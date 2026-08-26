import { apiFetch } from './auth';

export type AgentRuntimeName = 'codex' | 'claude';
export type RuntimeContainerStatus = 'not_created' | 'created' | 'running' | 'stopped' | 'error';
export type RuntimeAuthenticationStatus = 'authenticated' | 'not_authenticated' | 'unknown';

export interface AgentRuntimeStatus {
  runtime: AgentRuntimeName;
  role: 'main';
  configured: boolean;
  installed: boolean;
  rootPath: string;
  image: string;
  model?: string;
  container: {
    name: string;
    id: string | null;
    status: RuntimeContainerStatus;
  };
  authentication: {
    status: RuntimeAuthenticationStatus;
    method?: string;
  };
  version?: string | null;
  lastError?: string | null;
  assignedToMain: boolean;
}

export interface MainAgentRuntimeState {
  runtime: AgentRuntimeName | null;
  status: AgentRuntimeStatus | null;
}

export interface MainAgentSession {
  id: string;
  runtime: AgentRuntimeName;
  runtimeSessionId: string | null;
  status: 'ready';
  createdAt: string;
}

/**
 * Ein HTML-Block, den der Hauptagent ueber sein Artefakt-Werkzeug schickt.
 *
 * Die Feldnamen sind ABSICHTLICH identisch mit AgentHtmlBlock in
 * SynapseWorkspaceMock.tsx:92-102 — so muss auf dem ganzen Weg niemand
 * uebersetzen, und eine Umbenennung faellt sofort beim Uebersetzen auf.
 * Pflicht sind nur id und html; alles Weitere setzt die Empfangsseite als
 * Vorgabe, damit der Agent im ersten Schritt nur HTML schicken muss.
 * preview_path ist der Pfad des gerenderten PNG (Livebild). Er wird heute noch
 * NICHT angezeigt, steht aber von Anfang an im Format — sonst muesste es ein
 * zweites Mal geaendert werden, sobald das Livebild steht.
 */
export interface AgentArtifactEvent {
  id: string;
  html: string;
  title?: string;
  column?: number;
  columnSpan?: number;
  row?: number;
  rowSpan?: number;
  minHeight?: number;
  revision?: string | number;
  interactive?: boolean;
  preview_path?: string;
}

export interface RuntimeStreamHandlers {
  onReady?: (data: { sessionId: string; runtime: AgentRuntimeName }) => void;
  onRuntime?: (data: { event: unknown }) => void;
  onDelta?: (data: { content: string }) => void;
  /** Ein Artefakt-Block. EIN Ereignis je Block, nicht ein Ereignis je Antwort. */
  onArtifact?: (data: AgentArtifactEvent) => void;
  onUsage?: (data: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }) => void;
  /**
   * artifacts  = wie viele Bloecke der SERVER geschickt hat (er zaehlt sie beim
   *              Bauen des Stroms).
   * artefakteEmpfangen = wie viele hier ANGEKOMMEN sind.
   * Weichen die beiden ab, ist unterwegs etwas verloren gegangen. Das gehoert
   * sichtbar gemacht, nicht verschwiegen.
   */
  onDone?: (data: {
    sessionId?: string;
    runtimeSessionId?: string | null;
    context?: unknown;
    artifacts?: number;
    artefakteEmpfangen: number;
    unbekannteEreignisse: string[];
  }) => void;
  onError?: (data: { message: string }) => void;
}

export interface TerminalSessionHandle {
  runtime: AgentRuntimeName;
  sessionId: string;
}

export interface TerminalStreamHandlers {
  onConnected?: () => void;
  onOutput?: (data: string) => void;
  onExit?: (data: unknown) => void;
  onError?: (message: string) => void;
}

async function readError(response: Response): Promise<string> {
  const fallback = response.status + ' ' + response.statusText;
  try {
    const payload = await response.json() as { error?: string | { message?: string }; message?: string };
    if (typeof payload.error === 'string') return payload.error;
    if (payload.error && typeof payload.error.message === 'string') return payload.error.message;
    return typeof payload.message === 'string' ? payload.message : fallback;
  } catch {
    return fallback;
  }
}

async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await apiFetch(url, { ...init, headers });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<T>;
}

async function consumeSse(
  response: Response,
  onEvent: (event: string, data: unknown) => void,
): Promise<void> {
  if (!response.ok) throw new Error(await readError(response));
  if (!response.body) throw new Error('Der Server hat keinen Stream geöffnet.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (block: string) => {
    let event = 'message';
    const dataLines: string[] = [];
    block.split('\n').forEach((line) => {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    });
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    try {
      onEvent(event, JSON.parse(raw));
    } catch {
      onEvent(event, raw);
    }
  };

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      dispatch(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) dispatch(buffer);
}

export async function listAgentRuntimes(): Promise<{ drivers: Array<{ runtime: AgentRuntimeName; label: string }>; instances: AgentRuntimeStatus[] }> {
  const payload = await jsonRequest<{ success: true; drivers: Array<{ runtime: AgentRuntimeName; label: string }>; instances: AgentRuntimeStatus[] }>('/api/agent-runtimes');
  return { drivers: payload.drivers, instances: payload.instances };
}

export async function getAgentRuntimeStatus(runtime: AgentRuntimeName = 'codex'): Promise<AgentRuntimeStatus> {
  const payload = await jsonRequest<{ success: true; status: AgentRuntimeStatus }>('/api/agent-runtimes/' + runtime + '/status');
  return payload.status;
}

export async function configureAgentRuntime(
  runtime: AgentRuntimeName,
  config: { rootPath: string; image?: string; model?: string },
): Promise<AgentRuntimeStatus> {
  const payload = await jsonRequest<{ success: true; status: AgentRuntimeStatus }>('/api/agent-runtimes/' + runtime + '/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  });
  return payload.status;
}

export async function controlAgentRuntime(
  runtime: AgentRuntimeName,
  action: 'setup' | 'start' | 'stop',
): Promise<AgentRuntimeStatus> {
  const payload = await jsonRequest<{ success: true; status: AgentRuntimeStatus }>('/api/agent-runtimes/' + runtime + '/' + action, { method: 'POST' });
  return payload.status;
}

export async function getMainAgentRuntime(): Promise<MainAgentRuntimeState> {
  const payload = await jsonRequest<{ success: true } & MainAgentRuntimeState>('/api/main-agent/runtime');
  return { runtime: payload.runtime, status: payload.status };
}

export async function assignMainAgentRuntime(runtime: AgentRuntimeName | null): Promise<MainAgentRuntimeState> {
  const payload = await jsonRequest<{ success: true } & MainAgentRuntimeState>('/api/main-agent/runtime', {
    method: 'PUT',
    body: JSON.stringify({ runtime }),
  });
  return { runtime: payload.runtime, status: payload.status };
}

export async function createMainAgentSession(runtime: AgentRuntimeName = 'codex'): Promise<MainAgentSession> {
  const payload = await jsonRequest<{ success: true; session: MainAgentSession }>('/api/main-agent/sessions', {
    method: 'POST',
    body: JSON.stringify({ runtime }),
  });
  return payload.session;
}

export async function streamMainAgentMessage(
  sessionId: string,
  message: string,
  handlers: RuntimeStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await apiFetch('/api/main-agent/sessions/' + encodeURIComponent(sessionId) + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message }),
    signal,
  });
  let streamError = '';
  // ⚠️ MITZAEHLEN, WAS ANKOMMT — UND WAS NIEMAND KENNT.
  // Bis zum 26.08.2026 hatte diese Kette KEINEN else-Zweig: ein unbekanntes
  // Ereignis fiel spurlos heraus. Fuer Artefakte waere das die teuerste Form
  // gewesen — der Agent SCHICKT ein Artefakt, der Nutzer sieht Fliesstext, und
  // nichts sagt, dass etwas verloren ging. Der Nutzer haette geschlossen "der
  // Hauptagent kann kein HTML", obwohl er es konnte.
  // Beide Zaehler sind beim `done` vollstaendig, weil der Server es zuletzt
  // schickt; kommt es frueher, ist die Zahl zu klein und meldet lieber einmal
  // zu viel als einmal zu wenig.
  let artefakteEmpfangen = 0;
  const unbekannteEreignisse: string[] = [];
  await consumeSse(response, (event, data) => {
    const value = data as any;
    if (event === 'ready') handlers.onReady?.(value);
    else if (event === 'runtime') handlers.onRuntime?.(value);
    else if (event === 'delta') handlers.onDelta?.(value);
    else if (event === 'artifact') {
      artefakteEmpfangen += 1;
      handlers.onArtifact?.(value);
    }
    else if (event === 'usage') handlers.onUsage?.(value);
    else if (event === 'done') {
      handlers.onDone?.({
        ...(value && typeof value === 'object' ? value : {}),
        artefakteEmpfangen,
        unbekannteEreignisse,
      });
    }
    else if (event === 'error') {
      const failure = typeof value === 'string' ? { message: value } : value;
      streamError = failure?.message || 'Unbekannter Runtime-Fehler';
      handlers.onError?.({ message: streamError });
    }
    else if (!unbekannteEreignisse.includes(event)) unbekannteEreignisse.push(event);
  });
  if (streamError) throw new Error(streamError);
}

export async function createTerminalSession(
  runtime: AgentRuntimeName = 'codex',
  options: { cols?: number; rows?: number; command?: string } = {},
): Promise<TerminalSessionHandle> {
  const payload = await jsonRequest<{ success: true; sessionId: string }>('/api/agent-runtimes/' + runtime + '/terminal/sessions', {
    method: 'POST',
    body: JSON.stringify(options),
  });
  return { runtime, sessionId: payload.sessionId };
}

export async function streamTerminalSession(
  session: TerminalSessionHandle,
  handlers: TerminalStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await apiFetch('/api/agent-runtimes/' + session.runtime + '/terminal/sessions/' + encodeURIComponent(session.sessionId) + '/events', {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  await consumeSse(response, (event, data) => {
    const value = data as any;
    if (event === 'connected') handlers.onConnected?.();
    else if (event === 'output') handlers.onOutput?.(typeof value === 'string' ? value : value?.data || '');
    else if (event === 'exit') handlers.onExit?.(value);
    else if (event === 'error') handlers.onError?.(typeof value === 'string' ? value : value?.message || 'Terminalfehler');
  });
}

export async function sendTerminalInput(session: TerminalSessionHandle, data: string): Promise<void> {
  await jsonRequest('/api/agent-runtimes/' + session.runtime + '/terminal/sessions/' + encodeURIComponent(session.sessionId) + '/input', {
    method: 'POST',
    body: JSON.stringify({ data }),
  });
}

export async function resizeTerminalSession(session: TerminalSessionHandle, cols: number, rows: number): Promise<void> {
  await jsonRequest('/api/agent-runtimes/' + session.runtime + '/terminal/sessions/' + encodeURIComponent(session.sessionId) + '/resize', {
    method: 'POST',
    body: JSON.stringify({ cols, rows }),
  });
}

export async function closeTerminalSession(session: TerminalSessionHandle): Promise<void> {
  await jsonRequest('/api/agent-runtimes/' + session.runtime + '/terminal/sessions/' + encodeURIComponent(session.sessionId), { method: 'DELETE' });
}
