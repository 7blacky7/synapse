/**
 * MODUL: Daemon-Job-Vertrag (P9-T27, Welle 1, Schritte 1 und 2)
 * ZWECK: API-Seite fuer lokale FileWatcher-Daemons, die Shell- und Spezialisten-Jobs NICHT mehr
 *        selbst per PostgreSQL (LISTEN/claim/complete) abwickeln, sondern ueber die Synapse-API
 *        (routes/daemon-jobs.ts, Auth ueber den vorhandenen Tray-/Daemon-Token).
 *
 * MUSTER: wie die intern-Bruecke (daemon-bruecke.ts): Long-Poll zum Abholen, eigene Route zum
 *   Melden. Unterschied: die Jobs liegen weiterhin in PG (shell_jobs, specialist_jobs) — die API
 *   claimt sie STELLVERTRETEND fuer den Daemon mit genau denselben Core-Funktionen wie bisher
 *   (claimPendingShellJob, completeShellJob, ...). Verhalten der Queue bleibt dadurch identisch.
 *
 * WECKER: Ein gemeinsamer LISTEN-Client dieses API-Prozesses auf shell_job_created,
 *   shell_job_cancel und specialist_job_created weckt wartende Long-Polls. Faellt er aus, greift
 *   die Nachfrage im festen Takt (NACHFRAGE_MS) — er ist Beschleuniger, kein Fundament.
 *
 * ZURUECKGEBEN: Ist die Verbindung des Daemons waehrend des Long-Polls weg, werden bereits
 *   geclaimte Jobs wieder auf 'pending' gesetzt (nur, wenn sie noch diesem Daemon gehoeren und
 *   'running' sind). Sonst stuende ein nie gestarteter Job bis zum naechsten Daemon-Neustart auf
 *   'running'.
 *
 * ADDITIV: Der bisherige PG-Weg im Daemon bleibt unveraendert und ist die Vorgabe. Diese Datei
 *   aendert keine bestehende Funktion.
 */

import { EventEmitter } from 'node:events';
import type { Client } from 'pg';
import { getPool, verbindeListenClient } from '../db/index.js';
import {
  claimPendingShellJob,
  completeShellJob,
  type ShellJobCompletion,
  type ShellJobRow,
} from './shell-queue.js';
import {
  claimPendingSpecialistJob,
  completeSpecialistJob,
  type SpecialistJobCompletion,
  type SpecialistJobRow,
  type SpecialistZielRuntime,
} from './specialist-queue.js';
import { runtimeProjektPfad, projekteDerRuntime, projekteMitRuntimeAgenten } from './runtime-daemon-zugang.js';

/** Obergrenze des Long-Polls (wie die intern-Bruecke). */
export const DAEMON_JOB_WARTE_MAX_S = 25;
/** Hoechstzahl Jobs je Abruf — Schutz gegen einen Daemon, der unbegrenzt frei meldet. */
export const DAEMON_JOB_MAX_JE_ABRUF = 16;
/** Takt der Nachfrage, falls der LISTEN-Wecker fehlt oder ein Signal verloren geht. */
const NACHFRAGE_MS = 2_000;

const KANAELE = ['shell_job_created', 'shell_job_cancel', 'specialist_job_created'] as const;
type WeckKanal = (typeof KANAELE)[number];

// ── Wecker ──────────────────────────────────────────────────────────────────

const wecker = new EventEmitter();
wecker.setMaxListeners(0);
let weckClient: Client | null = null;
let weckVerbindung: Promise<void> | null = null;
let weckGeschlossen = false;

async function stelleWeckerSicher(): Promise<void> {
  if (weckClient || weckGeschlossen) return;
  if (weckVerbindung) return weckVerbindung;
  weckVerbindung = (async () => {
    try {
      const client = await verbindeListenClient();
      for (const k of KANAELE) await client.query(`LISTEN ${k}`);
      client.on('notification', (msg: { channel: string; payload?: string }) => {
        wecker.emit(msg.channel, msg.payload ?? '');
      });
      client.on('error', (err: Error) => {
        console.error('[daemon-jobs] LISTEN-Wecker Fehler, Nachfrage im Takt laeuft weiter:', err.message);
        try { void client.end(); } catch { /* ignore */ }
        if (weckClient === client) weckClient = null;
      });
      weckClient = client;
    } catch (err) {
      console.error('[daemon-jobs] LISTEN-Wecker nicht verfuegbar, Nachfrage im Takt:', (err as Error).message);
    } finally {
      weckVerbindung = null;
    }
  })();
  return weckVerbindung;
}

/** Beim Schliessen der API (Deploy): Wecker beenden. */
export async function schliesseDaemonJobWecker(): Promise<void> {
  weckGeschlossen = true;
  const c = weckClient;
  weckClient = null;
  if (c) {
    try { await c.query('UNLISTEN *'); } catch { /* ignore */ }
    try { await c.end(); } catch { /* ignore */ }
  }
}

/** Wartet auf ein Signal eines der Kanaele oder bis ms abgelaufen sind (hoechstens NACHFRAGE_MS). */
function warteAufSignal(kanaele: WeckKanal[], ms: number): Promise<void> {
  return new Promise((resolve) => {
    const dauer = Math.max(0, Math.min(ms, NACHFRAGE_MS));
    const fertig = () => {
      clearTimeout(timer);
      for (const k of kanaele) wecker.removeListener(k, fertig);
      resolve();
    };
    const timer = setTimeout(fertig, dauer);
    for (const k of kanaele) wecker.on(k, fertig);
  });
}

// ── Pruefungen ──────────────────────────────────────────────────────────────

/** Daemon-ID wie im Daemon gebildet: daemon-<hostname>-<pid>. Der Host muss dazu passen. */
export function istGueltigeDaemonId(daemonId: unknown, host: string): daemonId is string {
  if (typeof daemonId !== 'string' || daemonId.length > 200) return false;
  const praefix = `daemon-${host}-`;
  return daemonId.startsWith(praefix) && /^\d{1,10}$/.test(daemonId.slice(praefix.length));
}

/** Projektliste aus Query (Komma-getrennt) oder Array; ungueltige Namen fallen weg. */
export function leseProjektListe(roh: unknown): string[] {
  const teile = Array.isArray(roh) ? roh : typeof roh === 'string' ? roh.split(',') : [];
  const aus = new Set<string>();
  for (const t of teile) {
    const p = String(t).trim();
    if (p && p.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(p)) aus.add(p);
  }
  return [...aus].slice(0, 200);
}

/**
 * P9-T27 Nachbesserung (Abnahme d996c097): nur Projekte, die auf GENAU diesem Host registriert sind
 * (projects.hostname = host, keine /virtual/-Zeile). Der Host kommt aus dem Daemon-Token (Route),
 * nie vom Client. So claimt/reapt ein Daemon nie Jobs fremder Projekte, auch wenn er sie in
 * `projekte` nennt. Reihenfolge der Eingabe bleibt erhalten.
 */
export async function projekteDesHosts(projekte: string[], host: string): Promise<string[]> {
  if (projekte.length === 0) return [];
  const { rows } = await getPool().query<{ name: string }>(
    "SELECT DISTINCT name FROM projects WHERE name = ANY($1::text[]) AND hostname = $2 AND path NOT LIKE '/virtual/%'",
    [projekte, host],
  );
  const erlaubt = new Set(rows.map((r) => r.name));
  return projekte.filter((p) => erlaubt.has(p));
}

export interface DaemonAbrufOptionen {
  daemonId: string;
  host: string;
  projekte: string[];
  warteMs: number;
  /** true = Verbindung des Daemons ist weg; dann nichts mehr claimen und Geclaimtes zurueckgeben. */
  istGeschlossen: () => boolean;
  /**
   * P22-T6: Container-Daemon (Principal runtime-daemon). projekte hat die Route bereits auf die Projekte
   * dieser Runtime geprueft; geclaimt werden nur Jobs mit args.target_runtime = runtime. Ohne Wert: PC-Weg.
   */
  runtime?: SpecialistZielRuntime;
}

// ── Shell-Jobs ──────────────────────────────────────────────────────────────

/** Laufende Jobs dieses Daemons mit Abbruchwunsch (ersetzt LISTEN shell_job_cancel). */
export async function shellAbbruchWuensche(daemonId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT id FROM shell_jobs
      WHERE status = 'running' AND claimed_by = $1 AND cancelled_at IS NOT NULL`,
    [daemonId],
  );
  return rows.map((r) => r.id);
}

/** Setzt einen noch nicht gestarteten Claim zurueck auf 'pending' (nur eigener, laufender Claim). */
export async function gibShellJobZurueck(id: string, daemonId: string): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE shell_jobs
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
      WHERE id = $1 AND claimed_by = $2 AND status = 'running'`,
    [id, daemonId],
  );
  return (r.rowCount ?? 0) > 0;
}

export interface ShellDaemonAbruf {
  jobs: ShellJobRow[];
  abbrueche: string[];
}

/**
 * Long-Poll eines Daemons: claimt bis zu `frei` pending Jobs seiner aktiven Projekte (aelteste
 * zuerst, je Projekt mit claimPendingShellJob) und liefert Abbruchwuensche seiner laufenden Jobs.
 * Kehrt sofort zurueck, sobald etwas anliegt, sonst nach warteMs mit leeren Listen.
 * frei = 0: nur Abbruchwuensche (z. B. waehrend einer Worker-Pause oder bei vollen Slots).
 */
export async function holeShellJobsFuerDaemon(o: DaemonAbrufOptionen & { frei: number }): Promise<ShellDaemonAbruf> {
  void stelleWeckerSicher();
  const frei = Math.max(0, Math.min(Math.floor(o.frei), DAEMON_JOB_MAX_JE_ABRUF));
  const ende = Date.now() + Math.max(0, o.warteMs);
  for (;;) {
    const abbrueche = await shellAbbruchWuensche(o.daemonId);
    const jobs: ShellJobRow[] = [];
    if (frei > 0) {
      // Host-Filter je Durchlauf: nur Projekte, die auf o.host liegen (claimPendingShellJob kennt keinen Host).
      const projekte = await projekteDesHosts(o.projekte, o.host);
      let weiter = true;
      while (weiter && jobs.length < frei && !o.istGeschlossen()) {
        weiter = false;
        for (const projekt of projekte) {
          if (jobs.length >= frei || o.istGeschlossen()) break;
          const job = await claimPendingShellJob(projekt, o.daemonId);
          if (job) { jobs.push(job); weiter = true; }
        }
      }
    }
    if (o.istGeschlossen()) {
      for (const j of jobs) await gibShellJobZurueck(j.id, o.daemonId).catch(() => false);
      return { jobs: [], abbrueche: [] };
    }
    if (jobs.length > 0 || abbrueche.length > 0) return { jobs, abbrueche };
    const rest = ende - Date.now();
    if (rest <= 0) return { jobs: [], abbrueche: [] };
    await warteAufSignal(['shell_job_created', 'shell_job_cancel'], rest);
  }
}

export interface DaemonAbschlussErgebnis {
  ok: boolean;
  /** job_unbekannt | nicht_eigener_job */
  error?: string;
  status?: string;
}

/**
 * Abschluss eines Shell-Jobs durch den Daemon, der ihn geclaimt hat. Danach exakt der bisherige
 * Weg (completeShellJob: Maskierung, Cap, Abbruch-Vorrang, Demaskierung, NOTIFY).
 */
export async function schliesseShellJobFuerDaemon(
  id: string,
  daemonId: string,
  abschluss: ShellJobCompletion,
): Promise<DaemonAbschlussErgebnis> {
  const { rows } = await getPool().query<{ claimed_by: string | null; status: string }>(
    'SELECT claimed_by, status FROM shell_jobs WHERE id = $1',
    [id],
  );
  if (rows.length === 0) return { ok: false, error: 'job_unbekannt' };
  if (rows[0].claimed_by !== daemonId) return { ok: false, error: 'nicht_eigener_job', status: rows[0].status };
  await completeShellJob(id, abschluss);
  const nach = await getPool().query<{ status: string }>('SELECT status FROM shell_jobs WHERE id = $1', [id]);
  return { ok: true, status: nach.rows[0]?.status };
}

// ── Spezialisten-Jobs ───────────────────────────────────────────────────────

/** Wie lokalerProjektpfad (wrapper-prozess.ts), aber fuer den Host des anfragenden Daemons. */
export async function lokalerProjektpfadFuerHost(project: string, host: string): Promise<string | null> {
  const { rows } = await getPool().query<{ path: string; hostname: string }>(
    "SELECT DISTINCT path,hostname FROM projects WHERE name=$1 AND path NOT LIKE '/virtual/%'",
    [project],
  );
  return rows.length === 1 && rows[0].hostname === host ? rows[0].path : null;
}

export type SpecialistDaemonJob = SpecialistJobRow & { lokaler_projektpfad: string | null };

export async function gibSpecialistJobZurueck(id: string, daemonId: string): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE specialist_jobs
        SET status = 'pending', claimed_by = NULL, claimed_at = NULL, updated_at = NOW()
      WHERE id = $1 AND claimed_by = $2 AND status = 'running'`,
    [id, daemonId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Long-Poll fuer Spezialisten-Jobs (claimPendingSpecialistJob mit Host-Filter wie bisher). */
export async function holeSpecialistJobsFuerDaemon(o: DaemonAbrufOptionen): Promise<SpecialistDaemonJob[]> {
  void stelleWeckerSicher();
  const ende = Date.now() + Math.max(0, o.warteMs);
  for (;;) {
    const jobs: SpecialistJobRow[] = [];
    // Host-Filter wie bei Shell-Jobs: nur Projekte dieses Hosts (zusaetzlich zu target_hostname).
    // P22-T82: der Container-Daemon fragt nur nach Projekten, die er kennt; Jobs an seine Runtime in anderen Projekten (Spawn
    // eines Spezialisten im Container) kommen ueber projekteMitRuntimeAgenten dazu, je Runde frisch.
    const projekte = o.runtime
      ? [...new Set([...o.projekte, ...await projekteDerRuntime(await projekteMitRuntimeAgenten(o.runtime).catch(() => []), o.runtime)])]
      : await projekteDesHosts(o.projekte, o.host);
    for (const projekt of projekte) {
      if (jobs.length >= DAEMON_JOB_MAX_JE_ABRUF || o.istGeschlossen()) break;
      const job = await claimPendingSpecialistJob(projekt, o.daemonId, o.runtime ? undefined : o.host, o.runtime);
      if (job) jobs.push(job);
    }
    if (o.istGeschlossen()) {
      for (const j of jobs) await gibSpecialistJobZurueck(j.id, o.daemonId).catch(() => false);
      return [];
    }
    if (jobs.length > 0) {
      const aus: SpecialistDaemonJob[] = [];
      for (const j of jobs) aus.push({ ...j, lokaler_projektpfad: o.runtime ? runtimeProjektPfad(j.project) : await lokalerProjektpfadFuerHost(j.project, o.host) });
      return aus;
    }
    const rest = ende - Date.now();
    if (rest <= 0) return [];
    await warteAufSignal(['specialist_job_created'], rest);
  }
}

export async function schliesseSpecialistJobFuerDaemon(
  id: string,
  daemonId: string,
  abschluss: SpecialistJobCompletion,
): Promise<DaemonAbschlussErgebnis> {
  const { rows } = await getPool().query<{ claimed_by: string | null; status: string }>(
    'SELECT claimed_by, status FROM specialist_jobs WHERE id = $1',
    [id],
  );
  if (rows.length === 0) return { ok: false, error: 'job_unbekannt' };
  if (rows[0].claimed_by !== daemonId) return { ok: false, error: 'nicht_eigener_job', status: rows[0].status };
  await completeSpecialistJob(id, abschluss);
  return { ok: true, status: abschluss.status };
}

// ── Wrapper-Reaper (Datenteil von reapLokaleWrapper) ────────────────────────

import { leseAgentBezugModus } from './agent-bezug.js';
export interface WrapperReapKandidat {
  identity_id?: string | null;
  project: string;
  path: string;
  agent_name: string;
  wrapper_pid: number;
  last_activity: string;
}

/**
 * Datenteil von reapLokaleWrapper: alte running/idle-Zeilen der Projekte, die eindeutig auf
 * diesem Host liegen. Die Prozesspruefung (/proc) macht der Daemon selbst (pruefeWrapperProzess).
 */
export async function wrapperReapKandidaten(
  projekte: string[], host: string, alterMs = 300_000,
  /** P22-T6: Container-Daemon – Ordner im Container statt PC-Projektpfad (projekte vorher auf die Runtime geprueft). */
  pfadFuer?: (project: string) => string | null,
): Promise<WrapperReapKandidat[]> {
  const aus: WrapperReapKandidat[] = [];
  for (const project of projekte) {
    const path = pfadFuer ? pfadFuer(project) : await lokalerProjektpfadFuerHost(project, host);
    if (!path) continue;
    const { rows } = await getPool().query<{ agent_name: string; wrapper_pid: number; last_activity: string }>(
      "SELECT agent_name,wrapper_pid,last_activity::text AS last_activity FROM wrapper_status WHERE project=$1 AND status IN ('running','idle') AND last_activity < NOW()-($2::double precision * interval '1 millisecond')",
      [project, alterMs],
    );
    for (const r of rows) aus.push({ project, path, agent_name: r.agent_name, wrapper_pid: Number(r.wrapper_pid), last_activity: r.last_activity });
    if ((await leseAgentBezugModus()).modus !== 'alt') {
      const ids = await getPool().query("SELECT identity_id,agent_name,wrapper_pid,last_activity::text AS last_activity FROM agent_identitaet_wrapper_status WHERE project=$1 AND status IN ('running','idle') AND last_activity < NOW()-($2::double precision * interval '1 millisecond')",[project,alterMs]);
      for (const r of ids.rows) aus.push({ project,path,identity_id:r.identity_id,agent_name:r.agent_name,wrapper_pid:Number(r.wrapper_pid),last_activity:r.last_activity });
    }
  }
  return aus;
}

/** CAS wie in reapLokaleWrapper: nur unveraenderte Zeilen werden 'crashed'. */
export async function markiereWrapperAbgestuerzt(k: { identity_id?: string | null; project: string; agent_name: string; wrapper_pid: number; last_activity: string }): Promise<number> {
  if (k.identity_id && (await leseAgentBezugModus()).modus === 'alt') return 0;
  const r = await getPool().query(
    `UPDATE ${k.identity_id ? 'agent_identitaet_wrapper_status' : 'wrapper_status'} SET status='crashed',busy=false,connected_mcp=false WHERE project=$1 AND ${k.identity_id ? 'identity_id' : 'agent_name'}=$2 AND wrapper_pid=$3 AND last_activity=$4 AND status IN ('running','idle')`,
    [k.project, k.identity_id ?? k.agent_name, k.wrapper_pid, k.last_activity],
  );
  // P22-T118: Erkennungszeit, belegte Ursache und Container-Ereignis vermerken (additiv, wirft nie).
  if ((r.rowCount ?? 0) > 0) {
    await (await import('./wrapper-ende.js')).vermerkeWrapperEnde({ ...k, quelle: 'daemon_jobs_vertrag.markiereWrapperAbgestuerzt' }).catch(() => undefined);
  }
  return r.rowCount ?? 0;
}
