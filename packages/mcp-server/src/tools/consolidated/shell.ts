/**
 * mcp__synapse__shell
 *
 * Duenner Wrapper ueber execShellInProject / getShellStream / getShellJobs
 * aus @synapse/core. Identische Semantik zum REST-Endpoint /api/shell.
 *
 * Actions:
 *   - exec (default): Kommando ausfuehren
 *   - get_stream:     Neue Zeilen eines laufenden Kommandos holen (live)
 *   - history:        Letzte N Jobs eines Projekts auflisten (Metadata)
 *   - get:            Einzelnen Job per ID inkl. vollem Output
 */

import type { ConsolidatedTool } from './types.js';
import { str, num, reqStr } from './types.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  execShellInProject,
  getShellStream,
  getShellJobs,
  getShellJobById,
  getShellJobLogLines,
  searchShellJobLog,
  insertCompletedShellJob,
} from '@synapse/core';

const STREAMS_DIR = path.join(os.homedir(), '.synapse', 'shell-streams');

function readStreamLog(streamId: string | undefined | null): string | undefined {
  if (!streamId) return undefined;
  try {
    return fs.readFileSync(path.join(STREAMS_DIR, `${streamId}.log`), 'utf8');
  } catch {
    return undefined;
  }
}

export const shellTool: ConsolidatedTool = {
  definition: {
    name: 'shell',
    description:
      'Projekt-scoped Shell-Ausfuehrung mit Active-Gate. Prueft beim FileWatcher-Daemon ob das Projekt aktiv ist und fuehrt das Kommando im Projektpfad aus. Actions: exec (default) | get_stream (Live laufende Jobs) | history (Liste vergangener Jobs mit output_line_count) | get (Job-Details + voller Output) | log (Zeilenrange ODER Such-Treffer im Output, mit Zeilennummern).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['exec', 'get_stream', 'history', 'get', 'log'],
          description: 'Default: exec. log + id liefert Zeilenrange (Default 1-100); log + id + query liefert Such-Treffer mit Zeilennummern.',
        },
        project: { type: 'string', description: 'Projekt-Name (Pflicht fuer exec; optional fuer history Filter)' },
        command: { type: 'string', description: 'Shell-Kommando (Pflicht fuer exec)' },
        stream_id: { type: 'string', description: 'Pflicht fuer get_stream' },
        id: { type: 'string', description: 'Job-UUID (Pflicht fuer get und log)' },
        limit: { type: 'number', description: 'history: max Jobs (Default 20, Max 200)' },
        offset: { type: 'number', description: 'history: Skip N Jobs (Default 0)' },
        status: {
          type: 'string',
          enum: ['pending', 'running', 'done', 'failed', 'rejected', 'timeout'],
          description: 'history: Filter auf Status',
        },
        from_line: { type: 'number', description: 'log: ab Zeile N (1-basiert, Default 1)' },
        to_line: { type: 'number', description: 'log: bis Zeile M inkl. (Default from_line+99)' },
        query: { type: 'string', description: 'log: Such-Pattern (Substring oder Regex). Fuer Zahlen einfach die Zahl als String.' },
        regex: { type: 'boolean', description: 'log: query als Regex interpretieren (Default false = Substring)' },
        case_sensitive: { type: 'boolean', description: 'log: case-sensitive Suche (Default false)' },
        max_matches: { type: 'number', description: 'log: max Treffer (Default 200, Max 2000)' },
        timeout_ms: { type: 'number', description: 'Default 30000' },
        tail_lines: { type: 'number', description: 'Default 5' },
        cwd_relative: { type: 'string', description: 'Unterpfad innerhalb des Projekt-Roots' },
        since_last_read: {
          type: 'boolean',
          description: 'get_stream: nur neue Zeilen seit letztem Call (Default true)',
        },
      },
      required: ['action'],
    },
  },
  handler: async (args) => {
    const action = str(args, 'action') ?? 'exec';

    if (action === 'get_stream') {
      const result = getShellStream({
        stream_id: reqStr(args, 'stream_id'),
        tail_lines: num(args, 'tail_lines'),
        since_last_read: args.since_last_read !== false,
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (action === 'history') {
      const jobs = await getShellJobs({
        project: str(args, 'project'),
        limit: num(args, 'limit'),
        offset: num(args, 'offset'),
        status: str(args, 'status') as
          | 'pending' | 'running' | 'done' | 'failed' | 'rejected' | 'timeout'
          | undefined,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, count: jobs.length, jobs }, null, 2),
          },
        ],
      };
    }

    if (action === 'get') {
      const job = await getShellJobById(reqStr(args, 'id'));
      if (!job) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { success: false, error: 'unknown_job', message: `Job ${reqStr(args, 'id')} nicht gefunden` },
                null,
                2,
              ),
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, job }, null, 2) }] };
    }

    if (action === 'log') {
      const id = reqStr(args, 'id');
      const query = str(args, 'query');
      // Mit query → Such-Modus; ohne query → Range-Modus.
      if (query) {
        const result = await searchShellJobLog(id, query, {
          regex: args.regex === true,
          case_sensitive: args.case_sensitive === true,
          max_matches: num(args, 'max_matches'),
        });
        if (!result) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'unknown_job', message: `Job ${id} nicht gefunden` }, null, 2) }],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
      }
      const result = await getShellJobLogLines(id, num(args, 'from_line'), num(args, 'to_line'));
      if (!result) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'unknown_job', message: `Job ${id} nicht gefunden` }, null, 2) }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, ...result }, null, 2) }] };
    }

    if (action !== 'exec') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `unknown action: ${action}` }, null, 2) }],
      };
    }

    const project = reqStr(args, 'project');
    const command = reqStr(args, 'command');
    const cwdRel = str(args, 'cwd_relative');
    const timeoutMs = num(args, 'timeout_ms');
    const tailLines = num(args, 'tail_lines');

    const result = (await execShellInProject({
      project,
      command,
      cwd_relative: cwdRel,
      timeout_ms: timeoutMs,
      tail_lines: tailLines,
    })) as Record<string, unknown>;

    // History persistieren — damit eigene MCP-Aufrufe in shell history /
    // shell get / shell log auftauchen (gleiche Tabelle wie REST-Queue).
    // Best-effort: bei DB-Fehler nicht den exec-Aufruf scheitern lassen.
    try {
      const errCode = result['error'] as string | undefined;
      const isInactive = errCode === 'project_inactive';
      const status: 'done' | 'failed' | 'rejected' | 'timeout' = errCode
        ? (isInactive ? 'rejected' : 'failed')
        : (result['status'] === 'done'
            ? 'done'
            : result['status'] === 'running'
              ? 'timeout'
              : 'failed');
      const streamId = (result['stream_id'] as string | undefined) ?? undefined;
      const persistedId = await insertCompletedShellJob({
        project,
        command,
        cwd_relative: cwdRel,
        timeout_ms: timeoutMs,
        tail_lines: tailLines,
        status,
        exit_code: result['exit_code'] as number | undefined,
        tail: result['tail'] as string[] | undefined,
        error: errCode,
        message: result['message'] as string | undefined,
        output: readStreamLog(streamId),
        stream_id: streamId,
        source: 'mcp_local',
      });
      // History-ID anhaengen damit der User sie via "shell get" abholen kann
      (result as Record<string, unknown>)['id'] = persistedId.id;
    } catch {
      // Kein DB-Zugriff (z.B. Tests ohne PG) → exec-Result bleibt valide
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};
