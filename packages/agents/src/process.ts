import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StreamEvent, SendMessageResult } from './types.js'
import { resolveModel } from './models.js'

interface AgentProcess {
  agentName: string
  model: string
  proc: ChildProcess
  systemPrompt: string
  sessionId: string
  busy: boolean
  stdout: Interface
  messageQueue: Array<{ message: string; resolve: (result: SendMessageResult) => void; reject: (err: Error) => void }>
}

interface StartOptions {
  cwd?: string
  allowedTools?: string[]
  /** Pflicht fuer non-claude Provider (Gemini etc.): Projekt-Pfad fuer Skill-Files */
  projectPath?: string
  /** Pflicht fuer non-claude Provider: Projekt-Name (Synapse-DB-Lookup) */
  projectName?: string
  expertise?: string
  task?: string
}

interface AgentStatus {
  agentName: string
  model: string
  busy: boolean
  pid: number
  sessionId: string
}

class ProcessManager extends EventEmitter {
  private processes = new Map<string, AgentProcess>()

  async start(
    agentName: string,
    model: string,
    systemPrompt: string,
    opts?: StartOptions,
  ): Promise<void> {
    if (this.processes.has(agentName)) {
      throw new Error(`Agent "${agentName}" is already running`)
    }

    const sessionId = randomUUID()

    // Provider-Strategy: Claude CLI vs node-Runtime (Gemini etc.)
    const modelEntry = resolveModel(model)
    const useNodeRuntime = modelEntry?.binary === 'node'

    let proc: ChildProcess

    if (useNodeRuntime && modelEntry) {
      // Non-claude Provider via node-Subprocess (z.B. Gemini)
      // Runtime liest System-Prompt aus File (zu gross fuer ENV)
      const promptFile = join(tmpdir(), `synapse-runtime-prompt-${sessionId}.txt`)
      await writeFile(promptFile, systemPrompt, 'utf-8')

      // Resolve runtime path via require.resolve (robust gegen Workspace-Layout)
      const { createRequire } = await import('node:module')
      const requireFn = createRequire(import.meta.url)
      let runtimePath: string
      try {
        runtimePath = requireFn.resolve(modelEntry.runtimePath ?? '@synapse/agents-gemini/runtime')
      } catch (err) {
        throw new Error(
          `Runtime-Pfad nicht aufloesbar fuer Provider "${modelEntry.provider}" (${modelEntry.runtimePath}): ${err instanceof Error ? err.message : String(err)}. ` +
          `Stelle sicher dass das Runtime-Package gebaut ist (pnpm --filter @synapse/agents-gemini build).`,
        )
      }

      proc = spawn(
        'node',
        [runtimePath],
        {
          env: {
            ...process.env,
            SYNAPSE_WRAPPER_MODE: '1',
            SYNAPSE_AGENT_NAME: agentName,
            SYNAPSE_AGENT_MODEL: model,
            SYNAPSE_PROJECT_PATH: opts?.projectPath ?? opts?.cwd ?? process.cwd(),
            SYNAPSE_PROJECT_NAME: opts?.projectName ?? '',
            SYNAPSE_SYSTEM_PROMPT_FILE: promptFile,
            SYNAPSE_SESSION_ID: sessionId,
            SYNAPSE_AGENT_EXPERTISE: opts?.expertise ?? '',
            SYNAPSE_AGENT_TASK: opts?.task ?? '',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: opts?.cwd ?? process.cwd(),
        },
      )
    } else {
      // Default: Claude CLI
      const args = [
        '--print',
        '--verbose',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        '--model', model,
        '--system-prompt', systemPrompt,
        '--session-id', sessionId,
        '--permission-mode', 'bypassPermissions',
      ]

      if (opts?.allowedTools?.length) {
        for (const tool of opts.allowedTools) {
          args.push('--allowedTools', tool)
        }
      }

      // Werkzeuge des INNEREN Claude ueber eine eigene MCP-Konfiguration
      // (Schritt 3b, auf Bitte von mcp-http). Ohne die Variable aendert sich
      // NICHTS — der heutige stdio-Weg bleibt Zeichen fuer Zeichen gleich.
      // Gesetzt wird sie allein vom Spawner und nur bei
      // SYNAPSE_AGENT_MCP_TRANSPORT=http. Fehlt sie, laeuft der innere Agent
      // weiter ueber die stdio-Konfiguration des Projekts.
      // ⚠️ Nur hier, nicht im node-Zweig: die Gemini-Runtime kennt --mcp-config
      // nicht und wuerde am unbekannten Schalter scheitern.
      if (process.env.SYNAPSE_MCP_CONFIG_FILE) {
        args.push('--mcp-config', process.env.SYNAPSE_MCP_CONFIG_FILE)
        if (process.env.SYNAPSE_MCP_STRICT === '1') args.push('--strict-mcp-config')
      }

      proc = spawn(
        'claude',
        args,
        {
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: opts?.cwd ?? process.cwd(),
        },
      )
    }

    const stdout = createInterface({ input: proc.stdout! })

    const agent: AgentProcess = {
      agentName,
      model,
      proc,
      systemPrompt,
      sessionId,
      busy: false,
      stdout,
      messageQueue: [],
    }

    proc.stderr?.on('data', (data: Buffer) => {
      this.emit('stderr', agentName, data.toString())
    })

    proc.on('exit', (code, signal) => {
      this.processes.delete(agentName)
      this.emit('exit', agentName, code, signal)
    })

    proc.on('error', (err) => {
      this.processes.delete(agentName)
      this.emit('error', agentName, err)
    })

    this.processes.set(agentName, agent)
    this.emit('started', agentName)
  }

  async sendMessage(
    agentName: string,
    message: string,
  ): Promise<SendMessageResult> {
    const agent = this.getAgent(agentName)

    if (agent.busy) {
      return new Promise<SendMessageResult>((resolve, reject) => {
        agent.messageQueue.push({ message, resolve, reject })
      })
    }

    agent.busy = true

    try {
      return await this.writeAndCollect(agent, message)
    } finally {
      agent.busy = false
      void this.processQueue(agentName)
    }
  }

  async stop(agentName: string): Promise<void> {
    const agent = this.processes.get(agentName)
    if (!agent) return

    // Reject any queued messages
    for (const queued of agent.messageQueue) {
      queued.reject(new Error(`Agent "${agentName}" was stopped`))
    }
    agent.messageQueue = []

    agent.stdout.close()
    agent.proc.stdin?.end()
    agent.proc.kill('SIGTERM')

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        agent.proc.kill('SIGKILL')
        resolve()
      }, 5000)

      agent.proc.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })

    this.processes.delete(agentName)
  }

  isRunning(agentName: string): boolean {
    return this.processes.has(agentName)
  }

  getStatus(): Map<string, AgentStatus> {
    const status = new Map<string, AgentStatus>()
    for (const [name, agent] of this.processes) {
      status.set(name, {
        agentName: agent.agentName,
        model: agent.model,
        busy: agent.busy,
        pid: agent.proc.pid!,
        sessionId: agent.sessionId,
      })
    }
    return status
  }

  async stopAll(): Promise<void> {
    const names = [...this.processes.keys()]
    await Promise.all(names.map((name) => this.stop(name)))
  }

  private getAgent(agentName: string): AgentProcess {
    const agent = this.processes.get(agentName)
    if (!agent) {
      throw new Error(`Agent "${agentName}" is not running`)
    }
    return agent
  }

  private writeAndCollect(
    agent: AgentProcess,
    message: string,
    timeoutMs: number = 120_000,
  ): Promise<SendMessageResult> {
    return new Promise((resolve, reject) => {
      const contentParts: string[] = []
      let inputTokens = 0
      let outputTokens = 0
      let lastEventTs = Date.now()
      let eventCount = 0

      // Sliding timeout: resets on every event (120s without ANY event = stuck)
      let timeoutId = setTimeout(onTimeout, timeoutMs)

      function onTimeout() {
        cleanup()
        reject(
          new Error(
            `Agent "${agent.agentName}" Timeout nach ${timeoutMs / 1000}s ohne Event (${eventCount} Events total, letztes vor ${Math.round((Date.now() - lastEventTs) / 1000)}s)`,
          ),
        )
      }

      function resetTimeout() {
        clearTimeout(timeoutId)
        timeoutId = setTimeout(onTimeout, timeoutMs)
      }

      const onLine = (line: string) => {
        if (!line.trim()) return
        lastEventTs = Date.now()
        eventCount++
        resetTimeout()

        let event: StreamEvent
        try {
          event = JSON.parse(line)
        } catch {
          console.error(`[ProcessManager:${agent.agentName}] Non-JSON stdout: ${line.slice(0, 200)}`)
          return
        }

        console.error(`[ProcessManager:${agent.agentName}] Event: ${event.type}${event.type === 'result' ? ` (${event.usage?.input_tokens ?? 0}in/${event.usage?.output_tokens ?? 0}out)` : ''}`)

        // Emit activity event for wrapper to track
        this.emit('activity', agent.agentName, event.type, eventCount)

        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              contentParts.push(block.text)
            }
          }
        }

        if (event.type === 'result') {
          inputTokens = event.usage?.input_tokens ?? 0
          outputTokens = event.usage?.output_tokens ?? 0
          cleanup()
          resolve({
            content: event.result ?? contentParts.join(''),
            inputTokens,
            outputTokens,
          })
        }
      }

      const onExit = (code: number | null) => {
        cleanup()
        reject(
          new Error(
            `Agent "${agent.agentName}" exited unexpectedly (code: ${code})`,
          ),
        )
      }

      const onError = (err: Error) => {
        cleanup()
        reject(err)
      }

      const cleanup = () => {
        clearTimeout(timeoutId)
        agent.stdout.off('line', onLine)
        agent.proc.off('exit', onExit)
        agent.proc.off('error', onError)
      }

      agent.stdout.on('line', onLine)
      agent.proc.once('exit', onExit)
      agent.proc.once('error', onError)

      const inputMsg = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: message }],
        },
      })
      const ok = agent.proc.stdin!.write(inputMsg + '\n')
      if (!ok) {
        agent.proc.stdin!.once('drain', () => {})
      }
    })
  }

  private async processQueue(agentName: string): Promise<void> {
    const agent = this.processes.get(agentName)
    if (!agent || agent.busy || agent.messageQueue.length === 0) return

    const next = agent.messageQueue.shift()!
    agent.busy = true

    try {
      const result = await this.writeAndCollect(agent, next.message)
      next.resolve(result)
    } catch (err) {
      next.reject(err instanceof Error ? err : new Error(String(err)))
    } finally {
      agent.busy = false
      void this.processQueue(agentName)
    }
  }
}

export const processManager = new ProcessManager()
export { ProcessManager }
