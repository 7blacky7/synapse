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
  // Documents
  extractDocument,
  extractPDF,
  extractWord,
  extractExcel,
  indexDocument,
  searchDocuments,
  removeDocument,
} from './services/index.js';
export type { Memory } from './services/memory.js';
export type { DetectedTechnology } from './services/tech-detection.js';
export type { Context7Doc, Context7SearchResult } from './services/context7.js';
export type { IndexedDoc } from './services/docs-indexer.js';
export type { ExtractedDocument, DocumentSearchResult } from './services/documents.js';
export type { ProjectStatus } from './services/project-status.js';
export { getProjectStatus, setProjectStatus, isProjectInitialized, updateLastAccess, clearProjectStatus } from './services/project-status.js';

/**
 * Initialisiert Synapse Core
 * Testet Verbindungen und erstellt Collections
 */
export async function initSynapse(): Promise<boolean> {
  console.log('[Synapse] Initialisiere...');

  // Qdrant testen
  const { testQdrantConnection } = await import('./qdrant/client.js');
  const qdrantOk = await testQdrantConnection();

  if (!qdrantOk) {
    console.error('[Synapse] Qdrant nicht erreichbar - Abbruch');
    return false;
  }

  // Standard-Collections erstellen
  const { ensureAllCollections } = await import('./qdrant/collections.js');
  await ensureAllCollections();

  // Embedding Provider testen
  const { getEmbeddingProvider } = await import('./embeddings/index.js');

  try {
    await getEmbeddingProvider();
  } catch (error) {
    console.error('[Synapse] Kein Embedding Provider verfuegbar:', error);
    return false;
  }

  console.log('[Synapse] Initialisierung abgeschlossen');
  return true;
}
