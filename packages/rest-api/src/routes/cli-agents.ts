/**
 * Synapse API — CLI-Agent-Routen (PLAN-004 / DIND-5-prep)
 * Persistente CLI-Agenten-Container (claude/codex/antigravity) verwalten.
 * Gegenstueck zu workspaces.ts, aber persistent: Lifecycle NUR explizit
 * (start/update/stop). Feature-gated: ist SYNAPSE_DIND_ENABLED nicht gesetzt,
 * existiert der Orchestrator nicht und alle Aktionen liefern 503.
 */

import { FastifyInstance } from 'fastify';
import { getCliAgentOrchestrator } from '../services/cli-agent-orchestrator.js';

function ensureAvailable(reply: import('fastify').FastifyReply): ReturnType<typeof getCliAgentOrchestrator> {
  const orch = getCliAgentOrchestrator();
  if (!orch || !orch.isAvailable()) {
    reply.status(503).send({
      success: false,
      error: { message: 'CLI-Agent-Orchestrator nicht verfuegbar (SYNAPSE_DIND_ENABLED!=1 oder Docker-Socket fehlt)' },
    });
    return null;
  }
  return orch;
}

export async function cliAgentRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/cli-agents — Liste aller CLI-Agenten (PG = Source of Truth).
   *  Liest nur aus PG; braucht KEIN Docker. 503 bleibt den Docker-Aktionen vorbehalten. */
  fastify.get('/api/cli-agents', async (_request, reply) => {
    const orch = getCliAgentOrchestrator();
    if (!orch) {
      return reply.status(503).send({
        success: false,
        error: { message: 'CLI-Agent-Orchestrator nicht initialisiert (SYNAPSE_DIND_ENABLED!=1)' },
      });
    }
    try {
      const agents = await orch.listAgents();
      return {
        success: true,
        agents,
        count: agents.length,
        docker_available: orch.isAvailable(),
        cli_types: orch.listCliTypes(),
      };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /** POST /api/cli-agents — CLI-Agent registrieren/aktualisieren (startet nichts).
   *  Body: { cliType: string; name?: string; project?: string; image?: string;
   *          cpuLimit?: number; memLimitMb?: number; pidsLimit?: number; autoUpdate?: boolean } */
  fastify.post<{
    Body: {
      cliType?: string;
      name?: string;
      project?: string | null;
      image?: string;
      cpuLimit?: number;
      memLimitMb?: number;
      pidsLimit?: number;
      autoUpdate?: boolean;
    };
  }>('/api/cli-agents', async (request, reply) => {
    const orch = getCliAgentOrchestrator();
    if (!orch) {
      return reply.status(503).send({ success: false, error: { message: 'CLI-Agent-Orchestrator nicht initialisiert' } });
    }
    const cliType = request.body?.cliType;
    if (!cliType || typeof cliType !== 'string') {
      return reply.status(400).send({ success: false, error: { message: 'cliType (string) ist erforderlich im Body' } });
    }
    try {
      const agent = await orch.registerAgent({
        cliType,
        name: request.body?.name,
        project: request.body?.project ?? null,
        image: request.body?.image,
        cpuLimit: request.body?.cpuLimit,
        memLimitMb: request.body?.memLimitMb,
        pidsLimit: request.body?.pidsLimit,
        autoUpdate: request.body?.autoUpdate,
      });
      return { success: true, agent };
    } catch (err) {
      return reply.status(400).send({ success: false, error: { message: String(err) } });
    }
  });

  /** POST /api/cli-agents/:name/start — persistenten CLI-Container starten. */
  fastify.post<{ Params: { name: string } }>('/api/cli-agents/:name/start', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    try {
      const r = await orch.start(request.params.name);
      return { success: true, ...r };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /** POST /api/cli-agents/:name/update — Image (best effort) pullen + Container neu (CLI self-updatet). */
  fastify.post<{ Params: { name: string } }>('/api/cli-agents/:name/update', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    try {
      const r = await orch.update(request.params.name);
      return { success: true, ...r };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /** POST /api/cli-agents/:name/stop — Container stoppen+entfernen (Volumes bleiben). */
  fastify.post<{ Params: { name: string } }>('/api/cli-agents/:name/stop', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    try {
      const r = await orch.stop(request.params.name, 'api-manual');
      return { success: true, ...r };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /** POST /api/cli-agents/:name/exec — Kommando im CLI-Container (Version/Auth-Setup/Driving).
   *  Body: { command: string; timeoutMs?: number; workingDir?: string } */
  fastify.post<{
    Params: { name: string };
    Body: { command?: string; timeoutMs?: number; workingDir?: string };
  }>('/api/cli-agents/:name/exec', async (request, reply) => {
    const orch = ensureAvailable(reply);
    if (!orch) return;
    const command = request.body?.command;
    if (!command || typeof command !== 'string') {
      return reply.status(400).send({ success: false, error: { message: 'command (string) ist erforderlich im Body' } });
    }
    try {
      const result = await orch.exec(request.params.name, command, {
        timeoutMs: request.body?.timeoutMs,
        workingDir: request.body?.workingDir,
      });
      return { success: true, name: request.params.name, ...result };
    } catch (err) {
      return reply.status(500).send({ success: false, error: { message: String(err) } });
    }
  });

  /** PATCH /api/cli-agents/:name/config — cpu/mem/pids/image/autoUpdate (greift beim naechsten Start). */
  fastify.patch<{
    Params: { name: string };
    Body: { cpuLimit?: number; memLimitMb?: number; pidsLimit?: number; image?: string; autoUpdate?: boolean };
  }>('/api/cli-agents/:name/config', async (request, reply) => {
    const orch = getCliAgentOrchestrator();
    if (!orch) {
      return reply.status(503).send({ success: false, error: { message: 'CLI-Agent-Orchestrator nicht initialisiert' } });
    }
    try {
      const r = await orch.configure(request.params.name, request.body ?? {});
      return { success: true, name: request.params.name, ...r };
    } catch (err) {
      return reply.status(400).send({ success: false, error: { message: String(err) } });
    }
  });

  /** DELETE /api/cli-agents/:name — Agent entfernen (Container weg, PG-Row weg).
   *  Querystring: ?removeVolumes=true loescht auch die persistenten Auth-Volumes. */
  fastify.delete<{ Params: { name: string }; Querystring: { removeVolumes?: string } }>(
    '/api/cli-agents/:name',
    async (request, reply) => {
      const orch = getCliAgentOrchestrator();
      if (!orch) {
        return reply.status(503).send({ success: false, error: { message: 'CLI-Agent-Orchestrator nicht initialisiert' } });
      }
      try {
        const removeVolumes = request.query?.removeVolumes === 'true';
        const r = await orch.removeAgent(request.params.name, { removeVolumes });
        return { success: true, ...r };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { message: String(err) } });
      }
    }
  );
}
