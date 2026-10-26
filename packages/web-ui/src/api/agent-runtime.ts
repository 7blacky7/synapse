import { apiFetch } from './auth';
import type { SendeZitat } from '../components/zitat-logik';

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
  /** P22-T154: Datenvorlage (fest|stand|live), Projekt der Renderung, Zeitpunkt. */
  modus?: string;
  project?: string;
  vorlage?: boolean;
  gerendert_am?: string;
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
  /** P22-T168: Zitat-Anhaenge (nur an den Main dieser Sitzung). */
  zitate?: SendeZitat[],
): Promise<void> {
  const response = await apiFetch('/api/main-agent/sessions/' + encodeURIComponent(sessionId) + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message, ...(zitate?.length ? { zitate } : {}) }),
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
  /** herkunft (P22-T135): Eingabe einer lokalen CLI-Sitzung - cli = User an der CLI, mod_inbox / cc_send = zugestellte Nachricht. */
  absender: { agent_id?: string; identity_id?: string | null; rolle?: string | null; project?: string | null; channel?: string | null; herkunft?: 'cli' | 'mod_inbox' | 'cc_send' | null } | null;
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
  /** P22-T168: auch Zitat-Anhaenge (art 'zitat', zitat-logik anzeigeAusAnhaengen). */
  anhaenge: Array<{ name: string; typ: string | null; groesse: number | null } | ({ art: 'zitat' } & Record<string, unknown>)>;
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
  /** P22-T123: Tool-Karten aus tool_calls (Schalter verlauf_tool_karten); Debug der Zuordnung. */
  tool_karten?: { aktiv: boolean; quelle: string; antworten: number; gefunden: number; zugeordnet: number; ohne_fenster: number; letzter_fehler: string | null };
}

/** P22-T63: Seite (limit, vor_id) oder Aenderungen seit einem Stand (seit_rev, ab_id). */
export async function getMainAgentVerlauf(abfrage: { limit?: number; vor_id?: string; seit_rev?: string; ab_id?: string } = {}): Promise<MainAgentVerlauf> {
  const params = new URLSearchParams();
  for (const [name, wert] of Object.entries(abfrage)) if (wert !== undefined && wert !== '') params.set(name, String(wert));
  const query = params.toString();
  return jsonRequest<{ success: true } & MainAgentVerlauf>('/api/main-agent/verlauf' + (query ? '?' + query : ''));
}

/** P22-T81: Verlauf einer beliebigen Identitaet (gleiche Eintragsform wie der Main-Verlauf). */
export async function getAgentVerlauf(identityId: string, abfrage: { limit?: number; vor_id?: string; seit_rev?: string; ab_id?: string } = {}): Promise<MainAgentVerlauf> {
  const params = new URLSearchParams({ identity_id: identityId });
  for (const [name, wert] of Object.entries(abfrage)) if (wert !== undefined && wert !== '') params.set(name, String(wert));
  return jsonRequest<{ success: true } & MainAgentVerlauf>('/api/agent-runtimes/agent-verlauf?' + params.toString());
}

/** P22-T123: eine Tool-Karte aus tool_calls (gleiche Form wie werkzeuge.calls im Verlauf). */
export interface ToolKarteLive {
  id: string; name?: string; action?: string | null; input?: unknown; output?: unknown; isError?: boolean;
  start: string; ende: string | null; tool_call_id: string; project: string | null;
}

/**
 * P22-T123: Tool-Karten live (SSE GET /api/agent-runtimes/tool-karten/stream, PG-NOTIFY auf tool_calls), nur eigene Aufrufe der
 * Identitaet; identityId null = der Main. Rueckgabe: Abmelden. Bei Schalter AUS meldet der Server 'aus' und beendet den Strom.
 */
export function abonniereToolKarten(
  identityId: string | null,
  onKarte: (karte: ToolKarteLive) => void,
  onStatus?: (status: { art: 'bereit' | 'aus' | 'fehler'; info?: unknown }) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const query = identityId ? '?identity_id=' + encodeURIComponent(identityId) : '';
      const response = await apiFetch('/api/agent-runtimes/tool-karten/stream' + query, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body) { onStatus?.({ art: 'fehler', info: response.status }); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let puffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        puffer += decoder.decode(value, { stream: true });
        let ende = puffer.indexOf('\n\n');
        while (ende >= 0) {
          const block = puffer.slice(0, ende);
          puffer = puffer.slice(ende + 2);
          ende = puffer.indexOf('\n\n');
          let event = 'message';
          let data = '';
          for (const zeile of block.split('\n')) {
            if (zeile.startsWith('event:')) event = zeile.slice(6).trim();
            else if (zeile.startsWith('data:')) data += zeile.slice(5).trim();
          }
          if (!data) continue;
          let d: Record<string, unknown>;
          try { d = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          if (event === 'tool' && d.karte && typeof d.karte === 'object') onKarte(d.karte as ToolKarteLive);
          else if (event === 'bereit' || event === 'aus' || event === 'fehler') onStatus?.({ art: event, info: d });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) onStatus?.({ art: 'fehler', info: error instanceof Error ? error.message : String(error) });
    }
  })();
  return () => controller.abort();
}

/** P22-T116: Runtime-Agenten-Uebersicht (Schalter runtime_agenten_uebersicht, Std AUS) und Steuerung (runtime_agenten_steuerung). */
export interface RuntimeAgentZeile {
  name: string; identity_id: string | null; quelle: string; ort: string; runtime: string | null; status: string; busy: boolean;
  letzte_aktivitaet: string; inaktiv_sekunden: number; heartbeat: { an: boolean; takt_ms: number | null }; pid: number | null;
  wrapper_pid: number | null; modell: string | null; auftrag: string | null; tokens: { input: number; output: number; prozent: number }; warnungen: string[];
  /** P22-T125 (Schalter wrapper_status_ursache): Anzeigestatus aus belegter Ursache, eigene Zeile. */
  anzeige_status?: string; du_selbst?: boolean; beendet?: { ursache?: string; erkannt_am?: string | null; ereignis_id?: string | null; veraltet_verworfen?: boolean } | null;
}
export interface RuntimeAgentenStand { aktiv: boolean; /** P22-T122: Schalter runtime_agenten_panel_neu */ panel_neu?: boolean; orte?: Record<string, RuntimeAgentZeile[]>; anzahl?: number; warnungen_gesamt?: number; debug?: Record<string, unknown> }
export async function getRuntimeAgenten(project: string): Promise<RuntimeAgentenStand> {
  return jsonRequest<{ success: true } & RuntimeAgentenStand>('/api/agent-runtimes/runtime-agenten?project=' + encodeURIComponent(project));
}
export async function getRuntimeAgentLog(identityId: string): Promise<Record<string, unknown>> {
  return jsonRequest<Record<string, unknown>>('/api/agent-runtimes/runtime-agenten/log?identity_id=' + encodeURIComponent(identityId));
}
export async function getRuntimeProzesse(project: string): Promise<Record<string, unknown>> {
  return jsonRequest<Record<string, unknown>>('/api/agent-runtimes/runtime-agenten/prozesse?project=' + encodeURIComponent(project));
}
/** P22-T117: Abo-Runtimes, auf die ein Plattform-Agent wechseln kann (API-Runtimes gibt es dafuer nicht, User-Entscheidung). */
export const PLATTFORM_AGENT_RUNTIMES = ['claude', 'codex'] as const;
/** P22-T117: Modell/CLI-Anbieter eines Plattform-Agenten wechseln (Schalter plattform_agent_modellwechsel). */
export async function wechsleAgentModellUi(identityId: string, runtime: typeof PLATTFORM_AGENT_RUNTIMES[number], modell: string, grund: string): Promise<Record<string, unknown>> {
  return jsonRequest<Record<string, unknown>>('/api/agent-runtimes/runtime-agenten/modellwechsel', { method: 'POST', body: JSON.stringify({ identity_id: identityId, runtime, modell, grund }) });
}
/** P22-T116: zweistufig - ohne bestaetigung nur Vorschau + bestaetigung_id; mit {id, grund} Ausfuehrung. */
export async function steuereRuntimeAgentUi(identityId: string, aktion: 'stop' | 'start' | 'restart' | 'wake', grund: string, bestaetigung?: { id: string; grund: string; project: string; identity_id: string }): Promise<Record<string, unknown>> {
  return jsonRequest<Record<string, unknown>>('/api/agent-runtimes/runtime-agenten/steuern', { method: 'POST', body: JSON.stringify({ identity_id: identityId, aktion, grund, ...(bestaetigung ? { bestaetigung } : {}) }) });
}

/** P22-T112: PG-Produkt-Schalter im Projekt der Zielidentitaet, Standard AUS. */
export interface PlattformAgentChatSchalter { aktiv: boolean; quelle: string; name: string; wert: string | null; project: string | null; letzter_fehler: string | null;
  /** P22-T189: fehlt bei alter API = AUS. */
  mehrfenster?: { name: string; aktiv: boolean; quelle: string; letzter_fehler: string | null };
}
export async function getPlattformAgentChatSchalter(identityId: string): Promise<PlattformAgentChatSchalter> {
  return (await jsonRequest<{ success: true; schalter: PlattformAgentChatSchalter }>('/api/agent-runtimes/agent-chat/status?identity_id=' + encodeURIComponent(identityId))).schalter;
}

/** P22-T188: Heartbeat im Chatfenster (Koordinator: koordinator_heartbeat, Unteragent: laufender Wrapper / runtime_agenten_steuerung). */
export interface AgentHeartbeatStand {
  identity_id: string; agent_id: string; project: string; rolle: string; weg: 'koordinator_heartbeat' | 'wrapper' | null; verstellbar: boolean;
  schalter: { name: string; aktiv: boolean; quelle: string; letzter_fehler: string | null };
  gewuenscht: { aktiv: boolean; intervall_ms: number | null; quelle?: string } | null;
  tatsaechlich: { lauf: boolean; status?: string; aktiv?: boolean | null; intervall_ms?: number | null };
  hinweis: string | null; wrapper_nachgezogen?: boolean;
}
export async function getAgentHeartbeat(identityId: string): Promise<AgentHeartbeatStand> {
  return jsonRequest<{ success: true } & AgentHeartbeatStand>('/api/agent-runtimes/agent-heartbeat?identity_id=' + encodeURIComponent(identityId));
}
export async function setzeAgentHeartbeat(identityId: string, aktiv: boolean, intervallMs: number | null): Promise<AgentHeartbeatStand> {
  return jsonRequest<{ success: true } & AgentHeartbeatStand>('/api/agent-runtimes/agent-heartbeat', {
    method: 'PUT', body: JSON.stringify({ identity_id: identityId, aktiv, intervall_ms: intervallMs, grund: 'Web-UI Chatfenster (P22-T188)' }),
  });
}

/** P22-T124: Schalter agent_chat_einheitlich (Produkt-Schalter im Projekt der Zielidentitaet, Std AUS); fehlt das Feld = AUS. */
export async function getAgentChatEinheitlich(identityId: string): Promise<boolean> {
  const r = await jsonRequest<{ success: true; einheitlich?: { aktiv?: boolean } }>('/api/agent-runtimes/agent-chat/status?identity_id=' + encodeURIComponent(identityId));
  return r.einheitlich?.aktiv === true;
}

/** P22-T112: Nachricht des Users an einen Plattform-Agenten (Zustellung per Inbox). P22-T168: zitate gehen nur an diese Identitaet. */
export async function sendePlattformAgentChat(identityId: string, text: string, zitate?: SendeZitat[]): Promise<{ inbox_id: number; agent_id: string; project: string; zitate?: Record<string, unknown> }> {
  return jsonRequest<{ success: true; inbox_id: number; agent_id: string; project: string; zitate?: Record<string, unknown> }>('/api/agent-runtimes/agent-chat', {
    method: 'POST',
    body: JSON.stringify({ identity_id: identityId, text, ...(zitate?.length ? { zitate } : {}) }),
  });
}

/** P22-T137: Inbox-Nachricht zwischen User und Plattform-Agent; richtung 'ein' = vom User an den Agenten, 'aus' = vom Agenten an 'user'. */
export interface AgentChatInboxNachricht { id: number; richtung: 'ein' | 'aus'; von: string; an: string; text: string; erstellt_am: string }

/**
 * P22-T137: Inbox zwischen User und Agent (beide Richtungen, aelteste zuerst); Schalter wie agent-chat, AUS = aktiv false, leer.
 * P22-T146: ab_id = nur juengere (Abgleich), vor_id = die limit davor (aeltere nachladen); mehr = es gibt weitere in dieser Richtung.
 */
export async function getAgentChatInbox(identityId: string, o: { limit?: number; ab_id?: number; vor_id?: number } = {}): Promise<{ aktiv: boolean; nachrichten: AgentChatInboxNachricht[]; mehr?: boolean }> {
  const params = new URLSearchParams({ identity_id: identityId });
  for (const [name, wert] of Object.entries(o)) if (typeof wert === 'number' && Number.isFinite(wert) && (name !== 'limit' || wert > 0)) params.set(name, String(wert));
  const r = await jsonRequest<{ success: true; aktiv?: boolean; nachrichten?: AgentChatInboxNachricht[]; mehr?: boolean }>('/api/agent-runtimes/agent-chat/inbox?' + params.toString());
  return { aktiv: r.aktiv === true, nachrichten: Array.isArray(r.nachrichten) ? r.nachrichten : [], ...(typeof r.mehr === 'boolean' ? { mehr: r.mehr } : {}) };
}

/** P22-T141: Stand einer Artefakt-Bewertung (Design, global). zustand: vorbild | ueberarbeiten | verbannt | versuch_gezeigt. */
export interface ArtefaktBewertungStand {
  id: string; quelle_art: 'artefakt' | 'inbox' | 'verlauf'; quelle_ref: string; urteil: 'hoch' | 'runter'; kommentar: string | null;
  zustand: 'vorbild' | 'ueberarbeiten' | 'verbannt' | 'versuch_gezeigt'; titel?: string | null; nachfolger?: { art: string; ref: string } | null;
}

/** P22-T154: Renderung eines Vorlagen-Artefakts fuer ein Projekt (stand = Momentaufnahme, live = gedrosselt neu). */
export interface ArtefaktRenderStand {
  modus: 'fest' | 'stand' | 'live'; project: string | null; revision: number; gerendert_am: string; neu: boolean; fehler: string[]; hinweis?: string;
  debug?: Record<string, unknown>;
}
export interface ArtefaktAnsicht {
  id: string; html: string; titel: string | null; revision: number; modus: 'fest' | 'stand' | 'live'; hatVorlage: boolean; standardProject: string | null;
  render?: ArtefaktRenderStand; projekte: Array<{ project: string; revision: number; gerendert_am: string }>;
}

/** P22-T154: Artefakt laden; mit Vorlage rendert der Server fuer project (Standard: Standardprojekt). */
export async function getArtefaktAnsicht(id: string, project?: string | null): Promise<ArtefaktAnsicht> {
  const q = project ? '?project=' + encodeURIComponent(project) : '';
  const r = await jsonRequest<{ success: true; artefakt: Record<string, unknown>; render?: ArtefaktRenderStand; projekte?: ArtefaktAnsicht['projekte'] }>(
    '/api/main-agent/artefakte/' + encodeURIComponent(id) + q);
  const a = r.artefakt ?? {};
  return {
    id: String(a.id ?? id), html: typeof a.html === 'string' ? a.html : '', titel: typeof a.title === 'string' ? a.title : null,
    revision: typeof a.revision === 'number' ? a.revision : 1, modus: (a.modus as ArtefaktAnsicht['modus']) ?? 'fest', hatVorlage: a.hatVorlage === true,
    standardProject: typeof a.standardProject === 'string' ? a.standardProject : null, render: r.render, projekte: Array.isArray(r.projekte) ? r.projekte : [],
  };
}

/** P22-T154: neu zeichnen (Vorlage mit aktuellen Daten); Schalter artefakt_vorlagen AUS -> Fehler funktion_aus. */
export async function zeichneArtefaktNeu(id: string, project?: string | null): Promise<{ html: string; render: ArtefaktRenderStand; projekte: ArtefaktAnsicht['projekte'] }> {
  const r = await jsonRequest<{ success: true; html: string; render: ArtefaktRenderStand; projekte?: ArtefaktAnsicht['projekte'] }>(
    '/api/main-agent/artefakte/' + encodeURIComponent(id) + '/neu-zeichnen', { method: 'POST', body: JSON.stringify({ project: project ?? null }) });
  return { html: r.html, render: r.render, projekte: Array.isArray(r.projekte) ? r.projekte : [] };
}

export interface ArtefaktLiveDaten { artefakt_id: string; project: string; revision: number; html: string; gerendert_am: string; fehler?: string[] }

/**
 * P22-T154 Etappe 5: Live-Strom eines Artefakts (SSE GET /api/main-agent/artefakte/:id/stream?project=). Nur live-Artefakte bei
 * Schalter artefakt_vorlagen_live EIN; sonst meldet der Server 'aus' und beendet den Strom. Rueckgabe: Abmelden.
 */
export function abonniereArtefaktLive(
  id: string,
  project: string | null,
  onArtefakt: (d: ArtefaktLiveDaten) => void,
  onStatus?: (status: { art: 'bereit' | 'aus' | 'fehler'; info?: unknown }) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const q = project ? '?project=' + encodeURIComponent(project) : '';
      const response = await apiFetch('/api/main-agent/artefakte/' + encodeURIComponent(id) + '/stream' + q, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body) { onStatus?.({ art: 'fehler', info: response.status }); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let puffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        puffer += decoder.decode(value, { stream: true });
        let ende = puffer.indexOf('\n\n');
        while (ende >= 0) {
          const block = puffer.slice(0, ende);
          puffer = puffer.slice(ende + 2);
          ende = puffer.indexOf('\n\n');
          let event = 'message';
          let data = '';
          for (const zeile of block.split('\n')) {
            if (zeile.startsWith('event:')) event = zeile.slice(6).trim();
            else if (zeile.startsWith('data:')) data += zeile.slice(5).trim();
          }
          if (!data) continue;
          let d: Record<string, unknown>;
          try { d = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          if (event === 'artefakt' && typeof d.html === 'string') onArtefakt(d as unknown as ArtefaktLiveDaten);
          else if (event === 'bereit' || event === 'aus' || event === 'fehler') onStatus?.({ art: event, info: d });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) onStatus?.({ art: 'fehler', info: error instanceof Error ? error.message : String(error) });
    }
  })();
  return () => controller.abort();
}

/** P22-T141: Stand je Block ('artefakt:<id>,inbox:<n>,verlauf:<id>'); Schalter artefakt_bewertung AUS = aktiv false. */
export async function getArtefaktBewertungen(quellen: string): Promise<{ aktiv: boolean; bewertungen: ArtefaktBewertungStand[] }> {
  const r = await jsonRequest<{ success: true; aktiv?: boolean; bewertungen?: ArtefaktBewertungStand[] }>('/api/agent-runtimes/artefakt-bewertung?quellen=' + encodeURIComponent(quellen));
  return { aktiv: r.aktiv === true, bewertungen: Array.isArray(r.bewertungen) ? r.bewertungen : [] };
}

/** P22-T141: Bewertung des Users senden (nur Design/Aufmachung). Der Server liest den Schnappschuss selbst aus der Quelle. */
export async function sendeArtefaktBewertung(body: { quelle_art: string; quelle_ref: string; identity_id?: string; urteil: 'hoch' | 'runter'; kommentar?: string }):
  Promise<{ bewertung: ArtefaktBewertungStand }> {
  return jsonRequest<{ success: true; bewertung: ArtefaktBewertungStand }>('/api/agent-runtimes/artefakt-bewertung', { method: 'POST', body: JSON.stringify(body) });
}

/** P22-T161: ein Eintrag der Top-Artefakte eines Projekts (core leseTopArtefakte, ohne HTML). */
export interface TopArtefakt {
  bewertung_id: string; rang: number; quelle: { art: 'artefakt' | 'inbox' | 'verlauf'; ref: string }; titel: string | null;
  zustand: ArtefaktBewertungStand['zustand']; urteil: 'hoch' | 'runter'; kommentar_vorschau: string | null; kommentar_gekuerzt: boolean;
  urheber_agent: string | null; urheber_identity_id: string | null; project: string | null; standard_project: string | null;
  modus: 'fest' | 'stand' | 'live'; hat_vorlage: boolean; weg: 'vorlage' | 'main' | 'ausweis' | 'inbox' | 'verlauf'; artefakt_fehlt: boolean;
  bewertet_revision: number | null; aktuelle_revision: number | null; veraendert_seit_bewertung: boolean;
  bewertet_am: string; anzahl_bewertungen: number; saldo: number;
  /** P22-T166: das aktuelle Artefakt enthaelt ein Skript (nur Quelle artefakt). */
  hat_skript?: boolean;
}
/** P22-T166: skripte_aktiv = Schalter artefakt_skripte (Skript laeuft im ausgeklappten Eintrag nach Klick). */
export interface TopArtefakteAntwort { aktiv: boolean; project: string; eintraege: TopArtefakt[]; skripte_aktiv?: boolean; debug?: Record<string, unknown> }

/** P22-T161: Top-Artefakte des Projekts (Standard nur Vorbilder; alle = auch die anderen Zustaende). Schalter AUS = aktiv false. */
export async function getTopArtefakte(project: string, alle = false): Promise<TopArtefakteAntwort> {
  const params = new URLSearchParams({ project });
  if (alle) params.set('alle', '1');
  const r = await jsonRequest<{ success: true; aktiv?: boolean; project?: string; eintraege?: TopArtefakt[]; skripte_aktiv?: boolean; debug?: Record<string, unknown> }>(
    '/api/main-agent/artefakte/top?' + params.toString());
  return { aktiv: r.aktiv === true, project: typeof r.project === 'string' ? r.project : project, eintraege: Array.isArray(r.eintraege) ? r.eintraege : [],
    skripte_aktiv: r.skripte_aktiv === true, debug: r.debug };
}

export interface BewertungsSchnappschuss {
  bewertung_id: string; titel: string | null; html: string; quelle: { art: string; ref: string }; bewertet_revision: number | null; bewertet_am: string;
}

/** P22-T161: das HTML so, wie der User es bewertet hat (Umschalter bzw. einzige Ansicht bei Inbox/Verlauf). */
export async function getBewertungsSchnappschuss(bewertungId: string): Promise<BewertungsSchnappschuss> {
  return (await jsonRequest<{ success: true; schnappschuss: BewertungsSchnappschuss }>(
    '/api/main-agent/artefakte/top/' + encodeURIComponent(bewertungId) + '/schnappschuss')).schnappschuss;
}

/**
 * P22-T161: Live-Strom der Top-Liste (SSE GET /api/main-agent/artefakte/top/stream). 'geaendert' kommt gebuendelt bei jeder Aenderung
 * einer Bewertung; Schalter artefakt_bewertung AUS -> 'aus', Ende. Rueckgabe: Abmelden.
 */
export function abonniereTopArtefakte(
  onGeaendert: (d: { anzahl: number; ereignisse: unknown[] }) => void,
  onStatus?: (status: { art: 'bereit' | 'aus' | 'fehler'; info?: unknown }) => void,
): () => void {
  const controller = new AbortController();
  void (async () => {
    try {
      const response = await apiFetch('/api/main-agent/artefakte/top/stream', { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
      if (!response.ok || !response.body) { onStatus?.({ art: 'fehler', info: response.status }); return; }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let puffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        puffer += decoder.decode(value, { stream: true });
        let ende = puffer.indexOf('\n\n');
        while (ende >= 0) {
          const block = puffer.slice(0, ende);
          puffer = puffer.slice(ende + 2);
          ende = puffer.indexOf('\n\n');
          let event = 'message';
          let data = '';
          for (const zeile of block.split('\n')) {
            if (zeile.startsWith('event:')) event = zeile.slice(6).trim();
            else if (zeile.startsWith('data:')) data += zeile.slice(5).trim();
          }
          if (!data) continue;
          let d: Record<string, unknown>;
          try { d = JSON.parse(data) as Record<string, unknown>; } catch { continue; }
          if (event === 'geaendert') onGeaendert({ anzahl: Number(d.anzahl) || 0, ereignisse: Array.isArray(d.ereignisse) ? d.ereignisse : [] });
          else if (event === 'bereit' || event === 'aus' || event === 'fehler') onStatus?.({ art: event, info: d });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) onStatus?.({ art: 'fehler', info: error instanceof Error ? error.message : String(error) });
    }
  })();
  return () => controller.abort();
}

/** P22-T73: Schalter der Warteschlange des Main-Chats (Standard AUS); EIN = Nachrichten warten statt Fehler. */
export async function getMainAgentWarteschlangeSchalter(): Promise<{ aktiv: boolean; quelle: string }> {
  return (await jsonRequest<{ success: true; schalter: { aktiv: boolean; quelle: string } }>('/api/main-agent/warteschlange/schalter')).schalter;
}

export interface GeladenesToolBild { url: string; aktuell: boolean; revision: string | null; breite: number | null; hoehe: number | null }

/**
 * P22-T67: Bild eines Werkzeugaufrufs ueber die Ansicht-Route laden (Blob-URL; Rechte der Web-UI-Sitzung).
 * P22-T150: auch Bildverweise aus Nachrichten; breite/hoehe aus X-Bild-Breite/-Hoehe fuer die Unterschrift.
 */
export async function ladeToolBild(bild: Pick<AgentToolBild, 'project' | 'file_path' | 'revision'>): Promise<GeladenesToolBild> {
  const params = new URLSearchParams({ project: bild.project ?? '', file_path: bild.file_path ?? '' });
  if (bild.revision) params.set('revision', bild.revision);
  const response = await apiFetch('/api/main-agent/tool-bild?' + params.toString());
  if (!response.ok) throw new Error(await readError(response));
  const blob = await response.blob();
  const zahl = (name: string): number | null => { const n = Number(response.headers.get(name)); return Number.isFinite(n) && n > 0 ? n : null; };
  return { url: URL.createObjectURL(blob), aktuell: response.headers.get('X-Bild-Aktuell') === '1', revision: response.headers.get('X-Bild-Revision'),
    breite: zahl('X-Bild-Breite'), hoehe: zahl('X-Bild-Hoehe') };
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
