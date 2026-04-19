/**
 * Synapse API - Shell-Endpoint
 *
 * Gegenstueck zum mcp__synapse__shell-Tool. Verwendet dieselbe
 * Core-Funktion (execShellInProject), damit Logik + Active-Gate
 * identisch sind.
 *
 * HTTP-Status-Mapping:
 *   - unknown_project       → 404
 *   - project_inactive      → 423 Locked
 *   - cwd_outside_project   → 400
 *   - unknown_stream        → 404
 *   - sonst                 → 200
 */

import { FastifyInstance } from 'fastify';
import { execShellInProject, getShellStream } from '@synapse/core';

interface ShellBody {
  action?: 'exec' | 'get_stream';
  project?: string;
  command?: string;
  stream_id?: string;
  timeout_ms?: number;
  tail_lines?: number;
  cwd_relative?: string;
  since_last_read?: boolean;
}

function statusFor(result: Record<string, unknown>): number {
  const err = result.error;
  if (err === 'unknown_project' || err === 'unknown_stream') return 404;
  if (err === 'project_inactive') return 423;
  if (err === 'cwd_outside_project') return 400;
  return 200;
}

export async function shellRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: ShellBody }>('/api/shell', async (request, reply) => {
    const body = request.body ?? {};
    const action = body.action ?? 'exec';

    try {
      if (action === 'get_stream') {
        if (!body.stream_id) {
          return reply.status(400).send({ error: 'missing_field', message: 'stream_id erforderlich' });
        }
        const result = getShellStream({
          stream_id: body.stream_id,
          tail_lines: body.tail_lines,
          since_last_read: body.since_last_read,
        });
        return reply.status(statusFor(result)).send(result);
      }

      if (action === 'exec') {
        if (!body.project || !body.command) {
          return reply.status(400).send({
            error: 'missing_field',
            message: 'project und command sind erforderlich',
          });
        }
        const result = await execShellInProject({
          project: body.project,
          command: body.command,
          cwd_relative: body.cwd_relative,
          timeout_ms: body.timeout_ms,
          tail_lines: body.tail_lines,
        });
        return reply.status(statusFor(result)).send(result);
      }

      return reply.status(400).send({ error: 'unknown_action', message: `action: ${action}` });
    } catch (err) {
      fastify.log.error({ err, body }, '/api/shell failed');
      return reply.status(500).send({ error: 'internal', message: (err as Error).message });
    }
  });
}
