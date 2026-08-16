import { AgentRuntimeRepository } from './repository.js';
import { CodexRuntimeDriver } from './codex-driver.js';
import { ClaudeRuntimeDriver } from './claude-driver.js';
import { TerminalSessionRegistry } from './terminal-sessions.js';
import type { AgentRuntimeDriver, MainAgentSession, RuntimeName, RuntimeStatus } from './types.js';

export class AgentRuntimeManager {
  readonly terminals = new TerminalSessionRegistry();
  private readonly repository = new AgentRuntimeRepository();
  private readonly drivers = new Map<RuntimeName, AgentRuntimeDriver>();

  constructor() {
    const codex = new CodexRuntimeDriver(this.repository);
    const claude = new ClaudeRuntimeDriver(this.repository);
    this.drivers.set(codex.runtime, codex);
    this.drivers.set(claude.runtime, claude);
  }

  driver(runtime: string): AgentRuntimeDriver {
    const driver = this.drivers.get(runtime as RuntimeName);
    if (!driver) throw new Error('Unbekannte Agent-Runtime: ' + runtime);
    return driver;
  }

  listDrivers(): Array<{ runtime: RuntimeName; label: string }> {
    return [...this.drivers.values()].map((driver) => ({ runtime: driver.runtime, label: driver.label }));
  }

  async listStatuses(): Promise<RuntimeStatus[]> {
    return Promise.all([...this.drivers.values()].map((driver) => driver.status()));
  }

  async assignMain(runtime: RuntimeName | null): Promise<{ runtime: RuntimeName | null; status: RuntimeStatus | null }> {
    if (runtime) await this.assertMainRuntimeReady(runtime, false);
    await this.repository.assignMain(runtime);
    return this.mainAssignment();
  }

  async mainAssignment(): Promise<{ runtime: RuntimeName | null; status: RuntimeStatus | null }> {
    const config = await this.repository.getAssignedMain();
    if (!config) return { runtime: null, status: null };
    return { runtime: config.runtime, status: await this.driver(config.runtime).status() };
  }

  async createMainSession(runtime?: RuntimeName): Promise<MainAgentSession> {
    const assigned = (await this.repository.getAssignedMain())?.runtime;
    if (!assigned) throw new Error('Dem Main-Agenten ist noch keine Runtime zugewiesen');
    if (runtime && runtime !== assigned) throw new Error('Nur die aktuell zugewiesene Main-Agent-Runtime darf Sessions starten');
    await this.assertMainRuntimeReady(assigned);
    return this.repository.createSession(assigned);
  }

  async assertMainRuntimeReady(runtime: RuntimeName, requireAssigned = true): Promise<RuntimeStatus> {
    const assigned = (await this.repository.getAssignedMain())?.runtime;
    if (requireAssigned && assigned !== runtime) throw new Error('Runtime ist dem Main-Agenten nicht zugewiesen');
    const status = await this.driver(runtime).status();
    if (!status.installed || status.container.status !== 'running' || status.authentication.status !== 'authenticated') {
      throw new Error('Main-Agent-Runtime ist nicht installiert, laufend und authentifiziert');
    }
    return status;
  }

  async getMainSession(id: string): Promise<MainAgentSession> {
    const session = await this.repository.getSession(id);
    if (!session) throw new Error('Main-Agent-Sitzung nicht gefunden');
    return session;
  }

  async markSessionRunning(id: string): Promise<void> {
    if (!await this.repository.claimSession(id)) {
      throw new Error('Main-Agent-Sitzung verarbeitet bereits eine Nachricht');
    }
  }

  async completeSession(id: string, runtimeSessionId: string | null, context: Record<string, unknown> | null): Promise<void> {
    await this.repository.updateSession(id, { runtimeSessionId, context, status: 'completed', lastError: null });
  }

  async failSession(id: string, error: Error): Promise<void> {
    await this.repository.updateSession(id, { status: 'error', lastError: error.message });
  }

  shutdown(): void {
    this.terminals.closeAll();
  }
}

let singleton: AgentRuntimeManager | null = null;

export function getAgentRuntimeManager(): AgentRuntimeManager {
  if (!singleton) singleton = new AgentRuntimeManager();
  return singleton;
}

export function shutdownAgentRuntimeManager(): void {
  singleton?.shutdown();
  singleton = null;
}
