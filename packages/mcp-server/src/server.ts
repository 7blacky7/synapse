/**
 * Synapse MCP - Server
 * MCP Server Implementation mit 13 konsolidierten Tools
 */

import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  checkAgentOnboarding,
  getChatMessages,
  sendChatMessage,
  listAgents,
  getProjectPath,
  listActiveProjects,
  registerChatAgent,
  registerChatAgentsBatch,
  acknowledgeEventTool,
} from './tools/index.js';

import { getPendingEvents } from '@synapse/core';
import { ensureAgentsSchema, detectClaudeCli, heartbeatController, readStatus, postToInbox, postMessage, checkInbox } from '@synapse/agents';

import {
  projectTool,
  searchTool,
  memoryTool,
  thoughtTool,
  proposalTool,
  planTool,
  chatTool,
  channelTool,
  eventTool,
  specialistTool,
  docsTool,
  adminTool,
} from './tools/consolidated/index.js';

/** Eindeutige ID dieser Server-Instanz — bei Neustart neu generiert.
 *  Wird fuer Session-basiertes Onboarding verwendet: neue Instance = neues Onboarding. */
export const SERVER_INSTANCE_ID = randomUUID();

/** Tracking: Wann hat ein Agent zuletzt Chat gelesen? */
const lastChatRead = new Map<string, string>();

/** Tracking: Wie oft hat ein Agent ein kritisches Event ignoriert? */
const eventIgnoreCount = new Map<string, { firstSeen: number; count: number }>();

/** Zählt ungelesene Chat-Nachrichten für einen Agenten */
async function getUnreadChatCount(
  agentId: string,
  project: string
): Promise<{ broadcasts: number; dms: Array<{ from: string; count: number }> } | null> {
  const lastRead = lastChatRead.get(agentId);
  if (!lastRead) return null; // Noch nie gelesen → kein Count (Onboarding zeigt Chat-Hinweis)

  try {
    const result = await getChatMessages(project, {
      agentId,
      since: lastRead,
      limit: 50,
    });

    if (!result.success || result.messages.length === 0) return null;

    let broadcasts = 0;
    const dmCounts = new Map<string, number>();

    for (const msg of result.messages) {
      if (msg.senderId === agentId) continue; // Eigene Nachrichten ignorieren
      if (msg.recipientId === agentId) {
        // DM an mich
        dmCounts.set(msg.senderId, (dmCounts.get(msg.senderId) || 0) + 1);
      } else if (!msg.recipientId) {
        // Broadcast
        broadcasts++;
      }
    }

    if (broadcasts === 0 && dmCounts.size === 0) return null;

    return {
      broadcasts,
      dms: Array.from(dmCounts.entries()).map(([from, count]) => ({ from, count })),
    };
  } catch {
    return null;
  }
}

/** Prüft ausstehende Events für einen Agenten und baut Hint-Text */
async function getUnackedEventHint(
  agentId: string,
  project: string
): Promise<{ events: Array<{id: number, eventType: string, priority: string, payload: string | null}>, hint: string } | null> {
  try {
    const pending = await getPendingEvents(project, agentId);
    if (!pending || pending.length === 0) return null;

    const events = pending.map(e => ({
      id: e.id,
      eventType: e.eventType,
      priority: e.priority,
      payload: e.payload,
    }));

    const hintParts: string[] = [];
    for (const e of pending) {
      if (e.priority === 'critical') {
        hintParts.push(`⛔ PFLICHT-EVENT: ${e.eventType} von ${e.sourceId}: ${e.payload}. Reagiere SOFORT mit event(action: "acknowledge", event_id: ${e.id}, agent_id: "${agentId}")`);
      } else if (e.priority === 'high') {
        hintParts.push(`⚠️ EVENT: ${e.eventType} von ${e.sourceId}: ${e.payload}. Bitte mit event(action: "acknowledge", event_id: ${e.id}, agent_id: "${agentId}") bestaetigen.`);
      } else {
        hintParts.push(`📋 EVENT: ${e.eventType}: ${e.payload}. event(action: "acknowledge", event_id: ${e.id}, agent_id: "${agentId}")`);
      }
    }

    return { events, hint: hintParts.join('\n') };
  } catch {
    return null;
  }
}

/**
 * Erstellt und konfiguriert den MCP Server
 */
export function createServer(): Server {
  const server = new Server(
    {
      name: 'synapse-mcp',
      version: '0.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Tool-Liste registrieren (12 konsolidierte Tools)
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      projectTool.definition,
      searchTool.definition,
      memoryTool.definition,
      thoughtTool.definition,
      proposalTool.definition,
      planTool.definition,
      chatTool.definition,
      channelTool.definition,
      eventTool.definition,
      specialistTool.definition,
      docsTool.definition,
      adminTool.definition,
    ],
  }));

  // Tool-Aufrufe verarbeiten
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Globale Parameter fuer Agent-Onboarding extrahieren
    const agentId = args?.agent_id as string | undefined;
    const projectName = args?.project as string | undefined;

    // Helper: Ergebnis mit Onboarding erweitern
    const withOnboarding = async (result: Record<string, unknown>) => {
      if (!agentId || !projectName) {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      const onboarding = await checkAgentOnboarding(projectName, agentId);
      const enhanced: Record<string, unknown> = { ...result };

      // Onboarding-Regeln bei erstem Besuch
      if (onboarding?.isFirstVisit && onboarding.rules && onboarding.rules.length > 0) {
        enhanced.agentOnboarding = {
          isFirstVisit: true,
          message: '📋 WILLKOMMEN! Als neuer Agent beachte bitte folgende Projekt-Regeln:',
          rules: onboarding.rules,
        };
      }

      // Pending Events anzeigen (VOR Chat)
      const pendingEvents = await getUnackedEventHint(agentId, projectName);
      if (pendingEvents) {
        enhanced.pendingEvents = {
          count: pendingEvents.events.length,
          events: pendingEvents.events,
          hint: pendingEvents.hint,
        };
      }

      // Ungelesene Chat-Nachrichten anzeigen
      const unread = await getUnreadChatCount(agentId, projectName);
      if (unread) {
        const parts: string[] = [];
        if (unread.broadcasts > 0) parts.push(`${unread.broadcasts} Broadcasts`);
        for (const dm of unread.dms) parts.push(`${dm.count} DM von ${dm.from}`);
        enhanced.unreadChat = {
          ...unread,
          hint: `📨 Ungelesene Nachrichten: ${parts.join(', ')}. Lies mit: chat(action: "get", project: "${projectName}", agent_id: "${agentId}")`,
        };
      }

      // Aktive Agenten anzeigen (kompakte Einblendung)
      try {
        const agentList = await listAgents(projectName);
        if (agentList.success && agentList.agents.length > 0) {
          const others = agentList.agents.filter(a => a.id !== agentId);
          if (others.length > 0) {
            enhanced.activeAgents = {
              count: others.length + 1,
              agents: agentList.agents.map(a => ({
                id: a.id,
                model: a.model,
                isYou: a.id === agentId,
              })),
              hint: `👥 Aktive Agenten: ${agentList.agents.map(a => a.id === agentId ? `${a.id} (du)` : a.id).join(', ')}`,
            };
          }
        }
      } catch { /* Agenten-Liste darf nicht crashen */ }

      // Eskalation: Agent ignoriert kritische Events
      if (pendingEvents) {
        const hasCritical = pendingEvents.events.some(e => e.priority === 'critical');
        const hasHigh = pendingEvents.events.some(e => e.priority === 'high');

        if (hasCritical || hasHigh) {
          const key = agentId;
          const now = Date.now();
          const existing = eventIgnoreCount.get(key);

          if (!existing) {
            // Erstes Mal gesehen — Grace Period starten
            eventIgnoreCount.set(key, { firstSeen: now, count: 1 });
          } else {
            existing.count++;
            // Grace Period: 30 Sekunden nach erstem Sehen
            const elapsed = now - existing.firstSeen;
            if (elapsed > 30000 && existing.count >= 3) {
              // Eskalation an Koordinator
              try {
                const eventList = pendingEvents.events.map(e => `${e.eventType}(${e.priority})`).join(', ');
                await sendChatMessage(
                  projectName,
                  'system',
                  `⚠️ ESKALATION: Agent "${agentId}" ignoriert ${pendingEvents.events.length} Event(s) seit ${existing.count} Tool-Calls: ${eventList}`,
                  'koordinator'
                );
                console.error(`[Synapse] Eskalation: ${agentId} ignoriert Events seit ${existing.count} Calls`);
              } catch { /* Eskalation darf nicht crashen */ }
            }
          }
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(enhanced, null, 2) }] };
    };

    try {
      switch (name) {
        case 'project':
          return withOnboarding(await projectTool.handler(args as Record<string, unknown>));

        case 'search':
          return withOnboarding(await searchTool.handler(args as Record<string, unknown>));

        case 'memory':
          return withOnboarding(await memoryTool.handler(args as Record<string, unknown>));

        case 'thought':
          return withOnboarding(await thoughtTool.handler(args as Record<string, unknown>));

        case 'proposal':
          return withOnboarding(await proposalTool.handler(args as Record<string, unknown>));

        case 'plan':
          return withOnboarding(await planTool.handler(args as Record<string, unknown>));

        case 'chat': {
          const chatAction = (args as Record<string, unknown>)?.action as string;

          // SONDER-LOGIK: "register" mit lastChatRead Tracking + Specialist-Info
          if (chatAction === 'register') {
            const regId = (args as Record<string, unknown>)?.id as string;
            const regProjectPath = (args as Record<string, unknown>)?.project_path as string | undefined;
            const regProject = (args as Record<string, unknown>)?.project as string;
            const regModel = (args as Record<string, unknown>)?.model as string | undefined;
            const regCutoffDate = (args as Record<string, unknown>)?.cutoff_date as string | undefined;

            const result = await registerChatAgent(regId, regProject, regModel, regCutoffDate);
            // Chat-Read-Timestamp ab jetzt tracken
            lastChatRead.set(regId, new Date().toISOString());
            // Specialist-System: Pruefen ob dieser Agent ein Spezialist ist
            const regEnriched: Record<string, unknown> = { ...result };
            if (regProjectPath) {
              try {
                const specStatus = await readStatus(regProjectPath);
                if (specStatus.specialists[regId]) {
                  regEnriched.specialistInfo = {
                    isSpecialist: true,
                    specialistStatus: specStatus.specialists[regId].status,
                  };
                }
              } catch { /* Specialist-Status nicht verfuegbar */ }
            }
            return { content: [{ type: 'text', text: JSON.stringify(regEnriched, null, 2) }] };
          }

          // SONDER-LOGIK: "register_batch" mit lastChatRead Tracking
          if (chatAction === 'register_batch') {
            const agentsList = (args as Record<string, unknown>)?.agents as Array<{ id: string; model?: string; cutoffDate?: string }>;
            const batchProject = (args as Record<string, unknown>)?.project as string;
            const result = await registerChatAgentsBatch(agentsList, batchProject);
            const now = new Date().toISOString();
            for (const a of agentsList) lastChatRead.set(a.id, now);
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // SONDER-LOGIK: "send" mit Specialist Dual-Path Routing
          if (chatAction === 'send') {
            const senderId = (args as Record<string, unknown>)?.sender_id as string;
            const rawRecipientId = (args as Record<string, unknown>)?.recipient_id;
            const content = (args as Record<string, unknown>)?.content as string;
            const project = (args as Record<string, unknown>)?.project as string;
            const sendProjectPath = (args as Record<string, unknown>)?.project_path as string | undefined;

            // Array-Support: Multicast an mehrere Empfaenger
            if (Array.isArray(rawRecipientId)) {
              const recipientIds = rawRecipientId as string[];
              const results: Array<Record<string, unknown>> = [];
              const errors: string[] = [];
              for (const rid of recipientIds) {
                try {
                  // Specialist-Routing pro Empfaenger
                  if (sendProjectPath) {
                    try {
                      const specStatus = await readStatus(sendProjectPath);
                      if (specStatus.specialists[rid]) {
                        const inboxResult = await postToInbox(senderId, rid, content);
                        results.push({ success: true, routed: 'specialist_inbox', recipient: rid, ...inboxResult });
                        continue;
                      }
                    } catch { /* Specialist-Status nicht verfuegbar */ }
                  }
                  const r = await sendChatMessage(project, senderId, content, rid);
                  results.push(r as Record<string, unknown>);
                } catch (err) {
                  errors.push(`${rid}: ${err}`);
                }
              }
              const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
              try {
                await server.sendLoggingMessage({
                  level: 'info',
                  data: `📨 Chat [${senderId} → Multicast(${recipientIds.join(',')})]: ${preview}`,
                });
              } catch { /* Logging nicht verfuegbar */ }
              return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length, errors, action: 'send' }, null, 2) }] };
            }

            const recipientId = typeof rawRecipientId === 'string' ? rawRecipientId : undefined;

            // Dual-path: Specialist-Routing wenn project_path angegeben
            if (sendProjectPath) {
              try {
                const specStatus = await readStatus(sendProjectPath);

                // Recipient ist ein Spezialist → direkt in die Inbox routen
                if (recipientId && specStatus.specialists[recipientId]) {
                  const inboxResult = await postToInbox(senderId, recipientId, content);
                  const target = `DM an ${recipientId}`;
                  const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
                  try {
                    await server.sendLoggingMessage({
                      level: 'info',
                      data: `📨 Chat [${senderId} → ${target}] (specialist-inbox): ${preview}`,
                    });
                  } catch { /* Logging nicht verfuegbar */ }
                  return {
                    content: [{
                      type: 'text',
                      text: JSON.stringify({ success: true, routed: 'specialist_inbox', ...inboxResult }, null, 2),
                    }],
                  };
                }

                // Broadcast und Spezialisten laufen → auch in general-channel posten
                if (!recipientId) {
                  const runningCount = Object.values(specStatus.specialists).filter(s => s.status === 'running').length;
                  if (runningCount > 0) {
                    try {
                      await postMessage(`${project}-general`, senderId, content);
                    } catch { /* Channel existiert noch nicht */ }
                  }
                }
              } catch { /* Specialist-Status nicht verfuegbar, legacy fallback */ }
            }

            // Legacy-Pfad (auch als Fallback wenn kein project_path)
            const result = await sendChatMessage(project, senderId, content, recipientId);

            // Broadcast-Notification an den Client: Neue Chat-Nachricht!
            if (result.success) {
              const target = recipientId ? `DM an ${recipientId}` : 'Broadcast';
              const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
              try {
                await server.sendLoggingMessage({
                  level: 'info',
                  data: `📨 Chat [${senderId} → ${target}]: ${preview}`,
                });
              } catch { /* Logging nicht verfuegbar */ }
            }

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // SONDER-LOGIK: "get" mit lastChatRead Tracking + Specialist Inbox
          if (chatAction === 'get') {
            const getMsgProjectPath = (args as Record<string, unknown>)?.project_path as string | undefined;
            const getMsgAgentId = (args as Record<string, unknown>)?.agent_id as string | undefined;
            const getMsgProject = (args as Record<string, unknown>)?.project as string;
            const result = await getChatMessages(getMsgProject, {
              agentId: getMsgAgentId,
              since: (args as Record<string, unknown>)?.since as string | undefined,
              senderId: (args as Record<string, unknown>)?.sender_id_filter as string | undefined,
              limit: (args as Record<string, unknown>)?.limit as number | undefined,
            });
            // Timestamp aktualisieren — Agent hat Chat gelesen
            if (agentId) {
              lastChatRead.set(agentId, new Date().toISOString());
            }

            // Dual-path: Specialist-Inbox-Nachrichten anfuegen wenn project_path vorhanden
            if (getMsgProjectPath && getMsgAgentId) {
              try {
                const specStatus = await readStatus(getMsgProjectPath);
                if (Object.keys(specStatus.specialists).length > 0) {
                  const inboxMessages = await checkInbox(getMsgAgentId);
                  if (inboxMessages.length > 0) {
                    const inboxResult: Record<string, unknown> = {
                      ...(typeof result === 'object' && result !== null ? result : { messages: [] }),
                      specialistInbox: inboxMessages.map(m => ({
                        id: m.id,
                        from: m.fromAgent,
                        content: m.content,
                        createdAt: m.createdAt,
                      })),
                    };
                    return { content: [{ type: 'text', text: JSON.stringify(inboxResult, null, 2) }] };
                  }
                }
              } catch { /* Specialist-Inbox nicht verfuegbar */ }
            }

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // SONDER-LOGIK: "list" mit Specialist-Merge
          if (chatAction === 'list') {
            const listProjectPath = (args as Record<string, unknown>)?.project_path as string | undefined;
            const listProject = (args as Record<string, unknown>)?.project as string;
            const result = await listAgents(listProject);

            // Dual-path: Spezialisten anfuegen wenn project_path vorhanden
            if (listProjectPath) {
              try {
                const specStatus = await readStatus(listProjectPath);
                const specialists = Object.entries(specStatus.specialists).map(([specName, s]) => ({
                  id: specName,
                  isSpecialist: true,
                  status: s.status,
                  model: s.model,
                  currentTask: s.currentTask,
                  lastActivity: s.lastActivity,
                }));
                if (specialists.length > 0) {
                  const enrichedList: Record<string, unknown> = {
                    ...(typeof result === 'object' && result !== null ? result : {}),
                    specialists,
                  };
                  return { content: [{ type: 'text', text: JSON.stringify(enrichedList, null, 2) }] };
                }
              } catch { /* Specialist-Status nicht verfuegbar */ }
            }

            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          // Alle anderen chat-actions (unregister, unregister_batch, inbox_send, inbox_check)
          return withOnboarding(await chatTool.handler(args as Record<string, unknown>));
        }

        case 'channel':
          return withOnboarding(await channelTool.handler(args as Record<string, unknown>));

        case 'event': {
          const eventAction = (args as Record<string, unknown>)?.action as string;

          // SONDER-LOGIK: "ack" mit eventIgnoreCount Reset
          if (eventAction === 'ack') {
            const eventIdRaw = (args as Record<string, unknown>)?.event_id;
            const ackAgentId = (args as Record<string, unknown>)?.agent_id as string;
            const reaction = (args as Record<string, unknown>)?.reaction as string | undefined;

            // Array-Support: Mehrere Events in einem Call bestätigen
            if (Array.isArray(eventIdRaw)) {
              const eventIds = eventIdRaw as number[];
              const settled = await Promise.allSettled(
                eventIds.map(eid => acknowledgeEventTool(eid, ackAgentId, reaction))
              );
              const results: Array<Record<string, unknown>> = [];
              const errors: string[] = [];
              for (const r of settled) {
                if (r.status === 'fulfilled') results.push(r.value as Record<string, unknown>);
                else errors.push(String(r.reason));
              }
              // Eskalations-Counter zuruecksetzen wenn mindestens ein Ack erfolgreich
              const anySuccess = results.some(r => (r as any).success === true);
              if (anySuccess) {
                eventIgnoreCount.delete(ackAgentId);
              }
              return { content: [{ type: 'text', text: JSON.stringify({ results, count: results.length, errors }, null, 2) }] };
            }

            // Bestehend: Einzelnes Event
            const eventId = eventIdRaw as number;
            const result = await acknowledgeEventTool(eventId, ackAgentId, reaction);
            if (result.success) {
              eventIgnoreCount.delete(ackAgentId);
            }
            return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
          }

          return withOnboarding(await eventTool.handler(args as Record<string, unknown>));
        }

        case 'specialist':
          return withOnboarding(await specialistTool.handler(args as Record<string, unknown>));

        case 'docs':
          return withOnboarding(await docsTool.handler(args as Record<string, unknown>));

        case 'admin':
          return withOnboarding(await adminTool.handler(args as Record<string, unknown>));

        default:
          throw new Error(`Unbekanntes Tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: false,
              error: String(error),
            }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Startet den MCP Server
 */
export async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  console.error('[Synapse MCP] Server gestartet (v0.2.0)');

  // Step 1: Ensure agents DB schema exists before any tools are used
  await ensureAgentsSchema();

  // Step 2: Reconnect to running specialists and clean up orphans for all known projects
  const cliInfo = detectClaudeCli();
  if (cliInfo.available) {
    for (const activeProjectName of listActiveProjects()) {
      const projectPath = getProjectPath(activeProjectName);
      if (!projectPath) continue;

      const orphans = await heartbeatController.cleanupOrphans(projectPath);
      if (orphans.length > 0) {
        console.error(`[Synapse] Cleaned up ${orphans.length} orphaned agent sockets for "${activeProjectName}"`);
      }

      const reconnected = await heartbeatController.reconnectAll(projectPath);
      if (reconnected.connected.length > 0) {
        console.error(`[Synapse] Reconnected to ${reconnected.connected.length} running specialists for "${activeProjectName}"`);
      }
      if (reconnected.cleaned.length > 0) {
        console.error(`[Synapse] Cleaned up ${reconnected.cleaned.length} stale specialist entries for "${activeProjectName}"`);
      }
    }
  }
}
