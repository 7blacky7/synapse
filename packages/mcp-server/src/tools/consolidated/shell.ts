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
import {
  execShellInProject,
  getShellStream,
  getShellJobs,
  getShellJobById,
  getShellJobLogLines,
  searchShellJobLog,
} from '@synapse/core';

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

    const result = await execShellInProject({
      project: reqStr(args, 'project'),
      command: reqStr(args, 'command'),
      cwd_relative: str(args, 'cwd_relative'),
      timeout_ms: num(args, 'timeout_ms'),
      tail_lines: num(args, 'tail_lines'),
    });

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};
