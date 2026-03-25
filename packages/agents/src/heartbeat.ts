/**
 * MODUL: HeartbeatController (MCP-Server Side)
 * ZWECK: Verwaltet Unix-Socket-Verbindungen zu Agent-Wrappern.
 *        Sendet JSON-RPC-Kommandos (wake, stop, status, save_and_pause)
 *        und verarbeitet Antworten/Notifications vom Wrapper.
 *
 * ARCHITEKTUR:
 *   MCP-Server --> HeartbeatController --> Unix Socket --> Agent-Wrapper
 *
 * PROTOKOLL: Newline-delimited JSON-RPC 2.0
 *
 * NEBENEFFEKTE:
 *   - Liest status.json zur Reconnect-Logik
 *   - Aktualisiert/entfernt Eintraege in status.json bei toten PIDs
 *   - Loescht verwaiste .sock-Dateien
 */

import { connect, type Socket } from 'node:net'
import { readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readStatus, updateSpecialist, removeSpecialist } from './status.js'
import type { WrapperMessage, WrapperResponse, SendMessageResult } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WrapperConnection {
  name: string
  socket: Socket
  socketPath: string
  pending: Map<number, { resolve: (r: any) => void; reject: (e: Error) => void }>
  nextId: number
  buffer: string
}

// Timeout for individual JSON-RPC requests (30 seconds)
const REQUEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// HeartbeatController
// ---------------------------------------------------------------------------

class HeartbeatController {
  private connections = new Map<string, WrapperConnection>()

  /**
   * Connect to a wrapper's Unix socket.
   * Sets up data handler for JSON-RPC response correlation.
   */
  async connectToWrapper(name: string, socketPath: string): Promise<void> {
    if (this.connections.has(name)) {
      // Already connected — verify socket is still alive
      const existing = this.connections.get(name)!
      if (!existing.socket.destroyed) {
        return
      }
      // Socket is dead, clean it up and reconnect
      this.connections.delete(name)
    }

    return new Promise((resolve, reject) => {
      const socket = connect(socketPath)

      const conn: WrapperConnection = {
        name,
        socket,
        socketPath,
        pending: new Map(),
        nextId: 1,
        buffer: '',
      }

      socket.on('connect', () => {
        this.connections.set(name, conn)
        resolve()
      })

      socket.on('data', (data: Buffer) => {
        this.handleData(conn, data.toString())
      })

      socket.on('error', (err) => {
        if (!this.connections.has(name)) {
          // Connection never established
          reject(err)
        } else {
          // Reject all pending requests
          for (const [, { reject: rejectPending }] of conn.pending) {
            rejectPending(new Error(`Socket error for wrapper "${name}": ${err.message}`))
          }
          conn.pending.clear()
          this.connections.delete(name)
        }
      })

      socket.on('close', () => {
        // Reject all pending requests
        for (const [, { reject: rejectPending }] of conn.pending) {
          rejectPending(new Error(`Socket closed for wrapper "${name}"`))
        }
        conn.pending.clear()
        this.connections.delete(name)
      })
    })
  }

  /**
   * Disconnect from a wrapper, destroying the socket.
   */
  async disconnectFromWrapper(name: string): Promise<void> {
    const conn = this.connections.get(name)
    if (!conn) return

    // Reject all pending requests
    for (const [, { reject: rejectPending }] of conn.pending) {
      rejectPending(new Error(`Disconnecting from wrapper "${name}"`))
    }
    conn.pending.clear()

    if (!conn.socket.destroyed) {
      conn.socket.destroy()
    }

    this.connections.delete(name)
  }

  /**
   * Reconnect all wrappers from status.json.
   * Verifies PIDs are alive, cleans up dead entries.
   * Returns lists of connected and cleaned-up wrapper names.
   */
  async reconnectAll(
    projectPath: string,
  ): Promise<{ connected: string[]; cleaned: string[] }> {
    const status = await readStatus(projectPath)
    const connected: string[] = []
    const cleaned: string[] = []

    for (const [name, specialist] of Object.entries(status.specialists)) {
      const { wrapperPid, socket: socketPath } = specialist

      // Skip entries without a wrapperPid or socket path
      if (!wrapperPid || !socketPath) {
        continue
      }

      // Check if the wrapper process is still alive
      const alive = isPidAlive(wrapperPid)

      if (alive) {
        try {
          await this.connectToWrapper(name, socketPath)
          connected.push(name)
        } catch (err) {
          // Socket file exists in status but connection failed — treat as dead
          await removeSpecialist(projectPath, name)
          await deleteSocketFile(socketPath)
          cleaned.push(name)
        }
      } else {
        // PID is dead — clean up status entry and socket file
        await removeSpecialist(projectPath, name)
        await deleteSocketFile(socketPath)
        cleaned.push(name)
      }
    }

    return { connected, cleaned }
  }

  /**
   * Send a wake message to the wrapper and return the agent's response.
   */
  async sendWake(name: string, message: string): Promise<SendMessageResult> {
    const result = await this.sendRequest(name, 'wake', { message })
    return {
      content: String(result?.content ?? ''),
      inputTokens: Number(result?.inputTokens ?? 0),
      outputTokens: Number(result?.outputTokens ?? 0),
    }
  }

  /**
   * Send a stop command to the wrapper.
   */
  async sendStop(name: string): Promise<void> {
    await this.sendRequest(name, 'stop')
  }

  /**
   * Send a save_and_pause command to the wrapper.
   */
  async sendSaveAndPause(name: string): Promise<void> {
    await this.sendRequest(name, 'save_and_pause')
  }

  /**
   * Get the wrapper's current status.
   */
  async getWrapperStatus(name: string): Promise<Record<string, unknown>> {
    const result = await this.sendRequest(name, 'status')
    return (result as Record<string, unknown>) ?? {}
  }

  /**
   * Check whether the controller is currently connected to a wrapper.
   */
  isConnected(name: string): boolean {
    const conn = this.connections.get(name)
    return conn !== undefined && !conn.socket.destroyed
  }

  /**
   * Scan the socket directory for .sock files that are not present in
   * status.json and delete them (orphaned sockets from crashed wrappers).
   * Returns the list of deleted socket filenames.
   */
  async cleanupOrphans(projectPath: string): Promise<string[]> {
    const socketDir = join(projectPath, '.synapse', 'sockets')
    const status = await readStatus(projectPath)

    // Collect all known socket paths from status.json
    const knownSockets = new Set<string>(
      Object.values(status.specialists)
        .map((s) => s.socket)
        .filter(Boolean),
    )

    let files: string[]
    try {
      files = await readdir(socketDir)
    } catch {
      // Directory doesn't exist yet — nothing to clean up
      return []
    }

    const deleted: string[] = []

    for (const file of files) {
      if (!file.endsWith('.sock')) continue

      const fullPath = join(socketDir, file)
      if (!knownSockets.has(fullPath)) {
        await deleteSocketFile(fullPath)
        deleted.push(file)
      }
    }

    return deleted
  }

  /**
   * Disconnect from all connected wrappers.
   */
  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys())
    await Promise.all(names.map((name) => this.disconnectFromWrapper(name)))
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a JSON-RPC request to the named wrapper and wait for the response.
   * Rejects if the wrapper responds with an error or if the request times out.
   */
  private sendRequest(
    name: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<any> {
    const conn = this.connections.get(name)
    if (!conn) {
      return Promise.reject(new Error(`Not connected to wrapper "${name}"`))
    }
    if (conn.socket.destroyed) {
      return Promise.reject(new Error(`Socket destroyed for wrapper "${name}"`))
    }

    const id = conn.nextId++

    const request: WrapperMessage = {
      jsonrpc: '2.0',
      method,
      id,
      ...(params ? { params } : {}),
    }

    return new Promise((resolve, reject) => {
      // Register in pending map
      conn.pending.set(id, { resolve, reject })

      // Timeout guard
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        reject(
          new Error(
            `Timeout waiting for response to "${method}" (id=${id}) from wrapper "${name}"`,
          ),
        )
      }, REQUEST_TIMEOUT_MS)

      // Wrap resolve/reject to clear the timer
      conn.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })

      // Write the request
      try {
        conn.socket.write(JSON.stringify(request) + '\n')
      } catch (err) {
        conn.pending.delete(id)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Handle incoming data from a wrapper socket.
   * Buffers partial lines, parses complete newline-delimited JSON messages,
   * and dispatches responses (with id) or notifications (without id).
   */
  private handleData(conn: WrapperConnection, data: string): void {
    conn.buffer += data

    let newlineIdx: number
    while ((newlineIdx = conn.buffer.indexOf('\n')) !== -1) {
      const line = conn.buffer.slice(0, newlineIdx).trim()
      conn.buffer = conn.buffer.slice(newlineIdx + 1)

      if (!line) continue

      let msg: WrapperResponse
      try {
        msg = JSON.parse(line) as WrapperResponse
      } catch {
        // Malformed JSON — skip
        continue
      }

      if (msg.id !== undefined) {
        // Response to a pending request
        const pending = conn.pending.get(msg.id)
        if (pending) {
          conn.pending.delete(msg.id)
          if (msg.error) {
            pending.reject(
              new Error(`RPC error from wrapper "${conn.name}": ${msg.error.message} (code ${msg.error.code})`),
            )
          } else {
            pending.resolve(msg.result ?? null)
          }
        }
        // If no pending entry, the response is late/unexpected — ignore it
      }
      // Notifications (no id): fire-and-forget from wrapper side — nothing to dispatch here
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a process with the given PID is alive using signal 0.
 * `process.kill(pid, 0)` does not send a real signal — it only checks
 * whether the process exists and is reachable.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Delete a socket file, ignoring errors (e.g., already deleted).
 */
async function deleteSocketFile(socketPath: string): Promise<void> {
  try {
    await unlink(socketPath)
  } catch {
    // Ignore — file may already be gone
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const heartbeatController = new HeartbeatController()
