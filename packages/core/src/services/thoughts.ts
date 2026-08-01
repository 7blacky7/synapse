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
  ensureCollection,
  insertVector,
  searchVectors,
  scrollVectors,
  deleteVector,
  deleteVectors,
  getVectors,
} from '../qdrant/index.js';
import { embed } from '../embeddings/index.js';
import type { EmbedOptions } from '../embeddings/index.js';
import { getPool } from '../db/client.js';
import { updateTask } from './plans.js';
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
  taskStatus?: ProjectTask['status']
): Promise<Thought> {
  // Collection sicherstellen
  const collectionName = COLLECTIONS.projectThoughts(project);
  await ensureCollection(collectionName);

  // Das Embedding passiert NICHT mehr hier, sondern nebenlaeufig nach dem PG-Schreiben
  // (siehe unten). Frueher stand an dieser Stelle ein await embed(content) VOR dem Insert —
  // damit hing das Speichern eines Gedankens an der Auslastung der Embedding-Queue.

  // Thought erstellen
  // Thought erstellen
  const thought: Thought = {
    id: uuidv4(),
    project,
    source,
    content,
    tags,
    timestamp: new Date().toISOString(),
    task_id: taskId,
  };


  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query(
    `INSERT INTO thoughts (id, project, source, content, tags, timestamp, task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [thought.id, project, source, content, tags, thought.timestamp, taskId ?? null]
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

  // 3. Optional: Task-Status atomar mit setzen (wenn taskId + taskStatus)
  if (taskId && taskStatus) {
    try {
      const updated = await updateTask(project, taskId, { status: taskStatus });
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
  taskStatus?: ProjectTask['status']
): Promise<{ thoughts: Thought[]; warning?: string }> {
  if (items.length === 0) return { thoughts: [] };

  const collectionName = COLLECTIONS.projectThoughts(project);
  await ensureCollection(collectionName);

  const now = new Date().toISOString();
  const thoughts: Thought[] = items.map(item => ({
    id: uuidv4(),
    project,
    source,
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
    const off = i * 7;
    placeholders.push(`($${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, $${off + 7})`);
    values.push(t.id, t.project, t.source, t.content, t.tags, t.timestamp, t.task_id ?? null);
  });
  await pool.query(
    `INSERT INTO thoughts (id, project, source, content, tags, timestamp, task_id)
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

  // 4. Optional: Task-Status fuer alle items mit task_id setzen
  if (taskStatus) {
    for (const t of thoughts) {
      if (!t.task_id) continue;
      try {
        const updated = await updateTask(project, t.task_id, { status: taskStatus });
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
 * Ruft Gedanken fuer ein Projekt ab
 */
export async function getThoughts(
  project: string,
  limit: number = 50
): Promise<Thought[]> {
  const collectionName = COLLECTIONS.projectThoughts(project);
  const results = await scrollVectors<ThoughtPayload>(
    collectionName,
    {
      must: [
        {
          key: 'project',
          match: { value: project },
        },
      ],
    },
    limit
  );

  // Nach Timestamp sortieren (neueste zuerst)
  const thoughts = results.map(r => ({
    id: r.id,
    project: r.payload.project,
    source: r.payload.source as ThoughtSource,
    content: r.payload.content,
    tags: r.payload.tags,
    timestamp: r.payload.timestamp,
  }));

  thoughts.sort((a, b) =>
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return thoughts;
}

/**
 * Sucht semantisch in Gedanken
 */
export async function searchThoughts(
  query: string,
  project: string,
  limit: number = 10
): Promise<ThoughtSearchResult[]> {
  const collectionName = COLLECTIONS.projectThoughts(project);

  // Query embedden
  const queryVector = await embed(query);

  // Filter erstellen
  const filter: Record<string, unknown> = {
    must: [
      {
        key: 'project',
        match: { value: project },
      },
    ],
  };

  return searchVectors<ThoughtPayload>(
    collectionName,
    queryVector,
    limit,
    filter
  );
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
  // 1. PostgreSQL (Write-Primary) — fail-fast: wirft bei Fehler
  const pool = getPool();
  await pool.query('DELETE FROM thoughts WHERE id = $1', [id]);

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
  const collectionName = COLLECTIONS.projectThoughts(project);
  const results = await scrollVectors<ThoughtPayload>(
    collectionName,
    {
      must: [
        { key: 'project', match: { value: project } },
        { key: 'source', match: { value: source } },
      ],
    },
    limit
  );

  return results.map(r => ({
    id: r.id,
    project: r.payload.project,
    source: r.payload.source as ThoughtSource,
    content: r.payload.content,
    tags: r.payload.tags,
    timestamp: r.payload.timestamp,
  }));
}

/**
 * Ruft Gedanken nach Tag ab
 */
export async function getThoughtsByTag(
  project: string,
  tag: string,
  limit: number = 50
): Promise<Thought[]> {
  const collectionName = COLLECTIONS.projectThoughts(project);
  const results = await scrollVectors<ThoughtPayload>(
    collectionName,
    {
      must: [
        { key: 'project', match: { value: project } },
        { key: 'tags', match: { any: [tag] } },
      ],
    },
    limit
  );

  return results.map(r => ({
    id: r.id,
    project: r.payload.project,
    source: r.payload.source as ThoughtSource,
    content: r.payload.content,
    tags: r.payload.tags,
    timestamp: r.payload.timestamp,
  }));
}

/**
 * Ruft Gedanken anhand ihrer IDs ab (Batch)
 * Nutzt Qdrant client.retrieve() fuer einen einzelnen Call statt N Einzel-Abfragen
 */
export async function getThoughtsByIds(
  project: string,
  ids: string[]
): Promise<Thought[]> {
  if (ids.length === 0) return [];

  const collectionName = COLLECTIONS.projectThoughts(project);
  const results = await getVectors<ThoughtPayload>(collectionName, ids);

  return results
    .filter(r => r.payload.project === project)
    .map(r => ({
      id: r.id,
      project: r.payload.project,
      source: r.payload.source as ThoughtSource,
      content: r.payload.content,
      tags: r.payload.tags,
      timestamp: r.payload.timestamp,
    }));
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
  const pool = getPool();

  // ⚠️ thoughts IST ANDERS GEBAUT als memories und proposals: es gibt KEIN created_at und
  // KEIN updated_at, sondern eine einzelne Spalte "timestamp". Wer hier oder im Backlog nach
  // updated_at sortiert oder sie ausliest, bekommt zur Laufzeit einen Spaltenfehler — der
  // Code sieht dabei genauso aus wie der funktionierende in memory.ts.
  const { rows } = await pool.query(
    `SELECT source, content, tags, timestamp, task_id
       FROM thoughts WHERE id = $1 AND project = $2`,
    [id, project]
  );
  if (rows.length === 0) return; // zwischenzeitlich geloescht
  const row = rows[0];

  const collectionName = COLLECTIONS.projectThoughts(project);
  await ensureCollection(collectionName);

  const vector = await embed(row.content, embedOptions);
  const payload: ThoughtPayload = {
    project,
    source: row.source,
    content: row.content,
    tags: row.tags ?? [],
    timestamp: new Date(row.timestamp).toISOString(),
  };
  if (row.task_id) (payload as ThoughtPayload & { task_id?: string }).task_id = row.task_id;

  // Gleiche id wie die PG-Zeile: delete + insert wirkt als upsert. Das delete darf fehlen.
  await deleteVector(collectionName, id).catch(() => { /* existierte noch nicht */ });
  await insertVector(collectionName, vector, payload, id);

  await pool.query('UPDATE thoughts SET embedded_at = NOW() WHERE id = $1', [id]);
}
