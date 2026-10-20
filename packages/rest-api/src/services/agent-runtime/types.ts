import type { ContainerBeobachtung } from '@synapse/core';
import type { CliModellListe } from './cli-modelle.js';

export type RuntimeName = 'codex' | 'claude' | 'free-pool';
export type AgentRole = 'main' | 'specialist';
export type RuntimeContainerState = 'not_created' | 'created' | 'running' | 'stopped' | 'error';
export type RuntimeAuthState = 'authenticated' | 'not_authenticated' | 'unknown';

export interface RuntimeConfiguration {
  runtime: RuntimeName;
  role: AgentRole;
  rootPath: string;
  image: string;
  containerName: string;
  model: string | null;
  assignedToMain: boolean;
}

export interface RuntimeStatus {
  runtime: RuntimeName;
  role: AgentRole;
  configured: boolean;
  installed: boolean;
  rootPath: string;
  image: string;
  model: string | null;
  container: {
    name: string;
    id: string | null;
    status: RuntimeContainerState;
  };
  authentication: {
    status: RuntimeAuthState;
    method?: string;
  };
  version: string | null;
  lastError: string | null;
  diagnostic?: { code: 'pid_limit' | 'probe_timeout' | 'probe_error'; message: string };
  assignedToMain: boolean;
  /** P22-T64: Bewertung des Status-Probe-Laufs (Debug; status-stabil.ts). */
  pruefung?: StatusPruefung;
}

/** P22-T64: Ergebnis eines Status-Probe-Laufs. eindeutig = ok, ausgeloggt, container_aus, nicht_installiert; unklar = timeout, fehler. */
export type ProbeErgebnis = 'ok' | 'ausgeloggt' | 'container_aus' | 'nicht_installiert' | 'timeout' | 'fehler';
export interface StatusPruefung {
  /** Schalter runtime_status_stabil (Quelle) - AUS: Status ungefiltert wie der letzte Lauf. */
  schalter: { aktiv: boolean; quelle: string };
  letzter_lauf: { zeit: string; dauer_ms: number; ergebnis: ProbeErgebnis; eindeutig: boolean; meldung: string | null };
  /** frisch = Status aus diesem Lauf; letzter_guter_stand = bestaetigter Stand trotz unklarem/unbestaetigtem Lauf. */
  quelle: 'frisch' | 'letzter_guter_stand';
  /** Zeitpunkt des letzten bestaetigten Stands 'angemeldet' (oder null). */
  bestaetigt_am: string | null;
  alter_sekunden: number | null;
  /** Letzter Lauf zeitueberschritten/fehlgeschlagen, guter Stand gilt weiter. */
  haengt: boolean;
  /** Eindeutige 'nicht angemeldet'-Laeufe in Folge (Umschalten ab status_negativ_bestaetigung). */
  negativ_in_folge: number;
  hinweis: string | null;
}

export interface MainAgentSession {
  id: string;
  identityId?: string | null;
  laufId?: string | null;
  runtime: RuntimeName;
  runtimeSessionId: string | null;
  status: 'ready' | 'running' | 'completed' | 'error';
  context: Record<string, unknown> | null;
  createdAt: string;
  /** P22-T36: nur bei Schalter hauptagent EIN - Identitaetsweg oder Altweg mit Grund (nie ein Ausweiswert). */
  hauptagent?: { weg: 'identitaet' | 'altweg'; identity_id?: string; outcome?: string; fehler?: string };
}

/**
 * P8-T25: ein Werkzeugaufruf des Hauptagenten im Antwortstrom. start traegt Name und
 * Argumente, end das Ergebnis; beide teilen die id der Runtime (tool_use_id bzw. item.id).
 */
export interface RuntimeWerkzeugSchritt {
  phase: 'start' | 'end';
  id: string;
  name?: string;
  input?: unknown;
  output?: string;
  isError?: boolean;
  /** P22-T67: Bilder im Ergebnis (ohne Daten); Verweis auf das Asset, die Web-UI laedt ueber GET /api/main-agent/tool-bild nach. */
  bilder?: RuntimeWerkzeugBild[];
}

/** P22-T67: ein Bild eines Werkzeugergebnisses. Kein Base64: project + file_path (+ revision, Masse) zeigen auf das Asset. */
export interface RuntimeWerkzeugBild {
  mime_type: string;
  bytes: number;
  project?: string;
  file_path?: string;
  revision?: string;
  breite?: number;
  hoehe?: number;
}

export interface RuntimeStreamEvent {
  // 'artifact': Zustellung eines Hauptagenten-Artefakts in den offenen Strom
  // (artifact-stream.ts); die Empfangsseite kennt den Typ seit d7a39c1.
  // 'tool'/'thinking' (P8-T25): Werkzeugaufrufe und Denkphasen fuer die Chat-Anzeige.
  event: 'runtime' | 'delta' | 'usage' | 'error' | 'artifact' | 'tool' | 'thinking';
  data: Record<string, unknown>;
}

export interface RuntimeMessageResult {
  runtimeSessionId: string | null;
  context: Record<string, unknown> | null;
}

export interface TerminalSession {
  id: string;
  runtime: RuntimeName;
  stream: NodeJS.ReadWriteStream;
  exec: {
    resize(options: { h: number; w: number }): Promise<unknown>;
    inspect(): Promise<{ ExitCode?: number | null }>;
  };
  createdAt: Date;
}

export interface AgentRuntimeDriver {
  readonly runtime: RuntimeName;
  readonly label: string;
  /**
   * Ob `openTerminal` sinnvoll ist. Der Modell-Pool fuehrt kein Programm aus,
   * dort gibt es nichts, woran ein Terminal haengen koennte.
   */
  readonly supportsTerminal?: boolean;
  configure(input: { rootPath: string; image?: string; model?: string }): Promise<RuntimeStatus>;
  setup(): Promise<RuntimeStatus>;
  start(): Promise<RuntimeStatus>;
  stop(): Promise<RuntimeStatus>;
  status(): Promise<RuntimeStatus>;
  /** P22-T58: leichte Beobachtung fuer die Runtime-Ueberwachung (nur Container-Runtimes). */
  beobachte?(o: { probe_timeout_ms: number; daemon_frisch_ms: number }): Promise<ContainerBeobachtung>;
  /** P22-T58: docker restart des eigenen Containers (nur Container-Runtimes). */
  neustart?(): Promise<void>;
  /** P22-T58 F5: CLI-Update im Container (nur Container-Runtimes mit Agent-Runtime-Image). */
  cliUpdate?(o: { timeout_ms: number }): Promise<{ ok: boolean; exit_code: number | null; ausgabe: string }>;
  /** P22-T61: Modellliste aus der CLI im Container (nur Container-Runtimes); neu = Zwischenspeicher verwerfen. */
  modelle?(o?: { neu?: boolean }): Promise<CliModellListe>;
  openTerminal(input?: { cols?: number; rows?: number; command?: string }): Promise<TerminalSession>;
  sendMessage(
    session: MainAgentSession,
    message: string,
    emit: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeMessageResult>;
}
