/**
 * Synapse Core - Qdrant CRUD Operationen
 * Insert, Search, Delete fuer Vektoren
 */

import { v4 as uuidv4 } from 'uuid';
import { getQdrantClient } from './client.js';
import { SearchResult } from '../types/index.js';

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

  await client.upsert(collection, {
    wait: true,
    points: [
      {
        id: pointId,
        vector,
        payload,
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

  const points = items.map(item => ({
    id: item.id || uuidv4(),
    vector: item.vector,
    payload: item.payload,
  }));

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

  const results = await client.search(collection, {
    vector: queryVector,
    limit,
    filter: filter as any,
    with_payload: true,
  });

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
  filePath: string
): Promise<void> {
  await deleteByFilter(collection, {
    must: [
      {
        key: 'file_path',
        match: { value: filePath },
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
