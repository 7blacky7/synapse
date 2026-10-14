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
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool, registriereWorker, workerPausiert, meldeWorkerArbeit, createDefaultIgnore, shouldIgnore, ermittleShellLage, shellLageProbeProgramm, maskiereShellAntwort } from '@synapse/core';
import type { ShellLage,ShellBestaetigung,ShellSicherungsAntwort,SicherungsShell } from '@synapse/core';
import {workspaceJobDatenbank} from './workspace-job-db.js';
import {schuetzeWorkspaceWurzel,pruefeWorkspaceQuellen,schreibeWorkspaceQuellen,workspaceExecProgramm} from './workspace-quellschutz.js';
import {holeShellDbFreigabe,pruefeShellStart,holeShellStartKatalog,beginneShellSicherungsJob,beendeShellSicherungsJob,waehleShellStart,baueJobUmgebung}from'@synapse/core';
import type { ShellProbeAnfrage, ShellProbeAntwort } from '@synapse/core';

/**
 * P15-T40: Die Standard-Sperren kommen aus EINER Quelle, den DEFAULT_IGNORES in
 * core/watcher/ignore.ts (dieselben, die der Daemon-Watcher nutzt). Vorher stand
 * hier eine eigene Liste ohne .synapse, .env, *.pem usw. Sie gelten IMMER, auch
 * wenn der Aufrufer eigene ignorePatterns mitgibt. Die Glob-Muster unten sind nur
 * noch Zusatz fuer Dinge, die der Daemon nicht kennt.
 */
const STANDARD_SPERRE = createDefaultIgnore();
const DEFAULT_IGNORE_PATTERNS = ['.pytest_cache/**', '*.tsbuildinfo'];

/** true = Pfad bleibt draussen (Standard-Sperre oder eines der Glob-Muster). */
export function istWorkspaceIgnoriert(dateiPfad: string, muster: string[] = DEFAULT_IGNORE_PATTERNS): boolean {
  return (dateiPfad!=='pnpm-lock.yaml'&&shouldIgnore(STANDARD_SPERRE, dateiPfad)) || muster.some((p) => minimatch(dateiPfad, p, { dot: true }));
}

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
  /** WS3: Workspace-Name innerhalb des Projekts ('main' = Default). */
  name: string;
  containerId: string | null;
  status: 'cold' | 'warming' | 'active' | 'stopping' | 'error';
  image: string;
  cpuLimit: number;
  memLimitMb: number;
  tmpfsMb: number;
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
    // WS3: /workspace-Volume ist ueber alle Workspaces des Projekts geteilt —
    // irgendein laufender Container reicht fuer den Sync.
    const containerId = await this.anyActiveContainerId(project);
    if (!containerId) return false;

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
    await this.docker.getContainer(containerId).putArchive(pack as unknown as NodeJS.ReadableStream, { path: '/workspace' });
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
    const containerId = await this.anyActiveContainerId(project);
    if (!containerId) return false;

    // Pfad-Saniterung: keine ".." traversal, kein absoluter Pfad
    const clean = filePath.replace(/^\/+/, '').split('/').filter(seg => seg && seg !== '..').join('/');
    if (!clean) return false;

    const container = this.docker.getContainer(containerId);
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
  async ensureProjectRunning(project: string, ws = 'main', role?: string): Promise<string> {
    if (!this.dockerAvailable) {
      throw new Error('Workspace-Orchestrator nicht verfuegbar (Docker-Socket nicht erreichbar)');
    }
    const pool = getPool();
    // Offenes Prozessende vor jeder Container-Anlage abweisen; Restore folgt am verfügbaren Container.
    await this.pruefeAusstehendeQuellen(project);
    const { ws: wsName, suffix } = this.wsKey(project, ws);

    // WS4: Cap pro Projekt konfigurierbar (ENV SYNAPSE_WS_PER_PROJECT_CAP,
    // Default 6) statt hart 3 — Rollen-Instanzen (db-1, app, qa, ...) brauchen Luft.
    const perProjectCap = this.perProjectCap();
    const cap = await pool.query(
      `SELECT count(*) FILTER (WHERE name=$2)::int AS me, count(*)::int AS total
         FROM project_workspaces WHERE project=$1`,
      [project, wsName]
    );
    if (cap.rows[0].me === 0 && cap.rows[0].total >= perProjectCap) {
      throw new Error(`Workspace-Cap erreicht: Projekt "${project}" hat bereits ${cap.rows[0].total} Workspaces (Cap ${perProjectCap}, ENV SYNAPSE_WS_PER_PROJECT_CAP) — erst einen stoppen/entfernen`);
    }

    // WS4: Rolle = Template, Workspace = Instanz. Der role-Param wirkt nur bei
    // ERST-Anlage der Instanz (Template-Werte werden in die Row kopiert; danach
    // gilt die Row, Umkonfigurieren via configure). Projekt-Rolle vor globaler.
    if (role) {
      const tpl = await this.loadRoleTemplate(project, role);
      if (!tpl) {
        throw new Error(`Workspace-Rolle "${role}" nicht gefunden (weder projekt-scoped noch global) — workspace(role_list) zeigt verfuegbare Rollen`);
      }
      await pool.query(
        `INSERT INTO project_workspaces (project, name, role, image, cpu_limit, mem_limit_mb, pids_limit, tmpfs_mb, last_activity_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (project, name) DO NOTHING`,
        [project, wsName, role, tpl.image, tpl.cpuLimit, tpl.memLimitMb, tpl.pidsLimit, tpl.tmpfsMb]
      );
    }

    // Row sicherstellen + Activity vormerken (UPSERT).
    await pool.query(
      `INSERT INTO project_workspaces (project, name, last_activity_at) VALUES ($1, $2, NOW())
       ON CONFLICT (project, name) DO UPDATE SET last_activity_at = NOW(), updated_at = NOW()`,
      [project, wsName]
    );

    const row = await this.loadRow(project, wsName);
    if (!row) throw new Error(`Workspace-Row fuer ${project}/${wsName} fehlt nach UPSERT`);

    // Pruefen: laeuft Container wirklich?
    if (row.containerId && row.status === 'active') {
      const running = await this.isContainerRunning(row.containerId);
      if (running) {await this.pruefeAusstehendeQuellen(project,this.docker.getContainer(row.containerId));return row.containerId;}
      // Stale: Container weg → status reset.
      await this.markStopped(project, 'container war stale (nicht mehr running)', wsName);
    }

    // LRU-Eviction wenn Cap erreicht.
    const active = await this.countActive();
    if (active >= this.cfg.maxConcurrent) {
      await this.evictLru(project, wsName);
    }

    // Volumes + Container starten. /workspace-Volume ist pro PROJEKT (geteilt
    // ueber alle Workspaces — eine Quelle, ein Sync); Home-Volume pro WORKSPACE.
    const volumeName = row.volumeName ?? `${this.cfg.volumeNamePrefix}-${sanitize(project)}`;
    await this.ensureVolume(volumeName);
    // WS2-A1: Zweites Volume fuer /home/synapse — persistentes, schreibbares HOME.
    // Ohne das liegt $HOME im ReadonlyRootfs und npm/pip/cargo/
    // rustup/ccache sind funktionsunfaehig (Selbstbedienungs-Blockade).
    // Docker copy-on-first-use uebernimmt beim ersten Mount Inhalt+Ownership
    // (synapse 1000:1000) aus dem Image. Reset via resetHome().
    const homeVolumeName = `${this.cfg.volumeNamePrefix}-home-${sanitize(project)}${suffix}`;
    await this.ensureVolume(homeVolumeName);
    await pool.query(`UPDATE project_workspaces SET status='warming', volume_name=$3, updated_at=NOW() WHERE project=$1 AND name=$2`, [project, wsName, volumeName]);

    try {
      const containerId = await this.createAndStartContainer(project, wsName, row, volumeName, homeVolumeName);
      await pool.query(
        `UPDATE project_workspaces
            SET container_id=$3, status='active', last_started_at=NOW(),
                last_error=NULL, updated_at=NOW()
          WHERE project=$1 AND name=$2`,
        [project, wsName, containerId]
      );
      // WS4: Rollen-init_command — laeuft nach JEDEM Start (Dienste hochfahren,
      // z.B. initdb + pg_ctl). Template wird live gelesen (Edits wirken ab dem
      // naechsten Start). Fehler → last_error, Container bleibt nutzbar.
      await this.pruefeAusstehendeQuellen(project,this.docker.getContainer(containerId));
      await this.runRoleInit(project, wsName, containerId).catch(() => {});
      return containerId;
    } catch (err) {
      const msg = (err as Error).message;
      await pool.query(
        `UPDATE project_workspaces SET status='error', last_error=$3, updated_at=NOW() WHERE project=$1 AND name=$2`,
        [project, wsName, msg]
      );
      throw new Error(`Container-Start fuer ${project}/${wsName} fehlgeschlagen: ${msg}`);
    }
  }

  /** Markiert nur Activity, kein Container-Start. Fuer leichte Touches. */
  async recordActivity(project: string, ws = 'main'): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE project_workspaces SET last_activity_at=NOW(), updated_at=NOW() WHERE project=$1 AND name=$2`, [project, ws]);
  }

  /** Stoppt den Container (Volume bleibt, Daten persistent). */
  async stopProject(project: string, reason = 'manual', ws = 'main'): Promise<void> {
    if (!this.dockerAvailable) return;
    const pool = getPool();
    const row = await this.loadRow(project, ws);
    if (!row || !row.containerId) return;
    await pool.query(`UPDATE project_workspaces SET status='stopping', updated_at=NOW() WHERE project=$1 AND name=$2`, [project, ws]);
    // Last-Will Log-Line vorm Stop
    await this.appendToLog(row.containerId, `STOP requested (${reason})`).catch(() => {});
    try {
      const c = this.docker.getContainer(row.containerId);
      await c.stop({ t: 10 }).catch(() => {});
      await c.remove({ force: true }).catch(() => {});
    } catch (err) {
      console.error(`[Workspaces] Stop ${project} (${reason}): ${(err as Error).message}`);
    }
    console.error(`[Workspaces] stopped ${project}/${ws}: ${reason}`);
    await this.markStopped(project, reason, ws);
  }

  /**
   * WS2-A2: Setzt das persistente HOME-Volume des Projekts zurueck (Selbstheilung).
   * Stoppt den Container (Volume sonst in-use), entfernt
   * <volumeNamePrefix>-home-<project>; der naechste Start legt via Docker
   * copy-on-first-use ein frisches HOME aus dem Image an.
   * /workspace (Projekt-Quellen) bleibt unberuehrt. Der Home-Volume-Name ist
   * deterministisch aus dem Prefix abgeleitet — bewusst kein PG-Feld.
   */
  async resetHome(project: string, ws = 'main'): Promise<{ volume: string; removed: boolean }> {
    if (!this.dockerAvailable) {
      throw new Error('Workspace-Orchestrator nicht verfuegbar (Docker-Socket nicht erreichbar)');
    }
    const { ws: wsName, suffix } = this.wsKey(project, ws);
    const homeVolumeName = `${this.cfg.volumeNamePrefix}-home-${sanitize(project)}${suffix}`;
    await this.stopProject(project, 'reset-home', wsName);
    let removed = false;
    try {
      await this.docker.getVolume(homeVolumeName).remove({ force: true });
      removed = true;
    } catch (err) {
      // Volume existiert (noch) nicht — z.B. nie gestartet seit WS2-A1.
      // Dann ist das Ziel (frisches Home beim naechsten Start) ohnehin erfuellt.
      console.error(`[Workspaces] reset-home ${project}: remove uebersprungen (${(err as Error).message})`);
    }
    console.error(`[Workspaces] reset-home ${project}: ${homeVolumeName} removed=${removed}`);
    return { volume: homeVolumeName, removed };
  }

  /**
   * WS5-DX: Gibt einen Pfad unterhalb /workspace im Container zum Schreiben
   * fuer User synapse frei (Build-Artefakte: target/, build/, dist/, .venv/).
   * Hintergrund (empirisch 2026-06-13, moo cargo-Build): das /workspace-Volume
   * ist rw gemountet — die Read-Only-Wirkung entsteht NUR durch root-Ownership
   * + Mode 0444 aus dem PG-Sync. Diese Methode chownt den Teilbaum via
   * root-exec auf synapse (1000:1000) und setzt u+rwX. Source of Truth bleibt
   * PG: der Sync ueberschreibt synchronisierte Dateien wieder mit root/0444 —
   * make_writable ist fuer BUILD-OUTPUT gedacht, Source-Edits laufen weiter
   * ueber das files-Tool. Ganz-/workspace-Freigabe ist bewusst verboten.
   */
  async makeWritable(project: string, relPath: string, ws = 'main'): Promise<{ path: string }> {
    if (!this.dockerAvailable) {
      throw new Error('Workspace-Orchestrator nicht verfuegbar (Docker-Socket nicht erreichbar)');
    }
    const clean = (relPath || '').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '');
    if (!clean || clean === '.' || clean.includes('..') || !/^[A-Za-z0-9._\/-]+$/.test(clean)) {
      throw new Error(`make_writable: ungueltiger Pfad "${relPath}" — relativer Pfad unterhalb /workspace (kein "..", nicht "." / komplettes /workspace)`);
    }
    const { ws: wsName } = this.wsKey(project, ws);
    const containerId = await this.ensureProjectRunning(project, wsName);
    const container = this.docker.getContainer(containerId);
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', `mkdir -p '/workspace/${clean}' && chown -R 1000:1000 '/workspace/${clean}' && chmod -R u+rwX '/workspace/${clean}'`],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: '0',
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    await new Promise<void>((resolve) => { stream.on('end', () => resolve()); stream.on('error', () => resolve()); });
    const info = await exec.inspect().catch(() => null);
    if (info && info.ExitCode !== null && info.ExitCode !== 0) {
      throw new Error(`make_writable: chown/chmod fehlgeschlagen (exit ${info.ExitCode})`);
    }
    void this.appendToLog(containerId, `MAKE_WRITABLE: /workspace/${clean}`);
    await this.recordActivity(project, wsName);
    console.error(`[Workspaces] ${project}/${wsName}: make_writable /workspace/${clean}`);
    return { path: `/workspace/${clean}` };
  }

  /**
   * Fuehrt ein Shell-Kommando im Workspace-Container des Projekts aus.
   * Startet den Container falls noetig (ensureProjectRunning).
   * Sammelt stdout/stderr getrennt via Stream-Demux.
   * timeoutMs: hard kill nach N ms (Default 60s).
   */
  /** Berechnet die proxynet-interne URL fuer einen Workspace-Container + Port. */
  internalUrl(project: string, port: number, ws = 'main'): string {
    const { suffix } = this.wsKey(project, ws);
    return `http://${this.cfg.containerNamePrefix}-${sanitize(project)}${suffix}:${port}`;
  }

  /** P10-T36: fester Node-Lesehelfer im Zielcontainer; Nutzertext niemals evaluiert. */
  private async lageProbeImContainer(
    container: Docker.Container, input: ShellProbeAnfrage, cwd: string,
  ): Promise<ShellProbeAntwort> {
    const probe = await container.exec({
      Cmd: ['node', '-e', shellLageProbeProgramm(), JSON.stringify(input)],
      AttachStdout: true, AttachStderr: true, Tty: false, User: '1000:1000', WorkingDir: cwd,
    });
    const stream = await probe.start({ hijack: true, stdin: false });
    const stdout = new PassThrough(), stderr = new PassThrough();
    const chunks: Buffer[]=[]; let bytes=0;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(err?:Error)=>{
        if(done)return;done=true;clearTimeout(timer);
        if(err){stream.destroy();reject(err);return;}
        try{
          const result=JSON.parse(Buffer.concat(chunks).toString('utf8')) as ShellProbeAntwort;
          if(typeof result.cwd!=='string'||!Array.isArray(result.pfade)||!result.env)throw Error();
          resolve(result);
        }catch{reject(Error('workspace_lage_helfer_nicht_verfuegbar'));}
      };
      const timer=setTimeout(()=>finish(Error('workspace_lage_timeout')),5000);
      stdout.on('data',(chunk:Buffer)=>{
        bytes+=chunk.length;
        if(bytes>262144){finish(Error('workspace_lage_grenze'));return;}
        chunks.push(Buffer.from(chunk));
      });
      stderr.resume();
      // docker-modem schreibt in stdout, beendet diesen PassThrough aber nicht.
      // Der Rohstream ist die Abschlussquelle; Listener vor dem Demux setzen.
      stream.once('end',()=>finish());
      stream.once('close',()=>{if(!done)finish(Error('workspace_lage_helfer_nicht_verfuegbar'));});
      stream.once('error',()=>finish(Error('workspace_lage_helfer_nicht_verfuegbar')));
      this.docker.modem.demuxStream(stream, stdout, stderr);
    });
  }

  async exec(
    project: string,
    command: string,
    opts: { timeoutMs?: number; workingDir?: string; exposePorts?: number[]; workspace?: string; role?: string; agent_id?:string|null; bestaetigt?:ShellBestaetigung|null; shell?:SicherungsShell; onLage?: (lage: ShellLage) => Promise<void> | void } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number; internal_urls?: Record<number, string> } & Partial<ShellSicherungsAntwort> & {status?:string;id?:string;quellen_wiederhergestellt?:string[];quellen_pruefung_ausstehend?:boolean}> {
    if (!this.dockerAvailable) {
      throw new Error('Workspace-Orchestrator nicht verfuegbar (Docker-Socket nicht erreichbar)');
    }
    const { ws: wsName } = this.wsKey(project, opts.workspace ?? 'main');
    let containerId:string;
    try{containerId=await this.ensureProjectRunning(project, wsName, opts.role);}
    catch(error){if((error as Error).message!=='quellen_pruefung_ausstehend')throw error;
      return {stdout:'',stderr:'quellen_pruefung_ausstehend',exitCode:null,timedOut:false,durationMs:0,status:'failed',quellen_pruefung_ausstehend:true};}
    const container = this.docker.getContainer(containerId);
    try{await this.pruefeAusstehendeQuellen(project,container);}
    catch(error){if((error as Error).message!=='quellen_pruefung_ausstehend')throw error;
      return {stdout:'',stderr:'quellen_pruefung_ausstehend',exitCode:null,timedOut:false,durationMs:0,status:'failed',quellen_pruefung_ausstehend:true};}
    await schuetzeWorkspaceWurzel(container);
    const workingDir = opts.workingDir ?? '/workspace';
    const names = [...command.matchAll(/\$(?:env:)?([A-Za-z_]\w*)|\$\{([A-Za-z_]\w*)/g)].map(m=>m[1]??m[2]);
    const context = await this.lageProbeImContainer(container, { variablen: [...new Set(['HOME', 'PWD', ...names])],prozesse:true }, workingDir);
    // Docker exec erbt Config.Env trotz fehlender Env-Einträge: env -i entfernt sie tatsächlich.
    const containerInfo=await container.inspect();
    const basis=Object.fromEntries((containerInfo.Config.Env??[]).map(e=>{const i=e.indexOf('=');return [e.slice(0,i),e.slice(i+1)];}));
    const jobUmgebung=await baueJobUmgebung(project,{basis:{...basis,...context.env},home:context.env.HOME,existiert:()=>false});
    const dbFreigabe=await holeShellDbFreigabe(project);
    jobUmgebung.env=workspaceJobDatenbank(project,jobUmgebung.env,dbFreigabe);
    const bereinigteEnv:Record<string,string>=Object.fromEntries(Object.entries(jobUmgebung.env).filter((e):e is [string,string]=>e[1]!==undefined));
    context.env=bereinigteEnv;
    const start=waehleShellStart(opts.shell,'linux');
    const ermittle=()=>ermittleShellLage(command, {
      datenbank_freigabe:dbFreigabe,workspace_testdateien:true,
      shell:start.shell,os:context.os,cwd:context.cwd,project_root:'/workspace',env:context.env,env_vollstaendig:true,
      probe:async(input)=>({...await this.lageProbeImContainer(container,input,workingDir),env:bereinigteEnv}),
    });
    let lage=await ermittle();
    if(opts.onLage){await opts.onLage(await maskiereShellAntwort(project,lage));lage=await ermittle();}
    const katalog=await holeShellStartKatalog();
    const pruefung=pruefeShellStart({project,command,lage,workspace_testdateien:true,agent_id:opts.agent_id,bestaetigt:opts.bestaetigt,
      rechner:context.rechner??containerId,geschuetzte_pids:context.prozesse?.pids,geschuetzte_namen:context.prozesse?.namen},katalog);
    let sicherungsJob=await beginneShellSicherungsJob({project,command,agent_id:opts.agent_id,entscheidung:pruefung,lage,
      ursprung:'workspace',rechner:context.rechner??containerId});
    if(!pruefung.darf_starten)return maskiereShellAntwort(project,{
      stdout:'',stderr:'',exitCode:null,timedOut:false,durationMs:0,status:'rejected',
      ...pruefung.antwort,...(sicherungsJob?{id:sicherungsJob}:{})});
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const t0 = Date.now();
    console.error(`[Workspaces] exec ${project}: ${command.slice(0, 120)}${command.length > 120 ? '…' : ''} (timeout=${timeoutMs}ms)`);
    void this.appendToLog(containerId, `EXEC: ${command.slice(0, 200)}`);

    const testdatei=lage.kommandos?.some(k=>k.inline_skript?.workspace_testdatei===true)===true;
    const timeoutMarker='[workspace-timeout-'+randomUUID()+']';
    let wiederherstellungVersucht=false;
    let gestarteterExec:Docker.Exec|undefined;
    let endeBelegt=!testdatei;
    const ausstehend=async(detail:string,stdout='',stderr='',timedOut=false)=>{
      const offen={container_id:containerId,exec_id:gestarteterExec?.id};
      if(!offen.exec_id)throw Error('workspace_exec_identitaet_fehlt');
      if(!sicherungsJob){
        const audit=await getPool().query<{id:string}>(
          "INSERT INTO shell_jobs(project,command,status,agent_id,claimed_by,sicherung,error,message,completed_at) VALUES($1,$2,'failed',$3,'workspace',$4::jsonb,'quellen_pruefung_ausstehend',$5,NOW()) RETURNING id",
          [project,command,opts.agent_id??null,JSON.stringify({ursprung:'workspace',quellen_pruefung_ausstehend:offen}),detail]);
        sicherungsJob=audit.rows[0].id;
      }else await getPool().query(
        "UPDATE shell_jobs SET status='failed',error='quellen_pruefung_ausstehend',message=$4,completed_at=NOW(),sicherung=COALESCE(sicherung,'{}'::jsonb)||jsonb_build_object('quellen_pruefung_ausstehend',$2::jsonb) WHERE id=$1::uuid AND project=$3",
        [sicherungsJob,JSON.stringify(offen),project,detail]);
      return maskiereShellAntwort(project,{stdout,stderr,exitCode:null,timedOut,durationMs:Date.now()-t0,status:'failed',
        error:'quellen_pruefung_ausstehend',quellen_pruefung_ausstehend:true,id:sicherungsJob});
    };
    const wiederherstellen=async()=>{
      wiederherstellungVersucht=true;
      if(testdatei&&!endeBelegt)throw Error('quellen_pruefung_ausstehend');
      return testdatei?this.stelleWorkspaceQuellenWiederHer(project,container):[];
    };
    try {
    const exec = await container.exec({
      Cmd: ['/usr/bin/env','-i',...Object.entries(jobUmgebung.env).filter((e):e is [string,string]=>e[1]!==undefined).map(([k,v])=>k+'='+v),
        `SYNAPSE_PROJECT=${project}`,...(lage.datenbank_zuordnung&&dbFreigabe.test_system_id?[`SYNAPSE_SHELL_DB_FREIGABE=${JSON.stringify(dbFreigabe)}`]:[]),
        ...(testdatei?['node','-e',workspaceExecProgramm(),JSON.stringify({programm:opts.shell?start.programm:'/bin/sh',argv:[...start.prefix,command],timeoutMs,marker:timeoutMarker})]:[opts.shell?start.programm:'/bin/sh',...start.prefix,command])],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: '1000:1000',
      WorkingDir: opts.workingDir ?? '/workspace',
      Env: [], // Kindumgebung ausschließlich aus dem bereinigten env -i oben.
    });

    gestarteterExec=exec;
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
      timeoutHandle = setTimeout(() => { timedOut = true; reject(new Error(`exec timeout > ${timeoutMs}ms`)); }, timeoutMs+(testdatei?2000:0));
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
      endeBelegt=!testdatei||info.Running===false;
    } catch { /* Ohne inspect-Beleg bleibt die Nachprüfung ausstehend. */ }

    if(testdatei&&!endeBelegt)return ausstehend('Prozessende nicht verifiziert',stdout,stderr,timedOut);
    if(testdatei&&exitCode===124&&stderr.includes(timeoutMarker))timedOut=true;
    const quellen_wiederhergestellt=await wiederherstellen();
    if(quellen_wiederhergestellt.length&&!sicherungsJob){
      const audit=await getPool().query<{id:string}>(
        "INSERT INTO shell_jobs(project,command,status,agent_id,claimed_by,sicherung) VALUES($1,$2,'running',$3,'workspace',$4::jsonb) RETURNING id",
        [project,command,opts.agent_id??null,JSON.stringify({ursprung:'workspace',quellen_wiederhergestellt})]);
      sicherungsJob=audit.rows[0].id;
    }

    // Activity bei jedem exec frischen — Idle-Timer nicht versehentlich triggern.
    await this.recordActivity(project, wsName);

    const dt = Date.now() - t0;
    console.error(`[Workspaces] exec ${project} done: exit=${exitCode} stdout=${stdout.length}B stderr=${stderr.length}B in ${dt}ms${timedOut ? ' [TIMEOUT]' : ''}`);
    void this.appendToLog(containerId, `EXIT: code=${exitCode} duration=${dt}ms stdout=${stdout.length}B stderr=${stderr.length}B${timedOut ? ' TIMEOUT' : ''}`);

    const internal_urls: Record<number, string> = {};
    if (opts.exposePorts) for (const p of opts.exposePorts) internal_urls[p] = this.internalUrl(project, p, wsName);

    const result={stdout,stderr,exitCode,timedOut,durationMs:dt,...(quellen_wiederhergestellt.length?{quellen_wiederhergestellt}:{}),...(opts.exposePorts?{internal_urls}:{}),
      ...(pruefung.antwort?pruefung.antwort:{}),...(sicherungsJob?{id:sicherungsJob}:{})};
    if(sicherungsJob)await beendeShellSicherungsJob(sicherungsJob,project,{
      status:timedOut?'hard_limit':exitCode===0?'done':'failed',exit_code:exitCode,tail:(stdout+stderr).split('\n').slice(-5)});
    if(sicherungsJob&&quellen_wiederhergestellt.length)await getPool().query(
      "UPDATE shell_jobs SET sicherung=COALESCE(sicherung,'{}'::jsonb)||jsonb_build_object('quellen_wiederhergestellt',$2::jsonb) WHERE id=$1::uuid AND project=$3",
      [sicherungsJob,JSON.stringify(quellen_wiederhergestellt),project]);
    return maskiereShellAntwort(project,result);
    }catch(error){
      if(testdatei&&!endeBelegt){
        if(!gestarteterExec)endeBelegt=true;
        else {try{endeBelegt=(await gestarteterExec.inspect()).Running===false;}catch{/* Keine belegbare Beendigung; dauerhaft vormerken. */}}
        if(!endeBelegt)return ausstehend(String(error));
      }
      if(!wiederherstellungVersucht)await wiederherstellen();
      if(sicherungsJob)await beendeShellSicherungsJob(sicherungsJob,project,{status:'failed',error:'workspace_quellen_exec_fehlgeschlagen',message:String(error)});
      throw error;
    }
  }



  /** Nach Neustart weiter nutzbar: offene Prüfungen stehen am ursprünglichen Job in PG. */
  async pruefeAusstehendeQuellen(project:string,container?:Docker.Container):Promise<string[]>{
    const r=await getPool().query<{id:string;sicherung:{quellen_pruefung_ausstehend?:{container_id?:string;exec_id?:string}}}>(
      "SELECT id,sicherung FROM shell_jobs WHERE project=$1 AND sicherung ? 'quellen_pruefung_ausstehend'",[project]);
    if(!r.rows.length)return [];
    for(const row of r.rows){
      const offen=row.sicherung?.quellen_pruefung_ausstehend;
      if(!offen?.exec_id||!offen.container_id)throw Error('quellen_pruefung_ausstehend');
      let beendet=false;
      try{beendet=(await this.docker.getExec(offen.exec_id).inspect()).Running===false;}
      catch(error){
        if((error as {statusCode?:number}).statusCode===404){
          try{beendet=(await this.docker.getContainer(offen.container_id).inspect()).State.Running===false;}
          catch(containerError){beendet=(containerError as {statusCode?:number}).statusCode===404;}
        }
      }
      if(!beendet)throw Error('quellen_pruefung_ausstehend');
    }
    if(!container)return [];
    const repariert=await this.stelleWorkspaceQuellenWiederHer(project,container);
    await getPool().query(
      "UPDATE shell_jobs SET sicherung=(COALESCE(sicherung,'{}'::jsonb)-'quellen_pruefung_ausstehend')||$2::jsonb,error=NULL,message='quellen_pruefung_nachgeholt',updated_at=NOW() WHERE id=ANY($1::uuid[]) AND project=$3",
      [r.rows.map(row=>row.id),JSON.stringify({quellen_pruefung_nachgeholt:true,quellen_wiederhergestellt:repariert}),project]);
    return repariert;
  }

  /** Nur nach nativer Testdatei-Ausnahme: aktuelle PG-Revision während Restore/Verify sperren. */
  async stelleWorkspaceQuellenWiederHer(project:string,container: Docker.Container):Promise<string[]>{
    const client=await getPool().connect();
    try{
      await client.query('BEGIN');
      const r=await client.query<{file_path:string;content:string}>(
        'SELECT file_path, content FROM code_files WHERE project=$1 AND content IS NOT NULL FOR SHARE',[project]);
      const quellen=r.rows.filter(q=>q.file_path!=='pnpm-lock.yaml'&&!istWorkspaceIgnoriert(q.file_path));
      for(const q of quellen)if(!q.file_path||q.file_path.startsWith('/')||q.file_path.includes('\\')||
        q.file_path.split('/').some(p=>p==='..'||p==='.'||!p)||/[\x00-\x1f]/.test(q.file_path))throw Error('workspace_quellen_pfad_ungueltig');
      const fehlend=await pruefeWorkspaceQuellen(container,quellen);
      if(fehlend.length){
        await schreibeWorkspaceQuellen(container,quellen.filter(q=>fehlend.includes(q.file_path)));
        if((await pruefeWorkspaceQuellen(container,quellen)).length)throw Error('workspace_quellen_wiederherstellung_unvollstaendig');
      }
      await client.query('COMMIT');
      return fehlend;
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
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
    // WS3: /workspace-Volume ist projektweit geteilt — ein bereits laufender
    // Container (egal welcher Workspace) reicht; sonst main starten.
    const containerId = (await this.anyActiveContainerId(project)) ?? (await this.ensureProjectRunning(project));
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
      if (istWorkspaceIgnoriert(fp, ignore)) continue;
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
    // Nur Build-Artefaktverzeichnisse freigeben, niemals die Quellverzeichnisse.
    const buildDirs=new Set<string>();
    for(const row of r.rows){
      const fp=String(row.file_path);
      if(!istWorkspaceIgnoriert(fp,ignore)&&/(?:^|\/)package\.json$/.test(fp)){
        const base=fp.slice(0,-'package.json'.length);
        buildDirs.add(base+'node_modules');buildDirs.add(base+'dist');
      }
    }
    for(const dir of buildDirs)await new Promise<void>((resolve,reject)=>{
      pack.entry({name:dir,type:'directory',mode:0o755,uid:1000,gid:1000},err=>err?reject(err):resolve());
    });
    pack.finalize();
    await putPromise;
    await this.recordActivity(project);
    const dt = Date.now() - t0;
    console.error(`[Workspaces] materialize ${project}: ${files} files, ${bytes}B in ${dt}ms`);
    void this.appendToLog(containerId, `MATERIALIZE: ${files} files, ${bytes}B in ${dt}ms`);
    return { files, bytes, durationMs: dt };
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
    const containerId = (await this.anyActiveContainerId(project)) ?? (await this.ensureProjectRunning(project));
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
      if (istWorkspaceIgnoriert(fp, ignore)) { skipped++; continue; }
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

  async pin(project: string, pinned: boolean, ws = 'main'): Promise<void> {
    const pool = getPool();
    await pool.query(`UPDATE project_workspaces SET pinned=$2, updated_at=NOW() WHERE project=$1 AND name=$3`, [project, pinned, ws]);
  }

  /**
   * Setzt Workspace-Konfiguration pro Projekt (nur PG-Row). Aenderungen an
   * cpu/mem/pids/tmpfs/image greifen beim NAECHSTEN Container-Start —
   * ein laufender Container behaelt seine Caps (stop + start zum Anwenden).
   */
  async configure(
    project: string,
    opts: { cpuLimit?: number; memLimitMb?: number; pidsLimit?: number; tmpfsMb?: number; image?: string },
    ws = 'main'
  ): Promise<{ applied: Record<string, unknown>; requiresRestart: boolean }> {
    const pool = getPool();
    const { ws: wsName } = this.wsKey(project, ws);
    await pool.query(`INSERT INTO project_workspaces (project, name) VALUES ($1, $2) ON CONFLICT (project, name) DO NOTHING`, [project, wsName]);
    const sets: string[] = [];
    const vals: unknown[] = [project, wsName];
    const applied: Record<string, unknown> = {};
    const push = (col: string, v: unknown): void => { vals.push(v); sets.push(col + '=' + '$' + String(vals.length)); applied[col] = v; };
    if (opts.cpuLimit !== undefined && Number.isFinite(opts.cpuLimit) && opts.cpuLimit > 0 && opts.cpuLimit <= 32) push('cpu_limit', opts.cpuLimit);
    if (opts.memLimitMb !== undefined && Number.isInteger(opts.memLimitMb) && opts.memLimitMb >= 128) push('mem_limit_mb', opts.memLimitMb);
    if (opts.pidsLimit !== undefined && Number.isInteger(opts.pidsLimit) && opts.pidsLimit >= 16) push('pids_limit', opts.pidsLimit);
    if (opts.tmpfsMb !== undefined && Number.isInteger(opts.tmpfsMb) && opts.tmpfsMb >= 16) push('tmpfs_mb', opts.tmpfsMb);
    if (opts.image !== undefined && /^[a-zA-Z0-9._\/:@-]+$/.test(opts.image)) push('image', opts.image);
    if (sets.length === 0) {
      throw new Error('configure: keine gueltigen Felder (cpu_limit 0-32, mem_limit_mb>=128, pids_limit>=16, tmpfs_mb>=16, image)');
    }
    await pool.query(`UPDATE project_workspaces SET ${sets.join(', ')}, updated_at=NOW() WHERE project=$1 AND name=$2`, vals);
    const row = await this.loadRow(project, wsName);
    return { applied, requiresRestart: row?.status === 'active' };
  }

  async listWorkspaces(): Promise<WorkspaceInfo[]> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT project, name, container_id, status, image, cpu_limit, mem_limit_mb, tmpfs_mb, pinned,
              last_activity_at, last_started_at, last_stopped_at, last_error
         FROM project_workspaces ORDER BY (status='active') DESC, project, name, last_activity_at DESC`
    );
    return r.rows.map(this.rowToInfo);
  }

  // ─── interne Helfer ────────────────────────────────────────────────────────

  private rowToInfo(r: Record<string, unknown>): WorkspaceInfo {
    return {
      project: r.project as string,
      name: (r.name as string | undefined) ?? 'main',
      containerId: (r.container_id as string | null) ?? null,
      status: r.status as WorkspaceInfo['status'],
      image: r.image as string,
      cpuLimit: Number(r.cpu_limit),
      memLimitMb: Number(r.mem_limit_mb),
      tmpfsMb: Number(r.tmpfs_mb),
      pinned: r.pinned as boolean,
      lastActivityAt: new Date(r.last_activity_at as string),
      lastStartedAt: r.last_started_at ? new Date(r.last_started_at as string) : null,
      lastStoppedAt: r.last_stopped_at ? new Date(r.last_stopped_at as string) : null,
      lastError: (r.last_error as string | null) ?? null,
    };
  }

  private async loadRow(project: string, ws = 'main'): Promise<{ containerId: string | null; status: string; image: string; volumeName: string | null; cpuLimit: number; memLimitMb: number; pidsLimit: number; tmpfsMb: number; pinned: boolean } | null> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT container_id, status, image, volume_name, cpu_limit, mem_limit_mb, pids_limit, tmpfs_mb, pinned
         FROM project_workspaces WHERE project=$1 AND name=$2`,
      [project, ws]
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
      tmpfsMb: Number(x.tmpfs_mb),
      pinned: x.pinned,
    };
  }

  /** WS4: Workspaces pro Projekt — konfigurierbar statt hart 3 (Rollen-Instanzen). */
  private perProjectCap(): number {
    const n = parseInt(process.env.SYNAPSE_WS_PER_PROJECT_CAP || '', 10);
    return Number.isFinite(n) && n >= 1 ? n : 6;
  }

  /** WS5: ENV-Allowlist fuer privilegierte Rollen (devices/security_opts). */
  private privilegedRoleAllowed(role: string): boolean {
    return (process.env.SYNAPSE_WS_PRIVILEGED_ROLES || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      .includes(role.toLowerCase());
  }

  /** WS4: Laedt ein Rollen-Template — projekt-scoped schlaegt globale Rolle gleichen Namens. */
  private async loadRoleTemplate(project: string, role: string): Promise<{ image: string; cpuLimit: number; memLimitMb: number; pidsLimit: number; tmpfsMb: number; initCommand: string | null; devices: string[]; securityOpts: string[]; capAdd: string[] } | null> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT image, cpu_limit, mem_limit_mb, pids_limit, tmpfs_mb, init_command, devices, security_opts, cap_add
         FROM workspace_roles
        WHERE role = $2 AND (project = $1 OR project IS NULL)
        ORDER BY (project IS NOT NULL) DESC
        LIMIT 1`,
      [project, role.toLowerCase()]
    );
    if (!r.rows[0]) return null;
    const x = r.rows[0];
    return {
      image: x.image,
      cpuLimit: Number(x.cpu_limit),
      memLimitMb: Number(x.mem_limit_mb),
      pidsLimit: Number(x.pids_limit),
      tmpfsMb: Number(x.tmpfs_mb),
      initCommand: (x.init_command as string | null) ?? null,
      devices: (x.devices as string[] | null) ?? [],
      securityOpts: (x.security_opts as string[] | null) ?? [],
      capAdd: (x.cap_add as string[] | null) ?? [],
    };
  }

  /**
   * WS4: Fuehrt den Rollen-init_command der Instanz aus (nach jedem Container-
   * Start). Dienste-Bootstrap als User synapse (z.B. initdb + pg_ctl start,
   * redis-server --daemonize). Fehler sind nicht fatal: last_error wird gesetzt,
   * der Container bleibt nutzbar. Kein Rekursionsrisiko: zum Zeitpunkt des
   * Aufrufs ist status='active' — exec→ensureProjectRunning returned early.
   */
  private async runRoleInit(project: string, ws: string, containerId: string): Promise<void> {
    const pool = getPool();
    const r = await pool.query(`SELECT role FROM project_workspaces WHERE project=$1 AND name=$2`, [project, ws]);
    const role = (r.rows[0]?.role as string | null) ?? null;
    if (!role) return;
    const tpl = await this.loadRoleTemplate(project, role);
    if (!tpl?.initCommand) return;
    void this.appendToLog(containerId, `ROLE-INIT (${role}): ${tpl.initCommand.slice(0, 200)}`);
    try {
      const res = await this.exec(project, tpl.initCommand, { workspace: ws, timeoutMs: 120_000 });
      if (res.exitCode !== 0) {
        const msg = `role-init "${role}" exit=${res.exitCode}: ${(res.stderr || res.stdout).slice(0, 500)}`;
        await pool.query(`UPDATE project_workspaces SET last_error=$3, updated_at=NOW() WHERE project=$1 AND name=$2`, [project, ws, msg]);
        console.error(`[Workspaces] ${project}/${ws} ${msg}`);
      } else {
        console.error(`[Workspaces] ${project}/${ws} role-init "${role}" OK (${res.durationMs}ms)`);
      }
    } catch (err) {
      const msg = `role-init "${role}" failed: ${(err as Error).message}`;
      await pool.query(`UPDATE project_workspaces SET last_error=$3, updated_at=NOW() WHERE project=$1 AND name=$2`, [project, ws, msg]).catch(() => {});
      console.error(`[Workspaces] ${project}/${ws} ${msg}`);
    }
  }

  // ─── WS4: Rollen-Templates (Rolle = Template, Workspace = Instanz) ─────────
  // Rollen sind NIE fest: via role_set/role_delete editierbar (global ODER
  // projekt-scoped), jede Rolle ist beliebig oft instanziierbar (db-1, db-2, ...).

  async roleSet(opts: { project?: string | null; role: string; image?: string; cpuLimit?: number; memLimitMb?: number; pidsLimit?: number; tmpfsMb?: number; initCommand?: string | null; description?: string | null; devices?: string[]; securityOpts?: string[]; capAdd?: string[] }): Promise<Record<string, unknown>> {
    const role = (opts.role || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(role)) {
      throw new Error(`Ungueltiger Rollen-Name "${opts.role}" (erlaubt: ^[a-z0-9][a-z0-9-]{0,29}$)`);
    }
    if (opts.image !== undefined && !/^[a-zA-Z0-9._\/:@-]+$/.test(opts.image)) throw new Error('role_set: ungueltiges image');
    if (opts.cpuLimit !== undefined && !(Number.isFinite(opts.cpuLimit) && opts.cpuLimit > 0 && opts.cpuLimit <= 32)) throw new Error('role_set: cpu_limit 0-32');
    if (opts.memLimitMb !== undefined && !(Number.isInteger(opts.memLimitMb) && opts.memLimitMb >= 128)) throw new Error('role_set: mem_limit_mb >= 128');
    if (opts.pidsLimit !== undefined && !(Number.isInteger(opts.pidsLimit) && opts.pidsLimit >= 16)) throw new Error('role_set: pids_limit >= 16');
    if (opts.tmpfsMb !== undefined && !(Number.isInteger(opts.tmpfsMb) && opts.tmpfsMb >= 16)) throw new Error('role_set: tmpfs_mb >= 16');
    // WS5: enge Whitelists — wirksam werden devices/security_opts ohnehin erst,
    // wenn die Rolle in ENV SYNAPSE_WS_PRIVILEGED_ROLES allowlisted ist.
    if (opts.devices !== undefined && (!Array.isArray(opts.devices) || opts.devices.some(d => typeof d !== 'string' || !/^\/dev\/(fuse|kvm|net\/tun)$/.test(d)))) {
      throw new Error('role_set: devices — erlaubt sind nur /dev/fuse, /dev/kvm, /dev/net/tun (kein --privileged, kein docker.sock)');
    }
    if (opts.securityOpts !== undefined && (!Array.isArray(opts.securityOpts) || opts.securityOpts.some(s => !['seccomp=unconfined', 'apparmor=unconfined', 'label=disable'].includes(s)))) {
      throw new Error('role_set: security_opts — erlaubt sind nur seccomp=unconfined, apparmor=unconfined, label=disable');
    }
    if (opts.capAdd !== undefined && (!Array.isArray(opts.capAdd) || opts.capAdd.some(c => !['SETUID', 'SETGID'].includes(c)))) {
      throw new Error('role_set: cap_add — erlaubt sind nur SETUID, SETGID (rootless-Podman newuidmap/newgidmap; kein --privileged)');
    }
    const pool = getPool();
    const r = await pool.query(
      `INSERT INTO workspace_roles (project, role, image, cpu_limit, mem_limit_mb, pids_limit, tmpfs_mb, init_command, description, devices, security_opts, cap_add)
       VALUES ($1, $2, COALESCE($3, 'synapse-workspace:latest'), COALESCE($4, 1.0), COALESCE($5, 512), COALESCE($6, 200), COALESCE($7, 256), $8, $9, COALESCE($10::text[], '{}'), COALESCE($11::text[], '{}'), COALESCE($12::text[], '{}'))
       ON CONFLICT ((COALESCE(project, '')), role) DO UPDATE SET
         image        = COALESCE($3, workspace_roles.image),
         cpu_limit    = COALESCE($4, workspace_roles.cpu_limit),
         mem_limit_mb = COALESCE($5, workspace_roles.mem_limit_mb),
         pids_limit   = COALESCE($6, workspace_roles.pids_limit),
         tmpfs_mb     = COALESCE($7, workspace_roles.tmpfs_mb),
         init_command = COALESCE($8, workspace_roles.init_command),
         description  = COALESCE($9, workspace_roles.description),
         devices       = COALESCE($10::text[], workspace_roles.devices),
         security_opts = COALESCE($11::text[], workspace_roles.security_opts),
         cap_add       = COALESCE($12::text[], workspace_roles.cap_add),
         updated_at   = NOW()
       RETURNING project, role, image, cpu_limit, mem_limit_mb, pids_limit, tmpfs_mb, init_command, description, devices, security_opts, cap_add`,
      [opts.project ?? null, role, opts.image ?? null, opts.cpuLimit ?? null, opts.memLimitMb ?? null, opts.pidsLimit ?? null, opts.tmpfsMb ?? null, opts.initCommand ?? null, opts.description ?? null, opts.devices ?? null, opts.securityOpts ?? null, opts.capAdd ?? null]
    );
    return r.rows[0];
  }

  async roleList(project?: string): Promise<Array<Record<string, unknown>>> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT project, role, image, cpu_limit, mem_limit_mb, pids_limit, tmpfs_mb, init_command, description, devices, security_opts, cap_add, updated_at,
              (project IS NULL) AS is_global
         FROM workspace_roles
        WHERE project IS NULL OR project = $1
        ORDER BY role, (project IS NOT NULL) DESC`,
      [project ?? null]
    );
    return r.rows;
  }

  async roleDelete(role: string, project?: string | null): Promise<boolean> {
    const pool = getPool();
    const r = await pool.query(
      `DELETE FROM workspace_roles WHERE role = $1 AND COALESCE(project, '') = COALESCE($2, '')`,
      [role.toLowerCase(), project ?? null]
    );
    return (r.rowCount ?? 0) > 0;
  }

  private async countActive(): Promise<number> {
    const pool = getPool();
    const r = await pool.query(`SELECT count(*)::int c FROM project_workspaces WHERE status='active'`);
    return r.rows[0].c;
  }

  /**
   * WS3: Validiert einen Workspace-Namen und liefert den Namens-Suffix.
   * 'main' (Default) traegt KEINEN Suffix — Container-/Volume-/DNS-Namen des
   * Bestands bleiben unveraendert. Andere Workspaces: -<name>.
   */
  private wsKey(project: string, ws: string): { ws: string; suffix: string } {
    const clean = (ws || 'main').toLowerCase();
    if (clean !== 'main' && !/^[a-z0-9][a-z0-9-]{0,19}$/.test(clean)) {
      throw new Error(`Ungueltiger Workspace-Name "${ws}" fuer ${project} (erlaubt: ^[a-z0-9][a-z0-9-]{0,19}$)`);
    }
    return { ws: clean, suffix: clean === 'main' ? '' : `-${clean}` };
  }

  /**
   * WS3: Liefert die Container-ID IRGENDEINES laufenden Workspace des Projekts
   * (fuer /workspace-Sync — das Volume ist geteilt). null wenn keiner laeuft.
   */
  private async anyActiveContainerId(project: string): Promise<string | null> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT container_id FROM project_workspaces
        WHERE project=$1 AND status='active' AND container_id IS NOT NULL
        ORDER BY (name='main') DESC, last_activity_at DESC`,
      [project]
    );
    for (const row of r.rows) {
      if (await this.isContainerRunning(row.container_id)) return row.container_id;
    }
    return null;
  }

  private async evictLru(excludeProject: string, excludeWs = 'main'): Promise<void> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT project, name FROM project_workspaces
        WHERE status='active' AND pinned=false AND NOT (project = $1 AND name = $2)
        ORDER BY last_activity_at ASC LIMIT 1`,
      [excludeProject, excludeWs]
    );
    if (!r.rows[0]) {
      // Nichts evictierbar (alles pinned). Wir starten trotzdem → temporaere Ueberschreitung
      console.error(`[Workspaces] LRU-Eviction: nichts evictierbar (alle aktiven gepint), Cap wird temporaer ueberschritten`);
      return;
    }
    const victim = r.rows[0];
    console.error(`[Workspaces] LRU-Eviction: stoppe ${victim.project}/${victim.name} fuer ${excludeProject}/${excludeWs}`);
    await this.stopProject(victim.project, 'lru-evicted', victim.name);
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
    ws: string,
    row: { image: string; cpuLimit: number; memLimitMb: number; pidsLimit: number; tmpfsMb: number },
    volumeName: string,
    homeVolumeName: string
  ): Promise<string> {
    const { suffix } = this.wsKey(project, ws);
    // WS3: 'main' behaelt den Bestandsnamen synapse-ws-<p>; andere Workspaces
    // heissen synapse-ws-<p>-<name> — das ist zugleich ihr proxynet-DNS-Name.
    const name = `${this.cfg.containerNamePrefix}-${sanitize(project)}${suffix}`;
    // Falls Restmuell mit gleichem Namen existiert: aufraeumen.
    try {
      const stale = this.docker.getContainer(name);
      await stale.remove({ force: true }).catch(() => {});
    } catch { /* nicht existent, gut */ }

    // WS5: privilegierte Rollen-Optionen (devices/security_opts) — live aus dem
    // Rollen-Template (wie init_command), NICHT aus der Instanz-Row. Wirksam
    // NUR wenn die Rolle in ENV SYNAPSE_WS_PRIVILEGED_ROLES allowlisted ist;
    // sonst harter Start-Fehler. Kein --privileged, kein docker.sock — nur die
    // enge, in roleSet validierte Options-Whitelist.
    const pool = getPool();
    const roleRow = await pool.query(`SELECT role FROM project_workspaces WHERE project=$1 AND name=$2`, [project, ws]);
    const instanceRole = (roleRow.rows[0]?.role as string | null) ?? null;
    let privDevices: string[] = [];
    let privSecurityOpts: string[] = [];
    let privCapAdd: string[] = [];
    if (instanceRole) {
      const tpl = await this.loadRoleTemplate(project, instanceRole);
      if (tpl && (tpl.devices.length > 0 || tpl.securityOpts.length > 0 || tpl.capAdd.length > 0)) {
        if (!this.privilegedRoleAllowed(instanceRole)) {
          throw new Error(`Rolle "${instanceRole}" verlangt privilegierte Optionen (devices=${tpl.devices.join(',') || '-'}; security_opts=${tpl.securityOpts.join(',') || '-'}), steht aber nicht in ENV SYNAPSE_WS_PRIVILEGED_ROLES — Start verweigert (Opt-in pro Deployment)`);
        }
        privDevices = tpl.devices;
        privSecurityOpts = tpl.securityOpts;
        privCapAdd = tpl.capAdd;
        console.error(`[Workspaces] ${project}/${ws}: privilegierte Rolle "${instanceRole}" allowlisted — devices=[${privDevices.join(',')}] security_opts=[${privSecurityOpts.join(',')}]`);
      }
    }

    const create = await this.docker.createContainer({
      name,
      Image: row.image,
      Labels: { 'synapse.workspace': 'true', 'synapse.project': project, 'synapse.workspace-name': ws },
      Tty: false,
      OpenStdin: false,
      WorkingDir: '/workspace',
      Env: [`SYNAPSE_PROJECT=${project}`, `SYNAPSE_WORKSPACE=${ws}`],
      HostConfig: {
        NetworkMode: this.cfg.network,
        AutoRemove: false,
        ReadonlyRootfs: true,
        // exec-Flag: Docker-Tmpfs-Default ist noexec — das blockt kompilierte
        // Binaries/venv-Skripte in /tmp (real beobachtet). Im Sandbox-Container
        // ist exec dort kein Mehr-Risiko (/workspace ist ohnehin exec-faehig).
        Tmpfs: { '/tmp': `size=${Math.max(16, Math.round(row.tmpfsMb || 256))}m,exec,uid=1000,gid=1000` },
        // /workspace = Projekt-Quellen (PG-Sync), /home/synapse = persistentes
        // schreibbares HOME (npm/pip/cargo/rustup/ccache-Selbstbedienung, WS2-A1).
        Binds: [`${volumeName}:/workspace`, `${homeVolumeName}:/home/synapse`],
        // Resource-Caps
        NanoCpus: Math.round(row.cpuLimit * 1e9),
        Memory: row.memLimitMb * 1024 * 1024,
        MemorySwap: row.memLimitMb * 1024 * 1024,   // kein Swap-Spielraum
        PidsLimit: row.pidsLimit,
        // WS5: privilegierte Optionen — nur gesetzt wenn Rolle allowlisted (Gate oben).
        ...(privDevices.length > 0 ? { Devices: privDevices.map(d => ({ PathOnHost: d, PathInContainer: d, CgroupPermissions: 'rwm' })) } : {}),
        ...(privSecurityOpts.length > 0 ? { SecurityOpt: privSecurityOpts } : {}),
        ...(privCapAdd.length > 0 ? { CapAdd: privCapAdd } : {}),
      },
      // PID 1 = tail -F /tmp/ws.log → docker logs zeigt alle exec/materialize/start/stop
      // Events die der Orchestrator dorthin appended. /tmp ist tmpfs (siehe oben),
      // beim Container-Restart leer; Datei wird beim ersten echo neu angelegt.
      Cmd: ['/bin/sh', '-c', 'touch /tmp/ws.log; tail -F /tmp/ws.log 2>/dev/null'],
      User: '1000:1000',
    });
    await create.start();
    console.error(`[Workspaces] container created+started: ${name} (${create.id.slice(0, 12)}) for ${project}`);
    // Initial log-line in den Container damit docker logs sofort was zeigt
    void this.appendToLog(create.id, `CONTAINER STARTED (${name})`).catch(() => { /* ignore */ });
    return create.id;
  }

  /** Schreibt eine Zeile nach /tmp/ws.log im Container — taucht in docker logs auf. */
  private async appendToLog(containerId: string, line: string): Promise<void> {
    if (!this.dockerAvailable) return;
    try {
      const container = this.docker.getContainer(containerId);
      const ts = new Date().toISOString();
      // Escapen mit Heredoc-style stdin um Quote-Hoelle zu vermeiden
      const ex = await container.exec({
        Cmd: ['/bin/sh', '-c', `printf '[ws] %s %s\\n' "${ts}" "${line.replace(/"/g, '\\"').slice(0, 500)}" >> /tmp/ws.log`],
        AttachStdout: false, AttachStderr: false, User: '0',
      });
      await ex.start({ hijack: false, stdin: false });
    } catch { /* best-effort, no log noise */ }
  }

  private async markStopped(project: string, reason: string, ws = 'main'): Promise<void> {
    const pool = getPool();
    await pool.query(
      `UPDATE project_workspaces
          SET status='cold', container_id=NULL, last_stopped_at=NOW(),
              last_error=$2, updated_at=NOW()
        WHERE project=$1 AND name=$3`,
      [project, reason, ws]
    );
  }

  private startIdleStopLoop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    // P15-T12: pausierbar und einzeln ausloesbar ueber intern(worker_*)
    registriereWorker({
      name: 'workspace_idle_stop',
      beschreibung: `Workspace-Container nach ${this.cfg.idleStopMinutes} min ohne Aktivitaet stoppen (Tick ${this.cfg.tickIntervalMs} ms)`,
      durchlauf: () => this.idleStopTick(),
    });
    this.idleTimer = setInterval(() => {
      if (workerPausiert('workspace_idle_stop')) return;
      this.idleStopTick().catch(err => console.error(`[Workspaces] idleStopTick: ${(err as Error).message}`));
    }, this.cfg.tickIntervalMs);
  }

  private async idleStopTick(): Promise<{ gestoppt: number; docker: boolean }> {
    if (!this.dockerAvailable) return { gestoppt: 0, docker: false };
    const pool = getPool();
    const cutoff = new Date(Date.now() - this.cfg.idleStopMinutes * 60_000);
    const r = await pool.query(
      `SELECT project, name FROM project_workspaces
        WHERE status='active' AND pinned=false AND last_activity_at < $1`,
      [cutoff]
    );
    for (const row of r.rows) {
      await this.stopProject(row.project, `idle > ${this.cfg.idleStopMinutes}min`, row.name);
    }
    if (r.rows.length > 0) meldeWorkerArbeit('workspace_idle_stop');
    return { gestoppt: r.rows.length, docker: true };
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
