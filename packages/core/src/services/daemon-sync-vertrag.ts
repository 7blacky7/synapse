/**
 * MODUL: daemon-sync-vertrag.ts (P9-T27, letzter Schritt: Daemon ohne DATABASE_URL)
 * ZWECK: API-Seite fuer die letzten PG-Wege des lokalen FileWatcher-Daemons: Datei-Sync (Platte <-> PG),
 *        project-init, watcher_events und die lokalen Tray-Endpunkte. Aufgerufen von rest-api
 *        routes/daemon-sync.ts (Daemon-/Tray-Service-Token, Host AUS DEM TOKEN, nie vom Client).
 *        Die eigentlichen Sync-Schritte liegen in watcher/datenweg.ts (pgWatcherDatenweg), code.ts
 *        (indexiereDateiInhalt) und documents.ts (indexiereExtrahiertesDokument); hier stehen nur die
 *        Teile, die fuer den Fremdaufruf zusaetzlich abgesichert werden muessen.
 *
 * ABSICHERUNG:
 *   - istSyncPfad: nur projektrelative Pfade (kein absoluter Pfad, kein "..", kein NUL).
 *   - schliesseGeloeschteZeileFuerDaemon: hart geloescht wird nur eine soft-geloeschte Zeile, die zu
 *     Projekt UND Pfad passt (pgWatcherDatenweg loescht sonst blind per id).
 *   - project-init: Abschluss/Registrierung nur fuer den eigenen, laufenden Job (claimed_by = daemon_id);
 *     registriert wird fuer den Token-Host (registerProject nimmt sonst den Hostnamen der API).
 * ADDITIV: keine bestehende Funktion aendert sich.
 */

import path from 'node:path';
import { getPool } from '../db/client.js';
import { pgWatcherDatenweg } from '../watcher/datenweg.js';
import { registerVirtualProject } from './project-registry.js';
import { getSetupPhase, setSetupPhase, type SetupPhase } from './project-setup-status.js';
import type { ProjectInitJobRow } from './project-init-queue.js';

/** Projektrelativer Pfad ohne Ausbruch (gleiche Regel wie sichererPfad in intern-diagnose-daemon). */
export function istSyncPfad(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return false;
  if (path.posix.isAbsolute(p) || path.win32.isAbsolute(p)) return false;
  return !p.split(/[\\/]/).includes('..');
}

// ── project-init ──────────────────────────────────────────────────────────────────────────

/** registerProject fuer einen ANDEREN Host als den eigenen (der Host stammt aus dem Daemon-Token). */
export async function registriereProjektFuerHost(name: string, host: string, projectPath: string): Promise<void> {
  await getPool().query(
    `INSERT INTO projects (name, hostname, path, created_at, last_access)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (name, hostname) DO UPDATE SET
       path = EXCLUDED.path,
       last_access = NOW()`,
    [name, host, projectPath],
  );
}

/** Der eigene, laufende project-init-Job eines Daemons (sonst null). */
export async function eigenerProjectInitJob(id: string, daemonId: string): Promise<ProjectInitJobRow | null> {
  const { rows } = await getPool().query<ProjectInitJobRow>(
    `SELECT * FROM project_init_jobs WHERE id::text = $1 AND claimed_by = $2 AND status = 'running'`,
    [id, daemonId],
  );
  return rows[0] ?? null;
}

/**
 * Registrierungsschritte von initializeProject (Daemon) serverseitig: Host-Zeile, virtuelle REST-Zeile,
 * Setup-Phase (PG zuerst; ohne PG-Eintrag die lokale status.json-Phase des Daemons als Notnagel, wie
 * getSetupPhase(name, projectPath) im Daemon). Setzt 'initial-pending', wenn noch keine Phase besteht.
 */
export async function registriereInitProjektFuerDaemon(
  job: ProjectInitJobRow,
  host: string,
  projectPath: string,
  lokalePhase?: string | null,
): Promise<{ setup_phase_vorher: SetupPhase }> {
  await registriereProjektFuerHost(job.name, host, projectPath);
  try {
    await registerVirtualProject(job.name);
  } catch (err) {
    throw new Error(`Virtuelle REST-Registrierung fuer ${job.name} fehlgeschlagen: ${(err as Error).message}`);
  }
  let vorher = await getSetupPhase(job.name);
  if (vorher === 'none' && typeof lokalePhase === 'string' && /^[a-z-]{1,40}$/.test(lokalePhase) && lokalePhase !== 'none') {
    vorher = lokalePhase as SetupPhase;
  }
  if (vorher === 'none') {
    await setSetupPhase(job.name, 'initial-pending', { updatedBy: 'file-watcher-daemon:project-init' });
  }
  return { setup_phase_vorher: vorher };
}

// ── Datei-Sync ────────────────────────────────────────────────────────────────────────────

/** Nach dem Loeschen auf der Platte: nur eine soft-geloeschte Zeile genau dieses Projekts/Pfads. */
export async function schliesseGeloeschteZeileFuerDaemon(project: string, id: string, filePath: string): Promise<boolean> {
  const { rows } = await getPool().query(
    'SELECT 1 FROM code_files WHERE id::text = $1 AND project = $2 AND file_path = $3 AND deleted_at IS NOT NULL',
    [id, project, filePath],
  );
  if (!rows[0]) return false;
  return pgWatcherDatenweg.geloeschtAbschliessen(project, id, filePath);
}

export interface WatcherEreignisEintrag {
  project: string;
  kind: string;
  file_path: string;
  details?: unknown;
}

/**
 * Gebuendelte watcher_events des Daemons (gleiche Spalten wie der bisherige Einzel-INSERT), ein
 * Statement je Stapel von hoechstens 250 Zeilen. Best effort wie im Watcher: ein fehlgeschlagener
 * Stapel wird gemeldet und verworfen.
 */
export async function protokolliereWatcherEreignisse(eintraege: WatcherEreignisEintrag[]): Promise<number> {
  const pool = getPool();
  let n = 0;
  for (let i = 0; i < eintraege.length; i += 250) {
    const stapel = eintraege.slice(i, i + 250);
    const werte: unknown[] = [];
    const platz = stapel.map((e, j) => {
      werte.push(e.project, e.kind, e.file_path, e.details != null ? JSON.stringify(e.details) : null);
      return `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`;
    }).join(', ');
    try {
      await pool.query(`INSERT INTO watcher_events (project, event_type, file_path, details) VALUES ${platz}`, werte);
      n += stapel.length;
    } catch (err) {
      console.error(`[daemon-sync] watcher_events: Stapel mit ${stapel.length} Zeilen verworfen: ${(err as Error).message}`);
    }
  }
  return n;
}

// ── Tray (lokale Daemon-API /projects/:name/history|file_versions) ────────────────────────────────

export async function trayWatcherEreignisse(project: string, limit: number): Promise<unknown[]> {
  const { rows } = await getPool().query(
    `SELECT event_type, file_path, created_at, details
       FROM watcher_events
      WHERE project = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [project, limit],
  );
  return rows;
}

export async function trayDateiVersionen(project: string, limit: number): Promise<unknown[]> {
  const { rows } = await getPool().query(
    `SELECT id, file_path, edit_action, agent_id, reason, feature_tag,
            git_commit_sha, agent_note, created_at
       FROM file_versions
      WHERE project = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [project, limit],
  );
  return rows;
}
