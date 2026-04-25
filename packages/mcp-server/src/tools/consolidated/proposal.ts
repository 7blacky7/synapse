/**
 * Konsolidiertes Proposal-Tool
 * Vereint 5 MCP-Proposal-Tools zu einem einzigen Tool mit action-Parameter
 *
 * ALTE TOOLS → ACTIONS:
 * - list_proposals → "list"
 * - get_proposal → "get"
 * - update_proposal_status → "update_status"
 * - delete_proposal → "delete"
 * - update_proposal → "update"
 */

import {
  listProposalsWrapper,
  getProposalWrapper,
  getProposalsByIdsWrapper,
  updateProposalStatusWrapper,
  deleteProposalWrapper,
  deleteProposalsBatch,
  updateProposalTool,
} from '../proposals.js';
import { ConsolidatedTool, reqStr, str, bool, num, strArray } from './types.js';

export const proposalTool: ConsolidatedTool = {
  definition: {
    name: 'proposal',
    description: 'Konsolidiertes Proposal-Management: list, get, update_status, delete, update',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'update_status', 'delete', 'update'],
          description: 'Aktion: list (Auflistung), get (Abrufen), update_status (Status ändern), delete (Löschen), update (Aktualisieren)',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name',
        },
        agent_id: {
          type: 'string',
          description: 'Agent-ID für Onboarding',
        },
        id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Proposal-ID (für get, update_status, delete, update). Array erlaubt fuer: get',
        },
        status: {
          type: 'string',
          enum: ['pending', 'reviewed', 'accepted', 'rejected'],
          description: 'Status (für list: Filter; für update_status: Neuer Status; für update: Optional)',
        },
        content: {
          type: 'string',
          description: 'Neue Beschreibung (für update)',
        },
        suggested_content: {
          type: 'string',
          description: 'Neuer vorgeschlagener Inhalt (für update)',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview: Zeigt was geloescht wuerde ohne tatsaechlich zu loeschen (nur fuer delete mit Array)',
        },
        max_items: {
          type: 'number',
          description: 'Max. erlaubte Items pro Batch-Delete (Standard: 10, nur fuer delete mit Array)',
        },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');

    switch (action) {
      case 'list': {
        // list_proposals: Listet alle Proposals eines Projekts auf
        const status = str(args, 'status');
        const result = await listProposalsWrapper(project, status);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'get': {
        // Array-Support: Mehrere Proposals in einem Call
        const ids = strArray(args, 'id');
        if (ids && ids.length > 1) {
          const result = await getProposalsByIdsWrapper(project, ids);
          return result;
        }

        // Bestehend: Einzelner Proposal
        const id = reqStr(args, 'id');
        const result = await getProposalWrapper(project, id);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'update_status': {
        // Array-Support: Gleicher Status fuer mehrere Proposals
        const ids = strArray(args, 'id');
        if (ids && ids.length > 1) {
          const status = reqStr(args, 'status');
          const settled = await Promise.allSettled(
            ids.map(id => updateProposalStatusWrapper(project, id, status))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push({ text: r.value });
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        // Bestehend: Einzelner Status-Update
        const id = reqStr(args, 'id');
        const status = reqStr(args, 'status');
        const result = await updateProposalStatusWrapper(project, id, status);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'delete': {
        // Array-Support: Batch-Delete mit Safeguards
        const ids = strArray(args, 'id');
        if (ids && ids.length > 1) {
          const dryRun = bool(args, 'dry_run') ?? false;
          const maxItems = num(args, 'max_items') ?? 10;
          return await deleteProposalsBatch(project, ids, dryRun, maxItems);
        }

        // Bestehend: Einzelnes Delete
        const id = reqStr(args, 'id');
        const result = await deleteProposalWrapper(project, id);
        return {
          content: [{ type: 'text', text: result }],
        };
      }

      case 'update': {
        // update_proposal: Aktualisiert einen Proposal (einzelne Felder änderbar)
        const id = reqStr(args, 'id');
        const changes: { content?: string; suggestedContent?: string; status?: string } = {};

        if (args?.content) changes.content = str(args, 'content');
        if (args?.suggested_content) changes.suggestedContent = str(args, 'suggested_content');
        if (args?.status) changes.status = str(args, 'status');

        const result = await updateProposalTool(project, id, changes);
        return {
          success: result.success,
          message: result.message,
          proposal: result.proposal,
        };
      }

      default:
        throw new Error(`Unbekannte action: ${action}`);
    }
  },
};
