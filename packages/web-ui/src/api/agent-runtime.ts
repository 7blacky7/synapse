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
  diagnostic?: { code: 'pid_limit' | 'probe_timeout' | 'probe_error'; message: string };
  assignedToMain: boolean;
  /** P22-T64: Bewertung des Status-Probe-Laufs (Debug). */
  pruefung?: RuntimeStatusPruefung;
}

/** P22-T64: letzter Probe-Lauf und ob ein bestaetigter guter Stand trotz haengender Pruefung gilt. */
export interface RuntimeStatusPruefung {
  schalter: { aktiv: boolean; quelle: string };
  letzter_lauf: { zeit: string; dauer_ms: number; ergebnis: string; eindeutig: boolean; meldung: string | null };
  quelle: 'frisch' | 'letzter_guter_stand';
  bestaetigt_am: string | null;
  alter_sekunden: number | null;
  haengt: boolean;
  negativ_in_folge: number;
  hinweis: string | null;
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

/**
 * P8-T25: ein Werkzeugaufruf des Hauptagenten (SSE-Event `tool`). start traegt
 * Name und Argumente, end das Ergebnis; beide teilen die id.
 */
export interface AgentToolEvent {
  phase: 'start' | 'end';
  id: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  /** P22-T67: Bilder im Ergebnis als Asset-Verweis (kein Base64); Anzeige ueber ladeToolBild. */
  bilder?: AgentToolBild[];
}

/** P22-T67: ein Bild eines Werkzeugergebnisses; project + file_path (+ revision) zeigen auf das Asset. */
export interface AgentToolBild {
  mime_type: string;
  bytes: number;
  project?: string;
  file_path?: string;
  revision?: string;
  breite?: number;
  hoehe?: number;
}

export interface RuntimeStreamHandlers {
  onReady?: (data: { sessionId: string; runtime: AgentRuntimeName }) => void;
  onRuntime?: (data: { event: unknown }) => void;
  onDelta?: (data: { content: string }) => void;
  /** Ein Artefakt-Block. EIN Ereignis je Block, nicht ein Ereignis je Antwort. */
  onArtifact?: (data: AgentArtifactEvent) => void;
  onTool?: (data: AgentToolEvent) => void;
  /** Denkphase des Agenten (SSE-Event `thinking`). */
  onThinking?: (data: { content: string }) => void;
  /** P22-T63: Server-IDs der beiden Verlaufszeilen dieses Turns (bzw. aus = Grund, warum nichts gespeichert wird). */
  onVerlauf?: (data: { user_id?: string; antwort_id?: string; aus?: string }) => void;
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
    /** P22-T73: Nachricht wartet serverseitig (Warteschlange); die Antwort kommt spaeter ueber den Verlauf. */
    wartet?: { art: 'warten' | 'einwurf'; grund: string; antwort_id: string };
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

/** P22-T61: ein Modell aus der Liste der CLI im Container (GET /api/agent-runtimes/:runtime/modelle). */
export interface CliModell {
  id: string;
  name: string;
  beschreibung: string | null;
  standard_effort: string | null;
  effort_stufen: string[];
  kontext_ein: number | null;
  kontext_aus: number | null;
  sichtbar: boolean;
  gruppe: string | null;
  /** P22-T62: claude runtime.family; codex null. */
  familie?: string | null;
  /** P22-T65: je Stufe Name und Hinweis der CLI (z. B. 'Recommended', '3.5× or more usage'). */
  effort_details?: Array<{ stufe: string; name: string | null; hinweis: string | null }>;
  standard: boolean;
}

/** P22-T61: ausgelesene Modellliste; leer + grund, wenn keine Quelle lesbar war (kein Rueckfall auf feste Listen). */
export interface CliModellListe {
  runtime: AgentRuntimeName;
  quelle: 'cli' | 'datei' | null;
  quelle_detail: string | null;
  stand: string | null;
  veraltet_ab: string | null;
  cli_version: string | null;
  modelle: CliModell[];
  hinweise: string[];
  grund: string | null;
  abgefragt_am: string;
  /** P22-T75: Abgleich gegen model_registry (nur Befunde; meldungen leer = alles stimmt). */
  registry_abgleich?: RegistryAbgleich | null;
}

/** P22-T75: Befund CLI-Liste <-> model_registry. */
export interface RegistryAbgleich {
  geprueft: boolean;
  grund: string | null;
  anzahl: { ok: number; fehlt_in_registry: number; kontext_abweichend: number; kontext_fehlt: number };
  registry_ohne_cli: string[];
  meldungen: string[];
}

/** P22-T62: Modelle beider CLI-Runtimes fuer die Hauptagent-Steuerung (GET /api/main-agent/modelle). */
export interface MainAgentModellRuntime {
  runtime: 'claude' | 'codex';
  label: string;
  bereit: boolean;
  zugewiesen: boolean;
  /** Warum keine Liste da ist (Container aus, nicht angemeldet, ...); null = Liste vorhanden. */
  grund: string | null;
  standard: { modell: string | null; quelle: 'schalter_aus' | 'user_wahl' | 'profil' | 'kleinstes' | 'keins'; grund: string | null; user_wahl: string | null };
  user_wahl: string | null;
  /** P22-T64: Status-Pruefung dieser Runtime (Debug). */
  pruefung?: RuntimeStatusPruefung | null;
  quelle: 'cli' | 'datei' | null;
  quelle_detail: string | null;
  stand: string | null;
  cli_version: string | null;
  hinweise: string[];
  /** modell = Synapse-ID fuer den Wechsel (codex: 'codex/<slug>'). */
  /** effort_wahl (P22-T65) = gespeicherte Stufe dieses Modells; sonst gilt standard_effort. */
  modelle: Array<CliModell & { modell: string; effort_wahl?: string | null }>;
}
export interface MainAgentModelle {
  schalter: { aktiv: boolean; quelle: string; bis: string | null; letzter_fehler: string | null };
  runtimes: MainAgentModellRuntime[];
}

export async function getMainAgentModelle(): Promise<MainAgentModelle> {
  const payload = await jsonRequest<{ success: true } & MainAgentModelle>('/api/main-agent/modelle');
  return { schalter: payload.schalter, runtimes: payload.runtimes };
}

export async function getAgentRuntimeModelle(runtime: AgentRuntimeName, neu = false): Promise<CliModellListe> {
  const payload = await jsonRequest<{ success: true; modelle: CliModellListe }>('/api/agent-runtimes/' + runtime + '/modelle' + (neu ? '?neu=1' : ''));
  return payload.modelle;
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
    else if (event === 'tool') handlers.onTool?.(value);
    else if (event === 'thinking') handlers.onThinking?.(value);
    else if (event === 'verlauf') handlers.onVerlauf?.(value);
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

/** P22-T63: ein Eintrag des Hauptagenten-Verlaufs (GET /api/main-agent/verlauf); Feldnamen wie core VerlaufEintrag. */
export interface MainAgentVerlaufEintrag {
  id: string;
  rolle: 'user' | 'agent' | 'nachricht' | 'ausgabe' | 'system';
  richtung: 'ein' | 'aus' | 'intern';
  weg: 'webui' | 'inbox' | 'chat' | 'channel' | 'event' | 'heartbeat' | 'werkzeug' | 'lauf' | 'wechsel';
  absender: { agent_id?: string; identity_id?: string | null; rolle?: string | null; project?: string | null; channel?: string | null } | null;
  /** jsonl:<ref> = Sitzungs-Eintrag des Wrappers (Zaehl-/Uebergabebasis, nicht als Chatnachricht gezeigt). */
  quelle_ref: string | null;
  zaehlt: boolean;
  antwort_auf: string | null;
  gehoert_zu: string | null;
  /** P22-T73: 'wartet' = Antwortzeile in der Warteschlange (meta.warteschlange.art/grund). */
  status: 'laeuft' | 'fertig' | 'fehler' | 'abgebrochen' | 'wartet';
  text: string;
  werkzeuge: {
    calls: Array<{ id: string; name?: string; input?: unknown; output?: unknown; isError?: boolean; bilder?: AgentToolBild[]; start: string; ende: string | null }>;
    phasen: string[];
  };
  tokens: {
    gemessen?: { input: number; output: number; cache_read: number; cache_creation: number; quelle: string } | null;
    berechnet?: Record<string, unknown> | null;
  };
  kontext: { tokens: number; quelle: string; modell: string; fenster: number; prozent: number; schwellen_quelle?: 'registry' | 'cli' | 'fallback' } | null;
  zug: { zuege: number | null; dauer_ms: number; kosten: { usd: number; quelle: string } | null } | null;
  modell: string | null;
  hauptagent_weg: string | null;
  lauf_id: string | null;
  artefakte: AgentArtifactEvent[];
  anhaenge: Array<{ name: string; typ: string | null; groesse: number | null }>;
  hinweise: string[];
  meta: Record<string, unknown>;
  session_id: string | null;
  runtime: string | null;
  geraet: string | null;
  rev: string;
  erstellt_am: string;
  aktualisiert_am: string;
}

export interface MainAgentVerlauf {
  verfuegbar: boolean;
  grund?: 'schalter_aus' | 'keine_hauptagent_identitaet' | 'fehler';
  identity_id: string | null;
  /** Aufsteigend nach id. */
  eintraege: MainAgentVerlaufEintrag[];
  /** Nur Seite: es gibt aeltere Eintraege. */
  mehr: boolean;
  max_rev: string;
  geleert_rev: string;
}

/** P22-T63: Seite (limit, vor_id) oder Aenderungen seit einem Stand (seit_rev, ab_id). */
export async function getMainAgentVerlauf(abfrage: { limit?: number; vor_id?: string; seit_rev?: string; ab_id?: string } = {}): Promise<MainAgentVerlauf> {
  const params = new URLSearchParams();
  for (const [name, wert] of Object.entries(abfrage)) if (wert !== undefined && wert !== '') params.set(name, String(wert));
  const query = params.toString();
  return jsonRequest<{ success: true } & MainAgentVerlauf>('/api/main-agent/verlauf' + (query ? '?' + query : ''));
}

/** P22-T73: Schalter der Warteschlange des Main-Chats (Standard AUS); EIN = Nachrichten warten statt Fehler. */
export async function getMainAgentWarteschlangeSchalter(): Promise<{ aktiv: boolean; quelle: string }> {
  return (await jsonRequest<{ success: true; schalter: { aktiv: boolean; quelle: string } }>('/api/main-agent/warteschlange/schalter')).schalter;
}

export interface GeladenesToolBild { url: string; aktuell: boolean; revision: string | null }

/** P22-T67: Bild eines Werkzeugaufrufs ueber die Ansicht-Route laden (Blob-URL; Rechte der Web-UI-Sitzung). */
export async function ladeToolBild(bild: Pick<AgentToolBild, 'project' | 'file_path' | 'revision'>): Promise<GeladenesToolBild> {
  const params = new URLSearchParams({ project: bild.project ?? '', file_path: bild.file_path ?? '' });
  if (bild.revision) params.set('revision', bild.revision);
  const response = await apiFetch('/api/main-agent/tool-bild?' + params.toString());
  if (!response.ok) throw new Error(await readError(response));
  const blob = await response.blob();
  return { url: URL.createObjectURL(blob), aktuell: response.headers.get('X-Bild-Aktuell') === '1', revision: response.headers.get('X-Bild-Revision') };
}

/** P22-T63: Verlauf auf allen Geraeten ausblenden (nur nach Rueckfrage aufrufen); gespeichert bleibt alles. */
export async function clearMainAgentVerlauf(): Promise<{ ausgeblendet: number; ausgeblendet_bis_id: string; geleert_rev: string }> {
  return jsonRequest<{ success: true; ausgeblendet: number; ausgeblendet_bis_id: string; geleert_rev: string }>('/api/main-agent/verlauf', {
    method: 'DELETE',
    body: JSON.stringify({ bestaetigt: true }),
  });
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
