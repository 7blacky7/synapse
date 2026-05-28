/**
 * MODUL: WorkspaceOrchestrator
 * ZWECK: Verwaltet pro-Projekt Docker-Container (synapse-workspace-Image) als
 *        Sandbox fuer Shell-Jobs/File-Sync. Lazy-Start, Idle-Stop, LRU-Eviction,
 *        Resource-Caps. PG (project_workspaces) ist Single-Source-of-Truth.
 *
 * INPUT:  Projekt-Name + Konfig (maxConcurrent, idleStop, image, network, …)
 * OUTPUT: containerId fuer ensureProjectRunning / Status-Listen / Lifecycle-Aktionen
 *
 * NEBENEFFEKTE:
 *   - Docker-Socket: create/start/stop/exec/inspect Container, create Volume
 *   - PostgreSQL: liest+aktualisiert project_workspaces
 *   - Hintergrund-Loops: idleStopTick (default 60s)
 *
 * GRACEFUL DEGRADE: ohne erreichbaren Docker-Socket → init() liefert false,
 *   alle write-Operationen werfen klaren Fehler, REST/UI laeuft weiter.
 */

import Docker from 'dockerode';
import { getPool } from '@synapse/core';

export interface WorkspaceConfig {
  socketPath?: string;            // default /var/run/docker.sock
  image?: string;                 // default synapse-workspace:latest
  network?: string;               // default proxynet
  maxConcurrent?: number;         // default 5
  idleStopMinutes?: number;       // default 10
  tickIntervalMs?: number;        // default 60_000
  containerNamePrefix?: string;   // default synapse-ws
  volumeNamePrefix?: string;      // default synapse-workspace
}

export interface WorkspaceInfo {
  project: string;
  containerId: string | null;
  status: 'cold' | 'warming' | 'active' | 'stopping' | 'error';
  image: string;
  cpuLimit: number;
  memLimitMb: number;
  pinned: boolean;
  lastActivityAt: Date;
  lastStartedAt: Date | null;
  lastStoppedAt: Date | null;
  lastError: string | null;
}

const DEFAULTS = {
  socketPath: '/var/run/docker.sock',
  image: 'synapse-workspace:latest',
  network: 'proxynet',
  maxConcurrent: 5,
  idleStopMinutes: 10,
  tickIntervalMs: 60_000,
  containerNamePrefix: 'synapse-ws',
  volumeNamePrefix: 'synapse-workspace',
};

/** Saniert Projekt-Namen fuer Docker-Container/Volume-Naming (lowercase, [a-z0-9_-]). */
function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export class WorkspaceOrchestrator {
  private docker: Docker;
  private cfg: Required<WorkspaceConfig>;
  private idleTimer: NodeJS.Timeout | null = null;
  private dockerAvailable = false;

  constructor(cfg: WorkspaceConfig = {}) {
    this.cfg = { ...DEFAULTS, ...cfg } as Required<WorkspaceConfig>;
    this.docker = new Docker({ socketPath: this.cfg.socketPath });
  }

  /** Prueft Docker-Erreichbarkeit. Returns true wenn nutzbar, false sonst (no-throw). */
  async init(): Promise<boolean> {
    try {
      await this.docker.ping();
      this.dockerAvailable = true;
      console.error(`[Workspaces] Docker erreichbar (socket=${this.cfg.socketPath}, image=${this.cfg.image}, maxConcurrent=${this.cfg.maxConcurrent}, idleStop=${this.cfg.idleStopMinutes}min)`);
      this.startIdleStopLoop();
      return true;
    } catch (err) {
      this.dockerAvailable = false;
      console.error(`[Workspaces] Docker NICHT erreichbar (${(err as Error).message}) — Workspace-Features deaktiviert, REST laeuft normal weiter`);
      return false;
    }
  }

  isAvailable(): boolean {
    return this.dockerAvailable;
  }

  shutdown(): void {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }

  /**
   * Stellt sicher, dass der Workspace-Container fuer das Projekt laeuft.
   * Bei Bedarf: LRU-Eviction (wenn maxConcurrent erreicht), Volume-Create, Container-Start.
   * Aktualisiert last_activity_at in jedem Fall.
   * @returns containerId
   */
  async ensureProjectRunning(project: string): Promise<string> {
    if (!this.dockerAvailable) {
      throw new Error('Workspace-Orchestrator nicht verfuegbar (Docker-Socket nicht erreichbar)');
    }
    const pool = getPool();

    // Row sicherstellen + Activity vormerken (UPSERT).
    await pool.query(
      `INSERT INTO project_workspaces (project, last_activity_at) VALUES ($1, NOW())
       ON CONFLICT (project) DO UPDATE SET last_activity_at = NOW(), updated_at = NOW()`,
      [project]
    );

    const row = await this.loadRow(project);
    if (!row) throw new Error(`Workspace-Row fuer ${project} fehlt nach UPSERT`);

    // Pruefen: laeuft Container wirklich?
    if (row.containerId && row.status === 'active') {
      const running = await this.isContainerRunning(row.containerId);
      if (running) return row.containerId;
      // Stale: Container weg → status reset.
      await this.markStopped(project, 'container war stale (nicht mehr running)');
    }

    // LRU-Eviction wenn Cap erreicht.
    const active = await this.countActive();
    if (active >= this.cfg.maxConcurrent) {
      await this.evictLru(project);
    }

    // Volume + Container starten.
    const volumeName = row.volumeName ?? `${this.cfg.volumeNamePrefix}-${sanitize(project)}`;
    await this.ensureVolume(volumeName);
    await pool.query(`UPDATE project_workspaces SET status='warming', volume_name=$2, updated_at=NOW() WHERE project=$1`, [project, volumeName]);

    try {
      const containerId = await this.createAndStartContainer(project, row, volumeName);
      await pool.query(
        `UPDATE project_workspaces
            SET container_id=$2, status='active', last_started_at=NOW(),
                last_error=NULL, updated_at=NOW()
          WHERE project=$1`,
        [project, containerId]
      );
      return containerId;
    } catch (err) {
      const msg = (err as Error).message;
      await pool.query(
        `UPDATE project_workspaces SET status='error', last_error=$2, updated_at=NOW() WHERE project=$1`,
        [project, msg]
      );
      throw new Error(`Container-Start fuer ${project} fehlgeschlagen: ${msg}`);
    }
  }

  /** Markiert nur Activity, kein Container-Start. Fuer leichte Touches. */
  async recordActivity(project: string): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE project_workspaces SET last_activity_at=NOW(), updated_at=NOW() WHERE project=$1`, [project]);
  }

  /** Stoppt den Container (Volume bleibt, Daten persistent). */
  async stopProject(project: string, reason = 'manual'): Promise<void> {
    if (!this.dockerAvailable) return;
    const pool = getPool();
    const row = await this.loadRow(project);
    if (!row || !row.containerId) return;
    await pool.query(`UPDATE project_workspaces SET status='stopping', updated_at=NOW() WHERE project=$1`, [project]);
    try {
      const c = this.docker.getContainer(row.containerId);
      await c.stop({ t: 10 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
    } catch (err) {
      console.error(`[Workspaces] Stop ${project} (${reason}): ${(err as Error).message}`);
    }
    await this.markStopped(project, reason);
  }

  async pin(project: string, pinned: boolean): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE project_workspaces SET pinned=$2, updated_at=NOW() WHERE project=$1`, [project, pinned]);
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT project, container_id, status, image, cpu_limit, mem_limit_mb, pinned,
              last_activity_at, last_started_at, last_stopped_at, last_error
         FROM project_workspaces ORDER BY (status='active') DESC, last_activity_at DESC`
    );
    return r.rows.map(this.rowToInfo);
  }

  // ─── interne Helfer ────────────────────────────────────────────────────────

  private rowToInfo(r: Record<string, unknown>): WorkspaceInfo {
    return {
      project: r.project as string,
      containerId: (r.container_id as string | null) ?? null,
      status: r.status as WorkspaceInfo['status'],
      image: r.image as string,
      cpuLimit: Number(r.cpu_limit),
      memLimitMb: Number(r.mem_limit_mb),
      pinned: r.pinned as boolean,
      lastActivityAt: new Date(r.last_activity_at as string),
      lastStartedAt: r.last_started_at ? new Date(r.last_started_at as string) : null,
      lastStoppedAt: r.last_stopped_at ? new Date(r.last_stopped_at as string) : null,
      lastError: (r.last_error as string | null) ?? null,
    };
  }

  private async loadRow(project: string): Promise<{ containerId: string | null; status: string; image: string; volumeName: string | null; cpuLimit: number; memLimitMb: number; pidsLimit: number; pinned: boolean } | null> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT container_id, status, image, volume_name, cpu_limit, mem_limit_mb, pids_limit, pinned
         FROM project_workspaces WHERE project=$1`,
      [project]
    );
    if (!r.rows[0]) return null;
    const x = r.rows[0];
    return {
      containerId: x.container_id,
      status: x.status,
      image: x.image,
      volumeName: x.volume_name,
      cpuLimit: Number(x.cpu_limit),
      memLimitMb: Number(x.mem_limit_mb),
      pidsLimit: Number(x.pids_limit),
      pinned: x.pinned,
    };
  }

  private async countActive(): Promise<number> {
    const pool = getPool();
    const r = await pool.query(`SELECT count(*)::int c FROM project_workspaces WHERE status='active'`);
    return r.rows[0].c;
  }

  private async evictLru(excludeProject: string): Promise<void> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT project FROM project_workspaces
        WHERE status='active' AND pinned=false AND project <> $1
        ORDER BY last_activity_at ASC LIMIT 1`,
      [excludeProject]
    );
    if (!r.rows[0]) {
      // Nichts evictierbar (alles pinned). Wir starten trotzdem → temporaere Ueberschreitung
      console.error(`[Workspaces] LRU-Eviction: nichts evictierbar (alle aktiven gepint), Cap wird temporaer ueberschritten`);
      return;
    }
    const victim = r.rows[0].project;
    console.error(`[Workspaces] LRU-Eviction: stoppe ${victim} fuer ${excludeProject}`);
    await this.stopProject(victim, 'lru-evicted');
  }

  private async isContainerRunning(containerId: string): Promise<boolean> {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return info.State?.Running === true;
    } catch {
      return false;
    }
  }

  private async ensureVolume(name: string): Promise<void> {
    try {
      await this.docker.getVolume(name).inspect();
    } catch {
      await this.docker.createVolume({ Name: name, Labels: { 'synapse.workspace': 'true' } });
    }
  }

  private async createAndStartContainer(
    project: string,
    row: { image: string; cpuLimit: number; memLimitMb: number; pidsLimit: number },
    volumeName: string
  ): Promise<string> {
    const name = `${this.cfg.containerNamePrefix}-${sanitize(project)}`;
    // Falls Restmuell mit gleichem Namen existiert: aufraeumen.
    try {
      const stale = this.docker.getContainer(name);
      await stale.remove({ force: true }).catch(() => {});
    } catch { /* nicht existent, gut */ }

    const create = await this.docker.createContainer({
      name,
      Image: row.image,
      Labels: { 'synapse.workspace': 'true', 'synapse.project': project },
      Tty: false,
      OpenStdin: false,
      WorkingDir: '/workspace',
      Env: [`SYNAPSE_PROJECT=${project}`],
      HostConfig: {
        NetworkMode: this.cfg.network,
        AutoRemove: false,
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'size=64m,uid=1000,gid=1000' },
        Binds: [`${volumeName}:/workspace`],
        // Resource-Caps
        NanoCpus: Math.round(row.cpuLimit * 1e9),
        Memory: row.memLimitMb * 1024 * 1024,
        MemorySwap: row.memLimitMb * 1024 * 1024,   // kein Swap-Spielraum
        PidsLimit: row.pidsLimit,
      },
      // Container am Leben halten ohne TTY (cat liest stdin auf /dev/null).
      Cmd: ['/bin/sh', '-c', 'while true; do sleep 86400; done'],
      User: '1000:1000',
    });
    await create.start();
    return create.id;
  }

  private async markStopped(project: string, reason: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE project_workspaces
          SET status='cold', container_id=NULL, last_stopped_at=NOW(),
              last_error=$2, updated_at=NOW()
        WHERE project=$1`,
      [project, reason]
    );
  }

  private startIdleStopLoop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = setInterval(() => {
      this.idleStopTick().catch(err => console.error(`[Workspaces] idleStopTick: ${(err as Error).message}`));
    }, this.cfg.tickIntervalMs);
  }

  private async idleStopTick(): Promise<void> {
    if (!this.dockerAvailable) return;
    const pool = getPool();
    const cutoff = new Date(Date.now() - this.cfg.idleStopMinutes * 60_000);
    const r = await pool.query(
      `SELECT project FROM project_workspaces
        WHERE status='active' AND pinned=false AND last_activity_at < $1`,
      [cutoff]
    );
    for (const row of r.rows) {
      await this.stopProject(row.project, `idle > ${this.cfg.idleStopMinutes}min`);
    }
  }
}

// ─── Singleton fuer Server-Lifecycle ─────────────────────────────────────────
let _instance: WorkspaceOrchestrator | null = null;

/** Initialisiert den Orchestrator (idempotent). Returns true wenn Docker erreichbar. */
export async function initWorkspaceOrchestrator(cfg?: WorkspaceConfig): Promise<boolean> {
  if (_instance) return _instance.isAvailable();
  _instance = new WorkspaceOrchestrator(cfg);
  return await _instance.init();
}

/** Zugriff auf die Singleton-Instanz. Null wenn nicht initialisiert. */
export function getWorkspaceOrchestrator(): WorkspaceOrchestrator | null {
  return _instance;
}

/** Sauberes Abreissen (fuer SIGTERM-Handler). */
export function shutdownWorkspaceOrchestrator(): void {
  if (_instance) { _instance.shutdown(); _instance = null; }
}
