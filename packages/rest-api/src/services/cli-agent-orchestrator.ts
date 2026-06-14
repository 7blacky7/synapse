/**
 * Synapse API — CLI-Agent-Orchestrator (PLAN-004 / DIND-5-prep)
 * ============================================================================
 * NEUER verwalteter Container-Typ NEBEN dem WorkspaceOrchestrator (ersetzt ihn
 * NICHT). Verwaltet persistente CLI-Agenten-Container (claude / codex /
 * antigravity) auf dem HOST-Docker via docker.sock — GENAU WIE die Workspace-
 * Container, aber als eigener Typ. KEIN inneres DinD.
 *
 * ZENTRALE ABWEICHUNG zu WorkspaceOrchestrator (bewusst):
 *   - PERSISTENT: KEIN idle-stop-Loop, KEINE LRU-Eviction, kein pinned/
 *     last_activity. Lifecycle ausschliesslich explizit: START / UPDATE / STOP
 *     (getriggert ueber REST/WebUI).
 *   - RestartPolicy 'unless-stopped' — der Container ueberlebt synapse-api-/
 *     dockerd-Neustarts. Stoppen = aktive Nutzer-Entscheidung.
 *   - ReadonlyRootfs = FALSE (die CLI braucht Schreibzugriff fuer self-update
 *     und Caches). Workspace ist readonly + tmpfs.
 *   - User = root (0). Das CLI-Image laeuft als root (HOME=/root), die CLI liegt
 *     in /root/.local. Workspace laeuft als 1000:1000.
 *   - Auth-Volumes persistent PRO Agent: /root/.claude (Creds) + /root/.local
 *     (Binary + self-update-Stand) — ueberleben stop/start/update.
 *
 * Feature-gated: wird nur initialisiert wenn SYNAPSE_DIND_ENABLED=1 (siehe
 * server.ts). Ist DinD aus, existiert keine Instanz und die Routen liefern 503.
 *
 * PG-Tabelle cli_agents ist Single-Source-of-Truth (Orchestrator-Restarts
 * finden den Stand wieder; reconcile() korrigiert verwaiste Status).
 */

import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { getPool } from '@synapse/core';

export interface CliAgentConfig {
  socketPath?: string;
  network?: string;
  containerNamePrefix?: string;
  volumeNamePrefix?: string;
}

const DEFAULTS: Required<CliAgentConfig> = {
  socketPath: '/var/run/docker.sock',
  network: 'proxynet',
  containerNamePrefix: 'synapse-cli',
  volumeNamePrefix: 'synapse-cli',
};

/** Eine Mount-Bindung des persistenten Volumes in den CLI-Container. */
interface CliMount {
  volumeKey: 'auth' | 'local';
  path: string;
}

/** Bekannte CLI-Typen. claude existiert (docker/cli-agents/claude/). */
interface CliTypeSpec {
  image: string;
  binary: string;
  versionCmd: string;
  /** WorkingDir fuer exec (Image-WORKDIR). */
  workdir: string;
  mounts: CliMount[];
}

const CLI_TYPES: Record<string, CliTypeSpec> = {
  claude: {
    image: 'synapse-cli-claude:latest',
    binary: 'claude',
    versionCmd: 'claude --version',
    workdir: '/agent',
    mounts: [
      { volumeKey: 'auth', path: '/root/.claude' },
      { volumeKey: 'local', path: '/root/.local' },
    ],
  },
  // codex / antigravity folgen in DIND-2-Rest (eigene Images + Auth-Pfade).
};

export interface CliAgentInfo {
  name: string;
  cliType: string;
  project: string | null;
  status: string;
  image: string;
  containerId: string | null;
  version: string | null;
  authVolume: string | null;
  localVolume: string | null;
  cpuLimit: number;
  memLimitMb: number;
  pidsLimit: number;
  autoUpdate: boolean;
  lastStartedAt: string | null;
  lastStoppedAt: string | null;
  lastUpdatedAt: string | null;
  lastError: string | null;
  dockerRunning?: boolean;
}

function sanitize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function toIso(v: unknown): string | null {
  return v ? new Date(v as string).toISOString() : null;
}

function rowToInfo(row: Record<string, unknown>): CliAgentInfo {
  return {
    name: row.name as string,
    cliType: row.cli_type as string,
    project: (row.project as string | null) ?? null,
    status: row.status as string,
    image: row.image as string,
    containerId: (row.container_id as string | null) ?? null,
    version: (row.version as string | null) ?? null,
    authVolume: (row.auth_volume as string | null) ?? null,
    localVolume: (row.local_volume as string | null) ?? null,
    cpuLimit: Number(row.cpu_limit),
    memLimitMb: Number(row.mem_limit_mb),
    pidsLimit: Number(row.pids_limit),
    autoUpdate: Boolean(row.auto_update),
    lastStartedAt: toIso(row.last_started_at),
    lastStoppedAt: toIso(row.last_stopped_at),
    lastUpdatedAt: toIso(row.last_updated_at),
    lastError: (row.last_error as string | null) ?? null,
  };
}

const SELECT_COLS =
  'name, cli_type, project, status, image, container_id, version, auth_volume, local_volume, ' +
  'cpu_limit, mem_limit_mb, pids_limit, auto_update, last_started_at, last_stopped_at, last_updated_at, last_error';

export class CliAgentOrchestrator {
  private docker: Docker;
  private cfg: Required<CliAgentConfig>;
  private dockerAvailable = false;
  /** Per-Agent-Lock: serialisiert start/update/stop/remove gegen Races + Name-Kollision. */
  private locks = new Map<string, Promise<unknown>>();

  constructor(cfg: CliAgentConfig = {}) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.docker = new Docker({ socketPath: this.cfg.socketPath });
  }

  /**
   * Fuehrt fn unter einem per-Agent-Lock aus. Verhindert dass zwei gleichzeitige
   * Lifecycle-Operationen (z.B. doppeltes start(), oder start()+stop()) auf
   * denselben Container-Namen rennen (Docker 409 Name-Konflikt) oder die PG-Row
   * gegeneinander schreiben. Lock ist in-process (eine synapse-api-Instanz).
   */
  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const key = sanitize(name);
    const prev = this.locks.get(key) ?? Promise.resolve();
    // Diese Operation reiht sich hinter die vorige ein; nachfolgende warten auf "run".
    const run = prev.then(() => fn(), () => fn());
    // Map auf das (Fehler-neutralisierte) Ende dieser Operation setzen.
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      // Nur aufraeumen wenn keine weitere Operation zwischenzeitlich eingereiht wurde.
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /** Idempotent. Pingt Docker, raeumt verwaiste Status auf. KEIN Auto-Start, KEIN idle-Loop. */
  async init(): Promise<boolean> {
    try {
      await this.docker.ping();
      this.dockerAvailable = true;
      console.error('[CliAgents] Docker erreichbar — CLI-Agent-Orchestrator aktiv (persistent, kein idle-stop)');
      await this.reconcile().catch((err) => console.error(`[CliAgents] reconcile: ${(err as Error).message}`));
    } catch (err) {
      this.dockerAvailable = false;
      console.error(`[CliAgents] Docker nicht erreichbar (${(err as Error).message}) — Orchestrator inaktiv, REST liefert 503`);
    }
    return this.dockerAvailable;
  }

  isAvailable(): boolean {
    return this.dockerAvailable;
  }

  /** Liste der bekannten CLI-Typen (fuer WebUI/Registrierung). */
  listCliTypes(): { cliType: string; image: string; binary: string }[] {
    return Object.entries(CLI_TYPES).map(([cliType, s]) => ({ cliType, image: s.image, binary: s.binary }));
  }

  private assertAvailable(): void {
    if (!this.dockerAvailable) {
      throw new Error('CLI-Agent-Orchestrator nicht verfuegbar (Docker-Socket nicht erreichbar oder SYNAPSE_DIND_ENABLED!=1)');
    }
  }

  private resolveSpec(cliType: string): CliTypeSpec {
    const spec = CLI_TYPES[cliType];
    if (!spec) {
      throw new Error(`Unbekannter cli_type "${cliType}" — bekannt: ${Object.keys(CLI_TYPES).join(', ')}`);
    }
    return spec;
  }

  private async loadRow(name: string): Promise<CliAgentInfo | null> {
    const r = await getPool().query(`SELECT ${SELECT_COLS} FROM cli_agents WHERE name=$1`, [sanitize(name)]);
    return r.rows[0] ? rowToInfo(r.rows[0] as Record<string, unknown>) : null;
  }

  /**
   * Gleicht die PG-Tabelle mit der Docker-Realitaet ab (bei synapse-api-Neustart).
   * Robust in BEIDE Richtungen:
   *  (a) PG sagt aktiv (running/starting/updating/stopping), aber der Container
   *      lebt nicht (oder kein/falsches container_id) -> auf 'stopped' korrigieren.
   *  (b) Container traegt unser Label und LAEUFT (RestartPolicy unless-stopped hat
   *      ihn ueberlebt), aber die zugehoerige PG-Row ist nicht 'running' oder hat
   *      ein stale container_id -> Row wieder auf 'running' + container_id resyncen
   *      (Adoption). So gehen persistente Container nach einem Neustart nicht
   *      faelschlich als 'stopped' verloren.
   * Best-effort: einzelne Fehler werden geloggt, brechen reconcile nicht ab.
   */
  private async reconcile(): Promise<void> {
    const pool = getPool();

    // (a) PG-aktiv, aber Container tot/fehlt -> stopped.
    const active = await pool.query(
      `SELECT name, container_id FROM cli_agents WHERE status IN ('running','starting','updating','stopping')`
    );
    for (const row of active.rows) {
      let alive = false;
      if (row.container_id) {
        try {
          const info = await this.docker.getContainer(row.container_id as string).inspect();
          alive = info?.State?.Running === true;
        } catch {
          alive = false;
        }
      }
      if (!alive) {
        await pool
          .query(
            `UPDATE cli_agents SET status='stopped', container_id=NULL, last_stopped_at=NOW(), updated_at=NOW() WHERE name=$1`,
            [row.name]
          )
          .catch((err) => console.error(`[CliAgents] reconcile(a) ${row.name}: ${(err as Error).message}`));
        console.error(`[CliAgents] reconcile: ${row.name} als aktiv markiert, Container fehlt -> stopped`);
      }
    }

    // (b) Lebende, gelabelte Container den PG-Rows zuordnen (Adoption nach Neustart).
    try {
      const containers = await this.docker.listContainers({
        all: false, // nur laufende
        filters: { label: ['synapse.cli-agent=true'] },
      });
      for (const c of containers) {
        const name = (c.Labels?.['synapse.cli-name'] || '').trim();
        if (!name) continue;
        const row = await pool.query(
          `SELECT status, container_id FROM cli_agents WHERE name=$1`,
          [sanitize(name)]
        );
        const pg = row.rows[0];
        if (!pg) continue; // Container ohne Definition -> nicht anfassen (kein Auto-Cleanup im reconcile).
        if (pg.status !== 'running' || pg.container_id !== c.Id) {
          await pool
            .query(
              `UPDATE cli_agents SET status='running', container_id=$2, last_error=NULL, updated_at=NOW() WHERE name=$1`,
              [sanitize(name), c.Id]
            )
            .catch((err) => console.error(`[CliAgents] reconcile(b) ${name}: ${(err as Error).message}`));
          console.error(`[CliAgents] reconcile: laufenden Container ${name} adoptiert (${c.Id.slice(0, 12)})`);
        }
      }
    } catch (err) {
      console.error(`[CliAgents] reconcile(b) listContainers: ${(err as Error).message}`);
    }
  }

  private async ensureVolume(volumeName: string): Promise<void> {
    try {
      await this.docker.getVolume(volumeName).inspect();
    } catch {
      await this.docker.createVolume({ Name: volumeName, Labels: { 'synapse.cli-agent': 'true' } });
      console.error(`[CliAgents] Volume erstellt: ${volumeName}`);
    }
  }

  /**
   * Registriert/aktualisiert die DEFINITION eines CLI-Agenten (PG-Row). Startet
   * NICHTS — status bleibt 'stopped'. name default = cli_type. Volumes-Namen
   * werden stabil aus dem Namen abgeleitet (bleiben bei Updates erhalten).
   */
  async registerAgent(opts: {
    name?: string;
    cliType: string;
    project?: string | null;
    image?: string;
    cpuLimit?: number;
    memLimitMb?: number;
    pidsLimit?: number;
    autoUpdate?: boolean;
  }): Promise<CliAgentInfo> {
    const cliType = (opts.cliType || '').trim();
    const spec = this.resolveSpec(cliType);
    const name = sanitize(opts.name?.trim() || cliType);
    if (!name) throw new Error('registerAgent: name/cli_type ergibt einen leeren Namen');
    const image = opts.image && /^[a-zA-Z0-9._/:@-]+$/.test(opts.image) ? opts.image : spec.image;
    const authVolume = `${this.cfg.volumeNamePrefix}-${name}-auth`;
    const localVolume = `${this.cfg.volumeNamePrefix}-${name}-local`;
    const pool = getPool();
    await pool.query(
      `INSERT INTO cli_agents (name, cli_type, project, image, auth_volume, local_volume, cpu_limit, mem_limit_mb, pids_limit, auto_update)
       VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7,2.0), COALESCE($8,2048), COALESCE($9,512), COALESCE($10,TRUE))
       ON CONFLICT (name) DO UPDATE SET
         cli_type=EXCLUDED.cli_type,
         project=EXCLUDED.project,
         image=EXCLUDED.image,
         cpu_limit=COALESCE($7, cli_agents.cpu_limit),
         mem_limit_mb=COALESCE($8, cli_agents.mem_limit_mb),
         pids_limit=COALESCE($9, cli_agents.pids_limit),
         auto_update=COALESCE($10, cli_agents.auto_update),
         updated_at=NOW()`,
      [name, cliType, opts.project ?? null, image, authVolume, localVolume,
       opts.cpuLimit ?? null, opts.memLimitMb ?? null, opts.pidsLimit ?? null,
       opts.autoUpdate ?? null]
    );
    const row = await this.loadRow(name);
    if (!row) throw new Error(`registerAgent: Row "${name}" nach Insert nicht gefunden`);
    console.error(`[CliAgents] registriert: ${name} (cli_type=${cliType}, image=${image})`);
    return row;
  }

  /** Startet den persistenten CLI-Container (idempotent: laeuft er schon, no-op). */
  async start(name: string): Promise<{ name: string; containerId: string; status: string }> {
    this.assertAvailable();
    return this.withLock(name, () => this._start(name));
  }

  private async _start(name: string): Promise<{ name: string; containerId: string; status: string }> {
    const row = await this.loadRow(name);
    if (!row) throw new Error(`CLI-Agent "${name}" nicht registriert — zuerst POST /api/cli-agents`);
    const spec = this.resolveSpec(row.cliType);
    const pool = getPool();

    if (row.containerId) {
      try {
        const info = await this.docker.getContainer(row.containerId).inspect();
        if (info?.State?.Running) {
          await pool.query(`UPDATE cli_agents SET status='running', updated_at=NOW() WHERE name=$1`, [row.name]);
          return { name: row.name, containerId: row.containerId, status: 'running' };
        }
      } catch {
        /* Container weg — neu starten */
      }
    }

    await pool.query(`UPDATE cli_agents SET status='starting', last_error=NULL, updated_at=NOW() WHERE name=$1`, [row.name]);
    try {
      await this.ensureVolume(row.authVolume ?? `${this.cfg.volumeNamePrefix}-${row.name}-auth`);
      await this.ensureVolume(row.localVolume ?? `${this.cfg.volumeNamePrefix}-${row.name}-local`);
      const containerId = await this.createAndStartContainer(row, spec);
      await pool.query(
        `UPDATE cli_agents SET status='running', container_id=$2, last_started_at=NOW(), last_error=NULL, updated_at=NOW() WHERE name=$1`,
        [row.name, containerId]
      );
      void this.detectVersion(row.name).catch(() => undefined);
      console.error(`[CliAgents] gestartet: ${row.name} (${containerId.slice(0, 12)})`);
      return { name: row.name, containerId, status: 'running' };
    } catch (err) {
      await pool.query(`UPDATE cli_agents SET status='error', last_error=$2, updated_at=NOW() WHERE name=$1`, [row.name, (err as Error).message]);
      throw err;
    }
  }

  /**
   * Aktualisiert den CLI-Agenten: alten Container weg, Image (best effort) pullen,
   * frisch starten — der Image-Entrypoint self-updatet die CLI bei jedem Start.
   * Persistente Volumes bleiben (Auth + Version bleiben erhalten).
   */
  async update(name: string): Promise<{ name: string; status: string; image: string; version: string | null }> {
    this.assertAvailable();
    return this.withLock(name, () => this._update(name));
  }

  private async _update(name: string): Promise<{ name: string; status: string; image: string; version: string | null }> {
    const row = await this.loadRow(name);
    if (!row) throw new Error(`CLI-Agent "${name}" nicht registriert`);
    const spec = this.resolveSpec(row.cliType);
    const pool = getPool();
    await pool.query(`UPDATE cli_agents SET status='updating', last_error=NULL, updated_at=NOW() WHERE name=$1`, [row.name]);
    try {
      await this.removeContainer(row);
      // Lokal gebaute Images existieren evtl. nicht in einer Registry -> pull graceful.
      await this.pullImage(row.image).catch((err) =>
        console.error(`[CliAgents] update ${row.name}: pull uebersprungen (${(err as Error).message})`)
      );
      await this.ensureVolume(row.authVolume ?? `${this.cfg.volumeNamePrefix}-${row.name}-auth`);
      await this.ensureVolume(row.localVolume ?? `${this.cfg.volumeNamePrefix}-${row.name}-local`);
      const containerId = await this.createAndStartContainer(row, spec);
      await pool.query(
        `UPDATE cli_agents SET status='running', container_id=$2, last_started_at=NOW(), last_updated_at=NOW(), last_error=NULL, updated_at=NOW() WHERE name=$1`,
        [row.name, containerId]
      );
      const version = await this.detectVersion(row.name).catch(() => null);
      console.error(`[CliAgents] aktualisiert: ${row.name}`);
      return { name: row.name, status: 'running', image: row.image, version };
    } catch (err) {
      await pool.query(`UPDATE cli_agents SET status='error', last_error=$2, updated_at=NOW() WHERE name=$1`, [row.name, (err as Error).message]);
      throw err;
    }
  }

  /** Stoppt + entfernt den Container. Volumes bleiben (persistent). */
  async stop(name: string, reason = 'manual'): Promise<{ name: string; status: string }> {
    this.assertAvailable();
    return this.withLock(name, () => this._stop(name, reason));
  }

  private async _stop(name: string, reason = 'manual'): Promise<{ name: string; status: string }> {
    const row = await this.loadRow(name);
    if (!row) throw new Error(`CLI-Agent "${name}" nicht registriert`);
    const pool = getPool();
    await pool.query(`UPDATE cli_agents SET status='stopping', updated_at=NOW() WHERE name=$1`, [row.name]);
    await this.removeContainer(row);
    await pool.query(
      `UPDATE cli_agents SET status='stopped', container_id=NULL, last_stopped_at=NOW(), updated_at=NOW() WHERE name=$1`,
      [row.name]
    );
    console.error(`[CliAgents] gestoppt: ${row.name} (${reason}, Volumes bleiben)`);
    return { name: row.name, status: 'stopped' };
  }

  /** Container by-id und by-name entfernen (graceful). */
  private async removeContainer(row: CliAgentInfo): Promise<void> {
    if (row.containerId) {
      try {
        const c = this.docker.getContainer(row.containerId);
        await c.stop({ t: 10 }).catch(() => undefined);
        await c.remove({ force: true }).catch(() => undefined);
      } catch (err) {
        console.error(`[CliAgents] removeContainer ${row.name}: ${(err as Error).message}`);
      }
    }
    try {
      await this.docker.getContainer(`${this.cfg.containerNamePrefix}-${sanitize(row.name)}`).remove({ force: true });
    } catch {
      /* nicht vorhanden — ok */
    }
  }

  private async createAndStartContainer(row: CliAgentInfo, spec: CliTypeSpec): Promise<string> {
    const containerName = `${this.cfg.containerNamePrefix}-${sanitize(row.name)}`;
    // Stale Container gleichen Namens entfernen.
    try {
      await this.docker.getContainer(containerName).remove({ force: true });
    } catch {
      /* nicht vorhanden — gut */
    }
    const authVolume = row.authVolume ?? `${this.cfg.volumeNamePrefix}-${row.name}-auth`;
    const localVolume = row.localVolume ?? `${this.cfg.volumeNamePrefix}-${row.name}-local`;
    const binds = spec.mounts.map((m) => `${m.volumeKey === 'auth' ? authVolume : localVolume}:${m.path}`);
    const labels: Record<string, string> = {
      'synapse.cli-agent': 'true',
      'synapse.cli-type': row.cliType,
      'synapse.cli-name': row.name,
    };
    if (row.project) labels['synapse.project'] = row.project;
    const memBytes = row.memLimitMb * 1024 * 1024;

    const createOpts = {
      name: containerName,
      Image: row.image,
      Labels: labels,
      Tty: false,
      OpenStdin: false,
      Env: [
        `SYNAPSE_CLI_TYPE=${row.cliType}`,
        `SYNAPSE_CLI_NAME=${row.name}`,
        'USE_BUILTIN_RIPGREP=0',
        ...(row.project ? [`SYNAPSE_PROJECT=${row.project}`] : []),
      ],
      HostConfig: {
        NetworkMode: this.cfg.network,
        AutoRemove: false,
        // Persistent: ueberlebt synapse-api/dockerd-Neustart. Stop = explizit.
        RestartPolicy: { Name: 'unless-stopped' },
        Binds: binds,
        NanoCpus: Math.round(row.cpuLimit * 1e9),
        Memory: memBytes,
        MemorySwap: memBytes,
        PidsLimit: row.pidsLimit,
        // KEIN ReadonlyRootfs: die CLI braucht Schreibzugriff (self-update/Caches).
      },
      User: '0',
      // KEIN Cmd-Override -> Image-ENTRYPOINT (persistenter Idle-Loop + self-update) laeuft.
    };

    let create;
    try {
      create = await this.docker.createContainer(createOpts);
    } catch (err) {
      const msg = (err as Error).message || '';
      const status = (err as { statusCode?: number }).statusCode;
      // Image fehlt (lokal gebaut, nicht in Registry): klare, handlungsweisende Meldung.
      if (status === 404 || /no such image/i.test(msg)) {
        throw new Error(
          `Image "${row.image}" nicht vorhanden — zuerst bauen (docker/cli-agents/${row.cliType}/) und als "${row.image}" taggen, oder per update() pullen.`
        );
      }
      // 409 = Name-Kollision (Race trotz vorherigem force-remove): einmal hart wegraeumen + Retry.
      if (status === 409 || /Conflict|already in use/i.test(msg)) {
        try {
          await this.docker.getContainer(containerName).remove({ force: true });
        } catch {
          /* schon weg */
        }
        create = await this.docker.createContainer(createOpts);
      } else {
        throw err;
      }
    }
    await create.start();
    console.error(`[CliAgents] Container erstellt+gestartet: ${containerName} (${create.id.slice(0, 12)})`);
    return create.id;
  }

  private async pullImage(image: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream, (doneErr: Error | null) => (doneErr ? reject(doneErr) : resolve()));
      });
    });
  }

  /** Liest die CLI-Version via exec und schreibt sie in PG. */
  async detectVersion(name: string): Promise<string | null> {
    const row = await this.loadRow(name);
    if (!row) return null;
    const spec = this.resolveSpec(row.cliType);
    try {
      const res = await this.exec(name, spec.versionCmd, { timeoutMs: 15_000 });
      const version = (res.stdout || res.stderr || '').trim().split('\n')[0]?.slice(0, 200) || null;
      if (version) {
        await getPool().query(`UPDATE cli_agents SET version=$2, updated_at=NOW() WHERE name=$1`, [row.name, version]);
      }
      return version;
    } catch {
      return null;
    }
  }

  /**
   * docker exec im laufenden CLI-Container (Demux + harter Timeout). Fuer
   * Version-Detection, Auth-Setup (DIND-3) und das Wrapper-Driving (DIND-5).
   */
  async exec(
    name: string,
    command: string,
    opts: { timeoutMs?: number; workingDir?: string; user?: string } = {}
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; durationMs: number }> {
    this.assertAvailable();
    const row = await this.loadRow(name);
    if (!row) throw new Error(`CLI-Agent "${name}" nicht registriert`);
    if (!row.containerId) throw new Error(`CLI-Agent "${name}" laeuft nicht (Status ${row.status}) — zuerst start`);
    const spec = this.resolveSpec(row.cliType);
    const container = this.docker.getContainer(row.containerId);
    const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? 60_000, 600_000));
    const started = Date.now();

    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      User: opts.user ?? '0',
      WorkingDir: opts.workingDir ?? spec.workdir,
      Env: [`SYNAPSE_CLI_NAME=${row.name}`],
    });
    const stream = await exec.start({ hijack: true, stdin: false });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutPass = new PassThrough();
    const stderrPass = new PassThrough();
    stdoutPass.on('data', (c: Buffer) => stdoutChunks.push(c));
    stderrPass.on('data', (c: Buffer) => stderrChunks.push(c));
    this.docker.modem.demuxStream(stream, stdoutPass, stderrPass);

    let timedOut = false;
    let timeoutMsg = '';
    const streamDone = new Promise<void>((resolve, reject) => {
      stream.on('end', () => resolve());
      stream.on('error', (err: Error) => reject(err));
    });
    let timeoutHandle: NodeJS.Timeout | null = null;
    const timeout = new Promise<void>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        reject(new Error(`exec timeout > ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      await Promise.race([streamDone, timeout]);
    } catch (err) {
      (stream as unknown as { destroy?: () => void }).destroy?.();
      timeoutMsg = `\n[cli-orchestrator] ${(err as Error).message}`;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8') + timeoutMsg;
    let exitCode: number | null = null;
    try {
      const info = await exec.inspect();
      exitCode = info.ExitCode ?? null;
    } catch {
      /* ignore */
    }
    return { stdout, stderr, exitCode, timedOut, durationMs: Date.now() - started };
  }

  /** Aendert PG-Konfig (greift beim naechsten Start/Update). */
  async configure(
    name: string,
    opts: { cpuLimit?: number; memLimitMb?: number; pidsLimit?: number; image?: string; autoUpdate?: boolean }
  ): Promise<{ applied: Record<string, unknown>; requiresRestart: boolean }> {
    const row = await this.loadRow(name);
    if (!row) throw new Error(`CLI-Agent "${name}" nicht registriert`);
    const pool = getPool();
    const sets: string[] = [];
    const vals: unknown[] = [row.name];
    const applied: Record<string, unknown> = {};
    const push = (col: string, v: unknown): void => {
      vals.push(v);
      sets.push(`${col}=$${vals.length}`);
      applied[col] = v;
    };
    if (opts.cpuLimit !== undefined && Number.isFinite(opts.cpuLimit) && opts.cpuLimit > 0 && opts.cpuLimit <= 32) push('cpu_limit', opts.cpuLimit);
    if (opts.memLimitMb !== undefined && Number.isInteger(opts.memLimitMb) && opts.memLimitMb >= 256) push('mem_limit_mb', opts.memLimitMb);
    if (opts.pidsLimit !== undefined && Number.isInteger(opts.pidsLimit) && opts.pidsLimit >= 16) push('pids_limit', opts.pidsLimit);
    if (opts.image !== undefined && /^[a-zA-Z0-9._/:@-]+$/.test(opts.image)) push('image', opts.image);
    if (opts.autoUpdate !== undefined) push('auto_update', !!opts.autoUpdate);
    if (sets.length === 0) {
      throw new Error('configure: keine gueltigen Felder (cpu_limit 0-32, mem_limit_mb>=256, pids_limit>=16, image, auto_update)');
    }
    await pool.query(`UPDATE cli_agents SET ${sets.join(', ')}, updated_at=NOW() WHERE name=$1`, vals);
    return { applied, requiresRestart: row.status === 'running' };
  }

  /** Entfernt den Agenten komplett (Container weg, PG-Row weg, Volumes optional). */
  async removeAgent(name: string, opts: { removeVolumes?: boolean } = {}): Promise<{ name: string; removed: boolean; volumesRemoved: string[] }> {
    return this.withLock(name, () => this._removeAgent(name, opts));
  }

  private async _removeAgent(name: string, opts: { removeVolumes?: boolean } = {}): Promise<{ name: string; removed: boolean; volumesRemoved: string[] }> {
    const row = await this.loadRow(name);
    if (!row) return { name: sanitize(name), removed: false, volumesRemoved: [] };
    if (this.dockerAvailable) {
      await this.removeContainer(row);
    }
    const volumesRemoved: string[] = [];
    if (opts.removeVolumes && this.dockerAvailable) {
      for (const v of [row.authVolume, row.localVolume]) {
        if (!v) continue;
        try {
          await this.docker.getVolume(v).remove({ force: true });
          volumesRemoved.push(v);
        } catch {
          /* schon weg / in Benutzung */
        }
      }
    }
    await getPool().query(`DELETE FROM cli_agents WHERE name=$1`, [row.name]);
    console.error(`[CliAgents] entfernt: ${row.name} (volumesRemoved=${volumesRemoved.length})`);
    return { name: row.name, removed: true, volumesRemoved };
  }

  /** Liste aller CLI-Agenten (PG) + best-effort Live-Docker-Status. */
  async listAgents(): Promise<CliAgentInfo[]> {
    const pool = getPool();
    const r = await pool.query(
      `SELECT ${SELECT_COLS} FROM cli_agents ORDER BY (status='running') DESC, cli_type, name`
    );
    const infos = r.rows.map((row) => rowToInfo(row as Record<string, unknown>));
    if (this.dockerAvailable) {
      for (const info of infos) {
        if (info.containerId) {
          try {
            const di = await this.docker.getContainer(info.containerId).inspect();
            info.dockerRunning = di?.State?.Running === true;
          } catch {
            info.dockerRunning = false;
          }
        } else {
          info.dockerRunning = false;
        }
      }
    }
    return infos;
  }

  /** Persistent: keine Timer/Listener. Container laufen weiter (RestartPolicy). */
  shutdown(): void {
    /* nichts abzureissen */
  }
}

let _instance: CliAgentOrchestrator | null = null;

/** Initialisiert den CLI-Agent-Orchestrator (idempotent). Returns true wenn Docker erreichbar. */
export async function initCliAgentOrchestrator(cfg?: CliAgentConfig): Promise<boolean> {
  if (_instance) return _instance.isAvailable();
  _instance = new CliAgentOrchestrator(cfg);
  return await _instance.init();
}

/** Zugriff auf die Singleton-Instanz. Null wenn nicht initialisiert (DinD aus). */
export function getCliAgentOrchestrator(): CliAgentOrchestrator | null {
  return _instance;
}

/** Sauberes Abreissen (fuer SIGTERM-Handler). */
export function shutdownCliAgentOrchestrator(): void {
  if (_instance) {
    _instance.shutdown();
    _instance = null;
  }
}
