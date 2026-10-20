/**
 * P22-T6 (W2c): Der Hauptagent laeuft dauerhaft im Runtime-Container – wie ein lokaler Spezialist auf dem PC
 * (User 61c58de2 Pkt 2, Konzept e7ed9291 Architektur B): Container-Daemon -> spawnSpecialistTool -> Wrapper -> CLI-Kind,
 * Ausweis ueber Runtime-agent_start (P22-T5). Kein Projekt-Checkout, Ordner /projects/synapse-hauptagent mit .synapse/agents.
 *
 * ZUSTELLUNG: dieselbe Queue wie lokal (specialist_jobs, target_identity_id) plus args.target_runtime – nur der
 *   Container-Daemon dieser Runtime claimt solche Jobs, ein PC-Daemon nie (specialist-queue.ts).
 *   Erstkontakt/Start = Job 'spawn' (genau einer offen je Identitaet, Sperre wie T36). Chat-Turn = Job 'wake'; der Wrapper
 *   antwortet ueber seinen Socket synchron mit der fertigen Antwort (lokale Vorlage wakeSpecialistTool, inkl. Inbox-Rueckfall
 *   bei beschaeftigtem Agenten). Browser zu = Wrapper laeuft weiter.
 *
 * UMSCHALTBAR OHNE UMBAU (offene User-Fragen O1-O3, thought 825fcb16), Env, Standard = Vorschlag:
 *   SYNAPSE_HAUPTAGENT_ANTWORT        fertig (Standard) | live   – live ist vorbereitet, liefert bis zum Delta-Weg 'fertig'
 *   SYNAPSE_HAUPTAGENT_BESCHAEFTIGT   inbox (Standard, wie lokal) | fehler
 *   SYNAPSE_HAUPTAGENT_OHNE_DAEMON    altweg (Standard: docker exec je Turn mit Hinweis) | fehler
 *   SYNAPSE_HAUPTAGENT_TURN_MS        Wartezeit auf eine Antwort (Standard 10 Min)
 *
 * Heartbeat: Main-Spawn nutzt startrezept.heartbeat (P22-T7, hauptagentHeartbeatAusStartrezept), Standard AUS – still,
 *   nicht taub (wake/Live-Kanal wirken weiter). Andere Identitaeten unveraendert (an, adaptiv).
 * Kein eigener Schalter: der Aufrufer prueft 'hauptagent'. Ausweis nie in Job-args, Ergebnis oder Status.
 */
import { getPool } from '../db/client.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { HAUPTAGENT_AGENT_ID, hauptagentHeartbeatAusStartrezept } from './hauptagent-dienst.js';
import { enqueueSpecialistJob, waitForSpecialistJob, SPECIALIST_ZIEL_RUNTIMES, type SpecialistZielRuntime } from './specialist-queue.js';
import { runtimeProjektPfad, runtimeDaemonZugangStatus } from './runtime-daemon-zugang.js';
import { setzeHeartbeatKonfiguration } from './wrapper-status.js';
import { claimeRuntimeAuftraege, meldeRuntimeAuftrag, type AuftragFuerDaemon } from './runtime-auftraege-ausfuehrung.js';
import type { AgentZiel } from './agent-bezug.js';

export class MainLaufFehler extends Error {
  constructor(readonly code: string, readonly details?: Record<string, unknown>) { super(code); }
}

// ---------------------------------------------------------------------------------------------
// Optionen (O1-O3)
// ---------------------------------------------------------------------------------------------
export interface MainLaufOptionen {
  antwort: 'fertig' | 'live';
  beschaeftigt: 'inbox' | 'fehler';
  ohne_daemon: 'altweg' | 'fehler';
  turn_warte_ms: number;
}

function wahl<T extends string>(wert: string | undefined, erlaubt: readonly T[], standard: T): T {
  return wert && (erlaubt as readonly string[]).includes(wert) ? wert as T : standard;
}

export function leseMainLaufOptionen(env: NodeJS.ProcessEnv = process.env): MainLaufOptionen {
  const ms = Number(env.SYNAPSE_HAUPTAGENT_TURN_MS);
  return {
    antwort: wahl(env.SYNAPSE_HAUPTAGENT_ANTWORT, ['fertig', 'live'] as const, 'fertig'),
    beschaeftigt: wahl(env.SYNAPSE_HAUPTAGENT_BESCHAEFTIGT, ['inbox', 'fehler'] as const, 'inbox'),
    ohne_daemon: wahl(env.SYNAPSE_HAUPTAGENT_OHNE_DAEMON, ['altweg', 'fehler'] as const, 'altweg'),
    turn_warte_ms: Number.isFinite(ms) && ms >= 5_000 ? Math.min(ms, 60 * 60_000) : 10 * 60_000,
  };
}

export function istMainLaufRuntime(runtime: unknown): runtime is SpecialistZielRuntime {
  return typeof runtime === 'string' && (SPECIALIST_ZIEL_RUNTIMES as readonly string[]).includes(runtime);
}

/**
 * P22-T6c: passt ein Registry-Alias zur Runtime? Codex-Container: nur 'codex*' (codex-runtime); Claude-Container: alles
 * andere (claude-CLI-Aliase und api-* Node-Runtimes). Verhindert, dass nach einem Wechsel das Modell der alten Runtime startet.
 */
export function modellPasstZuRuntime(modell: string | null | undefined, runtime: SpecialistZielRuntime): boolean {
  if (!modell) return false;
  return runtime === 'codex' ? /^codex/.test(modell) : !/^codex/.test(modell);
}

// ---------------------------------------------------------------------------------------------
// Texte fuer den Spawn (Wissensschicht baut daraus den Prompt wie bei jedem Spezialisten)
// ---------------------------------------------------------------------------------------------
export const HAUPTAGENT_EXPERTISE = 'Synapse-Hauptagent: spricht im Web-UI-Chat mit dem User, verwaltet sich selbst im erlaubten Rahmen';
export const HAUPTAGENT_AUFGABE = 'Du bist der Synapse-Hauptagent (Identitaet "hauptagent"). Nachrichten des Users aus dem Web-UI-Chat '
  + 'erreichen dich als Weckruf; antworte direkt darauf. Nachrichten von Projektkoordinatoren kommen ueber Inbox/Chat. '
  + 'Deine Identitaet ist dein Synapse-Agenten-Ausweis; die Verbindung schickt ihn automatisch mit – gib ihn nie aus. '
  + 'Selbstverwaltung (Neustart, Update, Modell-/Runtime-Wechsel) nur ueber admin(action:"hauptagent_auftrag") mit hands_off; '
  + 'Stoppen und Rechteaenderungen entscheidet der User.';

// ---------------------------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------------------------
/** Pfad des Hauptagenten im Container. */
export function hauptagentContainerPfad(): string {
  return runtimeProjektPfad(HAUPTAGENT_PROJEKT);
}

export interface MainLaufStand {
  zustand: 'laeuft' | 'startet' | 'aus';
  wrapper: { status: string; busy: boolean; last_activity: string | null } | null;
  spawn_job_id: string | null;
}

export async function leseMainLauf(identityId: string): Promise<MainLaufStand> {
  const w = await getPool().query<{ status: string; busy: boolean; last_activity: Date | null }>(
    'SELECT status, busy, last_activity FROM agent_identitaet_wrapper_status WHERE identity_id=$1 AND project=$2',
    [identityId, HAUPTAGENT_PROJEKT]);
  const wrapper = w.rows[0]
    ? { status: w.rows[0].status, busy: !!w.rows[0].busy, last_activity: w.rows[0].last_activity?.toISOString() ?? null } : null;
  if (wrapper && (wrapper.status === 'running' || wrapper.status === 'idle')) return { zustand: 'laeuft', wrapper, spawn_job_id: null };
  const j = await getPool().query<{ id: string }>(
    `SELECT id FROM specialist_jobs WHERE project=$1 AND target_identity_id=$2 AND action='spawn' AND status IN ('pending','running')
      ORDER BY created_at DESC LIMIT 1`, [HAUPTAGENT_PROJEKT, identityId]);
  return { zustand: j.rows[0] ? 'startet' : 'aus', wrapper, spawn_job_id: j.rows[0]?.id ?? null };
}

/**
 * Container-Daemon der Runtime angemeldet und frisch: wirksamer Runtime-Daemon-Zugang (P22-T5) mit letzter Nutzung
 * (auth_tokens.last_used_at) juenger als frischMs. Der Daemon fragt per Long-Poll alle ~25 s an. Fehler: false.
 */
export async function runtimeDaemonAngemeldet(runtime: SpecialistZielRuntime, frischMs = 90_000): Promise<boolean> {
  try {
    const s = await runtimeDaemonZugangStatus(runtime);
    return s.zugang === 'aktiv' && !!s.zuletzt_genutzt && Date.now() - Date.parse(s.zuletzt_genutzt) < frischMs;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Start (Erstkontakt) und Turn
// ---------------------------------------------------------------------------------------------
async function warteJob(id: string, ms: number): Promise<{ status: string; ergebnis: Record<string, unknown> | null; message?: string; error?: string }> {
  const r = await waitForSpecialistJob(id, ms);
  return { status: r.status, ergebnis: werkzeugErgebnis(r.result), message: r.message, error: r.error };
}

/** Job-Ergebnis der Spezialisten-Tools ist ein MCP-Ergebnis {content:[{type:'text',text:JSON}]}. */
export function werkzeugErgebnis(result: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!result) return null;
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  const text = Array.isArray(content) ? content.find(c => c?.type === 'text')?.text : undefined;
  if (typeof text !== 'string') return result;
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
}

export interface MainStartEingabe {
  identity_id: string;
  runtime: SpecialistZielRuntime;
  modell: string;
  effort?: string | null;
  /** Wie lange auf den Start-Job gewartet wird (Standard 90 s). 0 = nur einreihen. */
  warte_ms?: number;
}

/**
 * Stellt sicher, dass genau EIN Main-Lauf existiert bzw. startet. Paralleler Erstkontakt (Tabs, Retry) wird ueber einen
 * Advisory-Lock serialisiert; laeuft schon ein Wrapper oder ist ein Start offen, wird kein zweiter eingereiht.
 */
export async function stelleMainLaufSicher(e: MainStartEingabe): Promise<{ zustand: MainLaufStand['zustand']; spawn_job_id: string | null; neu: boolean }> {
  if (!istMainLaufRuntime(e.runtime)) throw new MainLaufFehler('runtime_nicht_unterstuetzt', { runtime: e.runtime });
  const sperre = await getPool().connect();
  let jobId: string | null = null;
  let neu = false;
  try {
    await sperre.query('SELECT pg_advisory_lock(hashtext($1))', ['synapse-hauptagent-lauf']);
    const stand = await leseMainLauf(e.identity_id);
    if (stand.zustand === 'laeuft') return { zustand: 'laeuft', spawn_job_id: null, neu: false };
    jobId = stand.spawn_job_id;
    if (!jobId) {
      // Konfiguriertes Profil-Modell (modell_bestaetigt, nach completed modellwechsel nachgezogen) vor dem Runtime-Standard.
      const p = await getPool().query<{ modell_bestaetigt: string | null }>('SELECT modell_bestaetigt FROM agent_identitaeten WHERE id=$1', [e.identity_id]);
      const konfiguriert = p.rows[0]?.modell_bestaetigt?.trim() || null;
      const modell = konfiguriert && modellPasstZuRuntime(konfiguriert, e.runtime) ? konfiguriert : e.modell;
      const job = await enqueueSpecialistJob({
        project: HAUPTAGENT_PROJEKT, action: 'spawn',
        args: {
          name: HAUPTAGENT_AGENT_ID, identity_id: e.identity_id, model: modell, expertise: HAUPTAGENT_EXPERTISE,
          task: HAUPTAGENT_AUFGABE, project: HAUPTAGENT_PROJEKT, project_path: hauptagentContainerPfad(), keep_alive: true,
          target_runtime: e.runtime, ...(e.effort ? { effort: e.effort } : {}),
        },
      });
      jobId = job.id;
      neu = true;
    }
  } finally {
    await sperre.query('SELECT pg_advisory_unlock(hashtext($1))', ['synapse-hauptagent-lauf']).catch(() => undefined);
    sperre.release();
  }
  const warte = e.warte_ms ?? 90_000;
  if (warte <= 0) return { zustand: 'startet', spawn_job_id: jobId, neu };
  const r = await warteJob(jobId, warte);
  if (r.status === 'pending' || r.status === 'running') return { zustand: 'startet', spawn_job_id: jobId, neu };
  if (r.status !== 'done' || r.ergebnis?.success === false) {
    throw new MainLaufFehler(r.error === 'expired' ? 'runtime_daemon_nicht_erreichbar' : 'main_start_fehlgeschlagen', {
      job_id: jobId, status: r.status, meldung: (r.ergebnis?.message as string | undefined) ?? r.message ?? null });
  }
  return { zustand: 'laeuft', spawn_job_id: jobId, neu };
}

export type MainTurnErgebnis =
  | { art: 'antwort'; text: string; usage: { inputTokens: number | null; outputTokens: number | null } }
  | { art: 'zugestellt'; hinweis: string };

/** Ein Chat-Turn des Users an den laufenden Main (Job 'wake'). */
export async function sendeMainTurn(e: {
  identity_id: string; runtime: SpecialistZielRuntime; nachricht: string; optionen?: MainLaufOptionen;
}): Promise<MainTurnErgebnis> {
  const opt = e.optionen ?? leseMainLaufOptionen();
  if (!e.nachricht.trim()) throw new MainLaufFehler('nachricht_leer');
  if (!istMainLaufRuntime(e.runtime)) throw new MainLaufFehler('runtime_nicht_unterstuetzt', { runtime: e.runtime });
  const stand = await leseMainLauf(e.identity_id);
  if (stand.zustand !== 'laeuft') throw new MainLaufFehler('main_laeuft_nicht', { zustand: stand.zustand });
  // O2 'fehler': nicht in die Inbox legen, sondern gleich melden (die lokale Vorlage legt bei busy in die Inbox).
  if (opt.beschaeftigt === 'fehler' && stand.wrapper?.busy) throw new MainLaufFehler('main_beschaeftigt');
  const job = await enqueueSpecialistJob({
    project: HAUPTAGENT_PROJEKT, action: 'wake',
    args: { name: HAUPTAGENT_AGENT_ID, identity_id: e.identity_id, message: e.nachricht, target_runtime: e.runtime },
  });
  const r = await warteJob(job.id, opt.turn_warte_ms);
  if (r.status === 'pending' || r.status === 'running') throw new MainLaufFehler('main_turn_zeitlimit', { job_id: job.id });
  if (r.status !== 'done') {
    throw new MainLaufFehler(r.error === 'expired' ? 'runtime_daemon_nicht_erreichbar' : 'main_turn_fehlgeschlagen',
      { job_id: job.id, status: r.status, meldung: r.message ?? null });
  }
  const erg = r.ergebnis ?? {};
  if (erg.success === false) throw new MainLaufFehler('main_turn_fehlgeschlagen', { job_id: job.id, meldung: erg.message ?? null });
  if (erg.queued === true) return { art: 'zugestellt', hinweis: 'Hauptagent ist beschaeftigt; Nachricht in seiner Inbox zugestellt, Antwort folgt.' };
  const tokens = (erg.tokens ?? {}) as { input?: unknown; output?: unknown };
  return {
    art: 'antwort', text: typeof erg.response === 'string' ? erg.response : '',
    usage: { inputTokens: typeof tokens.input === 'number' ? tokens.input : null, outputTokens: typeof tokens.output === 'number' ? tokens.output : null },
  };
}

// ---------------------------------------------------------------------------------------------
// Runtime-Wechsel (P22-T6c) – Ausfuehrer ist die API, weil beide Container-Daemons beteiligt sind
// ---------------------------------------------------------------------------------------------
export interface RuntimeWechselDienste {
  /** Main-Zuweisung der Runtime-Instanzen (rest-api repository.assignMain). */
  weiseMainZu: (runtime: SpecialistZielRuntime) => Promise<void>;
  /** Aktuell zugewiesene Main-Runtime oder null. */
  zugewiesen: () => Promise<string | null>;
  /** Standardmodell der Ziel-Runtime, wenn der Auftrag keins nennt. */
  standardModell: (runtime: SpecialistZielRuntime) => Promise<string>;
  /** Wartezeit je Schritt (Standard 90 s). */
  warte_ms?: number;
}

async function wechsleRuntime(a: AuftragFuerDaemon, d: RuntimeWechselDienste): Promise<{ modell: string; runtime: string }> {
  const ziel = a.gewuenscht.runtime;
  if (!istMainLaufRuntime(ziel)) throw new MainLaufFehler('runtime_nicht_unterstuetzt', { runtime: ziel });
  const quelle = await d.zugewiesen();
  const warte = d.warte_ms ?? 90_000;
  const gew = typeof a.gewuenscht.modell === 'string' ? a.gewuenscht.modell : null;
  const modell = gew && modellPasstZuRuntime(gew, ziel) ? gew : await d.standardModell(ziel);
  if (!(await runtimeDaemonAngemeldet(ziel))) throw new MainLaufFehler('runtime_daemon_fehlt', { runtime: ziel });
  const failover = a.gewuenscht.failover === 'ja';
  // P22-T58-Failover: der alte Container ist schon gestoppt (docker stop). Kein Stop-Job; die Wrapper-Zeile steht aber noch
  // auf running/idle und wuerde den Start auf der neuen Runtime verhindern -> per CAS (wrapper_pid) auf crashed setzen.
  if (failover) {
    const w = await getPool().query<{ wrapper_pid: number | null }>(
      "SELECT wrapper_pid FROM agent_identitaet_wrapper_status WHERE identity_id=$1 AND project=$2 AND status IN ('running','idle')",
      [a.identity_id, HAUPTAGENT_PROJEKT]);
    if (w.rows[0]) {
      await getPool().query(
        `UPDATE agent_identitaet_wrapper_status SET status='crashed', busy=false, connected_mcp=false
          WHERE identity_id=$1 AND project=$2 AND status IN ('running','idle') AND wrapper_pid IS NOT DISTINCT FROM $3`,
        [a.identity_id, HAUPTAGENT_PROJEKT, w.rows[0].wrapper_pid]);
    }
  }
  // 1) Alte Runtime stoppt den Wrapper, solange sie noch Main-Runtime ist (ihr Daemon sieht synapse-hauptagent nur dann).
  if (!failover && quelle && quelle !== ziel && istMainLaufRuntime(quelle) && (await leseMainLauf(a.identity_id)).zustand === 'laeuft') {
    const stop = await enqueueSpecialistJob({ project: HAUPTAGENT_PROJEKT, action: 'stop',
      args: { name: HAUPTAGENT_AGENT_ID, identity_id: a.identity_id, project_path: hauptagentContainerPfad(), target_runtime: quelle } });
    const r = await warteJob(stop.id, warte);
    if (r.status !== 'done') throw new MainLaufFehler('stop_alte_runtime_fehlgeschlagen', { job_id: stop.id, status: r.status });
  }
  // 2) Zuweisung umstellen, 3) auf der neuen Runtime starten (derselbe Ausweis, dieselbe Identitaet).
  if (quelle !== ziel) await d.weiseMainZu(ziel);
  const start = await stelleMainLaufSicher({ identity_id: a.identity_id, runtime: ziel, modell, warte_ms: warte });
  if (start.zustand !== 'laeuft') throw new MainLaufFehler('main_start_dauert', { spawn_job_id: start.spawn_job_id });
  return { modell, runtime: ziel };
}

/**
 * Fuehrt offene runtime_wechsel-Auftraege des Hauptagenten aus (claim -> accepted -> completed | rejected), Fence wie beim
 * Container-Daemon. Laeuft im API-Prozess im Takt; ohne offenen Auftrag nur ein Claim-Versuch.
 */
export async function fuehreRuntimeWechselAus(d: RuntimeWechselDienste): Promise<number> {
  const projekte = [HAUPTAGENT_PROJEKT];
  const auftraege = await claimeRuntimeAuftraege({ projekte, arten: ['runtime_wechsel'], max: 1 });
  for (const a of auftraege) {
    const fence = { projekte, auftrag_id: a.auftrag_id, claim_revision: a.claim_revision, wer: 'api-runtime-wechsel' };
    try {
      if (a.status === 'claimed') await meldeRuntimeAuftrag({ ...fence, meldung: { schritt: 'accepted' } });
      const t = await wechsleRuntime(a, d);
      await meldeRuntimeAuftrag({ ...fence, meldung: { schritt: 'completed', tatsaechlich: t } });
    } catch (err) {
      const code = err instanceof MainLaufFehler ? err.code : ((err as Error).message ?? 'runtime_wechsel_fehler');
      await meldeRuntimeAuftrag({ ...fence, meldung: { schritt: 'rejected', fehler: code } }).catch(() => undefined);
    }
  }
  return auftraege.length;
}

// ---------------------------------------------------------------------------------------------
// Heartbeat beim Spawn (Daten-Route heartbeat_beim_spawn)
// ---------------------------------------------------------------------------------------------
/**
 * Identitaets-Spawn: Main aus startrezept.heartbeat (Standard AUS), alle anderen wie bisher (an, adaptiv).
 * Ersetzt fuer Identitaeten den festen Aufruf { enabled: true, intervalMs: null } der Daten-Route.
 */
export async function heartbeatBeimSpawnFuerZiel(project: string, ziel: Extract<AgentZiel, { art: 'identity' }>): Promise<void> {
  if (project !== HAUPTAGENT_PROJEKT) {
    await setzeHeartbeatKonfiguration(project, [ziel], { enabled: true, intervalMs: null });
    return;
  }
  const r = await getPool().query<{ startrezept: unknown }>('SELECT startrezept FROM agent_identitaeten WHERE id=$1 AND project=$2',
    [ziel.identity_id, project]);
  const h = hauptagentHeartbeatAusStartrezept(r.rows[0]?.startrezept);
  await setzeHeartbeatKonfiguration(project, [ziel], { enabled: h.aktiv, intervalMs: h.intervall_ms });
}
