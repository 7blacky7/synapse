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
  /** GET /api/workspaces — Liste aller bekannten Workspaces mit Status. */
  fastify.get('/api/workspaces', async (_request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    try {
      const workspaces = await orch.listWorkspaces();
      return { success: true, workspaces, count: workspaces.length };
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
