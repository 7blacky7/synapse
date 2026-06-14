/**
 * GRAPH-2: Farb- und Groessen-Paletten fuer die Graph-View.
 * 1:1 portiert aus synapse-graph/public/app.js (bewaehrte Optik beibehalten).
 */

export const POLL_MS = 8000;

export const EXT_COLORS: Record<string, string> = {
  ts: '#3178c6', tsx: '#61dafb', js: '#e8c545', mjs: '#e8c545', cjs: '#e8c545',
  py: '#4b8bbe', rs: '#dea584', go: '#00add8', json: '#7cb342', md: '#8d99c4',
  css: '#e91e8c', html: '#ff7043', moo: '#ab47bc', sql: '#26a69a', sh: '#66bb6a',
  toml: '#bdbdbd', yml: '#bdbdbd', yaml: '#bdbdbd',
};

// Symbol-Palette bewusst OHNE Blau — Dateifarben sind blau-lastig (ts/py/go).
// Doppel-Codierung: Symbole sind zusaetzlich DREIECKE (Dateien = Kreise).
export const SYM_COLORS: Record<string, string> = {
  function: '#ffb300', variable: '#aeea00', string: '#ff6e40', class: '#d500f9',
  interface: '#7c4dff', todo: '#ff1744', route: '#00e5ff', table: '#1de9b6',
};

export const TASK_COLORS: Record<string, string> = {
  todo: '#8d99c4', in_progress: '#5b8cff', done: '#3ddc84', blocked: '#ff5252',
};

export const MEM_COLORS: Record<string, string> = {
  rules: '#ef4444', architecture: '#8b5cf6', decision: '#f59e0b',
  documentation: '#38bdf8', note: '#94a3b8', other: '#94a3b8',
};

export const KIND_BASE: Record<string, { color: string; size: number }> = {
  project: { color: '#5b8cff', size: 56 },
  plan: { color: '#fbbf24', size: 40 },
  task: { color: '#8d99c4', size: 22 },
  memory: { color: '#94a3b8', size: 26 },
  thought: { color: '#67e8f9', size: 16 },
  proposal: { color: '#f472b6', size: 20 },
  tag: { color: '#475569', size: 12 },
};

export const EXT_NAMES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'React/TSX', js: 'JavaScript', mjs: 'JS-Modul', cjs: 'CommonJS',
  py: 'Python', rs: 'Rust', go: 'Go', json: 'JSON', md: 'Markdown', css: 'CSS',
  html: 'HTML', moo: 'moo', sql: 'SQL', sh: 'Shell', toml: 'TOML', yml: 'YAML', yaml: 'YAML',
};

export const SYM_NAMES: Record<string, string> = {
  function: 'Funktion', variable: 'Variable', string: 'String', class: 'Klasse',
  interface: 'Interface', todo: 'TODO/FIXME-Kommentar im Code', route: 'API-Route', table: 'SQL-Tabelle',
};

export const TL_COLORS: Record<string, string> = {
  files: '#5b8cff', shell: '#9ccc65', thought: '#67e8f9',
  memory: '#f59e0b', proposal: '#f472b6', task: '#3ddc84',
};

export const TL_NAMES: Record<string, string> = {
  files: 'Datei-Aenderung', shell: 'Shell-Befehl', thought: 'Gedanke',
  memory: 'Memory', proposal: 'Proposal', task: 'Task',
};

export const PLANET_BASES = [
  '#3b6fb5', '#7a5cc9', '#3da58a', '#b3683c', '#5b8cff',
  '#a04f7e', '#4a8f5d', '#8a6d3b', '#566b9e', '#7e57c2',
];

export function colorFor(ext: string): string {
  return EXT_COLORS[ext] ?? '#90a4ae';
}

export function sizeFor(n: number, min = 14, max = 56): number {
  return Math.max(min, Math.min(max, min + Math.sqrt(n || 0) * 4));
}
