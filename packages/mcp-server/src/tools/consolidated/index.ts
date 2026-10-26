/**
 * Konsolidierte MCP-Tools
 *
 * 68 einzelne Tools → 12 action-basierte Super-Tools
 * Backend-Logik in tools/*.ts bleibt unveraendert.
 */

export type { ConsolidatedTool } from './types.js';
import { anmerkungenTool } from './anmerkungen.js';
export { anmerkungenTool };
ergaenzeAgentTokenParameter([anmerkungenTool.definition]);
export { artefaktTool, begrenzeStdioArtefaktAntwort } from './artefakt.js';


import { projectTool } from './project.js';
export { projectTool };
import { searchTool } from './search.js';
export { searchTool };
import { memoryTool } from './memory.js';
export { memoryTool };
import { thoughtTool } from './thought.js';
export { thoughtTool };
import { proposalTool } from './proposal.js';
export { proposalTool };
import { planTool } from './plan.js';
export { planTool };
import { chatTool } from './chat.js';
export { chatTool };
import { channelTool } from './channel.js';
export { channelTool };
import { eventTool } from './event.js';
export { eventTool };
import { specialistTool } from './specialist.js';
export { specialistTool };
import { docsTool } from './docs.js';
export { docsTool };
import { adminTool } from './admin.js';
export { adminTool };
import { watcherTool } from './watcher.js';
export { watcherTool };
import { codeIntelTool } from './code-intel.js';
export { codeIntelTool };
import { assetIntelTool } from './asset-intel.js';
export { assetIntelTool };
import { hexTool } from './hex.js';
export { hexTool };
import { reverseTool } from './reverse.js';
export { reverseTool };
import { codeCheckTool } from './code-check.js';
export { codeCheckTool };
import { filesTool } from './files.js';
export { filesTool };
import { shellTool } from './shell.js';
export { shellTool };
import { guideTool } from './guide.js';
export { guideTool };
import { ignoreTool } from './ignore.js';
export { ignoreTool };
import { freeModelsTool } from './free-models.js';
export { freeModelsTool };
import { jevTool } from './jev.js';
export { jevTool };

// P22-T11: Vertrag auch beim direkten Import identisch zur ausgelieferten Tool-Liste.
import { ergaenzeAgentTokenParameter } from '@synapse/core';
ergaenzeAgentTokenParameter([projectTool.definition, searchTool.definition, memoryTool.definition, thoughtTool.definition, proposalTool.definition, planTool.definition, chatTool.definition, channelTool.definition, eventTool.definition, specialistTool.definition, docsTool.definition, adminTool.definition, watcherTool.definition, codeIntelTool.definition, assetIntelTool.definition, hexTool.definition, reverseTool.definition, codeCheckTool.definition, filesTool.definition, shellTool.definition, guideTool.definition, ignoreTool.definition, freeModelsTool.definition, jevTool.definition]);
