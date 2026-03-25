#!/usr/bin/env node

/**
 * MODUL: Agent-Wrapper (Standalone Binary)
 * ZWECK: Detached Node.js Prozess der einen Claude CLI Subprocess steuert,
 *        einen Unix Domain Socket fuer MCP-Server Kommunikation oeffnet,
 *        und einen Mini-Heartbeat (DB Polling) betreibt.
 *
 * ARCHITEKTUR:
 *   MCP-Server <-- Unix Socket (reconnectable!) --> Agent-Wrapper (detached)
 *                                                     +-- stdin/stdout PIPE -> claude CLI
 *
 * KONFIGURATION: Alle Parameter kommen aus Umgebungsvariablen (gesetzt vom Spawner).
 *
 * NEBENEFFEKTE:
 *   - Haelt Claude CLI Subprocess am Leben
 *   - Pollt DB fuer Channel/Inbox-Nachrichten
 *   - Aktualisiert status.json im Projekt
 *   - Erstellt und verwaltet Unix Domain Socket
 */

import { createServer, type Server, type Socket } from 'node:net'
import { unlinkSync, chmodSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { ProcessManager } from './process.js'
import { getNewMessagesForAgent } from './channels.js'
import { getNewMessages as getNewInboxMessages } from './inbox.js'
import { readStatus, updateSpecialist } from './status.js'
import { getPool } from '@synapse/core'
import {
  CONTEXT_CEILINGS,
  WARN_THRESHOLDS,
  type WrapperMessage,
  type WrapperResponse,
  type SendMessageResult,
  type SpecialistStatus,
} from './types.js'

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const AGENT_NAME = process.env.SYNAPSE_AGENT_NAME!
const AGENT_MODEL = process.env.SYNAPSE_AGENT_MODEL!
const PROJECT_PATH = process.env.SYNAPSE_PROJECT_PATH!
const SOCKET_PATH = process.env.SYNAPSE_SOCKET_PATH!
const SYSTEM_PROMPT_FILE = process.env.SYNAPSE_SYSTEM_PROMPT_FILE!
const POLL_INTERVAL = parseInt(process.env.SYNAPSE_POLL_INTERVAL || '15000', 10)
const KEEP_ALIVE = process.env.SYNAPSE_KEEP_ALIVE === '1'

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------
let lastChannelMsgId = 0
let lastInboxMsgId = 0
let totalInputTokens = 0
let totalOutputTokens = 0
let lastActivityTs = new Date().toISOString()
let agentBusy = false
let shuttingDown = false
let processAlive = true

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------
const processManager = new ProcessManager()
let socketServer: Server | null = null
const connectedClients: Set<Socket> = new Set()
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string, ...args: unknown[]) {
  console.error(`[Wrapper:${AGENT_NAME}] ${msg}`, ...args)
}

function getContextCeiling(): number {
  return CONTEXT_CEILINGS[AGENT_MODEL] ?? 200_000
}

function getWarnThreshold(): number {
  return WARN_THRESHOLDS[AGENT_MODEL] ?? 160_000
}

function getContextPercent(): number {
  const total = totalInputTokens + totalOutputTokens
  const ceiling = getContextCeiling()
  return ceiling > 0 ? Math.round((total / ceiling) * 100) : 0
}

// ---------------------------------------------------------------------------
// Part 1: Unix Socket Server (JSON-RPC, newline-delimited)
// ---------------------------------------------------------------------------

function sendToClient(client: Socket, response: WrapperResponse) {
  try {
    if (!client.destroyed) {
      client.write(JSON.stringify(response) + '\n')
    }
  } catch {
    // Client gone, will be cleaned up
  }
}

function broadcast(notification: WrapperResponse) {
  for (const client of connectedClients) {
    sendToClient(client, notification)
  }
}

function broadcastNotification(method: string, params: Record<string, unknown>) {
  broadcast({
    jsonrpc: '2.0',
    result: { method, ...params },
  })
}

async function handleRpcRequest(msg: WrapperMessage): Promise<WrapperResponse> {
  const id = msg.id
  try {
    switch (msg.method) {
      case 'wake':
        return await handleWake(msg.params?.message as string, id)
      case 'stop':
        return await handleStop(id)
      case 'status':
        return handleStatus(id)
      case 'save_and_pause':
        return await handleSaveAndPause(id)
      default:
        return {
          jsonrpc: '2.0',
          error: { code: -32601, message: `Unknown method: ${msg.method}` },
          id,
        }
    }
  } catch (err) {
    return {
      jsonrpc: '2.0',
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      id,
    }
  }
}

async function handleWake(message: string | undefined, id?: number): Promise<WrapperResponse> {
  if (!message) {
    return {
      jsonrpc: '2.0',
      error: { code: -32602, message: 'Missing "message" parameter' },
      id,
    }
  }

  if (!processAlive) {
    return {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Agent process is not running' },
      id,
    }
  }

  const result = await wakeAgent(message)
  return {
    jsonrpc: '2.0',
    result: {
      content: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    },
    id,
  }
}

async function handleStop(id?: number): Promise<WrapperResponse> {
  log('Stop requested — asking agent to save and shutting down')

  // Ask agent to save before stopping
  if (processAlive && !agentBusy) {
    try {
      await wakeAgent(
        `Du wirst gleich gestoppt. PFLICHT-AKTION JETZT:
1. Sichere deinen kompletten Wissensstand in MEMORY.md
2. Update deinen SKILL.md falls noetig
3. Antworte mit MEMORY_SAVED wenn fertig

Alles was du NICHT speicherst geht verloren.`,
      )
    } catch (err) {
      log('Could not ask agent to save before stop: %s', err)
    }
  }

  // Schedule shutdown after response is sent
  setTimeout(() => gracefulShutdown('stop_requested'), 100)

  return {
    jsonrpc: '2.0',
    result: { stopped: true },
    id,
  }
}

function handleStatus(id?: number): WrapperResponse {
  const total = totalInputTokens + totalOutputTokens
  return {
    jsonrpc: '2.0',
    result: {
      name: AGENT_NAME,
      model: AGENT_MODEL,
      busy: agentBusy,
      processAlive,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        total,
        percent: getContextPercent(),
      },
      contextCeiling: getContextCeiling(),
      lastActivity: lastActivityTs,
      pid: process.pid,
    },
    id,
  }
}

async function handleSaveAndPause(id?: number): Promise<WrapperResponse> {
  log('Save-and-pause requested — asking agent to save MEMORY + SKILL')

  if (processAlive && !agentBusy) {
    try {
      await wakeAgent(
        `PAUSE-SIGNAL: Sichere deinen aktuellen Stand.
1. Sichere deinen kompletten Wissensstand in MEMORY.md
2. Update deinen SKILL.md falls noetig
3. Antworte mit MEMORY_SAVED wenn fertig

Der Wrapper laeuft weiter — du bekommst spaeter neue Nachrichten.`,
      )
    } catch (err) {
      log('Could not ask agent to save during pause: %s', err)
    }
  }

  return {
    jsonrpc: '2.0',
    result: { saved: true },
    id,
  }
}

function startSocketServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Clean up leftover socket from previous run
    if (existsSync(SOCKET_PATH)) {
      try {
        unlinkSync(SOCKET_PATH)
      } catch {
        // ignore
      }
    }

    socketServer = createServer((client: Socket) => {
      connectedClients.add(client)
      log('Socket client connected (total: %d)', connectedClients.size)

      let buffer = ''

      client.on('data', (data: Buffer) => {
        buffer += data.toString()

        // Process newline-delimited JSON-RPC messages
        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim()
          buffer = buffer.slice(newlineIdx + 1)

          if (!line) continue

          let msg: WrapperMessage
          try {
            msg = JSON.parse(line)
          } catch {
            sendToClient(client, {
              jsonrpc: '2.0',
              error: { code: -32700, message: 'Parse error' },
            })
            continue
          }

          // Handle request asynchronously
          handleRpcRequest(msg).then(
            (response) => sendToClient(client, response),
            (err) =>
              sendToClient(client, {
                jsonrpc: '2.0',
                error: { code: -32000, message: String(err) },
                id: msg.id,
              }),
          )
        }
      })

      client.on('close', () => {
        connectedClients.delete(client)
        log('Socket client disconnected (remaining: %d)', connectedClients.size)
      })

      client.on('error', (err) => {
        connectedClients.delete(client)
        log('Socket client error: %s', err.message)
      })
    })

    socketServer.on('error', (err) => {
      log('Socket server error: %s', err.message)
      reject(err)
    })

    socketServer.listen(SOCKET_PATH, () => {
      // Restrict socket to owner only
      try {
        chmodSync(SOCKET_PATH, 0o600)
      } catch {
        // ignore chmod errors
      }
      log('Socket server listening on %s', SOCKET_PATH)
      resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Part 2: ProcessManager Integration
// ---------------------------------------------------------------------------

async function startAgentProcess(systemPrompt: string): Promise<void> {
  await processManager.start(AGENT_NAME, AGENT_MODEL, systemPrompt, {
    cwd: PROJECT_PATH,
  })
  processAlive = true
  log('Claude CLI subprocess started')
}

async function wakeAgent(message: string): Promise<SendMessageResult> {
  agentBusy = true
  lastActivityTs = new Date().toISOString()

  try {
    const result = await processManager.sendMessage(AGENT_NAME, message)

    // Track cumulative tokens
    totalInputTokens += result.inputTokens
    totalOutputTokens += result.outputTokens
    lastActivityTs = new Date().toISOString()

    // Broadcast output to all connected socket clients
    broadcastNotification('agent_output', {
      content: result.content,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    })

    return result
  } catch (err) {
    broadcastNotification('agent_error', {
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  } finally {
    agentBusy = false
  }
}

// ---------------------------------------------------------------------------
// Part 3: Mini-Heartbeat (DB Polling)
// ---------------------------------------------------------------------------

async function heartbeatPoll() {
  if (shuttingDown || !processAlive) return

  try {
    const hadChannelMessages = await pollChannelMessages()
    const hadInboxMessages = await pollInboxMessages()
    await updateStatusFile()

    // keepAlive: Wake agent even when no new messages arrived
    if (KEEP_ALIVE && !hadChannelMessages && !hadInboxMessages && !agentBusy) {
      const percent = getContextPercent()
      const total = totalInputTokens + totalOutputTokens
      const tokenInfo = `[Context: ${Math.round(total / 1000)}k tokens, ${percent}%]`
      const prompt = `${tokenInfo} HEARTBEAT — Keine neuen Nachrichten. Fuehre deinen laufenden Task fort oder poste einen Status-Update in deinen Channel.`
      try {
        await wakeAgent(prompt)
      } catch (err) {
        log('keepAlive wake failed: %s', err)
      }
    }
  } catch (err) {
    log('Heartbeat poll error: %s', err)
  }
}

async function pollChannelMessages(): Promise<boolean> {
  if (agentBusy) return false

  const newMsgs = await getNewMessagesForAgent(AGENT_NAME, lastChannelMsgId)
  if (newMsgs.length === 0) return false

  // Update watermark
  lastChannelMsgId = newMsgs[newMsgs.length - 1].id

  // Detect human messages (not from known agents/coordinator)
  const hasHumanMsg = newMsgs.some(
    (m) => m.sender !== 'coordinator' && !m.sender.startsWith('agent-'),
  )

  const summary = newMsgs
    .map((m) => {
      const isHuman = m.sender !== 'coordinator' && !m.sender.startsWith('agent-')
      const tag = isHuman ? '[PRAXIS-FEEDBACK] ' : ''
      const truncated = m.content.length > 500 ? m.content.slice(0, 500) + '...' : m.content
      return `${tag}[#${m.channelName}] ${m.sender}: ${truncated}`
    })
    .join('\n\n')

  // Context status
  const total = totalInputTokens + totalOutputTokens
  const percent = getContextPercent()
  const tokenInfo = `[Context: ${Math.round(total / 1000)}k tokens, ${percent}%]`

  let prompt = `${tokenInfo} Neue Channel-Nachrichten fuer dich:\n\n${summary}\n\nWenn du fachlich beitragen kannst, antworte im Channel mit mcp__synapse__post_to_channel. Wenn nichts fuer dich dabei ist, antworte nur mit HEARTBEAT_OK.`

  if (hasHumanMsg) {
    prompt += `\n\n[PRAXIS-FEEDBACK] ERKANNT: Eine oder mehrere Nachrichten kommen von einem Menschen (nicht von einem Agenten). Pruefe ob dein Fachwissen korrigiert oder ergaenzt wird. Wenn ja: Update deinen SKILL.md mit dem neuen Praxis-Wissen.`
  }

  // Context warning
  const warnThreshold = getWarnThreshold()
  if (total >= warnThreshold) {
    prompt += `\n\nCONTEXT-WARNUNG (${percent}%): Dein Kontext ist fast voll. Sichere JETZT deinen aktuellen Wissensstand in MEMORY.md — fasse zusammen was du in dieser Session gelernt hast, offene Themen und deinen letzten Stand.`
  }

  try {
    await wakeAgent(prompt)
  } catch (err) {
    log('Failed to wake agent for channel messages: %s', err)
  }

  // Auto-rotation at context ceiling
  const ceiling = getContextCeiling()
  if (total >= ceiling * 0.995) {
    await rotateAgent()
  }

  return true
}

async function pollInboxMessages(): Promise<boolean> {
  if (agentBusy) return false

  const newMsgs = await getNewInboxMessages(AGENT_NAME, lastInboxMsgId)
  if (newMsgs.length === 0) return false

  // Update watermark
  lastInboxMsgId = newMsgs[newMsgs.length - 1].id

  // Mark messages as processed
  const pool = getPool()
  const ids = newMsgs.map((m) => m.id)
  await pool.query(
    `UPDATE specialist_inbox SET processed = true WHERE id = ANY($1::int[])`,
    [ids],
  )

  const summary = newMsgs
    .map((m) => `[DM von ${m.fromAgent}]: ${m.content}`)
    .join('\n\n')

  const prompt = `Neue Inbox-Nachrichten:\n\n${summary}\n\nBearbeite sie und antworte ueber mcp__synapse__post_to_inbox.`

  try {
    await wakeAgent(prompt)
  } catch (err) {
    log('Failed to wake agent for inbox messages: %s', err)
  }

  return true
}

async function updateStatusFile() {
  try {
    await updateSpecialist(PROJECT_PATH, AGENT_NAME, {
      status: processAlive ? (agentBusy ? 'running' : 'idle') : 'crashed',
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        percent: getContextPercent(),
      },
      contextCeiling: getContextCeiling(),
      lastActivity: lastActivityTs,
      pid: processManager.isRunning(AGENT_NAME)
        ? (processManager.getStatus().get(AGENT_NAME)?.pid ?? 0)
        : 0,
      wrapperPid: process.pid,
    } as Partial<SpecialistStatus>)
  } catch (err) {
    log('Failed to update status file: %s', err)
  }
}

// ---------------------------------------------------------------------------
// Auto-rotation when context ceiling is reached
// ---------------------------------------------------------------------------

async function rotateAgent() {
  log('CONTEXT-ROTATION — saving memory and restarting')

  try {
    // Ask agent to save
    if (!agentBusy) {
      await wakeAgent(
        `CONTEXT-RESET STEHT BEVOR. Dein Kontext ist voll. Du wirst gleich neu gestartet.

PFLICHT-AKTION JETZT:
1. Sichere deinen kompletten Wissensstand in MEMORY.md
   - Was hast du in dieser Session gelernt?
   - Welche Diskussionen laufen gerade?
   - Was sind offene Punkte / TODOs?
2. Update deinen SKILL.md falls noetig
3. Antworte mit MEMORY_SAVED wenn fertig

Alles was du NICHT speicherst geht verloren.`,
      )
    }

    // Stop current process
    await processManager.stop(AGENT_NAME)
    processAlive = false

    // Reset token counters (keep message watermarks!)
    totalInputTokens = 0
    totalOutputTokens = 0

    // Re-read system prompt and restart
    const systemPrompt = await readFile(SYSTEM_PROMPT_FILE, 'utf-8')
    await startAgentProcess(systemPrompt)

    // Onboarding: tell agent to load its memory
    const onboardingPrompt = `Du wurdest nach einem Context-Reset neu gestartet.

ERSTE AKTION: Lies deine gesicherten Daten:
1. SKILL.md — dein Praxis-Wissen
2. MEMORY.md — dein letzter Wissensstand vor dem Reset

Danach: Check Channels und Inbox fuer neue Nachrichten.`

    await wakeAgent(onboardingPrompt)
    log('Context rotation completed successfully')
  } catch (err) {
    log('Context rotation failed: %s', err)
  }
}

// ---------------------------------------------------------------------------
// Part 4: Crash Handling & Cleanup
// ---------------------------------------------------------------------------

function setupProcessManagerEvents() {
  processManager.on('exit', (agentName: string, code: number | null, signal: string | null) => {
    if (agentName !== AGENT_NAME) return
    log('Claude CLI process exited (code: %s, signal: %s)', code, signal)
    processAlive = false
    agentBusy = false

    broadcastNotification('agent_error', {
      error: `Agent process exited (code: ${code}, signal: ${signal})`,
    })

    void updateSpecialist(PROJECT_PATH, AGENT_NAME, {
      status: 'crashed',
      lastActivity: new Date().toISOString(),
    } as Partial<SpecialistStatus>).catch(() => {})

    // If not shutting down, this is a crash — exit the wrapper too
    if (!shuttingDown) {
      log('Agent process crashed — wrapper will exit')
      void cleanup().then(() => process.exit(1))
    }
  })

  processManager.on('error', (agentName: string, err: Error) => {
    if (agentName !== AGENT_NAME) return
    log('Claude CLI process error: %s', err.message)
    processAlive = false
    agentBusy = false

    broadcastNotification('agent_error', {
      error: `Agent process error: ${err.message}`,
    })

    void updateSpecialist(PROJECT_PATH, AGENT_NAME, {
      status: 'crashed',
      lastActivity: new Date().toISOString(),
    } as Partial<SpecialistStatus>).catch(() => {})
  })

  processManager.on('stderr', (_agentName: string, data: string) => {
    // Forward stderr output for debugging (write to wrapper's stderr)
    if (data.trim()) {
      log('CLI stderr: %s', data.trim())
    }
  })
}

async function cleanup() {
  log('Cleaning up...')

  // Stop heartbeat
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId)
    heartbeatIntervalId = null
  }

  // Close all socket clients
  for (const client of connectedClients) {
    try {
      client.destroy()
    } catch {
      // ignore
    }
  }
  connectedClients.clear()

  // Close socket server
  if (socketServer) {
    socketServer.close()
    socketServer = null
  }

  // Remove socket file
  try {
    if (existsSync(SOCKET_PATH)) {
      unlinkSync(SOCKET_PATH)
    }
  } catch {
    // ignore
  }

  // Update status
  try {
    await updateSpecialist(PROJECT_PATH, AGENT_NAME, {
      status: 'stopped',
      lastActivity: new Date().toISOString(),
    } as Partial<SpecialistStatus>)
  } catch {
    // ignore
  }

  log('Cleanup complete')
}

async function gracefulShutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  log('Graceful shutdown initiated (reason: %s)', reason)

  // Stop agent process
  if (processAlive) {
    try {
      await processManager.stop(AGENT_NAME)
    } catch {
      // ignore
    }
    processAlive = false
  }

  await cleanup()
  process.exit(0)
}

function setupSignalHandlers() {
  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'))

  process.on('uncaughtException', (err) => {
    log('Uncaught exception: %s', err.message)
    void gracefulShutdown('uncaughtException')
  })

  process.on('unhandledRejection', (reason) => {
    log('Unhandled rejection: %s', reason)
    // Don't exit for unhandled rejections, just log
  })
}

// ---------------------------------------------------------------------------
// Part 5: Initialize message watermarks from DB
// ---------------------------------------------------------------------------

async function initializeWatermarks() {
  const pool = getPool()

  try {
    const channelResult = await pool.query<{ max_id: number }>(
      `SELECT COALESCE(MAX(cm.id), 0)::int AS max_id
       FROM specialist_channel_messages cm
       JOIN specialist_channels c ON c.id = cm.channel_id
       JOIN specialist_channel_members mem ON mem.channel_id = c.id
       WHERE mem.agent_name = $1`,
      [AGENT_NAME],
    )
    lastChannelMsgId = channelResult.rows[0]?.max_id ?? 0

    const inboxResult = await pool.query<{ max_id: number }>(
      `SELECT COALESCE(MAX(id), 0)::int AS max_id
       FROM specialist_inbox
       WHERE to_agent = $1`,
      [AGENT_NAME],
    )
    lastInboxMsgId = inboxResult.rows[0]?.max_id ?? 0

    log('Watermarks initialized (channel: %d, inbox: %d)', lastChannelMsgId, lastInboxMsgId)
  } catch (err) {
    log('Warning: Could not initialize watermarks from DB: %s', err)
    // Start from 0 — will pick up all messages, which is ok for a fresh start
  }
}

// ---------------------------------------------------------------------------
// Part 6: Startup
// ---------------------------------------------------------------------------

function validateEnv() {
  const required = [
    'SYNAPSE_AGENT_NAME',
    'SYNAPSE_AGENT_MODEL',
    'SYNAPSE_PROJECT_PATH',
    'SYNAPSE_SOCKET_PATH',
    'SYNAPSE_SYSTEM_PROMPT_FILE',
  ]
  const missing = required.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }
}

async function main() {
  validateEnv()

  log('Starting wrapper...')
  log('  Agent: %s', AGENT_NAME)
  log('  Model: %s', AGENT_MODEL)
  log('  Project: %s', PROJECT_PATH)
  log('  Socket: %s', SOCKET_PATH)
  log('  Poll interval: %dms', POLL_INTERVAL)
  log('  Keep alive: %s', KEEP_ALIVE)
  log('  PID: %d', process.pid)

  // 1. Setup signal handlers early
  setupSignalHandlers()

  // 2. Read system prompt from file
  const systemPrompt = await readFile(SYSTEM_PROMPT_FILE, 'utf-8')
  log('System prompt loaded (%d chars)', systemPrompt.length)

  // 3. Setup ProcessManager event handlers
  setupProcessManagerEvents()

  // 4. Start Claude CLI subprocess
  await startAgentProcess(systemPrompt)

  // 5. Start Unix Socket server
  await startSocketServer()

  // 6. Initialize watermarks from DB
  await initializeWatermarks()

  // 7. Start heartbeat polling
  heartbeatIntervalId = setInterval(() => void heartbeatPoll(), POLL_INTERVAL)
  log('Heartbeat started (interval: %dms)', POLL_INTERVAL)

  // 8. Update status file: running
  await updateSpecialist(PROJECT_PATH, AGENT_NAME, {
    status: 'running',
    model: AGENT_MODEL,
    wrapperPid: process.pid,
    socket: SOCKET_PATH,
    tokens: { input: 0, output: 0, percent: 0 },
    contextCeiling: getContextCeiling(),
    lastActivity: lastActivityTs,
  } as Partial<SpecialistStatus>)

  log('Wrapper fully started and ready')
}

main().catch((err) => {
  log('Fatal: %s', err)
  void cleanup().then(() => process.exit(1))
})
