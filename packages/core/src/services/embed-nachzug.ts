/**
 * MODUL: Embed-Nachzug (P15-T4)
 * ZWECK: Gemeinsamer Weg, Wissens-Eintraege (memories, thoughts, proposals, plans, error_patterns,
 *        tech_docs, skill_sections) einzeln ODER im Stapel einzubetten
 *
 * WARUM: der Backlog bettete jeden Eintrag einzeln ein (ein Queue-Slot + EMBED_MIN_GAP_MS je Zeile,
 *   ~2-4/s). Nach intern(neu_einbetten) warteten ~13.000 Eintraege. Im Stapel gehen die Texte als
 *   embedBatch (Scheiben je Queue-Slot) raus, der Qdrant-Upsert geschieht je Collection gesammelt.
 *
 * ⚠️ TEXT UND PAYLOAD MUESSEN IN BEIDEN WEGEN IDENTISCH SEIN — sonst haengt der Vektor davon ab,
 *   welcher Weg ihn erzeugt hat. Deshalb baut jede Tabelle sie an GENAU EINER Stelle
 *   (NachzugQuelle.lese im jeweiligen Dienst); Einzel-Nachtrag und Stapel rufen beide diese Stelle.
 *
 * INPUT:  NachzugQuelle (je Tabelle im Dienst definiert), ids, EmbedOptions
 * OUTPUT: Anzahl eingebetteter Eintraege
 * NEBENEFFEKTE: Qdrant-Upsert, embedded_at in PostgreSQL (nur wenn der Inhalt seit dem Lesen gleich blieb)
 */

import { ensureCollection, insertVectors } from '../qdrant/index.js';
import { embed, embedBatch, embeddingModellKennung, type EmbedOptions } from '../embeddings/index.js';
import { getHintergrundPool } from '../db/client.js';
import { betteWissenEin } from './wissen-stuecke.js';

/** Ein nachzutragender Vektor: woher, wohin, welcher Text, welche Payload. */
export interface NachzugPunkt {
  /** PG-Schluessel als Text; zugleich die Qdrant-Punkt-ID (skills: als Zahl, siehe schreibe) */
  id: string;
  /** Projekt der Zeile (null bei globalen Zeilen) */
  project: string | null;
  collection: string;
  /** Text, der eingebettet wird — exakt wie im Schreibweg */
  text: string;
  payload: Record<string, unknown>;
  /** Inhaltsstand beim Lesen (Ausdruck NachzugQuelle.standSql) */
  stand: string | null;
}

/** Je Tabelle: wie gelesen, geschrieben und markiert wird. */
export interface NachzugQuelle {
  tabelle: string;
  idSpalte: string;
  /** PG-Typ des Schluessels — ANY($1::typ[]) haelt den Primaerschluessel-Index nutzbar */
  idTyp: 'text' | 'uuid' | 'bigint';
  /**
   * SQL-Ausdruck ueber den Alias t, der den Inhaltsstand beschreibt (updated_at, content_hash
   * oder md5 der eingebetteten Spalten). lese liefert ihn als stand, markiere vergleicht damit:
   * wurde die Zeile waehrend des Einbettens geaendert, bleibt embedded_at NULL und der naechste
   * Lauf bettet den neuen Stand ein.
   */
  standSql: string;
  /** Liest die Zeilen und baut Text + Payload. Geloeschte ids fehlen im Ergebnis. */
  lese(ids: string[]): Promise<NachzugPunkt[]>;
  /** Eigener Upsert (skills: eigene Qdrant-URL); sonst ensureCollection + insertVectors. */
  schreibe?(collection: string, liste: Array<{ punkt: NachzugPunkt; vector: number[] }>): Promise<void>;
  /** true: beim Markieren auch embedding_modell setzen (skill_sections). */
  modellSpalte?: boolean;
}

/** Schreibt Vektoren je Collection gesammelt nach Qdrant. */
async function schreibePunkte(
  quelle: NachzugQuelle,
  paare: Array<{ punkt: NachzugPunkt; vector: number[] }>,
): Promise<void> {
  const jeCollection = new Map<string, Array<{ punkt: NachzugPunkt; vector: number[] }>>();
  for (const p of paare) {
    const liste = jeCollection.get(p.punkt.collection) ?? [];
    liste.push(p);
    jeCollection.set(p.punkt.collection, liste);
  }
  for (const [collection, liste] of jeCollection) {
    if (quelle.schreibe) {
      await quelle.schreibe(collection, liste);
      continue;
    }
    await ensureCollection(collection);
    // Gleiche id wie die PG-Zeile: upsert ersetzt Vektor UND Payload (wie frueher delete + insert).
    await insertVectors(collection, liste.map(({ punkt, vector }) => ({ id: punkt.id, vector, payload: punkt.payload })));
  }
}

/**
 * Setzt embedded_at fuer alle Punkte, deren Inhaltsstand noch dem gelesenen entspricht.
 * Ein Statement je Stapel (unnest), nicht eines je Zeile.
 */
export async function markiereEingebettet(quelle: NachzugQuelle, punkte: NachzugPunkt[]): Promise<number> {
  if (punkte.length === 0) return 0;
  const params: unknown[] = [punkte.map((p) => p.id), punkte.map((p) => p.stand)];
  let modell = '';
  if (quelle.modellSpalte) {
    params.push(embeddingModellKennung());
    modell = ', embedding_modell = $3';
  }
  const res = await getHintergrundPool().query(
    `UPDATE ${quelle.tabelle} AS t SET embedded_at = NOW()${modell}
       FROM unnest($1::text[], $2::text[]) AS s(id, stand)
      WHERE t.${quelle.idSpalte} = s.id::${quelle.idTyp}
        AND (${quelle.standSql}) IS NOT DISTINCT FROM s.stand`,
    params,
  );
  return res.rowCount ?? 0;
}

/**
 * Einzelweg: eine Zeile lesen, einbetten, schreiben, markieren.
 * @param passt optionaler Filter (z. B. Projekt muss stimmen) — sonst gibt es nichts zu tun.
 */
export async function betteEinzelnEin(
  quelle: NachzugQuelle,
  id: string,
  embedOptions: EmbedOptions,
  passt?: (p: NachzugPunkt) => boolean,
): Promise<void> {
  const punkt = (await quelle.lese([id])).find((p) => !passt || passt(p));
  if (!punkt) return; // zwischenzeitlich geloescht — nichts nachzutragen
  if (await betteWissenEin(quelle, punkt, embedOptions)) return;
  const vector = await embed(punkt.text, embedOptions);
  await schreibePunkte(quelle, [{ punkt, vector }]);
  await markiereEingebettet(quelle, [punkt]);
}

/**
 * Stapelweg: alle ids lesen, Texte gemeinsam einbetten (embedBatch teilt in Scheiben je
 * Queue-Slot), je Collection gesammelt schreiben, in einem Statement markieren.
 * Wirft, wenn das Einbetten oder Schreiben scheitert — der Aufrufer faellt dann auf den
 * Einzelweg zurueck, damit ein kaputter Eintrag nicht den ganzen Stapel blockiert.
 * @returns Zahl der gelesenen (= eingebetteten) Eintraege; geloeschte ids zaehlen nicht.
 */
export async function betteStapelEin(
  quelle: NachzugQuelle,
  ids: string[],
  embedOptions: EmbedOptions,
): Promise<number> {
  const gelesen = await quelle.lese(ids);
  if (gelesen.length === 0) return 0;
  const punkte: NachzugPunkt[] = [];
  // Lange Eintraege laufen scheibenweise; kurze behalten den bisherigen Stapelweg.
  for (const punkt of gelesen) {
    if (!await betteWissenEin(quelle, punkt, embedOptions)) punkte.push(punkt);
  }
  if (punkte.length === 0) return gelesen.length;
  const vektoren = await embedBatch(punkte.map((p) => p.text), embedOptions);
  await schreibePunkte(quelle, punkte.map((punkt, i) => ({ punkt, vector: vektoren[i] })));
  await markiereEingebettet(quelle, punkte);
  return gelesen.length;
}
