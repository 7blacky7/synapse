/**
 * Synapse API — Workspace-Routen
 * Pro-Projekt Docker-Container (synapse-workspace) verwalten + Shell-Exec.
 */

import { FastifyInstance } from 'fastify';
import { getWorkspaceOrchestrator } from '../services/workspace-orchestrator.js';

function ensureAvailable(reply: import('fastify').FastifyReply): ReturnType<typeof getWorkspaceOrchestrator> {
  const orch = getWorkspaceOrchestrator();
  if (!orch || !orch.isAvailable()) {
    reply.status(503).send({
      success: false,
      error: { message: 'Workspace-Orchestrator nicht verfuegbar (Docker-Socket fehlt oder deaktiviert)' },
    });
    return null;
  }
  return orch;
}

export async function workspaceRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/workspaces — Liste aller bekannten Workspaces mit Status.
   *  Liest nur aus PG (project_workspaces = Source of Truth) — braucht KEIN Docker.
   *  503 bleibt den Aktionen (start/stop/exec) vorbehalten, die wirklich Docker brauchen. */
  fastify.get('/api/workspaces', async (_request, reply) => {
    const orch = getWorkspaceOrchestrator();
    if (!orch) {
      return reply.status(503).send({
        success: false,
        error: { message: 'Workspace-Orchestrator nicht initialisiert' },
      });
    }
    try {
      const workspaces = await orch.listWorkspaces();
      return { success: true, workspaces, count: workspaces.length, docker_available: orch.isAvailable() };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /** POST /api/projects/:name/workspace/start — Container starten (lazy ensure).
   *  Body: { workspace?: string } — WS3: benannter Workspace (Default 'main'). */
  fastify.post<{ Params: { name: string }; Body: { workspace?: string; role?: string } }>(
    '/api/projects/:name/workspace/start',
    async (request, reply) => {
      const orch = ensureAvailable(reply);
      if (!orch) return;
      const ws = request.body?.workspace ?? 'main';
      try {
        const containerId = await orch.ensureProjectRunning(request.params.name, ws, request.body?.role);
        return { success: true, project: request.params.name, workspace: ws, container_id: containerId };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { message: String(err) } });
      }
    }
  );

  /** POST /api/projects/:name/workspace/stop — Container stoppen (Volume bleibt). */
  fastify.post<{ Params: { name: string }; Body: { workspace?: string } }>(
    '/api/projects/:name/workspace/stop',
    async (request, reply) => {
      const orch = ensureAvailable(reply);
      if (!orch) return;
      const ws = request.body?.workspace ?? 'main';
      try {
        await orch.stopProject(request.params.name, 'api-manual', ws);
        return { success: true, project: request.params.name, workspace: ws, stopped: true };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { message: String(err) } });
      }
    }
  );

  /** POST /api/projects/:name/workspace/pin — Body: { pinned?: boolean; workspace?: string }. */
  fastify.post<{ Params: { name: string }; Body: { pinned?: boolean; workspace?: string } }>(
    '/api/projects/:name/workspace/pin',
    async (request, reply) => {
      const orch = ensureAvailable(reply);
      if (!orch) return;
      const pinned = request.body?.pinned ?? true;
      const ws = request.body?.workspace ?? 'main';
      try {
        await orch.pin(request.params.name, pinned, ws);
        return { success: true, project: request.params.name, workspace: ws, pinned };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { message: String(err) } });
      }
    }
  );

  /**
   * POST /api/projects/:name/workspace/materialize
   * PG.code_files → Container-FS /workspace. Body: { ignorePatterns?: string[] }
   */
  fastify.post<{
    Params: { name: string };
    Body: { ignorePatterns?: string[] };
  }>('/api/projects/:name/workspace/materialize', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    try {
      const result = await orch.materialize(request.params.name, { ignorePatterns: request.body?.ignorePatterns });
      return { success: true, project: request.params.name, ...result };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /**
   * POST /api/projects/:name/workspace/reset-home
   * WS2-A2: HOME-Volume (/home/synapse) zuruecksetzen — Selbstheilung wenn
   * sich npm/pip/cargo/rustup-Caches oder Configs im Home zerschossen haben.
   * Stoppt den Container, entfernt das Home-Volume; naechster Start = frisch.
   */
  fastify.post<{
    Params: { name: string };
    Body: { workspace?: string };
  }>('/api/projects/:name/workspace/reset-home', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    const ws = request.body?.workspace ?? 'main';
    try {
      const result = await orch.resetHome(request.params.name, ws);
      return { success: true, project: request.params.name, workspace: ws, ...result };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /**
   * POST /api/projects/:name/workspace/commit
   * Container-FS /workspace → PG.code_files (mit Hash-Diff, parsed_at=NULL bei Aenderung).
   * Body: { ignorePatterns?: string[] }
   */
  fastify.post<{
    Params: { name: string };
    Body: { ignorePatterns?: string[] };
  }>('/api/projects/:name/workspace/commit', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    try {
      const result = await orch.commit(request.params.name, { ignorePatterns: request.body?.ignorePatterns });
      return { success: true, project: request.params.name, ...result };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /**
   * PATCH /api/projects/:name/workspace/config
   * Setzt cpu_limit/mem_limit_mb/pids_limit/tmpfs_mb/image (PG-Row) —
   * greift beim naechsten Container-Start.
   */
  fastify.patch<{
    Params: { name: string };
    Body: { cpuLimit?: number; memLimitMb?: number; pidsLimit?: number; tmpfsMb?: number; image?: string; workspace?: string };
  }>('/api/projects/:name/workspace/config', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    const ws = request.body?.workspace ?? 'main';
    try {
      const r = await orch.configure(request.params.name, request.body ?? {}, ws);
      return { success: true, project: request.params.name, workspace: ws, ...r };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /**
   * POST /api/projects/:name/workspace/exec
   * Body: { command: string; timeoutMs?: number; workingDir?: string;
   *         workspace?: string; exposePorts?: number[] }
   * Synchron: wartet bis Kommando fertig oder timeout. Liefert stdout/stderr/exitCode.
   * WS3: workspace waehlt den benannten Container (Default 'main').
   */
  fastify.post<{
    Params: { name: string };
    Body: { command?: string; timeoutMs?: number; workingDir?: string; workspace?: string; role?: string; exposePorts?: number[] };
  }>('/api/projects/:name/workspace/exec', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    const command = request.body?.command;
    if (!command || typeof command !== 'string') {
      return reply.status(400).send({
        success: false,
        error: { message: 'command (string) ist erforderlich im Body' },
      });
    }
    const ws = request.body?.workspace ?? 'main';
    try {
      const result = await orch.exec(request.params.name, command, {
        timeoutMs: request.body.timeoutMs,
        workingDir: request.body.workingDir,
        workspace: ws,
        role: request.body.role,
        exposePorts: Array.isArray(request.body.exposePorts)
          ? request.body.exposePorts.map(Number).filter(Number.isFinite)
          : undefined,
      });
      return { success: true, project: request.params.name, workspace: ws, ...result };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /**
   * WS4: Workspace-Rollen — Rolle = Template, Workspace = Instanz.
   * Rollen sind NIE fest (editierbar, global oder projekt-scoped) und beliebig
   * oft instanziierbar (start/exec mit role + frei waehlbarem name — db-1, db-2,
   * app, qa, ...). Reine PG-Operationen, brauchen kein Docker.
   */
  fastify.get<{ Querystring: { project?: string } }>('/api/workspace-roles', async (request, reply) => {
    const orch = getWorkspaceOrchestrator();
    if (!orch) return reply.status(503).send({ success: false, error: { message: 'Workspace-Orchestrator nicht initialisiert' } });
    try {
      const roles = await orch.roleList(request.query?.project);
      return { success: true, roles, count: roles.length };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  fastify.post<{ Body: { project?: string | null; role?: string; image?: string; cpuLimit?: number; memLimitMb?: number; pidsLimit?: number; tmpfsMb?: number; initCommand?: string; description?: string; devices?: string[]; securityOpts?: string[] } }>('/api/workspace-roles', async (request, reply) => {
    const orch = getWorkspaceOrchestrator();
    if (!orch) return reply.status(503).send({ success: false, error: { message: 'Workspace-Orchestrator nicht initialisiert' } });
    if (!request.body?.role) {
      return reply.status(400).send({ success: false, error: { message: 'role (string) ist erforderlich im Body' } });
    }
    try {
      const role = await orch.roleSet({ ...request.body, role: request.body.role });
      return { success: true, role };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  fastify.delete<{ Params: { role: string }; Querystring: { project?: string } }>('/api/workspace-roles/:role', async (request, reply) => {
    const orch = getWorkspaceOrchestrator();
    if (!orch) return reply.status(503).send({ success: false, error: { message: 'Workspace-Orchestrator nicht initialisiert' } });
    try {
      const deleted = await orch.roleDelete(request.params.role, request.query?.project ?? null);
      return { success: true, deleted };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });
}
