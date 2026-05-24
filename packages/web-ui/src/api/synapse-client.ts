/**
 * Synapse Web-UI API Client
 * Kommuniziert mit der REST-API
 */

const API_BASE = '/api';

export interface ProjectInfo {
  name: string;
  isActive: boolean;
}

/**
 * Holt alle verfuegbaren Projekte
 */
export async function getProjects(): Promise<ProjectInfo[]> {
  const response = await fetch(`${API_BASE}/projects`);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = await response.json();
  const activeWatchers = new Set(data.activeWatchers || []);

  return (data.projects || []).map((name: string) => ({
    name,
    isActive: activeWatchers.has(name),
  }));
}

/**
 * Initialisiert ein Projekt
 */
export async function initProject(path: string, name?: string): Promise<{ project: string; message: string }> {
  const response = await fetch(`${API_BASE}/projects/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, name }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP ${response.status}`);
  }

  return response.json();
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  context?: Array<{
    source: string;
    preview: string;
  }>;
  timestamp: string;
}

export interface ChatResponse {
  message: string;
  sessionId: string;
  context?: Array<{
    source: string;
    preview: string;
  }>;
}

export interface MemoryResult {
  name: string;
  project: string;
  content: string;
  category: string;
  tags: string[];
  score: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Sendet eine Chat-Nachricht an die API
 */
export async function sendChatMessage(
  message: string,
  project?: string,
  _image?: string,
  sessionId?: string
): Promise<ChatResponse> {
  const response = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message,
      project: project || undefined,
      sessionId: sessionId || undefined,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unbekannter Fehler' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Durchsucht Memories semantisch
 */
export async function searchMemories(
  query: string,
  project?: string,
  limit: number = 10
): Promise<MemoryResult[]> {
  const params = new URLSearchParams({
    query,
    limit: limit.toString(),
  });

  if (project) {
    params.set('project', project);
  }

  const response = await fetch(`${API_BASE}/memory/search?${params}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unbekannter Fehler' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.results || [];
}

/**
 * Holt alle Memories eines Projekts
 */
export async function listMemories(
  project: string,
  category?: string
): Promise<MemoryResult[]> {
  const params = new URLSearchParams({ project });

  if (category) {
    params.set('category', category);
  }

  const response = await fetch(`${API_BASE}/memory/list?${params}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unbekannter Fehler' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  const data = await response.json();
  return data.memories || [];
}

/**
 * Speichert ein neues Memory
 */
export async function saveMemory(
  project: string,
  name: string,
  content: string,
  category: string = 'note',
  tags: string[] = []
): Promise<MemoryResult> {
  const response = await fetch(`${API_BASE}/memory`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      project,
      name,
      content,
      category,
      tags,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unbekannter Fehler' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

/**
 * Loescht ein Memory
 */
export async function deleteMemory(
  project: string,
  name: string
): Promise<void> {
  const response = await fetch(
    `${API_BASE}/memory/${encodeURIComponent(project)}/${encodeURIComponent(name)}`,
    {
      method: 'DELETE',
    }
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unbekannter Fehler' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
}

/**
 * Durchsucht Code semantisch
 */
export async function searchCode(
  query: string,
  project: string,
  fileType?: string,
  limit: number = 10
): Promise<Array<{
  filePath: string;
  fileName: string;
  fileType: string;
  content: string;
  lineStart: number;
  lineEnd: number;
  score: number;
}>> {
  const params = new URLSearchParams({
    query,
    project,
    limit: limit.toString(),
  });

  if (fileType) {
    params.set('fileType', fileType);
  }

  const response = await fetch(`${API_BASE}/code/search?${params}`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unbekannter Fehler' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.results || [];
}

export interface SpecialistInfo {
  name: string;
  model: string;
  status: 'running' | 'idle' | 'crashed' | 'stopped' | 'stale';
  pid: number;
  wrapperPid: number;
  socket: string;
  tokens: {
    input: number;
    output: number;
    percent: number;
  };
  contextCeiling: number;
  lastActivity: string;
  channels: string[];
  currentTask: string | null;
  busy: boolean;
  provider: string | null;
  modelFullId: string | null;
}

export interface SpecialistListResponse {
  success: boolean;
  project: string;
  specialists: Record<string, SpecialistInfo>;
  runningCount: number;
  lastUpdate: string;
}

/**
 * Holt alle Spezialisten eines Projekts
 */
export async function getSpecialists(project: string): Promise<SpecialistListResponse> {
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/specialists`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Spawnt einen neuen Spezialisten
 */
export async function spawnSpecialist(
  project: string,
  name: string,
  model: string,
  cwd?: string,
  allowedTools?: string[]
): Promise<any> {
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/specialists/spawn`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, model, cwd, allowedTools }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || error.message || `HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Stoppt einen Spezialisten
 */
export async function stopSpecialist(project: string, specName: string): Promise<any> {
  const response = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(project)}/specialists/${encodeURIComponent(specName)}/stop`,
    { method: 'POST' }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || error.message || `HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Bereinigt einen Spezialisten
 */
export async function purgeSpecialist(project: string, specName: string): Promise<any> {
  const response = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(project)}/specialists/${encodeURIComponent(specName)}/purge`,
    { method: 'POST' }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || error.message || `HTTP ${response.status}`);
  }
  return response.json();
}

/**
 * Weckt einen Spezialisten
 */
export async function wakeSpecialist(project: string, specName: string, message: string): Promise<any> {
  const response = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(project)}/specialists/${encodeURIComponent(specName)}/wake`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || error.message || `HTTP ${response.status}`);
  }
  return response.json();
}

export interface ChannelInfo {
  id: number;
  name: string;
  project: string;
  description: string | null;
  createdBy: string | null;
  createdAt: string;
}

/**
 * Holt alle Channels eines Projekts
 */
export async function getChannels(project: string): Promise<ChannelInfo[]> {
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/channels`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.channels || [];
}

export interface ChannelMessage {
  id: number;
  channelId: number;
  sender: string;
  content: string;
  metadata: any;
  createdAt: string;
}

/**
 * Holt den Feed eines Channels
 */
export async function getChannelFeed(project: string, channel: string, limit?: number): Promise<ChannelMessage[]> {
  const params = new URLSearchParams();
  if (limit) {
    params.set('limit', limit.toString());
  }
  const response = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(project)}/channels/${encodeURIComponent(channel)}/feed?${params}`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.messages || [];
}

/**
 * Postet eine Nachricht in einen Channel
 */
export async function postChannelMessage(
  project: string,
  channel: string,
  content: string,
  sender?: string
): Promise<any> {
  const response = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(project)}/channels/${encodeURIComponent(channel)}/post`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, sender }),
    }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || error.message || `HTTP ${response.status}`);
  }
  return response.json();
}

export interface WatcherEvent {
  id: string;
  project: string;
  event_type: string;
  file_path: string;
  details: any;
  created_at: string;
}

export interface FileVersion {
  id: string;
  project: string;
  file_path: string;
  content_hash: string;
  edit_action: string | null;
  agent_id: string | null;
  batch_id: string | null;
  size_bytes: number;
  created_at: string;
  reason: string | null;
  feature_tag?: string | null;
  parent_version_id?: string | null;
  git_commit_sha?: string | null;
  agent_note?: string | null;
}

/**
 * Holt die letzten Watcher-Events
 */
export async function getWatcherEvents(project: string, limit?: number): Promise<WatcherEvent[]> {
  const params = new URLSearchParams();
  if (limit) {
    params.set('limit', limit.toString());
  }
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/watcher-events?${params}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.events || [];
}

/**
 * Holt die letzten Datei-Versionen
 */
export async function getFileVersions(project: string, limit?: number): Promise<FileVersion[]> {
  const params = new URLSearchParams();
  if (limit) {
    params.set('limit', limit.toString());
  }
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/file-versions?${params}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.versions || [];
}

export interface SystemStatus {
  server: string;
  qdrant: string;
  embeddings: string;
  collections: number;
  timestamp: string;
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const response = await fetch(`${API_BASE}/status`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.status;
}

export interface DetailedStats {
  project: string;
  code: {
    totalChunks: number;
    byFileType: Record<string, number>;
  };
  thoughts: {
    total: number;
    bySource: Record<string, number>;
  };
  memories: {
    total: number;
    byCategory: Record<string, number>;
  };
}

export interface Thought {
  id: string;
  project: string;
  source: string;
  content: string;
  tags: string[];
  timestamp: string;
}

export async function getThoughts(project: string, limit: number = 50): Promise<Thought[]> {
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/thoughts?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.thoughts || [];
}

export async function getDetailedStats(project: string): Promise<DetailedStats> {
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/stats/detailed`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.stats;
}

export async function executeShellCommand(project: string, command: string): Promise<any> {
  const response = await fetch(`${API_BASE}/shell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'exec', project, command })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `HTTP ${response.status}`);
  }
  return response.json();
}

export async function getShellHistory(project: string): Promise<any> {
  const response = await fetch(`${API_BASE}/shell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'history', project })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

export async function callMcpTool(name: string, args: Record<string, any>): Promise<any> {
  const response = await fetch(`/mcp/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: 'tools/call',
      params: { name, arguments: args }
    })
  });
  if (!response.ok) {
    throw new Error(`MCP Error: HTTP ${response.status}`);
  }
  const res = await response.json();
  if (res.error) {
    throw new Error(res.error.message || JSON.stringify(res.error));
  }
  const text = res.result?.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return res.result;
}

export interface ToolCall {
  id: number;
  project: string;
  tool_name: string;
  action: string;
  source: string;
  args_preview: string;
  ok: boolean;
  ts: string;
}

export async function getToolCalls(project: string, limit?: number): Promise<ToolCall[]> {
  const params = new URLSearchParams();
  if (limit) {
    params.set('limit', limit.toString());
  }
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/tool-calls?${params}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.toolCalls || [];
}

export interface ProjectTask {
  id: string;
  title: string;
  description: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPlan {
  id: string;
  project: string;
  name: string;
  description: string;
  goals: string[];
  architecture?: string;
  tasks: ProjectTask[];
  createdAt: string;
  updatedAt: string;
}

export async function getProjectPlan(project: string): Promise<ProjectPlan> {
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/plan`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.plan;
}

export async function updateProjectPlan(
  project: string,
  updates: Partial<Pick<ProjectPlan, 'name' | 'description' | 'goals' | 'architecture'>>
): Promise<ProjectPlan> {
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/plan`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.plan;
}

export async function addProjectTask(
  project: string,
  title: string,
  description: string,
  priority?: 'low' | 'medium' | 'high'
): Promise<ProjectTask> {
  const response = await fetch(`${API_BASE}/projects/${encodeURIComponent(project)}/plan/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, description, priority }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.task;
}

export async function updateProjectTask(
  project: string,
  taskId: string,
  updates: Partial<Pick<ProjectTask, 'title' | 'description' | 'status' | 'priority'>>
): Promise<ProjectTask> {
  const response = await fetch(
    `${API_BASE}/projects/${encodeURIComponent(project)}/plan/tasks/${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.task;
}

export interface DocSearchResult {
  framework: string;
  version?: string;
  title: string;
  content: string;
  url?: string;
  score: number;
}

export async function searchDocs(
  query: string,
  framework?: string,
  limit: number = 10
): Promise<DocSearchResult[]> {
  const response = await fetch(`${API_BASE}/search/docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, framework, limit }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.results || [];
}

