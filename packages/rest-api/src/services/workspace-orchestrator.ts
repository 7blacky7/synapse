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
import { PassThrough } from 'node:stream';
import * as tar from 'tar-stream';
import { minimatch } from 'minimatch';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '@synapse/core';

const DEFAULT_IGNORE_PATTERNS = [
  'node_modules/**', '.git/**', 'dist/**', 'build/**', 'target/**',
  '.next/**', '.nuxt/**', 'coverage/**', '__pycache__/**', '.pytest_cache/**',
  '*.tsbuildinfo', '.DS_Store', '.cache/**',
];

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
  private listenClient: PoolClient | null = null;
  private autoSyncCount = 0;

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
      this.startListening().catch(err => console.error(`[Workspaces] LISTEN-Start fehlgeschlagen: ${(err as Error).message}`));
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
    if (this.listenClient) {
      const c = this.listenClient; this.listenClient = null;
      c.query('UNLISTEN *').catch(() => {});
      c.release();
    }
  }

  getStats(): { autoSyncCount: number; dockerAvailable: boolean; listening: boolean } {
    return { autoSyncCount: this.autoSyncCount, dockerAvailable: this.dockerAvailable, listening: !!this.listenClient };
  }

  /**
   * LISTEN auf 'synapse_code_file_change' (PG-Trigger NOTIFY auf code_files).
   * Bei jeder Aenderung: wenn das Projekt einen aktiven Workspace hat, wird die
   * EINE geaenderte Datei in den Container geschoben (incremental materialize).
   * → "PG = Source of Truth, Container = live-Mirror".
   * Selbst-heilend: bei Connection-Fehler reconnect nach 5s.
   */
  private async startListening(): Promise<void> {
    try {
      const client = await getPool().connect();
      await client.query('LISTEN synapse_code_file_change');
      this.listenClient = client;
      console.error('[Workspaces] LISTEN synapse_code_file_change aktiv (PG → Container auto-sync)');
      client.on('notification', (msg) => {
        if (msg.channel !== 'synapse_code_file_change' || !msg.payload) return;
        try {
          const { project, file_path, action } = JSON.parse(msg.payload) as { project: string; file_path: string; action: string };
          if (!project || !file_path) return;
          if (action === 'DELETE') {
            this.deleteFile(project, file_path).catch(err =>
              console.error(`[Workspaces] auto-delete ${project}:${file_path} failed: ${(err as Error).message}`)
            );
          } else {
            this.materializeFile(project, file_path).catch(err =>
              console.error(`[Workspaces] auto-sync ${project}:${file_path} failed: ${(err as Error).message}`)
            );
          }
        } catch { /* malformed payload — ignore */ }
      });
      client.on('error', (err) => {
        console.error(`[Workspaces] LISTEN client error: ${err.message} — reconnect in 5s`);
        this.listenClient = null;
        try { client.release(true); } catch { /* ignore */ }
        setTimeout(() => this.startListening().catch(() => {}), 5_000);
      });
    } catch (err) {
      console.error(`[Workspaces] LISTEN-Connect fehlgeschlagen: ${(err as Error).message} — retry in 10s`);
      setTimeout(() => this.startListening().catch(() => {}), 10_000);
    }
  }

  /**
   * Schiebt EINE Datei in den Container des Projekts — aber NUR wenn der
   * Workspace aktuell active + Container wirklich running ist. Sonst no-op
   * (Files werden beim naechsten ensureProjectRunning per voller materialize
   * automatisch nachgeholt — siehe Container-Start).
   *
   * READ-ONLY-ENFORCEMENT: tar-Entry mit uid=0 gid=0 mode=0444 → Container-User
   * synapse(1000) kann lesen, NICHT modifizieren/loeschen via shell. Schreib-
   * versuche per "echo > file" oder "sed -i" laufen ins "Permission denied".
   * Aenderungen MUESSEN ueber files-Tool (PG) gehen → auto-sync hierher.
   */
  async materializeFile(project: string, filePath: string): Promise<boolean> {
    if (!this.dockerAvailable) return false;
    const row = await this.loadRow(project);
    if (!row || row.status !== 'active' || !row.containerId) return false;
    const running = await this.isContainerRunning(row.containerId);
    if (!running) return false;

    const pool = getPool();
    const r = await pool.query(
      'SELECT content FROM code_files WHERE project=$1 AND file_path=$2 AND content IS NOT NULL',
      [project, filePath]
    );
    if (!r.rows[0]?.content) return false;
    const content = Buffer.from(r.rows[0].content as string, 'utf8');

    const pack = tar.pack();
    await new Promise<void>((resolve, reject) => {
      const entry = pack.entry(
        // uid:0 + mode:0444 → read-only fuer synapse user (Lockdown)
        { name: filePath, size: content.length, mode: 0o444, uid: 0, gid: 0, mtime: new Date() },
        (err) => (err ? reject(err) : resolve())
      );
      entry.end(content);
    });
    pack.finalize();
    await this.docker.getContainer(row.containerId).putArchive(pack as unknown as NodeJS.ReadableStream, { path: '/workspace' });
    this.autoSyncCount++;
    console.error(`[Workspaces] auto-sync ${project}: ${filePath} (${content.length}B, ro)`);
    return true;
  }

  /**
   * Loescht EINE Datei im Container (PG-DELETE oder content→NULL trigger).
   * No-op wenn Container nicht aktiv. docker exec mit User 0 (root) damit
   * read-only-Source-Files (mode 0444 root-owned) gelocht werden koennen.
   */
  async deleteFile(project: string, filePath: string): Promise<boolean> {
    if (!this.dockerAvailable) return false;
    const row = await this.loadRow(project);
    if (!row || row.status !== 'active' || !row.containerId) return false;
    const running = await this.isContainerRunning(row.containerId);
    if (!running) return false;

    // Pfad-Saniterung: keine ".." traversal, kein absoluter Pfad
    const clean = filePath.replace(/^\/+/, '').split('/').filter(seg => seg && seg !== '..').join('/');
    if (!clean) return false;

    const container = this.docker.getContainer(row.containerId);
    try {
      const exec = await container.exec({
        Cmd: ['/bin/sh', '-c', `rm -f /workspace/${clean.replace(/'/g, "'\\''")}`],
        AttachStdout: false,
        AttachStderr: false,
        Tty: false,
        User: '0', // root, damit auch read-only Source-Files entfernt werden koennen
      });
      const stream = await exec.start({ hijack: true, stdin: false });
      await new Promise<void>((resolve) => stream.on('end', () => resolve()));
      this.autoSyncCount++;
      console.error(`[Workspaces] auto-delete ${project}: ${clean}`);
      return true;
    } catch (err) {
      console.error(`[Workspaces] delete ${project}:${clean} exec failed: ${(err as Error).message}`);
      return false;
    }
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

  /**
   * Fuehrt ein Shell-Kommando im Workspace-Container des Projekts aus.
   * Startet den Container falls noetig (ensureProjectRunning).
   * Sammelt stdout/stderr getrennt via Stream-Demux.
   * timeoutMs: hard kill nach N ms (Default 60s).
   */
  async exec(
    project: string,
    command: string,
    opts: { timeoutMs?: number; workingDir?: string } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }> {
    if (!this.dockerAvailable) {
      throw new Error('Workspace-Orchestrator nicht verfuegbar (Docker-Socket nicht erreichbar)');
    }
    const containerId = await this.ensureProjectRunning(project);
    const container = this.docker.getContainer(containerId);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const t0 = Date.now();

    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: '1000:1000',
      WorkingDir: opts.workingDir ?? '/workspace',
      Env: [`SYNAPSE_PROJECT=${project}`],
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutPass = new PassThrough();
    const stderrPass = new PassThrough();
    stdoutPass.on('data', (c: Buffer) => stdoutChunks.push(c));
    stderrPass.on('data', (c: Buffer) => stderrChunks.push(c));
    // Multiplexed-Stream (Header pro Frame fuer stdout/stderr) demuxen.
    this.docker.modem.demuxStream(stream, stdoutPass, stderrPass);

    let timedOut = false;
    const streamDone = new Promise<void>((resolve, reject) => {
      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<void>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => { timedOut = true; reject(new Error(`exec timeout > ${timeoutMs}ms`)); }, timeoutMs);
    });

    let timeoutMsg = '';
    try {
      await Promise.race([streamDone, timeout]);
    } catch (err) {
      // Bei Timeout: Stream schliessen, Container weiterlaufen lassen.
      stream.destroy?.();
      timeoutMsg = `\n[orchestrator] ${(err as Error).message}`;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    let stdout = Buffer.concat(stdoutChunks).toString('utf8');
    let stderr = Buffer.concat(stderrChunks).toString('utf8') + timeoutMsg;

    let exitCode: number | null = null;
    try {
      const info = await exec.inspect();
      exitCode = info.ExitCode ?? null;
    } catch { /* ignore */ }

    // Activity bei jedem exec frischen — Idle-Timer nicht versehentlich triggern.
    await this.recordActivity(project);
    return { stdout, stderr, exitCode, timedOut, durationMs: Date.now() - t0 };
  }

  /**
   * Kopiert ALLE PG-Files des Projekts (code_files.content) in den Workspace-Container
   * unter /workspace. Verwendet docker putArchive mit einem in-memory Tar-Stream.
   * Owner: synapse (1000:1000), Mode 0644.
   * Optional: ignorePatterns ueberschreibt die Defaults.
   */
  async materialize(
    project: string,
    opts: { ignorePatterns?: string[] } = {}
  ): Promise<{ files: number; bytes: number; durationMs: number }> {
    if (!this.dockerAvailable) throw new Error('Workspace-Orchestrator nicht verfuegbar');
    const containerId = await this.ensureProjectRunning(project);
    const container = this.docker.getContainer(containerId);
    const t0 = Date.now();
    const pool = getPool();
    const ignore = opts.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;

    const r = await pool.query(
      'SELECT file_path, content FROM code_files WHERE project = $1 AND content IS NOT NULL',
      [project]
    );

    const pack = tar.pack();

    // RACE-FIX: putArchive PARALLEL zum Producer starten — sonst blockt
    // tar.pack() bei voller internal-buffer (~16 KB). Vorher wurde der Stream
    // erst nach finalize konsumiert → nach 3-4 kleinen Files Deadlock.
    const putPromise = container.putArchive(pack as unknown as NodeJS.ReadableStream, { path: '/workspace' });

    let files = 0;
    let bytes = 0;
    for (const row of r.rows) {
      const fp = row.file_path as string;
      if (ignore.some(p => minimatch(fp, p, { dot: true }))) continue;
      const content = Buffer.from(row.content as string, 'utf8');
      // Lockdown: uid=0 + mode=0444 → synapse user kann lesen, nicht modifizieren.
      // Shell-Schreibversuche auf Source ("echo > foo.ts", "sed -i") laufen ins
      // Permission denied. KI muss files-Tool nutzen → PG-Sync hierher.
      await new Promise<void>((resolve, reject) => {
        const entry = pack.entry(
          { name: fp, size: content.length, mode: 0o444, uid: 0, gid: 0, mtime: new Date() },
          (err) => (err ? reject(err) : resolve())
        );
        entry.end(content);
      });
      files++;
      bytes += content.length;
    }
    pack.finalize();
    await putPromise;
    await this.recordActivity(project);
    return { files, bytes, durationMs: Date.now() - t0 };
  }

  /**
   * Liest den /workspace-Inhalt aus dem Container und persistiert geaenderte/neue
   * Dateien in code_files (PG). Vergleicht content_hash → unveraenderte werden
   * uebersprungen. Ignore-Patterns (Default: node_modules, .git, dist, build, ...).
   * Setzt indexed_at=NOW(), parsed_at=NULL bei Aenderung → Daemon parst nach.
   */
  async commit(
    project: string,
    opts: { ignorePatterns?: string[] } = {}
  ): Promise<{ created: number; updated: number; unchanged: number; skipped: number; durationMs: number }> {
    if (!this.dockerAvailable) throw new Error('Workspace-Orchestrator nicht verfuegbar');
    const containerId = await this.ensureProjectRunning(project);
    const container = this.docker.getContainer(containerId);
    const t0 = Date.now();
    const pool = getPool();
    const ignore = opts.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;

    // Bestehende Hashes laden, um Unchanged-Detection ohne Round-trips pro Datei.
    const existing = new Map<string, string>();
    {
      const er = await pool.query(
        'SELECT file_path, content_hash FROM code_files WHERE project = $1',
        [project]
      );
      for (const row of er.rows) existing.set(row.file_path, row.content_hash);
    }

    // getArchive liefert tar des Verzeichnisses; Entries sind als 'workspace/...' praefixiert.
    const stream = await container.getArchive({ path: '/workspace' });
    const extract = tar.extract();
    const entries: Array<{ path: string; content: Buffer }> = [];

    await new Promise<void>((resolve, reject) => {
      extract.on('entry', (header, entryStream, next) => {
        if (header.type !== 'file') {
          entryStream.resume();
          entryStream.on('end', next);
          return;
        }
        // Header-Name z.B. "workspace/src/index.ts" → relative "src/index.ts"
        let relPath = header.name;
        if (relPath.startsWith('workspace/')) relPath = relPath.slice('workspace/'.length);
        else if (relPath === 'workspace') { entryStream.resume(); entryStream.on('end', next); return; }
        const chunks: Buffer[] = [];
        entryStream.on('data', (c: Buffer) => chunks.push(c));
        entryStream.on('end', () => {
          entries.push({ path: relPath, content: Buffer.concat(chunks) });
          next();
        });
        entryStream.on('error', err => reject(err));
      });
      extract.on('finish', () => resolve());
      extract.on('error', err => reject(err));
      (stream as NodeJS.ReadableStream).pipe(extract);
    });

    let created = 0, updated = 0, unchanged = 0, skipped = 0;
    for (const { path: fp, content } of entries) {
      if (ignore.some(p => minimatch(fp, p, { dot: true }))) { skipped++; continue; }
      // NUL-Bytes strippen (PG UTF8) — selbe Defensive wie in code.ts.
      const text = content.toString('utf8').replace(/\0/g, '');
      const hash = createHash('sha256').update(text).digest('hex');
      const prevHash = existing.get(fp);
      if (prevHash === hash) { unchanged++; continue; }

      const fileName = fp.split('/').pop() ?? fp;
      const fileType = (fileName.includes('.') ? fileName.split('.').pop() : '') ?? '';
      await pool.query(
        `INSERT INTO code_files (id, project, file_path, file_name, file_type, chunk_count, file_size, content, content_hash, indexed_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 0, $5, $6, $7, NOW(), NOW())
         ON CONFLICT (project, file_path) DO UPDATE SET
           file_name=EXCLUDED.file_name,
           file_type=EXCLUDED.file_type,
           file_size=EXCLUDED.file_size,
           content=EXCLUDED.content,
           content_hash=EXCLUDED.content_hash,
           parsed_at=NULL,
           indexed_at=NOW(),
           updated_at=NOW()`,
        [project, fp, fileName, fileType, text.length, text, hash]
      );
      if (prevHash) updated++; else created++;
    }
    await this.recordActivity(project);
    return { created, updated, unchanged, skipped, durationMs: Date.now() - t0 };
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
