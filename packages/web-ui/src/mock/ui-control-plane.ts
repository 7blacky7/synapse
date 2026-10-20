import type { NavGroup, SettingsViewModel } from '../control-plane/view-model';

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
