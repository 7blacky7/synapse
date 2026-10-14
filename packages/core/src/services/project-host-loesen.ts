/**
 * P9-T30: Host-Bindung eines Projekts gezielt loesen (Vorschau zuerst).
 *
 * Entfernt NUR die Registry-Zeile (projects) dieses einen Hosts, schaltet die Tray-Bindung
 * (project_host_bindings) dieses Hosts ab, beendet offene restore_existing-Jobs dieses Hosts und
 * reiht einen Daemon-Auftrag ein (project_init_jobs mode 'host_loesen'). Der Daemon holt den
 * Auftrag ueber die API ab (/api/project-init/host-loesen/claim) und entfernt den
 * config.json-Eintrag — kein PG-Zugriff vom PC.
 * Alle anderen Hosts (z. B. rest-api) und alle Projektdaten (Code, Memories, Plaene, Assets)
 * bleiben. Kein disable (das wirkt global). Lokale Ordner werden NICHT geloescht, nur gemeldet.
 *
 * Berechtigung: Koordinator/User (darfKoordinatorOderUser). Die REST-Route fuer den Tray
 * ("Von diesem PC entfernen") prueft selbst und uebergibt berechtigung:'tray' — dort darf ein
 * Daemon-Zugang nur seinen EIGENEN, bestaetigten Host loesen.
 */
import type { Pool, PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';
import { aktuelleUserHerkunft } from './user-herkunft.js';
import { isValidProjectName } from './project-init-queue.js';
import { VIRTUELLER_HOST, istVirtuellerRegistryPfad, istVirtuellesProjekt } from './virtuelle-projekte.js';

export const HOST_LOESEN_MODE = 'host_loesen';

export class HostLoesenFehler extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 409) {
    super(message);
    this.name = 'HostLoesenFehler';
  }
}
const fail = (code: string, message: string, status = 409): never => {
  throw new HostLoesenFehler(code, message, status);
};
function pruefeHost(h: unknown): asserts h is string {
  if (typeof h !== 'string' || !h || h.length > 200 || /[\s/\\\x00]/.test(h)) fail('host_ungueltig', 'hostname ungueltig.', 400);
}
function pruefeUuid(v: unknown): asserts v is string {
  if (typeof v !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v)) fail('id_ungueltig', 'Job-ID ungueltig.', 400);
}

interface RegistryZeile { hostname: string; path: string; enabled: boolean }

async function leseLage(db: Pool | PoolClient, project: string, hostname: string) {
  const registry = (await db.query<RegistryZeile>(
    'SELECT hostname, path, enabled FROM projects WHERE name=$1 ORDER BY hostname', [project])).rows;
  const bindung = (await db.query<{ enabled: boolean }>(
    'SELECT enabled FROM project_host_bindings WHERE project=$1 AND hostname=$2', [project, hostname])).rows[0] ?? null;
  const jobs = (await db.query<{ id: string; mode: string; status: string }>(
    "SELECT id, mode, status FROM project_init_jobs WHERE name=$1 AND hostname=$2 AND status IN ('pending','running') ORDER BY created_at",
    [project, hostname])).rows;
  return { registry, bindung, jobs };
}

export interface HostLoesenAuftrag {
  project: string;
  hostname: string;
  /** Aufrufer fuer Rollenpruefung und requested_by. */
  agent?: string;
  /** Standard true: nur zeigen, was passieren wuerde. */
  vorschau?: boolean;
  /**
   * 'rolle' (Standard) = Koordinator/User per Agent-ID; 'tray' = Route hat Daemon/User-Zugang selbst
   * geprueft UND den User-Kontext (mitUserHerkunft) gesetzt. Ohne diesen Kontext wird 'tray'
   * abgelehnt (P9-T30 Nachbesserung: 'tray' umgeht die Rollenpruefung nicht).
   */
  berechtigung?: 'rolle' | 'tray';
  db?: Pool;
}

export async function projektHostLoesen(o: HostLoesenAuftrag): Promise<Record<string, unknown>> {
  const berechtigt = (o.berechtigung ?? 'rolle') === 'tray'
    ? aktuelleUserHerkunft() !== undefined
    : darfKoordinatorOderUser(o.agent);
  if (!berechtigt) {
    fail('nur_koordinator', 'Host-Bindung loesen darf nur Koordinator/User (im Tray: "Von diesem PC entfernen").', 403);
  }
  if (typeof o.project !== 'string' || !isValidProjectName(o.project)) fail('invalid_name', 'Gueltiger Projektname (project) erforderlich.', 400);
  pruefeHost(o.hostname);
  if (o.hostname === VIRTUELLER_HOST) {
    fail('virtueller_host', `Die Zeile "${VIRTUELLER_HOST}" ist der API-Zugang des Projekts und wird hier nie entfernt.`, 400);
  }
  const db = o.db ?? getPool();
  const project = o.project, hostname = o.hostname;
  const lage = await leseLage(db, project, hostname);
  const ziel = lage.registry.find((r) => r.hostname === hostname) ?? null;
  if (ziel && istVirtuellerRegistryPfad(ziel.path)) {
    fail('virtueller_host', `Die Zeile ${hostname} -> ${ziel.path} ist ein virtueller API-Eintrag und wird hier nie entfernt.`, 400);
  }
  const bleibt = lage.registry.filter((r) => r.hostname !== hostname).map((r) => ({ hostname: r.hostname, path: r.path, enabled: r.enabled }));
  const restoreJobs = lage.jobs.filter((j) => j.mode === 'restore_existing').map((j) => j.id);
  const offenerAuftrag = lage.jobs.find((j) => j.mode === HOST_LOESEN_MODE)?.id ?? null;
  const lokalerPfad = ziel?.path ?? null;
  const hinweisLokal = lokalerPfad
    ? `Lokale Ordner entfernt Synapse NICHT: ${lokalerPfad} (und ggf. <workspace>/.synapse-restore/${project}) bitte selbst pruefen.`
    : 'Keine Registry-Zeile fuer diesen Host; lokale Ordner entfernt Synapse nicht.';
  const basis = {
    project,
    hostname,
    virtuell: istVirtuellesProjekt(project),
    entfernt: {
      registry_zeile: ziel ? { hostname: ziel.hostname, path: ziel.path, enabled: ziel.enabled } : null,
      tray_bindung_abschalten: lage.bindung?.enabled === true,
      restore_jobs_beenden: restoreJobs,
      daemon_auftrag: 'config.json-Eintrag dieses Projekts auf diesem Host entfernen (Daemon holt den Auftrag ueber die API ab; Watcher stoppt, Dateien bleiben).',
    },
    bleibt: {
      registry: bleibt,
      projektdaten: 'Code-Index, Memories, Thoughts, Plaene, Assets und Projekt-DB bleiben unveraendert; kein disable.',
    },
    hinweis_lokal: hinweisLokal,
  };
  if (o.vorschau !== false) {
    return { success: true, status: 'vorschau', ...basis, ausfuehren: 'Gleichen Aufruf mit vorschau:false wiederholen.' };
  }

  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['project-host-loesen:' + project + ':' + hostname]);
    const entfernt = (await c.query<{ path: string }>(
      "DELETE FROM projects WHERE name=$1 AND hostname=$2 AND path NOT LIKE '/virtual/%' RETURNING path", [project, hostname])).rows;
    const bindung = await c.query(
      'UPDATE project_host_bindings SET enabled=false, updated_at=clock_timestamp() WHERE project=$1 AND hostname=$2 AND enabled RETURNING project',
      [project, hostname]);
    const beendet = (await c.query<{ id: string }>(
      `UPDATE project_init_jobs SET status='failed', error='host_geloest',
         message='Host-Bindung per host_loesen entfernt.', completed_at=NOW(), updated_at=NOW()
       WHERE name=$1 AND hostname=$2 AND mode='restore_existing' AND status IN ('pending','running') RETURNING id`,
      [project, hostname])).rows.map((r) => r.id);
    await c.query('DELETE FROM project_code_manifests WHERE project=$1 AND hostname=$2', [project, hostname]);
    const vorhanden = (await c.query<{ id: string }>(
      "SELECT id FROM project_init_jobs WHERE name=$1 AND hostname=$2 AND mode=$3 AND status IN ('pending','running') ORDER BY created_at LIMIT 1",
      [project, hostname, HOST_LOESEN_MODE])).rows[0];
    const auftrag = vorhanden ?? (await c.query<{ id: string }>(
      'INSERT INTO project_init_jobs (name, hostname, requested_by, mode) VALUES ($1,$2,$3,$4) RETURNING id',
      [project, hostname, o.agent ?? null, HOST_LOESEN_MODE])).rows[0];
    await c.query('COMMIT');
    return {
      success: true,
      status: 'geloest',
      ...basis,
      ergebnis: {
        registry_zeile_entfernt: entfernt.length > 0,
        tray_bindung_abgeschaltet: (bindung.rowCount ?? 0) > 0,
        restore_jobs_beendet: beendet,
        daemon_job_id: auftrag.id,
        daemon_job_wiederverwendet: Boolean(vorhanden ?? offenerAuftrag),
      },
      daemon_status: `project(action:"init_status", job_id:"${auftrag.id}") zeigt, wann der Daemon den config.json-Eintrag entfernt hat.`,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Daemon-Seite (ueber die API): offene host_loesen-Auftraege dieses Hosts claimen. Haengende (>10 min running) werden neu vergeben. */
export async function claimHostLoesungen(hostname: string, db: Pool = getPool()): Promise<Array<{ id: string; name: string }>> {
  pruefeHost(hostname);
  const r = await db.query<{ id: string; name: string }>(
    `UPDATE project_init_jobs j SET status='running', claimed_by=$1, claimed_at=clock_timestamp(), updated_at=clock_timestamp()
      WHERE j.id IN (
        SELECT id FROM project_init_jobs
         WHERE mode=$2 AND hostname=$1
           AND (status='pending' OR (status='running' AND claimed_at < clock_timestamp() - interval '10 minutes'))
         ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING j.id, j.name`,
    [hostname, HOST_LOESEN_MODE]);
  return r.rows;
}

/** Daemon-Seite: Ergebnis eines host_loesen-Auftrags melden. */
export async function schliesseHostLoesung(
  id: string,
  hostname: string,
  ergebnis: { status: 'done' | 'failed'; message?: string; error?: string },
  db: Pool = getPool(),
): Promise<void> {
  pruefeUuid(id);
  pruefeHost(hostname);
  if (ergebnis?.status !== 'done' && ergebnis?.status !== 'failed') fail('status_ungueltig', 'status muss done oder failed sein.', 400);
  const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 2000) : null);
  const r = await db.query(
    `UPDATE project_init_jobs SET status=$3, message=$4, error=$5, completed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND hostname=$2 AND mode='${HOST_LOESEN_MODE}' AND status='running' RETURNING id`,
    [id, hostname, ergebnis.status, text(ergebnis.message), ergebnis.status === 'failed' ? text(ergebnis.error) ?? 'daemon_fehler' : null]);
  if (!r.rows.length) fail('host_loesen_job_unbekannt', 'Auftrag unbekannt, nicht laufend oder fuer einen anderen Host.', 404);
}
