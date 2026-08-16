export type RuntimeKind = 'cli' | 'api';
export type RuntimeStatus = 'ready' | 'warning' | 'offline';
export type HostStatus = 'connected' | 'idle' | 'offline';

export interface RuntimeProfile {
  id: string;
  name: string;
  kind: RuntimeKind;
  provider: string;
  model: string;
  authentication: string;
  accountStatus: string;
  host: string;
  enabled: boolean;
  mainAgentCompatible: boolean;
  status: RuntimeStatus;
}

export interface HostAgent {
  name: string;
  project: string;
  role: string;
  state: 'running' | 'idle' | 'sleeping';
  runtime: string;
  memory: string;
  heartbeat: string;
}

export interface AgentHostProfile {
  id: string;
  name: string;
  kind: string;
  address: string;
  operatingSystem: string;
  status: HostStatus;
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  diskUsed: number;
  diskTotal: number;
  runtimes: string[];
  agents: HostAgent[];
  history: Array<{ time: string; event: string; detail: string; tone: 'ok' | 'info' | 'warning' }>;
}

export const runtimeProfiles: RuntimeProfile[] = [
  { id: 'claude-code', name: 'Claude Code', kind: 'cli', provider: 'Anthropic', model: 'Claude Opus 4.1', authentication: 'Account', accountStatus: 'Angemeldet', host: 'unraid-agent-01', enabled: true, mainAgentCompatible: true, status: 'ready' },
  { id: 'codex-cli', name: 'Codex CLI', kind: 'cli', provider: 'OpenAI', model: 'GPT-5.6 Codex', authentication: 'ChatGPT Account', accountStatus: 'Nicht angemeldet', host: 'workstation-01', enabled: false, mainAgentCompatible: true, status: 'warning' },
  { id: 'openai-api', name: 'API Runtime', kind: 'api', provider: 'OpenAI-kompatibel', model: 'GPT-5.6', authentication: 'API-Key-Profil', accountStatus: 'server-default', host: 'unraid-agent-01', enabled: true, mainAgentCompatible: true, status: 'ready' },
];

export const agentHosts: AgentHostProfile[] = [
  {
    id: 'unraid-agent-01',
    name: 'unraid-agent-01',
    kind: 'Server · Docker Host',
    address: '192.168.50.15',
    operatingSystem: 'Unraid · Linux 6.x',
    status: 'connected',
    cpuUsage: 38,
    memoryUsed: 6.2,
    memoryTotal: 32,
    diskUsed: 84,
    diskTotal: 240,
    runtimes: ['Claude Code', 'API Runtime'],
    agents: [
      { name: 'synapse-main', project: 'global', role: 'main', state: 'running', runtime: 'Claude Code', memory: '1.8 GB', heartbeat: '12 s' },
      { name: 'ui-koordinator', project: 'synapse', role: 'project-coordinator', state: 'running', runtime: 'Claude Code', memory: '980 MB', heartbeat: '24 s' },
      { name: 'dreamer-night', project: 'synapse', role: 'dreamer', state: 'sleeping', runtime: 'API Runtime', memory: '0 MB', heartbeat: '02:00' },
      { name: 'parser-pruefer', project: 'synapse', role: 'specialist', state: 'idle', runtime: 'Claude Code', memory: '310 MB', heartbeat: '60 s' },
    ],
    history: [
      { time: '12:24:08', event: 'Heartbeat', detail: 'Hoststatus empfangen · 4 Agenten registriert', tone: 'ok' },
      { time: '12:21:44', event: 'Runtime', detail: 'Claude Code Session für ui-koordinator erneuert', tone: 'info' },
      { time: '12:18:02', event: 'Ressourcen', detail: 'RAM unter Warnschwelle · 19 % verwendet', tone: 'ok' },
      { time: '11:59:31', event: 'Authentifizierung', detail: 'Persistentes Claude-Account-Profil verfügbar', tone: 'ok' },
    ],
  },
  {
    id: 'workstation-01',
    name: 'workstation-01',
    kind: 'Arbeitsplatz · Runtime Host',
    address: '192.168.50.10',
    operatingSystem: 'Linux Desktop',
    status: 'idle',
    cpuUsage: 7,
    memoryUsed: 3.4,
    memoryTotal: 64,
    diskUsed: 32,
    diskTotal: 120,
    runtimes: ['Codex CLI'],
    agents: [
      { name: 'codex-ui-review', project: 'synapse', role: 'specialist', state: 'sleeping', runtime: 'Codex CLI', memory: '0 MB', heartbeat: 'pausiert' },
    ],
    history: [
      { time: '12:10:17', event: 'Host', detail: 'Verbindung im UI-Mock auf idle gesetzt', tone: 'info' },
      { time: '11:48:05', event: 'Login erforderlich', detail: 'Codex CLI wartet auf ChatGPT-Account', tone: 'warning' },
    ],
  },
  {
    id: 'remote-host-qa',
    name: 'remote-host-qa',
    kind: 'Remote · Test Host',
    address: '10.20.0.12',
    operatingSystem: 'Ubuntu Server',
    status: 'offline',
    cpuUsage: 0,
    memoryUsed: 0,
    memoryTotal: 16,
    diskUsed: 0,
    diskTotal: 80,
    runtimes: [],
    agents: [],
    history: [
      { time: '10:02:41', event: 'Verbindung getrennt', detail: 'Heartbeat-Zeitfenster überschritten', tone: 'warning' },
    ],
  },
];

export const workspaceProfiles = [
  { id: 'synapse-main', project: 'synapse', name: 'main', mode: 'persistent', status: 'active', image: 'synapse-workspace:latest', role: 'app', cpu: 2, memory: 2048, pids: 256, storage: 20, network: 'proxynet', scope: 'project', scopeId: 'project:synapse', sync: 'PG → Workspace live', overlay: 'nein', changedFiles: 0, merge: 'nicht erforderlich', conflicts: 0, hostMemory: '32 GB', reserve: '25.8 GB frei · 20 GB reservierbar', pinned: true },
  { id: 'synapse-ui-review', project: 'synapse', name: 'ui-review', mode: 'isolated', status: 'idle', image: 'synapse-workspace:latest', role: 'ui-review', cpu: 4, memory: 4096, pids: 384, storage: 30, network: 'isoliert', scope: 'workspace overlay', scopeId: 'workspace:synapse:ui-review', sync: 'eigener Parser-/CodeIntel-Stand', overlay: 'ja · 7 Dateien', changedFiles: 7, merge: 'gesperrt bis bewusste Freigabe', conflicts: 0, hostMemory: '32 GB', reserve: '21.8 GB frei · 16 GB reservierbar', pinned: false },
  { id: 'synapse-browser-test', project: 'synapse', name: 'browser-test', mode: 'mirror', status: 'stopped', image: 'synapse-browser:latest', role: 'browser-qa', cpu: 2, memory: 2048, pids: 192, storage: 10, network: 'proxynet', scope: 'test run', scopeId: 'workspace:synapse:browser-test', sync: 'Reset nach Lauf', overlay: 'temporär · 3 Dateien', changedFiles: 3, merge: 'Reset statt Merge', conflicts: 0, hostMemory: '32 GB', reserve: '25.8 GB frei · 20 GB reservierbar', pinned: false },
  { id: 'moo-main', project: 'moo', name: 'main', mode: 'persistent', status: 'active', image: 'synapse-workspace:latest', role: 'app', cpu: 2, memory: 1536, pids: 192, storage: 12, network: 'proxynet', scope: 'project', scopeId: 'project:moo', sync: 'PG → Workspace live', overlay: 'nein', changedFiles: 0, merge: 'nicht erforderlich', conflicts: 0, hostMemory: '32 GB', reserve: '24.2 GB frei', pinned: false },
  { id: 'evalink-review', project: 'evalink-pdf-editor', name: 'pdf-review', mode: 'isolated', status: 'stopped', image: 'synapse-browser:latest', role: 'browser-qa', cpu: 2, memory: 2048, pids: 192, storage: 10, network: 'isoliert', scope: 'workspace overlay', scopeId: 'workspace:evalink-pdf-editor:pdf-review', sync: 'eingefrorener Stand', overlay: 'ja · 2 Dateien', changedFiles: 2, merge: 'wartet', conflicts: 0, hostMemory: '32 GB', reserve: '22.1 GB frei', pinned: true },
];

export const testSystems = [
  { id: 'pixel-5', name: 'Pixel 5', kind: 'Android · reales Gerät', targetClass: 'Hardware', architecture: 'arm64', status: 'available', heartbeat: 'vor 18 s', capabilities: 'touch · kamera · WLAN · light tests', owner: 'Moritz', ownerMessage: 'Bitte Akku über 30 % halten.', connection: 'WLAN / ADB später', reset: 'App-Daten nach Freigabe', network: 'Gerätenetz', token: 'eigene Testsystem-Identität', tokenStatus: 'aktiv · einmal sichtbar', tokenLastUsed: 'heute 11:42', lock: 'frei', currentTest: '—', currentAgent: '—' },
  { id: 'macos-qa', name: 'macOS QA', kind: 'macOS · Remote Testsystem', targetClass: 'VM', architecture: 'arm64', status: 'reserved', heartbeat: 'vor 7 s', capabilities: 'Safari · Screenshot · UI automation', owner: 'UI-Agent', ownerMessage: 'Snapshot vor jedem Volltest.', connection: 'SSH / Agent später', reset: 'Snapshot manuell', network: 'isoliert', token: 'eigene Testsystem-Identität', tokenStatus: 'aktiv', tokenLastUsed: 'heute 12:03', lock: 'reserviert bis 12:45', currentTest: 'WebUI Smoke', currentAgent: 'ui-koordinator' },
  { id: 'browser-qa', name: 'Browser QA', kind: 'Browser · virtueller Workspace', targetClass: 'Workspace', architecture: 'amd64', status: 'offline', heartbeat: 'überschritten', capabilities: 'Chromium · Netzwerk · Screenshot', owner: '—', ownerMessage: 'Automatischer Reset nach Lauf.', connection: 'Workspace Runtime', reset: 'nach jedem Lauf', network: 'proxynet', token: 'laufbezogen', tokenStatus: 'widerrufen', tokenLastUsed: 'gestern 23:18', lock: 'offline', currentTest: '—', currentAgent: '—' },
];