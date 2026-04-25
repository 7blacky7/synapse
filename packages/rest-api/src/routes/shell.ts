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
import {
  enqueueShellJob,
  waitForShellJob,
  getShellJobs,
  getShellJobById,
  getShellJobLogLines,
  searchShellJobLog,
} from '@synapse/core';

interface ShellBody {
  action?: 'exec' | 'get_stream' | 'history' | 'get' | 'log';
  project?: string;
  command?: string;
  stream_id?: string;
  id?: string;
  limit?: number;
  offset?: number;
  status?: 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout';
  from_line?: number;
  to_line?: number;
  query?: string;
  regex?: boolean;
  case_sensitive?: boolean;
  max_matches?: number;
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
        return reply.status(501).send({
          success: false,
          error: 'get_stream via REST-API noch nicht implementiert',
        });
      }

      if (action === 'history') {
        const jobs = await getShellJobs({
          project: body.project,
          limit: body.limit,
          offset: body.offset,
          status: body.status,
        });
        return reply.status(200).send({ success: true, count: jobs.length, jobs });
      }

      if (action === 'get') {
        if (!body.id) {
          return reply.status(400).send({ success: false, error: 'missing_field', message: 'id ist erforderlich fuer get' });
        }
        const job = await getShellJobById(body.id);
        if (!job) {
          return reply.status(404).send({ success: false, error: 'unknown_job', message: `Job ${body.id} nicht gefunden` });
        }
        return reply.status(200).send({ success: true, job });
      }

      if (action === 'log') {
        if (!body.id) {
          return reply.status(400).send({ success: false, error: 'missing_field', message: 'id ist erforderlich fuer log' });
        }
        if (body.query) {
          const result = await searchShellJobLog(body.id, body.query, {
            regex: body.regex === true,
            case_sensitive: body.case_sensitive === true,
            max_matches: body.max_matches,
          });
          if (!result) {
            return reply.status(404).send({ success: false, error: 'unknown_job', message: `Job ${body.id} nicht gefunden` });
          }
          return reply.status(200).send({ success: true, ...result });
        }
        const result = await getShellJobLogLines(body.id, body.from_line, body.to_line);
        if (!result) {
          return reply.status(404).send({ success: false, error: 'unknown_job', message: `Job ${body.id} nicht gefunden` });
        }
        return reply.status(200).send({ success: true, ...result });
      }

      if (action === 'exec') {
        if (!body.project || !body.command) {
          return reply.status(400).send({
            error: 'missing_field',
            message: 'project und command sind erforderlich',
          });
        }
        const timeoutMs = body.timeout_ms ?? 30000;
        const { id, stream_id } = await enqueueShellJob({
          project: body.project,
          command: body.command,
          cwd_relative: body.cwd_relative,
          timeout_ms: timeoutMs,
          tail_lines: body.tail_lines,
        });

        const result = await waitForShellJob(id, timeoutMs + 5000);
        // success-Flag + message sind Pflicht: Web-KI-Connectors brauchen
        // ein klares Fehlersignal, sonst hangt der Call stillschweigend.
        return reply.status(statusFor(result as unknown as Record<string, unknown>)).send({
          success: !result.error,
          status: result.status,
          stream_id: result.stream_id ?? stream_id,
          exit_code: result.exit_code,
          tail: result.tail,
          error: result.error,
          message: result.message,
        });
      }

      return reply.status(400).send({ error: 'unknown_action', message: `action: ${action}` });
    } catch (err) {
      fastify.log.error({ err, body }, '/api/shell failed');
      return reply.status(500).send({ error: 'internal', message: (err as Error).message });
    }
  });
}
