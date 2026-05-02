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
import { createProposal } from '@synapse/core';
import { ConsolidatedTool, reqStr, str, bool, num, strArray, objArray } from './types.js';

export const proposalTool: ConsolidatedTool = {
  definition: {
    name: 'proposal',
    description: 'Proposal-Management: create (single oder Bulk via items[]), list, get, update_status, delete, update.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'get', 'update_status', 'delete', 'update'],
          description: 'Aktion: create (Anlegen, single oder items[]), list, get, update_status, delete, update',
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
        file_path: {
          type: 'string',
          description: 'Datei-Pfad (relativ) auf den sich der Proposal bezieht (fuer create).',
        },
        author: {
          type: 'string',
          description: 'Autor des Proposals (fuer create).',
        },
        description: {
          type: 'string',
          description: 'Kurzbeschreibung des Vorschlags (fuer create).',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optionale Tags (fuer create).',
        },
        items: {
          type: 'array',
          description: 'Bulk-Mode fuer create: 1..50 Proposals in einem Call. Jedes Item: { file_path, suggested_content, description, author, tags? }. project gilt fuer alle. Best-effort.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              file_path: { type: 'string' },
              suggested_content: { type: 'string' },
              description: { type: 'string' },
              author: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['file_path', 'suggested_content', 'description', 'author'],
          },
        },
      },
      required: ['action', 'project'],
    },
  },

  handler: async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const action = reqStr(args, 'action');
    const project = reqStr(args, 'project');

    switch (action) {
      case 'create': {
        // Bulk-Mode: items[] vorhanden → mehrere Proposals in einem Call.
        type CreateItem = {
          file_path?: string;
          suggested_content?: string;
          description?: string;
          author?: string;
          tags?: string[];
        };
        const items = objArray<CreateItem>(args, 'items');
        if (items && items.length > 0) {
          const results: Array<{ index: number; ok: boolean; id?: string; error?: string }> = [];
          let applied = 0;
          let failed = 0;
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            try {
              if (!it.file_path) throw new Error('file_path fehlt');
              if (!it.suggested_content) throw new Error('suggested_content fehlt');
              if (!it.description) throw new Error('description fehlt');
              if (!it.author) throw new Error('author fehlt');
              const tags = Array.isArray(it.tags) ? it.tags.filter((t): t is string => typeof t === 'string') : [];
              const proposal = await createProposal(project, it.file_path, it.suggested_content, it.description, it.author, tags);
              results.push({ index: i, ok: true, id: proposal.id });
              applied++;
            } catch (err) {
              results.push({ index: i, ok: false, error: (err as Error).message });
              failed++;
            }
          }
          return {
            total: items.length,
            applied,
            failed,
            results,
            message: `${applied}/${items.length} Proposals erstellt${failed > 0 ? ` (${failed} fehlgeschlagen)` : ''}.`,
          };
        }

        // Single-Mode
        const filePath = reqStr(args, 'file_path');
        const suggested = reqStr(args, 'suggested_content');
        const desc = reqStr(args, 'description');
        const author = reqStr(args, 'author');
        const tags = strArray(args, 'tags') ?? [];
        const proposal = await createProposal(project, filePath, suggested, desc, author, tags);
        return { success: true, proposal };
      }

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
