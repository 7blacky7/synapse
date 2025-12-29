/**
 * Synapse Core - Qdrant Collection Management
 * Erstellt und verwaltet Qdrant Collections
 */

import { getQdrantClient } from './client.js';
import { COLLECTIONS } from '../types/index.js';

/** Vektor-Dimension fuer Embeddings (nomic-embed-text = 768) */
const VECTOR_SIZE = 768;

/**
 * Prueft ob eine Collection existiert
 */
export async function collectionExists(name: string): Promise<boolean> {
  const client = getQdrantClient();

  try {
    await client.getCollection(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Erstellt eine Collection falls sie nicht existiert
 */
export async function ensureCollection(
  name: string,
  vectorSize: number = VECTOR_SIZE
): Promise<void> {
  const client = getQdrantClient();

  if (await collectionExists(name)) {
    console.log(`[Synapse] Collection "${name}" existiert bereits`);
    return;
  }

  await client.createCollection(name, {
    vectors: {
      size: vectorSize,
      distance: 'Cosine',
    },
  });

  console.log(`[Synapse] Collection "${name}" erstellt`);
}

/**
 * Loescht eine Collection
 */
export async function deleteCollection(name: string): Promise<void> {
  const client = getQdrantClient();

  if (!(await collectionExists(name))) {
    console.log(`[Synapse] Collection "${name}" existiert nicht`);
    return;
  }

  await client.deleteCollection(name);
  console.log(`[Synapse] Collection "${name}" geloescht`);
}

/**
 * Erstellt alle Standard-Collections fuer Synapse
 */
export async function ensureAllCollections(): Promise<void> {
  console.log('[Synapse] Erstelle Standard-Collections...');

  // Dokumentations-Cache
  await ensureCollection(COLLECTIONS.techDocs);

  // Projekt-Plaene
  await ensureCollection(COLLECTIONS.projectPlans);

  // Gedankenaustausch
  await ensureCollection(COLLECTIONS.projectThoughts);

  console.log('[Synapse] Alle Standard-Collections bereit');
}

/**
 * Erstellt eine projekt-spezifische Code-Collection
 */
export async function ensureProjectCollection(projectName: string): Promise<string> {
  const collectionName = COLLECTIONS.projectCode(projectName);
  await ensureCollection(collectionName);
  return collectionName;
}

/**
 * Listet alle Synapse-Collections auf
 */
export async function listCollections(): Promise<string[]> {
  const client = getQdrantClient();
  const result = await client.getCollections();
  return result.collections.map(c => c.name);
}

/**
 * Gibt Statistiken ueber eine Collection zurueck
 */
export async function getCollectionStats(name: string): Promise<{
  pointsCount: number;
  vectorsCount: number;
} | null> {
  const client = getQdrantClient();

  try {
    const info = await client.getCollection(name);
    return {
      pointsCount: info.points_count ?? 0,
      vectorsCount: info.indexed_vectors_count ?? info.points_count ?? 0,
    };
  } catch {
    return null;
  }
}
