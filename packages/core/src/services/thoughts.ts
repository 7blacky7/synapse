/**
 * Synapse Core - Thoughts Service
 * Gedankenaustausch zwischen KIs speichern und abrufen
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
} from '../qdrant/index.js';
import { embed } from '../embeddings/index.js';

/**
 * Fuegt einen Gedanken hinzu
 */
export async function addThought(
  project: string,
  source: ThoughtSource,
  content: string,
  tags: string[] = []
): Promise<Thought> {
  // Collection sicherstellen
  await ensureCollection(COLLECTIONS.projectThoughts);

  // Embedding generieren
  const vector = await embed(content);

  // Thought erstellen
  const thought: Thought = {
    id: uuidv4(),
    project,
    source,
    content,
    tags,
    timestamp: new Date().toISOString(),
  };

  // Payload erstellen
  const payload: ThoughtPayload = {
    project: thought.project,
    source: thought.source,
    content: thought.content,
    tags: thought.tags,
    timestamp: thought.timestamp,
  };

  // In Qdrant speichern
  await insertVector(COLLECTIONS.projectThoughts, vector, payload, thought.id);

  console.log(`[Synapse] Gedanke gespeichert von "${source}" fuer Projekt "${project}"`);
  return thought;
}

/**
 * Ruft Gedanken fuer ein Projekt ab
 */
export async function getThoughts(
  project: string,
  limit: number = 50
): Promise<Thought[]> {
  const results = await scrollVectors<ThoughtPayload>(
    COLLECTIONS.projectThoughts,
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
  project?: string,
  limit: number = 10
): Promise<ThoughtSearchResult[]> {
  // Query embedden
  const queryVector = await embed(query);

  // Filter erstellen
  const filter: Record<string, unknown> | undefined = project
    ? {
        must: [
          {
            key: 'project',
            match: { value: project },
          },
        ],
      }
    : undefined;

  return searchVectors<ThoughtPayload>(
    COLLECTIONS.projectThoughts,
    queryVector,
    limit,
    filter
  );
}

/**
 * Loescht einen Gedanken
 */
export async function deleteThought(id: string): Promise<void> {
  await deleteVector(COLLECTIONS.projectThoughts, id);
  console.log(`[Synapse] Gedanke geloescht: ${id}`);
}

/**
 * Ruft Gedanken nach Source ab
 */
export async function getThoughtsBySource(
  project: string,
  source: ThoughtSource,
  limit: number = 50
): Promise<Thought[]> {
  const results = await scrollVectors<ThoughtPayload>(
    COLLECTIONS.projectThoughts,
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
  const results = await scrollVectors<ThoughtPayload>(
    COLLECTIONS.projectThoughts,
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
