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
  image?: string;
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
  image?: string,
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
      image: image || undefined,
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
