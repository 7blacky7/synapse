export type Area =
  | 'overview'
  | 'main-agent'
  | 'projects'
  | 'channels'
  | 'agents'
  | 'hosts'
  | 'runtimes'
  | 'workspaces'
  | 'testsystems'
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
  source: 'api';
}
export interface EntityViewModel {
  id: string;
  title: string;
  subtitle: string;
  status: string;
  statusTone: 'ready' | 'planned' | 'warning' | 'offline';
  source: 'mock';
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
