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
 */

import os from 'node:os';
import type { ShellJobCompletion, ShellJobRow, SpecialistJobCompletion, SpecialistJobRow } from '@synapse/core';
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
  return 'pg';
}

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

async function anfrage<T>(pfad: string, init: { method: 'GET' | 'POST'; body?: unknown }, timeoutMs: number, signal?: AbortSignal): Promise<T> {
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

/** MAX_OUTPUT_BYTES der Queue; ein Zeichen mehr genuegt, damit die API exakt wie bisher kuerzt. */
const OUTPUT_UEBERTRAG_MAX = 1_000_000 + 1;

/**
 * Meldet den Abschluss. Wirft bei Netz-/Serverfehlern (die Wiederholung macht ShellAbschlussWiederholung).
 * job_unbekannt/nicht_eigener_job sind endgueltig: protokolliert, nicht wiederholt.
 */
export async function meldeShellAbschlussApi(id: string, daemonId: string, abschluss: ShellJobCompletion): Promise<void> {
  const body = {
    host: DAEMON_HOST,
    daemon_id: daemonId,
    id,
    abschluss: typeof abschluss.output === 'string' && abschluss.output.length > OUTPUT_UEBERTRAG_MAX
      ? { ...abschluss, output: abschluss.output.slice(0, OUTPUT_UEBERTRAG_MAX) }
      : abschluss,
  };
  try {
    await anfrage('/api/daemon/shell/abschluss', { method: 'POST', body }, 60_000);
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

export const schlafe = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
