export type RuntimeName = 'codex' | 'claude';
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
  assignedToMain: boolean;
}

export interface MainAgentSession {
  id: string;
  runtime: RuntimeName;
  runtimeSessionId: string | null;
  status: 'ready' | 'running' | 'completed' | 'error';
  context: Record<string, unknown> | null;
  createdAt: string;
}

export interface RuntimeStreamEvent {
  event: 'runtime' | 'delta' | 'usage' | 'error';
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
  configure(input: { rootPath: string; image?: string; model?: string }): Promise<RuntimeStatus>;
  setup(): Promise<RuntimeStatus>;
  start(): Promise<RuntimeStatus>;
  stop(): Promise<RuntimeStatus>;
  status(): Promise<RuntimeStatus>;
  openTerminal(input?: { cols?: number; rows?: number; command?: string }): Promise<TerminalSession>;
  sendMessage(
    session: MainAgentSession,
    message: string,
    emit: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeMessageResult>;
}
