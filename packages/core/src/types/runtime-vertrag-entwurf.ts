/**
 * P22-T1 / W0a — ENTWURF ZUR ABNAHME, keine aktive Implementierung.
 * Quellen: e7ed9291 §§2/3/5/W0, 2039b0ed, 88f80455, bf473136.
 *
 * Ausschliesslich Typen; bewusst kein Barrel-Export und keine Anbindung an
 * Auth, Repository, ensureSchema, Routen, Daemon oder Wrapper.
 * Bestand RuntimeName/MainAgentSession/pc-daemon bleibt unveraendert.
 * Persistenz-/Transaktionsentwurf und Abnahmefaelle: Vertrags-Thought P22-T1.
 */
export type RuntimeInstanceId = string; // serverseitige stabile UUID, nicht Container-ID/RuntimeName
export type ExecutorId = string; // stabile UUID je ausfuehrender Dienstinstanz
export type BootGeneration = string; // PG-bigint als Dezimalstring; API erhoeht monoton
export type RunId = string; // dauerhafte UUID eines beaufsichtigten Laufs, nicht eines Turns
export type CommandId = string; // dauerhafte UUID; bei Transportretry unveraendert
export type AgentIdentityId = string; // bestehende/servergepraegte Main-ID, spaeter W1
export type ConversationId = string; // identitaetsgebundener Gespraechs-/Handoffbezug
export type SessionId = string; // Bezug zur bestehenden agent_runtime_sessions.id
export type Revision = string; // PG-bigint als Dezimalstring
export type ApiTimestamp = string; // ISO-8601; fuer Leaseentscheidungen gilt API-Zeit
export type WorkerKind = 'cli' | 'api';

export interface RuntimeInstanceContract {
  runtime_instance_id: RuntimeInstanceId;
  /** FK zum bestehenden agent_runtime_instances.runtime; kein neues Providerregister. */
  runtime_key: string;
  worker_kind: WorkerKind;
}

/** Ein Executor kann mehrere Identitaeten betreuen; keine eigene Projekt-/Teamdatenbank. */
export interface ExecutorContract {
  executor_id: ExecutorId;
  runtime_instance_id: RuntimeInstanceId;
  boot_generation: BootGeneration;
  worker_kind: WorkerKind;
  last_process_liveness_at: ApiTimestamp | null;
}

export type RuntimeDaemonCapability =
  | 'observe-own-runtime'
  | 'claim-assigned-commands'
  | 'report-own-runs'
  | 'read-assigned-configuration';

/** Vorschlag fuer additive Principal-Aufloesung, KEIN Ersatz des AuthTokenRow. */
export interface RuntimeDaemonPrincipalDraft {
  kind: 'runtime-daemon';
  credential_id: string; // nur Ausweisreferenz, niemals Bearer-Wert
  runtime_instance_id: RuntimeInstanceId;
  executor_id: ExecutorId;
  capabilities: readonly RuntimeDaemonCapability[];
  allowed_scopes: readonly RuntimeAgentScope[];
  credential_revision: Revision;
}

/** PC-Zweig bleibt an die bestaetigte ProjectRestore-Hostbindung gebunden. */
export interface PcDaemonPrincipalDraft {
  kind: 'pc-daemon';
  credential_id: string;
  host: string;
}

export type DaemonPrincipalDraft = PcDaemonPrincipalDraft | RuntimeDaemonPrincipalDraft;
export type RuntimeAgentScope = { kind: 'global-main' } | { kind: 'project'; project: string };

/**
 * Geschuetzte serverseitige Ausweis-Metadaten, nicht Status-/Modelldaten.
 * Ein eigener widerrufbarer Ausweis je Runtimeinstanz; Rotation mit ACK.
 * Kein Tray-Token und keine ProjectRestore-PCbindung fuer runtime-daemon.
 */
export interface RuntimeDaemonCredentialDraft {
  credential_id: string;
  runtime_instance_id: RuntimeInstanceId;
  executor_id: ExecutorId;
  token_hash: string;
  issued_at: ApiTimestamp;
  revoked_at: ApiTimestamp | null;
  revision: Revision;
  replacement_ack_at: ApiTimestamp | null;
}

/** W2-Minimum: servergepraegter Modellzugang, niemals Daemon-Ausweis vererben. */
export interface MainRunPrincipalDraft {
  kind: 'main-run';
  credential_id: string;
  identity_id: AgentIdentityId;
  scope: { kind: 'global-main' };
  session_id: SessionId;
  fence: RunFence;
  confirmed_profile_id: string;
}

/** Jeder Claim, Bericht, ACK und Steuerauftrag prueft ALLE Fence-Felder. */
export interface RunFence {
  runtime_instance_id: RuntimeInstanceId;
  executor_id: ExecutorId;
  boot_generation: BootGeneration;
  run_id: RunId;
  run_generation: Revision;
}

export type RunObservedState =
  | 'pending' | 'starting' | 'idle' | 'busy' | 'draining'
  | 'unknown' | 'stopped' | 'failed';

/**
 * pending bis unknown belegt den Identitaets-Slot, auch idle/Heartbeat AUS.
 * stopped/failed erst nach belegtem lokalem Prozessende, niemals nur Timeout.
 */
export interface AgentRunContract {
  fence: RunFence;
  identity_id: AgentIdentityId;
  worker_kind: WorkerKind;
  scope: RuntimeAgentScope;
  session_id: SessionId;
  conversation_id: ConversationId;
  desired_state: 'enabled' | 'disabled';
  observed_state: RunObservedState;
  process_observation: {
    last_liveness_at: ApiTimestamp | null;
    /** PID nur im Zielnamespace sinnvoll; nie process.kill im API-Namespace. */
    namespace_id: string | null;
    wrapper_pid: number | null;
    process_start_marker: string | null;
    cli_thread_id: string | null;
    exit_confirmed_at: ApiTimestamp | null;
  };
}

/** Minimaler globaler Singleton statt eines kompletten W1-Teamregisters. */
export interface MainBindingContract {
  singleton_key: 'main';
  identity_id: AgentIdentityId;
  conversation_id: ConversationId;
  selected_runtime_instance_id: RuntimeInstanceId | null;
  active_run_id: RunId | null;
  revision: Revision;
  /** Erst ein gefencter Wrapperstart-ACK setzt eingerichtet. */
  setup_state: 'not_configured' | 'pending' | 'configured';
  desired_enabled: boolean; // Produktionsstandard fuer Neues: false
  heartbeat_enabled: boolean; // Produktstandard false; Nachrichten bleiben erreichbar
}

/**
 * Interner Testoverride ist getrennt von dauerhaftem Produktzustand.
 * Keine produktive Funktion haengt von intern ab. User-Off dominiert.
 * Ablauf/Brueckenverlust/Produktionsmodus -> aktuelle Produktionsbasis.
 */
export interface RuntimeMechanismDiagnostic<T> {
  production_value: T;
  effective_value: T;
  source: 'standard' | 'produkt-schalter' | 'intern';
  product_revision: Revision;
  internal_override_expires_at: ApiTimestamp | null;
  observed_at: ApiTimestamp | null;
  last_error_code: string | null; // bereinigt, keine Credentials/Prompts
}

export interface MainRuntimeDiagnostic {
  main_enabled: RuntimeMechanismDiagnostic<boolean>;
  heartbeat_enabled: RuntimeMechanismDiagnostic<boolean>;
  selected_runtime: RuntimeMechanismDiagnostic<RuntimeInstanceId | null>;
  executor_liveness_at: ApiTimestamp | null; // kein Modell-Weckheartbeat
  run_state: RunObservedState | null;
}

/**
 * Authentifizierter User, bestaetigte Runtimezuweisung/Auth/Produktfreigabe
 * sind SERVER-Vorbedingungen, keine vertrauenswuerdigen Request-Flags.
 * Idempotenz immer zusaetzlich zum Singleton, nie nur je Browserrequest.
 */
export interface MainFirstContactDraft {
  runtime_instance_id: RuntimeInstanceId;
  expected_binding_revision: Revision;
  request_id: string;
  message_id: string;
  message: string;
}

export type MainFirstContactResultDraft =
  | {
      outcome: 'created' | 'existing';
      identity_id: AgentIdentityId;
      conversation_id: ConversationId;
      session_id: SessionId;
      run_id: RunId;
      start_command_id: CommandId;
      message_id: string;
      setup_state: 'pending' | 'configured';
    }
  | {
      outcome: 'rejected';
      reason: 'disabled' | 'authentication_required' | 'runtime_conflict'
        | 'stale_binding' | 'idempotency_conflict' | 'executor_unavailable';
    };

export type RuntimeCommandPayloadDraft =
  | { kind: 'start'; session_id: SessionId; confirmed_profile_id: string }
  | { kind: 'deliver-message'; message_id: string }
  | { kind: 'set-heartbeat'; enabled: boolean; product_revision: Revision }
  | { kind: 'drain'; reason: 'user-off' | 'runtime-switch' | 'heartbeat-off-idle' }
  | {
      kind: 'interrupt';
      /** Unterbrechen benoetigt explizite Autorisierung; kein Watchdog-Recht. */
      authorization_id: string;
      authority: 'user' | 'main' | 'project-coordinator';
    };

export interface RuntimeCommandDraft {
  command_id: CommandId;
  target: RunFence;
  payload: RuntimeCommandPayloadDraft;
  status: 'pending' | 'claimed' | 'accepted' | 'completed' | 'rejected';
  claim_revision: Revision;
  lease_expires_at: ApiTimestamp | null;
}

/** Leaseablauf beweist keinen Exit; lokal vor Wiederholung Commandmarker versoehnen. */
export interface RuntimeCommandAckDraft {
  command_id: CommandId;
  target: RunFence;
  claim_revision: Revision;
  stage: 'accepted' | 'completed' | 'rejected';
  process_start_marker: string | null;
  last_error_code: string | null;
}

/**
 * SPAETERE Umsetzung / Abnahme (hier keinerlei Wirkung):
 * - API/PG haelt Identitaet, Singleton, Ausweisbindung, Policy, durable Inbox.
 * - CLI-Executor im Container beaufsichtigt Wrapper/Kinder ohne PG/Docker-Socket.
 * - API-Worker nutzt eigenen serverseitigen Transport/Budget, keinen CLI-Login.
 * - Alle Starts: dauerhafter Singleton-Lock + UNIQUE aktiver Run je Identitaet.
 * - Erstkontakt speichert Nachricht + Run + Startcommand in EINER Transaktion.
 * - Zwei Tabs mit verschiedenen Request-IDs erhalten denselben Main-Run.
 * - Unklarer Prozesszustand blockiert Ersatzlauf bis belegter Versoehnung/Exit.
 * - Runtimewechsel haelt Identitaet/Gespraech; alter Lauf erst geordnet beenden.
 *   Heartbeat AUS allein gibt den aktiven Lauf NICHT fuer einen Doppelstart frei.
 * - Hauptagent ein/aus, Heartbeat ein/aus und Runtimewahl: Produkt-Schalter,
 *   dauerhaft in PG, nur User/explizit berechtigter Koordinator, mit Audit.
 * - Erstkontakt/Executor/Runzugang: Code-/Configfreigabe standardmaessig AUS.
 * - intern: befristete Diagnose/Testoverrides mit Revision/Quelle/Ablauf;
 *   keine neuen Rechte, keine Ausweisausgabe und kein versteckter Start.
 */
