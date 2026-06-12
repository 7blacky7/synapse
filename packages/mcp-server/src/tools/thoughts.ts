/**
 * Synapse MCP - Thoughts Tools
 * Gedankenaustausch zwischen KIs
 */

import {
  addThought as addThoughtCore,
  getThoughts as getThoughtsCore,
  searchThoughts as searchThoughtsCore,
  deleteThought as deleteThoughtCore,
  getThoughtsByIds as getThoughtsByIdsCore,
  addThoughtsBatch as addThoughtsBatchCore,

} from '@synapse/core';
import type { Thought, ThoughtSource } from '@synapse/core';

/**
 * Fuegt einen Gedanken hinzu
 */
export async function addThought(
  project: string,
  source: ThoughtSource,
  content: string,
  tags: string[] = [],
  taskId?: string,
  taskStatus?: 'todo' | 'in_progress' | 'done' | 'blocked'
): Promise<{
  success: boolean;
  id: string | null;
  tags?: string[];
  timestamp?: Thought['timestamp'];
  content_length?: number;
  content_preview?: string;
  message: string;
}> {
  try {
    const thought = await addThoughtCore(project, source, content, tags, taskId, taskStatus);

    // Anti-Echo (DX-Befund 4): id + Preview statt komplettem Content-Echo.
    return {
      success: true,
      id: thought.id,
      tags: thought.tags,
      timestamp: thought.timestamp,
      content_length: thought.content.length,
      content_preview: thought.content.length > 120 ? `${thought.content.slice(0, 120)}…` : thought.content,
      message: `Gedanke gespeichert von "${source}"`,
    };
  } catch (error) {
    return {
      success: false,
      id: null,
      message: `Fehler beim Speichern des Gedankens: ${error}`,
    };
  }
}

/**
 * Fuegt mehrere Gedanken atomar hinzu (Batch)
 */
export async function addThoughtsBatchTool(
  project: string,
  source: ThoughtSource,
  items: Array<{ content: string; tags?: string[]; task_id?: string }>,
  taskStatus?: 'todo' | 'in_progress' | 'done' | 'blocked'
): Promise<{
  success: boolean;
  count: number;
  ids: string[];
  thoughts: Array<{ id: string; tags?: string[]; content_preview: string }>;
  warning?: string;
  message: string;
}> {
  try {
    if (items.length === 0) {
      return { success: false, count: 0, ids: [], thoughts: [], message: 'items darf nicht leer sein' };
    }
    if (items.length > 50) {
      return { success: false, count: 0, ids: [], thoughts: [], message: `Batch-Limit: Max 50 Items pro Call. Erhalten: ${items.length}` };
    }
    const valid = items.filter(i => typeof i.content === 'string' && i.content.length > 0);
    if (valid.length === 0) {
      return { success: false, count: 0, ids: [], thoughts: [], message: 'Keine gueltigen Items (content fehlt oder leer)' };
    }

    const result = await addThoughtsBatchCore(project, source, valid, taskStatus);
    // Anti-Echo (DX-Befund 4): ids + Previews statt komplettem Content-Echo.
    return {
      success: true,
      count: result.thoughts.length,
      ids: result.thoughts.map(t => t.id),
      thoughts: result.thoughts.map(t => ({
        id: t.id,
        tags: t.tags,
        content_preview: t.content.length > 120 ? `${t.content.slice(0, 120)}…` : t.content,
      })),
      warning: result.warning,
      message: `${result.thoughts.length} Gedanken gespeichert von "${source}" (Batch)`,
    };
  } catch (error) {
    return {
      success: false,
      count: 0,
      ids: [],
      thoughts: [],
      message: `Fehler beim Batch-Speichern der Gedanken: ${error}`,
    };
  }
}


/**
 * Ruft Gedanken fuer ein Projekt ab
 */
export async function getThoughts(
  project: string,
  limit: number = 50
): Promise<{
  success: boolean;
  thoughts: Thought[];
  message: string;
}> {
  try {
    const thoughts = await getThoughtsCore(project, limit);

    return {
      success: true,
      thoughts,
      message: `${thoughts.length} Gedanken geladen`,
    };
  } catch (error) {
    return {
      success: false,
      thoughts: [],
      message: `Fehler beim Laden der Gedanken: ${error}`,
    };
  }
}

/**
 * Sucht semantisch in Gedanken
 */
export async function searchThoughts(
  query: string,
  project: string,
  limit: number = 10
): Promise<{
  success: boolean;
  results: Array<{
    id: string;
    project: string;
    source: string;
    content: string;
    tags: string[];
    timestamp: string;
    score: number;
  }>;
  message: string;
}> {
  try {
    const results = await searchThoughtsCore(query, project, limit);

    return {
      success: true,
      results: results.map(r => ({
        id: r.id,
        project: r.payload.project,
        source: r.payload.source,
        content: r.payload.content,
        tags: r.payload.tags,
        timestamp: r.payload.timestamp,
        score: r.score,
      })),
      message: `${results.length} Gedanken gefunden`,
    };
  } catch (error) {
    return {
      success: false,
      results: [],
      message: `Fehler bei Gedanken-Suche: ${error}`,
    };
  }
}

/**
 * Aktualisiert einen bestehenden Gedanken
 */
export async function updateThoughtTool(
  project: string,
  id: string,
  changes: { content?: string; tags?: string[] }
): Promise<{
  success: boolean;
  thought: Thought | null;
  message: string;
}> {
  try {
    const { updateThought } = await import('@synapse/core');
    const thought = await updateThought(project, id, changes);

    if (!thought) {
      return {
        success: false,
        thought: null,
        message: `Gedanke "${id}" nicht gefunden in Projekt "${project}"`,
      };
    }

    const changedFields = Object.keys(changes).filter(k => changes[k as keyof typeof changes] !== undefined);
    return {
      success: true,
      thought,
      message: `Gedanke "${id}" aktualisiert (${changedFields.join(', ')})`,
    };
  } catch (error) {
    return {
      success: false,
      thought: null,
      message: `Fehler beim Aktualisieren des Gedankens: ${error}`,
    };
  }
}

/**
 * Loescht einen Gedanken nach ID
 */
export async function deleteThought(
  project: string,
  id: string
): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    const result = await deleteThoughtCore(project, id);

    return {
      success: true,
      message: result.warning
        ? `Gedanke "${id}" aus Projekt "${project}" geloescht (Warning: ${result.warning})`
        : `Gedanke "${id}" aus Projekt "${project}" geloescht`,
    };
  } catch (error) {
    return {
      success: false,
      message: `Fehler beim Loeschen des Gedankens: ${error}`,
    };
  }
}

/**
 * Loescht mehrere Gedanken (Batch) mit Safeguards
 */
export async function deleteThoughtsBatch(
  project: string,
  ids: string[],
  dryRun: boolean = false,
  maxItems: number = 10
): Promise<Record<string, unknown>> {
  // Safeguard: max_items Limit
  if (ids.length > maxItems) {
    return {
      success: false,
      message: `Batch-Limit: Max ${maxItems} Items pro Call. Erhalten: ${ids.length}. Nutze dry_run fuer Vorschau oder erhoehe max_items.`,
    };
  }

  // Audit-Logging (PFLICHT fuer Batch-Deletes)
  console.error(`[BATCH-DELETE] tool=thought action=delete count=${ids.length} dry_run=${dryRun} items=${JSON.stringify(ids)}`);

  // dry_run: Preview ohne Loeschen
  if (dryRun) {
    const { getThoughtsByIds } = await import('@synapse/core');
    const thoughts = await getThoughtsByIds(project, ids);
    return {
      success: true,
      dry_run: true,
      would_delete: thoughts.map(t => ({ id: t.id, source: t.source, content: t.content.substring(0, 100) })),
      count: thoughts.length,
      message: `dry_run: ${thoughts.length} Gedanken wuerden geloescht`,
    };
  }

  try {
    const { deleteThoughts } = await import('@synapse/core');
    const result = await deleteThoughts(project, ids);
    return {
      success: true,
      deleted: result.deleted,
      warning: result.warning,
      message: `${result.deleted} Gedanken geloescht`,
    };
  } catch (error) {
    return { success: false, message: `Fehler: ${error}` };
  }
}

/**
 * Ruft Gedanken anhand ihrer IDs ab (Batch)
 */
export async function getThoughtsByIdsTool(
  project: string,
  ids: string[]
): Promise<{
  success: boolean;
  thoughts: Thought[];
  message: string;
}> {
  try {
    const thoughts = await getThoughtsByIdsCore(project, ids);

    return {
      success: true,
      thoughts,
      message: `${thoughts.length} von ${ids.length} Gedanken geladen`,
    };
  } catch (error) {
    return {
      success: false,
      thoughts: [],
      message: `Fehler beim Laden der Gedanken: ${error}`,
    };
  }
}
