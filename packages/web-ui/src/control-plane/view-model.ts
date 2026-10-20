export type Area =
  | 'overview'
  | 'main-agent'
  | 'channels'
  | 'agents'
  | 'workspaces'
  | 'dreamer'
  | 'verwalter'
  | 'graph'
  | 'user-memories'
  | 'personal-artifacts'
  | 'system'
  | 'settings';

export interface ProjectViewModel {
  name: string;
  path: string;
  isActive: boolean;
  source: 'api';
}

export interface ChannelViewModel {
  id: number;
  name: string;
  project: string;
  description: string;
  createdBy: string;
  createdAt: string;
  source: 'api';
}

export interface ChannelMessageViewModel {
  id: number;
  sender: string;
  content: string;
  createdAt: string;
  source: 'api';
}

/** P8-T25: Wo ein Agent laeuft (nur Anzeige, aus vorhandenen Daten). */
export interface AgentHerkunftViewModel {
  art: 'unraid' | 'pc' | 'sonstig' | 'unbekannt';
  ort: string | null;
}

export interface ChannelMemberViewModel {
  name: string;
  identityId?: string;
  role: string;
  status: 'online' | 'idle';
  messages: number;
  herkunft: AgentHerkunftViewModel;
  source: 'api';
}

export interface OnlineCoordinatorViewModel {
  id: string;
  name: string;
  project: string;
  lastActivity: string;
  herkunft: AgentHerkunftViewModel;
  source: 'api';
}

export type ProjectKnowledgeKind = 'agents' | 'tasks' | 'memories' | 'thoughts' | 'audit';

export interface ProjectKnowledgeEntryViewModel {
  id: string;
  title: string;
  detail: string;
  status: string;
  source: string;
}

export interface ProjectTeamAgentViewModel {
  name: string;
  model: string;
  status: string;
  contextPercent: number;
  tokensIn: number;
  tokensOut: number;
  channels: string[];
  currentTask: string;
  busy: boolean;
  provider: string;
  lastActivity: string;
  source: 'api';
}

export interface ProjectWorkspaceViewModel {
  id: string;
  name: string;
  project: string;
  status: string;
  image: string;
  cpuLimit: number;
  memLimitMb: number;
  tmpfsMb: number;
  pinned: boolean;
  lastActivityAt: string;
  lastStartedAt: string;
  lastStoppedAt: string;
  lastError: string;
  dockerAvailable: boolean;
  source: 'api';
}

export interface PersonalMemoryViewModel {
  name: string;
  category: string;
  tags: string[];
  sizeChars: number;
  updatedAt: string;
  source: 'api';
}

export interface PersonalArtifactViewModel {
  id: string;
  title: string;
  revision: number;
  htmlChars: number;
  createdBy: string;
  sessionId: string;
  updatedAt: string;
  source: 'api';
}

export interface ToolCallViewModel {
  id: string;
  tool: string;
  action: string;
  agent: string;
  status: 'running' | 'done' | 'failed';
  argsPreview: string;
  resultPreview: string;
  error: string;
  durationMs: number;
  createdAt: string;
  /** api: GET tool-calls; stream: Werkzeugaufruf aus dem Antwortstrom des Hauptagenten. */
  source: 'api' | 'stream';
}
export interface EntityViewModel {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  statusTone: 'ready' | 'planned' | 'warning' | 'offline';
  source: 'mock' | 'api';
  details: Array<{ label: string; value: string }>;
}

export interface NavGroup {
  label: string;
  items: Array<{ area: Area; label: string; glyph: string }>;
}

export interface SettingsViewModel {
  heartbeatEnabled: boolean;
  heartbeatInterval: number;
  heartbeatPolicy: string;
  defaultHtmlOutput: boolean;
  runtimeProfile: string;
  terminalEnabled: boolean;
  maxConcurrentAgents: number;
  workspaceImage: string;
  workspaceCpu: number;
  workspaceMemory: number;
  workspaceIdleStop: number;
  autoPinWorkspace: boolean;
  testResetAfterRun: boolean;
  testNetworkProfile: string;
  artifactRetentionDays: number;
  animationsEnabled: boolean;
  compactDensity: boolean;
  accentColor: string;
}
