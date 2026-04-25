/**
 * Consolidated Channel Tool
 * Konsolidiert 6 MCP-Channel-Tools zu einem einzigen Tool mit action-Parameter
 *
 * Actions:
 * - create: Erstellt einen neuen Channel
 * - join: Fuegt einen Agenten einem Channel hinzu
 * - leave: Entfernt einen Agenten aus einem Channel
 * - post: Postet eine Nachricht in einen Channel
 * - feed: Holt Nachrichten aus einem Channel
 * - list: Listet alle Channels auf
 */

import type { ConsolidatedTool } from './types.js';
import { reqStr, str, num, bool, strArray } from './types.js';
import {
  createChannel,
  joinChannel,
  leaveChannel,
  postMessage,
  getMessages,
  listChannels,
} from '@synapse/agents';

function jsonResult(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// Handler-Implementierungen fuer jede Action
// ---------------------------------------------------------------------------

async function handleCreate(args: Record<string, unknown>) {
  const name = reqStr(args, 'name');
  const project = reqStr(args, 'project');
  const description = reqStr(args, 'description');
  const createdBy = reqStr(args, 'created_by');

  try {
    const channel = await createChannel(project, name, description, createdBy);
    return jsonResult({
      success: true,
      channel,
      message: `Channel "${name}" erstellt.`,
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

async function handleJoin(args: Record<string, unknown>) {
  const project = reqStr(args, 'project');
  const channelName = reqStr(args, 'channel_name');
  const agentName = reqStr(args, 'agent_name');

  try {
    const joined = await joinChannel(project, channelName, agentName);
    if (!joined) {
      return jsonResult({ success: false, message: `Channel "${channelName}" nicht gefunden.` });
    }
    return jsonResult({ success: true, message: `"${agentName}" ist Channel "${channelName}" beigetreten.` });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

async function handleLeave(args: Record<string, unknown>) {
  const project = reqStr(args, 'project');
  const channelName = reqStr(args, 'channel_name');
  const agentName = reqStr(args, 'agent_name');

  try {
    const left = await leaveChannel(project, channelName, agentName);
    if (!left) {
      return jsonResult({ success: false, message: `"${agentName}" war nicht in Channel "${channelName}".` });
    }
    return jsonResult({ success: true, message: `"${agentName}" hat Channel "${channelName}" verlassen.` });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

async function handlePost(args: Record<string, unknown>) {
  const project = reqStr(args, 'project');
  const channelName = reqStr(args, 'channel_name');
  const sender = reqStr(args, 'sender');
  const content = reqStr(args, 'content');

  try {
    const result = await postMessage(project, channelName, sender, content);
    if (!result) {
      return jsonResult({ success: false, message: `Channel "${channelName}" nicht gefunden.` });
    }
    return jsonResult({
      success: true,
      message: `Nachricht in "${channelName}" gepostet.`,
      messageId: result.id,
      createdAt: result.createdAt.toISOString(),
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

async function handleFeed(args: Record<string, unknown>) {
  const project = reqStr(args, 'project');
  const channelName = reqStr(args, 'channel_name');
  const limit = num(args, 'limit');
  const sinceId = num(args, 'since_id');
  const preview = bool(args, 'preview');

  try {
    const messages = await getMessages(project, channelName, { limit, sinceId, preview });
    return jsonResult({
      success: true,
      channel: channelName,
      count: messages.length,
      messages: messages.map(m => ({
        id: m.id,
        sender: m.sender,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

async function handleList(args: Record<string, unknown>) {
  const project = str(args, 'project');

  try {
    const channels = await listChannels(project);
    return jsonResult({
      success: true,
      count: channels.length,
      channels,
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const channelTool: ConsolidatedTool = {
  definition: {
    name: 'channel',
    description: 'Verwaltet Channels fuer Spezialisten-Kommunikation (create, join, leave, post, feed, list)',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'join', 'leave', 'post', 'feed', 'list'],
          description: 'Die auszufuehrende Aktion',
        },
        // create: name, project, description, created_by
        name: {
          type: 'string',
          description: 'Channel-Name (fuer create)',
        },
        project: {
          type: 'string',
          description: 'Projekt-Name (fuer create und list)',
        },
        description: {
          type: 'string',
          description: 'Beschreibung des Channels (fuer create)',
        },
        created_by: {
          type: 'string',
          description: 'Ersteller (Agent-Name, fuer create)',
        },
        // join/leave/post/feed: channel_name
        channel_name: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: 'Channel-Name (fuer join, leave, post, feed). Array erlaubt fuer: join, leave',
        },
        // join/leave: agent_name
        agent_name: {
          type: 'string',
          description: 'Agent-Name (fuer join, leave)',
        },
        // post: sender, content
        sender: {
          type: 'string',
          description: 'Absender (Agent-Name, fuer post)',
        },
        content: {
          type: 'string',
          description: 'Nachrichteninhalt (fuer post)',
        },
        // feed: limit, since_id, preview
        limit: {
          type: 'number',
          description: 'Max. Nachrichten (Standard: 20, fuer feed)',
        },
        since_id: {
          type: 'number',
          description: 'Nur Nachrichten nach dieser ID (fuer feed)',
        },
        preview: {
          type: 'boolean',
          description: 'Inhalte auf 200 Zeichen kuerzen (fuer feed)',
        },
      },
      required: ['action'],
    },
  },

  handler: async (args: Record<string, unknown>) => {
    const action = reqStr(args, 'action');

    switch (action) {
      case 'create':
        return await handleCreate(args);
      case 'join': {
        // Array-Support: Mehreren Channels beitreten
        const channelNames = strArray(args, 'channel_name');
        if (channelNames && channelNames.length > 1) {
          const project = reqStr(args, 'project');
          const agentName = reqStr(args, 'agent_name');
          const settled = await Promise.allSettled(
            channelNames.map(cn => joinChannel(project, cn, agentName))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (let i = 0; i < settled.length; i++) {
            const r = settled[i];
            if (r.status === 'fulfilled') {
              results.push({
                success: !!r.value,
                channel: channelNames[i],
                message: r.value
                  ? `"${agentName}" ist Channel "${channelNames[i]}" beigetreten.`
                  : `Channel "${channelNames[i]}" nicht gefunden.`,
              });
            } else {
              errors.push(`${channelNames[i]}: ${r.reason}`);
            }
          }
          return jsonResult({ results, count: results.length, errors });
        }
        return await handleJoin(args);
      }
      case 'leave': {
        // Array-Support: Mehrere Channels verlassen
        const channelNames = strArray(args, 'channel_name');
        if (channelNames && channelNames.length > 1) {
          const project = reqStr(args, 'project');
          const agentName = reqStr(args, 'agent_name');
          const settled = await Promise.allSettled(
            channelNames.map(cn => leaveChannel(project, cn, agentName))
          );
          const results: Array<Record<string, unknown>> = [];
          const errors: string[] = [];
          for (let i = 0; i < settled.length; i++) {
            const r = settled[i];
            if (r.status === 'fulfilled') {
              results.push({
                success: !!r.value,
                channel: channelNames[i],
                message: r.value
                  ? `"${agentName}" hat Channel "${channelNames[i]}" verlassen.`
                  : `"${agentName}" war nicht in Channel "${channelNames[i]}".`,
              });
            } else {
              errors.push(`${channelNames[i]}: ${r.reason}`);
            }
          }
          return jsonResult({ results, count: results.length, errors });
        }
        return await handleLeave(args);
      }
      case 'post':
        return await handlePost(args);
      case 'feed':
        return await handleFeed(args);
      case 'list':
        return await handleList(args);
      default:
        return jsonResult({ success: false, message: `Unbekannte Action: ${action}` });
    }
  },
};
