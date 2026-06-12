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

  /** POST /api/projects/:name/workspace/start — Container starten (lazy ensure). */
  fastify.post<{ Params: { name: string } }>(
    '/api/projects/:name/workspace/start',
    async (request, reply) => {
      const orch = ensureAvailable(reply);
      if (!orch) return;
      try {
        const containerId = await orch.ensureProjectRunning(request.params.name);
        return { success: true, project: request.params.name, container_id: containerId };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { message: String(err) } });
      }
    }
  );

  /** POST /api/projects/:name/workspace/stop — Container stoppen (Volume bleibt). */
  fastify.post<{ Params: { name: string } }>(
    '/api/projects/:name/workspace/stop',
    async (request, reply) => {
      const orch = ensureAvailable(reply);
      if (!orch) return;
      try {
        await orch.stopProject(request.params.name, 'api-manual');
        return { success: true, project: request.params.name, stopped: true };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { message: String(err) } });
      }
    }
  );

  /** POST /api/projects/:name/workspace/pin — Body: { pinned: boolean }. */
  fastify.post<{ Params: { name: string }; Body: { pinned?: boolean } }>(
    '/api/projects/:name/workspace/pin',
    async (request, reply) => {
      const orch = ensureAvailable(reply);
      if (!orch) return;
      const pinned = request.body?.pinned ?? true;
      try {
        await orch.pin(request.params.name, pinned);
        return { success: true, project: request.params.name, pinned };
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
  }>('/api/projects/:name/workspace/reset-home', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    try {
      const result = await orch.resetHome(request.params.name);
      return { success: true, project: request.params.name, ...result };
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
    Body: { cpuLimit?: number; memLimitMb?: number; pidsLimit?: number; tmpfsMb?: number; image?: string };
  }>('/api/projects/:name/workspace/config', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    try {
      const r = await orch.configure(request.params.name, request.body ?? {});
      return { success: true, project: request.params.name, ...r };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /**
   * POST /api/projects/:name/workspace/exec
   * Body: { command: string; timeoutMs?: number; workingDir?: string }
   * Synchron: wartet bis Kommando fertig oder timeout. Liefert stdout/stderr/exitCode.
   */
  fastify.post<{
    Params: { name: string };
    Body: { command?: string; timeoutMs?: number; workingDir?: string };
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
    try {
      const result = await orch.exec(request.params.name, command, {
        timeoutMs: request.body.timeoutMs,
        workingDir: request.body.workingDir,
      });
      return { success: true, project: request.params.name, ...result };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });
}
