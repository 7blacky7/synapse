import type { Area, EntityViewModel, NavGroup, SettingsViewModel } from '../control-plane/view-model';

export const navigation: NavGroup[] = [
  {
    label: 'Arbeitsbereich',
    items: [
      { area: 'overview', label: 'Übersicht', glyph: '⌂' },
      { area: 'main-agent', label: 'Hauptagent', glyph: '◎' },
      { area: 'channels', label: 'Channels', glyph: '#' },
      { area: 'agents', label: 'Agententeam', glyph: '◉' },
      { area: 'workspaces', label: 'Projekt-Workspaces', glyph: '□' },
      { area: 'graph', label: 'Graph', glyph: '◇' },
    ],
  },
  {
    label: 'Persönlich',
    items: [
      { area: 'user-memories', label: 'Meine Memories', glyph: '◈' },
      { area: 'personal-artifacts', label: 'Persönliche Artefakte', glyph: '▧' },
    ],
  },
  {
    label: 'Dienste',
    items: [
      { area: 'dreamer', label: 'Dreamer', glyph: '◌' },
      { area: 'verwalter', label: 'Verwalter', glyph: '≡' },
      { area: 'system', label: 'System', glyph: '◫' },
    ],
  },
];

export const entityData: Partial<Record<Area, EntityViewModel[]>> = {
  agents: [
    {
      id: 'ui-agent',
      title: 'UI-Agent',
      subtitle: 'Spezialist · synapse',
      status: 'bereit',
      statusTone: 'ready',
      source: 'mock',
      details: [
        { label: 'Rolle', value: 'Spezialist' },
        { label: 'Projekt', value: 'synapse' },
        { label: 'Sessionen', value: '4 in der Laufhistorie' },
        { label: 'Letzte Aktivität', value: 'gerade eben' },
      ],
    },
  ],
  hosts: [
    {
      id: 'host-unraid',
      title: 'claude-unraid-01',
      subtitle: 'Agent Host · Server',
      status: 'bereit',
      statusTone: 'ready',
      source: 'mock',
      details: [
        { label: 'RAM', value: '6,2 / 32 GB' },
        { label: 'Agenten', value: '8' },
        { label: 'Runtimes', value: 'Claude CLI, Codex CLI' },
        { label: 'Terminal', value: 'UI vorbereitet' },
      ],
    },
    {
      id: 'host-workstation',
      title: 'workstation-01',
      subtitle: 'Agent Host · Arbeitsplatz',
      status: 'geplant',
      statusTone: 'planned',
      source: 'mock',
      details: [
        { label: 'RAM', value: 'noch nicht verbunden' },
        { label: 'Agenten', value: '0' },
        { label: 'Runtimes', value: 'Codex CLI' },
        { label: 'Terminal', value: 'UI vorbereitet' },
      ],
    },
  ],
  runtimes: [
    {
      id: 'claude-cli',
      title: 'Claude Code',
      subtitle: 'CLI · Account',
      status: 'angemeldet',
      statusTone: 'ready',
      source: 'mock',
      details: [
        { label: 'Host', value: 'claude-unraid-01' },
        { label: 'Authentifizierung', value: 'Account' },
        { label: 'Agenten', value: '6' },
        { label: 'Profil', value: 'Standard' },
      ],
    },
    {
      id: 'codex-cli',
      title: 'Codex',
      subtitle: 'CLI · ChatGPT Account',
      status: 'nicht eingerichtet',
      statusTone: 'warning',
      source: 'mock',
      details: [
        { label: 'Host', value: 'workstation-01' },
        { label: 'Authentifizierung', value: 'ChatGPT Account' },
        { label: 'Agenten', value: '0' },
        { label: 'Profil', value: 'noch offen' },
      ],
    },
    {
      id: 'openai-api',
      title: 'OpenAI API',
      subtitle: 'API · API-Key-Profil',
      status: 'konfiguriert',
      statusTone: 'ready',
      source: 'mock',
      details: [
        { label: 'Host', value: 'claude-unraid-01' },
        { label: 'Authentifizierung', value: 'API-Key-Profil' },
        { label: 'Agenten', value: '2' },
        { label: 'Profil', value: 'server-default' },
      ],
    },
  ],
  workspaces: [
    {
      id: 'workspace-main',
      title: 'main',
      subtitle: 'synapse · Workspace',
      status: 'active',
      statusTone: 'ready',
      source: 'mock',
      details: [
        { label: 'Image', value: 'synapse-workspace:latest' },
        { label: 'CPU', value: '2 Kerne' },
        { label: 'RAM', value: '2048 MB' },
        { label: 'Idle-Stop', value: '10 Minuten' },
      ],
    },
  ],
  testsystems: [
    {
      id: 'test-browser',
      title: 'browser-qa',
      subtitle: 'Browser-Testsystem',
      status: 'geplant',
      statusTone: 'planned',
      source: 'mock',
      details: [
        { label: 'Geräteklasse', value: 'Desktop Browser' },
        { label: 'Isolation', value: 'pro Testlauf' },
        { label: 'Reset-Policy', value: 'nach jedem Lauf' },
        { label: 'Netzwerk', value: 'proxynet' },
      ],
    },
    {
      id: 'test-windows',
      title: 'windows-qa',
      subtitle: 'Desktop-Testsystem',
      status: 'geplant',
      statusTone: 'planned',
      source: 'mock',
      details: [
        { label: 'Geräteklasse', value: 'Windows Desktop' },
        { label: 'Isolation', value: 'Snapshot' },
        { label: 'Reset-Policy', value: 'nach Freigabe' },
        { label: 'Netzwerk', value: 'isoliert' },
      ],
    },
  ],
  dreamer: [
    {
      id: 'dreamer-main',
      title: 'Dreamer',
      subtitle: 'Ideen- und Verbesserungsdienst',
      status: 'vorbereitet',
      statusTone: 'planned',
      source: 'mock',
      details: [
        { label: 'Produktivlogik', value: 'unverändert' },
        { label: 'Eingang', value: 'UI vorbereitet' },
        { label: 'Vorschläge', value: 'UI vorbereitet' },
        { label: 'Automatik', value: 'deaktiviert' },
      ],
    },
  ],
  verwalter: [
    {
      id: 'verwalter-main',
      title: 'Verwalter',
      subtitle: 'Wartungs- und Orchestrierungsdienst',
      status: 'vorbereitet',
      statusTone: 'planned',
      source: 'mock',
      details: [
        { label: 'Produktivlogik', value: 'unverändert' },
        { label: 'Wartung', value: 'UI vorbereitet' },
        { label: 'Zeitpläne', value: 'UI vorbereitet' },
        { label: 'Automatik', value: 'deaktiviert' },
      ],
    },
  ],
  system: [
    {
      id: 'system-api',
      title: 'Synapse API',
      subtitle: 'REST- und MCP-Schicht',
      status: 'verbunden',
      statusTone: 'ready',
      source: 'mock',
      details: [
        { label: 'Web-UI', value: 'verbunden' },
        { label: 'Projektquelle', value: 'REST API' },
        { label: 'Channels', value: 'REST API · lesen/schreiben' },
        { label: 'Graph', value: 'bestehende API' },
      ],
    },
    {
      id: 'system-index',
      title: 'Index-Pipeline',
      subtitle: 'Parser und Embeddings',
      status: 'nur Anzeige',
      statusTone: 'ready',
      source: 'mock',
      details: [
        { label: 'Parser', value: 'keine UI-Aktion' },
        { label: 'Embeddings', value: 'keine UI-Aktion' },
        { label: 'FileWatcher', value: 'bestehende Instanz' },
        { label: 'Sicherheitsgrenze', value: 'UI-0 bis UI-3' },
      ],
    },
  ],
};

export const defaultSettings: SettingsViewModel = {
  heartbeatEnabled: true,
  heartbeatInterval: 60,
  heartbeatPolicy: 'Projektstatus prüfen, offene Events priorisieren und unterbrochene Arbeit kontrolliert fortsetzen.',
  defaultHtmlOutput: true,
  runtimeProfile: 'Austauschbar',
  terminalEnabled: true,
  maxConcurrentAgents: 6,
  workspaceImage: 'synapse-workspace:latest',
  workspaceCpu: 2,
  workspaceMemory: 2048,
  workspaceIdleStop: 10,
  autoPinWorkspace: false,
  testResetAfterRun: true,
  testNetworkProfile: 'proxynet',
  artifactRetentionDays: 30,
  animationsEnabled: true,
  compactDensity: false,
  accentColor: '#f97316',
};
