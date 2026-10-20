import type { ContainerBeobachtung } from '@synapse/core';

export type RuntimeName = 'codex' | 'claude' | 'free-pool';
export type AgentRole = 'main' | 'specialist';
export type RuntimeContainerState = 'not_created' | 'created' | 'running' | 'stopped' | 'error';
export type RuntimeAuthState = 'authenticated' | 'not_authenticated' | 'unknown';

export interface RuntimeConfiguration {
  runtime: RuntimeName;
  role: AgentRole;
  rootPath: string;
  image: string;
  containerName: string;
  model: string | null;
  assignedToMain: boolean;
}

export interface RuntimeStatus {
  runtime: RuntimeName;
  role: AgentRole;
  configured: boolean;
  installed: boolean;
  rootPath: string;
  image: string;
  model: string | null;
  container: {
    name: string;
    id: string | null;
    status: RuntimeContainerState;
  };
  authentication: {
    status: RuntimeAuthState;
    method?: string;
  };
  version: string | null;
  lastError: string | null;
  diagnostic?: { code: 'pid_limit' | 'probe_timeout' | 'probe_error'; message: string };
  assignedToMain: boolean;
}

export interface MainAgentSession {
  id: string;
  identityId?: string | null;
  laufId?: string | null;
  runtime: RuntimeName;
  runtimeSessionId: string | null;
  status: 'ready' | 'running' | 'completed' | 'error';
  context: Record<string, unknown> | null;
  createdAt: string;
  /** P22-T36: nur bei Schalter hauptagent EIN - Identitaetsweg oder Altweg mit Grund (nie ein Ausweiswert). */
  hauptagent?: { weg: 'identitaet' | 'altweg'; identity_id?: string; outcome?: string; fehler?: string };
}

export interface RuntimeStreamEvent {
  // 'artifact': Zustellung eines Hauptagenten-Artefakts in den offenen Strom
  // (artifact-stream.ts); die Empfangsseite kennt den Typ seit d7a39c1.
  event: 'runtime' | 'delta' | 'usage' | 'error' | 'artifact';
  data: Record<string, unknown>;
}

export interface RuntimeMessageResult {
  runtimeSessionId: string | null;
  context: Record<string, unknown> | null;
}

export interface TerminalSession {
  id: string;
  runtime: RuntimeName;
  stream: NodeJS.ReadWriteStream;
  exec: {
    resize(options: { h: number; w: number }): Promise<unknown>;
    inspect(): Promise<{ ExitCode?: number | null }>;
  };
  createdAt: Date;
}

export interface AgentRuntimeDriver {
  readonly runtime: RuntimeName;
  readonly label: string;
  /**
   * Ob `openTerminal` sinnvoll ist. Der Modell-Pool fuehrt kein Programm aus,
   * dort gibt es nichts, woran ein Terminal haengen koennte.
   */
  readonly supportsTerminal?: boolean;
  configure(input: { rootPath: string; image?: string; model?: string }): Promise<RuntimeStatus>;
  setup(): Promise<RuntimeStatus>;
  start(): Promise<RuntimeStatus>;
  stop(): Promise<RuntimeStatus>;
  status(): Promise<RuntimeStatus>;
  /** P22-T58: leichte Beobachtung fuer die Runtime-Ueberwachung (nur Container-Runtimes). */
  beobachte?(o: { probe_timeout_ms: number; daemon_frisch_ms: number }): Promise<ContainerBeobachtung>;
  /** P22-T58: docker restart des eigenen Containers (nur Container-Runtimes). */
  neustart?(): Promise<void>;
  /** P22-T58 F5: CLI-Update im Container (nur Container-Runtimes mit Agent-Runtime-Image). */
  cliUpdate?(o: { timeout_ms: number }): Promise<{ ok: boolean; exit_code: number | null; ausgabe: string }>;
  openTerminal(input?: { cols?: number; rows?: number; command?: string }): Promise<TerminalSession>;
  sendMessage(
    session: MainAgentSession,
    message: string,
    emit: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeMessageResult>;
}
