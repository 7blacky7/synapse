/**
 * Konsolidiertes MCP-Tool für Event-Verwaltung
 *
 * Kombiniert 3 Event-Tools zu einem einzigen Tool mit action-Parameter:
 * - emit: Sendet ein Event an Agenten
 * - ack: Bestätigt ein Event
 * - pending: Holt unbestätigte Events
 */

import type { ConsolidatedTool } from './types.js';
import { reqStr, str, num, bool, numArray } from './types.js';
import {
  emitEventTool,
  acknowledgeEventTool,
  getPendingEventsTool,
} from '../events.js';

export const eventTool: ConsolidatedTool = {
  definition: {
    name: 'event',
    description:
      'Verwaltet Events für Agenten. Actions: emit (Sendet Event), ack (Bestätigt Event), pending (Holt unbestätigte Events).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['emit', 'ack', 'pending'],
          description: 'Action: "emit", "ack", oder "pending"',
        },
        // emit-Parameter
        project: {
          type: 'string',
          description: 'Projekt-Name (erforderlich für emit und pending)',
        },
        event_type: {
          type: 'string',
          description:
            'Event-Typ für emit: WORK_STOP, CRITICAL_REVIEW, ARCH_DECISION, TEAM_DISCUSSION, ANNOUNCEMENT, NEW_TASK, CHECK_CHANNEL',
        },
        priority: {
          type: 'string',
          description: 'Priorität für emit: critical, high, normal',
        },
        scope: {
          type: 'string',
          description:
            'Empfänger für emit: "all" oder "agent:<id>" (Standard: "all")',
        },
        source_id: {
          type: 'string',
          description: 'Absender Agent-ID (erforderlich für emit)',
        },
        payload: {
          type: 'string',
          description: 'Optionaler JSON-Payload für emit',
        },
        requires_ack: {
          type: 'boolean',
          description: 'Ob Agenten quittieren müssen (Standard: true, nur für emit)',
        },
        // ack-Parameter
        event_id: {
          oneOf: [
            { type: 'number' },
            { type: 'array', items: { type: 'number' }, minItems: 1 },
          ],
          description: 'Event-ID (erforderlich für ack). Array erlaubt fuer Batch-Ack',
        },
        agent_id: {
          type: 'string',
          description: 'Eigene Agent-ID (erforderlich für ack und pending)',
        },
        reaction: {
          type: 'string',
          description: 'Optionale Reaktion/Kommentar (nur für ack)',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    switch (action) {
      case 'emit': {
        const project = reqStr(args, 'project');
        const eventType = reqStr(args, 'event_type');
        const priority = reqStr(args, 'priority');
        const sourceId = reqStr(args, 'source_id');
        const scope = str(args, 'scope') ?? 'all';
        const payload = str(args, 'payload');
        const requiresAck = bool(args, 'requires_ack');

        const result = await emitEventTool(
          project,
          eventType,
          priority,
          scope,
          sourceId,
          payload,
          requiresAck
        );

        return result;
      }

      case 'ack': {
        const agentId = reqStr(args, 'agent_id');
        const reaction = str(args, 'reaction');

        // Array-Support: Mehrere Events in einem Call bestätigen
        const eventIds = numArray(args, 'event_id');
        if (eventIds && eventIds.length > 1) {
          const settled = await Promise.allSettled(
            eventIds.map(eid => acknowledgeEventTool(eid, agentId, reaction))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (const r of settled) {
            if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
            else errors.push(String(r.reason));
          }
          return { results, count: results.length, errors };
        }

        // Bestehend: Einzelnes Event
        const eventId = num(args, 'event_id');
        if (eventId === undefined) {
          throw new Error('Parameter "event_id" ist erforderlich für action "ack"');
        }
        const result = await acknowledgeEventTool(eventId, agentId, reaction);
        return result;
      }

      case 'pending': {
        const project = reqStr(args, 'project');
        const agentId = reqStr(args, 'agent_id');

        const result = await getPendingEventsTool(project, agentId);

        return result;
      }

      default: {
        throw new Error(
          `Unbekannte action "${action}". Gültig sind: "emit", "ack", "pending"`
        );
      }
    }
  },
};
