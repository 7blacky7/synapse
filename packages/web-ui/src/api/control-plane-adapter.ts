import {
  getChannelFeed,
  getChannels,
  getProjects,
  getSpecialists,
  postChannelMessage,
} from './synapse-client';
import { apiFetch } from './auth';
import type {
  AgentHerkunftViewModel,
  OnlineCoordinatorViewModel,
  ChannelMemberViewModel,
  ChannelMessageViewModel,
  ChannelViewModel,
  EntityViewModel,
  PersonalArtifactViewModel,
  PersonalMemoryViewModel,
  ProjectKnowledgeEntryViewModel,
  ProjectKnowledgeKind,
  ProjectTeamAgentViewModel,
  ProjectViewModel,
  ProjectWorkspaceViewModel,
  ToolCallViewModel,
} from '../control-plane/view-model';

interface WatcherProject {
  name?: unknown;
  pfad?: unknown;
  enabled?: unknown;
  running?: unknown;
}

interface WatcherProjectsResponse {
  projekte?: WatcherProject[];
}

interface WatcherChannel {
  name?: unknown;
  project?: unknown;
  description?: unknown;
  letzte_aktivitaet?: unknown;
}

interface WatcherChannelMessage {
  metadata?: unknown;
  id?: unknown;
  sender?: unknown;
  content?: unknown;
  createdAt?: unknown;
}

interface WatcherChannelsResponse {
  channels?: WatcherChannel[];
}

interface WatcherFeedResponse {
  messages?: WatcherChannelMessage[];
}

function channelAbsender(sender: unknown, metadata: unknown): string {
  const h = (metadata as { herkunft?: { akteur?: string; kanal?: string } } | undefined)?.herkunft;
  if (h?.akteur === 'user' && (h.kanal === 'tray' || h.kanal === 'web-ui-chat')) return h.kanal === 'tray' ? 'User (Tray)' : 'User (Web-UI)';
  return typeof sender === 'string' && sender ? sender : 'unbekannt';
}

const RELATION_SUFFIX = /_(code|memories|thoughts|plans|proposals|docs|media)$/i;

function cleanName(value: string): string {
  return value.trim();
}

function canonicalCollectionName(value: string): string {
  return cleanName(value).replace(RELATION_SUFFIX, '');
}

function validProjectName(value: string): boolean {
  return Boolean(value && value !== 'undefined' && value !== '[object Object]');
}

async function watcherRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch('/watcher-api' + path, {
    cache: 'no-store',
    ...init,
  });

  // Den GoTray-Daemon gibt es nur dort, wo die Oberflaeche neben ihm laeuft;
  // im Entwicklungsserver reicht ein Proxy den Pfad an ihn weiter. Auf dem
  // Server ohne Daemon kennt niemand /watcher-api — beantwortet wird er
  // trotzdem, naemlich mit der index.html der Oberflaeche: Status 200,
  // Inhalt HTML.
  //
  // Genau daran ist der Rueckfall auf die REST-API gescheitert: 200 gilt als
  // Erfolg, das HTML scheitert still am JSON-Parsen und wird zum leeren
  // Objekt, und die Aufrufer lesen daraus eine leere Liste. Die Oberflaeche
  // zeigte dann weder Projekte noch Channels, ohne dass irgendwo ein Fehler
  // sichtbar wurde. Ein fehlender Dienst muss als Fehler ankommen, sonst
  // sieht "nicht erreichbar" aus wie "nichts vorhanden".
  const inhaltstyp = response.headers.get('content-type') || '';
  if (!inhaltstyp.toLowerCase().includes('application/json')) {
    throw new Error(
      'GoTray-API nicht verfuegbar — Antwort war ' + (inhaltstyp || 'ohne Typangabe'),
    );
  }

  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || 'GoTray-API HTTP ' + response.status);
  }
  return data;
}

async function loadWatcherProjects(): Promise<ProjectViewModel[]> {
  const data = await watcherRequest<WatcherProjectsResponse>('/projects');
  const unique = new Map<string, ProjectViewModel>();

  for (const row of data.projekte || []) {
    const name = typeof row.name === 'string' ? cleanName(row.name) : '';
    if (!validProjectName(name)) continue;
    unique.set(name, {
      name,
      path: typeof row.pfad === 'string' ? row.pfad : '',
      isActive: Boolean(row.enabled ?? row.running),
      source: 'api',
    });
  }

  return Array.from(unique.values());
}

async function loadRestFallbackProjects(): Promise<ProjectViewModel[]> {
  const rows = await getProjects();
  const unique = new Map<string, ProjectViewModel>();

  for (const row of rows) {
    const name = canonicalCollectionName(row.name);
    if (!validProjectName(name)) continue;
    const current = unique.get(name);
    unique.set(name, {
      name,
      path: current?.path || '',
      isActive: Boolean(row.isActive || current?.isActive),
      source: 'api',
    });
  }

  return Array.from(unique.values());
}

export async function loadProjectViewModels(): Promise<ProjectViewModel[]> {
  let rows: ProjectViewModel[];
  try {
    rows = await loadWatcherProjects();
  } catch {
    rows = await loadRestFallbackProjects();
  }

  return rows.sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.name.localeCompare(b.name, 'de');
  });
}

async function loadWatcherChannels(project: string): Promise<ChannelViewModel[]> {
  const data = await watcherRequest<WatcherChannelsResponse>(
    '/projects/' + encodeURIComponent(project) + '/channels',
  );
  return (data.channels || []).map((row, index) => ({
    id: index + 1,
    name: typeof row.name === 'string' ? cleanName(row.name) : '',
    project: typeof row.project === 'string' ? row.project : project,
    description: typeof row.description === 'string' && row.description
      ? row.description
      : 'Keine Beschreibung',
    createdBy: 'GoTray',
    createdAt: '',
    letzteAktivitaet: typeof row.letzte_aktivitaet === 'string' && row.letzte_aktivitaet ? row.letzte_aktivitaet : undefined,
    source: 'api' as const,
  })).filter((row) => Boolean(row.name));
}

export async function loadChannelViewModels(project: string): Promise<ChannelViewModel[]> {
  let rows: ChannelViewModel[];
  try {
    rows = await loadWatcherChannels(project);
  } catch {
    const fallback = await getChannels(project);
    rows = fallback.map((row) => ({
      id: row.id,
      name: cleanName(row.name),
      project: row.project || project,
      description: row.description || 'Keine Beschreibung',
      createdBy: row.createdBy || 'unbekannt',
      createdAt: row.createdAt || '',
      letzteAktivitaet: row.letzte_aktivitaet || undefined,
      source: 'api' as const,
    }));
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

async function loadWatcherMessages(
  project: string,
  channel: string,
): Promise<ChannelMessageViewModel[]> {
  const path = '/projects/' + encodeURIComponent(project)
    + '/channels/' + encodeURIComponent(channel) + '/feed?limit=100';
  const data = await watcherRequest<WatcherFeedResponse>(path);
  return (data.messages || []).map((row, index) => ({
    id: typeof row.id === 'number' ? row.id : index + 1,
    sender: channelAbsender(row.sender, row.metadata),
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    source: 'api' as const,
  }));
}

export async function loadChannelMessageViewModels(
  project: string,
  channel: string,
): Promise<ChannelMessageViewModel[]> {
  try {
    return await loadWatcherMessages(project, channel);
  } catch {
    const rows = await getChannelFeed(project, channel, 100);
    return rows.map((row) => ({
      id: row.id,
      sender: channelAbsender(row.sender, row.metadata),
      content: row.content,
      createdAt: row.createdAt,
      source: 'api',
    }));
  }
}

async function apiJson<T>(path: string, label: string): Promise<T> {
  const response = await apiFetch(path);
  const data = await response.json().catch(() => ({})) as T & {
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(message || label + ' HTTP ' + response.status);
  }
  return data;
}

function projectPath(project: string): string {
  return '/api/projects/' + encodeURIComponent(project);
}

interface ChannelMembersResponse {
  members?: Array<{
    agent?: unknown;
    identity_id?: unknown;
    mitglied?: unknown;
    aktiv?: unknown;
    nachrichten?: unknown;
    herkunft?: unknown;
  }>;
}

const HERKUNFTS_ARTEN = ['unraid', 'pc', 'sonstig', 'unbekannt'] as const;

function herkunftAus(value: unknown): AgentHerkunftViewModel {
  const roh = (value && typeof value === 'object' ? value : {}) as { art?: unknown; ort?: unknown };
  const art = HERKUNFTS_ARTEN.find((item) => item === roh.art) ?? 'unbekannt';
  return { art, ort: typeof roh.ort === 'string' && roh.ort ? roh.ort : null };
}

/** P8-T25: kurzes Kennzeichen, wo ein Agent laeuft. */
export function herkunftText(herkunft: AgentHerkunftViewModel): string {
  if (herkunft.art === 'unraid') return 'Unraid-Container' + (herkunft.ort ? ' · ' + herkunft.ort : '');
  if (herkunft.art === 'pc') return 'PC' + (herkunft.ort ? ' · ' + herkunft.ort : '');
  if (herkunft.art === 'sonstig') return herkunft.ort || 'sonstiger Ort';
  return 'unbekannt';
}

// Teilnehmer eines Channels: Mitglieder und Nur-Poster (holeChannelTeilnehmer).
// Der User schreibt als Absender 'user' ohne Identitaet; er ist kein Agent und
// bleibt deshalb aus der Agentenleiste draussen.
export async function loadChannelMemberViewModels(
  project: string,
  channel: string,
): Promise<ChannelMemberViewModel[]> {
  const data = await apiJson<ChannelMembersResponse>(
    projectPath(project) + '/channels/' + encodeURIComponent(channel) + '/members',
    'Channel-Teilnehmer',
  );
  return (data.members || [])
    .filter((row) => typeof row.agent === 'string' && row.agent)
    .filter((row) => !(row.agent === 'user' && !row.identity_id))
    .map<ChannelMemberViewModel>((row) => ({
      name: row.agent as string,
      identityId: typeof row.identity_id === 'string' && row.identity_id ? row.identity_id : undefined,
      role: row.mitglied === true ? 'Mitglied' : 'nur Beiträge',
      status: row.aktiv === true ? 'online' : 'idle',
      messages: typeof row.nachrichten === 'number' ? row.nachrichten : 0,
      herkunft: herkunftAus(row.herkunft),
      source: 'api',
    }));
}

interface OnlineKoordinatorenResponse {
  koordinatoren?: Array<{ project?: unknown; name?: unknown; identity_id?: unknown; letzte_aktivitaet?: unknown; herkunft?: unknown }>;
}

// P8-T25: Koordinatoren aller Projekte mit aktuellem Lebenszeichen (Seitenleiste).
export async function loadOnlineCoordinators(): Promise<OnlineCoordinatorViewModel[]> {
  const data = await apiJson<OnlineKoordinatorenResponse>('/api/koordinatoren/online', 'Koordinatoren');
  return (data.koordinatoren || []).filter((row) => text(row.identity_id)).map((row) => ({
    id: text(row.identity_id),
    name: text(row.name) || 'koordinator',
    project: text(row.project),
    lastActivity: zeit(row.letzte_aktivitaet),
    herkunft: herkunftAus(row.herkunft),
    source: 'api' as const,
  }));
}

interface ProjectAgentsResponse {
  agents?: Array<{ agent_name?: unknown; model?: unknown; status?: unknown; tokens_percent?: unknown; last_activity?: unknown }>;
}

interface ProjectPlanResponse {
  plan?: {
    name?: unknown;
    kurz_id?: unknown;
    tasks?: Array<{ id?: unknown; kurz_id?: unknown; title?: unknown; description?: unknown; status?: unknown; priority?: unknown }>;
  };
}

interface ProjectMemoriesResponse {
  memories?: Array<{ name?: unknown; category?: unknown; tags?: unknown; sizeChars?: unknown; updatedAt?: unknown }>;
}

interface ProjectThoughtsResponse {
  thoughts?: Array<{ id?: unknown; source?: unknown; content?: unknown; tags?: unknown; timestamp?: unknown; task_id?: unknown }>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function zeit(value: unknown): string {
  const raw = text(value);
  if (!raw) return '';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('de-DE');
}

const TASK_REIHENFOLGE: Record<string, number> = { in_progress: 0, todo: 1, blocked: 2, done: 3 };

// Lesende Projektdaten fuer die Unteransichten hinter dem Channel. Jede Art
// kommt aus ihrer vorhandenen REST-Route; nichts davon ist lokal erfunden.
export async function loadProjectKnowledgeEntries(
  project: string,
  kind: ProjectKnowledgeKind,
): Promise<ProjectKnowledgeEntryViewModel[]> {
  if (kind === 'agents') {
    const data = await apiJson<ProjectAgentsResponse>(projectPath(project) + '/agents', 'Projektagenten');
    return (data.agents || []).filter((row) => text(row.agent_name)).map((row) => ({
      id: 'agent:' + text(row.agent_name),
      title: text(row.agent_name),
      detail: [text(row.model) || 'Modell unbekannt', 'Kontext ' + (text(row.tokens_percent) || '0') + ' %', zeit(row.last_activity) ? 'letzte Aktivität ' + zeit(row.last_activity) : ''].filter(Boolean).join(' · '),
      status: text(row.status) || 'unbekannt',
      source: 'Wrapper-Status',
    }));
  }
  if (kind === 'tasks') {
    let data: ProjectPlanResponse;
    try {
      data = await apiJson<ProjectPlanResponse>(projectPath(project) + '/plan', 'Projektplan');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Kein Plan gefunden')) return [];
      throw error;
    }
    const planName = [text(data.plan?.kurz_id), text(data.plan?.name)].filter(Boolean).join(' ');
    return (data.plan?.tasks || [])
      .map((row, index) => ({ row, index }))
      .sort((a, b) => (TASK_REIHENFOLGE[text(a.row.status)] ?? 9) - (TASK_REIHENFOLGE[text(b.row.status)] ?? 9) || a.index - b.index)
      .map(({ row, index }) => ({
        id: 'task:' + (text(row.id) || index),
        title: [text(row.kurz_id), text(row.title)].filter(Boolean).join(' '),
        detail: text(row.description),
        status: text(row.status) || 'todo',
        source: 'Plan ' + (planName || 'aktiv') + (text(row.priority) ? ' · ' + text(row.priority) : ''),
      }));
  }
  if (kind === 'memories') {
    const data = await apiJson<ProjectMemoriesResponse>(projectPath(project) + '/memories', 'Projekt-Memories');
    return (data.memories || []).filter((row) => text(row.name)).map((row) => ({
      id: 'memory:' + text(row.name),
      title: text(row.name),
      detail: [Array.isArray(row.tags) && row.tags.length ? 'Tags: ' + row.tags.join(', ') : '', typeof row.sizeChars === 'number' ? row.sizeChars + ' Zeichen' : '', zeit(row.updatedAt) ? 'geändert ' + zeit(row.updatedAt) : ''].filter(Boolean).join('\n'),
      status: text(row.category) || 'other',
      source: 'Projekt-Memory',
    }));
  }
  if (kind === 'thoughts') {
    const data = await apiJson<ProjectThoughtsResponse>(projectPath(project) + '/thoughts?limit=50', 'Projekt-Thoughts');
    return (data.thoughts || []).map((row, index) => {
      const content = text(row.content);
      return {
        id: 'thought:' + (text(row.id) || index),
        title: content.split('\n').find((line) => line.trim())?.trim().slice(0, 120) || 'Thought',
        detail: content,
        status: zeit(row.timestamp) || (Array.isArray(row.tags) ? row.tags.join(', ') : ''),
        source: 'Thought · ' + (text(row.source) || 'unbekannt') + (text(row.task_id) ? ' · ' + text(row.task_id) : ''),
      };
    });
  }
  const calls = await loadToolCallViewModels(project, 50);
  return calls.reverse().map((call) => ({
    id: 'call:' + call.id,
    title: call.tool + (call.action ? '.' + call.action : ''),
    detail: [call.argsPreview, call.error || call.resultPreview].filter(Boolean).join('\n\n'),
    status: call.status + (call.createdAt ? ' · ' + zeit(call.createdAt) : ''),
    source: 'Tool-Aufruf · ' + call.agent,
  }));
}

// P8-T25: Projekt-Agententeam aus wrapper_status (GET specialists).
export async function loadProjectTeamViewModels(project: string): Promise<ProjectTeamAgentViewModel[]> {
  const data = await getSpecialists(project);
  return Object.values(data.specialists || {}).map((row) => ({
    name: row.name,
    model: row.modelFullId || row.model || '',
    status: row.status || 'unbekannt',
    contextPercent: row.tokens?.percent ?? 0,
    tokensIn: row.tokens?.input ?? 0,
    tokensOut: row.tokens?.output ?? 0,
    channels: Array.isArray(row.channels) ? row.channels : [],
    currentTask: row.currentTask || '',
    busy: row.busy === true,
    provider: row.provider || '',
    lastActivity: row.lastActivity || '',
    source: 'api' as const,
  })).sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
}

// P8-T25: Agenten aller aktiven Projekte (Einstellungen · Alle Agenten). Ein
// Projekt, dessen Abfrage scheitert, faellt heraus und wird gezaehlt.
export async function loadAllAgentViewModels(): Promise<{ agents: Array<ProjectTeamAgentViewModel & { project: string }>; fehlgeschlagen: number }> {
  const projekte = (await loadProjectViewModels()).filter((row) => row.isActive);
  const ergebnisse = await Promise.allSettled(projekte.map(async (row) => (await loadProjectTeamViewModels(row.name)).map((agent) => ({ ...agent, project: row.name }))));
  const agents = ergebnisse.flatMap((ergebnis) => ergebnis.status === 'fulfilled' ? ergebnis.value : []);
  return { agents, fehlgeschlagen: ergebnisse.filter((ergebnis) => ergebnis.status === 'rejected').length };
}

interface WorkspacesResponse {
  docker_available?: unknown;
  workspaces?: Array<{
    project?: unknown; name?: unknown; status?: unknown; image?: unknown; cpuLimit?: unknown; memLimitMb?: unknown;
    tmpfsMb?: unknown; pinned?: unknown; lastActivityAt?: unknown; lastStartedAt?: unknown; lastStoppedAt?: unknown; lastError?: unknown;
  }>;
}

// P8-T25: Workspaces des Projekts aus project_workspaces (GET /api/workspaces).
export async function loadProjectWorkspaceViewModels(project: string): Promise<ProjectWorkspaceViewModel[]> {
  return (await loadAllWorkspaceViewModels()).filter((row) => row.project === project);
}

// P8-T25: alle Workspaces aller Projekte (Einstellungen · Alle Workspaces).
export async function loadAllWorkspaceViewModels(): Promise<ProjectWorkspaceViewModel[]> {
  const data = await apiJson<WorkspacesResponse>('/api/workspaces', 'Workspaces');
  const docker = data.docker_available === true;
  return (data.workspaces || []).filter((row) => text(row.project)).map((row) => ({
    id: text(row.project) + '::' + (text(row.name) || 'main'),
    name: text(row.name) || 'main',
    project: text(row.project),
    status: text(row.status) || 'unbekannt',
    image: text(row.image),
    cpuLimit: typeof row.cpuLimit === 'number' ? row.cpuLimit : 0,
    memLimitMb: typeof row.memLimitMb === 'number' ? row.memLimitMb : 0,
    tmpfsMb: typeof row.tmpfsMb === 'number' ? row.tmpfsMb : 0,
    pinned: row.pinned === true,
    lastActivityAt: zeit(row.lastActivityAt),
    lastStartedAt: zeit(row.lastStartedAt),
    lastStoppedAt: zeit(row.lastStoppedAt),
    lastError: text(row.lastError),
    dockerAvailable: docker,
    source: 'api' as const,
  }));
}

interface StatusResponse {
  status?: { server?: unknown; qdrant?: unknown; embeddings?: unknown; collections?: unknown; timestamp?: unknown };
}

// P8-T25: Systemstatus aus GET /api/status statt erfundener Zeilen.
export async function loadSystemEntities(): Promise<EntityViewModel[]> {
  const data = await apiJson<StatusResponse>('/api/status', 'Systemstatus');
  const status = data.status ?? {};
  const gemessen = zeit(status.timestamp) || '–';
  const zeile = (id: string, title: string, wert: string, ok: boolean): EntityViewModel => ({
    id,
    title,
    subtitle: wert,
    status: ok ? 'in Ordnung' : 'gestört',
    statusTone: ok ? 'ready' : 'offline',
    source: 'api',
    details: [
      { label: 'Wert', value: wert },
      { label: 'Gemessen', value: gemessen },
      { label: 'Quelle', value: 'GET /api/status' },
    ],
  });
  const embeddings = text(status.embeddings) || 'nicht verfuegbar';
  const collections = typeof status.collections === 'number' ? status.collections : 0;
  return [
    zeile('server', 'API-Server', text(status.server) || 'unbekannt', status.server === 'running'),
    zeile('qdrant', 'Qdrant', text(status.qdrant) || 'unbekannt', status.qdrant === 'connected'),
    zeile('embeddings', 'Embedding-Provider', embeddings, embeddings !== 'nicht verfuegbar'),
    zeile('collections', 'Collections', String(collections), collections > 0),
  ];
}

// P8-T25: Compute-Policy des Projekts; null heisst "keine eigene gesetzt".
export async function loadComputePolicy(project: string): Promise<Record<string, unknown> | null> {
  const data = await apiJson<{ policy?: unknown }>('/api/projects/' + encodeURIComponent(project) + '/compute-policy', 'Compute-Policy');
  return data.policy && typeof data.policy === 'object' ? data.policy as Record<string, unknown> : null;
}

/**
 * P8-T25: Der persoenliche Bereich gehoert dem Hauptagenten. Seine Memories
 * liegen im virtuellen Projekt des Hauptagenten (HAUPTAGENT_PROJEKT im Core),
 * nicht im gerade gewaehlten Projekt.
 */
export const PERSOENLICHES_PROJEKT = 'synapse-hauptagent';

export async function loadPersonalMemories(): Promise<PersonalMemoryViewModel[]> {
  const data = await apiJson<ProjectMemoriesResponse>(projectPath(PERSOENLICHES_PROJEKT) + '/memories', 'Meine Memories');
  return (data.memories || []).filter((row) => text(row.name)).map((row) => ({
    name: text(row.name),
    category: text(row.category) || 'other',
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    sizeChars: typeof row.sizeChars === 'number' ? row.sizeChars : 0,
    updatedAt: zeit(row.updatedAt),
    source: 'api' as const,
  }));
}

export async function loadPersonalMemoryContent(name: string): Promise<string> {
  const data = await apiJson<{ memory?: { content?: unknown } }>(projectPath(PERSOENLICHES_PROJEKT) + '/memories/' + encodeURIComponent(name), 'Memory');
  return text(data.memory?.content);
}

interface ArtefakteResponse {
  artefakte?: Array<{ id?: unknown; title?: unknown; revision?: unknown; htmlZeichen?: unknown; createdBy?: unknown; sessionId?: unknown; updatedAt?: unknown }>;
}

// P8-T25: HTML-Artefakte des Hauptagenten (agent_artifacts, artefakt-Tool).
export async function loadPersonalArtifacts(): Promise<PersonalArtifactViewModel[]> {
  const data = await apiJson<ArtefakteResponse>('/api/main-agent/artefakte?limit=200', 'Artefakte');
  return (data.artefakte || []).filter((row) => text(row.id)).map((row) => ({
    id: text(row.id),
    title: text(row.title) || 'Ohne Titel',
    revision: typeof row.revision === 'number' ? row.revision : 1,
    htmlChars: typeof row.htmlZeichen === 'number' ? row.htmlZeichen : 0,
    createdBy: text(row.createdBy) || 'Hauptagent',
    sessionId: text(row.sessionId),
    updatedAt: zeit(row.updatedAt),
    source: 'api' as const,
  }));
}

export async function loadPersonalArtifactHtml(id: string): Promise<{ html: string; revision: number }> {
  const data = await apiJson<{ artefakt?: { html?: unknown; revision?: unknown } }>('/api/main-agent/artefakte/' + encodeURIComponent(id), 'Artefakt');
  return { html: text(data.artefakt?.html), revision: typeof data.artefakt?.revision === 'number' ? data.artefakt.revision : 1 };
}

export async function sendChannelMessage(
  project: string,
  channel: string,
  content: string,
  sender = 'synapse-web-ui',
): Promise<void> {
  await postChannelMessage(project, channel, content, sender);
}

interface ToolCallResponseRow {
  id?: unknown;
  ts?: unknown;
  project?: unknown;
  agent_id?: unknown;
  tool_name?: unknown;
  action?: unknown;
  args_preview?: unknown;
  ok?: unknown;
  error?: unknown;
  duration_ms?: unknown;
  result_preview?: unknown;
}

interface ToolCallsResponse {
  calls?: ToolCallResponseRow[];
}

export async function loadToolCallViewModels(
  project: string,
  limit = 12,
): Promise<ToolCallViewModel[]> {
  return ladeToolCallListe('/api/projects/' + encodeURIComponent(project) + '/tool-calls?limit=' + limit);
}

/**
 * P8-T26: NUR die Aufrufe des Hauptagenten (projektuebergreifend, Server filtert nach seiner Identitaet).
 * Fuer Main-Chat und Arbeitsraum; dort erscheinen nie Projektaufrufe anderer Agenten.
 */
export async function loadMainAgentToolCallViewModels(limit = 12): Promise<ToolCallViewModel[]> {
  return ladeToolCallListe('/api/main-agent/tool-calls?limit=' + limit);
}

async function ladeToolCallListe(pfad: string): Promise<ToolCallViewModel[]> {
  const response = await apiFetch(pfad);
  const data = await response.json().catch(() => ({})) as ToolCallsResponse & {
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(message || 'Toolaktivität HTTP ' + response.status);
  }

  return (data.calls || []).map<ToolCallViewModel>((row) => ({
    id: String(row.id || ''),
    ...(typeof row.project === 'string' && row.project ? { project: row.project } : {}),
    tool: typeof row.tool_name === 'string' ? row.tool_name : 'tool',
    action: typeof row.action === 'string' ? row.action : '',
    agent: typeof row.agent_id === 'string' && row.agent_id ? row.agent_id : 'unbekannt',
    status: row.ok === false ? 'failed' : row.ok === true ? 'done' : 'running',
    argsPreview: typeof row.args_preview === 'string' ? row.args_preview : '',
    resultPreview: typeof row.result_preview === 'string' ? row.result_preview : '',
    error: typeof row.error === 'string' ? row.error : '',
    durationMs: typeof row.duration_ms === 'number' ? row.duration_ms : 0,
    createdAt: typeof row.ts === 'string' ? row.ts : '',
    source: 'api',
  })).reverse();
}

interface ToolCallDetailResponse {
  call?: ToolCallResponseRow & { result?: unknown };
  error?: { message?: string } | string;
}

export async function loadToolCallResult(project: string, id: string): Promise<string> {
  return ladeToolCallErgebnis('/api/projects/' + encodeURIComponent(project) + '/tool-calls/' + encodeURIComponent(id));
}

/** P8-T26: volles Ergebnis eines Hauptagenten-Aufrufs (Server prueft, dass er dem Hauptagenten gehoert). */
export async function loadMainAgentToolCallResult(id: string): Promise<string> {
  return ladeToolCallErgebnis('/api/main-agent/tool-calls/' + encodeURIComponent(id));
}

async function ladeToolCallErgebnis(pfad: string): Promise<string> {
  const response = await apiFetch(pfad);
  const data = await response.json().catch(() => ({})) as ToolCallDetailResponse;
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(message || 'Toolausgabe HTTP ' + response.status);
  }
  const value = data.call?.result ?? data.call?.error ?? data.call?.result_preview ?? '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}