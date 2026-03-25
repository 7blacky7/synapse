import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { StreamEvent, SendMessageResult } from './types.js'

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

    const proc = spawn(
      'claude',
      args,
      {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: opts?.cwd ?? process.cwd(),
      },
    )

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

      const timeoutId = setTimeout(() => {
        cleanup()
        reject(
          new Error(
            `Agent "${agent.agentName}" Timeout nach ${timeoutMs / 1000}s ohne result-Event (letztes Event vor ${Math.round((Date.now() - lastEventTs) / 1000)}s)`,
          ),
        )
      }, timeoutMs)

      const onLine = (line: string) => {
        if (!line.trim()) return
        lastEventTs = Date.now()

        let event: StreamEvent
        try {
          event = JSON.parse(line)
        } catch {
          console.error(`[ProcessManager:${agent.agentName}] Non-JSON stdout: ${line.slice(0, 200)}`)
          return
        }

        console.error(`[ProcessManager:${agent.agentName}] Event: ${event.type}${event.type === 'result' ? ` (${event.usage?.input_tokens ?? 0}in/${event.usage?.output_tokens ?? 0}out)` : ''}`)

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
