/**
 * Synapse Core - Services
 * Re-exportiert alle Service-Funktionen
 */

export * from './code.js';
export * from './code-intel.js';
export * from './code-write.js';
export * from './thoughts.js';
export * from './plans.js';
export * from './docs.js';
export * from './tech-detection.js';
export * from './context7.js';
export * from './docs-indexer.js';
export * from './memory.js';
export * from './documents.js';
export * from './project-status.js';
export * from './global-search.js';
export * from './proposals.js';
export * from './backup.js';
export * from './ignore-rules.js';
export {
  registerAgent,
  registerAgentsBatch,
  unregisterAgent,
  unregisterAgentsBatch,
  expireIdleAgentSessions,
  getAgentSession,
  listActiveAgents,
  sendMessage,
  getMessages,
} from './chat.js';
export type { ChatMessage, AgentSession } from './chat.js';
export {
  erlaubteRollen, regelSichtbarFuer, tagVerdacht,
  baueOnboardingRegeln, baueRegelAbrufHinweis,
} from './agent-rollen.js';
export type { AgentRolle, OnboardingRegel } from './agent-rollen.js';
export { addTechDoc, searchTechDocs, getDocsForFile, deleteTechDoc, updateTechDoc } from './tech-docs.js';
export type { TechDoc, TechDocType, TechDocResult } from './tech-docs.js';
export { emitEvent, acknowledgeEvent, getPendingEvents, getUnackedCount } from './events.js';
export type { AgentEvent, EventAck, EventType, EventPriority } from './events.js';
export * from './error-patterns.js';
export * from './channels.js';
export * from './channel-unread.js';
export * from './inbox.js';
export {
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
} from './shell-queue.js';
export type {
  EnqueueArgs,
  ShellJobRow,
  ShellJobCompletion,
  ShellJobResult,
} from './shell-queue.js';
export {
  enqueueSpecialistJob,
  claimPendingSpecialistJob,
  completeSpecialistJob,
  waitForSpecialistJob,
  expirePendingSpecialistJobs,
} from './specialist-queue.js';
export type {
  SpecialistAction,
  SpecialistJobRow,
  SpecialistJobCompletion,
  SpecialistJobResult,
} from './specialist-queue.js';

// Agent-ID Resolver — geteilt zwischen MCP-Server, REST-API und Core-Services
export { resolveAgentId } from './agent-id-resolver.js';

// Tool-Call Activity-Log — zentraler Audit-Store fuer shell(action:"activity")
export { logToolCall, isMutationAction, queryToolCalls, expireOldToolCalls } from './tool-call-log.js';
export type {
  ToolCallLogEntry,
  ToolCallRow,
  ActivityFilters,
  ActivityDetail,
} from './tool-call-log.js';

// Daemon-Heartbeat (Auto-Routing shell ↔ workspace)
export {
  upsertDaemonHeartbeat,
  isDaemonAliveForProject,
  getDaemonHeartbeat,
  clearDaemonHeartbeat,
} from './daemon-heartbeat.js';
export type { DaemonHeartbeatRow } from './daemon-heartbeat.js';

// Wrapper-Status (PG Source-of-Truth fuer laufende Spezialisten)
export {
  upsertWrapperStatus,
  getWrapperStatus,
  listWrapperStatus,
  removeWrapperStatus,
} from './wrapper-status.js';
export type { WrapperStatusRow } from './wrapper-status.js';
