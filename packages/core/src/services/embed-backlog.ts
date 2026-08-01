/**
 * MODUL: Embedding-Backlog
 * ZWECK: Holt Eintraege nach, deren Vektor beim Schreiben nicht zustande kam
 *
 * INPUT:
 *   - project?: string - optional auf ein Projekt beschraenken
 *   - limit?: number - Obergrenze je Lauf (Drosselung)
 *
 * OUTPUT:
 *   - { geprueft, nachgetragen, fehlgeschlagen } je Aufruf
 *
 * NEBENEFFEKTE: schreibt Vektoren nach Qdrant und setzt embedded_at in PostgreSQL
 *
 * ABHAENGIGKEITEN: ./memory.js (embeddeMemoryNach), ../db/pool.js
 */

import { getPool } from '../db/client.js';
import { embeddeMemoryNach } from './memory.js';
import { embeddeThoughtNach } from './thoughts.js';
import { embeddeProposalNach } from './proposals.js';

/**
 * Welche Tabellen der Nachzug bedient, und womit.
 *
 * ⚠️ DIE SORTIERSPALTE IST NICHT UEBERALL DIESELBE. memories und proposals haben
 * created_at/updated_at, thoughts hat WEDER NOCH — dort heisst die einzige Zeitspalte
 * "timestamp". Eine gemeinsame Query mit ORDER BY updated_at wuerde fuer thoughts zur
 * Laufzeit mit einem Spaltenfehler abbrechen, und zwar erst dann, wenn tatsaechlich ein
 * Rueckstand entsteht — also genau im Fehlerfall, fuer den der Nachzug gebaut ist.
 * Deshalb steht sie hier je Tabelle explizit.
 */
const TABELLEN = [
  { name: 'memories', sortSpalte: 'updated_at', nachtrag: embeddeMemoryNach },
  { name: 'thoughts', sortSpalte: 'timestamp', nachtrag: embeddeThoughtNach },
  { name: 'proposals', sortSpalte: 'updated_at', nachtrag: embeddeProposalNach },
] as const;

/**
 * Hinweis fuer aufrufende KIs, wortgleich gehalten zum EMBEDDING_PENDING_HINT der Code-Seite.
 * Der Eintrag ist SOFORT ueber PostgreSQL abrufbar — nur die semantische Suche hinkt kurz nach.
 */
export const EMBED_PENDING_HINT =
  'In PostgreSQL gespeichert und sofort abrufbar. Die semantische Suche spiegelt den Eintrag ' +
  'noch nicht — das Embedding laeuft im Hintergrund nach. Kein Blocker: nicht extra danach suchen.';

/** Was ein Backlog-Lauf getan hat. */
export interface BacklogErgebnis {
  geprueft: number;
  nachgetragen: number;
  fehlgeschlagen: number;
}

/**
 * EMBED-1: traegt offene Embeddings nach.
 *
 * WARUM ES DIESE FUNKTION GEBEN MUSS: seit die Schreibpfade das Embedding nebenlaeufig
 * anstossen, kehrt der Aufruf zurueck, bevor der Vektor steht. Schlaegt das Embedding dann
 * fehl — Ollama nicht erreichbar, Prozess beendet, Qdrant weg — liegt der Eintrag in
 * PostgreSQL und ist ueber jede strukturierte Abfrage auffindbar, hat aber nie einen Vektor.
 * Er waere damit STILL VERLOREN: nichts schlaegt fehl, nichts wird geloggt, und die
 * semantische Suche findet ihn einfach nie. embedded_at IS NULL ist der einzige Zeuge.
 *
 * Analog zu parseUnparsedFiles auf der Code-Seite: sequenziell und gedrosselt, damit ein
 * grosser Rueckstand nicht seinerseits die Embedding-Queue verstopft und die interaktiven
 * Schreibvorgaenge ausbremst — das waere genau der Zustand, gegen den EMBED-1 gebaut ist.
 *
 * @param limit Obergrenze je Lauf. Klein halten; der naechste Tick holt den Rest.
 * @param project optional auf ein Projekt beschraenken (sonst alle).
 */
export async function embeddeOffeneEintraege(
  limit = 20,
  project?: string
): Promise<BacklogErgebnis> {
  const pool = getPool();
  const ergebnis: BacklogErgebnis = { geprueft: 0, nachgetragen: 0, fehlgeschlagen: 0 };

  // Das Limit gilt fuer den GESAMTEN Lauf, nicht je Tabelle: sonst wuerde ein grosser
  // Rueckstand in einer Tabelle die Drosselung der anderen beiden mit aushebeln.
  let uebrig = limit;

  for (const tabelle of TABELLEN) {
    if (uebrig <= 0) break;

    // Aeltester Rueckstand zuerst — ein Eintrag, der beim Schreiben gescheitert ist, soll
    // nicht dauerhaft hinter neu hinzukommenden zurueckstehen. Sortierspalte je Tabelle,
    // siehe Kommentar bei TABELLEN.
    const { rows } = await pool.query(
      `SELECT id, project
         FROM ${tabelle.name}
        WHERE embedded_at IS NULL
          AND ($1::text IS NULL OR project = $1)
        ORDER BY ${tabelle.sortSpalte}
        LIMIT $2`,
      [project ?? null, uebrig]
    );

    for (const row of rows) {
      ergebnis.geprueft++;
      uebrig--;
      try {
        await tabelle.nachtrag(row.project, row.id);
        ergebnis.nachgetragen++;
      } catch (err) {
        // Nicht abbrechen: ein kaputter Eintrag darf den Rest des Rueckstands nicht blockieren.
        // embedded_at bleibt NULL, der naechste Lauf versucht es erneut.
        ergebnis.fehlgeschlagen++;
        console.error(
          `[Synapse] Embedding-Nachtrag fehlgeschlagen (${tabelle.name}/${row.id}):`,
          (err as Error).message
        );
      }
    }
  }

  if (ergebnis.nachgetragen > 0 || ergebnis.fehlgeschlagen > 0) {
    console.error(
      `[Synapse] Embedding-Backlog: ${ergebnis.nachgetragen} nachgetragen, ` +
        `${ergebnis.fehlgeschlagen} fehlgeschlagen (von ${ergebnis.geprueft} geprueft).`
    );
  }

  return ergebnis;
}

/**
 * Wie viele Eintraege warten noch auf ihren Vektor? Fuer Diagnose und Tests.
 *
 * Bewusst getrennt von embeddeOffeneEintraege: eine Zaehlung darf keine Nebenwirkung haben,
 * sonst kann man den Zustand nicht beobachten, ohne ihn zu veraendern.
 */
export async function zaehleOffeneEmbeddings(project?: string): Promise<Record<string, number>> {
  const pool = getPool();
  const ergebnis: Record<string, number> = {};

  // thoughts und proposals tragen die Spalte bereits, ihre Schreibpfade sind aber noch
  // blockierend — dort kann derzeit gar kein Rueckstand entstehen. Sie werden trotzdem
  // gezaehlt, damit die Umstellung sofort sichtbar wird, sobald sie erfolgt.
  for (const tabelle of ['memories', 'thoughts', 'proposals']) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${tabelle}
        WHERE embedded_at IS NULL AND ($1::text IS NULL OR project = $1)`,
      [project ?? null]
    );
    ergebnis[tabelle] = rows[0].n;
  }

  return ergebnis;
}
