/**
 * MODUL: Qdrant Collection Management
 * ZWECK: Erstellt, prueft und loescht Qdrant Collections — inkl. Dimensions-Validierung.
 *
 * INPUT:
 *   - name: string - Collection-Name
 *   - vectorSize?: number - Vektor-Dimension (Standard: aus getEmbeddingDimension())
 *   - project: string - Projektname fuer projekt-spezifische Collections
 *
 * OUTPUT:
 *   - void: Collection ist nach ensureCollection() garantiert vorhanden
 *   - boolean: Existenz-Check
 *   - number | null: Vektor-Dimension einer bestehenden Collection
 *   - string[]: Liste aller Collection-Namen
 *   - {pointsCount, vectorsCount} | null: Collection-Statistiken
 *
 * NEBENEFFEKTE:
 *   - Qdrant: Erstellt oder loescht Collections
 *   - Warnt bei Dimensions-Mismatch (altes Modell vs. neue Embedding-Dimension)
 *   - ensureAllCollections() erstellt globale tech_docs Collection
 *   - ensureProjectCollections() erstellt alle 7 Projekt-Collections auf einmal
 */

import { getQdrantClient } from './client.js';
import { COLLECTIONS } from '../types/index.js';
import { getEmbeddingDimension } from '../embeddings/index.js';

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
 * Liest die Vektor-Dimension einer existierenden Collection
 * Gibt null zurueck wenn Collection nicht existiert
 */
export async function getCollectionVectorSize(name: string): Promise<number | null> {
  const client = getQdrantClient();
  try {
    const info = await client.getCollection(name);
    const vectors = info.config.params.vectors;
    if (vectors && typeof vectors === 'object' && 'size' in vectors) {
      return (vectors as { size: number }).size;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Prueft ob die Dimension einer Collection zum aktuellen Embedding-Modell passt
 */
export async function checkDimensionMatch(name: string): Promise<{
  match: boolean;
  collectionDim: number | null;
  currentDim: number;
}> {
  const currentDim = await getEmbeddingDimension();
  const collectionDim = await getCollectionVectorSize(name);

  return {
    match: collectionDim === null || collectionDim === currentDim,
    collectionDim,
    currentDim,
  };
}

/**
 * Erstellt eine Collection falls sie nicht existiert
 * Warnt bei Dimensions-Mismatch (automatische Migration erfolgt in initSynapse)
 */
export async function ensureCollection(
  name: string,
  vectorSize?: number
): Promise<void> {
  const client = getQdrantClient();
  const size = vectorSize ?? await getEmbeddingDimension();

  if (await collectionExists(name)) {
    // Dimensions-Mismatch pruefen
    const collectionDim = await getCollectionVectorSize(name);
    if (collectionDim !== null && collectionDim !== size) {
      console.error(
        `[Synapse] ⚠️ DIMENSIONS-MISMATCH: Collection "${name}" hat ${collectionDim}d, ` +
        `aktuelles Modell liefert ${size}d. Migration noetig.`
      );
    }
    return;
  }

  await client.createCollection(name, {
    vectors: {
      size,
      distance: 'Cosine',
    },
  });

  console.error(`[Synapse] Collection "${name}" erstellt (${size}d)`);
}

/**
 * Loescht eine Collection
 */
export async function deleteCollection(name: string): Promise<void> {
  const client = getQdrantClient();

  if (!(await collectionExists(name))) {
    console.error(`[Synapse] Collection "${name}" existiert nicht`);
    return;
  }

  await client.deleteCollection(name);
  console.error(`[Synapse] Collection "${name}" geloescht`);
}

/**
 * Erstellt alle Standard-Collections fuer Synapse
 */
export async function ensureAllCollections(): Promise<void> {
  console.error('[Synapse] Erstelle Standard-Collections...');

  // Dokumentations-Cache (global)
  await ensureCollection(COLLECTIONS.techDocs);

  console.error('[Synapse] Alle Standard-Collections bereit');
}

/**
 * Erstellt alle Collections fuer ein bestimmtes Projekt
 */
export async function ensureProjectCollections(project: string): Promise<void> {
  const collections = [
    COLLECTIONS.projectCode(project),
    COLLECTIONS.projectMedia(project),
    COLLECTIONS.projectMemories(project),
    COLLECTIONS.projectThoughts(project),
    COLLECTIONS.projectPlans(project),
    COLLECTIONS.projectProposals(project),
    COLLECTIONS.projectDocs(project),
  ];

  for (const col of collections) {
    await ensureCollection(col);
  }

  console.error(`[Synapse] Projekt-Collections fuer "${project}" bereit`);
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
