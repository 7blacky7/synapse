/**
 * Konsolidiertes MCP-Tool für Event-Verwaltung
 *
 * Kombiniert 3 Event-Tools zu einem einzigen Tool mit action-Parameter:
 * - emit: Sendet ein Event an Agenten
 * - ack: Bestätigt ein Event
 * - pending: Holt unbestätigte Events
 */

import type { ConsolidatedTool } from './types.js';
import { reqStr, str, num, bool, numArray, objArray } from './types.js';
import { resolveAgentId } from '@synapse/core';
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
            'Event-Typ für emit: WORK_STOP, CRITICAL_REVIEW, ARCH_DECISION, TEAM_DISCUSSION, ANNOUNCEMENT, NEW_TASK, CHECK_CHANNEL, PLAN_READY',
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
        events: {
          type: 'array',
          description: 'Bulk-Mode fuer emit: 1..50 Events in einem Call. Jedes Item: { event_type, priority, scope?, payload?, requires_ack? }. project + source_id gelten fuer alle. Best-effort.',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              event_type: { type: 'string' },
              priority: { type: 'string' },
              scope: { type: 'string' },
              payload: { type: 'string' },
              requires_ack: { type: 'boolean' },
            },
            required: ['event_type', 'priority'],
          },
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
        const rawSourceId = str(args, 'source_id');
        const sourceId = resolveAgentId(rawSourceId);
        if (!sourceId) throw new Error('Parameter "source_id" ist erforderlich (oder SYNAPSE_AGENT_NAME setzen)');

        // Bulk-Mode: events[] vorhanden → mehrere Events in einem Call.
        type EmitItem = {
          event_type?: string;
          priority?: string;
          scope?: string;
          payload?: string;
          requires_ack?: boolean;
        };
        const events = objArray<EmitItem>(args, 'events');
        if (events && events.length > 0) {
          const results: Array<{ index: number; ok: boolean; event_id?: number; error?: string }> = [];
          let applied = 0;
          let failed = 0;
          for (let i = 0; i < events.length; i++) {
            const e = events[i];
            try {
              if (!e.event_type) throw new Error('event_type fehlt');
              if (!e.priority) throw new Error('priority fehlt');
              const r = await emitEventTool(
                project,
                e.event_type,
                e.priority,
                e.scope ?? 'all',
                sourceId,
                e.payload,
                e.requires_ack,
              );
              const eid = (r as { event_id?: number; eventId?: number }).event_id ?? (r as { eventId?: number }).eventId;
              results.push({ index: i, ok: true, event_id: eid });
              applied++;
            } catch (err) {
              results.push({ index: i, ok: false, error: (err as Error).message });
              failed++;
            }
          }
          return {
            total: events.length,
            applied,
            failed,
            results,
            message: `${applied}/${events.length} Events emittiert${failed > 0 ? ` (${failed} fehlgeschlagen)` : ''}.`,
          };
        }

        // Single-Mode
        const eventType = reqStr(args, 'event_type');
        const priority = reqStr(args, 'priority');
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
        const rawAckAgentId = str(args, 'agent_id');
        const agentId = resolveAgentId(rawAckAgentId);
        if (!agentId) throw new Error('Parameter "agent_id" ist erforderlich für ack (oder SYNAPSE_AGENT_NAME setzen)');
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
        const agentId = reqStr(args, 'agent_id'); // READ-FILTER: kein resolveAgentId (würde auf ENV-Agent filtern wenn nicht gesetzt)

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
