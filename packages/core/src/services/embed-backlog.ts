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
 * STAPEL (P15-T4): je Tabelle werden bis zu EMBED_BACKLOG_STAPEL Zeilen (Standard 64) gemeinsam
 *   eingebettet (embed-nachzug.ts: embedBatch, Qdrant-Upsert je Collection, embedded_at in einem
 *   Statement). Frueher ein embed() je Zeile plus EMBED_MIN_GAP_MS -> ~2-4 Eintraege/s.
 *   Scheitert ein Stapel, laufen seine Zeilen einzeln ueber die Nachtrag-Funktionen, damit ein
 *   kaputter Eintrag nicht den Rest blockiert.
 *
 * ABHAENGIGKEITEN: NachzugQuellen + Nachtrag-Funktionen der Dienste (memory, thoughts, proposals,
 *   plans, error-patterns, tech-docs, skills), ./embed-nachzug.js, ../db/client.js
 */

import { getPool } from '../db/client.js';
import { embeddeMemoryNach, memoryNachzug } from './memory.js';
import { embeddeThoughtNach, thoughtNachzug } from './thoughts.js';
import { embeddeProposalNach, proposalNachzug } from './proposals.js';
import { embeddePlanNach, planNachzug } from './plans.js';
import { embeddeErrorPatternNach, errorPatternNachzug } from './error-patterns.js';
import { embeddeTechDocNach, techDocNachzug } from './tech-docs.js';
import { embeddeSkillSectionNach, skillSectionNachzug } from './skills.js';
import { betteStapelEin } from './embed-nachzug.js';
import { schalterHaeltAn } from './intern-schalter.js';

/**
 * Welche Tabellen der Nachzug bedient, und womit.
 *
 * REIHENFOLGE (P15-T4): skill_sections zuerst — die Skill-Hooks schlagen bei jeder Aktion Skills
 * per Vektorsuche vor und liefern ohne Vektoren nichts. Danach Wissen in bisheriger Reihenfolge.
 *
 * ⚠️ DIE SORTIERSPALTE IST NICHT UEBERALL DIESELBE. memories und proposals haben
 * created_at/updated_at, thoughts hat WEDER NOCH — dort heisst die einzige Zeitspalte
 * "timestamp". Eine gemeinsame Query mit ORDER BY updated_at wuerde fuer thoughts zur
 * Laufzeit mit einem Spaltenfehler abbrechen, und zwar erst dann, wenn tatsaechlich ein
 * Rueckstand entsteht — also genau im Fehlerfall, fuer den der Nachzug gebaut ist.
 * Deshalb steht sie hier je Tabelle explizit.
 *
 * tech_docs (P12-T16): Sortierspalte indexed_at; project ist dort NULL fuer globale
 * Context7-Zeilen. Die Ziel-Collection waehlt techDocNachzug selbst aus der PG-Zeile
 * (project ? project_<p>_docs : tech_docs_cache), der uebergebene project-Wert ist egal.
 *
 * skill_sections (P12-T13): Schluessel heisst punkt_id (= Qdrant-Punkt-ID), Zeitspalte
 * aktualisiert_am. Der importierte Bestand wird per skills-nach-pg.mjs --bestand-markieren als
 * eingebettet markiert, sonst bettete der Backlog alle Altzeilen erneut ein.
 *
 * plans + error_patterns (P12-T12): seit dem Re-Embedding im Nachzug. error_patterns ist global
 * und hat KEINE project-Spalte (mitProjekt false) — ein Projektfilter ueberspringt sie.
 *
 * quelle = Stapelweg (embed-nachzug.ts), nachtrag = Einzelweg als Rueckfall. Beide bauen Text und
 * Payload ueber dieselbe NachzugQuelle.lese. quelle ist eine Funktion, weil tech-docs.ts dieses
 * Modul importiert (EMBED_PENDING_HINT): im Importzyklus waere die const beim Aufbau von TABELLEN
 * noch nicht initialisiert (TDZ) — Funktionsdeklarationen wie nachtrag sind davon nicht betroffen.
 */
const TABELLEN = [
  { name: 'skill_sections', sortSpalte: 'aktualisiert_am', idSpalte: 'punkt_id', mitProjekt: true, quelle: () => skillSectionNachzug, nachtrag: embeddeSkillSectionNach },
  { name: 'memories', sortSpalte: 'updated_at', idSpalte: 'id', mitProjekt: true, quelle: () => memoryNachzug, nachtrag: embeddeMemoryNach },
  { name: 'thoughts', sortSpalte: 'timestamp', idSpalte: 'id', mitProjekt: true, quelle: () => thoughtNachzug, nachtrag: embeddeThoughtNach },
  { name: 'proposals', sortSpalte: 'updated_at', idSpalte: 'id', mitProjekt: true, quelle: () => proposalNachzug, nachtrag: embeddeProposalNach },
  { name: 'plans', sortSpalte: 'updated_at', idSpalte: 'id', mitProjekt: true, quelle: () => planNachzug, nachtrag: embeddePlanNach },
  { name: 'error_patterns', sortSpalte: 'created_at', idSpalte: 'id', mitProjekt: false, quelle: () => errorPatternNachzug, nachtrag: embeddeErrorPatternNach },
  { name: 'tech_docs', sortSpalte: 'indexed_at', idSpalte: 'id', mitProjekt: true, quelle: () => techDocNachzug, nachtrag: embeddeTechDocNach },
] as const;

/** Tabellen, die der Nachzug bedient (fuer Filter wie intern(nachzug_jetzt, tabelle)). */
export const BACKLOG_TABELLEN: readonly string[] = TABELLEN.map((t) => t.name);

/**
 * P15-T12 E3: Tabellen in Abarbeitungsreihenfolge mit Sortier-/ID-Spalte - fuer
 * intern(warteschlange_liste, wissen_nachzug). Nur lesend.
 */
export const BACKLOG_TABELLEN_INFO: ReadonlyArray<{ name: string; sortSpalte: string; idSpalte: string; mitProjekt: boolean }> =
  TABELLEN.map((t) => ({ name: t.name, sortSpalte: t.sortSpalte, idSpalte: t.idSpalte, mitProjekt: t.mitProjekt }));

/**
 * Zeilen je Stapel (P15-T4). Kein Modellwert: die Aufteilung in Ollama-Aufrufe macht embedBatch
 * (EMBED_OLLAMA_BATCH je Scheibe); hier geht es nur darum, wie viel ein Fehlschlag zurueckwirft.
 */
function stapelGroesse(): number {
  const n = Number(process.env.EMBED_BACKLOG_STAPEL);
  return Number.isInteger(n) && n > 0 ? n : 64;
}

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
 * Gedrosselt ueber limit und die Prioritaet 'background': die Stapel laufen durch die
 * Hintergrund-Queue und werden von interaktiven Schreibvorgaengen verdraengt — der Nachzug
 * darf sie nicht ausbremsen, das waere genau der Zustand, gegen den EMBED-1 gebaut ist.
 *
 * @param limit Obergrenze je Lauf. Der naechste Tick holt den Rest.
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
  const stapel = stapelGroesse();

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

    for (let i = 0; i < rows.length; i += stapel) {
      const teil = rows.slice(i, i + stapel);
      ergebnis.geprueft += teil.length;
      uebrig -= teil.length;
      try {
        ergebnis.nachgetragen += await betteStapelEin(
          tabelle.quelle(),
          teil.map((r) => r.id),
          { priority: 'background' }
        );
        continue;
      } catch (err) {
        // Schalter waehrend des Laufs gesetzt -> anhalten statt einzeln weiterzumachen.
        if (await schalterHaeltAn('embedding', 'embedding-backlog')) return { ...ergebnis, angehalten: true };
        console.error(
          `[Synapse] Embedding-Stapel fehlgeschlagen (${tabelle.name}, ${teil.length} Eintraege), einzeln weiter:`,
          (err as Error).message
        );
      }
      // Rueckfall: einzeln, damit ein kaputter Eintrag den Rest des Stapels nicht blockiert.
      for (const row of teil) {
        try {
          await tabelle.nachtrag(row.project, row.id, { priority: 'background' });
          ergebnis.nachgetragen++;
        } catch (err) {
          // embedded_at bleibt NULL, der naechste Lauf versucht es erneut.
          ergebnis.fehlgeschlagen++;
          console.error(
            `[Synapse] Embedding-Nachtrag fehlgeschlagen (${tabelle.name}/${row.id}):`,
            (err as Error).message
          );
        }
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
