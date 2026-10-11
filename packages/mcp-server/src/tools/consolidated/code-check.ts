/**
 * Synapse MCP - code_check Tool (P15-T37)
 *
 * Haengt NUR ein: Schema und Dispatcher kommen aus core (services/code-check-tool.ts) - dieselben,
 * die die REST-Strecke (rest-api/src/routes/mcp.ts) nutzt. Vorher hatte jede Strecke eine eigene
 * Kopie, die die E1-Felder (Signatur, Geltung, Beispiele, Status) nicht kannte.
 * fuehreCodeCheckAus wirft nie; Fehler kommen als success:false mit error-Code.
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { CODE_CHECK_DEFINITION, fuehreCodeCheckAus } from '@synapse/core';

import { ConsolidatedTool } from './types.js';

export const codeCheckTool: ConsolidatedTool = {
  // as const in core macht das Schema readonly; das MCP-Tool-Schema erwartet veraenderbare Typen.
  definition: CODE_CHECK_DEFINITION as unknown as Tool,
  handler: (args) => fuehreCodeCheckAus(args),
};
