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
} from '../qdrant/index.js';
import { embed } from '../embeddings/index.js';
import { getPool } from '../db/client.js';

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
  const collectionName = COLLECTIONS.projectThoughts(project);
  await ensureCollection(collectionName);

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

  // 1. PostgreSQL (Source of Truth)
  try {
    const pool = getPool();
    await pool.query(
      `INSERT INTO thoughts (id, project, source, content, tags, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [thought.id, project, source, content, tags, thought.timestamp]
    );
  } catch (error) {
    console.error('[Synapse] PostgreSQL Thought-Write fehlgeschlagen, nur Qdrant:', error);
  }

  // 2. Qdrant (Vektor-Index)
  await insertVector(collectionName, vector, payload, thought.id);

  console.error(`[Synapse] Gedanke gespeichert von "${source}" fuer Projekt "${project}"`);
  return thought;
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
 * Loescht einen Gedanken
 */
export async function deleteThought(project: string, id: string): Promise<void> {
  // 1. PostgreSQL
  try {
    const pool = getPool();
    await pool.query('DELETE FROM thoughts WHERE id = $1', [id]);
  } catch (error) {
    console.error('[Synapse] PostgreSQL Thought-Delete fehlgeschlagen:', error);
  }

  // 2. Qdrant
  const collectionName = COLLECTIONS.projectThoughts(project);
  await deleteVector(collectionName, id);
  console.error(`[Synapse] Gedanke geloescht: ${id}`);
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
