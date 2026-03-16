/**
 * MCP-Tools fuer den Agenten-Event-Layer
 */

import {
  emitEvent,
  acknowledgeEvent,
  getPendingEvents,
} from '@synapse/core';

/**
 * Sendet ein Event an Agenten
 */
export async function emitEventTool(
  project: string,
  eventType: string,
  priority: string,
  scope: string,
  sourceId: string,
  payload?: string,
  requiresAck?: boolean
): Promise<{
  success: boolean;
  event: { id: number; eventType: string; priority: string; createdAt: string } | null;
  message: string;
}> {
  try {
    const event = await emitEvent(
      project,
      eventType as import('@synapse/core').EventType,
      priority as import('@synapse/core').EventPriority,
      scope,
      sourceId,
      payload,
      requiresAck
    );
    return {
      success: true,
      event: {
        id: event.id,
        eventType: event.eventType,
        priority: event.priority,
        createdAt: event.createdAt,
      },
      message: `Event "${eventType}" [${priority}] gesendet an "${scope}" (ID: ${event.id})`,
    };
  } catch (error) {
    return { success: false, event: null, message: `Fehler: ${error}` };
  }
}

/**
 * Bestaetigt ein Event durch einen Agenten
 */
export async function acknowledgeEventTool(
  eventId: number,
  agentId: string,
  reaction?: string
): Promise<{
  success: boolean;
  ack: { eventId: number; agentId: string; ackedAt: string } | null;
  message: string;
}> {
  try {
    const ack = await acknowledgeEvent(eventId, agentId, reaction);
    return {
      success: true,
      ack: {
        eventId: ack.eventId,
        agentId: ack.agentId,
        ackedAt: ack.ackedAt,
      },
      message: `Event #${eventId} von Agent "${agentId}" bestaetigt`,
    };
  } catch (error) {
    return { success: false, ack: null, message: `Fehler: ${error}` };
  }
}

/**
 * Holt unbestaetigte Events fuer einen Agenten
 */
export async function getPendingEventsTool(
  project: string,
  agentId: string
): Promise<{
  success: boolean;
  events: Array<{
    id: number;
    eventType: string;
    priority: string;
    scope: string;
    sourceId: string;
    payload: string | null;
    createdAt: string;
  }>;
  message: string;
}> {
  try {
    const events = await getPendingEvents(project, agentId);
    return {
      success: true,
      events: events.map(e => ({
        id: e.id,
        eventType: e.eventType,
        priority: e.priority,
        scope: e.scope,
        sourceId: e.sourceId,
        payload: e.payload,
        createdAt: e.createdAt,
      })),
      message: `${events.length} ausstehende Events fuer "${agentId}"`,
    };
  } catch (error) {
    return { success: false, events: [], message: `Fehler: ${error}` };
  }
}
