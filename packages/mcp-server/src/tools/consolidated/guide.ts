/**
 * Synapse MCP - Consolidated guide Tool
 * Tool-Dokumentation fuer lokale Agenten. Selbe Quelle wie REST-API guide.
 * Single Source of Truth: @synapse/core (GUIDE_OVERVIEW + TOOL_GUIDES).
 */

import { GUIDE_OVERVIEW, TOOL_GUIDES } from '@synapse/core';
import { ConsolidatedTool, str } from './types.js';

export const guideTool: ConsolidatedTool = {
  definition: {
    name: 'guide',
    description:
      'Tool-Dokumentation: Quick-Start + detaillierte Nutzungs-Anleitung fuer alle Synapse-Tools. ' +
      'Ohne Parameter: Uebersicht. Mit tool_name: Deep-Dive. Mit tool_name + action_name: Action-Details. ' +
      'Bei der ersten Nutzung jedes Tools in einer Session wird die Tool-Doku automatisch an die Response angehaengt — ' +
      'rufe guide gezielt auf, wenn du Detail-Infos brauchst.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: {
          type: 'string',
          description:
            'Name des Tools fuer Detail-Doku (z.B. "code_intel", "shell", "files"). Weglassen fuer Uebersicht.',
        },
        action_name: {
          type: 'string',
          description:
            'Optional: Spezifische Action innerhalb eines Multi-Action-Tools (z.B. "tree" bei code_intel).',
        },
      },
    },
  },

  async handler(args) {
    const toolName = str(args, 'tool_name');
    const actionName = str(args, 'action_name');

    if (!toolName) {
      return {
        success: true,
        scope: 'overview',
        content: GUIDE_OVERVIEW,
        available_tools: Object.keys(TOOL_GUIDES),
        tip: 'Rufe guide({ tool_name: "<name>" }) fuer Detail-Doku zu einem einzelnen Tool auf.',
      };
    }

    const toolGuide = TOOL_GUIDES[toolName];
    if (!toolGuide) {
      return {
        success: false,
        error: `Kein Guide fuer Tool "${toolName}" gefunden.`,
        available_tools: Object.keys(TOOL_GUIDES),
      };
    }

    if (actionName) {
      const action = toolGuide.actions?.[actionName];
      if (!action) {
        return {
          success: false,
          error: `Kein Guide fuer Action "${actionName}" in Tool "${toolName}" gefunden.`,
          available_actions: toolGuide.actions ? Object.keys(toolGuide.actions) : [],
        };
      }
      return {
        success: true,
        scope: 'action',
        tool: toolName,
        action: actionName,
        guide: action,
      };
    }

    return {
      success: true,
      scope: 'tool',
      tool: toolName,
      guide: toolGuide,
      tip: toolGuide.actions
        ? `Dieses Tool hat mehrere Actions: ${Object.keys(toolGuide.actions).join(', ')}. Rufe guide({ tool_name: "${toolName}", action_name: "<action>" }) fuer Detail-Doku.`
        : undefined,
    };
  },
};
