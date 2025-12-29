/**
 * Synapse Core - Memory Service
 * Persistente Speicherung von Dokumentationen und Notizen
 * Ähnlich zu Serena's write_memory
 */

import { v4 as uuidv4 } from 'uuid';
import { embed } from '../embeddings/index.js';
import { ensureCollection } from '../qdrant/collections.js';
import {
  insertVector,
  searchVectors,
  scrollVectors,
  deleteVector,
  deleteByFilter,
} from '../qdrant/operations.js';

const COLLECTION_NAME = 'synapse_memories';

export interface Memory {
  id: string;
  project: string;
  name: string;
  content: string;
  category: 'documentation' | 'note' | 'architecture' | 'decision' | 'other';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemoryPayload extends Record<string, unknown> {
  project: string;
  name: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemorySearchResult {
  id: string;
  score: number;
  payload: MemoryPayload;
}

/**
 * Speichert ein Memory (überschreibt bei gleichem Namen)
 */
export async function writeMemory(
  project: string,
  name: string,
  content: string,
  category: Memory['category'] = 'note',
  tags: string[] = []
): Promise<Memory> {
  await ensureCollection(COLLECTION_NAME);

  // Prüfen ob Memory mit diesem Namen existiert
  const existing = await getMemoryByName(project, name);

  const now = new Date().toISOString();
  const memory: Memory = {
    id: existing?.id || uuidv4(),
    project,
    name,
    content,
    category,
    tags,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  // Embedding generieren
  const vector = await embed(content);

  const payload: MemoryPayload = {
    project: memory.project,
    name: memory.name,
    content: memory.content,
    category: memory.category,
    tags: memory.tags,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };

  // Falls existiert, erst löschen
  if (existing) {
    await deleteVector(COLLECTION_NAME, existing.id);
  }

  // Speichern
  await insertVector(COLLECTION_NAME, vector, payload, memory.id);

  console.log(`[Synapse] Memory "${name}" gespeichert für Projekt "${project}"`);
  return memory;
}

/**
 * Liest ein Memory nach Name
 */
export async function getMemoryByName(
  project: string,
  name: string
): Promise<Memory | null> {
  try {
    const results = await scrollVectors<MemoryPayload>(
      COLLECTION_NAME,
      {
        must: [
          { key: 'project', match: { value: project } },
          { key: 'name', match: { value: name } },
        ],
      },
      1
    );

    if (results.length === 0) {
      return null;
    }

    const point = results[0];
    return {
      id: point.id as string,
      project: point.payload.project,
      name: point.payload.name,
      content: point.payload.content,
      category: point.payload.category as Memory['category'],
      tags: point.payload.tags,
      createdAt: point.payload.createdAt,
      updatedAt: point.payload.updatedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Listet alle Memories eines Projekts
 */
export async function listMemories(
  project: string,
  category?: Memory['category']
): Promise<Memory[]> {
  const must: Array<Record<string, unknown>> = [
    { key: 'project', match: { value: project } },
  ];

  if (category) {
    must.push({ key: 'category', match: { value: category } });
  }

  const results = await scrollVectors<MemoryPayload>(
    COLLECTION_NAME,
    { must },
    1000
  );

  return results.map((point) => ({
    id: point.id as string,
    project: point.payload.project,
    name: point.payload.name,
    content: point.payload.content,
    category: point.payload.category as Memory['category'],
    tags: point.payload.tags,
    createdAt: point.payload.createdAt,
    updatedAt: point.payload.updatedAt,
  }));
}

/**
 * Durchsucht Memories semantisch
 */
export async function searchMemories(
  query: string,
  project?: string,
  limit: number = 10
): Promise<MemorySearchResult[]> {
  const queryVector = await embed(query);

  const filter: Record<string, unknown> = { must: [] };
  const must = filter.must as Array<Record<string, unknown>>;

  if (project) {
    must.push({ key: 'project', match: { value: project } });
  }

  return searchVectors<MemoryPayload>(
    COLLECTION_NAME,
    queryVector,
    limit,
    must.length > 0 ? filter : undefined
  );
}

/**
 * Löscht ein Memory
 */
export async function deleteMemory(
  project: string,
  name: string
): Promise<boolean> {
  const existing = await getMemoryByName(project, name);

  if (!existing) {
    return false;
  }

  await deleteVector(COLLECTION_NAME, existing.id);
  console.log(`[Synapse] Memory "${name}" gelöscht für Projekt "${project}"`);
  return true;
}

/**
 * Löscht alle Memories eines Projekts
 */
export async function deleteProjectMemories(project: string): Promise<number> {
  const memories = await listMemories(project);

  for (const memory of memories) {
    await deleteVector(COLLECTION_NAME, memory.id);
  }

  return memories.length;
}
