/**
 * Bridge zwischen Synapse-MCP-Tools und Gemini Function Calling.
 *
 * Importiert alle ConsolidatedTools aus @synapse/mcp-server, erzeugt
 * Gemini-FunctionDeclarations und stellt eine Dispatch-Funktion bereit
 * die Function-Calls vom Modell direkt an die Tool-Handler weiterreicht.
 */

import type { FunctionDeclaration } from '@google/genai';
import {
  projectTool, searchTool, memoryTool, thoughtTool, proposalTool,
  planTool, chatTool, channelTool, eventTool, specialistTool,
  docsTool, adminTool, watcherTool, codeIntelTool, codeCheckTool,
  filesTool, shellTool, guideTool,
} from '@synapse/mcp-server/consolidated';
import type { ConsolidatedTool } from '@synapse/mcp-server/consolidated';
import { convertSchema } from './schema-convert.js';

const ALL_TOOLS: ConsolidatedTool[] = [
  projectTool, searchTool, memoryTool, thoughtTool, proposalTool,
  planTool, chatTool, channelTool, eventTool, specialistTool,
  docsTool, adminTool, watcherTool, codeIntelTool, codeCheckTool,
  filesTool, shellTool, guideTool,
];

export interface ToolBridge {
  /** FunctionDeclarations zur Uebergabe an Gemini config.tools */
  declarations: FunctionDeclaration[];
  /** Beim Konvertieren entstandene Hinweise (oneOf-Degradierungen etc.) */
  warnings: string[];
  /** Dispatcher: ruft den passenden Handler auf, faengt Fehler ab */
  dispatch: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export function buildToolBridge(): ToolBridge {
  const declarations: FunctionDeclaration[] = [];
  const handlerMap = new Map<string, ConsolidatedTool['handler']>();
  const allWarnings: string[] = [];

  for (const tool of ALL_TOOLS) {
    const def = tool.definition;
    const inputSchema = def.inputSchema as unknown as Parameters<typeof convertSchema>[0];
    const { schema, warnings } = convertSchema(inputSchema, def.name);
    allWarnings.push(...warnings.map(w => `[${def.name}] ${w}`));

    declarations.push({
      // mcp__synapse__-Prefix damit Wrapper-Wake-Prompts (Claude-MCP-Format)
      // 1:1 funktionieren: "mcp__synapse__thought({trigger_respawn:true})"
      // wuerde sonst ins Leere laufen.
      name: `mcp__synapse__${def.name}`,
      description: def.description ?? '',
      parameters: schema,
    });
    handlerMap.set(def.name, tool.handler);
  }

  const dispatch = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    // Prefix entfernen falls Modell ihn ruft (sollte immer der Fall sein
    // weil declarations mit Prefix registriert sind, aber tolerant)
    const cleanName = name.replace(/^mcp__synapse__/, '');
    const handler = handlerMap.get(cleanName);
    if (!handler) {
      return { error: `Unbekanntes Tool: "${name}". Verfuegbar: ${Array.from(handlerMap.keys()).map(n => `mcp__synapse__${n}`).join(', ')}` };
    }
    try {
      const result = await handler(args);
      return result;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  return { declarations, warnings: allWarnings, dispatch };
}
