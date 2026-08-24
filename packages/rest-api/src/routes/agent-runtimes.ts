import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { validateToken, type TokenKind } from '../services/auth.js';
import { getAgentRuntimeManager, shutdownAgentRuntimeManager } from '../services/agent-runtime/manager.js';
import type { RuntimeName, RuntimeStreamEvent } from '../services/agent-runtime/types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendError(reply: FastifyReply, error: unknown, status = 500): FastifyReply {
  return reply.status(status).send({ success: false, error: { message: errorMessage(error) } });
}

function sse(reply: FastifyReply, event: string, data: Record<string, unknown>): void {
  reply.raw.write('event: ' + event + '\n');
  reply.raw.write('data: ' + JSON.stringify(data) + '\n\n');
}

export function runtimeTokenAllowed(kind: TokenKind): boolean {
  return kind === 'access' || kind === 'session';
}

function requestToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === 'string'
    ? /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1]?.trim()
    : null;
  if (bearer) return bearer;
  const query = request.query as Record<string, unknown> | undefined;
  if (typeof query?.sse_token === 'string') return query.sse_token;
  const cookie = request.headers.cookie;
  if (typeof cookie !== 'string') return null;
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === 'synapse_session') return decodeURIComponent(value.join('='));
  }
  return null;
}

async function guardInteractiveRuntimeRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const pathname = request.url.split('?')[0];
  if (!pathname.startsWith('/api/agent-runtimes') && !pathname.startsWith('/api/main-agent')) return;
  if (process.env.SYNAPSE_AUTH_DISABLED === '1') return;
  const token = requestToken(request);
  const principal = token ? await validateToken(token) : null;
  if (!principal) {
    await reply.code(401).send({ success: false, error: { code: 'unauthorized', message: 'Interaktive Benutzer-Session erforderlich' } });
    return;
  }
  if (!runtimeTokenAllowed(principal.kind)) {
    await reply.code(403).send({ success: false, error: { code: 'service_token_forbidden', message: 'Service-/Daemon-/Wrapper-Tokens duerfen Agent-Runtimes nicht bedienen' } });
  }
}

export async function agentRuntimeRoutes(fastify: FastifyInstance): Promise<void> {
  const manager = getAgentRuntimeManager();

  fastify.addHook('onRequest', guardInteractiveRuntimeRequest);
  fastify.addHook('onClose', async () => shutdownAgentRuntimeManager());

  fastify.get('/api/agent-runtimes', async (_request, reply) => {
    try {
      return {
        success: true,
        drivers: manager.listDrivers(),
        instances: await manager.listStatuses(),
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<{ Params: { runtime: string } }>('/api/agent-runtimes/:runtime/status', async (request, reply) => {
    try {
      return { success: true, status: await manager.driver(request.params.runtime).status() };
    } catch (error) {
      return sendError(reply, error, 400);
    }
  });

  fastify.put<{
    Params: { runtime: string };
    Body: { rootPath?: string; image?: string; model?: string };
  }>('/api/agent-runtimes/:runtime/config', async (request, reply) => {
    if (!request.body?.rootPath || typeof request.body.rootPath !== 'string') {
      return sendError(reply, new Error('rootPath ist erforderlich'), 400);
    }
    try {
      const status = await manager.driver(request.params.runtime).configure({
        rootPath: request.body.rootPath,
        image: request.body.image,
        model: request.body.model,
      });
      return { success: true, status };
    } catch (error) {
      return sendError(reply, error, 400);
    }
  });

  for (const action of ['setup', 'start', 'stop'] as const) {
    fastify.post<{ Params: { runtime: string } }>('/api/agent-runtimes/:runtime/' + action, async (request, reply) => {
      try {
        const driver = manager.driver(request.params.runtime);
        const status = action === 'setup'
          ? await driver.setup()
          : action === 'start'
            ? await driver.start()
            : await driver.stop();
        return { success: true, status };
      } catch (error) {
        return sendError(reply, error);
      }
    });
  }

  fastify.post<{
    Params: { runtime: string };
    Body: { cols?: number; rows?: number; command?: string };
  }>('/api/agent-runtimes/:runtime/terminal/sessions', async (request, reply) => {
    try {
      const session = await manager.driver(request.params.runtime).openTerminal(request.body ?? {});
      manager.terminals.add(session);
      return { success: true, sessionId: session.id };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.get<{
    Params: { runtime: string; sessionId: string };
  }>('/api/agent-runtimes/:runtime/terminal/sessions/:sessionId/events', async (request, reply) => {
    try {
      manager.driver(request.params.runtime);
      manager.terminals.assertRuntime(request.params.sessionId, request.params.runtime);
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const subscription = manager.terminals.subscribe(request.params.sessionId, (item) => {
        sse(reply, item.event, item.data);
      });
      for (const item of subscription.replay) sse(reply, item.event, item.data);
      const heartbeat = setInterval(() => reply.raw.write(': heartbeat\n\n'), 15_000);
      const cleanup = (): void => {
        clearInterval(heartbeat);
        subscription.unsubscribe();
      };
      reply.raw.once('close', cleanup);
      reply.raw.once('error', cleanup);
    } catch (error) {
      if (!reply.sent) return sendError(reply, error, 404);
    }
  });

  fastify.post<{
    Params: { runtime: string; sessionId: string };
    Body: { data?: string };
  }>('/api/agent-runtimes/:runtime/terminal/sessions/:sessionId/input', async (request, reply) => {
    if (typeof request.body?.data !== 'string') return sendError(reply, new Error('data ist erforderlich'), 400);
    try {
      manager.driver(request.params.runtime);
      manager.terminals.assertRuntime(request.params.sessionId, request.params.runtime);
      manager.terminals.write(request.params.sessionId, request.body.data);
      return { success: true };
    } catch (error) {
      return sendError(reply, error, 404);
    }
  });

  fastify.post<{
    Params: { runtime: string; sessionId: string };
    Body: { cols?: number; rows?: number };
  }>('/api/agent-runtimes/:runtime/terminal/sessions/:sessionId/resize', async (request, reply) => {
    const cols = Number(request.body?.cols);
    const rows = Number(request.body?.rows);
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 8) {
      return sendError(reply, new Error('cols >= 20 und rows >= 8 sind erforderlich'), 400);
    }
    try {
      manager.driver(request.params.runtime);
      manager.terminals.assertRuntime(request.params.sessionId, request.params.runtime);
      await manager.terminals.resize(request.params.sessionId, cols, rows);
      return { success: true };
    } catch (error) {
      return sendError(reply, error, 404);
    }
  });

  fastify.delete<{
    Params: { runtime: string; sessionId: string };
  }>('/api/agent-runtimes/:runtime/terminal/sessions/:sessionId', async (request, reply) => {
    try {
      manager.driver(request.params.runtime);
      manager.terminals.assertRuntime(request.params.sessionId, request.params.runtime);
      return { success: true, closed: manager.terminals.close(request.params.sessionId) };
    } catch (error) {
      return sendError(reply, error, 404);
    }
  });

  fastify.get('/api/main-agent/runtime', async (_request, reply) => {
    try {
      return { success: true, ...(await manager.mainAssignment()) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  fastify.put<{
    Body: { runtime?: RuntimeName | null };
  }>('/api/main-agent/runtime', async (request, reply) => {
    const runtime = request.body?.runtime ?? null;
    if (runtime !== null && runtime !== 'codex' && runtime !== 'claude' && runtime !== 'free-pool') {
      return sendError(reply, new Error('Unbekannte Runtime'), 400);
    }
    try {
      return { success: true, ...(await manager.assignMain(runtime)) };
    } catch (error) {
      return sendError(reply, error, 400);
    }
  });

  fastify.post<{
    Body: { runtime?: RuntimeName };
  }>('/api/main-agent/sessions', async (request, reply) => {
    try {
      const session = await manager.createMainSession(request.body?.runtime);
      return { success: true, session };
    } catch (error) {
      return sendError(reply, error, 400);
    }
  });

  fastify.post<{
    Params: { sessionId: string };
    Body: { message?: string };
  }>('/api/main-agent/sessions/:sessionId/messages', async (request, reply) => {
    if (typeof request.body?.message !== 'string' || !request.body.message.trim()) {
      return sendError(reply, new Error('message ist erforderlich'), 400);
    }
    let session;
    try {
      session = await manager.getMainSession(request.params.sessionId);
      manager.driver(session.runtime);
      await manager.assertMainRuntimeReady(session.runtime);
      await manager.markSessionRunning(session.id);
    } catch (error) {
      return sendError(reply, error, 404);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    sse(reply, 'ready', { sessionId: session.id, runtime: session.runtime });

    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    reply.raw.once('close', onClose);
    try {
      const result = await manager.driver(session.runtime).sendMessage(
        session,
        request.body.message,
        (item: RuntimeStreamEvent) => sse(reply, item.event, item.data),
        controller.signal,
      );
      await manager.completeSession(session.id, result.runtimeSessionId, result.context);
      if (!controller.signal.aborted) {
        sse(reply, 'done', {
          sessionId: session.id,
          runtimeSessionId: result.runtimeSessionId,
          context: result.context,
        });
        reply.raw.end();
      }
    } catch (error) {
      await manager.failSession(session.id, error instanceof Error ? error : new Error(String(error))).catch(() => undefined);
      if (!controller.signal.aborted) {
        sse(reply, 'error', { message: errorMessage(error) });
        reply.raw.end();
      }
    } finally {
      reply.raw.off('close', onClose);
    }
  });
}
