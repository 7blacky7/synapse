/**
 * Konsolidierte MCP-Tools
 *
 * 68 einzelne Tools → 12 action-basierte Super-Tools
 * Backend-Logik in tools/*.ts bleibt unveraendert.
 */

export type { ConsolidatedTool } from './types.js';

export { projectTool } from './project.js';
export { searchTool } from './search.js';
export { memoryTool } from './memory.js';
export { thoughtTool } from './thought.js';
export { proposalTool } from './proposal.js';
export { planTool } from './plan.js';
export { chatTool } from './chat.js';
export { channelTool } from './channel.js';
export { eventTool } from './event.js';
export { specialistTool } from './specialist.js';
export { docsTool } from './docs.js';
export { adminTool } from './admin.js';
export { watcherTool } from './watcher.js';
export { codeIntelTool } from './code-intel.js';
