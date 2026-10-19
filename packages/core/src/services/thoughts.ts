/**
 * MODUL: Gedanken-System
 * ZWECK: Speichert und durchsucht Gedanken/Notizen von KI-Agenten fuer Wissensaustausch
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - source: ThoughtSource - Ursprung des Gedankens (z.B. "claude", "user")
 *   - content: string - Inhalt des Gedankens
 *   - tags: string[] - Optionale Tags fuer Kategorisierung
 *   - query: string - Suchbegriff fuer semantische Suche
 *   - id: string - Gedanken-ID fuer Loeschung
 *
 * OUTPUT:
 *   - Thought: Gespeicherter Gedanke mit ID und Timestamp
 *   - Thought[]: Liste von Gedanken (nach Timestamp sortiert, neueste zuerst)
 *   - ThoughtSearchResult[]: Suchergebnisse mit Relevanz-Score
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Schreibt/loescht in per-Projekt Collection "project_{name}_thoughts"
 *   - Logs: Konsolenausgabe bei Speicherung/Loeschung
 *
 * ABHÄNGIGKEITEN:
 *   - ../types/index.js (intern) - Thought, ThoughtPayload, ThoughtSource Typen
 *   - ../qdrant/index.js (intern) - Collection und Vektor-Operationen
 *   - ../embeddings/index.js (intern) - Text-zu-Vektor Konvertierung
 *   - uuid (extern) - ID-Generierung
 *
 * HINWEISE:
 *   - Gedanken sind projekt-gebunden aber source-uebergreifend durchsuchbar
 *   - Semantische Suche kann optional projekt-uebergreifend sein
 *   - Filterung nach Source oder Tag moeglich
 */

import { v4 as uuidv4 } from 'uuid';
import {
  Thought,
  ThoughtPayload,
  ThoughtSearchResult,
  ThoughtSource,
  COLLECTIONS,
} from '../types/index.js';
import {
  insertVector,
  searchVectors,
  deleteVector,
  deleteVectors,
} from '../qdrant/index.js';
import {
  loeseThoughtIdsAuf,
  leseThoughtsAusPg,
  leseThoughtsNachSourceAusPg,
  leseThoughtsNachTagAusPg,
  leseThoughtsNachIdsAusPg,
  holeThoughtsPerEingabe,
  mischeSuchtreffer,
  type Aufloesung,
  type ThoughtMitAufloesung,
} from './thought-ids.js';
import { embed } from '../embeddings/index.js';
import type { EmbedOptions } from '../embeddings/index.js';
import { getPool, getHintergrundPool } from '../db/client.js';
import { embeddingNachtragAngehalten } from './intern-schalter.js';
import { betteEinzelnEin, type NachzugQuelle } from './embed-nachzug.js';
import { updateTask } from './plans.js';
import type { TaskBearbeiter } from './agent-profil-vertrag.js';
import { aktuelleAgentIdentityId } from './agent-bezug.js';
import { thoughtTaskRefs } from './plan-suche.js';
import { spiegeleThoughtInTopf } from './entscheidungstopf.js';
import type { ProjectTask } from '../types/index.js';
/**
 * Fuegt einen Gedanken hinzu
 */
export async function addThought(
  project: string,
  source: ThoughtSource,
  content: string,
  tags: string[] = [],
  taskId?: string,
  taskStatus?: ProjectTask['status'],
  bearbeiter?: TaskBearbeiter
): Promise<Thought> {
  // P10-T11: Collection-Prüfung gehört zum Index-Nachtrag, nicht vor den PG-Write.

  // Das Embedding passiert NICHT mehr hier, sondern nebenlaeufig nach dem PG-Schreiben
  // (siehe unten). Frueher stand an dieser Stelle ein await embed(content) VOR dem Insert —
  // damit hing das Speichern eines Gedankens an der Auslastung der Embedding-Queue.

  // Thought erstellen
  // Thought erstellen
  const thought: Thought = {
    id: uuidv4(),
    project,
    source,
    ...(aktuelleAgentIdentityId(project, source) ? {source_identity_id:aktuelleAgentIdentityId(project, source)!} : {}),
    content,
    tags,
    timestamp: new Date().toISOString(),
    task_id: taskId,
  };


  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query(
    `INSERT INTO thoughts (id, project, source, content, tags, timestamp, task_id, source_identity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO NOTHING`,
    [thought.id, project, source, content, tags, thought.timestamp, taskId ?? null, thought.source_identity_id ?? null]
  );

  // 2. Qdrant (Vektor-Index) — NEBENLAEUFIG seit EMBED-1.
  // Der Aufruf kehrt zurueck, sobald der Gedanke in PostgreSQL steht. Bis der Vektor da ist,
  // bleibt embedded_at NULL und der Backlog sieht den Eintrag.
  // WARUM DAS HIER BESONDERS ZAEHLT: jeder Session-Handoff ist ein Gedanke. Lief im Hintergrund
  // ein grosser Embedding-Lauf, blockierte frueher genau der Aufruf, mit dem eine Session ihren
  // letzten Stand sichert — und lief in ein Timeout, obwohl der Text laengst geschrieben war.
  let warning: string | undefined;
  void embeddeThoughtNach(project, thought.id).catch(err => {
    console.error(`[Synapse] Thought-Embedding fehlgeschlagen, Backlog holt es nach:`, err);
  });
  // P15 E1: thought mit Tags entscheidung+user -> roh-Eintrag im Entscheidungs-Topf (wirft nie; Fehler als warning)
  const spiegel = await spiegeleThoughtInTopf(project, { id: thought.id, source, content, tags });
  if (spiegel.fehler) warning = `Topf-Spiegel fehlgeschlagen: ${spiegel.fehler}`;

  // 3. Optional: Task-Status atomar mit setzen (wenn taskId + taskStatus)
  if (taskId && taskStatus) {
    try {
      const updated = await updateTask(project, taskId, { status: taskStatus }, undefined, bearbeiter);
      if (!updated) {
        warning = (warning ? warning + '; ' : '') + `Task ${taskId} nicht gefunden — Status nicht gesetzt`;
      }
    } catch (error) {
      warning = (warning ? warning + '; ' : '') + `Task-Update fehlgeschlagen: ${error}`;
    }
  }

  console.error(`[Synapse] Gedanke gespeichert von "${source}" fuer Projekt "${project}"`);
  return { ...thought, warning };
}

/**
 * Fuegt mehrere Gedanken atomar hinzu (Batch).
 * 1× embedBatch fuer alle Texte, 1× INSERT mit allen Rows, N× insertVector (Qdrant).
 * Source ist fuer alle Items im Batch identisch.
 */
export async function addThoughtsBatch(
  project: string,
  source: ThoughtSource,
  items: Array<{ content: string; tags?: string[]; task_id?: string }>,
  taskStatus?: ProjectTask['status'],
  bearbeiter?: TaskBearbeiter
): Promise<{ thoughts: Thought[]; warning?: string }> {
  if (items.length === 0) return { thoughts: [] };

  // P10-T11: Auch ein Batch speichert unabhängig von der Verfügbarkeit des Suchindex.
  const now = new Date().toISOString();
  const thoughts: Thought[] = items.map(item => ({
    id: uuidv4(),
    project,
    source,
    ...(aktuelleAgentIdentityId(project, source) ? {source_identity_id:aktuelleAgentIdentityId(project, source)!} : {}),
    content: item.content,
    tags: item.tags ?? [],
    timestamp: now,
    task_id: item.task_id,
  }));

  // Die Embeddings entstehen NICHT mehr hier. Frueher lief an dieser Stelle ein embedBatch
  // ueber alle Texte, BEVOR ueberhaupt etwas in PostgreSQL stand — bei belegter Queue hing
  // damit das Speichern eines ganzen Batches, obwohl noch keine Zeile geschrieben war.

  // 2. PostgreSQL: Multi-Row INSERT in einem Statement
  const pool = getPool();
  const values: unknown[] = [];
  const placeholders: string[] = [];
  thoughts.forEach((t, i) => {
    const off = i * 8;
    placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7}, $${off + 8})`);
    values.push(t.id, t.project, t.source, t.content, t.tags, t.timestamp, t.task_id ?? null, t.source_identity_id ?? null);
  });
  await pool.query(
    `INSERT INTO thoughts (id, project, source, content, tags, timestamp, task_id, source_identity_id)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (id) DO NOTHING`,
    values
  );

  // 3. Qdrant — NEBENLAEUFIG seit EMBED-1.
  // Die Zeilen stehen in PostgreSQL und sind sofort abrufbar; embedded_at ist bei allen NULL,
  // sie sind also auch dann fuer den Backlog sichtbar, wenn hier etwas schiefgeht.
  // SEQUENZIELL VERKETTET, nicht N-fach parallel: ein Batch mit fuenfzig Gedanken wuerde sonst
  // fuenfzig Embeddings gleichzeitig anstossen und die Queue (zwei Slots) selbst verstopfen —
  // also genau den Zustand herstellen, gegen den diese Umstellung gebaut ist.
  // let statt const: der Task-Status-Block weiter unten schreibt hier noch hinein.
  let warning: string | undefined;
  void (async () => {
    for (const t of thoughts) {
      try {
        await embeddeThoughtNach(project, t.id);
      } catch (err) {
        console.error(`[Synapse] Thought-Batch-Embedding fehlgeschlagen (${t.id}), Backlog holt es nach:`, err);
      }
    }
  })();

  // P15 E1: Entscheidungs-Topf-Spiegel (entscheidung+user -> roh-Eintrag, Fehler als warning)
  for (const t of thoughts) {
    const spiegel = await spiegeleThoughtInTopf(project, { id: t.id, source, content: t.content, tags: t.tags });
    if (spiegel.fehler) warning = (warning ? warning + '; ' : '') + `Topf-Spiegel ${t.id}: ${spiegel.fehler}`;
  }

  // 4. Optional: Task-Status fuer alle items mit task_id setzen
  if (taskStatus) {
    for (const t of thoughts) {
      if (!t.task_id) continue;
      try {
        const updated = await updateTask(project, t.task_id, { status: taskStatus }, undefined, bearbeiter);
        if (!updated) {
          warning = (warning ? warning + '; ' : '') + `Task ${t.task_id} nicht gefunden`;
        }
      } catch (error) {
        warning = (warning ? warning + '; ' : '') + `Task-Update fehlgeschlagen (${t.task_id}): ${error}`;
      }
    }
  }

  console.error(`[Synapse] ${thoughts.length} Gedanken gespeichert von "${source}" (Batch)`);
  return { thoughts, warning };
}


/**
 * Ruft Gedanken fuer ein Projekt ab — aus PostgreSQL (Quelle der Wahrheit), neueste zuerst.
 * Sortierung und Limit in SQL (frueher: Qdrant-Scroll + JS-Sort = zufaellige N).
 */
export async function getThoughts(
  project: string,
  limit: number = 50
): Promise<Thought[]> {
  return (await leseThoughtsAusPg(project, limit)) as Thought[];
}

/**
 * Sucht semantisch in Gedanken
 */
export async function searchThoughts(
  query: string,
  project: string,
  limit: number = 10,
  taskId?: string,
): Promise<ThoughtSearchResult[]> {
  const collectionName = COLLECTIONS.projectThoughts(project);

  // Query embedden
  const queryVector = await embed(query, { art: 'query' });

  // Filter erstellen
  const filter: Record<string, unknown> = {
    must: [
      {
        key: 'project',
        match: { value: project },
      },
    ],
  };

  let resolvedTasks: string[] | undefined;
  if (taskId) {
    resolvedTasks = (await thoughtTaskRefs(project, taskId)).map(ref => ref.toUpperCase());
    // PG-IDs als Vektorfilter: auch alte Payloads ohne task_id bleiben auffindbar.
    const { rows } = await getPool().query<{ id: string }>('SELECT id FROM thoughts WHERE project=$1 AND upper(task_id)=ANY($2::text[])', [project, resolvedTasks]);
    if (!rows.length) return [];
    (filter.must as unknown[]).push({ has_id: rows.map(r => r.id) });
  }
  const treffer = await searchVectors<ThoughtPayload>(
    collectionName,
    queryVector,
    limit,
    filter
  );

  // Qdrant liefert nur ids + score; Inhalt/Tags/source/timestamp kommen aus PostgreSQL.
  // Treffer ohne PG-Zeile (verwaister Vektor) werden verworfen und gezaehlt.
  const zeilen = await leseThoughtsNachIdsAusPg(project, treffer.map(t => String(t.id)));
  const gemischt = mischeSuchtreffer(treffer, zeilen);
  if (gemischt.verworfen > 0) {
    console.error(`[Synapse] searchThoughts: ${gemischt.verworfen} Qdrant-Treffer ohne PG-Zeile verworfen (Projekt "${project}")`);
  }
  const ergebnis: ThoughtSearchResult[] = resolvedTasks
    ? gemischt.treffer.filter(t => resolvedTasks!.includes(String((t.payload as unknown as Record<string, unknown>).task_id ?? '').toUpperCase()))
    : gemischt.treffer;
  if (gemischt.verworfen > 0) {
    (ergebnis as ThoughtSearchResult[] & { verworfen_ohne_pg?: number }).verworfen_ohne_pg = gemischt.verworfen;
  }
  return ergebnis;
}

/** P10-T51 (N2): Laenge der Vorschau je Suchtreffer. */
export const THOUGHT_VORSCHAU_ZEICHEN = 300;

/** Erste THOUGHT_VORSCHAU_ZEICHEN Zeichen, mit Auslassungszeichen, wenn gekuerzt. */
export function thoughtVorschau(content: string | null | undefined, max: number = THOUGHT_VORSCHAU_ZEICHEN): string {
  const text = content ?? '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * P10-T51 (N2): Suchtreffer ohne Volltext. Zehn Treffer mit Volltext waren 70.549 Zeichen und
 * rissen das Antwortlimit des Clients. Je Treffer bleiben id, score und die Metadaten; statt
 * content gibt es vorschau + content_laenge, embedding_modell entfaellt. Volltext: thought get
 * oder Parameter volltext:true.
 */
export function kuerzeThoughtTreffer(treffer: ThoughtSearchResult[]): Array<{
  id: ThoughtSearchResult['id'];
  score: number;
  payload: Record<string, unknown>;
}> {
  return treffer.map((t) => {
    const { content, embedding_modell: _modell, ...rest } = t.payload as unknown as Record<string, unknown> & { content?: string };
    const text = typeof content === 'string' ? content : '';
    return { ...t, payload: { ...rest, vorschau: thoughtVorschau(text), content_laenge: text.length } };
  });
}

/**
 * Aktualisiert einen bestehenden Gedanken (partielle Aenderungen)
 * PostgreSQL first, dann Qdrant bei content-Aenderung
 */
export async function updateThought(
  project: string,
  id: string,
  changes: { content?: string; tags?: string[] }
): Promise<Thought | null> {
  // 1. Bestehenden Thought aus PostgreSQL laden
  const pool = getPool();
  const existing = await pool.query(
    'SELECT id, project, source, content, tags, timestamp FROM thoughts WHERE project = $1 AND id = $2',
    [project, id]
  );

  if (existing.rows.length === 0) {
    console.error(`[Synapse] updateThought: Thought "${id}" nicht gefunden in Projekt "${project}"`);
    return null;
  }

  const row = existing.rows[0];
  const now = new Date().toISOString();

  // 2. Felder mergen (nur gesetzte changes ueberschreiben)
  const mergedContent = changes.content ?? row.content;
  const mergedTags = changes.tags ?? row.tags;

  // 3. PostgreSQL UPDATE (Write-Primary) — fail-fast: wirft bei Fehler
  await pool.query(
    `UPDATE thoughts SET content = $1, tags = $2, embedded_at = NULL WHERE id = $3`,
    [mergedContent, mergedTags, id]
  );

  // 4. Qdrant — NEBENLAEUFIG seit EMBED-1.
  // Das UPDATE oben hat embedded_at genullt: der alte Vektor beschreibt den alten Text und ist
  // ab sofort falsch. Die Zeile ist damit fuer den Backlog sichtbar; der Aufruf hier ist nur
  // der schnelle Weg zum selben Ergebnis.
  const warning: string | undefined = undefined;
  void embeddeThoughtNach(project, id).catch(err => {
    console.error(`[Synapse] Thought-Update-Embedding fehlgeschlagen, Backlog holt es nach:`, err);
  });

  // 5. Aktualisierter Thought zurueckgeben
  const updatedThought: Thought = {
    id,
    project,
    source: row.source as ThoughtSource,
    content: mergedContent,
    tags: mergedTags,
    timestamp: row.timestamp instanceof Date ? row.timestamp.toISOString() : row.timestamp,
    warning,
  };

  console.error(`[Synapse] Thought "${id}" aktualisiert fuer Projekt "${project}"`);
  return updatedThought;
}

/**
 * Loescht einen Gedanken
 */
export async function deleteThought(project: string, id: string): Promise<{ success: boolean; warning?: string }> {
  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler. Nur im eigenen Projekt.
  const pool = getPool();
  await pool.query('DELETE FROM thoughts WHERE id = $1 AND project = $2', [id, project]);

  // 2. Qdrant — Warning bei Fehler, PG-Daten bereits geloescht
  let warning: string | undefined;
  try {
    const collectionName = COLLECTIONS.projectThoughts(project);
    await deleteVector(collectionName, id);
  } catch (error) {
    console.error('[Synapse] Qdrant Thought-Delete fehlgeschlagen:', error);
    warning = (warning ? warning + ' | ' : '') + `Qdrant-Write fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] Gedanke geloescht: ${id}`);
  return { success: true, warning };
}

/**
 * Loescht mehrere Gedanken anhand ihrer IDs (Batch)
 * PG: DELETE WHERE id = ANY($1::uuid[]) — atomar
 * Qdrant: deleteVectors(ids[]) — ein Call
 */
export async function deleteThoughts(
  project: string,
  ids: string[]
): Promise<{ deleted: number; warning?: string }> {
  if (ids.length === 0) return { deleted: 0 };

  // 1. PostgreSQL (Write-Primary) — atomar, fail-fast
  const pool = getPool();
  const pgResult = await pool.query(
    'DELETE FROM thoughts WHERE id = ANY($1::text[]) AND project = $2 RETURNING id',
    [ids, project]
  );
  const deletedCount = pgResult.rowCount ?? 0;

  // 2. Qdrant — Warning bei Fehler, PG-Daten bereits geloescht
  let warning: string | undefined;
  try {
    const collectionName = COLLECTIONS.projectThoughts(project);
    await deleteVectors(collectionName, ids);
  } catch (error) {
    console.error('[Synapse] Qdrant Batch-Thought-Delete fehlgeschlagen:', error);
    warning = `Qdrant-Delete fehlgeschlagen: ${error}`;
  }

  console.error(`[Synapse] ${deletedCount} Gedanken geloescht (Batch)`);
  return { deleted: deletedCount, warning };
}

/**
 * Ruft Gedanken nach Source ab
 */
export async function getThoughtsBySource(
  project: string,
  source: ThoughtSource,
  limit: number = 50
): Promise<Thought[]> {
  return (await leseThoughtsNachSourceAusPg(project, source, limit)) as Thought[];
}

/**
 * Ruft Gedanken nach Tag ab
 */
export async function getThoughtsByTag(
  project: string,
  tag: string,
  limit: number = 50
): Promise<Thought[]> {
  return (await leseThoughtsNachTagAusPg(project, tag, limit)) as Thought[];
}

/**
 * Ruft Gedanken anhand ihrer IDs ab (Batch) — aus PostgreSQL.
 * Akzeptiert volle UUIDs UND eindeutige Praefixe (mind. 8 Zeichen); nicht aufloesbare Eingaben
 * fehlen im Ergebnis (Details: holeThoughtsMitProblemen). Gekuerzt angefragte tragen aufgeloeste_id.
 */
export async function getThoughtsByIds(
  project: string,
  ids: string[]
): Promise<Thought[]> {
  if (ids.length === 0) return [];
  const r = await holeThoughtsPerEingabe(project, ids);
  return r.thoughts as Thought[];
}

/** Wie getThoughtsByIds, meldet aber auch mehrdeutige/ungueltige/unbekannte Eingaben. */
export async function holeThoughtsMitProblemen(
  project: string,
  ids: string[]
): Promise<{ thoughts: ThoughtMitAufloesung[]; probleme: Aufloesung[] }> {
  if (ids.length === 0) return { thoughts: [], probleme: [] };
  return holeThoughtsPerEingabe(project, ids);
}

export interface ThoughtIdProblem {
  success: false;
  status: Aufloesung['status'];
  eingabe: string;
  message: string;
  kandidaten?: Aufloesung['kandidaten'];
}

function zuProblem(a: Aufloesung): ThoughtIdProblem {
  const message = a.fehler
    ?? (a.status === 'nicht_gefunden' ? `Gedanke "${a.eingabe}" nicht gefunden` : `id "${a.eingabe}" nicht aufloesbar`);
  return { success: false, status: a.status, eingabe: a.eingabe, message, ...(a.kandidaten ? { kandidaten: a.kandidaten } : {}) };
}

/**
 * update per volle UUID ODER Praefix. Nicht aufloesbar/mehrdeutig -> nichts wird geaendert.
 */
export async function aendereThoughtPerId(
  project: string,
  idEingabe: string,
  changes: { content?: string; tags?: string[] }
): Promise<(Thought & { aufgeloeste_id?: string }) | ThoughtIdProblem | null> {
  const [a] = await loeseThoughtIdsAuf(project, [idEingabe]);
  if (a.status !== 'ok' || !a.id) return zuProblem(a);
  const t = await updateThought(project, a.id, changes);
  if (!t) return zuProblem({ eingabe: idEingabe, status: 'nicht_gefunden' });
  return a.gekuerzt ? { ...t, aufgeloeste_id: a.id } : t;
}

export interface LoeschErgebnis {
  success: boolean;
  deleted: number;
  /** volle IDs, die geloescht wurden (bzw. geloescht wuerden bei dryRun) */
  ids: string[];
  /** Eingaben, die nicht ok waren (mehrdeutig/ungueltig/unbekannt) — dafuer geschah nichts */
  probleme: ThoughtIdProblem[];
  aufgeloest?: Array<{ eingabe: string; id: string }>;
  dry_run?: boolean;
  warning?: string;
}

/**
 * delete per volle UUID(s) ODER Praefixe. Mehrdeutige/ungueltige/unbekannte Eingaben werden NICHT
 * geloescht und einzeln gemeldet; die uebrigen laufen durch.
 */
export async function loescheThoughtsPerId(
  project: string,
  eingaben: string[],
  optionen: { dryRun?: boolean } = {}
): Promise<LoeschErgebnis> {
  const aufl = await loeseThoughtIdsAuf(project, eingaben);
  const probleme = aufl.filter(a => a.status !== 'ok').map(zuProblem);
  const ids = [...new Set(aufl.filter(a => a.status === 'ok' && a.id).map(a => a.id as string))];
  const aufgeloest = aufl
    .filter(a => a.status === 'ok' && a.gekuerzt && a.id)
    .map(a => ({ eingabe: a.eingabe, id: a.id as string }));
  const extra = aufgeloest.length > 0 ? { aufgeloest } : {};
  if (optionen.dryRun) {
    return { success: ids.length > 0, deleted: 0, ids, probleme, dry_run: true, ...extra };
  }
  if (ids.length === 0) return { success: false, deleted: 0, ids: [], probleme, ...extra };
  const r = await deleteThoughts(project, ids);
  return { success: r.deleted > 0, deleted: r.deleted, ids, probleme, warning: r.warning, ...extra };
}


/**
 * EMBED-1: traegt den Vektor eines Gedankens nach.
 *
 * Gerufen von addThought OHNE await und vom Backlog fuer alles, was dabei liegengeblieben ist.
 * embedded_at wird ERST nach erfolgreichem insertVector gesetzt — faellt das Embedding aus,
 * bleibt die Spalte NULL und der Backlog holt den Eintrag erneut.
 *
 * Warum der Inhalt frisch aus PG kommt statt als Parameter: zwischen dem Schreiben und dem
 * Nachreichen kann der Gedanke aktualisiert worden sein; dann soll der NEUE Stand embedded
 * werden, nicht der alte.
 */
export async function embeddeThoughtNach(
  project: string,
  id: string,
  embedOptions: EmbedOptions = {},
): Promise<void> {
  // P5-T15/P14-T2: der Nachtrag ist Hintergrundarbeit (die KI hat ihre Antwort schon), ausser ein Aufrufer
  // wartet bewusst und setzt priority selbst. Schalter embedding an -> Hintergrund-Nachtrag auslassen;
  // embedded_at bleibt NULL, der Backlog holt nach der Freigabe nach.
  embedOptions = { ...embedOptions, priority: embedOptions.priority ?? 'background' };
  if (embedOptions.priority === 'background' && await embeddingNachtragAngehalten()) return;
  // P15-T4: Lesen, Text und Payload teilt sich der Einzelweg mit dem Stapel (thoughtNachzug).
  await betteEinzelnEin(thoughtNachzug, id, embedOptions, (p) => p.project === project);
}

/**
 * Inhaltsstand eines Gedankens. ⚠️ thoughts hat KEIN updated_at (nur "timestamp" = Anlage), deshalb
 * md5 ueber die eingebetteten Spalten: aendert updateThought Inhalt oder Tags waehrend des Einbettens,
 * bleibt embedded_at NULL und der naechste Lauf holt den neuen Stand.
 */
const THOUGHT_STAND = "md5(concat_ws('|', t.content, t.tags::text, t.task_id, t.source_identity_id))";

/**
 * P15-T4: Lesen, Text und Payload eines Gedankens — EINZIGE Stelle fuer Einzel-Nachtrag und Stapel
 * (embed-nachzug.ts). Inhalt frisch aus PG (Hintergrund-Pool, P5-T15).
 */
export const thoughtNachzug: NachzugQuelle = {
  tabelle: 'thoughts',
  idSpalte: 'id',
  idTyp: 'text',
  standSql: THOUGHT_STAND,
  async lese(ids) {
    // ⚠️ KEIN created_at/updated_at in thoughts — Zeitspalte heisst "timestamp".
    const { rows } = await getHintergrundPool().query(
      `SELECT t.id, t.project, t.source, t.content, t.tags, t.timestamp, t.task_id, t.source_identity_id,
              ${THOUGHT_STAND} AS stand
         FROM thoughts t WHERE t.id = ANY($1::text[])`,
      [ids]
    );
    return rows.map((row) => {
      const payload: ThoughtPayload = {
        project: row.project,
        source: row.source,
        content: row.content,
        tags: row.tags ?? [],
        timestamp: new Date(row.timestamp).toISOString(),
      };
      if (row.task_id) (payload as ThoughtPayload & { task_id?: string }).task_id = row.task_id;
      return {
        id: row.id,
        project: row.project,
        collection: COLLECTIONS.projectThoughts(row.project),
        text: row.content,
        payload: { ...payload, ...(row.source_identity_id ? { source_identity_id: row.source_identity_id } : {}) },
        stand: row.stand,
      };
    });
  },
};
