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
 * ABHAENGIGKEITEN: Nachtrag-Funktionen der Dienste (memory, thoughts, proposals, plans,
 *   error-patterns, tech-docs, skills), ../db/client.js
 */

import { getPool } from '../db/client.js';
import { embeddeMemoryNach } from './memory.js';
import { embeddeThoughtNach } from './thoughts.js';
import { embeddeProposalNach } from './proposals.js';
import { embeddePlanNach } from './plans.js';
import { embeddeErrorPatternNach } from './error-patterns.js';
import { embeddeTechDocNach } from './tech-docs.js';
import { embeddeSkillSectionNach } from './skills.js';
import { schalterHaeltAn } from './intern-schalter.js';

/**
 * Welche Tabellen der Nachzug bedient, und womit.
 *
 * ⚠️ DIE SORTIERSPALTE IST NICHT UEBERALL DIESELBE. memories und proposals haben
 * created_at/updated_at, thoughts hat WEDER NOCH — dort heisst die einzige Zeitspalte
 * "timestamp". Eine gemeinsame Query mit ORDER BY updated_at wuerde fuer thoughts zur
 * Laufzeit mit einem Spaltenfehler abbrechen, und zwar erst dann, wenn tatsaechlich ein
 * Rueckstand entsteht — also genau im Fehlerfall, fuer den der Nachzug gebaut ist.
 * Deshalb steht sie hier je Tabelle explizit.
 *
 * tech_docs (P12-T16): Sortierspalte indexed_at; project ist dort NULL fuer globale
 * Context7-Zeilen. embeddeTechDocNach waehlt die Ziel-Collection selbst aus der PG-Zeile
 * (project ? project_<p>_docs : tech_docs_cache), der uebergebene project-Wert ist egal.
 *
 * skill_sections (P12-T13): Schluessel heisst punkt_id (= Qdrant-Punkt-ID), Zeitspalte
 * aktualisiert_am. Der importierte Bestand wird per skills-nach-pg.mjs --bestand-markieren als
 * eingebettet markiert, sonst bettete der Backlog alle Altzeilen erneut ein.
 *
 * plans + error_patterns (P12-T12): seit dem Re-Embedding im Nachzug. error_patterns ist global
 * und hat KEINE project-Spalte (mitProjekt false) — ein Projektfilter ueberspringt sie.
 */
const TABELLEN = [
  { name: 'memories', sortSpalte: 'updated_at', idSpalte: 'id', mitProjekt: true, nachtrag: embeddeMemoryNach },
  { name: 'thoughts', sortSpalte: 'timestamp', idSpalte: 'id', mitProjekt: true, nachtrag: embeddeThoughtNach },
  { name: 'proposals', sortSpalte: 'updated_at', idSpalte: 'id', mitProjekt: true, nachtrag: embeddeProposalNach },
  { name: 'plans', sortSpalte: 'updated_at', idSpalte: 'id', mitProjekt: true, nachtrag: embeddePlanNach },
  { name: 'error_patterns', sortSpalte: 'created_at', idSpalte: 'id', mitProjekt: false, nachtrag: embeddeErrorPatternNach },
  { name: 'tech_docs', sortSpalte: 'indexed_at', idSpalte: 'id', mitProjekt: true, nachtrag: embeddeTechDocNach },
  { name: 'skill_sections', sortSpalte: 'aktualisiert_am', idSpalte: 'punkt_id', mitProjekt: true, nachtrag: embeddeSkillSectionNach },
] as const;

/** Tabellen, die der Nachzug bedient (fuer Filter wie intern(nachzug_jetzt, tabelle)). */
export const BACKLOG_TABELLEN: readonly string[] = TABELLEN.map((t) => t.name);

/** Projektbedingung je Tabelle: ohne project-Spalte nur, wenn kein Projektfilter gesetzt ist. */
function projektBedingung(mitProjekt: boolean): string {
  return mitProjekt ? '($1::text IS NULL OR project = $1)' : '$1::text IS NULL';
}

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
  /** P14-T2: true, wenn der Schalter embedding den Lauf angehalten hat (nichts angefasst). */
  angehalten?: boolean;
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
  project?: string,
  /** P14-T5: nur diese Tabelle (siehe BACKLOG_TABELLEN), sonst alle. */
  nurTabelle?: string
): Promise<BacklogErgebnis> {
  const pool = getPool();
  const ergebnis: BacklogErgebnis = { geprueft: 0, nachgetragen: 0, fehlgeschlagen: 0 };
  // P14-T2: Schalter embedding (jeder Modus) haelt den Nachzug an; embedded_at bleibt NULL, nichts geht verloren.
  if (await schalterHaeltAn('embedding', 'embedding-backlog')) return { ...ergebnis, angehalten: true };

  // Das Limit gilt fuer den GESAMTEN Lauf, nicht je Tabelle: sonst wuerde ein grosser
  // Rueckstand in einer Tabelle die Drosselung der anderen mit aushebeln.
  let uebrig = limit;

  for (const tabelle of TABELLEN) {
    if (uebrig <= 0) break;
    if (nurTabelle && tabelle.name !== nurTabelle) continue;

    // Aeltester Rueckstand zuerst — ein Eintrag, der beim Schreiben gescheitert ist, soll
    // nicht dauerhaft hinter neu hinzukommenden zurueckstehen. Sortierspalte je Tabelle,
    // siehe Kommentar bei TABELLEN.
    const { rows } = await pool.query(
      `SELECT ${tabelle.idSpalte}::text AS id, ${tabelle.mitProjekt ? 'project' : 'NULL::text AS project'}
         FROM ${tabelle.name}
        WHERE embedded_at IS NULL
          AND ${projektBedingung(tabelle.mitProjekt)}
        ORDER BY ${tabelle.sortSpalte}
        LIMIT $2`,
      [project ?? null, uebrig]
    );

    for (const row of rows) {
      ergebnis.geprueft++;
      uebrig--;
      try {
        await tabelle.nachtrag(row.project, row.id, { priority: 'background' });
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

  for (const tabelle of TABELLEN) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${tabelle.name}
        WHERE embedded_at IS NULL AND ${projektBedingung(tabelle.mitProjekt)}`,
      [project ?? null]
    );
    ergebnis[tabelle.name] = rows[0].n;
  }

  return ergebnis;
}
