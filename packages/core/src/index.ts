/**
 * Synapse Core
 * Gemeinsamer Kern fuer MCP Server und REST API
 *
 * @packageDocumentation
 */

// Konfiguration
export { loadConfig, getConfig, resetConfig } from './config.js';

// Typen
export * from './types/index.js';

// Qdrant
export {
  getQdrantClient,
  testQdrantConnection,
  resetQdrantClient,
  collectionExists,
  ensureCollection,
  deleteCollection,
  ensureAllCollections,
  ensureProjectCollection,
  listCollections,
  getCollectionStats,
  getCollectionVectorSize,
  checkDimensionMatch,
  insertVector,
  insertVectors,
  searchVectors,
  deleteVector,
  deleteByFilter,
  deleteByFilePath,
  deleteByProject,
  getVector,
  scrollVectors,
} from './qdrant/index.js';

// Embeddings
export {
  getEmbeddingProvider,
  getEmbeddingDimension,
  embed,
  embedBatch,
  resetEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from './embeddings/index.js';
export type { EmbeddingProvider } from './embeddings/index.js';

// FileWatcher
export {
  startFileWatcher,
  readFileWithMetadata,
  isBinaryFile,
  isBinaryExtension,
  isExtractableDocument,
  getFileType,
  getFileExtension,
  loadGitignore,
  shouldIgnore,
  createDefaultIgnore,
  getDefaultIgnores,
} from './watcher/index.js';
export type { FileWatcherOptions, FileWatcherInstance } from './watcher/index.js';

// Chunking
export { chunkText, chunkFile } from './chunking/index.js';
export type { ChunkOptions, TextChunk } from './chunking/index.js';

// Services
export {
  // Code
  indexFile,
  updateFile,
  removeFile,
  handleFileEvent,
  searchCode,
  getProjectStats,
  // Thoughts
  addThought,
  getThoughts,
  searchThoughts,
  deleteThought,
  getThoughtsBySource,
  getThoughtsByTag,
  // Plans
  createPlan,
  getPlan,
  updatePlan,
  addTask,
  updateTask,
  deletePlan,
  // Docs
  cacheDoc,
  searchDocs,
  getDocsForFramework,
  clearDocsForFramework,
  searchDocsWithFallback,
  listCachedFrameworks,
  // Tech Detection
  detectTechnologies,
  // Context7
  getContext7Client,
  Context7Client,
  // Docs Indexer
  indexFrameworkDocs,
  indexProjectTechnologies,
  isFrameworkCached,
  cacheSearchResults,
  // Memory
  writeMemory,
  getMemoryByName,
  listMemories,
  searchMemories,
  deleteMemory,
  deleteProjectMemories,
  readMemoryWithRelatedCode,
  findMemoriesForPath,
  getRulesForNewAgent,
  // Documents
  extractDocument,
  extractPDF,
  extractWord,
  extractExcel,
  indexDocument,
  searchDocuments,
  removeDocument,
  // Global Search
  globalSearch,
  listSearchableProjects,
  // Proposals
  createProposal,
  getProposal,
  listProposals,
  updateProposalStatus,
  deleteProposal,
  searchProposals,
  // Backup
  dumpCollectionToFile,
  readBackupFile,
  getBackupDir,
  getBackupStats,
} from './services/index.js';
export type { BackupEntry } from './services/backup.js';
export type { Memory, MemoryWithRelatedCode, RelatedMemoryResult, RelatedCodeResult } from './services/memory.js';
export type { DetectedTechnology } from './services/tech-detection.js';
export type { Context7Doc, Context7SearchResult } from './services/context7.js';
export type { IndexedDoc } from './services/docs-indexer.js';
export type { ExtractedDocument, DocumentSearchResult } from './services/documents.js';
export type {
  GlobalSearchOptions,
  GlobalSearchResult,
  GlobalSearchItem,
  GlobalSearchMetadata,
  CodeSearchMetadata,
  ThoughtSearchMetadata,
  MemorySearchMetadata,
  SearchType,
} from './services/global-search.js';
export type { ProjectStatus } from './services/project-status.js';
export { getProjectStatus, setProjectStatus, isProjectInitialized, updateLastAccess, clearProjectStatus, isAgentKnown, registerAgent } from './services/project-status.js';

/**
 * Collections die Agenten-Daten enthalten und bei Modellwechsel gesichert werden
 * Code-Collections (project_{name}) und tech_docs_cache werden NICHT gesichert
 */
const MIGRATABLE_COLLECTIONS = [
  'project_thoughts',
  'synapse_memories',
  'project_plans',
  'synapse_proposals',
] as const;

/**
 * Ermittelt das Text-Feld fuer Re-Embedding anhand des Collection-Typs
 */
function getEmbeddingTextField(
  collectionName: string,
  payload: Record<string, unknown>
): string {
  if (collectionName === 'project_thoughts') {
    return (payload.content as string) || '';
  }
  if (collectionName === 'synapse_memories') {
    return (payload.content as string) || '';
  }
  if (collectionName === 'project_plans') {
    const name = (payload.name as string) || '';
    const desc = (payload.description as string) || '';
    const goals = (payload.goals as string[]) || [];
    return `${name} ${desc} ${goals.join(' ')}`.trim();
  }
  if (collectionName === 'synapse_proposals') {
    return (payload.description as string) || '';
  }
  return JSON.stringify(payload);
}

/**
 * Migriert eine einzelne Collection bei Dimensions-Mismatch
 * 1. Payloads sichern (JSONL)  2. Collection loeschen  3. Neu erstellen  4. Re-embedden
 */
async function migrateCollection(
  collectionName: string,
  newDim: number,
  oldDim: number
): Promise<{ migrated: number; failed: number }> {
  const { scrollVectors } = await import('./qdrant/operations.js');
  const { deleteCollection, ensureCollection } = await import('./qdrant/collections.js');
  const { insertVector } = await import('./qdrant/operations.js');
  const { embed } = await import('./embeddings/index.js');
  const { dumpCollectionToFile, getBackupDir } = await import('./services/backup.js');
  const path = await import('path');

  let migrated = 0;
  let failed = 0;

  // 1. Alle Payloads aus Qdrant lesen
  let points: Array<{ id: string; payload: Record<string, unknown> }> = [];
  try {
    points = await scrollVectors<Record<string, unknown>>(collectionName, {}, 10000);
  } catch {
    console.error(`[Synapse Migration] Konnte "${collectionName}" nicht lesen`);
    return { migrated: 0, failed: 0 };
  }

  if (points.length === 0) {
    console.error(`[Synapse Migration] "${collectionName}" ist leer, nur Dimension aktualisieren`);
    await deleteCollection(collectionName);
    await ensureCollection(collectionName, newDim);
    return { migrated: 0, failed: 0 };
  }

  // 2. JSONL-Backup schreiben (Sicherheitsnetz)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = getBackupDir();
  const backupPath = path.join(backupDir, `${collectionName}_${timestamp}.jsonl`);
  await dumpCollectionToFile(collectionName, backupPath);

  // 3. Collection loeschen und neu erstellen
  await deleteCollection(collectionName);
  await ensureCollection(collectionName, newDim);

  // 4. Alle Payloads re-embedden und einfuegen
  console.error(`[Synapse Migration] Re-embedde ${points.length} Eintraege fuer "${collectionName}"...`);

  for (const point of points) {
    try {
      const text = getEmbeddingTextField(collectionName, point.payload);
      if (!text) {
        failed++;
        continue;
      }
      const vector = await embed(text);
      await insertVector(collectionName, vector, point.payload, point.id);
      migrated++;

      if (migrated % 25 === 0) {
        console.error(`[Synapse Migration] "${collectionName}": ${migrated}/${points.length}`);
      }
    } catch (error) {
      failed++;
      console.error(`[Synapse Migration] Fehler bei ${point.id}: ${error}`);
    }
  }

  console.error(
    `[Synapse Migration] "${collectionName}": ${migrated} migriert, ${failed} fehlgeschlagen`
  );

  return { migrated, failed };
}

/**
 * Initialisiert Synapse Core
 * Testet Verbindungen, prueft Dimensions-Mismatch, migriert automatisch, erstellt Collections
 */
export async function initSynapse(): Promise<boolean> {
  console.error('[Synapse] Initialisiere...');

  // Qdrant testen
  const { testQdrantConnection } = await import('./qdrant/client.js');
  const qdrantOk = await testQdrantConnection();

  if (!qdrantOk) {
    console.error('[Synapse] Qdrant nicht erreichbar - Abbruch');
    return false;
  }

  // Embedding Provider testen
  const { getEmbeddingProvider, getEmbeddingDimension } = await import('./embeddings/index.js');

  try {
    await getEmbeddingProvider();
  } catch (error) {
    console.error('[Synapse] Kein Embedding Provider verfuegbar:', error);
    return false;
  }

  // Aktuelle Dimension ermitteln
  const currentDim = await getEmbeddingDimension();

  // Dimensions-Mismatch pruefen und automatisch migrieren
  const { getCollectionVectorSize, collectionExists: colExists } = await import('./qdrant/collections.js');

  let totalMigrated = 0;
  let totalFailed = 0;

  for (const collectionName of MIGRATABLE_COLLECTIONS) {
    if (!(await colExists(collectionName))) continue;

    const collectionDim = await getCollectionVectorSize(collectionName);
    if (collectionDim === null) continue;

    if (collectionDim !== currentDim) {
      console.error(
        `[Synapse] Dimensions-Mismatch erkannt: "${collectionName}" hat ${collectionDim}d, ` +
        `aktuelles Modell liefert ${currentDim}d. Starte automatische Migration...`
      );

      const result = await migrateCollection(collectionName, currentDim, collectionDim);
      totalMigrated += result.migrated;
      totalFailed += result.failed;
    }
  }

  if (totalMigrated > 0 || totalFailed > 0) {
    console.error(
      `[Synapse] Migration abgeschlossen: ${totalMigrated} Eintraege migriert, ${totalFailed} fehlgeschlagen`
    );
  }

  // Standard-Collections erstellen (fehlende werden angelegt)
  const { ensureAllCollections } = await import('./qdrant/collections.js');
  await ensureAllCollections();

  console.error('[Synapse] Initialisierung abgeschlossen');
  return true;
}
