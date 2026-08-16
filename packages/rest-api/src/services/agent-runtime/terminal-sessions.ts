import { EventEmitter } from 'node:events';
import type { RuntimeName, TerminalSession } from './types.js';

export interface TerminalEvent {
  event: 'connected' | 'output' | 'exit' | 'error';
  data: Record<string, unknown>;
}

interface ManagedTerminal {
  session: TerminalSession;
  bus: EventEmitter;
  history: TerminalEvent[];
  closed: boolean;
  subscribers: number;
  cleanupTimer: NodeJS.Timeout | null;
}

const IDLE_TTL_MS = 60_000;
const EXIT_REPLAY_TTL_MS = 5_000;

export class TerminalSessionRegistry {
  private readonly sessions = new Map<string, ManagedTerminal>();

  add(session: TerminalSession): void {
    const managed: ManagedTerminal = {
      session,
      bus: new EventEmitter(),
      history: [],
      closed: false,
      subscribers: 0,
      cleanupTimer: null,
    };
    managed.bus.setMaxListeners(0);
    this.sessions.set(session.id, managed);
    this.record(managed, 'connected', { sessionId: session.id, runtime: session.runtime });
    this.scheduleCleanup(managed, IDLE_TTL_MS);
    session.stream.on('data', (chunk: Buffer | string) => {
      this.record(managed, 'output', { data: chunk.toString() });
    });
    session.stream.on('error', (error: Error) => {
      this.record(managed, 'error', { message: error.message });
      managed.closed = true;
      this.scheduleCleanup(managed, EXIT_REPLAY_TTL_MS);
    });
    session.stream.on('end', () => {
      void session.exec.inspect().then((info) => {
        this.record(managed, 'exit', { exitCode: info.ExitCode ?? null });
        managed.closed = true;
        this.scheduleCleanup(managed, EXIT_REPLAY_TTL_MS);
      }).catch((error: Error) => {
        this.record(managed, 'error', { message: error.message });
        managed.closed = true;
        this.scheduleCleanup(managed, EXIT_REPLAY_TTL_MS);
      });
    });
  }

  assertRuntime(id: string, runtime: string): void {
    const managed = this.require(id);
    if (managed.session.runtime !== runtime) throw new Error('Terminal-Sitzung gehoert zu einer anderen Runtime');
  }

  subscribe(id: string, listener: (event: TerminalEvent) => void): { replay: TerminalEvent[]; unsubscribe: () => void } {
    const managed = this.require(id);
    this.clearCleanup(managed);
    managed.subscribers += 1;
    const handler = (event: TerminalEvent): void => listener(event);
    managed.bus.on('event', handler);
    let active = true;
    return {
      replay: [...managed.history],
      unsubscribe: () => {
        if (!active) return;
        active = false;
        managed.bus.off('event', handler);
        managed.subscribers = Math.max(0, managed.subscribers - 1);
        if (managed.subscribers === 0) {
          this.scheduleCleanup(managed, managed.closed ? EXIT_REPLAY_TTL_MS : IDLE_TTL_MS);
        }
      },
    };
  }

  write(id: string, data: string): void {
    const managed = this.require(id);
    if (managed.closed || !managed.session.stream.writable) throw new Error('Terminal-Sitzung ist geschlossen');
    managed.session.stream.write(data);
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    const managed = this.require(id);
    await managed.session.exec.resize({ w: cols, h: rows });
  }

  close(id: string): boolean {
    const managed = this.sessions.get(id);
    if (!managed) return false;
    this.clearCleanup(managed);
    managed.closed = true;
    managed.session.stream.end();
    (managed.session.stream as NodeJS.ReadWriteStream & { destroy(): void }).destroy();
    managed.bus.removeAllListeners();
    this.sessions.delete(id);
    return true;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private require(id: string): ManagedTerminal {
    const managed = this.sessions.get(id);
    if (!managed) throw new Error('Terminal-Sitzung nicht gefunden');
    return managed;
  }

  private scheduleCleanup(managed: ManagedTerminal, delay: number): void {
    this.clearCleanup(managed);
    managed.cleanupTimer = setTimeout(() => this.close(managed.session.id), delay);
    managed.cleanupTimer.unref();
  }

  private clearCleanup(managed: ManagedTerminal): void {
    if (managed.cleanupTimer) clearTimeout(managed.cleanupTimer);
    managed.cleanupTimer = null;
  }

  private record(managed: ManagedTerminal, event: TerminalEvent['event'], data: Record<string, unknown>): void {
    const item = { event, data };
    managed.history.push(item);
    if (managed.history.length > 250) managed.history.shift();
    managed.bus.emit('event', item);
  }
}
