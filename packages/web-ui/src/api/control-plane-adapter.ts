import {
  getChannelFeed,
  getChannels,
  getProjects,
  postChannelMessage,
} from './synapse-client';
import { apiFetch } from './auth';
import type {
  ChannelMessageViewModel,
  ChannelViewModel,
  ProjectViewModel,
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
}

interface WatcherChannelMessage {
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
    sender: typeof row.sender === 'string' && row.sender ? row.sender : 'unbekannt',
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
      sender: row.sender || 'unbekannt',
      content: row.content,
      createdAt: row.createdAt,
      source: 'api',
    }));
  }
}

export async function sendChannelMessage(
  project: string,
  channel: string,
  content: string,
  sender = 'synapse-web-ui',
): Promise<void> {
  const path = '/projects/' + encodeURIComponent(project)
    + '/channels/' + encodeURIComponent(channel) + '/post';
  try {
    await watcherRequest(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, sender }),
    });
  } catch (watcherError) {
    try {
      await postChannelMessage(project, channel, content, sender);
    } catch {
      throw watcherError;
    }
  }
}

interface ToolCallResponseRow {
  id?: unknown;
  ts?: unknown;
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
  const response = await apiFetch(
    '/api/projects/' + encodeURIComponent(project) + '/tool-calls?limit=' + limit,
  );
  const data = await response.json().catch(() => ({})) as ToolCallsResponse & {
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(message || 'Toolaktivität HTTP ' + response.status);
  }

  return (data.calls || []).map<ToolCallViewModel>((row) => ({
    id: String(row.id || ''),
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
  const response = await apiFetch(
    '/api/projects/' + encodeURIComponent(project) + '/tool-calls/' + encodeURIComponent(id),
  );
  const data = await response.json().catch(() => ({})) as ToolCallDetailResponse;
  if (!response.ok) {
    const message = typeof data.error === 'string' ? data.error : data.error?.message;
    throw new Error(message || 'Toolausgabe HTTP ' + response.status);
  }
  const value = data.call?.result ?? data.call?.error ?? data.call?.result_preview ?? '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}