/**

 * MODUL: daemon-jobs-api.ts (P9-T27, Welle 1, Schritte 1 und 2)
 * ZWECK: Client-Seite des Daemon-Job-Vertrags (rest-api routes/daemon-jobs.ts). Shell- und
 *        Spezialisten-Jobs werden ueber die Synapse-API geholt und gemeldet statt per eigener
 *        PostgreSQL-Verbindung (LISTEN/claim/complete).
 *
 * WEG: derselbe API-Zugang wie intern-bruecke/skills-proxy — synapse_api_url + synapse_api_token
 *   aus ~/.synapse/file-watcher/config.json (Tray). LAN ist nur eine schnellere Adresse derselben
 *   API (synapse_api_url), kein zweiter Kanal.
 *
 * SCHALTER (Uebergang, Grundsatz "erweitern"): Vorgabe ist der bisherige PG-Weg.
 *   SYNAPSE_DAEMON_JOBS_WEG=api|pg  (Umgebung, hat Vorrang)
 *   "daemon_jobs_weg": "api"|"pg"   (config.json)
 *   Unbekannte Werte werden laut gemeldet und als 'pg' behandelt. Ist 'api' gewaehlt, faellt der
 *   Daemon NICHT still auf PG zurueck — ein Worker, der anders arbeitet als bestellt, waere unsichtbar.
 *
 * P9-T27 WELLE 2: Derselbe Schalter steuert jetzt auch Shell-Kontext (execShellInProject ohne PG),
 *   die PG-Schritte der Spezialisten-Tools, enabled-sync und den Daemon-Heartbeat.
 *   VORGABE ohne Schalter: 'pg', solange der Daemon ein DATABASE_URL hat (Rueckfall, unveraendert).
 *   Fehlt DATABASE_URL/SYNAPSE_DATABASE_URL ganz, ist der PG-Weg ohnehin unmoeglich -> 'api'.
 *   Ein ausdruecklich gesetztes 'pg' bleibt 'pg' (Rueckfall per Schalter).
 */

import os from 'node:os';
import type { ShellJobCompletion, ShellJobRow, SpecialistJobCompletion, SpecialistJobRow } from '@synapse/core';
import type { ShellExecKontextDaten, ShellSicherungEingabe } from '@synapse/core';
import { loadConfig } from './config.js';
import { leseApiZugang } from './skills-proxy.js';

export type DaemonJobsWeg = 'pg' | 'api';

/** Hostname wie in der Daemon-ID (daemon-<hostname>-<pid>) und in reapOrphanedRunningJobs. */
export const DAEMON_HOST = os.hostname();
/** Long-Poll-Dauer je Abruf (API deckelt auf 25 s). */
export const DAEMON_JOBS_POLL_S = 25;

let gemeldeterUnbekannterWert: string | null = null;

/** Liest den Schalter; Vorgabe 'pg'. */
export function daemonJobsWeg(): DaemonJobsWeg {
  let roh = (process.env.SYNAPSE_DAEMON_JOBS_WEG ?? '').trim().toLowerCase();
  if (!roh) {
    try {
      const wert = loadConfig().daemon_jobs_weg;
      if (typeof wert === 'string') roh = wert.trim().toLowerCase();
    } catch { /* keine config -> Vorgabe */ }
  }
  if (roh === 'api') return 'api';
  if (roh !== '' && roh !== 'pg' && gemeldeterUnbekannterWert !== roh) {
    gemeldeterUnbekannterWert = roh;
    console.error(`[daemon-jobs] daemon_jobs_weg/SYNAPSE_DAEMON_JOBS_WEG="${roh}" ist unbekannt — es gibt nur "pg" und "api". Ich nehme "pg".`);
  }
  // P9-T27 Welle 2: ohne Schalter und ohne DB-Zugang ist PG unmoeglich -> API ist Standard.
  if (roh === '' && !ohneDatenbankGemeldet && !hatDatenbankUrl()) {
    ohneDatenbankGemeldet = true;
    console.error('[daemon-jobs] kein DATABASE_URL in der Daemon-Umgebung — Weg: API (Rueckfall per daemon_jobs_weg="pg" nur mit DATABASE_URL).');
  }
  if (roh === '' && !hatDatenbankUrl()) return 'api';
  return 'pg';
}

let ohneDatenbankGemeldet = false;

/** true, wenn der Daemon (noch) einen direkten DB-Zugang in seiner Umgebung hat. */
export function hatDatenbankUrl(): boolean {
  return !!(process.env.DATABASE_URL ?? '').trim() || !!(process.env.SYNAPSE_DATABASE_URL ?? '').trim();
}

/** Daemon-ID dieses Prozesses (wie in shell-/specialist-job-worker). */
export const DAEMON_API_ID = `daemon-${DAEMON_HOST}-${process.pid}`;

/** Prueft die Voraussetzungen des API-Wegs; wirft mit klarer Meldung statt still zurueckzufallen. */
export function pruefeApiWeg(): void {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(DAEMON_HOST)) {
    throw new Error(`daemon_jobs_weg=api: Hostname "${DAEMON_HOST}" ist fuer die API-Route nicht gueltig ([A-Za-z0-9._-], max 128).`);
  }
  const { token } = leseApiZugang();
  if (!token) throw new Error('daemon_jobs_weg=api verlangt synapse_api_token in config.json (Tray: Verbindung einrichten).');
}

export class DaemonJobsApiFehler extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

/** P9-T27 letzter Schritt: auch von daemon-sync-api.ts genutzt (gleicher Zugang, gleiche Fehlerform). */
export async function anfrage<T>(pfad: string, init: { method: 'GET' | 'POST'; body?: unknown }, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const { url, token } = leseApiZugang();
  if (!token) throw new DaemonJobsApiFehler('kein synapse_api_token in config.json (Tray: Verbindung einrichten)', 0, 'kein_token');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const weiter = () => controller.abort();
  signal?.addEventListener('abort', weiter, { once: true });
  try {
    const res = await fetch(`${url}${pfad}`, {
      method: init.method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    let daten: Record<string, unknown> = {};
    try { daten = (await res.json()) as Record<string, unknown>; } catch { /* leerer Body */ }
    if (!res.ok) {
      const code = typeof daten.error === 'string' ? daten.error : undefined;
      const hinweis = res.status === 404 && !code ? ' (API ohne Daemon-Job-Routen — veralteter Stand?)' : '';
      throw new DaemonJobsApiFehler(`HTTP ${res.status}${code ? ` ${code}` : ''} bei ${pfad}${hinweis}`, res.status, code);
    }
    return daten as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', weiter);
  }
}

function query(werte: Record<string, string | number>): string {
  return Object.entries(werte).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

// ── Shell ───────────────────────────────────────────────────────────────────

export interface ShellAbrufAntwort {
  jobs: ShellJobRow[];
  abbrueche: string[];
}

export async function holeShellJobsApi(o: { daemonId: string; projekte: string[]; frei: number; warteS: number; signal?: AbortSignal }): Promise<ShellAbrufAntwort> {
  const pfad = `/api/daemon/shell/jobs?${query({ host: DAEMON_HOST, daemon_id: o.daemonId, projekte: o.projekte.join(','), frei: o.frei, warte: o.warteS })}`;
  const a = await anfrage<{ jobs?: ShellJobRow[]; abbrueche?: string[] }>(pfad, { method: 'GET' }, (o.warteS + 15) * 1000, o.signal);
  return { jobs: Array.isArray(a.jobs) ? a.jobs : [], abbrueche: Array.isArray(a.abbrueche) ? a.abbrueche : [] };
}

/** Die HTTP-JSON-Huelle muss unter Fastifys Bodylimit bleiben (auch Escape-/UTF-8-Bytes). */
const ABSCHLUSS_BODY_MAX = 900_000;

/**
 * Abschluss-Retry/Backoff liegt zentral in ShellAbschlussWiederholung (PG/API gleich).
 * Zu grosse Ausgabe und 413 duerfen den kleinen terminalen Status nicht blockieren.
 */
export async function meldeShellAbschlussApi(id: string, daemonId: string, abschluss: ShellJobCompletion): Promise<void> {
  let ergebnis = abschluss;
  const body = () => ({ host: DAEMON_HOST, daemon_id: daemonId, id, abschluss: ergebnis });
  const kuerzen = (): void => {
    ergebnis = {
      status: abschluss.status, exit_code: abschluss.exit_code,
      error: abschluss.error, nur_laufend: abschluss.nur_laufend,
      output_truncated: true,
      message: 'Shellprozess beendet; Ausgabe konnte nicht vollstaendig uebertragen werden. Lokaler Stream bleibt erhalten.',
    };
  };
  if (Buffer.byteLength(JSON.stringify(body()), 'utf8') > ABSCHLUSS_BODY_MAX) {
    console.error('[daemon-jobs] Abschluss-Ausgabe zu gross; terminaler Status wird ohne Ausgabe gemeldet:', id);
    kuerzen();
  }
  try {
    try {
      await anfrage('/api/daemon/shell/abschluss', { method: 'POST', body: body() }, 60_000);
    } catch (err) {
      if (!(err instanceof DaemonJobsApiFehler) || err.status !== 413) throw err;
      console.error('[daemon-jobs] Abschluss-Ausgabe abgelehnt (HTTP 413); Wiederholung ohne Ausgabe:', id);
      kuerzen();
      await anfrage('/api/daemon/shell/abschluss', { method: 'POST', body: body() }, 60_000);
    }
  } catch (err) {
    if (err instanceof DaemonJobsApiFehler && (err.code === 'job_unbekannt' || err.code === 'nicht_eigener_job')) {
      console.error(`[daemon-jobs] Abschluss ${id} verworfen: ${err.code} (Job gehoert nicht mehr diesem Daemon).`);
      return;
    }
    throw err;
  }
}

export async function shellWartungApi(aktion: 'reap' | 'expire', daemonId: string): Promise<number>;
export async function shellWartungApi(aktion: 'eigene_laufende', daemonId: string): Promise<ShellJobRow[]>;
export async function shellWartungApi(aktion: 'reap' | 'expire' | 'eigene_laufende', daemonId: string): Promise<number | ShellJobRow[]> {
  const a = await anfrage<{ anzahl?: number; jobs?: ShellJobRow[] }>(
    '/api/daemon/shell/wartung', { method: 'POST', body: { host: DAEMON_HOST, daemon_id: daemonId, aktion } }, 30_000);
  if (aktion === 'eigene_laufende') return Array.isArray(a.jobs) ? a.jobs : [];
  return Number(a.anzahl ?? 0);
}

// ── Spezialisten ────────────────────────────────────────────────────────────

export type SpecialistApiJob = SpecialistJobRow & { lokaler_projektpfad?: string | null };

export async function holeSpecialistJobsApi(o: { daemonId: string; projekte: string[]; warteS: number; signal?: AbortSignal }): Promise<SpecialistApiJob[]> {
  const pfad = `/api/daemon/specialist/jobs?${query({ host: DAEMON_HOST, daemon_id: o.daemonId, projekte: o.projekte.join(','), warte: o.warteS })}`;
  const a = await anfrage<{ jobs?: SpecialistApiJob[] }>(pfad, { method: 'GET' }, (o.warteS + 15) * 1000, o.signal);
  return Array.isArray(a.jobs) ? a.jobs : [];
}

export async function meldeSpecialistAbschlussApi(id: string, daemonId: string, abschluss: SpecialistJobCompletion): Promise<void> {
  await anfrage('/api/daemon/specialist/abschluss', { method: 'POST', body: { host: DAEMON_HOST, daemon_id: daemonId, id, abschluss } }, 60_000);
}

export interface WrapperKandidat {
  identity_id?: string | null;
  project: string;
  path: string;
  agent_name: string;
  wrapper_pid: number;
  last_activity: string;
}

export async function specialistExpireApi(daemonId: string, maxAlterS: number): Promise<number> {
  const a = await anfrage<{ anzahl?: number }>('/api/daemon/specialist/wartung',
    { method: 'POST', body: { host: DAEMON_HOST, daemon_id: daemonId, aktion: 'expire', max_alter_s: maxAlterS } }, 30_000);
  return Number(a.anzahl ?? 0);
}

export async function wrapperKandidatenApi(daemonId: string, projekte: string[], alterMs = 300_000): Promise<WrapperKandidat[]> {
  const a = await anfrage<{ kandidaten?: WrapperKandidat[] }>('/api/daemon/specialist/wartung',
    { method: 'POST', body: { host: DAEMON_HOST, daemon_id: daemonId, aktion: 'wrapper_kandidaten', projekte, alter_ms: alterMs } }, 30_000);
  return Array.isArray(a.kandidaten) ? a.kandidaten : [];
}

export async function wrapperAbgestuerztApi(daemonId: string, kandidat: WrapperKandidat): Promise<number> {
  const a = await anfrage<{ anzahl?: number }>('/api/daemon/specialist/wartung',
    { method: 'POST', body: { host: DAEMON_HOST, daemon_id: daemonId, aktion: 'wrapper_abgestuerzt', kandidat } }, 30_000);
  return Number(a.anzahl ?? 0);
}

// ── P9-T27 Welle 2: Shell-Kontext ────────────────────────────────────────────────

/** Kontext fuer execShellInProject eines eigenen, laufenden Jobs (Projektpfad, Projekt-DB, Katalog, Freigabe). */
export async function holeShellKontextApi(id: string, daemonId: string): Promise<ShellExecKontextDaten> {
  const a = await anfrage<{ kontext?: ShellExecKontextDaten }>(
    `/api/daemon/shell/kontext?${query({ host: DAEMON_HOST, daemon_id: daemonId, id })}`, { method: 'GET' }, 30_000);
  if (!a.kontext || typeof a.kontext.project_root !== 'string') throw new DaemonJobsApiFehler('Shell-Kontext ohne Inhalt', 0, 'kontext_leer');
  return a.kontext;
}

/** Sicherungs-Audit (beginneShellSicherungsJob) eines eigenen laufenden Jobs serverseitig speichern. */
export async function meldeShellSicherungApi(id: string, daemonId: string, speicher: ShellSicherungEingabe): Promise<string | undefined> {
  const a = await anfrage<{ id?: string | null }>('/api/daemon/shell/sicherung',
    { method: 'POST', body: { host: DAEMON_HOST, daemon_id: daemonId, id, speicher } }, 30_000);
  return typeof a.id === 'string' ? a.id : undefined;
}

// ── P9-T27 Welle 2: Spezialisten-Daten, Projekte, Heartbeat ────────────────────────

/** PG-Schritt der Spezialisten-Tools ueber POST /api/daemon/specialist/daten. */
import { daemonAuftragBindung } from './daemon-auftrag.js';
export async function spezialistenDatenApi<T = Record<string, unknown>>(aktion: string, daten: Record<string, unknown> = {}): Promise<T> {
  return anfrage<T>('/api/daemon/specialist/daten',
    { method: 'POST', body: { ...daten, ...daemonAuftragBindung(), host: DAEMON_HOST, daemon_id: DAEMON_API_ID, aktion } }, 30_000);
}

export interface DaemonProjektZeile { name: string; path: string; enabled: boolean; setup_phase: string | null }

/** Projekt-Snapshot dieses Hosts (enabled-sync), gleiche Zeilen wie die bisherige PG-Abfrage. */
export async function holeProjekteApi(): Promise<DaemonProjektZeile[]> {
  const a = await anfrage<{ projekte?: DaemonProjektZeile[] }>(
    `/api/daemon/projekte?${query({ host: DAEMON_HOST, daemon_id: DAEMON_API_ID })}`, { method: 'GET' }, 30_000);
  if (!Array.isArray(a.projekte)) throw new DaemonJobsApiFehler('Projekt-Snapshot ohne Liste', 0, 'projekte_leer');
  return a.projekte;
}

/** Daemon-Heartbeat (daemon_heartbeats) melden oder loeschen. */
export async function heartbeatApi(aktion: 'melden' | 'loeschen', projekte: string[]): Promise<void> {
  if (projekte.length === 0) return;
  await anfrage('/api/daemon/heartbeat',
    { method: 'POST', body: { host: DAEMON_HOST, daemon_id: DAEMON_API_ID, aktion, projekte, pid: process.pid } }, 15_000);
}

export const schlafe = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
