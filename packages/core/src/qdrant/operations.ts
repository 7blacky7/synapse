/**
 * MODUL: Qdrant CRUD Operationen
 * ZWECK: Insert, Search, Delete und Scroll von Vektoren in Qdrant Collections.
 *
 * INPUT:
 *   - collection: string - Name der Qdrant-Collection
 *   - vector: number[] - Embedding-Vektor
 *   - payload: Record - Beliebige Metadaten zum Vektor
 *   - filter: Record - Qdrant-Filter-Objekt (must/should/must_not)
 *   - limit: number - Max. Anzahl Ergebnisse
 *   - id?: string - Optionale UUID; wird sonst generiert
 *
 * OUTPUT:
 *   - string: ID des eingefuegten Vektors
 *   - string[]: IDs bei Batch-Insert
 *   - SearchResult<T>[]: Semantische Suchergebnisse mit Score und Payload
 *   - Array<{id, payload}>: Scroll-Ergebnisse (gefiltert, ohne Score)
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Schreibt, liest und loescht Punkte in den angegebenen Collections
 *   - Kein PostgreSQL; kein Embedding (Vektoren muessen fertig uebergeben werden)
 */

import { v4 as uuidv4 } from 'uuid';
import { getQdrantClient } from './client.js';
import { SearchResult } from '../types/index.js';
import { getPool } from '../db/client.js';

// ===========================================
// PATH-CANONICALIZATION
// ===========================================
// Qdrant soll IMMER relative file_path-Eintraege speichern (Single Source of Truth).
// Caller koennen absolute Pfade uebergeben — diese werden beim Insert/Delete
// gegen den Projekt-Root in der projects-Tabelle aufgeloest und gekuerzt.

const PROJECT_ROOT_TTL_MS = 60_000;
const projectRootCache = new Map<string, { root: string | null; expiresAt: number }>();

/**
 * Loescht den projectRoot-Cache (nur fuer Tests/Migrations gedacht).
 */
export function clearProjectRootCache(): void {
  projectRootCache.clear();
}

async function getProjectRoot(project: string): Promise<string | null> {
  const now = Date.now();
  const cached = projectRootCache.get(project);
  if (cached && cached.expiresAt > now) return cached.root;

  let root: string | null = null;
  try {
    const pool = getPool();
    const res = await pool.query<{ path: string }>(
      `SELECT path FROM projects WHERE name = $1 ORDER BY last_access DESC NULLS LAST LIMIT 1`,
      [project]
    );
    if (res.rows.length > 0) root = res.rows[0].path;
  } catch (err) {
    console.error(`[Qdrant canonicalize] PG-Lookup fuer projectRoot "${project}" fehlgeschlagen:`, err);
  }

  projectRootCache.set(project, { root, expiresAt: now + PROJECT_ROOT_TTL_MS });
  return root;
}

/**
 * Wandelt einen absoluten file_path in einen projekt-relativen Pfad.
 * - Bereits relative Pfade werden unveraendert zurueckgegeben.
 * - Absolute Pfade ohne passenden Projekt-Root werden geloggt + as-is zurueckgegeben (best-effort).
 */
export async function canonicalizeFilePath(filePath: string, project: string): Promise<string> {
  if (!filePath) return filePath;
  if (!filePath.startsWith('/')) return filePath; // bereits relativ
  if (!project) {
    console.error(`[Qdrant canonicalize] Kein project-Name fuer absoluten Pfad: ${filePath}`);
    return filePath;
  }

  const root = await getProjectRoot(project);
  if (!root) {
    console.error(`[Qdrant canonicalize] Kein projectRoot fuer "${project}" gefunden — file_path bleibt absolut: ${filePath}`);
    return filePath;
  }

  const rootSlash = root.endsWith('/') ? root : root + '/';
  if (filePath === root) return '';
  if (filePath.startsWith(rootSlash)) {
    return filePath.substring(rootSlash.length);
  }

  console.error(`[Qdrant canonicalize] file_path passt nicht zum projectRoot "${root}" (project=${project}): ${filePath}`);
  return filePath;
}

/**
 * Normalisiert file_path im Payload (wenn vorhanden) gegen den project-Root.
 * No-op falls payload kein file_path oder kein project enthaelt.
 */
async function canonicalizePayload<T extends Record<string, unknown>>(payload: T): Promise<T> {
  const filePath = payload.file_path;
  const project = payload.project;
  if (typeof filePath !== 'string' || typeof project !== 'string') return payload;
  if (!filePath.startsWith('/')) return payload; // schon relativ → kein Realloc

  const canon = await canonicalizeFilePath(filePath, project);
  if (canon === filePath) return payload;
  return { ...payload, file_path: canon };
}

/**
 * Fuegt einen Vektor mit Payload in eine Collection ein
 */
export async function insertVector<T extends Record<string, unknown>>(
  collection: string,
  vector: number[],
  payload: T,
  id?: string
): Promise<string> {
  const client = getQdrantClient();
  const pointId = id || uuidv4();
  const canonPayload = await canonicalizePayload(payload);

  await client.upsert(collection, {
    wait: true,
    points: [
      {
        id: pointId,
        vector,
        payload: canonPayload,
      },
    ],
  });

  return pointId;
}

/**
 * Fuegt mehrere Vektoren mit Payloads ein (Batch)
 */
export async function insertVectors<T extends Record<string, unknown>>(
  collection: string,
  items: Array<{ vector: number[]; payload: T; id?: string }>
): Promise<string[]> {
  const client = getQdrantClient();

  const points = await Promise.all(
    items.map(async item => ({
      id: item.id || uuidv4(),
      vector: item.vector,
      payload: await canonicalizePayload(item.payload),
    }))
  );

  await client.upsert(collection, {
    wait: true,
    points,
  });

  return points.map(p => p.id as string);
}

/**
 * Sucht aehnliche Vektoren in einer Collection
 */
export async function searchVectors<T>(
  collection: string,
  queryVector: number[],
  limit: number = 10,
  filter?: Record<string, unknown>
): Promise<SearchResult<T>[]> {
  const client = getQdrantClient();

  let results;
  try {
    results = await client.search(collection, {
      vector: queryVector,
      limit,
      filter: filter as any,
      with_payload: true,
    });
  } catch (error: unknown) {
    console.error(`[Synapse Qdrant] searchVectors FEHLER in "${collection}": vectorDim=${queryVector.length}, limit=${limit}, filter=${JSON.stringify(filter)}`);
    throw error;
  }

  return results.map(result => ({
    id: result.id as string,
    score: result.score,
    payload: result.payload as T,
  }));
}

/**
 * Loescht einen Vektor anhand der ID
 */
export async function deleteVector(
  collection: string,
  id: string
): Promise<void> {
  const client = getQdrantClient();

  await client.delete(collection, {
    wait: true,
    points: [id],
  });
}

/**
 * Loescht mehrere Vektoren anhand ihrer IDs (Batch)
 */
export async function deleteVectors(
  collection: string,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const client = getQdrantClient();

  await client.delete(collection, {
    wait: true,
    points: ids,
  });
}

/**
 * Loescht Vektoren anhand eines Filters
 */
export async function deleteByFilter(
  collection: string,
  filter: Record<string, unknown>
): Promise<void> {
  const client = getQdrantClient();

  await client.delete(collection, {
    wait: true,
    filter: filter as any,
  });
}

/**
 * Loescht alle Vektoren einer Datei (fuer Update-Mechanismus)
 */
export async function deleteByFilePath(
  collection: string,
  filePath: string,
  project?: string
): Promise<void> {
  const canonPath = project ? await canonicalizeFilePath(filePath, project) : filePath;
  await deleteByFilter(collection, {
    must: [
      {
        key: 'file_path',
        match: { value: canonPath },
      },
    ],
  });
}

/**
 * Loescht alle Vektoren eines Projekts
 */
export async function deleteByProject(
  collection: string,
  project: string
): Promise<void> {
  await deleteByFilter(collection, {
    must: [
      {
        key: 'project',
        match: { value: project },
      },
    ],
  });
}

/**
 * Holt einen Vektor anhand der ID
 */
export async function getVector<T>(
  collection: string,
  id: string
): Promise<{ id: string; payload: T } | null> {
  const client = getQdrantClient();

  try {
    const results = await client.retrieve(collection, {
      ids: [id],
      with_payload: true,
    });

    if (results.length === 0) {
      return null;
    }

    return {
      id: results[0].id as string,
      payload: results[0].payload as T,
    };
  } catch {
    return null;
  }
}

/**
 * Holt mehrere Vektoren anhand ihrer IDs (Batch)
 */
export async function getVectors<T>(
  collection: string,
  ids: string[]
): Promise<Array<{ id: string; payload: T }>> {
  if (ids.length === 0) return [];
  const client = getQdrantClient();

  try {
    const results = await client.retrieve(collection, {
      ids,
      with_payload: true,
    });

    return results.map(point => ({
      id: point.id as string,
      payload: point.payload as T,
    }));
  } catch {
    return [];
  }
}

/**
 * Aktualisiert das Payload aller Punkte einer Datei bei Umbenennung.
 * Nutzt Qdrants setPayload-API, kein Re-Embedding noetig.
 */
export async function updatePayloadByFilePath(
  collection: string,
  oldFilePath: string,
  newFilePath: string
): Promise<number> {
  const client = getQdrantClient();
  const fileName = newFilePath.split('/').pop() || newFilePath;

  // Alle Punkte mit dem alten Pfad finden
  const points = await scrollVectors<{ file_path: string }>(
    collection,
    { must: [{ key: 'file_path', match: { value: oldFilePath } }] },
    1000
  );

  if (points.length === 0) return 0;

  const ids = points.map(p => p.id);
  try {
    await client.setPayload(collection, {
      wait: true,
      points: ids,
      payload: {
        file_path: newFilePath,
        file_name: fileName,
        updated_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error(`[Synapse Qdrant] setPayload fehlgeschlagen fuer ${oldFilePath} → ${newFilePath}:`, err);
    throw err;
  }

  return ids.length;
}

/**
 * Holt alle Vektoren mit einem bestimmten Filter
 */
export async function scrollVectors<T>(
  collection: string,
  filter: Record<string, unknown>,
  limit: number = 100
): Promise<Array<{ id: string; payload: T }>> {
  const client = getQdrantClient();

  const results = await client.scroll(collection, {
    filter: filter as any,
    limit,
    with_payload: true,
  });

  return results.points.map(point => ({
    id: point.id as string,
    payload: point.payload as T,
  }));
}
