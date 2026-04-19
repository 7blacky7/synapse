/**
 * mcp__synapse__shell
 *
 * Projekt-scoped Shell-Ausfuehrung. Das Tool fragt vor jedem exec den
 * FileWatcher-Daemon via HTTP nach dem Active-Status des Projekts.
 * Nur aktive Projekte duerfen Kommandos empfangen — User kontrolliert
 * die Aktivitaet im Tray.
 *
 * Actions:
 *   - exec (default): Kommando ausfuehren, bei Timeout stream_id + tail
 *   - get_stream: Neue Zeilen seit letztem get_stream holen, oder tail_lines
 */

import type { ConsolidatedTool } from './types.js';
import { str, num, reqStr } from './types.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { getProjectRoot } from '@synapse/core';

const STREAMS_DIR = path.join(os.homedir(), '.synapse', 'shell-streams');
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TAIL_LINES = 5;
const STREAM_TTL_MS = 60 * 60 * 1000; // 1h

type StreamMeta = {
  stream_id: string;
  project: string;
  command: string;
  started_ms: number;
  cwd: string;
  pid?: number;
  status: 'running' | 'done' | 'failed';
  exit_code?: number;
  last_read_offset: number;
  log_path: string;
};

function ensureStreamsDir(): void {
  fs.mkdirSync(STREAMS_DIR, { recursive: true });
}

function metaPath(id: string): string {
  return path.join(STREAMS_DIR, `${id}.meta.json`);
}

function logPath(id: string): string {
  return path.join(STREAMS_DIR, `${id}.log`);
}

function readMeta(id: string): StreamMeta | null {
  try {
    const raw = fs.readFileSync(metaPath(id), 'utf8');
    return JSON.parse(raw) as StreamMeta;
  } catch {
    return null;
  }
}

function writeMeta(meta: StreamMeta): void {
  fs.writeFileSync(metaPath(meta.stream_id), JSON.stringify(meta, null, 2));
}

function tailLines(file: string, n: number): string[] {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  }
}

/**
 * Abfrage an den FileWatcher-Daemon ob das Projekt aktiv ist.
 * Daemon-Port aus ~/.synapse/file-watcher/daemon.port, Fallback 7878.
 * Wenn Daemon nicht erreichbar → wir interpretieren das als "unbekannt"
 * und erlauben exec (keine Gatekeeping moeglich).
 */
async function isProjectActive(project: string): Promise<{ active: boolean; reason: string }> {
  let port = 7878;
  try {
    const raw = fs.readFileSync(
      path.join(os.homedir(), '.synapse', 'file-watcher', 'daemon.port'),
      'utf8',
    );
    const parsed = parseInt(raw.trim(), 10);
    if (!Number.isNaN(parsed)) port = parsed;
  } catch { /* default */ }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/projects/${encodeURIComponent(project)}/status`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.status === 404) return { active: false, reason: 'unknown_to_daemon' };
    if (!res.ok) return { active: true, reason: 'daemon_error_fallback_allow' };
    const body = await res.json() as { enabled?: boolean };
    return { active: body.enabled === true, reason: body.enabled ? 'enabled' : 'disabled' };
  } catch {
    // Daemon nicht erreichbar — erlaubend ausfallen (wie bisher ohne Daemon)
    return { active: true, reason: 'daemon_unreachable_fallback_allow' };
  }
}

function execShell(opts: {
  project: string;
  projectRoot: string;
  command: string;
  cwdRelative?: string;
  timeoutMs: number;
  tailN: number;
}): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ensureStreamsDir();

    const streamId = crypto.randomBytes(8).toString('hex');
    const cwd = opts.cwdRelative
      ? path.resolve(opts.projectRoot, opts.cwdRelative)
      : opts.projectRoot;

    // Sicherheit: cwd muss unterhalb projectRoot bleiben
    const relCheck = path.relative(opts.projectRoot, cwd);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      resolve({
        error: 'cwd_outside_project',
        message: 'cwd_relative darf nicht aus dem Projekt-Root ausbrechen',
      });
      return;
    }

    const log = fs.openSync(logPath(streamId), 'w');
    const child = spawn('sh', ['-c', opts.command], {
      cwd,
      env: process.env,
      stdio: ['ignore', log, log],
    });

    const meta: StreamMeta = {
      stream_id: streamId,
      project: opts.project,
      command: opts.command,
      started_ms: Date.now(),
      cwd,
      pid: child.pid,
      status: 'running',
      last_read_offset: 0,
      log_path: logPath(streamId),
    };
    writeMeta(meta);

    const timeout = setTimeout(() => {
      // Prozess bleibt laufen — wir antworten mit stream_id, User kann weiter pollen
      resolve({
        status: 'running',
        stream_id: streamId,
        tail: tailLines(logPath(streamId), opts.tailN),
        message: 'command still running — use action:"get_stream" with stream_id to fetch more',
      });
    }, opts.timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      fs.closeSync(log);
      meta.status = code === 0 ? 'done' : 'failed';
      meta.exit_code = code ?? -1;
      writeMeta(meta);
      resolve({
        status: meta.status,
        stream_id: streamId,
        exit_code: meta.exit_code,
        tail: tailLines(logPath(streamId), opts.tailN),
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      fs.closeSync(log);
      meta.status = 'failed';
      meta.exit_code = -1;
      writeMeta(meta);
      resolve({
        status: 'failed',
        stream_id: streamId,
        error: err.message,
        tail: tailLines(logPath(streamId), opts.tailN),
      });
    });
  });
}

function getStream(streamId: string, tailN: number, sinceLastRead: boolean): Record<string, unknown> {
  const meta = readMeta(streamId);
  if (!meta) {
    return { error: 'unknown_stream', stream_id: streamId };
  }
  const fullLog = fs.existsSync(meta.log_path) ? fs.readFileSync(meta.log_path, 'utf8') : '';
  let content = fullLog;
  if (sinceLastRead) {
    content = fullLog.slice(meta.last_read_offset);
    meta.last_read_offset = fullLog.length;
    writeMeta(meta);
  }
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return {
    status: meta.status,
    stream_id: streamId,
    exit_code: meta.exit_code,
    new_lines: lines.slice(-tailN),
    total_bytes: fullLog.length,
  };
}

function cleanupOldStreams(): void {
  try {
    ensureStreamsDir();
    const now = Date.now();
    for (const f of fs.readdirSync(STREAMS_DIR)) {
      if (!f.endsWith('.meta.json')) continue;
      const id = f.replace(/\.meta\.json$/, '');
      const meta = readMeta(id);
      if (!meta) continue;
      if (meta.status !== 'running' && now - meta.started_ms > STREAM_TTL_MS) {
        try { fs.unlinkSync(metaPath(id)); } catch { /* ignore */ }
        try { fs.unlinkSync(logPath(id)); } catch { /* ignore */ }
      }
    }
  } catch { /* best-effort */ }
}

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
        timeout_ms: { type: 'number', description: `Default ${DEFAULT_TIMEOUT_MS}` },
        tail_lines: { type: 'number', description: `Default ${DEFAULT_TAIL_LINES}` },
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
    const tailN = num(args, 'tail_lines') ?? DEFAULT_TAIL_LINES;

    cleanupOldStreams();

    if (action === 'get_stream') {
      const id = reqStr(args, 'stream_id');
      const sinceLastRead = args.since_last_read !== false;
      const result = getStream(id, tailN, sinceLastRead);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (action !== 'exec') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `unknown action: ${action}` }, null, 2) }],
      };
    }

    const project = reqStr(args, 'project');
    const command = reqStr(args, 'command');
    const timeoutMs = num(args, 'timeout_ms') ?? DEFAULT_TIMEOUT_MS;
    const cwdRelative = str(args, 'cwd_relative');

    const projectRoot = await getProjectRoot(project);
    if (!projectRoot) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: 'unknown_project',
          message: `Projekt "${project}" nicht registriert`,
        }, null, 2) }],
      };
    }

    const gate = await isProjectActive(project);
    if (!gate.active) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          error: 'project_inactive',
          reason: gate.reason,
          message: `Projekt "${project}" ist auf dem Host inaktiv. User muss im Tray aktivieren.`,
        }, null, 2) }],
      };
    }

    const result = await execShell({
      project, projectRoot, command, cwdRelative,
      timeoutMs, tailN,
    });

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
};
