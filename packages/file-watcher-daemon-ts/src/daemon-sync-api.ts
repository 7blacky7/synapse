/**
 * MODUL: daemon-sync-api.ts (P9-T27, letzter Schritt: Daemon ohne DATABASE_URL)
 * ZWECK: Client-Seite von rest-api routes/daemon-sync.ts. Alles, was der Daemon bisher ueber
 *        @synapse/core direkt in PostgreSQL las/schrieb, laeuft im API-Weg (daemonJobsWeg()==='api')
 *        hierueber — mit demselben Zugang wie die Daemon-Jobs (synapse_api_url + Tray-Token aus
 *        ~/.synapse/file-watcher/config.json, anfrage() aus daemon-jobs-api.ts):
 *
 *   apiWatcherDatenweg      WatcherDatenweg fuer startFileWatcher (watcher_events gepuffert 2 s / 500,
 *                           Rename-Pruefung, PG->Platte-Poll, Abschluss geloeschter Zeilen)
 *   installiereIgnoreApiQuelle   project_ignore_rules ueber die API (Watcher + asset-sync)
 *   indexiereDateiApi / indexiereDokumentApi / entferneDateiApi   Platte -> PG (forwardEvent)
 *   setzeProjektSchalterApi       Tray enable/disable -> projects.enabled
 *   apiSyncDateiZugriff           intern sync_datei (PG-Stand einer Datei)
 *   *ProjectInitApi               project-init-Worker (claim/abschluss/expire/registrieren)
 *   trayApi                       lokale Tray-Endpunkte (api.ts)
 *
 * Lokal bleibt, was nur der PC kann: Datei lesen, Binaer-Kopf pruefen, Dokument extrahieren.
 * Gerechnet, gespeichert, geparst und embedded wird auf dem Server (gleiche Core-Funktionen).
 */

import fs from 'node:fs';
import {
  setzeIgnoreRegelQuelle,
  readFileWithMetadata,
  isBinaryFile,
  leseDateiKopf,
  extractDocument,
} from '@synapse/core';
import type {
  WatcherDatenweg,
  PgFsZeile,
  PgFsLoeschZeile,
  IgnoreRegelZeile,
  SyncDateiPgZugriff,
  SyncDateiZeile,
  ProjectInitJobRow,
} from '@synapse/core';
import { anfrage, DaemonJobsApiFehler, DAEMON_API_ID, DAEMON_HOST } from './daemon-jobs-api.js';

function kopf(aktion: string, daten: Record<string, unknown>): Record<string, unknown> {
  return { ...daten, host: DAEMON_HOST, daemon_id: DAEMON_API_ID, aktion };
}

async function sync<T>(aktion: string, daten: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  return anfrage<T>('/api/daemon/sync', { method: 'POST', body: kopf(aktion, daten) }, timeoutMs);
}

const liste = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

// ── watcher_events: gepuffert, best effort ───────────────────────────────────────────────────

interface Ereignis { project: string; kind: string; file_path: string; details?: unknown }
const PUFFER_MAX = 10_000;
const STAPEL = 500;
const TAKT_MS = 2_000;
let puffer: Ereignis[] = [];
let pufferTimer: NodeJS.Timeout | null = null;
let leertGerade = false;
let verworfeneEreignisse = 0;
let ereignisFehlerGemeldet = false;

function planeLeeren(): void {
  if (pufferTimer) return;
  pufferTimer = setTimeout(() => { pufferTimer = null; void leereEreignisPuffer(); }, TAKT_MS);
  pufferTimer.unref?.();
}

/** Schickt alle gepufferten watcher_events (Stapel je 500). Wirft nie. */
export async function leereEreignisPuffer(): Promise<void> {
  if (leertGerade) return;
  leertGerade = true;
  try {
    while (puffer.length > 0) {
      const stapel = puffer.splice(0, STAPEL);
      try {
        await sync('ereignisse', { eintraege: stapel }, 30_000);
        if (ereignisFehlerGemeldet) { console.error('[daemon-sync] watcher_events wieder uebertragbar'); ereignisFehlerGemeldet = false; }
      } catch (err) {
        // Best effort wie der PG-Weg: Stapel verwerfen, einmal melden, Rest beim naechsten Takt.
        verworfeneEreignisse += stapel.length;
        if (!ereignisFehlerGemeldet) {
          console.error(`[daemon-sync] watcher_events nicht uebertragbar (${(err as Error).message}) — Stapel verworfen (bisher ${verworfeneEreignisse}).`);
          ereignisFehlerGemeldet = true;
        }
        break;
      }
    }
  } finally {
    leertGerade = false;
    if (puffer.length > 0) planeLeeren();
  }
}

// ── WatcherDatenweg ueber die API ────────────────────────────────────────────────────────────

export const apiWatcherDatenweg: WatcherDatenweg = {
  art: 'api',

  async ereignisseAufraeumen(project) {
    await sync('ereignisse_aufraeumen', { project });
  },

  ereignisProtokollieren(project, kind, filePath, details) {
    try {
      if (puffer.length >= PUFFER_MAX) { puffer.shift(); verworfeneEreignisse++; }
      puffer.push({ project, kind, file_path: filePath, ...(details !== undefined && details !== null ? { details } : {}) });
      if (puffer.length >= STAPEL) void leereEreignisPuffer();
      else planeLeeren();
    } catch { /* best effort */ }
  },

  async codeZeileVorhanden(project, filePath) {
    const r = await sync<{ vorhanden?: boolean }>('code_zeile', { project, file_path: filePath });
    return r.vorhanden === true;
  },

  async geaenderte(project, a) {
    const r = await sync<{ delta?: PgFsZeile[]; voll?: PgFsZeile[] }>('geaenderte',
      { project, untergrenze: a.untergrenze, voll_nach: a.vollNach, limit: a.limit }, 60_000);
    return { delta: liste<PgFsZeile>(r.delta), voll: liste<PgFsZeile>(r.voll) };
  },

  async geloeschte(project, a) {
    const r = await sync<{ delta?: PgFsLoeschZeile[]; voll?: PgFsLoeschZeile[] }>('geloeschte',
      { project, untergrenze: a.untergrenze, geloescht_nach: a.geloeschtNach, limit: a.limit }, 60_000);
    return { delta: liste<PgFsLoeschZeile>(r.delta), voll: liste<PgFsLoeschZeile>(r.voll) };
  },

  async hashBekannt(project, filePath, hash) {
    const r = await sync<{ bekannt?: boolean }>('hash_bekannt', { project, file_path: filePath, hash });
    return r.bekannt === true;
  },

  async inhalt(project, filePath) {
    const r = await sync<{ content?: string | null }>('inhalt', { project, file_path: filePath }, 120_000);
    return typeof r.content === 'string' ? r.content : null;
  },

  async geloeschtAbschliessen(project, id, filePath) {
    try {
      await sync('geloescht_abschliessen', { project, id, file_path: filePath });
      return true;
    } catch (err) {
      // Die API loescht nur eine passende soft-geloeschte Zeile; eine inzwischen wiederhergestellte
      // oder schon geloeschte Zeile ist kein Fehler des Ticks.
      if (err instanceof DaemonJobsApiFehler && err.code === 'zeile_passt_nicht') return false;
      throw err;
    }
  },
};

// ── Ignore-Regeln ────────────────────────────────────────────────────────────────────────────

/** project_ignore_rules ueber die API (gilt fuer Watcher UND asset-sync, prozessweit). */
export function installiereIgnoreApiQuelle(): void {
  setzeIgnoreRegelQuelle(async (project: string): Promise<IgnoreRegelZeile[]> => {
    const r = await sync<{ regeln?: IgnoreRegelZeile[] }>('ignore_regeln', { project });
    if (!Array.isArray(r.regeln)) throw new Error('ignore_regeln: Antwort ohne Liste');
    return r.regeln;
  });
}

// ── Platte -> PG (manager.forwardEvent) ──────────────────────────────────────────────────────

/**
 * indexFile im API-Weg: lokal Binaer-Kopf pruefen und lesen (wie indexFile/storeFileContent), dann
 * Inhalt + Groesse an die API (indexiereDateiInhalt: Hash-Schutz, Versionierung, Parsen, Embedding).
 * Media-Pruefung macht der Aufrufer (klassifiziereDatei), die API prueft sie zusaetzlich.
 */
export async function indexiereDateiApi(relPath: string, project: string, absPath: string, scanAbgeschlossen: boolean): Promise<number> {
  try {
    if (isBinaryFile(absPath, leseDateiKopf(absPath))) {
      console.error(`[Synapse] indexFile: Binaerdatei gehoert nicht in den Code-Index, uebersprungen: ${relPath}`);
      return 0;
    }
  } catch { /* nicht lesbar: wie bisher entscheidet das Lesen */ }
  const daten = readFileWithMetadata(absPath, project);
  if (!daten) {
    console.error(`[Synapse] Datei nicht lesbar: ${absPath}`);
    return 0;
  }
  let groesse: number | undefined;
  try { groesse = fs.statSync(absPath).size; } catch { groesse = undefined; }
  const r = await sync<{ geaendert?: number; verworfen?: string }>('datei', {
    project, file_path: relPath, content: daten.content, datei_groesse: groesse, scan_abgeschlossen: scanAbgeschlossen,
  }, 120_000);
  if (r.verworfen) console.error(`[manager] ${relPath} von der API verworfen: ${r.verworfen}`);
  return Number(r.geaendert ?? 0);
}

/** indexDocument im API-Weg: lokal extrahieren (dort liegt die Datei), Chunking/Embedding auf dem Server. */
export async function indexiereDokumentApi(relPath: string, project: string, absPath: string): Promise<unknown> {
  const doc = await extractDocument(absPath);
  const r = await sync<{ ergebnis?: unknown }>('dokument', { project, file_path: relPath, doc }, 300_000);
  return r.ergebnis;
}

/** removeFile im API-Weg (Snapshot fs_delete, code_files, Qdrant — alles auf dem Server). */
export async function entferneDateiApi(relPath: string, project: string): Promise<void> {
  await sync('entfernen', { project, file_path: relPath }, 60_000);
}

/** Tray enable/disable: projects.enabled (setProjectEnabled) fuer ein Projekt dieses Hosts. */
export async function setzeProjektSchalterApi(project: string, enabled: boolean): Promise<void> {
  await anfrage('/api/daemon/projekt-schalter', { method: 'POST', body: kopf('schalten', { project, enabled }) }, 30_000);
}

// ── intern sync_datei ────────────────────────────────────────────────────────────────────────

export const apiSyncDateiZugriff: SyncDateiPgZugriff = {
  async zeile(project, filePath) {
    const r = await sync<{ zeile?: SyncDateiZeile | null }>('datei_zeile', { project, file_path: filePath });
    return r.zeile ?? undefined;
  },
  async inhalt(project, filePath) {
    const r = await sync<{ content?: string | null }>('inhalt', { project, file_path: filePath }, 120_000);
    return typeof r.content === 'string' ? r.content : null;
  },
  async bekannteVersion(project, filePath, hash) {
    const r = await sync<{ version?: { id: string; agent_id: string | null; created_at: unknown } | null }>('bekannte_version',
      { project, file_path: filePath, hash });
    return r.version ?? undefined;
  },
};

// ── project-init ─────────────────────────────────────────────────────────────────────────────

export interface ProjectInitAbschluss {
  status: 'done' | 'failed' | 'rejected' | 'timeout';
  resolved_path?: string;
  error?: string;
  message?: string;
}

async function init<T>(aktion: string, daten: Record<string, unknown> = {}): Promise<T> {
  return anfrage<T>('/api/daemon/project-init', { method: 'POST', body: kopf(aktion, daten) }, 30_000);
}

/** Aeltesten passenden pending Job claimen (Host aus dem Token). */
export async function claimProjectInitApi(): Promise<ProjectInitJobRow | null> {
  const r = await init<{ job?: ProjectInitJobRow | null }>('claim');
  return r.job ?? null;
}

export async function schliesseProjectInitApi(id: string, abschluss: ProjectInitAbschluss): Promise<void> {
  await init('abschluss', { id, abschluss });
}

export async function expireProjectInitApi(maxAlterS = 30): Promise<number> {
  const r = await init<{ anzahl?: number }>('expire', { max_alter_s: maxAlterS });
  return Number(r.anzahl ?? 0);
}

/** registerProject + registerVirtualProject + Setup-Phase (PG) fuer den eigenen laufenden Job. */
export async function registriereProjectInitApi(id: string, pfad: string, lokalePhase: string | null): Promise<{ setup_phase_vorher: string }> {
  const r = await init<{ setup_phase_vorher?: string }>('registrieren', { id, path: pfad, lokale_phase: lokalePhase });
  return { setup_phase_vorher: typeof r.setup_phase_vorher === 'string' ? r.setup_phase_vorher : 'none' };
}

// ── Tray ─────────────────────────────────────────────────────────────────────────────────────

/** Lokale Tray-Endpunkte (api.ts) im API-Weg: eine Aktion je Endpunkt, nur Projekte dieses Hosts. */
export async function trayApi<T = Record<string, unknown>>(aktion: string, project: string, daten: Record<string, unknown> = {}): Promise<T> {
  return anfrage<T>('/api/daemon/tray', { method: 'POST', body: kopf(aktion, { ...daten, project }) }, 30_000);
}
