/**
 * Synapse Core
 * Gemeinsamer Kern fuer MCP Server und REST API
 *
 * @packageDocumentation
 */

// Konfiguration
export { loadConfig, getConfig, resetConfig } from './config.js';

// Guide-Content (Tool-Doku, geteilt zwischen REST-API und MCP-Server)
export { GUIDE_OVERVIEW, TOOL_GUIDES } from './guide/index.js';
export type { ToolGuide, ActionGuide } from './guide/index.js';

// PostgreSQL
export { getPool, testDatabaseConnection, closePool, ensureSchema } from './db/index.js';

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
  deleteVectors,
  deleteByFilter,
  deleteByFilePath,
  deleteByProject,
  getVector,
  getVectors,
  scrollVectors,
} from './qdrant/index.js';

// Embeddings
export {
  getEmbeddingProvider,
  getEmbeddingDimension,
  embed,
  embedBatch,
  embedMedia,
  supportsMultimodal,
  resetEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  OpenAICompatibleProvider,
  GoogleEmbeddingProvider,
  CohereEmbeddingProvider,
} from './embeddings/index.js';
export type { EmbeddingProvider } from './embeddings/index.js';

// FileWatcher
export {
  startFileWatcher,
  readFileWithMetadata,
  isBinaryFile,
  isBinaryExtension,
  isExtractableDocument,
  isMultimodalFile,
  getMediaMimeType,
  getMediaCategory,
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
  // Project Registry
  registerProject,
  getProjectRoot,
  toRelativePath,
  toAbsolutePath,
  registerVirtualProject,
  setProjectEnabled,
} from './services/project-registry.js';

// Specialist Respawn Trigger (geteilt zwischen stdio MCP + REST API)
export { maybeTriggerRespawn } from './services/specialist-respawn.js';
export type { RespawnDecision } from './services/specialist-respawn.js';

// Agent-ID Resolver (zentrale Fallback-Logik fuer audit-relevante Schreib-Ops)
export { resolveAgentId } from './services/agent-id-resolver.js';

// Tool-Call Activity-Log (zentraler Audit-Store fuer shell(action:"activity"))
export { logToolCall, isMutationAction, queryToolCalls, expireOldToolCalls } from './services/tool-call-log.js';
export type { ToolCallLogEntry, ToolCallRow, ActivityFilters, ActivityDetail } from './services/tool-call-log.js';

// Model-Registry Service (DB-Loader fuer Spezialisten-Modelle)
export {
  getModel,
  listAliases as listModelAliases,
  listModels,
  listProviders,
  invalidateCache as invalidateModelCache,
  getProviderCredential,
  setProviderCredential,
} from './services/model-registry.js';
export type { ModelEntry as DbModelEntry, Provider as ModelProvider } from './services/model-registry.js';

// Shell-Exec (gemeinsam fuer MCP-Tool + REST /api/shell)
export {
  execShellInProject,
  getShellStream,
  isProjectActive,
} from './services/shell-exec.js';
export type { ShellExecArgs, ShellGetStreamArgs } from './services/shell-exec.js';

// Migrations
export { migrateToRelativePaths } from './migrations/migrate-to-relative-paths.js';

export {
  // Code
  indexFile,
  updateFile,
  removeFile,
  reconcileOrphans,
  renameCodeFile,
  verifyProjectAgainstFilesystem,
  handleFileEvent,
  searchCode,
  searchCodeBatch,
  getProjectStats,
  searchFilesByPath,
  backfillCodeFiles,
  parseUnparsedFiles,
  linkCrossFileReferences,
  getEmbeddingPending,
  embeddingPendingHint,
  resetProjectEmbeddings,
  EMBEDDING_PENDING_HINT,
  // Media
  indexMediaFile,
  indexMediaDirectory,
  removeMediaFile,
  searchMedia,
  // Thoughts
  addThought,
  addThoughtsBatch,

  updateThought,
  getThoughts,
  searchThoughts,
  deleteThought,
  deleteThoughts,
  getThoughtsBySource,
  getThoughtsByTag,
  getThoughtsByIds,
  // Plans
  createPlan,
  getPlan,
  updatePlan,
  addTasksBatch,
  deleteTasks,

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
  updateMemory,
  getMemoryByName,
  getMemoriesByNames,
  listMemories,
  searchMemories,
  deleteMemory,
  deleteMemories,
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
  updateProposal,
  getProposal,
  getProposalsByIds,
  listProposals,
  updateProposalStatus,
  deleteProposal,
  deleteProposals,
  searchProposals,
  // Code Intelligence (PG-only)
  getProjectTree,
  getFunctions,
  getVariables,
  getSymbols,
  getReferences,
  getStatements,
  getCallEdges,
  getExecutionFlow,
  getEntrypoints,
  fullTextSearchCode,
  getFileContent,
  applyContentRange,
  // Code Write
  replaceLines,
  insertAfterLine,
  deleteLines,
  searchReplace,
  searchReplaceBatch,
  contentHash,
  createFileInPg,
  updateFileInPg,
  softDeleteFile,
  moveFileInPg,
  copyFileInPg,
  getFileContentFromPg,
  // Backup
  dumpCollectionToFile,
  readBackupFile,
  getBackupDir,
  getBackupStats,
  backupProject,
  // Chat
  registerAgent as registerChatAgent,
  registerAgentsBatch,
  unregisterAgent as unregisterChatAgent,
  unregisterAgentsBatch,
  getAgentSession,
  listActiveAgents,
  sendMessage as sendChatMessage,
  getMessages as getChatMessages,
  // Tech-Docs
  addTechDoc,
  searchTechDocs,
  getDocsForFile,
  deleteTechDoc,
  updateTechDoc,
  // Events
  emitEvent,
  acknowledgeEvent,
  getPendingEvents,
  getUnackedCount,
  // Channels
  createChannel,
  deleteChannel,
  joinChannel,
  leaveChannel,
  removeAgentFromAllChannels,

  postChannelMessage,
  getChannelMessages,
  getChannelMembers,
  listChannels,
  getNewMessagesForAgent,
  ensureGeneralChannel,
  // Inbox
  postToInbox,
  checkInbox,
  getNewInboxMessages,
  getInboxHistory,
  // Error Patterns
  addErrorPattern,
  listErrorPatterns,
  deleteErrorPattern,
  checkErrorPatterns,
  getModelTier,
  deriveModelScope,
  // Shell-Queue
  enqueueShellJob,
  claimPendingShellJob,
  expirePendingShellJobs,
  completeShellJob,
  waitForShellJob,
  getShellJobs,
  getShellJobById,
  getShellJobLogLines,
  searchShellJobLog,
  insertCompletedShellJob,
  // Specialist-Queue
  enqueueSpecialistJob,
  claimPendingSpecialistJob,
  completeSpecialistJob,
  waitForSpecialistJob,
  expirePendingSpecialistJobs,

} from './services/index.js';
export type {
  EnqueueArgs,
  ShellJobRow,
  ShellJobCompletion,
  ShellJobResult,
} from './services/shell-queue.js';
export type {
  SpecialistAction,
  SpecialistJobRow,
  SpecialistJobCompletion,
  SpecialistJobResult,
} from './services/specialist-queue.js';

export type { FunctionInfo, VariableInfo, SymbolInfo, ReferenceInfo, ReferencesResult, FullTextSearchResult, FileContentResult, FileContentOptions, TreeOptions, StatementInfo, CallEdgeInfo, ExecutionFlowResult, EntrypointInfo } from './services/code-intel.js';
export type { BatchEdit, BatchResult } from './services/code-write.js';

// File-Versionierung (Schritt 1)
export {
  listFileVersions,
  listFileHistory,
  getFileVersion,
  restoreFileVersion,
  listBatchVersions,
  restoreBatch,
} from './services/file-versions.js';
export type { FileVersionMeta, FileVersionFull } from './services/file-versions.js';

// Wrapper-Status (PG Source-of-Truth fuer laufende Spezialisten)
export {
  upsertWrapperStatus,
  getWrapperStatus,
  listWrapperStatus,
  removeWrapperStatus,
} from './services/wrapper-status.js';
export type { WrapperStatusRow } from './services/wrapper-status.js';

// Skills (EXPERIMENTAL — Qdrant Skill-DB access)
export { searchSkills, listSkills, getSkillSection, getSkillFull } from './services/skills.js';
export type { SkillSearchHit, SkillListEntry, SkillSection } from './services/skills.js';

// Daemon-Heartbeat (Auto-Routing shell ↔ workspace)
export {
  upsertDaemonHeartbeat,
  isDaemonAliveForProject,
  getDaemonHeartbeat,
  clearDaemonHeartbeat,
} from './services/daemon-heartbeat.js';
export type { DaemonHeartbeatRow } from './services/daemon-heartbeat.js';

// Project-Init-Queue (Self-Service Project-Bootstrap fuer Web-KIs)
export {
  isValidProjectName,
  enqueueProjectInitJob,
  claimPendingProjectInitJob,
  completeProjectInitJob,
  expirePendingProjectInitJobs,
  waitForProjectInitJob,
  getProjectInitJob,
} from './services/project-init-queue.js';
export type { ProjectInitJobRow, ProjectInitStatus, ProjectInitCompletion } from './services/project-init-queue.js';

// Multi-File Edit-Plans (Schritt 2)
export {
  planBatch,
  commitBatch,
  cancelBatch,
  getBatchPlan,
} from './services/file-batch.js';
export type {
  FileBatchOp,
  FileBatchOpAction,
  OpPreview,
  FileBatchPlanRow,
  FileBatchStatus,
  PlanBatchResult,
  CommitBatchResult,
  CommitConflictDetail,
} from './services/file-batch.js';
export type { BackupEntry } from './services/backup.js';
export type { ChatMessage, AgentSession } from './services/chat.js';
export type { AgentEvent, EventAck, EventType, EventPriority } from './services/events.js';
export type { TechDoc, TechDocType, TechDocResult } from './services/tech-docs.js';
export type { ErrorPattern, ErrorPatternWarning } from './services/error-patterns.js';
export type { Memory, MemoryWithRelatedCode, RelatedMemoryResult, RelatedCodeResult } from './services/memory.js';
export type { DetectedTechnology } from './services/tech-detection.js';
export type { Context7Doc } from './services/context7.js';
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
// Parser Worker-Threads Pool
export { getParserPool, resetParserPool, ParserWorkerPool } from './parser/worker-pool.js';
export type { ParseArgs } from './parser/worker-pool.js';

export type { ProjectStatus } from './services/project-status.js';
export { getProjectStatus, setProjectStatus, isProjectInitialized, updateLastAccess, clearProjectStatus, isAgentKnown, registerAgent } from './services/project-status.js';
/**
 * Ermittelt das Text-Feld fuer Re-Embedding anhand des Collection-Suffixes
 */
function getEmbeddingTextField(
  collectionName: string,
  payload: Record<string, unknown>
): string {
  if (collectionName.endsWith('_thoughts')) {
    return (payload.content as string) || '';
  }
  if (collectionName.endsWith('_memories')) {
    return (payload.content as string) || '';
  }
  if (collectionName.endsWith('_plans')) {
    const name = (payload.name as string) || '';
    const desc = (payload.description as string) || '';
    const goals = (payload.goals as string[]) || [];
    return `${name} ${desc} ${goals.join(' ')}`.trim();
  }
  if (collectionName.endsWith('_proposals')) {
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
  newDim: number
): Promise<{ migrated: number; failed: number }> {
  const { scrollVectors } = await import('./qdrant/operations.js');
  const { deleteCollection, ensureCollection } = await import('./qdrant/collections.js');
  const { insertVector } = await import('./qdrant/operations.js');
  const { embed } = await import('./embeddings/index.js');
  const { dumpCollectionToFile, getBackupDir } = await import('./services/backup.js');
  const path = await import('path');

  let migrated = 0;
  let failed = 0;

  let points: Array<{ id: string; payload: Record<string, unknown> }> = [];
  try {
    points = await scrollVectors<Record<string, unknown>>(collectionName, {}, 10000);
  } catch {
    console.error(`[Synapse Migration] Konnte "${collectionName}" nicht lesen`);
    return { migrated: 0, failed: 0 };
  }

  if (points.length === 0) {
    await deleteCollection(collectionName);
    await ensureCollection(collectionName, newDim);
    return { migrated: 0, failed: 0 };
  }

  // JSONL-Backup schreiben (Sicherheitsnetz)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = getBackupDir();
  const backupPath = path.join(backupDir, `${collectionName}_${timestamp}.jsonl`);
  await dumpCollectionToFile(collectionName, backupPath);

  await deleteCollection(collectionName);
  await ensureCollection(collectionName, newDim);

  console.error(`[Synapse Migration] Re-embedde ${points.length} Eintraege fuer "${collectionName}"...`);

  for (const point of points) {
    try {
      const text = getEmbeddingTextField(collectionName, point.payload);
      if (!text) { failed++; continue; }
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

  console.error(`[Synapse Migration] "${collectionName}": ${migrated} migriert, ${failed} fehlgeschlagen`);
  return { migrated, failed };
}

/**
 * Initialisiert Synapse Core
 * Testet Verbindungen (PostgreSQL, Qdrant, Embeddings), erstellt Collections
 *
 * @param projectName - Projekt-Name (Pflicht). Erstellt Per-Projekt Collections
 *   und migriert bei Dimensions-Mismatch automatisch mit Backup.
 */
export async function initSynapse(projectName: string): Promise<boolean> {
  console.error(`[Synapse] Initialisiere Projekt "${projectName}"...`);

  // 0. Embedding-Provider resetten damit aktuelle Config geladen wird
  const { resetEmbeddingProvider } = await import('./embeddings/index.js');
  resetEmbeddingProvider();

  // 1. PostgreSQL testen + Schema sicherstellen
  const { testDatabaseConnection, ensureSchema } = await import('./db/index.js');
  const dbOk = await testDatabaseConnection();
  if (dbOk) {
    await ensureSchema();
  } else {
    console.error('[Synapse] PostgreSQL nicht erreichbar - fahre ohne DB fort');
  }

  // 2. Qdrant testen
  const { testQdrantConnection } = await import('./qdrant/client.js');
  const qdrantOk = await testQdrantConnection();
  if (!qdrantOk) {
    console.error('[Synapse] Qdrant nicht erreichbar - Abbruch');
    return false;
  }

  // 3. Embedding Provider testen
  const { getEmbeddingProvider, getEmbeddingDimension } = await import('./embeddings/index.js');
  try {
    await getEmbeddingProvider();
  } catch (error) {
    console.error('[Synapse] Kein Embedding Provider verfuegbar:', error);
    return false;
  }

  const currentDim = await getEmbeddingDimension();

  // 4. Per-Projekt Collections pruefen und bei Mismatch migrieren
  const {
    getCollectionVectorSize,
    collectionExists: colExists,
    deleteCollection: delCol,
    ensureCollection: ensCol,
    ensureAllCollections,
    ensureProjectCollections,
  } = await import('./qdrant/collections.js');

  const { COLLECTIONS } = await import('./types/index.js');

  // Alle Per-Projekt Collections dieses Projekts
  const projectCollections = [
    COLLECTIONS.projectMemories(projectName),
    COLLECTIONS.projectThoughts(projectName),
    COLLECTIONS.projectPlans(projectName),
    COLLECTIONS.projectProposals(projectName),
    COLLECTIONS.projectCode(projectName),
    COLLECTIONS.projectMedia(projectName),
    COLLECTIONS.projectDocs(projectName),
  ];

  let totalMigrated = 0;
  let totalFailed = 0;

  for (const colName of projectCollections) {
    if (!(await colExists(colName))) continue;

    const colDim = await getCollectionVectorSize(colName);
    if (colDim === null) continue;

    if (colDim !== currentDim) {
      // Code-Collections: einfach loeschen (Filewatcher re-indexiert)
      if (colName.endsWith('_code')) {
        console.error(
          `[Synapse] Code-Collection "${colName}" hat ${colDim}d, Modell liefert ${currentDim}d. ` +
          `Loesche und erstelle neu.`
        );
        await delCol(colName);
        await ensCol(colName, currentDim);
      } else {
        // Daten-Collections: mit Backup migrieren
        console.error(
          `[Synapse] Dimensions-Mismatch: "${colName}" hat ${colDim}d, Modell liefert ${currentDim}d. Migriere...`
        );
        const result = await migrateCollection(colName, currentDim);
        totalMigrated += result.migrated;
        totalFailed += result.failed;
      }
    }
  }

  if (totalMigrated > 0 || totalFailed > 0) {
    console.error(
      `[Synapse] Migration: ${totalMigrated} migriert, ${totalFailed} fehlgeschlagen`
    );
  }

  // 5. Globale + Projekt-Collections sicherstellen
  await ensureAllCollections();
  await ensureProjectCollections(projectName);

  // 6. code_files Backfill (einmalig: Qdrant → PostgreSQL)
  if (dbOk) {
    try {
      const { backfillCodeFiles } = await import('./services/code.js');
      await backfillCodeFiles(projectName);
    } catch (err) {
      console.warn(`[Synapse] code_files Backfill fehlgeschlagen: ${err}`);
    }
  }

  // 7. Ungeparste Dateien nachparsen (content vorhanden, parsed_at IS NULL)
  if (dbOk) {
    try {
      const { parseUnparsedFiles } = await import('./services/code.js');
      await parseUnparsedFiles(projectName);
    } catch (err) {
      console.warn(`[Synapse] parseUnparsedFiles fehlgeschlagen: ${err}`);
    }
  }

  console.error(`[Synapse] Projekt "${projectName}" bereit`);
  return true;
}
