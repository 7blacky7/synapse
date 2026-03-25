/**
 * Synapse MCP - Specialist, Channel & Inbox Tools
 * Wrapper-Funktionen fuer die @synapse/agents Integration
 */

import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  detectClaudeCli,
  canSpawn,
  ensureAgentDir,
  readSkill,
  writeSkill,
  createInitialSkill,
  readMemory as readAgentMemory,
  readStatus,
  updateSpecialist,
  removeSpecialist,
  buildSpecialistPrompt,
  heartbeatController,
  ensureGeneralChannel,
  joinChannel,
  leaveChannel,
  createChannel,
  postMessage,
  getMessages,
  listChannels,
  getChannelMembers,
  postToInbox,
  checkInbox,
  type SpecialistConfig,
} from '@synapse/agents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveWrapperPath(): string {
  // ESM-compatible resolution: use createRequire to locate the wrapper binary
  const require = createRequire(import.meta.url);
  return require.resolve('@synapse/agents/dist/wrapper.js');
}

function jsonResult(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

// ---------------------------------------------------------------------------
// spawn_specialist
// ---------------------------------------------------------------------------

export async function spawnSpecialistTool(
  name: string,
  model: SpecialistConfig['model'],
  expertise: string,
  task: string,
  project: string,
  projectPath: string,
  cwd?: string,
  channel?: string,
  allowedTools?: string[],
  keepAlive?: boolean,
) {
  // 1. Claude CLI pruefen
  const cliInfo = detectClaudeCli();
  if (!cliInfo.available) {
    return jsonResult({
      success: false,
      message: 'Claude CLI nicht gefunden. Installiere claude (npm i -g @anthropic-ai/claude-code) und stelle sicher, dass "claude" im PATH ist.',
    });
  }

  // 2. Limit pruefen
  const spawnCheck = await canSpawn(projectPath);
  if (!spawnCheck.ok) {
    return jsonResult({
      success: false,
      message: spawnCheck.reason ?? 'Specialist-Limit erreicht.',
    });
  }

  // 3. Agent-Verzeichnis erstellen
  await ensureAgentDir(projectPath, name);

  // 4. SKILL.md lesen oder erstellen
  let skill = await readSkill(projectPath, name);
  if (!skill) {
    skill = createInitialSkill(name, model, expertise);
    await writeSkill(projectPath, name, skill);
  }

  // 5. MEMORY.md lesen
  const memory = await readAgentMemory(projectPath, name);

  // 6. System-Prompt bauen
  const config: SpecialistConfig = {
    name,
    model,
    expertise,
    task,
    project,
    cwd,
    channel,
    allowedTools,
  };
  const systemPrompt = buildSpecialistPrompt(config, skill, memory);

  // 7. System-Prompt in Datei schreiben (zu gross fuer Env-Var)
  const promptFile = join(projectPath, '.synapse', 'agents', name, 'system-prompt.txt');
  await writeFile(promptFile, systemPrompt, 'utf-8');

  // 8. General-Channel sicherstellen und Agent joinen
  await ensureGeneralChannel(project, name, name);
  if (channel && channel !== `${project}-general`) {
    await joinChannel(channel, name);
  }

  // 9. Wrapper als DETACHED Prozess starten
  const socketDir = join(projectPath, '.synapse', 'sockets');
  await mkdir(socketDir, { recursive: true });
  const socketPath = join(socketDir, `${name}.sock`);

  const wrapperPath = resolveWrapperPath();

  const wrapper = spawn('node', [wrapperPath], {
    env: {
      ...process.env,
      SYNAPSE_AGENT_NAME: name,
      SYNAPSE_AGENT_MODEL: model,
      SYNAPSE_PROJECT_NAME: project,
      SYNAPSE_PROJECT_PATH: projectPath,
      SYNAPSE_SOCKET_PATH: socketPath,
      SYNAPSE_SYSTEM_PROMPT_FILE: promptFile,
      SYNAPSE_AGENT_CWD: cwd ?? projectPath,
      ...(allowedTools?.length ? { SYNAPSE_ALLOWED_TOOLS: allowedTools.join(',') } : {}),
      ...(keepAlive ? { SYNAPSE_KEEP_ALIVE: '1' } : {}),
    },
    detached: true,
    stdio: 'ignore',
  });
  wrapper.unref();

  const wrapperPid = wrapper.pid ?? 0;

  // 10. Kurz warten und dann verbinden
  await new Promise((resolve) => setTimeout(resolve, 1500));

  try {
    await heartbeatController.connectToWrapper(name, socketPath);
  } catch (err) {
    // Verbindung fehlgeschlagen — Wrapper koennte noch starten
    console.error(`[Synapse] Konnte nicht sofort zu Wrapper "${name}" verbinden: ${err}`);
  }

  // 11. Status aktualisieren
  await updateSpecialist(projectPath, name, {
    name,
    model,
    status: 'running',
    pid: wrapperPid,
    wrapperPid,
    socket: socketPath,
    tokens: { input: 0, output: 0, percent: 0 },
    contextCeiling: model.includes('1m') ? 1_000_000 : 200_000,
    lastActivity: new Date().toISOString(),
    channels: [channel ?? `${project}-general`],
    currentTask: task,
  });

  return jsonResult({
    success: true,
    specialist: {
      name,
      model,
      expertise,
      task,
      project,
      wrapperPid,
      socket: socketPath,
      channel: channel ?? `${project}-general`,
    },
    message: `Spezialist "${name}" (${model}) gestartet. PID: ${wrapperPid}`,
  });
}

// ---------------------------------------------------------------------------
// stop_specialist
// ---------------------------------------------------------------------------

export async function stopSpecialistTool(
  name: string,
  projectPath: string,
) {
  try {
    // Stop-Kommando senden
    if (heartbeatController.isConnected(name)) {
      await heartbeatController.sendStop(name);
    }
  } catch (err) {
    console.error(`[Synapse] Fehler beim Stoppen von "${name}": ${err}`);
  }

  // Verbindung trennen
  await heartbeatController.disconnectFromWrapper(name);

  // Status aktualisieren
  await updateSpecialist(projectPath, name, {
    status: 'stopped',
    lastActivity: new Date().toISOString(),
    currentTask: null,
  } as any);

  return jsonResult({
    success: true,
    message: `Spezialist "${name}" gestoppt.`,
  });
}

// ---------------------------------------------------------------------------
// specialist_status
// ---------------------------------------------------------------------------

export async function specialistStatusTool(
  projectPath: string,
  name?: string,
) {
  if (!name) {
    // Alle Spezialisten
    const status = await readStatus(projectPath);
    return jsonResult({
      success: true,
      specialists: status.specialists,
      maxSpecialists: status.maxSpecialists,
      runningCount: Object.values(status.specialists).filter(s => s.status === 'running').length,
      lastUpdate: status.lastUpdate,
    });
  }

  // Einzelner Spezialist
  const status = await readStatus(projectPath);
  const specialist = status.specialists[name];
  if (!specialist) {
    return jsonResult({
      success: false,
      message: `Spezialist "${name}" nicht gefunden.`,
    });
  }

  // Wrapper-Status holen wenn verbunden
  let wrapperStatus: Record<string, unknown> = {};
  if (heartbeatController.isConnected(name)) {
    try {
      wrapperStatus = await heartbeatController.getWrapperStatus(name);
    } catch {
      wrapperStatus = { connected: false, error: 'Konnte Wrapper-Status nicht abrufen' };
    }
  }

  // SKILL.md lesen
  const skill = await readSkill(projectPath, name);

  return jsonResult({
    success: true,
    specialist,
    wrapperStatus,
    skill: skill ?? '(keine SKILL.md vorhanden)',
    connected: heartbeatController.isConnected(name),
  });
}

// ---------------------------------------------------------------------------
// wake_specialist
// ---------------------------------------------------------------------------

export async function wakeSpecialistTool(
  name: string,
  message: string,
) {
  if (!heartbeatController.isConnected(name)) {
    return jsonResult({
      success: false,
      message: `Spezialist "${name}" ist nicht verbunden. Verwende spawn_specialist um ihn zu starten.`,
    });
  }

  try {
    const result = await heartbeatController.sendWake(name, message);
    return jsonResult({
      success: true,
      response: result.content,
      tokens: {
        input: result.inputTokens,
        output: result.outputTokens,
      },
    });
  } catch (err) {
    // Agent busy → auto-fallback to inbox (delivered on next heartbeat poll)
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('Agent is busy')) {
      try {
        const inboxResult = await postToInbox('koordinator', name, message);
        return jsonResult({
          success: true,
          queued: true,
          message: `Spezialist "${name}" ist beschaeftigt. Nachricht in Inbox zugestellt (ID: ${inboxResult.id}) — wird beim naechsten Heartbeat verarbeitet.`,
        });
      } catch (inboxErr) {
        return jsonResult({
          success: false,
          message: `Spezialist "${name}" ist beschaeftigt und Inbox-Fallback fehlgeschlagen: ${inboxErr}`,
        });
      }
    }

    return jsonResult({
      success: false,
      message: `Fehler beim Aufwecken von "${name}": ${err}`,
    });
  }
}

// ---------------------------------------------------------------------------
// update_specialist_skill
// ---------------------------------------------------------------------------

export async function updateSpecialistSkillTool(
  name: string,
  projectPath: string,
  section: 'regeln' | 'fehler' | 'patterns',
  action: 'add' | 'remove',
  content: string,
) {
  const skill = await readSkill(projectPath, name);
  if (!skill) {
    return jsonResult({
      success: false,
      message: `Spezialist "${name}" hat keine SKILL.md.`,
    });
  }

  const sectionHeaders: Record<string, string> = {
    regeln: '# Regeln',
    fehler: '# Fehler → Loesung',
    patterns: '# Patterns',
  };

  const header = sectionHeaders[section];
  const lines = skill.split('\n');

  // Finde den Abschnitt
  const sectionIdx = lines.findIndex(l => l.trim() === header);
  if (sectionIdx === -1) {
    return jsonResult({
      success: false,
      message: `Abschnitt "${header}" nicht gefunden in SKILL.md von "${name}".`,
    });
  }

  // Finde das Ende des Abschnitts (naechster # Header oder EOF)
  let endIdx = lines.length;
  for (let i = sectionIdx + 1; i < lines.length; i++) {
    if (lines[i].startsWith('# ') && !lines[i].startsWith('# Fehler')) {
      endIdx = i;
      break;
    }
  }

  if (action === 'add') {
    // Entferne Platzhalter "(Noch keine ...)"
    const sectionLines = lines.slice(sectionIdx + 1, endIdx);
    const filteredLines = sectionLines.filter(l => !l.trim().startsWith('(Noch keine'));

    const newLines = [
      ...lines.slice(0, sectionIdx + 1),
      ...filteredLines,
      `- ${content}`,
      '',
      ...lines.slice(endIdx),
    ];

    await writeSkill(projectPath, name, newLines.join('\n'));
    return jsonResult({
      success: true,
      message: `Eintrag zu "${section}" hinzugefuegt in SKILL.md von "${name}".`,
    });
  }

  if (action === 'remove') {
    const sectionLines = lines.slice(sectionIdx + 1, endIdx);
    const filtered = sectionLines.filter(l => !l.includes(content));

    if (filtered.length === sectionLines.length) {
      return jsonResult({
        success: false,
        message: `Eintrag "${content}" nicht gefunden in Abschnitt "${section}".`,
      });
    }

    const newLines = [
      ...lines.slice(0, sectionIdx + 1),
      ...filtered,
      ...lines.slice(endIdx),
    ];

    await writeSkill(projectPath, name, newLines.join('\n'));
    return jsonResult({
      success: true,
      message: `Eintrag aus "${section}" entfernt in SKILL.md von "${name}".`,
    });
  }

  return jsonResult({ success: false, message: `Unbekannte Aktion: ${action}` });
}

// ---------------------------------------------------------------------------
// Channel Tools
// ---------------------------------------------------------------------------

export async function createChannelTool(
  name: string,
  project: string,
  description: string,
  createdBy: string,
) {
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

export async function joinChannelTool(
  channelName: string,
  agentName: string,
) {
  try {
    const joined = await joinChannel(channelName, agentName);
    if (!joined) {
      return jsonResult({ success: false, message: `Channel "${channelName}" nicht gefunden.` });
    }
    return jsonResult({ success: true, message: `"${agentName}" ist Channel "${channelName}" beigetreten.` });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function leaveChannelTool(
  channelName: string,
  agentName: string,
) {
  try {
    const left = await leaveChannel(channelName, agentName);
    if (!left) {
      return jsonResult({ success: false, message: `"${agentName}" war nicht in Channel "${channelName}".` });
    }
    return jsonResult({ success: true, message: `"${agentName}" hat Channel "${channelName}" verlassen.` });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function postToChannelTool(
  channelName: string,
  sender: string,
  content: string,
) {
  try {
    const result = await postMessage(channelName, sender, content);
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

export async function getChannelFeedTool(
  channelName: string,
  limit?: number,
  sinceId?: number,
  preview?: boolean,
) {
  try {
    const messages = await getMessages(channelName, { limit, sinceId, preview });
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

export async function listChannelsTool(
  project?: string,
) {
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
// Inbox Tools
// ---------------------------------------------------------------------------

export async function postToInboxTool(
  fromAgent: string,
  toAgent: string,
  content: string,
) {
  try {
    const result = await postToInbox(fromAgent, toAgent, content);
    return jsonResult({
      success: true,
      message: `Nachricht von "${fromAgent}" an "${toAgent}" gesendet.`,
      messageId: result.id,
      createdAt: result.createdAt.toISOString(),
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

export async function checkInboxTool(
  agentName: string,
) {
  try {
    const messages = await checkInbox(agentName);
    return jsonResult({
      success: true,
      agent: agentName,
      count: messages.length,
      messages: messages.map(m => ({
        id: m.id,
        from: m.fromAgent,
        content: m.content,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    return jsonResult({ success: false, message: `Fehler: ${err}` });
  }
}

// ---------------------------------------------------------------------------
// Utility: get_agent_capabilities
// ---------------------------------------------------------------------------

export function getAgentCapabilitiesTool() {
  const cliInfo = detectClaudeCli();
  return jsonResult({
    success: true,
    claudeCli: cliInfo,
    features: {
      specialists: cliInfo.available,
      channels: true,
      inbox: true,
      skillLearning: cliInfo.available,
    },
    message: cliInfo.available
      ? `Claude CLI verfuegbar (${cliInfo.version}). Alle Specialist-Features aktiv.`
      : 'Claude CLI nicht verfuegbar. Channel und Inbox Tools funktionieren, aber Specialist-Spawning ist deaktiviert.',
  });
}
