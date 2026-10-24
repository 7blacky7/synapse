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
  /** P8-T29: Zeit der juengsten Nachricht (ISO), fehlt bei Channels ohne Nachricht. */
  letzteAktivitaet?: string;
  source: 'api';
}

export interface ChannelMessageViewModel {
  id: number;
  sender: string;
  /** P22-T88: Anzeige eines archivierten (umbenannten) Absenders, z. B. 'runtime-review (archiviert)'; sender bleibt der alte Name. */
  senderAnzeige?: string;
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
  /** P22-T89: eindeutiger Schluessel ('identity:<id>' | 'wrapper:<name>'); fehlt er, gilt name. */
  key?: string;
  agentId?: string;
  identityId?: string;
  art?: 'identitaet' | 'wrapper';
  rolle?: string;
  typ?: string;
  ausweis?: 'gueltig' | 'keiner';
  laufStatus?: string;
  /** Quelle des Kontextstands; '' = nicht verfuegbar. */
  contextQuelle?: string;
  letzteAnmeldung?: string;
  anmeldungAnlass?: string;
  /** Schalter agent_anmeldungen ist AUS: keine Anmeldedaten. */
  anmeldungAus?: boolean;
  herkunft?: AgentHerkunftViewModel;
  /** P22-T113: woher der Agent gestartet wurde (Plattform, Daemon/Tray, Desktop-CLI, Web-KI, Extern); Vorgabe = noch kein Start. */
  startOrt?: { bezeichnung: string; vorgabe: boolean; quelle: string };
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
  /** P8-T26: Projekt des Aufrufs, wenn die Quelle projektuebergreifend ist (Hauptagent). */
  project?: string;
  /** P22-T67: Bilder des Ergebnisses als Asset-Verweis (kein Base64). */
  bilder?: Array<{ mime_type: string; bytes: number; project?: string; file_path?: string; revision?: string; breite?: number; hoehe?: number }>;
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
