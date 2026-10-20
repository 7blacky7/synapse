/**
 * P8-T30: lesende Datenwege fuer das Projektdetail hinter dem Channel
 * (Tasks / Plan im Plan-Format, Memories). Quelle sind die REST-Routen zum
 * plan- und memory-Tool; die Web-UI aendert hier nichts.
 */
import { apiFetch } from './auth';

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked';

export interface PlanListEntry {
  id: string;
  kurzId: string;
  name: string;
  goal: string;
  active: boolean;
  priority: string;
  open: number;
  done: number;
  total: number;
  updatedAt: string;
  snoozedUntil: string;
}

export interface PlanTaskRow {
  id: string;
  kurzId: string;
  title: string;
  status: string;
  priority: string;
  gitBranch: string;
  participants: string[];
  recommendation: string;
  snoozed: boolean;
  snoozedUntil: string;
  updatedAt: string;
}

export interface PlanDetail {
  kurzId: string;
  name: string;
  description: string;
  goals: string[];
  active: boolean;
  priority: string;
  tasks: PlanTaskRow[];
}

export interface TaskLinkThought { id: string; source: string; preview: string; at: string }
export interface TaskLinkVersion { id: string; filePath: string; agent: string; reason: string; at: string }

export interface TaskDetail extends PlanTaskRow {
  description: string;
  planLabel: string;
  createdAt: string;
  thoughts: { total: number; items: TaskLinkThought[] };
  versions: { total: number; items: TaskLinkVersion[] };
}

export interface TaskSearchHit {
  id: string;
  kurzId: string;
  title: string;
  status: string;
  priority: string;
  planLabel: string;
  preview: string;
  score: number;
  thoughtPins: number;
  versionPins: number;
  snoozed: boolean;
}

export interface MemoryEntry {
  name: string;
  category: string;
  tags: string[];
  sizeChars: number;
  updatedAt: string;
  score?: number;
  preview?: string;
}

export interface MemoryContent {
  name: string;
  category: string;
  tags: string[];
  content: string;
  linkedPaths: string[];
  createdAt: string;
  updatedAt: string;
}

type Roh = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function list(value: unknown): Roh[] {
  return Array.isArray(value) ? value.filter((row): row is Roh => !!row && typeof row === 'object') : [];
}

export function zeitText(value: unknown): string {
  const raw = str(value);
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('de-DE');
}

function pfad(project: string): string {
  return '/api/projects/' + encodeURIComponent(project);
}

async function holeJson(url: string, label: string, init?: RequestInit): Promise<Roh> {
  const response = await apiFetch(url, init);
  const data = await response.json().catch(() => ({})) as Roh;
  if (!response.ok) {
    const fehler = data.error;
    const message = typeof fehler === 'string' ? fehler : str((fehler as Roh | undefined)?.message);
    throw new Error(message || label + ' HTTP ' + response.status);
  }
  return data;
}

/** Beteiligte kommen je nach Stand als Name oder als Objekt. */
function beteiligteNamen(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return item;
    const row = (item && typeof item === 'object' ? item : {}) as Roh;
    return str(row.agent_id) || str(row.agent) || str(row.name) || str(row.identity_id);
  }).filter(Boolean);
}

function empfehlungText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const row = value as Roh;
  const teile = [str(row.modell), str(row.effort), str(row.kontext)].filter(Boolean);
  return teile.join(' · ');
}

function taskZeile(row: Roh): PlanTaskRow {
  return {
    id: str(row.id),
    kurzId: str(row.kurz_id),
    title: str(row.title),
    status: str(row.status) || 'todo',
    priority: str(row.priority),
    gitBranch: str(row.git_branch),
    participants: beteiligteNamen(row.beteiligte),
    recommendation: empfehlungText(row.empfehlung),
    snoozed: row.zurueckgestellt === true,
    snoozedUntil: zeitText(row.zurueckgestellt_bis),
    updatedAt: zeitText(row.updated_at),
  };
}

function planLabel(plan: Roh | undefined): string {
  return [str(plan?.kurz_id), str(plan?.name)].filter(Boolean).join(' ');
}

/** plan(list): aktiver Plan zuerst, dann Prioritaet, dann zuletzt geaendert (Sortierung liefert der Server). */
export async function loadPlanList(project: string): Promise<{ plans: PlanListEntry[]; hidden: number }> {
  const data = await holeJson(pfad(project) + '/plaene?alle=true', 'Plaene');
  const plans = list(data.plaene).map<PlanListEntry>((row) => ({
    id: str(row.id),
    kurzId: str(row.kurz_id),
    name: str(row.name),
    goal: str(row.ziel),
    active: row.aktiv === true,
    priority: str(row.prioritaet) || 'mittel',
    open: num(row.tasks_offen),
    done: num(row.tasks_erledigt),
    total: num(row.tasks_gesamt),
    updatedAt: zeitText(row.updated_at),
    snoozedUntil: row.zurueckgestellt === true ? zeitText(row.zurueckgestellt_bis) : '',
  }));
  return { plans, hidden: num(data.ausgeblendet) };
}

export async function loadPlanDetail(project: string, ref: string): Promise<PlanDetail> {
  const data = await holeJson(pfad(project) + '/plaene/' + encodeURIComponent(ref), 'Plan');
  const plan = (data.plan && typeof data.plan === 'object' ? data.plan : {}) as Roh;
  return {
    kurzId: str(plan.kurz_id),
    name: str(plan.name),
    description: str(plan.description),
    goals: Array.isArray(plan.goals) ? plan.goals.filter((goal): goal is string => typeof goal === 'string') : [],
    active: plan.aktiv === true,
    priority: str(plan.prioritaet) || 'mittel',
    tasks: list(plan.tasks).map(taskZeile),
  };
}

export async function loadTaskDetail(project: string, ref: string): Promise<TaskDetail> {
  const data = await holeJson(pfad(project) + '/plan-tasks/' + encodeURIComponent(ref), 'Task');
  const task = (data.task && typeof data.task === 'object' ? data.task : {}) as Roh;
  const links = (data.verknuepfungen && typeof data.verknuepfungen === 'object' ? data.verknuepfungen : {}) as Roh;
  const thoughts = (links.thoughts && typeof links.thoughts === 'object' ? links.thoughts : {}) as Roh;
  const versions = (links.dateiversionen && typeof links.dateiversionen === 'object' ? links.dateiversionen : {}) as Roh;
  return {
    ...taskZeile(task),
    description: str(task.description),
    planLabel: planLabel(data.plan as Roh | undefined),
    createdAt: zeitText(task.created_at),
    thoughts: {
      total: num(thoughts.gesamt),
      items: list(thoughts.eintraege).map((row) => ({ id: str(row.id), source: str(row.source), preview: str(row.vorschau), at: zeitText(row.timestamp) })),
    },
    versions: {
      total: num(versions.gesamt),
      items: list(versions.eintraege).map((row) => ({ id: str(row.id), filePath: str(row.file_path), agent: str(row.agent_id), reason: str(row.reason), at: zeitText(row.created_at) })),
    },
  };
}

/** plan(search, art:tasks): semantisch, Treffer tragen Pin-Zahlen. */
export async function searchPlanTasks(project: string, query: string, status = ''): Promise<TaskSearchHit[]> {
  const parameter = new URLSearchParams({ query, alle: 'true', limit: '30' });
  if (status) parameter.set('status', status);
  const data = await holeJson(pfad(project) + '/plan-suche?' + parameter.toString(), 'Task-Suche');
  return list(data.results).map<TaskSearchHit>((row) => {
    const pins = (row.pins && typeof row.pins === 'object' ? row.pins : {}) as Roh;
    return {
      id: str(row.id),
      kurzId: str(row.kurz_id),
      title: str(row.title),
      status: str(row.status) || 'todo',
      priority: str(row.priority),
      planLabel: planLabel(row.plan as Roh | undefined),
      preview: str(row.vorschau),
      score: num(row.score),
      thoughtPins: num(pins.thoughts),
      versionPins: num(pins.dateiversionen),
      snoozed: row.zurueckgestellt === true,
    };
  });
}

export type WissensArt = 'regeln' | 'fehler' | 'muster' | 'kontext';

export interface AgentKnowledge {
  agent: string;
  text: string;
  meta: Array<{ label: string; value: string }>;
  arten: Array<{ art: WissensArt; text: string; count: number }>;
  systemPromptLength: number;
  empty: boolean;
  warnings: string[];
}

/** Agenten des Projekts (Wrapper-Status), Auswahl fuer den Reiter Agentenwissen. */
export async function loadKnowledgeAgents(project: string): Promise<string[]> {
  const data = await holeJson(pfad(project) + '/agents', 'Agenten');
  return [...new Set(list(data.agents).map((row) => str(row.agent_name)).filter(Boolean))].sort();
}

/** GET specialists/:specName/wissen; null = zu diesem Agenten ist kein Wissen hinterlegt (404). */
export async function loadAgentKnowledge(project: string, agent: string): Promise<AgentKnowledge | null> {
  const response = await apiFetch(pfad(project) + '/specialists/' + encodeURIComponent(agent) + '/wissen');
  if (response.status === 404) return null;
  const data = await response.json().catch(() => ({})) as Roh;
  if (!response.ok) {
    const fehler = data.error;
    throw new Error((typeof fehler === 'string' ? fehler : str((fehler as Roh | undefined)?.message)) || 'Agentenwissen HTTP ' + response.status);
  }
  const arten = (data.arten && typeof data.arten === 'object' ? data.arten : {}) as Record<string, Roh>;
  const meta = (data.meta && typeof data.meta === 'object' ? data.meta : {}) as Roh;
  return {
    agent,
    text: str(data.text),
    meta: Object.entries(meta).filter(([, value]) => typeof value === 'string' || typeof value === 'number').map(([label, value]) => ({ label, value: String(value) })),
    arten: (['regeln', 'fehler', 'muster', 'kontext'] as WissensArt[]).map((art) => ({ art, text: str(arten[art]?.text), count: num(arten[art]?.anzahl) })),
    systemPromptLength: num(data.system_prompt_laenge),
    empty: data.leer === true,
    warnings: Array.isArray(data.warnungen) ? data.warnungen.filter((item): item is string => typeof item === 'string') : [],
  };
}

export async function loadMemoryList(project: string): Promise<MemoryEntry[]> {
  const data = await holeJson(pfad(project) + '/memories', 'Memories');
  return list(data.memories).filter((row) => str(row.name)).map<MemoryEntry>((row) => ({
    name: str(row.name),
    category: str(row.category) || 'other',
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sizeChars: num(row.sizeChars),
    updatedAt: zeitText(row.updatedAt),
  }));
}

/** Semantische Memory-Suche (POST memories/search); Treffer tragen Score und Vorschau. */
export async function searchMemoryEntries(project: string, query: string): Promise<MemoryEntry[]> {
  const data = await holeJson(pfad(project) + '/memories/search', 'Memory-Suche', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, limit: 20 }),
  });
  return list(data.results).filter((row) => str(row.name)).map<MemoryEntry>((row) => ({
    name: str(row.name),
    category: str(row.category) || 'other',
    tags: [],
    sizeChars: 0,
    updatedAt: '',
    score: num(row.score),
    preview: str(row.preview),
  }));
}

export async function loadMemoryContent(project: string, name: string): Promise<MemoryContent> {
  const data = await holeJson(pfad(project) + '/memories/' + encodeURIComponent(name), 'Memory');
  const memory = (data.memory && typeof data.memory === 'object' ? data.memory : {}) as Roh;
  return {
    name: str(memory.name) || name,
    category: str(memory.category) || 'other',
    tags: Array.isArray(memory.tags) ? memory.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    content: str(memory.content),
    linkedPaths: Array.isArray(memory.linkedPaths) ? memory.linkedPaths.filter((item): item is string => typeof item === 'string') : [],
    createdAt: zeitText(memory.createdAt),
    updatedAt: zeitText(memory.updatedAt),
  };
}
