/**
 * mcp__synapse__shell
 *
 * Duenner Wrapper ueber execShellInProject / getShellStream aus
 * @synapse/core. Identische Semantik zum REST-Endpoint /api/shell.
 *
 * Actions:
 *   - exec (default): Kommando ausfuehren
 *   - get_stream: Neue Zeilen eines laufenden Kommandos holen
 */

import type { ConsolidatedTool } from './types.js';
import { str, num, reqStr } from './types.js';
import { execShellInProject, getShellStream } from '@synapse/core';

export const shellTool: ConsolidatedTool = {
  definition: {
    name: 'shell',
    description:
      'Projekt-scoped Shell-Ausfuehrung mit Active-Gate. Prueft beim FileWatcher-Daemon ob das Projekt aktiv ist und fuehrt das Kommando im Projektpfad aus. Bei Timeout → stream_id fuer Chunked-Retrieval zurueck.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['exec', 'get_stream'],
          description: 'Default: exec. get_stream liefert neue Zeilen eines laufenden Kommandos.',
        },
        project: { type: 'string', description: 'Projekt-Name (Pflicht fuer exec)' },
        command: { type: 'string', description: 'Shell-Kommando (Pflicht fuer exec)' },
        stream_id: { type: 'string', description: 'Pflicht fuer get_stream' },
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

    if (action !== 'exec') {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `unknown action: ${action}` }, null, 2) }] };
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
