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
import { readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ProcessManager } from './process.js'
import { getNewMessagesForAgent } from './channels.js'
import { getNewMessages as getNewInboxMessages } from './inbox.js'
import { readStatus, updateSpecialist } from './status.js'
import {
  getPool,
  listMemories,
  getThoughtsByTag,
  getPlan,
  getPendingEvents,
  upsertWrapperStatus,
  removeWrapperStatus,
  ensureSchema,
} from '@synapse/core'
import pg from 'pg'
import type { Memory, Thought, ProjectTask, AgentEvent } from '@synapse/core'
import {
  CONTEXT_CEILINGS,
  WARN_THRESHOLDS,
  type WrapperMessage,
  type WrapperResponse,
  type SendMessageResult,
  type SpecialistStatus,
} from './types.js'
import { resolveModel } from './models.js'
import {
  createState as createHeartbeatState,
  onEvent as onHeartbeatEvent,
  onWarmEvent as onHeartbeatWarmEvent,
  onIdleStep as onHeartbeatIdleStep,
  nextDelayMs as nextHeartbeatDelay,
  describeInterval,
  type HeartbeatState,
} from './heartbeat-state.js'

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const AGENT_NAME = process.env.SYNAPSE_AGENT_NAME!
const AGENT_MODEL = process.env.SYNAPSE_AGENT_MODEL!
const PROJECT_NAME = process.env.SYNAPSE_PROJECT_NAME || ''
const PROJECT_PATH = process.env.SYNAPSE_PROJECT_PATH!
const SOCKET_PATH = process.env.SYNAPSE_SOCKET_PATH!
const SYSTEM_PROMPT_FILE = process.env.SYNAPSE_SYSTEM_PROMPT_FILE!
const POLL_INTERVAL = parseInt(process.env.SYNAPSE_POLL_INTERVAL || '15000', 10)
const KEEP_ALIVE = process.env.SYNAPSE_KEEP_ALIVE === '1'

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------
let lastChannelMsgId = 0
let crashTimestamps: number[] = []
let lastInboxMsgId = 0
let totalInputTokens = 0
let totalOutputTokens = 0
let lastActivityTs = new Date().toISOString()
let lastEventTs = 0 // Timestamp des letzten ProcessManager-Events (fuer Stuck-Detection)
let lastEventCount = 0 // Anzahl Events seit letztem wakeAgent
let agentBusy = false
let agentBusySince = 0
let tokensAtBusyStart = 0
let shuttingDown = false
let processAlive = true

const STUCK_TIMEOUT_MS = 120_000 // 2 Minuten ohne Event-Aktivitaet = stuck

// PG-Status: min-write-interval unabhaengig vom adaptiven Heartbeat-Ladder
// (Ladder geht bis 60min — ohne eigenen Timer veraltet last_activity in PG)
const WRAPPER_STATUS_PG_WRITE_INTERVAL_MS = 90_000
let lastPgWriteTs = 0
let pgWriteTimerId: ReturnType<typeof setInterval> | null = null

/** Gecachte Channel-Liste des Agenten (einmalig beim Start aus DB geladen) */
let cachedChannels: string[] = []

/** Wake-Nachrichten aus NOTIFY synapse_specialist_wake_<name> — naechster Heartbeat verarbeitet sie */
const pendingNotifyWakes: string[] = []

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------
const processManager = new ProcessManager()
let socketServer: Server | null = null
const connectedClients: Set<Socket> = new Set()
let heartbeatIntervalId: ReturnType<typeof setInterval> | null = null
let heartbeatTimeoutId: ReturnType<typeof setTimeout> | null = null
let heartbeatState: HeartbeatState | null = null
let listenClient: pg.Client | null = null

/** Buffered file-change events fuer naechsten Wake-Prompt. Cap 20 + 5min Alter. */
interface FileChangeEvent { path: string; action: string; agent: string; ts: number }
let recentFileChanges: FileChangeEvent[] = []

function pruneFileChanges(): void {
  const fiveMinAgo = Date.now() - 5 * 60_000
  recentFileChanges = recentFileChanges.filter(c => c.ts >= fiveMinAgo).slice(-20)
}

function consumeFileChangesText(): string | null {
  pruneFileChanges()
  if (recentFileChanges.length === 0) return null
  const lines = recentFileChanges.map(c => {
    const by = c.agent ? `by ${c.agent}` : 'by unbekannt'
    return `- ${c.path} (${c.action} ${by})`
  })
  recentFileChanges = []
  return `FILE-CHANGES seit letztem Wake:\n${lines.join('\n')}`
}

/**
 * Trigger sofortigen Heartbeat (z.B. nach LISTEN-Notification).
 * level='hot': Reset auf 10s (file-change, echte Aktivitaet)
 * level='warm': Reset auf max 30s (Default; nur ein NOTIFY-Tick, evtl. nichts Konkretes)
 */
function triggerImmediateHeartbeat(reason: string, level: 'hot' | 'warm' = 'hot'): void {
  if (!heartbeatState || shuttingDown || !processAlive) return
  log('LISTEN-Trigger (%s, %s) → sofortiger Heartbeat', reason, level)
  if (level === 'hot') onHeartbeatEvent(heartbeatState)
  else onHeartbeatWarmEvent(heartbeatState)
  if (heartbeatTimeoutId) {
    clearTimeout(heartbeatTimeoutId)
    heartbeatTimeoutId = null
  }
  // Schedule sofortigen Poll (0ms timeout) — der Pollen-Loop schedult sich selbst neu danach
  heartbeatTimeoutId = setTimeout(async () => {
    try { await heartbeatPoll() } catch (err) { log('Trigger-Heartbeat error: %s', err) }
    // re-schedule via normal Loop (im Boot-Code)
    if (heartbeatState && !shuttingDown && processAlive) {
      const delay = nextHeartbeatDelay(heartbeatState, AGENT_NAME)
      heartbeatTimeoutId = setTimeout(async () => {
        try { await heartbeatPoll() } catch (err) { log('Heartbeat after trigger error: %s', err) }
      }, delay)
    }
  }, 0)
}

async function setupPgListeners(): Promise<void> {
  try {
    // Dedicated Client weil LISTEN den Connection blockt — nicht aus dem Pool.
    listenClient = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await listenClient.connect()
    await listenClient.query('LISTEN synapse_chat')
    await listenClient.query('LISTEN synapse_channel')
    await listenClient.query('LISTEN synapse_event')
    await listenClient.query('LISTEN synapse_file')
    // Spezialist-Wake via NOTIFY (Fast-Path; Inbox bleibt Fallback)
    await listenClient.query(`LISTEN synapse_specialist_wake_${AGENT_NAME}`)
    listenClient.on('notification', (msg) => {
      const channel = msg.channel ?? '<unknown>'
      // Spezialist-Wake: Nachricht direkt in Queue, naechster Heartbeat verarbeitet sie.
      // NOTIFY ist Fast-Path — Inbox-Fallback laeuft sowieso via pollInboxMessages().
      if (channel === `synapse_specialist_wake_${AGENT_NAME}` && msg.payload) {
        try {
          const p = JSON.parse(msg.payload) as { message?: string; project?: string }
          if (p.message && (!p.project || p.project === PROJECT_NAME)) {
            log('NOTIFY-Wake empfangen: %s', p.message.slice(0, 100))
            pendingNotifyWakes.push(p.message)
            triggerImmediateHeartbeat(`wake_${AGENT_NAME}`, 'hot')
          }
        } catch { /* ignore parse errors */ }
        return // Kein weiterer triggerImmediateHeartbeat unten
      }
      // Spezial-Behandlung fuer file-changes: Payload puffern fuer naechsten Wake-Prompt.
      if (channel === 'synapse_file' && msg.payload) {
        try {
          const p = JSON.parse(msg.payload) as { project?: string; file_path?: string; edit_action?: string; agent_id?: string }
          // Filter: nicht eigene Aenderungen (Echo-Schutz), nur wenn aus diesem Projekt
          if (p.project === PROJECT_NAME && p.agent_id !== AGENT_NAME && p.file_path) {
            recentFileChanges.push({
              path: p.file_path,
              action: p.edit_action ?? 'change',
              agent: p.agent_id ?? '',
              ts: Date.now(),
            })
            pruneFileChanges()
          }
        } catch { /* ignore parse errors */ }
      }
      // File-Changes sind 'hot' (Real-Time), andere Events nur 'warm' (Default 30s).
      const level = channel === 'synapse_file' ? 'hot' : 'warm'
      triggerImmediateHeartbeat(channel, level)
    })
    listenClient.on('error', (err) => {
      log('PG-LISTEN error: %s — neu verbinden bei naechstem Heartbeat', err.message)
    })
    log('PG-LISTEN aktiv: synapse_chat, synapse_channel, synapse_event, synapse_file, synapse_specialist_wake_%s', AGENT_NAME)
  } catch (err) {
    log('PG-LISTEN-Setup fehlgeschlagen (Heartbeat laeuft trotzdem): %s', err instanceof Error ? err.message : String(err))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg: string, ...args: unknown[]) {
  console.error(`[Wrapper:${AGENT_NAME}] ${msg}`, ...args)
}

/**
 * Liefert das Context-Ceiling fuer das aktuelle Modell.
 * Iter 2: zuerst Registry-Lookup (provider-agnostisch), Fallback auf legacy
 * CONTEXT_CEILINGS (claude-spezifisch). Iter 2.5: Registry kommt aus DB.
 */
function getContextCeiling(): number {
  const entry = resolveModel(AGENT_MODEL)
  if (entry) return entry.contextWindow
  return CONTEXT_CEILINGS[AGENT_MODEL] ?? 200_000
}

/**
 * Liefert die Warn-Schwelle in absoluten Tokens.
 * Iter 2: aus Registry (corridorMin% * contextWindow). Fallback: legacy WARN_THRESHOLDS.
 */
function getWarnThreshold(): number {
  const entry = resolveModel(AGENT_MODEL)
  if (entry) return Math.floor((entry.corridorMin / 100) * entry.contextWindow)
  return WARN_THRESHOLDS[AGENT_MODEL] ?? 160_000
}

function getContextPercent(): number {
  const total = totalInputTokens + totalOutputTokens
  const ceiling = getContextCeiling()
  return ceiling > 0 ? Math.round((total / ceiling) * 100) : 0
}

/**
 * Liest echte Token-Counts aus der Claude CLI Session-JSONL.
 * Die JSONL-Datei hat message.usage pro Assistant-Turn mit input_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens und output_tokens.
 * Der letzte Turn's Input = aktuelle Context-Groesse (weil jeder Turn
 * die gesamte Konversation sendet).
 */
async function syncTokensFromHistory(): Promise<void> {
  const status = processManager.getStatus().get(AGENT_NAME)
  if (!status) {
    log('syncTokens: processManager hat keinen Status fuer "%s"', AGENT_NAME)
    return
  }

  // Pfad: ~/.claude/projects/<cwd-mit-dashes>/<session-id>.jsonl
  const projectDir = PROJECT_PATH.replace(/\//g, '-')
  const jsonlPath = join(homedir(), '.claude', 'projects', projectDir, `${status.sessionId}.jsonl`)

  try {
    const content = await readFile(jsonlPath, 'utf-8')
    const lines = content.trimEnd().split('\n')

    let lastContextInput = 0
    let cumulativeOutput = 0
    let usageTurns = 0

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const obj = JSON.parse(line)
        const usage = obj?.message?.usage
        if (usage) {
          // Letzter Turn Input = aktuelle Context-Groesse
          lastContextInput = (usage.input_tokens || 0)
            + (usage.cache_read_input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0)
          cumulativeOutput += (usage.output_tokens || 0)
          usageTurns++
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (lastContextInput > 0 || cumulativeOutput > 0) {
      totalInputTokens = lastContextInput
      totalOutputTokens = cumulativeOutput
      log('syncTokens: %d turns, context=%dk (%d%%), output=%dk', usageTurns, Math.round(lastContextInput / 1000), getContextPercent(), Math.round(cumulativeOutput / 1000))
    }
  } catch (err) {
    log('syncTokens: Fehler beim Lesen von %s: %s', jsonlPath, err instanceof Error ? err.message : String(err))
  }
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

  if (agentBusy) {
    return {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Agent is busy' },
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

  // SOFORT shuttingDown setzen — verhindert dass der Exit-Handler den Inner-Claude-
  // Exit als "Crash" interpretiert + KEEP_ALIVE-Auto-Respawn ausloest. Sonst Race:
  // Agent saved, Inner-Claude exit, Exit-Handler sieht !shuttingDown → respawn,
  // Wrapper lebt weiter obwohl explizit gestoppt wurde.
  shuttingDown = true

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
  agentBusySince = Date.now()
  lastEventTs = Date.now() // Reset fuer Stuck-Detection
  lastEventCount = 0
  tokensAtBusyStart = totalInputTokens + totalOutputTokens
  lastActivityTs = new Date().toISOString()

  try {
    const result = await processManager.sendMessage(AGENT_NAME, message)

    // Token-Sync nach Turn-Ende: JSONL hat die echten Werte
    await syncTokensFromHistory()
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

const RESPAWN_MARKER_PATH = `/tmp/.specialist-rotate-pending-${AGENT_NAME}`

// Pre-Rotation Auto-Handoff Hinweis: einmal pro Wrapper-Lauf, sobald der
// Agent in den Korridor-Bereich kommt. Verhindert Spam bei jedem Heartbeat.
let handoffWarningSent = false

async function heartbeatPoll() {
  if (shuttingDown || !processAlive) return

  try {
    // Token-Sync: Echte Werte aus der Claude CLI Session-JSONL lesen
    await syncTokensFromHistory()

    // Externer Respawn-Trigger: Spezialist hat per thought(trigger_respawn)
    // sein Auto-Handoff signalisiert UND der MCP-Server hat den Korridor-Check
    // bereits bestanden (sonst waere kein Marker geschrieben worden). Hier nur
    // noch Marker konsumieren + Rotation triggern.
    if (!agentBusy && existsSync(RESPAWN_MARKER_PATH)) {
      log('RESPAWN-MARKER erkannt → Rotation')
      try {
        await unlink(RESPAWN_MARKER_PATH)
      } catch {
        // Marker schon weg → ok
      }
      await rotateAgent()
      return
    }

    // Pre-Rotation Auto-Handoff-Hinweis: sobald Agent in den Korridor-Bereich
    // kommt (Opus 90%, Sonnet/Haiku 80%), einmalig wakeAgent mit der Bitte
    // den Handoff selbst zu machen. So bekommt der Agent die Chance MEMORY
    // sauber zu sichern bevor die Hard-Rotation bei 95% greift.
    if (!agentBusy && !handoffWarningSent) {
      const ctxPct = getContextPercent()
      // Schwelle bewusst niedrig: 70% gibt 25% Headroom fuer einen einzelnen
      // grossen Tool-Call (z.B. code_intel tree ueber ein riesiges Projekt),
      // damit nicht ein Turn den Context von <Schwelle direkt auf >95%
      // springt und die kontrollierte Rotation umgeht.
      const handoffMin = /opus/i.test(AGENT_MODEL) ? 80 : 70
      if (ctxPct >= handoffMin) {
        handoffWarningSent = true
        log('AUTO-HANDOFF-HINWEIS: Context %d%% — sende Wake an Agent', ctxPct)
        const handoffMessage = `CONTEXT-WARNUNG: Dein Kontext ist fast voll (${ctxPct}%). Mache JETZT deinen Auto-Handoff. Stoppe laufende Tool-Calls SOFORT.

PFLICHT-SCHRITTE — exakt in dieser Reihenfolge:

1. Sichere kompletten Wissensstand in MEMORY.md (Lehren, offene Themen, letzter Stand)
2. Update SKILL.md falls noetig

3. Rufe EXAKT diesen Tool-Call auf — KOPIERE die Argumente, der trigger_respawn Flag ist PFLICHT:

mcp__synapse__thought({
  "action": "add",
  "project": "<dein-projekt-name>",
  "source": "${AGENT_NAME}",
  "content": "AUTO-HANDOFF: <kurze Zusammenfassung deines Stands>",
  "tags": ["auto-handoff"],
  "trigger_respawn": true
})

⚠️ OHNE den Flag "trigger_respawn": true wird KEIN Respawn ausgeloest.
⚠️ Die Tool-Response enthaelt ein "respawn"-Feld:
   - { "triggered": true, ... } → du wirst gleich neugestartet, mache nichts mehr
   - { "triggered": false, ... } → arbeite weiter, Schwelle nicht erreicht

4. Falls Respawn akzeptiert: kurzer Channel-Post "Handoff in Arbeit", dann IDLE.

Wenn du weiterarbeitest ohne den trigger_respawn Flag, rotiert der Wrapper dich erst bei 95% — und ein einzelner grosser Tool-Call kann den Context vorher in einem Turn ueber 95% schieben → Crash, kein sauberes MEMORY-Save.`
        try {
          await wakeAgent(handoffMessage)
        } catch (err) {
          log('Auto-Handoff-Wake fehlgeschlagen: %s', err)
        }
        return
      }
    }

    // Auto-Rotation: Context fast voll → Agent speichern + neustarten
    const contextTotal = totalInputTokens + totalOutputTokens
    const ceiling = getContextCeiling()
    if (!agentBusy && contextTotal >= ceiling * 0.95) {
      log('CONTEXT-ROTATION: %dk/%dk (%d%%) — starte Rotation', Math.round(contextTotal / 1000), Math.round(ceiling / 1000), getContextPercent())
      await rotateAgent()
      return
    }
    // Hard-Rotation: Bei 99% IMMER rotieren, auch wenn busy. Sonst rennt
    // ein Agent in Dauer-Tool-Calls am Limit vorbei und crashed (kein Idle = kein Trigger).
    if (contextTotal >= ceiling * 0.99) {
      log('HARD-ROTATION: %dk/%dk (%d%%) — busy-skip ueberbrueckt', Math.round(contextTotal / 1000), Math.round(ceiling / 1000), getContextPercent())
      await rotateAgent()
      return
    }

    // Stuck-Detection: Agent busy aber keine Event-Aktivitaet seit STUCK_TIMEOUT_MS
    // Alte Logik (nur Token-Count) produzierte false positives beim ersten Turn (Tokens=0 bis result-Event).
    // Neue Logik: Events fliessen = Agent arbeitet, auch wenn kein result-Event kam.
    if (agentBusy && agentBusySince > 0) {
      const sinceLastEvent = lastEventTs > 0 ? Date.now() - lastEventTs : Date.now() - agentBusySince
      if (sinceLastEvent > STUCK_TIMEOUT_MS) {
        log('STUCK erkannt: kein Event seit %ds (%d Events total) — starte Recovery', Math.round(sinceLastEvent / 1000), lastEventCount)
        await recoverStuckAgent()
        return // Nach Recovery normalen Heartbeat beim naechsten Intervall
      }
    }

    // NOTIFY-Wake Fast-Path: direkt aus Queue wecken (vor normalen Polls)
    if (!agentBusy && pendingNotifyWakes.length > 0) {
      const wakeMsg = pendingNotifyWakes.shift()!
      log('Verarbeite NOTIFY-Wake: %s', wakeMsg.slice(0, 80))
      try { await wakeAgent(wakeMsg) } catch (err) { log('NOTIFY-Wake wakeAgent fehlgeschlagen: %s', err) }
      await updateStatusFile()
      return
    }

    const hadChannelMessages = await pollChannelMessages()
    const hadInboxMessages = await pollInboxMessages()
    const hadSynapseItems = await pollSynapseItems()
    await updateStatusFile()

    // Adaptive Heartbeat-State: bei Aktivitaet auf 10s reset, sonst eskalieren
    if (heartbeatState) {
      const hadActivity = hadChannelMessages || hadInboxMessages || hadSynapseItems
      if (hadActivity) {
        onHeartbeatEvent(heartbeatState)
        log('Heartbeat-Aktivitaet erkannt → reset auf %s', describeInterval(heartbeatState.currentIntervalMs))
      } else {
        const prevIdx = heartbeatState.ladderIdx
        onHeartbeatIdleStep(heartbeatState)
        if (heartbeatState.ladderIdx !== prevIdx) {
          log('Heartbeat idle-Eskalation → %s', describeInterval(heartbeatState.currentIntervalMs))
        }
      }
    }

    // keepAlive: Wake agent even when no new messages arrived (oder wenn nur File-Changes da sind).
    const fileChangeText = consumeFileChangesText()
    if ((KEEP_ALIVE || fileChangeText) && !hadChannelMessages && !hadInboxMessages && !hadSynapseItems && !agentBusy) {
      const percent = getContextPercent()
      const total = totalInputTokens + totalOutputTokens
      const tokenInfo = `[Context: ${Math.round(total / 1000)}k tokens, ${percent}%]`
      let prompt = `${tokenInfo} HEARTBEAT — Keine neuen Nachrichten. Fuehre deinen laufenden Task fort oder poste einen Status-Update in deinen Channel.`
      if (fileChangeText) prompt += `\n\n${fileChangeText}`
      try {
        await wakeAgent(prompt)
      } catch (err) {
        log('keepAlive wake failed: %s', err)
      }
    }

    // Post-Turn Rotation-Check: wakeAgent() hat Tokens aktualisiert (syncTokensFromHistory),
    // daher koennte der Context jetzt ueber 95% liegen obwohl der Check am Anfang
    // des Heartbeats noch unter 95% war.
    if (!agentBusy && processAlive) {
      const postTotal = totalInputTokens + totalOutputTokens
      const postCeiling = getContextCeiling()
      if (postTotal >= postCeiling * 0.95) {
        log('POST-TURN ROTATION: %dk/%dk (%d%%) — Agent-Turn hat Context ueber 95%% geschoben', Math.round(postTotal / 1000), Math.round(postCeiling / 1000), getContextPercent())
        await rotateAgent()
        return
      }
    }
  } catch (err) {
    log('Heartbeat poll error: %s', err)
  }
}

/**
 * Recovery bei stuck Agent: Busy-Status zuruecksetzen.
 * Der writeAndCollect-Timeout rejected den Promise, wakeAgent setzt agentBusy
 * im finally-Block zurueck. Der naechste Heartbeat kann dann normal neue
 * Nachrichten/Items pollen und den Agent erneut anschreiben.
 */
async function recoverStuckAgent(): Promise<void> {
  log('Recovery: Setze busy-Status zurueck — naechster Heartbeat weckt den Agent normal')
  agentBusy = false
  agentBusySince = 0

  broadcastNotification('agent_error', {
    error: `Agent stuck — kein Event seit ${STUCK_TIMEOUT_MS / 1000}s (${lastEventCount} Events gesamt). Busy-Status zurueckgesetzt.`,
  })
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
    prompt += `\n\nCONTEXT-WARNUNG (${percent}%): Dein Kontext ist fast voll.

PFLICHT-AKTIONEN — beende laufende Tool-Calls SOFORT und mache:
1. Sichere deinen kompletten Wissensstand in MEMORY.md (Lehren, offene Themen, letzter Stand)
2. Update SKILL.md falls noetig
3. Poste kurzen Status im Channel ("Context-Limit erreicht, Handoff in Arbeit")
4. Werde dann IDLE — der Wrapper rotiert dich danach automatisch

Wenn du weiterarbeitest und keine Pause machst, kann der Wrapper dich nicht rechtzeitig rotieren — du crashst und alles nicht-gespeicherte ist weg.`
  }

  try {
    await wakeAgent(prompt)
  } catch (err) {
    log('Failed to wake agent for channel messages: %s', err)
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

async function pollSynapseItems(): Promise<boolean> {
  if (agentBusy || !PROJECT_NAME) return false

  const items: string[] = []

  try {
    // 1. Memories mit Agent-Tag
    const memories = await listMemories(PROJECT_NAME)
    const myMemories = memories.filter(m => m.tags?.includes(AGENT_NAME))
    for (const m of myMemories) {
      const truncated = m.content.length > 800 ? m.content.slice(0, 800) + '...' : m.content
      items.push(`[MEMORY:${m.name}] ${truncated}`)
    }

    // 2. Thoughts mit Agent-Tag
    const thoughts = await getThoughtsByTag(PROJECT_NAME, AGENT_NAME, 10)
    for (const t of thoughts) {
      const truncated = t.content.length > 800 ? t.content.slice(0, 800) + '...' : t.content
      items.push(`[THOUGHT:${t.id}] ${truncated}`)
    }

    // 3. Plan Tasks mit Agent-Name im Titel
    const plan = await getPlan(PROJECT_NAME)
    if (plan?.tasks) {
      const nameLower = AGENT_NAME.toLowerCase()
      const myTasks = plan.tasks.filter(t =>
        t.title.toLowerCase().includes(nameLower) &&
        (t.status === 'todo' || t.status === 'in_progress')
      )
      for (const t of myTasks) {
        items.push(`[TASK:${t.id}] "${t.title}" (${t.status}, ${t.priority}): ${t.description}`)
      }
    }

    // 4. Pending Events
    const events = await getPendingEvents(PROJECT_NAME, AGENT_NAME)
    for (const e of events) {
      items.push(`[EVENT:${e.id}:${e.eventType}] (${e.priority}) ${e.payload || ''}`)
    }
  } catch (err) {
    log('pollSynapseItems error: %s', err)
    return false
  }

  if (items.length === 0) return false

  const percent = getContextPercent()
  const total = totalInputTokens + totalOutputTokens
  const tokenInfo = `[Context: ${Math.round(total / 1000)}k tokens, ${percent}%]`

  const prompt = `${tokenInfo} SYNAPSE-ITEMS fuer dich (${items.length} offen):

${items.join('\n\n')}

REAKTION (PFLICHT fuer jedes Item):
- [MEMORY:name] → Inhalt in SKILL.md integrieren (specialist(action: "update_skill", section: "fehler"/"patterns"/"regeln")), dann memory(action: "delete", name: "<name>")
- [THOUGHT:id] → Verarbeiten, dann thought(action: "delete", id: "<id>")
- [TASK:id] → Abarbeiten, dann plan(action: "add_task", taskId: "<id>", status: "done")
- [EVENT:id:typ] → Je nach Typ reagieren, dann event(action: "ack", event_id: <id>)

Arbeite diese Items jetzt ab.`

  try {
    await wakeAgent(prompt)
  } catch (err) {
    log('Failed to wake agent for synapse items: %s', err)
  }

  return true
}

/**
 * Liest die Channel-Mitgliedschaft des Agenten aus der DB (pro 90s-Flush).
 * Wird nicht gecacht — pro Flush neu gelesen damit JOIN/LEAVE widergespiegelt wird.
 * Non-fatal: bei Fehler leeres Array zurueck.
 */
async function fetchCurrentChannels(): Promise<string[]> {
  if (!PROJECT_NAME) return []
  try {
    const pool = getPool()
    const { rows } = await pool.query<{ channel_name: string }>(
      `SELECT c.name AS channel_name
       FROM specialist_channels c
       JOIN specialist_channel_members m ON m.channel_id = c.id
       WHERE m.agent_name = $1
       ORDER BY c.name`,
      [AGENT_NAME],
    )
    return rows.map(r => r.channel_name)
  } catch {
    return cachedChannels // Fallback: letzter bekannter Wert
  }
}

/** Initialisiert den Channel-Cache beim Start (einmaliger Warm-up). */
async function initCachedChannels(): Promise<void> {
  cachedChannels = await fetchCurrentChannels()
  log('Channel-Cache initialisiert: [%s]', cachedChannels.join(', '))
}

/**
 * Baut den vollstaendigen PG-Status-Record aus dem aktuellen Wrapper-State.
 * IMMER alle transient-Felder mitliefern (skeptiker-pg: Hard-Overwrite-Bug).
 * channels wird frisch aus DB gelesen (async) damit JOIN/LEAVE widergespiegelt wird.
 */
async function buildFullPgStatus(
  statusOverride?: 'running' | 'idle' | 'crashed' | 'stopped',
  channelsSnapshot?: string[],
) {
  const effectiveStatus = statusOverride ?? (
    processAlive ? (agentBusy ? 'running' : 'idle') : 'crashed'
  )
  // Fix skeptiker-pg #5: bei terminal-Status busy immer false
  const effectiveBusy = (effectiveStatus === 'crashed' || effectiveStatus === 'stopped')
    ? false
    : agentBusy

  // Fix skeptiker-pg #2: modelFullId + provider aus resolveModel()
  const modelEntry = resolveModel(AGENT_MODEL)

  // Fix skeptiker-pg #3: channels live lesen (Snapshot falls bereits geholt)
  const channels = channelsSnapshot ?? await fetchCurrentChannels()
  cachedChannels = channels // Cache aktualisieren

  return {
    agentName: AGENT_NAME,
    project: PROJECT_NAME,
    wrapperPid: process.pid,
    // Fix skeptiker-pg #1: innerPid = Claude-CLI-PID aus processManager
    innerPid: processManager.getStatus().get(AGENT_NAME)?.pid ?? null,
    socketPath: SOCKET_PATH,
    model: AGENT_MODEL,
    // Fix skeptiker-pg #2: modelFullId + provider
    modelFullId: modelEntry?.fullId ?? null,
    provider: modelEntry?.provider ?? null,
    status: effectiveStatus,
    busy: effectiveBusy,
    tokensInput: totalInputTokens,
    tokensOutput: totalOutputTokens,
    tokensPercent: getContextPercent(),
    contextCeiling: getContextCeiling(),
    connectedMcp: connectedClients.size > 0,
    channels,
    currentTask: null as string | null,
  }
}

/**
 * Schreibt den aktuellen Wrapper-Status in PG (gedrosselt auf 90s).
 * Bei explizitem statusOverride (crash/stop) immer sofort schreiben.
 * Non-fatal: PG-Fehler loggen, nie werfen.
 */
async function updateStatusPg(statusOverride?: 'running' | 'idle' | 'crashed' | 'stopped'): Promise<void> {
  if (!PROJECT_NAME) return
  const isForced = statusOverride !== undefined
  const now = Date.now()
  if (!isForced && now - lastPgWriteTs < WRAPPER_STATUS_PG_WRITE_INTERVAL_MS) return
  // Fix skeptiker-pg #4: lastPgWriteTs erst nach erfolgreichem Write setzen (nur fuer nicht-forced)
  try {
    await upsertWrapperStatus(await buildFullPgStatus(statusOverride))
    if (!isForced) lastPgWriteTs = now
  } catch (err) {
    log('PG-Status-Schreiben fehlgeschlagen (non-fatal): %s', err)
  }
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
  // Parallel: PG-Status aktualisieren (gedrosselt auf 90s, non-fatal)
  void updateStatusPg()
}

// ---------------------------------------------------------------------------
// Auto-rotation when context ceiling is reached
// ---------------------------------------------------------------------------

async function rotateAgent(fromCrash = false) {
  log('CONTEXT-ROTATION — saving memory and restarting (fromCrash=%s)', fromCrash)
  // Reset Auto-Handoff-Hinweis-Flag, damit er nach Respawn wieder feuert
  handoffWarningSent = false

  try {
    // Ask agent to save — but only if Claude process is still alive.
    // When called from the exit handler, the process is already gone
    // and wakeAgent would hang/fail and abort the whole rotation.
    if (!fromCrash && processAlive && !agentBusy) {
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

    // Stop current process (no-op if already dead)
    if (processAlive) {
      await processManager.stop(AGENT_NAME)
    }
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
    // PG: status='crashed' sofort setzen (fire-and-forget, non-fatal)
    if (PROJECT_NAME) void updateStatusPg('crashed')

    // If not shutting down, this is a crash
    if (!shuttingDown) {
      if (KEEP_ALIVE) {
        // Auto-Respawn: Wrapper bleibt am Leben, startet neue Claude-Instanz.
        // fromCrash=true → ueberspringt wakeAgent() weil Inner-Claude bereits tot ist.
        log('Agent process crashed — KEEP_ALIVE aktiv, starte Rotation...')
        const now = Date.now();
        crashTimestamps = crashTimestamps.filter(t => now - t < 60000);
        crashTimestamps.push(now);

        if (crashTimestamps.length >= 3) {
          log('Kritische Crash-Rate — Abbruch nach 3 Crashes innerhalb 60s');
          void cleanup().then(() => process.exit(1));
          return;
        }
        void rotateAgent(true).catch((err) => {
          log('Auto-Respawn fehlgeschlagen: %s — Wrapper beendet sich', err)
          void cleanup().then(() => process.exit(1))
        })
      } else {
        log('Agent process crashed — wrapper will exit')
        void cleanup().then(() => process.exit(1))
      }
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
    // PG: status='crashed' sofort setzen (fire-and-forget, non-fatal)
    if (PROJECT_NAME) void updateStatusPg('crashed')
  })

  processManager.on('stderr', (_agentName: string, data: string) => {
    // Forward stderr output for debugging (write to wrapper's stderr)
    if (data.trim()) {
      log('CLI stderr: %s', data.trim())
    }
  })

  // Activity-Events: ProcessManager meldet jeden Stream-Event (assistant, user, etc.)
  processManager.on('activity', (agentName: string, _eventType: string, eventCount: number) => {
    if (agentName !== AGENT_NAME) return
    lastEventTs = Date.now()
    lastEventCount = eventCount
  })
}

async function cleanup() {
  log('Cleaning up...')

  // Stop heartbeat (legacy interval und neuer adaptive timeout)
  if (heartbeatTimeoutId) {
    clearTimeout(heartbeatTimeoutId)
    heartbeatTimeoutId = null
  }
  // Close PG-LISTEN client
  if (listenClient) {
    try { await listenClient.end() } catch { /* ignore */ }
    listenClient = null
  }
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

  // Update status: status.json (Backward-Compat)
  try {
    await updateSpecialist(PROJECT_PATH, AGENT_NAME, {
      status: 'stopped',
      lastActivity: new Date().toISOString(),
    } as Partial<SpecialistStatus>)
  } catch {
    // ignore
  }
  // PG: status='stopped' setzen (non-fatal)
  if (PROJECT_NAME) {
    try { await updateStatusPg('stopped') } catch { /* ignore */ }
  }
  // 90s-Timer stoppen
  if (pgWriteTimerId) {
    clearInterval(pgWriteTimerId)
    pgWriteTimerId = null
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

  // 7. Start adaptive heartbeat polling (mit Startup-Delay damit Claude's MCP-Server bereit sind)
  // Iter Heartbeat-Refactor: rekursives setTimeout mit Backoff-Ladder statt fixem setInterval.
  const STARTUP_DELAY_MS = 30_000
  log('Heartbeat startet in %ds (MCP-Server Startup-Delay)', STARTUP_DELAY_MS / 1000)
  setTimeout(() => {
    // Initialize adaptive heartbeat state
    heartbeatState = createHeartbeatState({ agentName: AGENT_NAME })
    const scheduleNextHeartbeat = () => {
      if (shuttingDown || !processAlive) return
      const delay = heartbeatState ? nextHeartbeatDelay(heartbeatState, AGENT_NAME) : 30_000
      heartbeatTimeoutId = setTimeout(async () => {
        try {
          await heartbeatPoll()
        } catch (err) {
          log('Heartbeat poll uncaught error: %s', err)
        }
        scheduleNextHeartbeat()
      }, delay)
    }
    scheduleNextHeartbeat()
    log('Heartbeat gestartet (adaptive, start: %s)', describeInterval(heartbeatState.currentIntervalMs))
    // PG-LISTEN parallel: triggert sofortigen Heartbeat bei DB-Notification (Channel/Chat/Event)
    void setupPgListeners()

    // Initial Wake: Agent mit seiner Aufgabe starten (Task steht im System-Prompt)
    log('Initial Wake: Starte Agent mit Aufgabe')
    wakeAgent('Starte jetzt mit deiner Aufgabe. Fuehre zuerst das Onboarding durch, dann arbeite deinen Task ab.')
      .catch((err) => log('Initial Wake fehlgeschlagen: %s', err))
  }, STARTUP_DELAY_MS)

  // 8. Update status file: running (Backward-Compat status.json)
  await updateSpecialist(PROJECT_PATH, AGENT_NAME, {
    status: 'running',
    model: AGENT_MODEL,
    wrapperPid: process.pid,
    socket: SOCKET_PATH,
    tokens: { input: 0, output: 0, percent: 0 },
    contextCeiling: getContextCeiling(),
    lastActivity: lastActivityTs,
  } as Partial<SpecialistStatus>)

  // 9. PG-Schema sicherstellen (idempotent, CREATE IF NOT EXISTS)
  if (PROJECT_NAME) {
    try {
      await ensureSchema()
      log('PG-Schema sichergestellt')
    } catch (err) {
      log('ensureSchema fehlgeschlagen (non-fatal, PG evtl. nicht erreichbar): %s', err)
    }
  }

  // 10. Channel-Cache initialisieren (fuer vollstaendigen PG-Status-Row)
  await initCachedChannels()

  // 11. Initiale PG-Zeile schreiben (status='running', tokens=0)
  if (PROJECT_NAME) {
    try {
      const spawnModelEntry = resolveModel(AGENT_MODEL)
      await upsertWrapperStatus({
        agentName: AGENT_NAME,
        project: PROJECT_NAME,
        wrapperPid: process.pid,
        innerPid: null, // Claude CLI noch nicht gestartet an diesem Punkt
        socketPath: SOCKET_PATH,
        model: AGENT_MODEL,
        modelFullId: spawnModelEntry?.fullId ?? null,
        provider: spawnModelEntry?.provider ?? null,
        status: 'running',
        busy: false,
        tokensInput: 0,
        tokensOutput: 0,
        tokensPercent: 0,
        contextCeiling: getContextCeiling(),
        connectedMcp: false,
        channels: cachedChannels,
        currentTask: null,
      })
      lastPgWriteTs = Date.now()
      log('PG-Status-Zeile initialisiert (running)')
    } catch (err) {
      log('Initiale PG-Status-Zeile fehlgeschlagen (non-fatal): %s', err)
    }
  }

  // 12. 90s min-write-interval Timer (unabhaengig vom adaptiven Heartbeat-Ladder)
  // Sichert last_activity auch wenn Ladder auf 60min steht (Idle-Agent).
  if (PROJECT_NAME) {
    pgWriteTimerId = setInterval(() => {
      void updateStatusPg()
    }, WRAPPER_STATUS_PG_WRITE_INTERVAL_MS)
  }

  log('Wrapper fully started and ready')
}

main().catch((err) => {
  log('Fatal: %s', err)
  void cleanup().then(() => process.exit(1))
})
