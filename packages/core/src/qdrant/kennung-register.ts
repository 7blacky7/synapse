/**
 * MODUL: Embedding-Kennungsregister (P12-T6)
 * ZWECK: Merkt je Qdrant-Collection, mit welchem Modell sie gefuellt wird (Kennung aus
 *        embeddings/modell-profil.ts) und meldet, wenn das aktive Modell davon abweicht.
 *
 * WARUM: Synapse verglich bisher nur die DIMENSION. Der Wechsel Google -> qwen3-embedding
 * (beide 3072d) blieb dadurch unbemerkt; ~60 % der aelteren Memories/Thoughts tragen bis
 * heute Vektoren des alten Modells und sind per Suche praktisch unauffindbar (P5-T9,
 * Befund 92009f99). Die Dimension sagt nichts darueber, ob zwei Vektoren vergleichbar sind.
 *
 * GRENZEN - BEWUSST:
 *   - Meldet NUR. Loescht, migriert und blockiert nichts. Das Neu-Einbetten ist Sache des
 *     Werkzeugs aus P12-T12 (neue Collections, Nachzug, Umschalten).
 *   - PostgreSQL nicht erreichbar oder Tabelle fehlt -> stiller Verzicht (einmal geloggt).
 *     Ein Schreibvorgang darf an diesem Register nie scheitern.
 *   - Bestands-Collections ohne Eintrag werden beim ersten Blick mit der AKTUELLEN Kennung
 *     uebernommen (quelle 'bestand-ungeprueft'). Das heisst NICHT, dass ihr Inhalt dazu passt
 *     - nur, dass ab hier ein Wechsel erkannt wird.
 *   - Einzelne Punkte tragen zusaetzlich payload.embedding_modell (qdrant/operations.ts).
 */
import { getPool } from '../db/client.js';
import { embeddingModellKennung } from '../embeddings/modell-profil.js';

export type KennungsStatus = 'neu-registriert' | 'passt' | 'abweichend' | 'unbekannt';

export interface KennungsBefund {
  collection: string;
  status: KennungsStatus;
  aktuell: string;
  gespeichert?: string;
}

// Je Prozess genuegt ein Blick pro Collection: ensureCollection laeuft in jedem Schreibweg.
const geprueft = new Map<string, KennungsBefund>();
let deaktiviert = false;

function verzichte(grund: unknown): void {
  if (!deaktiviert) {
    console.error(`[Synapse] Kennungsregister nicht verfuegbar (${String(grund).slice(0, 160)}) - Modellwechsel werden nicht erkannt.`);
  }
  deaktiviert = true;
}

/** Neue Collection: Kennung und Dimension festhalten (ueberschreibt einen alten Eintrag gleichen Namens). */
export async function registriereCollection(name: string, dimension: number): Promise<void> {
  if (deaktiviert) return;
  const kennung = embeddingModellKennung();
  try {
    await getPool().query(
      `INSERT INTO embedding_collections (collection, modell_kennung, dimension, quelle)
       VALUES ($1, $2, $3, 'angelegt')
       ON CONFLICT (collection) DO UPDATE
         SET modell_kennung = EXCLUDED.modell_kennung, dimension = EXCLUDED.dimension,
             quelle = 'angelegt', aktualisiert_am = NOW()`,
      [name, kennung, dimension],
    );
    geprueft.set(name, { collection: name, status: 'neu-registriert', aktuell: kennung });
  } catch (err) {
    verzichte(err);
  }
}

/** Bestehende Collection: passt das aktive Modell zum gespeicherten? Meldet Abweichungen einmal je Prozess. */
export async function pruefeCollectionKennung(name: string, dimension: number | null): Promise<KennungsBefund> {
  const aktuell = embeddingModellKennung();
  const bekannt = geprueft.get(name);
  if (bekannt && bekannt.aktuell === aktuell) return bekannt;
  if (deaktiviert) return { collection: name, status: 'unbekannt', aktuell };

  let befund: KennungsBefund;
  try {
    const { rows } = await getPool().query<{ modell_kennung: string }>(
      'SELECT modell_kennung FROM embedding_collections WHERE collection = $1',
      [name],
    );
    if (rows.length === 0) {
      await getPool().query(
        `INSERT INTO embedding_collections (collection, modell_kennung, dimension, quelle)
         VALUES ($1, $2, $3, 'bestand-ungeprueft') ON CONFLICT (collection) DO NOTHING`,
        [name, aktuell, dimension],
      );
      befund = { collection: name, status: 'neu-registriert', aktuell };
    } else if (rows[0].modell_kennung === aktuell) {
      befund = { collection: name, status: 'passt', aktuell };
    } else {
      befund = { collection: name, status: 'abweichend', aktuell, gespeichert: rows[0].modell_kennung };
      console.error(
        `[Synapse] ⚠️ MODELLWECHSEL: Collection "${name}" wurde mit "${rows[0].modell_kennung}" gefuellt, ` +
        `aktiv ist "${aktuell}". Vektoren beider Modelle sind NICHT vergleichbar - Suche liefert Unsinn. ` +
        `Nichts wurde geloescht. Neu einbetten mit dem Re-Embedding-Werkzeug (P12-T12).`,
      );
    }
  } catch (err) {
    verzichte(err);
    return { collection: name, status: 'unbekannt', aktuell };
  }
  geprueft.set(name, befund);
  return befund;
}

/** Fuer Tests und nach einem Modellwechsel im selben Prozess. */
export function vergissKennungsPruefungen(): void {
  geprueft.clear();
  deaktiviert = false;
}
