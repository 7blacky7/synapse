/**
 * Konsolidiertes MCP-Tool fuer Agenten-Chat
 *
 * Vereint 9 Chat-Tools zu einem einzigen Tool mit action-Parameter:
 * - register (register_chat_agent)
 * - unregister (unregister_chat_agent)
 * - register_batch (register_chat_agents_batch)
 * - unregister_batch (unregister_chat_agents_batch)
 * - send (send_chat_message)
 * - get (get_chat_messages)
 * - list (list_chat_agents)
 * - inbox_send (post_to_inbox)
 * - inbox_check (check_inbox)
 */

import type { ConsolidatedTool } from './types.js';
import { reqStr, str, num, bool, strArray, objArray } from './types.js';
import {
  registerChatAgent,
  unregisterChatAgent,
  registerChatAgentsBatch,
  unregisterChatAgentsBatch,
  sendChatMessage,
  getChatMessages,
  listAgents,
  postToInboxTool,
  checkInboxTool,
} from '../index.js';

export const chatTool: ConsolidatedTool = {
  definition: {
    name: 'chat',
    description:
      'Verwaltetes Chat-System fuer Agenten mit verschiedenen Aktionen: Registrierung, Messaging, Inbox-Handling',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['register', 'unregister', 'register_batch', 'unregister_batch', 'send', 'get', 'list', 'inbox_send', 'inbox_check'],
          description:
            'Die auszufuehrende Aktion (register, unregister, register_batch, unregister_batch, send, get, list, inbox_send, inbox_check)',
        },

        // ===== register =====
        id: { type: 'string', description: 'Agent-ID (fuer register, unregister)' },
        project: { type: 'string', description: 'Projekt-Name' },
        project_path: { type: 'string', description: 'Absoluter Pfad zum Projekt-Ordner' },
        model: { type: 'string', description: 'Modell-Name (z.B. claude-opus-4-6)' },
        cutoff_date: { type: 'string', description: 'Wissens-Cutoff (YYYY-MM-DD)' },

        // ===== unregister_batch / register_batch =====
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Liste der Agent-IDs (fuer unregister_batch)',
        },
        agents: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              model: { type: 'string' },
            },
            required: ['id'],
          },
          description: 'Liste der Agenten (fuer register_batch)',
        },

        // ===== send =====
        sender_id: { type: 'string', description: 'Absender Agent-ID' },
        content: { type: 'string', description: 'Nachrichteninhalt' },
        recipient_id: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Empfaenger Agent-ID (optional, fuer DM). Array erlaubt fuer: send (Multicast)',
        },

        // ===== get =====
        agent_id: { type: 'string', description: 'Eigene Agent-ID' },
        since: { type: 'string', description: 'ISO-Timestamp fuer Polling' },
        sender_id_filter: { type: 'string', description: 'Optional: Nur Nachrichten von diesem Absender' },
        limit: { type: 'number', description: 'Max. Nachrichten (Standard: 50)' },

        // ===== inbox_send / inbox_check =====
        from_agent: { type: 'string', description: 'Absender Agent-Name' },
        to_agent: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Empfaenger Agent-Name. Array erlaubt fuer: inbox_send (Multicast)',
        },
        agent_name: { type: 'string', description: 'Agent-Name' },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    try {
      switch (action) {
        // ===== register =====
        case 'register': {
          const regId = reqStr(args, 'id');
          const regProject = reqStr(args, 'project');
          const regModel = str(args, 'model');
          const regCutoffDate = str(args, 'cutoff_date');

          const result = await registerChatAgent(regId, regProject, regModel, regCutoffDate);
          return { ...result, action: 'register' };
        }

        // ===== unregister =====
        case 'unregister': {
          const unregId = reqStr(args, 'id');
          const result = await unregisterChatAgent(unregId);
          return { ...result, action: 'unregister' };
        }

        // ===== register_batch =====
        case 'register_batch': {
          const batchAgents = objArray<{ id: string; model?: string; cutoffDate?: string }>(args, 'agents');
          if (!batchAgents || batchAgents.length === 0) {
            throw new Error('Parameter "agents" muss ein Array mit mindestens einem Eintrag sein');
          }
          const batchProject = reqStr(args, 'project');

          const result = await registerChatAgentsBatch(batchAgents, batchProject);
          return { ...result, action: 'register_batch' };
        }

        // ===== unregister_batch =====
        case 'unregister_batch': {
          const batchIds = strArray(args, 'ids');
          if (!batchIds || batchIds.length === 0) {
            throw new Error('Parameter "ids" muss ein Array mit mindestens einem Eintrag sein');
          }

          const result = await unregisterChatAgentsBatch(batchIds);
          return { ...result, action: 'unregister_batch' };
        }

        // ===== send =====
        case 'send': {
          const sendProject = reqStr(args, 'project');
          const sendSenderId = reqStr(args, 'sender_id');
          const sendContent = reqStr(args, 'content');

          // Array-Support: Gleiche Nachricht an mehrere Empfaenger
          const recipientIds = strArray(args, 'recipient_id');
          if (recipientIds && recipientIds.length > 1) {
            const settled = await Promise.allSettled(
              recipientIds.map(rid => sendChatMessage(sendProject, sendSenderId, sendContent, rid))
            );
            const results: Array<Record<string, unknown>> = [];
            const errors: string[] = [];
            for (const r of settled) {
              if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
              else errors.push(String(r.reason));
            }
            return { results, count: results.length, errors, action: 'send' };
          }

          // Bestehend: Einzelner Empfaenger (oder Broadcast wenn kein recipient_id)
          const sendRecipientId = str(args, 'recipient_id');
          const result = await sendChatMessage(sendProject, sendSenderId, sendContent, sendRecipientId);
          return { ...result, action: 'send' };
        }

        // ===== get =====
        case 'get': {
          const getProject = reqStr(args, 'project');
          const getAgentId = str(args, 'agent_id');
          const getSince = str(args, 'since');
          const getSenderIdFilter = str(args, 'sender_id_filter');
          const getLimit = num(args, 'limit');

          const result = await getChatMessages(getProject, {
            agentId: getAgentId,
            since: getSince,
            senderId: getSenderIdFilter,
            limit: getLimit,
          });
          return { ...result, action: 'get' };
        }

        // ===== list =====
        case 'list': {
          const listProject = reqStr(args, 'project');
          const result = await listAgents(listProject);
          return { ...result, action: 'list' };
        }

        // ===== inbox_send =====
        case 'inbox_send': {
          const inboxFromAgent = reqStr(args, 'from_agent');
          const inboxContent = reqStr(args, 'content');

          // Array-Support: Gleiche Nachricht an mehrere Agenten-Inboxen
          const toAgents = strArray(args, 'to_agent');
          if (toAgents && toAgents.length > 1) {
            const settled = await Promise.allSettled(
              toAgents.map(ta => postToInboxTool(inboxFromAgent, ta, inboxContent))
            );
            const results: Array<Record<string, unknown>> = [];
            const errors: string[] = [];
            for (const r of settled) {
              if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
              else errors.push(String(r.reason));
            }
            return { success: true, action: 'inbox_send', results, count: results.length, errors };
          }

          // Bestehend: Einzelner Empfaenger
          const inboxToAgent = reqStr(args, 'to_agent');
          const result = await postToInboxTool(inboxFromAgent, inboxToAgent, inboxContent);
          return {
            success: true,
            action: 'inbox_send',
            ...result,
          };
        }

        // ===== inbox_check =====
        case 'inbox_check': {
          const checkAgentName = reqStr(args, 'agent_name');
          const result = await checkInboxTool(checkAgentName);
          return {
            success: true,
            action: 'inbox_check',
            ...result,
          };
        }

        default:
          throw new Error(`Unbekannte Action: ${action}`);
      }
    } catch (error) {
      return {
        success: false,
        action,
        error: String(error),
      };
    }
  },
};
