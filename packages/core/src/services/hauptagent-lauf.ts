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
import { runtimeProjektPfad, runtimeDaemonZugangStatus, wrapperRuntime, WRAPPER_ZIEL_SQL } from './runtime-daemon-zugang.js';
import { setzeHeartbeatKonfiguration } from './wrapper-status.js';
import { claimeRuntimeAuftraege, meldeRuntimeAuftrag, meldeAuftragFortschritt, type AuftragFuerDaemon } from './runtime-auftraege-ausfuehrung.js';
import type { AgentZiel } from './agent-bezug.js';
import { leseCliModelleSchalter, pruefeModellFuerRuntime, effortFuerStart, pruefeEffortFuerModell } from './hauptagent-modelle.js';

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
 * P22-T62: Altregel (Schalter hauptagent_cli_modelle AUS); EIN prueft pruefeModellFuerRuntime gegen die CLI-Liste.
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
  + 'Stoppen und Rechteaenderungen entscheidet der User. '
  // P22-T79: Sonderstellung (memory grundsatz-main-agent-sonderstellung).
  + 'Du siehst ALLE Projekte des Users lesend ein (Tasks, Plaene, Thoughts, Memories, Channels, Code): gib dafuer project:"<name>" an. '
  + 'Du arbeitest nicht in Projekten; Auftraege gibst du an deren Koordinator. Im internen Bereich synapse-hauptagent liegen keine '
  + 'Projektdaten. Dein bisheriges Gespraech spielt Synapse dir im Abschnitt GEDAECHTNIS ein (falls vorhanden): das bist du.';

// ---------------------------------------------------------------------------------------------
// Zustand
// ---------------------------------------------------------------------------------------------
/** Pfad des Hauptagenten im Container. */
export function hauptagentContainerPfad(): string {
  return runtimeProjektPfad(HAUPTAGENT_PROJEKT);
}

export interface MainLaufStand {
  zustand: 'laeuft' | 'startet' | 'aus';
  /** P22-T71: runtime = wo der Wrapper lebt (Ziel des letzten Spawn-Jobs, sonst provider/model), wrapper_pid fuer CAS. */
  wrapper: { status: string; busy: boolean; last_activity: string | null; runtime: SpecialistZielRuntime | null; wrapper_pid: number | null } | null;
  spawn_job_id: string | null;
  /** P22-T71: ein lebender Main-Wrapper steht auf einer ANDEREN als der angefragten Runtime (z. B. nach halbem Wechsel). */
  andere_runtime: SpecialistZielRuntime | null;
}

const lebt = (w: MainLaufStand['wrapper']): boolean => !!w && (w.status === 'running' || w.status === 'idle');

/**
 * Stand des Main-Laufs. P22-T71: mit runtime gilt ein Wrapper nur als 'laeuft', wenn er auf DIESER Runtime lebt; einer auf
 * einer anderen Runtime steht in andere_runtime (zustand dann 'aus' bzw. 'startet'). Ohne runtime wie bisher (jede Runtime).
 */
export async function leseMainLauf(identityId: string, runtime?: SpecialistZielRuntime | null): Promise<MainLaufStand> {
  const w = await getPool().query<{ status: string; busy: boolean; last_activity: Date | null; ziel: string | null; provider: string | null; model: string | null; wrapper_pid: number | null }>(
    `SELECT w.status, w.busy, w.last_activity, ${WRAPPER_ZIEL_SQL} AS ziel, w.provider, w.model, w.wrapper_pid
       FROM agent_identitaet_wrapper_status w WHERE w.identity_id=$1 AND w.project=$2`,
    [identityId, HAUPTAGENT_PROJEKT]);
  const z = w.rows[0];
  const wrapper = z ? {
    status: z.status, busy: !!z.busy, last_activity: z.last_activity?.toISOString() ?? null,
    runtime: wrapperRuntime(z.ziel, z.provider, z.model), wrapper_pid: z.wrapper_pid ?? null,
  } : null;
  const andere = lebt(wrapper) && runtime && wrapper!.runtime && wrapper!.runtime !== runtime ? wrapper!.runtime : null;
  if (lebt(wrapper) && !andere) return { zustand: 'laeuft', wrapper, spawn_job_id: null, andere_runtime: null };
  const j = await getPool().query<{ id: string }>(
    `SELECT id FROM specialist_jobs WHERE project=$1 AND target_identity_id=$2 AND action='spawn' AND status IN ('pending','running')
       AND ($3::text IS NULL OR args->>'target_runtime' = $3) ORDER BY created_at DESC LIMIT 1`, [HAUPTAGENT_PROJEKT, identityId, runtime ?? null]);
  return { zustand: j.rows[0] ? 'startet' : 'aus', wrapper, spawn_job_id: j.rows[0]?.id ?? null, andere_runtime: andere };
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

// ---------------------------------------------------------------------------------------------
// Beenden (P22-T71)
// ---------------------------------------------------------------------------------------------
/** Frist des Wrappers fuer einen Stop ohne Speicher-Runde (SIGUSR2), danach SIGKILL im Daemon. */
export const MAIN_STOP_FRIST_MS = 15_000;
/** Ohne Lebenszeichen so lange gilt ein Wrapper, den der Daemon nicht kennt ('nicht verbunden'), als verwaist. */
export const MAIN_VERWAIST_MS = 180_000;
const schlafe = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

export interface MainStopErgebnis {
  beendet: boolean;
  weg: 'schon_aus' | 'gestoppt' | 'erzwungen' | 'fehlgeschlagen';
  /** Warum der Stop-Job den Prozesstod nicht nachweisen konnte (z. B. 'Prozesstod UNGEPRUEFT: ...'); null = nachgewiesen. */
  grund: string | null;
  job_id: string | null;
}

/** CAS auf die PID: ein inzwischen neu gestarteter Wrapper (andere PID) bleibt unberuehrt. */
async function setzeMainZeile(identityId: string, pid: number | null, status: 'stopped' | 'crashed'): Promise<void> {
  await getPool().query(
    `UPDATE agent_identitaet_wrapper_status SET status=$4, busy=false, connected_mcp=false
      WHERE identity_id=$1 AND project=$2 AND status IN ('running','idle') AND wrapper_pid IS NOT DISTINCT FROM $3`,
    [identityId, HAUPTAGENT_PROJEKT, pid, status]);
}

/**
 * P22-T71: beendet den Main-Wrapper auf `runtime` WIRKLICH. Stop-Job ohne Speicher-Runde (die Uebergabe kommt aus dem Verlauf,
 * P22-T63 D) mit erwarteter PID. Erfolg nur bei nachgewiesenem Prozesstod bzw. beendeter Statuszeile – ein 'done' mit
 * success:false ('Prozesstod UNGEPRUEFT', Ursache der Befunde 37e3ff9d/cdf29dc3) genuegt NICHT. Lebt er danach weiter: erzwinge
 * (Container-Neustart dieser Runtime, Dienst des Aufrufers) und Zeile per CAS auf crashed; ohne erzwinge: beendet=false.
 */
export async function beendeMainLauf(identityId: string, runtime: SpecialistZielRuntime, o: {
  warte_ms?: number; erzwinge?: ((runtime: SpecialistZielRuntime) => Promise<void>) | null;
} = {}): Promise<MainStopErgebnis> {
  const hier = (s: MainLaufStand): boolean => lebt(s.wrapper) && (!s.wrapper!.runtime || s.wrapper!.runtime === runtime);
  const vorher = await leseMainLauf(identityId);
  if (!hier(vorher)) return { beendet: true, weg: 'schon_aus', grund: null, job_id: null };
  const pid = vorher.wrapper!.wrapper_pid;
  // Hoechstens ein offener Stop je Runtime (paralleler Wechsel/Turn wartet auf denselben Job).
  const offen = await getPool().query<{ id: string }>(
    `SELECT id FROM specialist_jobs WHERE project=$1 AND target_identity_id=$2 AND action='stop' AND status IN ('pending','running')
       AND args->>'target_runtime' = $3 ORDER BY created_at DESC LIMIT 1`, [HAUPTAGENT_PROJEKT, identityId, runtime]);
  const jobId = offen.rows[0]?.id ?? (await enqueueSpecialistJob({
    project: HAUPTAGENT_PROJEKT, action: 'stop',
    args: {
      name: HAUPTAGENT_AGENT_ID, identity_id: identityId, project_path: hauptagentContainerPfad(), target_runtime: runtime,
      ohne_sicherung: true, frist_ms: MAIN_STOP_FRIST_MS, ...(pid ? { wrapper_pid: pid } : {}),
    },
  })).id;
  const r = await warteJob(jobId, o.warte_ms ?? MAIN_STOP_FRIST_MS + 20_000);
  const nachgewiesen = r.status === 'done' && r.ergebnis?.success === true;
  const grund = nachgewiesen ? null : r.status === 'done'
    ? String(r.ergebnis?.message ?? 'stop_ohne_erfolg').slice(0, 300) : `stop_job_${r.status}${r.error ? ':' + r.error : ''}`;
  // P22-T71: Stop-Ergebnis im API-Log sichtbar (im Auftrag steht es im Fortschritt bzw. im Ablehnungsgrund).
  console.error(`[hauptagent-lauf] stop ${runtime} pid ${pid ?? '-'} job ${jobId}: ${nachgewiesen ? 'Prozess beendet' : 'NICHT nachgewiesen: ' + grund}`);
  // Der Wrapper setzt beim Beenden selbst 'stopped'; kurz darauf warten (eine neue PID heisst: schon ersetzt).
  const ende = Date.now() + (nachgewiesen ? 2_000 : 10_000);
  let jetzt = await leseMainLauf(identityId);
  while (hier(jetzt) && jetzt.wrapper!.wrapper_pid === pid && Date.now() < ende) {
    await schlafe(500);
    jetzt = await leseMainLauf(identityId);
  }
  if (!hier(jetzt) || jetzt.wrapper!.wrapper_pid !== pid) return { beendet: true, weg: 'gestoppt', grund, job_id: jobId };
  if (nachgewiesen) {
    await setzeMainZeile(identityId, pid, 'stopped');
    return { beendet: true, weg: 'gestoppt', grund: null, job_id: jobId };
  }
  if (!o.erzwinge) return { beendet: false, weg: 'fehlgeschlagen', grund, job_id: jobId };
  try {
    await o.erzwinge(runtime);
  } catch (err) {
    return { beendet: false, weg: 'fehlgeschlagen', grund: `${grund}; erzwingen: ${((err as Error).message ?? String(err)).slice(0, 200)}`, job_id: jobId };
  }
  await setzeMainZeile(identityId, pid, 'crashed');
  return { beendet: true, weg: 'erzwungen', grund, job_id: jobId };
}

export interface MainStartEingabe {
  identity_id: string;
  runtime: SpecialistZielRuntime;
  modell: string;
  effort?: string | null;
  /** Wie lange auf den Start-Job gewartet wird (Standard 90 s). 0 = nur einreihen. */
  warte_ms?: number;
  /** P22-T62 (Schalter hauptagent_cli_modelle EIN): ausdruecklich gewaehltes Modell geht vor dem konfigurierten Profil-Modell. */
  modell_explizit?: boolean;
  /** P22-T71: letzter Ausweg, wenn ein Wrapper auf einer anderen Runtime sich nicht stoppen laesst (Container-Neustart). */
  erzwinge?: ((runtime: SpecialistZielRuntime) => Promise<void>) | null;
}

/**
 * Stellt sicher, dass genau EIN Main-Lauf existiert bzw. startet. Paralleler Erstkontakt (Tabs, Retry) wird ueber einen
 * Advisory-Lock serialisiert; laeuft schon ein Wrapper oder ist ein Start offen, wird kein zweiter eingereiht.
 */
export async function stelleMainLaufSicher(e: MainStartEingabe): Promise<{ zustand: MainLaufStand['zustand']; spawn_job_id: string | null; neu: boolean }> {
  if (!istMainLaufRuntime(e.runtime)) throw new MainLaufFehler('runtime_nicht_unterstuetzt', { runtime: e.runtime });
  // P22-T71: lebt der Main noch auf einer anderen Runtime (halber Wechsel), erst dort beenden – zwei Wrapper derselben
  // Identitaet schrieben sonst abwechselnd dieselbe Statuszeile, und Turns gingen an den falschen.
  const vorab = await leseMainLauf(e.identity_id, e.runtime);
  if (vorab.andere_runtime) {
    const b = await beendeMainLauf(e.identity_id, vorab.andere_runtime, { erzwinge: e.erzwinge ?? null });
    if (!b.beendet) throw new MainLaufFehler('main_laeuft_auf_anderer_runtime', { runtime: vorab.andere_runtime, job_id: b.job_id, meldung: b.grund });
  }
  const sperre = await getPool().connect();
  let jobId: string | null = null;
  let neu = false;
  try {
    await sperre.query('SELECT pg_advisory_lock(hashtext($1))', ['synapse-hauptagent-lauf']);
    const stand = await leseMainLauf(e.identity_id, e.runtime);
    if (stand.zustand === 'laeuft') return { zustand: 'laeuft', spawn_job_id: null, neu: false };
    if (stand.andere_runtime) throw new MainLaufFehler('main_laeuft_auf_anderer_runtime', { runtime: stand.andere_runtime });
    jobId = stand.spawn_job_id;
    if (!jobId) {
      // Konfiguriertes Profil-Modell (modell_bestaetigt, nach completed modellwechsel nachgezogen) vor dem Runtime-Standard.
      const p = await getPool().query<{ modell_bestaetigt: string | null }>('SELECT modell_bestaetigt FROM agent_identitaeten WHERE id=$1', [e.identity_id]);
      const konfiguriert = p.rows[0]?.modell_bestaetigt?.trim() || null;
      // P22-T62: Schalter EIN -> Profil-Modell nur, wenn es in der Liste der Ziel-Runtime steht; ausdrueckliche Wahl geht vor.
      const ein = (await leseCliModelleSchalter()).aktiv;
      let modell = e.modell;
      if (konfiguriert && !(ein && e.modell_explizit)) {
        if (!ein) modell = modellPasstZuRuntime(konfiguriert, e.runtime) ? konfiguriert : e.modell;
        else {
          const pr = await pruefeModellFuerRuntime(konfiguriert, e.runtime, { schalter: true });
          if (pr.passt) modell = pr.modell;
        }
      }
      // P22-T65 (Schalter EIN): ohne ausdrueckliche Stufe die gespeicherte Wahl dieses Modells bzw. sein standard_effort.
      let effort = e.effort ?? null;
      if (ein && !effort && (e.runtime === 'claude' || e.runtime === 'codex')) effort = (await effortFuerStart(e.runtime, modell)).effort;
      const job = await enqueueSpecialistJob({
        project: HAUPTAGENT_PROJEKT, action: 'spawn',
        args: {
          name: HAUPTAGENT_AGENT_ID, identity_id: e.identity_id, model: modell, expertise: HAUPTAGENT_EXPERTISE,
          task: HAUPTAGENT_AUFGABE, project: HAUPTAGENT_PROJEKT, project_path: hauptagentContainerPfad(), keep_alive: true,
          target_runtime: e.runtime, ...(effort ? { effort } : {}),
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
  | { art: 'antwort'; text: string; usage: { inputTokens: number | null; outputTokens: number | null; kontextTokens?: number } }
  /** P22-T73: inbox_id = Inbox-Zeile des Einwurfs (die Zustellung ordnet die spaetere Antwort darueber zu); null bei alten Daemons. */
  | { art: 'zugestellt'; hinweis: string; inbox_id: number | null };

/** Ein Chat-Turn des Users an den laufenden Main (Job 'wake'). */
export async function sendeMainTurn(e: {
  identity_id: string; runtime: SpecialistZielRuntime; nachricht: string; optionen?: MainLaufOptionen;
  /** P22-T73: Absender des Inbox-Rueckfalls bei beschaeftigtem Main (Web-UI-Chat: 'user'). */
  absender?: string;
}): Promise<MainTurnErgebnis> {
  const opt = e.optionen ?? leseMainLaufOptionen();
  if (!e.nachricht.trim()) throw new MainLaufFehler('nachricht_leer');
  if (!istMainLaufRuntime(e.runtime)) throw new MainLaufFehler('runtime_nicht_unterstuetzt', { runtime: e.runtime });
  const stand = await leseMainLauf(e.identity_id, e.runtime);
  if (stand.zustand !== 'laeuft') throw new MainLaufFehler('main_laeuft_nicht', { zustand: stand.zustand, andere_runtime: stand.andere_runtime });
  // O2 'fehler': nicht in die Inbox legen, sondern gleich melden (die lokale Vorlage legt bei busy in die Inbox).
  if (opt.beschaeftigt === 'fehler' && stand.wrapper?.busy) throw new MainLaufFehler('main_beschaeftigt');
  const job = await enqueueSpecialistJob({
    project: HAUPTAGENT_PROJEKT, action: 'wake',
    args: { name: HAUPTAGENT_AGENT_ID, identity_id: e.identity_id, message: e.nachricht, target_runtime: e.runtime, ...(e.absender ? { absender: e.absender } : {}) },
  });
  const r = await warteJob(job.id, opt.turn_warte_ms);
  if (r.status === 'pending' || r.status === 'running') throw new MainLaufFehler('main_turn_zeitlimit', { job_id: job.id });
  if (r.status !== 'done') {
    throw new MainLaufFehler(r.error === 'expired' ? 'runtime_daemon_nicht_erreichbar' : 'main_turn_fehlgeschlagen',
      { job_id: job.id, status: r.status, meldung: r.message ?? null });
  }
  const erg = r.ergebnis ?? {};
  if (erg.success === false) {
    const meldung = typeof erg.message === 'string' ? erg.message : null;
    // P22-T71: 'nicht verbunden' = der Daemon dieser Runtime kennt keinen laufenden Wrapper. Ist die Statuszeile zudem ohne
    // Lebenszeichen seit MAIN_VERWAIST_MS, gilt sie als crashed (CAS auf PID), damit der naechste Start nicht blockiert.
    if (meldung && /nicht verbunden/i.test(meldung)) {
      const zuletzt = stand.wrapper?.last_activity ? Date.parse(stand.wrapper.last_activity) : 0;
      if (Date.now() - zuletzt > MAIN_VERWAIST_MS) await setzeMainZeile(e.identity_id, stand.wrapper?.wrapper_pid ?? null, 'crashed');
      throw new MainLaufFehler('main_nicht_verbunden', { job_id: job.id, meldung });
    }
    throw new MainLaufFehler('main_turn_fehlgeschlagen', { job_id: job.id, meldung });
  }
  if (erg.queued === true) {
    const inbox = Number(erg.inbox_id);
    return { art: 'zugestellt', hinweis: 'Hauptagent ist beschaeftigt; Nachricht in seiner Inbox zugestellt, Antwort folgt.',
      inbox_id: Number.isSafeInteger(inbox) && inbox > 0 ? inbox : null };
  }
  const tokens = (erg.tokens ?? {}) as { input?: unknown; output?: unknown; kontext?: unknown };
  // P22-T70: Kontextstand misst der Wrapper (JSONL); fehlt er (altes Runtime-Image), bleibt der Kontext 'nicht gemessen'.
  const kontext = typeof tokens.kontext === 'number' && tokens.kontext > 0 ? tokens.kontext : null;
  return {
    art: 'antwort', text: typeof erg.response === 'string' ? erg.response : '',
    usage: {
      inputTokens: typeof tokens.input === 'number' ? tokens.input : null, outputTokens: typeof tokens.output === 'number' ? tokens.output : null,
      ...(kontext ? { kontextTokens: kontext } : {}),
    },
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
  /** Wartezeit je Schritt (Standard 90 s); der Start auf der Ziel-Runtime darf doppelt so lange dauern. */
  warte_ms?: number;
  /** P22-T71: letzter Ausweg, wenn der alte Wrapper den Stop ueberlebt: Container-Neustart der alten Runtime. */
  erzwingeStop?: (runtime: SpecialistZielRuntime) => Promise<void>;
}

type Fortschritt = (schritt: string, details?: Record<string, unknown>) => Promise<void>;

async function wechsleRuntime(a: AuftragFuerDaemon, d: RuntimeWechselDienste, fortschritt: Fortschritt = async () => undefined): Promise<{ modell: string; runtime: string }> {
  const ziel = a.gewuenscht.runtime;
  if (!istMainLaufRuntime(ziel)) throw new MainLaufFehler('runtime_nicht_unterstuetzt', { runtime: ziel });
  const quelle = await d.zugewiesen();
  const warte = d.warte_ms ?? 90_000;
  const gew = typeof a.gewuenscht.modell === 'string' ? a.gewuenscht.modell : null;
  // P22-T62: Schalter EIN -> gewuenschtes Modell muss in der Liste der Ziel-Runtime stehen; sonst ehrliche Ablehnung statt
  // stillem Ersetzen. Ohne Wunsch: Standard (User-Wahl der Runtime bzw. kleinstes Modell).
  const ein = (await leseCliModelleSchalter()).aktiv;
  let modell: string;
  if (ein && gew) {
    const pr = await pruefeModellFuerRuntime(gew, ziel, { schalter: true });
    if (!pr.passt) throw new MainLaufFehler(pr.grund ?? 'modell_passt_nicht', { modell: gew, runtime: ziel, gelistet: pr.gelistet });
    modell = pr.modell;
  } else {
    modell = gew && !ein && modellPasstZuRuntime(gew, ziel) ? gew : await d.standardModell(ziel);
  }
  // P22-T65 (Schalter EIN): gewuenschte Effort-Stufe muss zum Modell passen (ausgelesene Stufen), sonst ehrliche Ablehnung.
  const gewEffort = typeof a.gewuenscht.effort === 'string' ? a.gewuenscht.effort : null;
  let effort: string | null = null;
  if (ein && gewEffort) {
    const pe = await pruefeEffortFuerModell(ziel, modell, gewEffort);
    if (!pe.ok) throw new MainLaufFehler(pe.grund ?? 'effort_ungueltig', { effort: gewEffort, modell, stufen: pe.stufen });
    effort = pe.effort;
  }
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
  // 1) P22-T71: alten Lauf WIRKLICH beenden, bevor die Zuweisung wechselt (ohne Speicher-Runde, die Uebergabe kommt aus dem
  //    Verlauf). Massgeblich ist die Runtime des lebenden Wrappers – nach einem halben Wechsel nicht unbedingt die zugewiesene.
  if (!failover) {
    const st = await leseMainLauf(a.identity_id);
    const alt = lebt(st.wrapper) ? (st.wrapper!.runtime ?? (istMainLaufRuntime(quelle) ? quelle : null)) : null;
    if (alt && alt !== ziel) {
      await fortschritt('stoppt_alt', { runtime: alt });
      const b = await beendeMainLauf(a.identity_id, alt, { erzwinge: d.erzwingeStop ?? null });
      if (!b.beendet) throw new MainLaufFehler('stop_alte_runtime_fehlgeschlagen', { runtime: alt, job_id: b.job_id, meldung: b.grund });
      await fortschritt('alt_gestoppt', { runtime: alt, weg: b.weg, stop_job_id: b.job_id, stop_ergebnis: b.grund ?? 'Prozess nachweislich beendet' });
    }
  }
  // P22-T63 D: Uebergabe aus dem Verlauf als Startkontext des neuen Laufs (User-/Selbstwechsel, Failover; wirft nie).
  const { erzeugeVerlaufUebergabe } = await import('./hauptagent-verlauf.js');
  const handsOff = (a as { hands_off?: { thought_id?: unknown } | null }).hands_off;
  await erzeugeVerlaufUebergabe(a.identity_id, { runtime: ziel, modell, effort }, failover ? 'failover' : 'runtime_wechsel',
    typeof handsOff?.thought_id === 'string' ? handsOff.thought_id : null);
  // 2) Zuweisung umstellen, 3) auf der neuen Runtime starten (derselbe Ausweis, dieselbe Identitaet).
  if (quelle !== ziel) await d.weiseMainZu(ziel);
  // P22-T71: fertig erst, wenn der Main auf der Ziel-Runtime laeuft (sonst gaebe es ein 'completed' ohne Main).
  await fortschritt('startet', { runtime: ziel, modell });
  const start = await stelleMainLaufSicher({
    identity_id: a.identity_id, runtime: ziel, modell, warte_ms: warte * 2, modell_explizit: ein && !!gew, effort, erzwinge: d.erzwingeStop ?? null,
  });
  if (start.zustand !== 'laeuft') throw new MainLaufFehler('main_start_dauert', { spawn_job_id: start.spawn_job_id });
  await fortschritt('laeuft', { runtime: ziel, modell });
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
      const fortschritt: Fortschritt = async (schritt, details) => {
        await meldeAuftragFortschritt({ auftrag_id: a.auftrag_id, claim_revision: a.claim_revision, schritt, details }).catch(() => undefined);
      };
      const t = await wechsleRuntime(a, d, fortschritt);
      await meldeRuntimeAuftrag({ ...fence, meldung: { schritt: 'completed', tatsaechlich: t } });
    } catch (err) {
      // P22-T71: Code UND Ursache (z. B. 'Prozesstod UNGEPRUEFT: ...'), damit Chip und Debug den echten Grund zeigen.
      const code = err instanceof MainLaufFehler ? err.code : ((err as Error).message ?? 'runtime_wechsel_fehler');
      const meldung = err instanceof MainLaufFehler && typeof err.details?.meldung === 'string' ? err.details.meldung : null;
      await meldeRuntimeAuftrag({ ...fence, meldung: { schritt: 'rejected', fehler: (meldung ? `${code}: ${meldung}` : code).slice(0, 500) } }).catch(() => undefined);
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
