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

import {
  claimUnreadChannelHints,
  getPendingEvents,
  TOOL_GUIDES,
  ensureSchema,
  logToolCall,
  resolveAgentId,
} from '@synapse/core';
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
  codeIntelTool,
  codeCheckTool,
  ignoreTool,
  filesTool,
  shellTool,
  guideTool,
} from './tools/consolidated/index.js';

/** Eindeutige ID dieser Server-Instanz — bei Neustart neu generiert.
 *  Wird fuer Session-basiertes Onboarding verwendet: neue Instance = neues Onboarding. */
export const SERVER_INSTANCE_ID = randomUUID();

/** Tracking: Wann hat ein Agent zuletzt Chat gelesen? */
const lastChatRead = new Map<string, string>();

/** Tracking: Wie oft hat ein Agent ein kritisches Event ignoriert? */
const eventIgnoreCount = new Map<string, { firstSeen: number; count: number }>();

/** Tracking: Welche (Session, Tool)-Kombination wurde bereits mit Guide-Hint versehen?
 *  Schluessel: `${sessionKey}:${toolName}`. sessionKey = agent_id (wenn gesetzt) oder
 *  SERVER_INSTANCE_ID (Fallback fuer anonyme Calls). Lebt im RAM, wird bei Server-Restart
 *  geleert — neuer Server-Run = neue Hints. */
const firstUseHinted = new Set<string>();

/** Baut einen kompakten Tool-Guide-Hinweis fuer die erste Nutzung eines Tools.
 *  Liest aus dem geteilten TOOL_GUIDES (Single Source of Truth in @synapse/core).
 *  Returnt null wenn fuer das Tool kein Guide existiert. */
function buildFirstUseHint(toolName: string): Record<string, unknown> | null {
  const g = TOOL_GUIDES[toolName];
  if (!g) return null;
  return {
    message: `📚 Erste Nutzung von "${toolName}" in dieser Session — kompakte Doku unten. Vollstaendig: guide({ tool_name: "${toolName}" }).`,
    summary: g.summary,
    when_to_use: g.when_to_use,
    when_not_to_use: g.when_not_to_use,
    actions: g.actions ? Object.keys(g.actions) : undefined,
    anti_patterns: g.anti_patterns,
  };
}

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
        hintParts.push(`⛔ PFLICHT-EVENT: ${e.eventType} von ${e.sourceId}: ${e.payload}. Reagiere SOFORT mit event(action: "ack", event_id: ${e.id}, agent_id: "${agentId}")`);
      } else if (e.priority === 'high') {
        hintParts.push(`⚠️ EVENT: ${e.eventType} von ${e.sourceId}: ${e.payload}. Bitte mit event(action: "ack", event_id: ${e.id}, agent_id: "${agentId}") bestaetigen.`);
      } else {
        hintParts.push(`📋 EVENT: ${e.eventType}: ${e.payload}. event(action: "ack", event_id: ${e.id}, agent_id: "${agentId}")`);
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

  // Tool-Liste registrieren (14 konsolidierte Tools)
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
      codeIntelTool.definition,
      codeCheckTool.definition,
      ignoreTool.definition,
      filesTool.definition,
      shellTool.definition,
      guideTool.definition,
    ],
  }));

  // Tool-Aufrufe verarbeiten
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const _t0 = Date.now();

    // Globale Parameter fuer Agent-Onboarding extrahieren
    const agentId = args?.agent_id as string | undefined;
    const projectName = args?.project as string | undefined;
    const role = args?.role as import('./tools/onboarding.js').AgentRole | undefined;

    // First-Use-Hint: pro (Session, Tool) genau einmal die Tool-Doku anhaengen.
    // sessionKey = agent_id wenn gesetzt, sonst Server-Instance-ID (Fallback fuer
    // anonyme Calls in derselben MCP-Session).
    const sessionKey = agentId ?? SERVER_INSTANCE_ID;
    const firstUseKey = `${sessionKey}:${name}`;
    let toolGuideHint: Record<string, unknown> | null = null;
    if (!firstUseHinted.has(firstUseKey)) {
      toolGuideHint = buildFirstUseHint(name);
      // Auch bei null markieren — kein "Retry" wenn Tool im Guide fehlt
      firstUseHinted.add(firstUseKey);
    }

    // Post-Hoc-Decorator: Haengt den First-Use-Hint an JEDE finale Tool-Response —
    // egal ob der Pfad ueber withOnboarding lief oder bypass-Sonderlogik (chat.list,
    // event.ack, etc.). Idempotent: nur einmal pro Response, nur wenn nicht schon drin.
    const attachToolGuide = (resp: { content: Array<{ type: string; text: string }>; isError?: boolean }) => {
      if (!toolGuideHint) return resp;
      const first = resp.content?.[0];
      if (!first || first.type !== 'text' || typeof first.text !== 'string') return resp;
      try {
        const parsed = JSON.parse(first.text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return resp;
        if ('tool_guide' in parsed) return resp; // schon angehaengt (z.B. via withOnboarding)
        parsed.tool_guide = toolGuideHint;
        first.text = JSON.stringify(parsed, null, 2);
      } catch { /* nicht-JSON Response — kein Decorate moeglich, lassen */ }
      return resp;
    };


    const attachResponseHooks = async (
      resp: { content: Array<{ type: string; text: string }>; isError?: boolean },
    ) => {
      const guided = attachToolGuide(resp);
      if (!agentId) return guided;
      const first = guided.content?.[0];
      if (!first || first.type !== 'text' || typeof first.text !== 'string') return guided;
      try {
        const parsed = JSON.parse(first.text);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return guided;
        const hints = await claimUnreadChannelHints(agentId);
        if (hints.length > 0) {
          parsed.unread_channels = hints.map((hint) => ({
            project: hint.project,
            channel: hint.channel,
            count: hint.count,
            newest_id: hint.newestId,
          }));
          first.text = JSON.stringify(parsed, null, 2);
        }

        // ⚠️ MEMORY, GEDANKE UND TASK SIND EBENFALLS HINWEISGEBER (Vorgabe des Users,
        // 02.08.2026). Ein Skillname steht genauso in einer Memory oder einer Task wie in
        // einer Channel-Nachricht. Wer nie einen Channel betritt, bekam vorher nie einen
        // Vorschlag. Gilt schreibend UND lesend: der haeufige Fall ist, dass einer die Task
        // anlegt und ein anderer den Auftrag bekommt, genau sie abzurufen.
        // Die Dedup bleibt global je Agent — kein Skill wird zweimal gezeigt, egal woher.
        if (name === 'memory' || name === 'thought' || name === 'plan') {
          const { verarbeiteSkillHinweisgeber, holeOffeneSkillVorschlaege } = await import('@synapse/core');
          await verarbeiteSkillHinweisgeber(
            name,
            args?.action as string | undefined,
            (args ?? {}) as Record<string, unknown>,
            parsed,
            agentId,
          );
          const weitere = await holeOffeneSkillVorschlaege(agentId);
          if (weitere.suggestions.length > 0) {
            parsed.skill_suggestions = weitere.suggestions;
            parsed.skill_hook_metrics = weitere.metrics;
            first.text = JSON.stringify(parsed, null, 2);
          }
        }
      } catch { /* Response-Hooks duerfen Toolantworten nie brechen */ }
      return guided;
    };

    // Helper: Ergebnis mit Onboarding erweitern
    const withOnboarding = async (result: Record<string, unknown>) => {
      if (!agentId || !projectName) {
        const out: Record<string, unknown> = { ...result };
        if (toolGuideHint) out.tool_guide = toolGuideHint;
        return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
      }

      const onboarding = await checkAgentOnboarding(projectName, agentId, undefined, role);
      const enhanced: Record<string, unknown> = { ...result };
      if (toolGuideHint) enhanced.tool_guide = toolGuideHint;

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

    const baseResp = await (async () => {
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
                      await postMessage(project, `${project}-general`, senderId, content);
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

        case 'code_intel':
          return withOnboarding(await codeIntelTool.handler(args as Record<string, unknown>));

        case 'code_check':
          return withOnboarding(await codeCheckTool.handler(args as Record<string, unknown>));

        case 'ignore':
          return withOnboarding(await ignoreTool.handler(args as Record<string, unknown>));

        case 'files':
          return withOnboarding(await filesTool.handler(args as Record<string, unknown>));

        case 'shell':
          return withOnboarding(await shellTool.handler(args as Record<string, unknown>));

        case 'guide':
          return withOnboarding(await guideTool.handler(args as Record<string, unknown>));

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
    })();
    // Activity-Log (best-effort, non-blocking) — stdio-Pfad.
    const _resp = baseResp as { content?: Array<{ text?: string }>; isError?: boolean };
    const _text = _resp.content?.[0]?.text ?? null;
    void logToolCall({
      project: typeof projectName === 'string' ? projectName : null,
      agentId: resolveAgentId(typeof agentId === 'string' ? agentId : null),
      source: 'stdio',
      tool: name,
      action: typeof (args as Record<string, unknown> | undefined)?.action === 'string' ? ((args as Record<string, unknown>).action as string) : null,
      argsPreview: JSON.stringify(args ?? {}).slice(0, 500),
      ok: !_resp.isError,
      error: _resp.isError ? (_text ?? 'error') : null,
      durationMs: Date.now() - _t0,
      result: _text,
    });
    return await attachResponseHooks(
      baseResp as { content: Array<{ type: string; text: string }>; isError?: boolean },
    );
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

  // Step 0: Haupt-DB-Schema sicherstellen (Tabellen + Migrationen, idempotent).
  // Wichtig: VOR ensureAgentsSchema(), und VOR dem ersten Tool-Call — sonst
  // schlagen Tools auf neuen Spalten/Tabellen mit "relation does not exist" fehl.
  try {
    await ensureSchema();
  } catch (err) {
    console.error('[Synapse] ensureSchema fehlgeschlagen — Tools koennten Schema-Fehler werfen:', err);
  }

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
