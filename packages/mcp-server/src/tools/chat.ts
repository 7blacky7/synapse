/**
 * MCP-Tools fuer Agenten-Chat
 */

import {
  registerChatAgent as coreRegisterAgent,
  registerAgentsBatch as coreRegisterBatch,
  unregisterChatAgent as coreUnregisterAgent,
  unregisterAgentsBatch as coreUnregisterBatch,
  listActiveAgents as coreListActiveAgents,
  sendChatMessage as coreSendMessage,
  getChatMessages as coreGetMessages,
} from '@synapse/core';

/**
 * Registriert einen Agenten im Chat
 */
export async function registerChatAgent(
  id: string,
  project: string,
  model?: string,
  cutoffDate?: string
): Promise<{
  success: boolean;
  session: { id: string; project: string; model: string | null; cutoffDate: string | null };
  message: string;
}> {
  try {
    const session = await coreRegisterAgent(id, project, model, cutoffDate);
    return {
      success: true,
      session: {
        id: session.id,
        project: session.project,
        model: session.model,
        cutoffDate: session.cutoffDate,
      },
      message: `Agent "${id}" registriert${session.cutoffDate ? ` (Cutoff: ${session.cutoffDate})` : ''}`,
    };
  } catch (error) {
    return {
      success: false,
      session: { id, project, model: null, cutoffDate: null },
      message: `Fehler bei Registrierung: ${error}`,
    };
  }
}

/**
 * Meldet einen Agenten ab
 */
export async function unregisterChatAgent(
  id: string
): Promise<{ success: boolean; message: string }> {
  try {
    await coreUnregisterAgent(id);
    return { success: true, message: `Agent "${id}" abgemeldet` };
  } catch (error) {
    return { success: false, message: `Fehler: ${error}` };
  }
}

/**
 * Registriert mehrere Agenten auf einmal
 */
export async function registerChatAgentsBatch(
  agents: Array<{ id: string; model?: string; cutoffDate?: string }>,
  project: string
): Promise<{
  success: boolean;
  sessions: Array<{ id: string; project: string; model: string | null; cutoffDate: string | null }>;
  message: string;
}> {
  try {
    const sessions = await coreRegisterBatch(agents, project);
    return {
      success: true,
      sessions: sessions.map(s => ({
        id: s.id,
        project: s.project,
        model: s.model,
        cutoffDate: s.cutoffDate,
      })),
      message: `${sessions.length} Agenten registriert`,
    };
  } catch (error) {
    return { success: false, sessions: [], message: `Fehler: ${error}` };
  }
}

/**
 * Meldet mehrere Agenten auf einmal ab
 */
export async function unregisterChatAgentsBatch(
  ids: string[]
): Promise<{ success: boolean; count: number; message: string }> {
  try {
    await coreUnregisterBatch(ids);
    return { success: true, count: ids.length, message: `${ids.length} Agenten abgemeldet` };
  } catch (error) {
    return { success: false, count: 0, message: `Fehler: ${error}` };
  }
}

/**
 * Sendet eine Nachricht (Broadcast oder DM)
 */
export async function sendChatMessage(
  project: string,
  senderId: string,
  content: string,
  recipientId?: string
): Promise<{
  success: boolean;
  message: { id: number; timestamp: string } | null;
  error?: string;
}> {
  try {
    const msg = await coreSendMessage(project, senderId, content, recipientId);
    return {
      success: true,
      message: { id: msg.id, timestamp: msg.timestamp },
    };
  } catch (error) {
    return { success: false, message: null, error: `${error}` };
  }
}

/**
 * Holt neue Nachrichten (Polling)
 */
export async function getChatMessages(
  project: string,
  options: {
    since?: string;
    senderId?: string;
    agentId?: string;
    limit?: number;
  } = {}
): Promise<{
  success: boolean;
  messages: Array<{
    id: number;
    senderId: string;
    recipientId: string | null;
    content: string;
    timestamp: string;
  }>;
  message: string;
}> {
  try {
    const msgs = await coreGetMessages(project, options);
    return {
      success: true,
      messages: msgs.map(m => ({
        id: m.id,
        senderId: m.senderId,
        recipientId: m.recipientId,
        content: m.content,
        timestamp: m.timestamp,
      })),
      message: `${msgs.length} Nachrichten`,
    };
  } catch (error) {
    return { success: false, messages: [], message: `Fehler: ${error}` };
  }
}

/**
 * Listet aktive Agenten
 */
export async function listAgents(
  project: string
): Promise<{
  success: boolean;
  agents: Array<{ id: string; model: string | null; cutoffDate: string | null; registeredAt: string }>;
  message: string;
}> {
  try {
    const agents = await coreListActiveAgents(project);
    return {
      success: true,
      agents: agents.map(a => ({
        id: a.id,
        model: a.model,
        cutoffDate: a.cutoffDate,
        registeredAt: a.registeredAt,
      })),
      message: `${agents.length} aktive Agenten`,
    };
  } catch (error) {
    return { success: false, agents: [], message: `Fehler: ${error}` };
  }
}
