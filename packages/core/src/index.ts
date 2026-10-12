/**
 * Synapse Core
 * Gemeinsamer Kern fuer MCP Server und REST API
 *
 * @packageDocumentation
 */

// P6-T27: optionale Ghost-Schatten, Standardabfragen unveraendert.
export { mitCodeIntelSchatten, schattenCacheStatistik } from './services/code-intel-schatten.js';
export type { RegelVerzeichnis } from './services/agent-rollen.js';
// P10-T33: gemeinsame Shell-Maske, auch fuer Lage-/Audit-Daten.
export {maskiereShellAntwort,maskiereShellDaten,maskiereShellText,ladeShellWerte,mitShellAusgabe,shellSichtUnmaskiert} from './services/shell-maske.js';

export { holeAgentOnboarding } from './services/agent-onboarding.js';

export { ermittleProjektAusPfad } from './services/project-registry.js';

// Konfiguration
export { loadConfig, getConfig, resetConfig } from './config.js';

// Guide-Content (Tool-Doku, geteilt zwischen REST-API und MCP-Server)
export { GUIDE_OVERVIEW, TOOL_GUIDES } from './guide/index.js';
export type { ToolGuide, ActionGuide } from './guide/index.js';

// PostgreSQL
export { getPool, getHintergrundPool, imHintergrund, istImHintergrund, testDatabaseConnection, closePool, ensureSchema, pruefeSchema, stelleSchemaSicher, schemaModus, leereSchemaWarnung, SCHEMA_KENNUNG } from './db/index.js';
export type { SchemaModus, SchemaPruefung, SchemaStandArt, SchemaSicherErgebnis } from './db/index.js';

// Typen
export * from './types/index.js';

// Asset-Intel (Nicht-Quellcode-Dateien): Inspektion + Speichern (P4-T60 ff., P4-T67)
export * from './asset-intel/index.js';
export {
  speichereAssetErgebnis,
  markiereAssetQuelleFehlt,
  benenneAssetUm,
  aktualisiereVerweisZiel,
  entferneAssetsEndgueltig,
  findeVerschobenesAsset,
  loesePfadAuf,
  normalisiereAssetPfad,
  dateisystemPruefer,
  ASSET_MAX_OBJEKTE_STANDARD,
  ASSET_LOESCHFRIST_TAGE,
} from './services/asset-intel-store.js';
export type {
  AssetAufloesung,
  AufloesungsKontext,
  VerweisAufloesung,
  SpeicherOptionen,
  SpeicherErgebnis,
  QuelleFehltErgebnis,
  EntfernenOptionen,
} from './services/asset-intel-store.js';
// Asset-Intel: Indexierung im lokalen Watcher (P4-T67, Etappe D)
export {
  verarbeiteAssetEreignis,
  verifyAssetsAgainstFilesystem,
  konfiguriereAssetSync,
  assetSyncZaehler,
  setzeAssetSyncZaehlerZurueck,
  assetWegAbgeschaltet,
  setzeAssetWegZurueck,
  warteAufAssetLeerlauf,
  beendeAssetSync,
} from './services/asset-intel-sync.js';
export type { AssetSyncKonfiguration, AssetSyncZaehler, AssetVerifyErgebnis } from './services/asset-intel-sync.js';
export { AssetInspektionsWorker, WORKER_GNADENFRIST_MS } from './asset-intel/worker-runner.js';
export type { WorkerInspektionsOptionen } from './asset-intel/worker-runner.js';
export { assetArt, assetEndungen, leseDateiKopf, KOPF_BYTES } from './watcher/binary.js';
export type { AssetArt } from './watcher/binary.js';
// Asset-Intel Lesen + Tool asset_intel (P4-T67/T70, Etappe B1)
export {
  holeAssetBaum,
  inspiziereAusDb,
  holeObjekte,
  holeVerweise,
  holeBenutztVon,
  holeFehlende,
  holeGraph,
  holeWurzelnUndWaisen,
  sucheAssets,
  sucheAssetsBatch,
  movePreview,
  assetHealth,
  parseAssetFilter,
  zerlegeSuchanfrage,
  kappeAntwort,
  escapeLike,
  AssetIntelFehler,
  ASSET_ANTWORT_MAX,
  ASSET_DATA_WERT_MAX,
  ASSET_MAX_FILTER,
  ASSET_GRAPH_MAX_TIEFE,
  ASSET_LESE_TIMEOUT_MS,
  ASSET_STATUS,
} from './services/asset-intel-abfragen.js';
export type {
  AssetFilter,
  AssetFilterOp,
  BaumOptionen,
  InspektionsOptionen,
  AssetInspektion,
  ObjektOptionen,
  VerweisOptionen,
  GraphOptionen,
  AssetGraph,
  SuchOptionen,
} from './services/asset-intel-abfragen.js';
export { ASSET_INTEL_DEFINITION, ASSET_INTEL_ACTIONS, fuehreAssetIntelAus } from './services/asset-intel-tool.js';
export type { AssetIntelAction } from './services/asset-intel-tool.js';
// Intern-Tool (P14): Schalter fuer interne Ablaeufe + Tool-Definition/Dispatcher (nur bei SYNAPSE_INTERN_TOOL=1)
export {
  INTERN_SCHALTER,
  InternSchalterFehler,
  setzeSchalter,
  leseSchalter,
  alleSchalter,
  hoechstdauerMs,
  istSchalterName,
  schalterHaeltAn,
  embeddingNachtragAngehalten,
} from './services/intern-schalter.js';
export type { InternSchalterName, InternSchalterStand, SetzeSchalterOptionen } from './services/intern-schalter.js';
// P15-T12: Worker-Steuerung im Prozess-Speicher (pausieren/fortsetzen/durchlauf) fuer das intern-Tool
export {
  registriereWorker,
  workerPausiert,
  meldeWorkerArbeit,
  pausiereWorker,
  setzeWorkerFort,
  loeseWorkerDurchlaufAus,
  workerStatus,
  workerNamen,
  workerPauseMaxMin,
  WorkerSteuerungFehler,
} from './services/worker-steuerung.js';
export type { WorkerDefinition, WorkerPause, WorkerStand, PausiereOptionen } from './services/worker-steuerung.js';
// P15-T12 E2: Befehle an lokale Daemons ueber den API-Long-Poll (nur Speicher)
export {
  DAEMON_BEFEHLE,
  DaemonBrueckeFehler,
  holeDaemonBefehle,
  stelleDaemonBefehleZurueck,
  meldeDaemonAntwort,
  meldeDaemonStatus,
  daemonUebersicht,
  sendeAnDaemon,
  istGueltigerHost,
  vergissDaemons,
} from './services/daemon-bruecke.js';
export type { DaemonBefehl, DaemonBefehlName, DaemonUebersicht } from './services/daemon-bruecke.js';
// P15-T23: Diagnose-Befehle im Daemon (sync_datei, parser_pool)
export { fuehreDiagnoseLokal, syncDateiLokal, DIAGNOSE_DAEMON_BEFEHLE } from './services/intern-diagnose-daemon.js';
export type { DiagnoseDaemonKontext } from './services/intern-diagnose-daemon.js';
// P15-T12 E3/E4: Warteschlangen einsehen/umsortieren (Speicher-Register je Prozess + PG in der API)
export {
  registriereWarteschlange,
  holeWarteschlange,
  warteschlangenNamen,
  vergissAlleWarteschlangen,
  seiteAusListe,
} from './services/warteschlangen-register.js';
export type {
  WarteschlangenDefinition,
  WarteschlangenEintrag,
  WarteschlangenFilter,
  WarteschlangenListe,
  VerschiebeAuftrag,
  VerschiebeZiel,
} from './services/warteschlangen-register.js';
export {
  WARTESCHLANGEN_ACTIONS,
  WarteschlangenFehler,
  fuehreWarteschlangeAus,
  fuehreWarteschlangeLokal,
  istWarteschlangenAction,
} from './services/intern-warteschlangen.js';
export {
  WAITS_ACTIONS,
  fuehreWaitsAus,
  istWaitsAction,
  toteWaitsListe,
  toteWaitsSichernUndSchliessen,
} from './services/intern-waits.js';
export type { ToterWait, WaitGeschlossen } from './services/intern-waits.js';
export { assetWarteschlange } from './services/asset-intel-sync.js';
export { embeddingWarteschlangeEintraege } from './embeddings/index.js';
export { listeFaelligeDateien } from './services/code.js';
export {
  INTERN_DEFINITION,
  INTERN_ACTIONS,
  INTERN_TOOL_AUS,
  internToolAktiv,
  fuehreInternAus,
  fuehreWorkerActionAus,
} from './services/intern-tool.js';
export type { InternAction } from './services/intern-tool.js';
export {
  InternOllamaFehler,
  ollamaStatus,
  ollamaEntladen,
  ollamaLaden,
  embeddingMessen,
  geladeneModelle,
  gleichesModell,
  ollamaBasis,
} from './services/intern-ollama.js';
export type { GeladenesModell } from './services/intern-ollama.js';
export { internStatus, dbSitzungen, langsameAufrufe, registriereInternQuelle } from './services/intern-einblick.js';
// Asset-Weiche code_intel <-> asset_intel + Baum-Marker (P4-T67/T70, Etappe C)
export {
  ergaenzeCodeIntelAntwort,
  loeseDateiWelt,
  projektHatAssets,
  vergissAssetStand,
  holeBaumAssets,
  assetMarker,
  assetSammelZeile,
  assetGroesse,
  findeCodeDatei,
  zaehleCodeDateien,
  BAUM_ASSETS_JE_VERZEICHNIS,
  WEICHE_SUCHTREFFER_MAX,
  WEICHE_SUCH_ZEITGRENZE_MS,
} from './services/asset-weiche.js';
export type { AssetKurz, DateiWelt, BaumAsset, BaumAssets } from './services/asset-weiche.js';

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
  mitPraefix,
  aktivePraefixe,
  embeddingModellName,
  embeddingModellKennung,
  // P15-T8: Modellprofile aus PG (Praefixe, num_ctx, Stueckgroesse, Score-Schwellen je Zweck)
  aktivesModellprofil,
  modellprofilStand,
  sichereModellprofil,
  geladenesModellprofil,
  vergissModellprofil,
  scoreSchwelle,
  scoreSchwelleOderHinweis,
  ModellNichtKalibriertError,
  SCORE_ZWECKE,
  zielDimension,
  getEmbeddingQueueStats,
  EmbeddingQueueFullError,
  embedMedia,
  supportsMultimodal,
  resetEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  OpenAICompatibleProvider,
  GoogleEmbeddingProvider,
  CohereEmbeddingProvider,
} from './embeddings/index.js';
// P15-T1: Modellwerte aus Ollama (Digest, Groesse, VRAM, Dimension, Kontext) statt fest verdrahtet
export { ollamaModellInfo, vergissOllamaModellInfo } from './embeddings/ollama-modell-info.js';
export type { OllamaModellInfo } from './embeddings/ollama-modell-info.js';
export type {
  EmbeddingProvider,
  EmbedOptions,
  EmbedPriority,
  EmbeddingQueueStats,
} from './embeddings/index.js';

// FileWatcher
export {
  startFileWatcher,
  readFileWithMetadata,
  isBinaryFile,
  isBinaryExtension,
  isExtractableDocument,
  isMultimodalFile,
  klassifiziereDatei,
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
  listeProjekte,
  toRelativePath,
  toAbsolutePath,
  registerVirtualProject,
  setProjectEnabled,
  isProjectEnabled,
  getProjectRegistryRows,
} from './services/project-registry.js';
export type { ProjectRegistryRow, ProjektEintrag } from './services/project-registry.js';

// Symbol umbenennen auf Basis der aufgeloesten Referenzen (Vorschau; die
// Ausfuehrung laeuft ueber den normalen Mehrfach-Schreibweg).
export { planeUmbenennung } from './services/code-rename.js';
export type {
  UmbenennungsPlan,
  UmbenennungsStelle,
  UebersprungeneStelle,
} from './services/code-rename.js';

// Specialist Respawn Trigger (geteilt zwischen stdio MCP + REST API)
export { maybeTriggerRespawn } from './services/specialist-respawn.js';
export type { RespawnDecision } from './services/specialist-respawn.js';

// Agent-ID Resolver (zentrale Fallback-Logik fuer audit-relevante Schreib-Ops)
export { resolveAgentId } from './services/agent-id-resolver.js';

// PA-1: unbekannte Tool-Parameter melden statt still verwerfen.
// Liegt in core, weil BEIDE Strecken (stdio-MCP und REST) dieselbe Pruefung brauchen —
// zwei Kopien waeren genau die Doppelpflege, gegen die der Fix gebaut wurde.
export { pruefeUnbekannteParameter, baueErlaubteParameter } from './services/unbekannte-parameter.js';
export type { ParameterBefund } from './services/unbekannte-parameter.js';

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

// Kontext-Korridor (Schwellen fuer Warnung/Handoff/Rotation, alle Stufen der Kette)
export {
  berechneKontextSchwellen,
  fallbackKorridor,
  KORRIDOR_200K,
  KORRIDOR_1M,
  ROTATION_PROZENT,
  HANDOFF_VORLAUF_TOKENS,
} from './services/kontext-korridor.js';
export type { KorridorWerte, KontextSchwellen } from './services/kontext-korridor.js';
export { pruefeRespawnKorridor } from './services/specialist-respawn.js';
export type { KorridorPruefung } from './services/specialist-respawn.js';

// shell(exec): Warten bei neuer Channel-Nachricht unterbrechen (Task b5b5304a)
export {
  warteAufChannelNachricht, pruefeUnterbrechung, leseChannelNotify, istChannelMitglied,
  unterbrechungsMeldung, SHELL_UNTERBRECHUNG_HINWEIS, CHANNEL_NOTIFY_KANAL,
} from './services/shell-channel-unterbrechung.js';
export type { ChannelUnterbrechung } from './services/shell-channel-unterbrechung.js';

// Kurz-IDs fuer Plaene und Tasks (P<n>, P<n>-T<m>) + Befuellungs-Logik fuer scripts/plaene-kurz-ids.mjs
export {
  planNummer, taskNummer, planKurzId, taskKurzId, waehleAktiven, ergaenzeTaskKurzIds, planeKurzIds,
} from './services/plan-kurz-ids.js';
export type { KurzIdZeile, KurzIdAenderung } from './services/plan-kurz-ids.js';
export type { PlanRef, PlanListenEintrag, VerschiebeErgebnis } from './services/plans.js';

// Selbstzuweisung: plan(passende_tasks) / plan(uebernehmen) (Aufgabe C)
export { passendeTasks, uebernehmeTask, passtZuProfil, ladeAgentProfil } from './services/plan-zuweisung.js';
export type { AgentProfil } from './services/plan-zuweisung.js';

// Selbstauskunft fuer Spezialisten: specialist(action:'selbst')
export { selbstAuskunft } from './services/specialist-selbst.js';
export { listWrapperStatusFuerAgent } from './services/wrapper-status.js';

// Effort-Stufen fuer claude --effort (Spezialisten)
export { EFFORT_STUFEN, istEffortStufe, pruefeEffort, waehleEffort } from './services/effort.js';
export type { EffortStufe } from './services/effort.js';

// Modell-Empfehlung je Plan-Task per Jev (plan action 'empfehlen', EXPERIMENTELL)
export { empfehleFuerPlan, loeseKandidatenAuf, baueAuswahl, pruefeLage, filtereNachLage, frageTeil, JEV_STANDARD_URL, JEV_STANDARD_MODELL, EINZIGE_OPTION } from './services/jev-empfehlung.js';
export type { EmpfehlenOptionen, EmpfehlenErgebnis, JevEmpfehlung, JevDeps, JevKontext, JevLage, ModellAuswahl } from './services/jev-empfehlung.js';
// Tasks per Jev dem passenden Plan zuordnen (plan action 'einordnen')
export { ordneTasksEin, EINORDNEN_MAX_TASKS, EINORDNEN_BLOCK } from './services/plan-einordnen.js';
export type { EinordnenOptionen, EinordnenDeps, EinordnenZeile, EinordnenErgebnis } from './services/plan-einordnen.js';
export { JEV_KATALOG, JEV_GRUPPEN, JEV_STANDARD_KANDIDATEN } from './services/jev-criteria.js';
export { MODELLWAHL_CRITERIA, KATALOG_QUELLE as JEV_KATALOG_QUELLE, KATALOG_STAND as JEV_KATALOG_STAND } from './services/jev-criteria-katalog.js';
export type { JevKandidat, JevOption, JevFamilie } from './services/jev-criteria.js';

// Model-Cutoffs (Wissensstand je Modell, Tabelle model_cutoffs)
export {
  resolveCutoff,
  normalisiereModell,
  invalidateCutoffCache,
  MODEL_CUTOFF_SEED,
} from './services/model-cutoffs.js';
export { pruefeShellText, ladeShellSicherungsKatalog, seedShellSicherung, zaehleShellSicherungsBestand } from './services/shell-sicherung.js';
export type { ShellSicherungsKatalog, ShellTextErgebnis, ShellSicherungsRegel, ShellAntwortEintrag } from './services/shell-sicherung.js';
export { ermittleShellLage } from './services/shell-lage.js';
export type { ShellLage, ShellLageKontext } from './services/shell-lage.js';
export { probeShellLage, shellLageProbeProgramm } from './services/shell-lage-probe.js';
export type { ShellProbeAnfrage, ShellProbeAntwort } from './services/shell-lage-probe.js';
export { waehleShellStart } from './services/shell-start.js';

// Shell-Exec (gemeinsam fuer MCP-Tool + REST /api/shell)
export {
  execShellInProject,
  getShellStream,
  isProjectActive,
} from './services/shell-exec.js';
export type { ShellExecArgs, ShellGetStreamArgs } from './services/shell-exec.js';
export {
  baueJobUmgebung,
  ergaenzeJobPfad,
  vergissJobUmgebungCache,
  SYNAPSE_DB_HINWEIS,
} from './services/shell-job-umgebung.js';
export type { JobUmgebung, JobUmgebungInfo, BaueJobUmgebungOptionen } from './services/shell-job-umgebung.js';

// Migrations
export { migrateToRelativePaths } from './migrations/migrate-to-relative-paths.js';

// Embedding-Backlog (EMBED-1): Nachzug fuer nebenlaeufig angestossene Embeddings
export {
  embeddeOffeneEintraege,
  zaehleOffeneEmbeddings,
  EMBED_PENDING_HINT,
} from './services/embed-backlog.js';
export type { BacklogErgebnis } from './services/embed-backlog.js';

// GPU-2: verteilte Code-Chunk Pull-Claims (API und lokaler Unraid-Fallback).
export {
  claimEmbeddingChunks,
  completeEmbeddingClaim,
  completeEmbeddingClaims,
  validateEmbeddingVector,
} from './services/embedding-claims.js';
export type {
  EmbeddingChunkClaim,
  CompleteEmbeddingClaimInput,
  CompleteEmbeddingClaimResult,
  ClaimOptions,
} from './services/embedding-claims.js';
export { deterministicChunkPointId, embeddingContentHash } from './services/embedding-chunk-id.js';

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
  projekteMitBacklog,
  linkCrossFileReferences,
  getEmbeddingPending,
  embeddingPendingHint,
  EMBEDDING_PENDING_HINT,
  resetProjectEmbeddings,
  resetProjectParse,
  reparseProject,
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
  listPlans,
  aktivierePlan,
  aendereTasks,
  getAllePlaene,
  findeTaskInPlan,
  resolveProjectTaskId,
  verschiebeTasks,
  planUebersicht,
  listPlansDetail,
  zurueckstellePlan,
  zurueckstelleTask,
  filtereWiedervorlageTasks,
  filtereNachTaskIds,
  taskSchlaeft,
  taskBis,
  planKontext,
  planRefVon,
  hinweisPlaene,
  planIndex,

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
  getOnboardingMemories,
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
  searchReplaceEindeutig,
  findeTreffer,
  trefferFehlerMeldung,
  contentHash,
  createFileInPg,
  updateFileInPg,
  softDeleteFile,
  moveFileInPg,
  copyFileInPg,
  snapshotFileVersion,
  getFileContentFromPg,
  // Backup
  dumpCollectionToFile,
  readBackupFile,
  getBackupDir,
  getBackupStats,
  backupProject,
  // Ignore-Regeln
  listeIgnoreRegeln,
  fuegeIgnoreRegelnHinzu,
  blendeVoruebergehendEin,
  loeseDauerInSekunden,
  entferneIgnoreRegel,
  schalteIgnoreRegel,
  pruefeIgnorePfad,
  markiereIgnorierteDateien,
  markiereEinzelneDateiIgnoriert,
  pruefeUndBereiteSchreibenVor,
  // Chat
  registerAgent as registerChatAgent,
  registerAgentsBatch,
  unregisterAgent as unregisterChatAgent,
  unregisterAgentsBatch,
  getAgentSession,
  listActiveAgents,
  expireIdleAgentSessions,
  sendMessage as sendChatMessage,
  getMessages as getChatMessages,
  // P15-T32: Sitzungs-Signal (admin index_stats sitzung, Spezialisten-Spawn)
  SITZUNGS_ARTEN,
  SITZUNG_PARAMETER,
  pruefeSitzungsArt,
  beginneSitzung,
  wendeSitzungsSignalAn,
  // Agent-Rollen (Regel-Sichtbarkeit — geteilt von MCP-Server und REST-API)
  erlaubteRollen,
  regelSichtbarFuer,
  baueOnboardingRegeln,
  baueOnboardingRegelwerk,
  baueRegelAbrufHinweis,
  rolleFuerAgent,
  rollenQuelleKlartext,
  tagVerdacht,
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
  getPendingEventHints,
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
  recordChannelRead,
  claimUnreadChannelHints,
  markChannelRead,
  NAVIGATIONSSCHWELLE,
  // Inbox
  postToInbox,
  checkInbox,
  getNewInboxMessages,
  getInboxHistory,
  removeInboxForAgent,
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
  cancelShellJob,
  hideShellJobHints,
  HINWEIS_SCHUTZ_MS,
  reapOrphanedRunningJobs,
  aktuellerDateistand,
  claimShellJobHints,
  pruneShellJobNotices,
  CANCEL_PROTECTED_MS,
  EXPIRE_PENDING_AFTER_SEC,
  DETACH_AFTER_MS,
  HARD_LIMIT_MS,
  // Specialist-Queue
  enqueueSpecialistJob,
  claimPendingSpecialistJob,
  completeSpecialistJob,
  waitForSpecialistJob,
  expirePendingSpecialistJobs,
  // Werkzeug-gebundene Regeln (2.2) — Regel haengt an der Handlung, nicht an der Rolle
  holeWerkzeugRegeln,
  baueWerkzeugMarken,
  WERKZEUG_REGEL_FELD,

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

export type { FunctionInfo, VariableInfo, SymbolInfo, ReferenceInfo, ReferencesResult, FullTextSearchResult, FileContentResult, FileContentOptions, TreeOptions, StatementInfo, CallEdgeInfo, CallEdgesResult, ExecutionFlowResult, EntrypointInfo } from './services/code-intel.js';
export type { BatchEdit, BatchResult, BatchFehlschlag } from './services/code-write.js';
// P15-T17: Einzelschreibweg (E-a) - Optionen und Ergebnis von createFileInPg/updateFileInPg
export type { EinzelSchreibOptionen, SchreibErgebnis } from './services/code-write.js';
export { getParserGesundheitDatei, getParserGesundheitUebersicht, backfillParserCoverage, schreibeParserCoverage } from './services/parser-health.js';
export type { ParserGesundheitDatei, ParserGesundheitUebersicht, ParserBefundGesamt, ParserUebersichtDatei } from './services/parser-health.js';

// File-Versionierung (Schritt 1)
export {
  listFileVersions,
  listFileHistory,
  getFileVersion,
  restoreFileVersion,
  listBatchVersions,
  restoreBatch,
  restoreBatchVorschau,
  versionsDiff,
} from './services/file-versions.js';
export type { FileVersionMeta, FileVersionFull, VersionDiff } from './services/file-versions.js';

// Wrapper-Status (PG Source-of-Truth fuer laufende Spezialisten)
export {
  upsertWrapperStatus,
  getWrapperStatus,
  listWrapperStatus,
  removeWrapperStatus,
} from './services/wrapper-status.js';
export { setzeHeartbeatKonfiguration, setzeHeartbeatBeimSpawn, steuereHeartbeat } from './services/wrapper-status.js';
// Thought-Kurz-IDs + PG als Quelle der Wahrheit (P10-T28)
export { holeThoughtsMitProblemen, aendereThoughtPerId, loescheThoughtsPerId } from './services/thoughts.js';
export type { ThoughtIdProblem, LoeschErgebnis } from './services/thoughts.js';
export { loeseThoughtIdsAuf, pruefeIdEingabe } from './services/thought-ids.js';
// Drift-Schutz fuer update: Anker pruefen (P7-T11 a), geteilt mit file-batch
export { leseUpdateAnker, hatUpdateAnker, pruefeUpdateAnker } from './services/update-anker.js';
export type { UpdateAnker } from './services/update-anker.js';
// Spawn-Eingaben in Worker-Form (P7-T9)
export { normalisiereSpawnEintrag, normalisiereSpawnBatch, baueSpawnJobArgs, pruefeSpawnEffort, SPAWN_BATCH_MAX } from './services/specialist-spawn-args.js';
export type { SpawnArgs, SpawnOptionen } from './services/specialist-spawn-args.js';
// Proposals: PG als Quelle der Wahrheit + Praefix-IDs (P10-T29)
export { holeProposalsMitProblemen, aendereProposalPerId, setzeProposalStatusPerId, loescheProposalsPerId } from './services/proposals.js';
export type { ProposalLoeschErgebnis } from './services/proposals.js';
export type { ProposalIdProblem } from './services/proposal-ids.js';
// specialist(status): Namensfilter + Leichen kenntlich machen (P7-T10)
export { waehleSpezialisten, parseNamen, veraltetSchwelleMs, beschrifteZeile, kennzeichnung, ausblendHinweis } from './services/spezialisten-status-filter.js';

// JEV-10: Jev entscheidet Rueckfragen, wenn der User weg ist (P7-T28)
export { holeJevModusHinweis, holeJevSitzungsHinweis, leereJevModusCache, JEV_MODUS_ZEILE } from './services/jev-modus-hinweis.js';
export {
  entscheideRueckfrage,
  setzeAbwesenheit,
  leseAbwesenheit,
  holeEntscheidungsProtokoll,
  ueberstimmeEntscheidung,
  hinweisText as jevEntscheidetHinweis,
  baueAbwesenheitsHinweis,
  ERLAUBTE_KATEGORIEN,
  VERBOTENE_KATEGORIEN,
  STANDARD_ENTSCHEIDUNG_TOR,
  STANDARD_MAX_RUNDEN,
  WEITERE_KEY,
  STANDARD_RATE_PRO_STUNDE,
} from './services/jev-entscheidung.js';
// P15-T33 E0.5: Jev-Schalter, gemeinsamer Jev-Client, Kosten/Budget, Steuerung am admin-Tool
export {
  JEV_FUNKTIONEN, JEV_ALLE, JevSchalterFehler, jevWirksam, jevEntscheidungsHinweiseAn, filtereJevTool, jevToolSperre,
  setzeJevSchalter, jevSchalterListe, leereJevSchalterCache,
} from './services/jev-schalter.js';
export type { JevFunktion, JevWirkung, JevSchalterZeile, SetzeJevSchalterOptionen } from './services/jev-schalter.js';
export { rufeJev, jevKonfig } from './services/jev-client.js';
export type { JevAnfrage, JevErgebnis, JevAntwortDaten, JevKonfig } from './services/jev-client.js';
export {
  bucheJevAufruf, jevKostenAusUsage, jevPreisJeMio, jevBudgetStand, jevBudgetPause, reserviereJevBudget, bucheJevBudget,
  setzeJevBudget, setzeJevBudgetZurueck, jevKostenUebersicht, holeJevKontostand,
} from './services/jev-kosten.js';
export type { JevBudgetStand, JevKostenUebersicht, JevAufrufBuchung, JevUsdQuelle } from './services/jev-kosten.js';
export { JEV_ADMIN_ACTIONS, JEV_ADMIN_BESCHREIBUNG, JEV_ADMIN_PARAMETER, istJevAdminAction, fuehreJevAdminAus } from './services/jev-admin.js';
export { JEV_SPRACHEN, JevOptionenFehler, leseJevOptionen, setzeJevOptionen, wirksameJevSprache } from './services/jev-optionen.js';
export type { JevSprache, JevOptionen, JevErklaerungSprachen } from './services/jev-optionen.js';
// P15-T33 E1: Erklaerungs-Topf (Jev waehlt, Claude erklaert)
export {
  ERKLAERUNG_ACTIONS, ERKLAERUNG_PARAMETER, ERKLAERUNG_STATUS, meldeFehlerfall, verarbeiteFehlerfall, baueSchatten, jevZustand,
  baueJevFrage, kriteriumText, waehleErklaerung, ladeKandidaten, pruefeGenerik, legeErklaerungAb, pruefeFall, verwerfeFall,
  listeOffeneFaelle, holeFall, listeErklaerungen, bewerteErklaerung, erklaerungenTagespruefung, fuehreErklaerungsActionAus,
  istErklaerungsAction, familieVon, schluesselVon, schwaerzeGeheimnisse,
  // P15-T33 E2: Startbestand, persistente Warteschlange, Onboarding-Zeile
  ladeErklaerungstopfSeed, erklaerungstopfSeedPfad, pruefeSeedEintrag, erklaerungstopfStatus, holeErklaerungsEreignisseNach,
  erklaerungsFaelleZeile,
} from './services/erklaerungen.js';
export type { Erklaerung, ErklaerungTexte, Schatten, Fehlerereignis, FallPruefung, JevVersuch } from './services/erklaerungen.js';
// P15 E1: Entscheidungs-Topf fuer Jev (Praezedenz, Sicherheit S2, Durchsicht, Seed, Thought-Spiegel)
export {
  TOPF_STATUS, TOPF_HERKUNFT, STANDARD_TOPF_KANDIDATEN, STANDARD_TOPF_TOR, STANDARD_IRREVERSIBEL_SCHWELLE, SICHERHEIT_MUSTER, IRREVERSIBEL_FRAGE,
  scanneSicherheitText, leseAufbereitung, schreibeTopfEintrag, legeEntscheidungAb, bereiteEntscheidungAuf, listeEntscheidungstopf, zaehleTopf,
  entscheidungstopfStatus, spiegeleThoughtInTopf, seedDateiPfad, ladeEntscheidungstopfSeed, topfDokText, topfKriterium, topfPraezedenzState,
  holeTopfKandidaten, ergaenzeTopfEmbeddings,
} from './services/entscheidungstopf.js';
export type { TopfEintrag, TopfAufbereitung, TopfEmbedFn, TopfDeps, TopfKandidat, TopfStatus } from './services/entscheidungstopf.js';
export { durchsichtEntscheidung, entscheidungsDurchsichtZeile, fuehreJevTopfActionAus, istJevTopfAction, JEV_TOPF_ACTIONS, JEV_TOPF_BESCHREIBUNG, JEV_TOPF_PARAMETER } from './services/jev-entscheidung.js';
export type { DurchsichtOptionen } from './services/jev-entscheidung.js';

// Agenten-Wissen in der Datenbank (API-Bruecke Schritt 4). Additiv — der
// Dateiweg in packages/agents/src/skills.ts bleibt unveraendert bestehen.
export {
  leseAgentWissen,
  leseWissensArt,
  agentIstBekannt,
  setzeWissen,
  haengeWissenAn,
  entferneWissenZeilen,
  legeAgentWissenAn,
  loescheAgentWissen,
  listeWissensAgenten,
  normalisiereArt,
  erlaubteArten,
  PROMPT_ARTEN,
  ALLE_ARTEN,
} from './services/agent-wissen.js';
export type {
  WissensArt,
  WissensForm,
  WissensEintrag,
  ArtSicht,
  AgentMetaDaten,
  AgentWissen,
} from './services/agent-wissen.js';
export {
  serialisiereAgentMeta,
  leseAgentMetaYaml,
  yamlSkalar,
} from './services/agent-meta-yaml.js';
export type { AgentMetaFelder } from './services/agent-meta-yaml.js';
export type { WrapperStatusRow, HeartbeatKonfiguration, HeartbeatUebersicht } from './services/wrapper-status.js';

// Skills (EXPERIMENTAL — Qdrant Skill-DB access)
export { mitFileTaskWarnung, ordneFileTasksZu } from './services/file-task-zuordnung.js';
export type { FileTaskZuordnung } from './services/file-task-zuordnung.js';
export { searchSkills, listSkills, getSkillSection, getSkillFull } from './services/skills.js';
// P12-T13 Teil 2: Skills PG-first schreiben
export {
  speichereSkillSection,
  loescheSkillSection,
  loescheSkill,
  ersetzeSkill,
  embeddeSkillSectionNach,
} from './services/skills.js';
export type { SkillSectionEingabe, SkillSchreibErgebnis, SkillSicht, SkillScope } from './services/skills.js';

// Free-Model-Pool: Katalog externer API-Modelle (vor allem kostenloser).
// Die Modelllisten kommen live von den Anbietern; gepflegt wird nur die Endpunkt-Registry.
export {
  PROVIDER_REGISTRY,
  getPoolSnapshot,
  getPoolProviders,
  getPoolModel,
  loeseAliasAuf,
  listeAliase,
  getAufrufZiel,
  searchPool,
  probeProvider,
  markiereFehlschlag,
  markiereErfolg,
  markiereAnbieterZugang,
  uebernimmFreigabe,
  setzeModellFreigabe,
  listeSperren,
  loescheSperren,
  invalidiereCredentialCache,
} from './services/free-model-pool.js';
export {
  classifyFailure,
  lohntWeiterenVersuch,
  istVermittlerFehler,
  leseWartezeit,
} from './services/free-model-pool-errors.js';
export type { FailureReason, ClassifiedFailure, FailureInput } from './services/free-model-pool-errors.js';
export {
  speichereArtefakt,
  aktualisiereArtefaktPfade,
  pruefeArtefaktEingabe,
  ARTEFAKT_HTML_MAX,
} from './services/artefakt.js';
export type { ArtefaktEingabe, ArtefaktZeile } from './services/artefakt.js';
export {
  setzeFreigabe,
  setzeDatenverwendung,
  leseProtokoll,
  listeCredentials,
  speichereCredential,
  leseCredentialGeheimnis,
} from './services/free-model-pool-store.js';
export type { CredentialZeile } from './services/free-model-pool-store.js';
export { getModelsDev, findeModel, listeProviderIds } from './services/models-dev.js';
export type { ModelsDevModel, ModelsDevProvider, ModelsDevRegistry } from './services/models-dev.js';
export type {
  AufrufZiel,
  PoolModel,
  PoolSnapshot,
  PoolFilter,
  PoolSuchergebnis,
  ProviderEntry,
  ProviderStatus,
  CostClass,
  Reachability,
  FreeType,
  WireFormat,
  AuthScheme,
} from './services/free-model-pool.js';
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

// Projekt-DB auf der Unraid-Projekt-Instanz (5433) beim Self-Service-Init
export {
  legeProjektDbAn,
  leseProjektDbInfo,
  leseProjektDbZugang,
  projektDbKurzinfo,
  ladeProjektDbKonfig,
  pruefeProjektDbZiel,
  leiteDbNamenAb,
  rollenNameFuer,
  bauPruefSql,
  bauRolleSql,
  bauAnlageSql,
  bauNachpruefSql,
  bauRueckbauSql,
  projektDbDsn,
  envHatDatabaseUrl,
  schreibeProjektDbEnv,
  ProjektDbSchutzFehler,
  PROJEKT_DB_MEMORY_NAME,
} from './services/projekt-db.js';
export type {
  ProjektDbErgebnis,
  ProjektDbAnlage,
  ProjektDbZugang,
  ProjektDbStatus,
  ProjektDbZiel,
  ProjektDbKonfig,
  PsqlAusfuehrer,
  LegeProjektDbAnOptionen,
} from './services/projekt-db.js';

// Serverseitige Skill-Hooks (HOOK-3/HOOK-4)
export {
  holeSprachSkillVorschlaege,
  waehleSprachSkills,
  holeChannelSkillVorschlaege,
  holeOffeneSkillVorschlaege,
  bereiteChannelSkillVorschlaegeVor,
  bereiteSkillVorschlaegeVor,
  holeChannelSkillsNachBeitritt,
  holeSkillsFuerQuellen,
  aktiveProjektAgenten,
  verarbeiteSkillHinweisgeber,
  sammleSkillQuellen,
  baueChannelSkillSuchtext,
  waehleChannelSkillTreffer,
} from './services/skill-hook.js';
export type {
  SkillVorschlag,
  SkillHookMetriken,
  SkillHookErgebnis,
  ChannelSkillNachricht,
} from './services/skill-hook.js';

// Multi-File Edit-Plans (Schritt 2)
export {
  planBatch,
  commitBatch,
  cancelBatch,
  getBatchPlan,
  addCoeditContribution,
  markCoeditReady,
  markCoeditNoChanges,
  getSharedPlanStatus,
  buildPlanStatusResponse,
  buildCompactPlanStatusResponse,
  buildCompactSharedPlanStatusResponse,
  replanBatch,
  failedOpsOf,
  PlanBatchOpsFailedError,
  planFailureResponse,
  buildCancelResponse,
  nichtsGeschriebenBefund,
  opZumNeuPlanen,
  pollPlanStatus,
  getPlanOpsVollstaendig,
  opIndicesLesen,
  planSchattenDiff,
  buildPlanStatusResponseMitDiff,
  schreibeCommitDiffs,
  pruefeGespeichertenPlan,
  befundeQuittierenLesen,
} from './services/file-batch.js';
export type { PlanDiff, PlanDiffDatei } from './services/file-batch.js';
export { dateiDiff, aenderungsBereiche, diffText } from './services/file-diff.js';
export { claimOpenPlanHints } from './services/plan-hints.js';
export type { OpenPlanHints, OpenPlanHintEntry } from './services/plan-hints.js';
export type {
  FileBatchOp,
  FileBatchOpAction,
  OpPreview,
  FileBatchPlanRow,
  FileBatchStatus,
  PlanBatchResult,
  CoeditWaitGroup,
  CoeditWaitStatus,
  CoeditAddResult,
  CoeditLifecycleResult,
  SharedPlanStatusResult,
  PlanStatusAnsicht,
  CommitBatchResult,
  CommitConflictDetail,
  CoeditConflictDetail,
  FailedPlanOp,
  SharedPlanRef,
  CancelBatchResult,
  WithdrawalRecord,
} from './services/file-batch.js';

// Kooperative Dateireservierungen (Co-Edit CE-1)
export {
  addFileReservations,
  releaseFileReservations,
  updateFileReservations,
  listFileReservations,
  normalizeReservationFilePaths,
  findForeignActiveReservationPrimaries,
  getDirectWriteReservationHint,
  getReservationTtlConfig,
  refreshReservationTtlsForFiles,
  renewFileReservationTtls,
  releaseStaleFileReservations,
  reservationTtlHint,
} from './services/file-reservations.js';
// P15-T36: Projekt-Pfade (eine Normalisierung + Sperre fuer files/files_batch, Plaene, Co-Edit, Reservierungen)
export {
  normalisiereProjektPfad,
  normalisiereOps,
  pruefeSchreibZiel,
  pruefeFilesPfadArgs,
  liegtImProjekt,
  PfadUngueltig,
  PfadGesperrt,
} from './services/projekt-pfad.js';
export type { PfadFehlerGrund, PfadFehlerAntwort } from './services/projekt-pfad.js';
// P15-T36 Teil 2: .env-Werte in allen Ausgaben maskieren (NAME=[WERT]), Platzhalter beim Schreiben = unveraendert
export {
  ENV_PLATZHALTER,
  istEnvDatei,
  istMcpJsonDatei,
  istMaskierteDatei,
  maskiereMcpJson,
  maskiereDatei,
  entmaskiereMcpJson,
  entmaskiereSensibleDatei,
  mcpJsonHinweise,
  mcpJsonSicht,
  maskiereMcpJsonDiffText,
  maskiereEnv,
  envSicht,
  entmaskiereEnv,
  envHinweise,
  maskiereEnvDiffText,
  maskiereEnvDiff,
  maskiereEnvOp,
  EnvSchreibweg,
  envHinweiseFuerBatch,
  schwaerzeEnvWerteInAntwort,
} from './services/env-maske.js';
export type {
  FileReservation,
  ReservationMutationResult,
  ReservationUpdateResult,
  AlreadyReleasedReservation,
  ForeignActiveReservationPrimary,
  DirectWriteReservationHint,
  ReservationTtlConfig,
} from './services/file-reservations.js';
export type { BackupEntry } from './services/backup.js';
export type { ChatMessage, AgentSession } from './services/chat.js';
export type { AgentEvent, EventAck, EventType, EventPriority } from './services/events.js';
export type { TechDoc, TechDocType, TechDocResult } from './services/tech-docs.js';
export type { ErrorPattern, ErrorPatternWarning } from './services/error-patterns.js';
// P15-T17 E0: Fehlermuster-Treffer an den Agenten ausliefern (Nachlieferung)
export { holeFehlermusterHinweise, verfolgeFehlermusterPruefung, vormerkenBefunde } from './services/fehlermuster-auslieferung.js';
// P15-T37: code_check - eine Definition + ein Dispatcher fuer stdio und REST; Musterpflege mit Selbsttest/Dubletten.
export { CODE_CHECK_DEFINITION, CODE_CHECK_ACTIONS, fuehreCodeCheckAus, kompaktesMuster } from './services/code-check-tool.js';
export { legeMusterAn, aendereMuster, findeDubletten, findeAehnliche, normalisiereErkennung, normalisiereGeltung, normalisiereVerweise } from './services/fehlermuster-pflege.js';
export type { MusterFelder, PflegeErgebnis, DublettenTreffer, AehnlichTreffer } from './services/fehlermuster-pflege.js';
// P15-T17: Pruefkern (Signatur-Muster, Syntax-Schnittstelle fuer P16-T4)
export {
  pruefeSignaturen,
  pruefeSyntaxEinzelweg,
  registriereSyntaxPruefer,
  hatSyntaxPruefer,
  geaenderteZeilen,
  ladeSignaturMuster,
  SyntaxfehlerAbgelehnt,
  QUITTIER_HINWEIS,
} from './services/fehlermuster-pruefung.js';
export type { FehlerBefund, SyntaxPruefer, SyntaxMeldung, SyntaxErgebnis } from './services/fehlermuster-pruefung.js';
// P16-T4: Syntaxpruefer Stufe 1 (TS/JS, JSON, CSS ...) im eigenen Worker-Pool
export {
  registriereStandardSyntaxPruefer,
  syntaxPoolZustand,
  beendeSyntaxPool,
  SyntaxWorkerPool,
  SyntaxPrueferTimeout,
  SyntaxPoolNichtVerfuegbar,
  PRUEFER_KATALOG,
} from './services/syntax-pruefer/index.js';
export type { PrueferDefinition } from './services/syntax-pruefer/index.js';
export type { FehlermusterHinweis, FehlermusterAuslieferung } from './services/fehlermuster-auslieferung.js';
export type { Memory, MemoryWithRelatedCode, RelatedMemoryResult, RelatedCodeResult } from './services/memory.js';
export type { DetectedTechnology } from './services/tech-detection.js';
export type { Context7Doc } from './services/context7.js';
export type { IndexedDoc } from './services/docs-indexer.js';
// P12-T17: Context7-Automatik, Kontingent und inhaltsbasierte Tech-Erkennung
export {
  initContext7Automatik,
  context7AutomatikTick,
  stosseContext7An,
  erkenneTechnologienAusPg,
  merkeContext7Abfrage,
} from './services/context7-automatik.js';
export { context7Kontingent, kontingentKonfig, reserviereContext7Aufruf } from './services/context7-kontingent.js';
export type { Context7Kontingent, Context7Stufe, Context7Aufrufart } from './services/context7-kontingent.js';
export { detectTechnologiesAusInhalten, ERKENNUNGS_DATEINAMEN, MANIFEST_DATEINAMEN } from './services/tech-detection.js';
export type { ManifestInhalt, ImportQuelle } from './services/tech-detection.js';
export { Context7Fehler } from './services/context7.js';
export type { Context7Bibliothek } from './services/context7.js';
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
export { getParserPool, resetParserPool, ParserWorkerPool, getParserActivity } from './parser/worker-pool.js';
export type { ParseArgs, ParserAktivitaet } from './parser/worker-pool.js';

export type { ProjectStatus } from './services/project-status.js';
export { getProjectStatus, setProjectStatus, isProjectInitialized, updateLastAccess, clearProjectStatus, isAgentKnown, registerAgent, setzeOnboardingRuhe, baueChannelUebersicht } from './services/project-status.js';
export { holeChannelTeilnehmer } from './services/project-status.js';
export { holeSichtungsstand, setzeSichtung, archiviereChannel, archiviereNachrichten } from './services/channels.js';
export { ensureChannelverwalterRegel, CHANNELVERWALTER_REGEL_NAME } from './services/channelverwalter-regel.js';
export type { SichtungsEintrag } from './services/channels.js';
export type { ChannelUebersicht, ChannelUebersichtEintrag, ChannelTeilnehmer } from './services/project-status.js';

// Setup-Phase (SETUP-1: PG Source-of-Truth, status.json nur noch Cache/Fallback)
export type { SetupPhase } from './services/project-setup-status.js';
export { getSetupPhase, setSetupPhase, ermittleProjektStatus } from './services/project-setup-status.js';
export { backfillSetupPhaseFromStatusFiles } from './migrations/backfill-setup-phase.js';
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
      const vector = await embed(text, { priority: 'background' });
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
export async function initSynapse(
  projectName: string,
  optionen: { schema?: 'ausfuehren' | 'pruefen' | 'aus' } = {},
): Promise<boolean> {
  console.error(`[Synapse] Initialisiere Projekt "${projectName}"...`);

  // 0. Embedding-Provider resetten damit aktuelle Config geladen wird
  const { resetEmbeddingProvider } = await import('./embeddings/index.js');
  resetEmbeddingProvider();

  // 1. PostgreSQL testen + Schema sicherstellen
  // P7-T14: ensureSchema sperrt alle Produktions-Tabellen ~2,3 s — nur der API-Start fuehrt es aus
  // (schema:'ausfuehren'); alle anderen Aufrufer pruefen nur (Standard) bzw. legen bei LEERER DB einmal an.
  const { testDatabaseConnection, stelleSchemaSicher } = await import('./db/index.js');
  const dbOk = await testDatabaseConnection();
  if (dbOk) {
    await stelleSchemaSicher(optionen.schema ?? 'pruefen');
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

    // P12-T11/T12 (Befund 1dbb8308): die automatische Migration liest hoechstens 10000 Punkte,
    // LOESCHT danach die Collection und behandelt nur DIESES Projekt; Code-Collections werden
    // sofort geloescht. Ein Dimensionswechsel fuehrt deshalb nur noch zu einer Meldung - das
    // Neu-Einbetten macht das Re-Embedding-Werkzeug (neue Collections, Nachzug, Umschalten).
    // Altes Verhalten nur ausdruecklich: SYNAPSE_START_MIGRATION=1.
    if (colDim !== currentDim && process.env.SYNAPSE_START_MIGRATION !== '1') {
      console.error(
        `[Synapse] ⚠️ DIMENSIONS-MISMATCH: "${colName}" hat ${colDim}d, Modell liefert ${currentDim}d. ` +
        `NICHTS geloescht oder migriert - Schreiben in diese Collection schlaegt fehl, bis sie mit dem ` +
        `Re-Embedding-Werkzeug neu aufgebaut ist (SYNAPSE_START_MIGRATION=1 = alte Automatik).`
      );
      continue;
    }
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
