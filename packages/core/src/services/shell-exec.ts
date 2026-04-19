/**
 * Shared Shell-Execution-Service — wird vom MCP-Tool (shell) und vom
 * REST-Endpoint (/api/shell) gemeinsam genutzt.
 *
 * Schutzschichten:
 *   1. Project-Root-Resolution via getProjectRoot (hostname-scoped).
 *   2. Active-Gate via FileWatcher-Daemon (HTTP, kurzer Timeout).
 *   3. cwd-Traversal-Schutz.
 *   4. Timeout → stream_id + Log-Puffer fuer Chunked-Retrieval.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { getProjectRoot } from './project-registry.js';

const STREAMS_DIR = path.join(os.homedir(), '.synapse', 'shell-streams');
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_TAIL_LINES = 5;
const STREAM_TTL_MS = 60 * 60 * 1000;

export type ShellExecArgs = {
  project: string;
  command: string;
  cwd_relative?: string;
  timeout_ms?: number;
  tail_lines?: number;
};

export type ShellGetStreamArgs = {
  stream_id: string;
  tail_lines?: number;
  since_last_read?: boolean;
};

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

function metaPath(id: string): string { return path.join(STREAMS_DIR, `${id}.meta.json`); }
function logPath(id: string): string { return path.join(STREAMS_DIR, `${id}.log`); }

function readMeta(id: string): StreamMeta | null {
  try { return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as StreamMeta; }
  catch { return null; }
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
  } catch { return []; }
}

export async function isProjectActive(
  project: string
): Promise<{ active: boolean; reason: string }> {
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
    const res = await fetch(
      `http://127.0.0.1:${port}/projects/${encodeURIComponent(project)}/status`,
      { signal: AbortSignal.timeout(500) },
    );
    if (res.status === 404) return { active: false, reason: 'unknown_to_daemon' };
    if (!res.ok) return { active: true, reason: 'daemon_error_fallback_allow' };
    const body = await res.json() as { enabled?: boolean };
    return { active: body.enabled === true, reason: body.enabled ? 'enabled' : 'disabled' };
  } catch {
    return { active: true, reason: 'daemon_unreachable_fallback_allow' };
  }
}

export async function execShellInProject(
  args: ShellExecArgs
): Promise<Record<string, unknown>> {
  const tailN = args.tail_lines ?? DEFAULT_TAIL_LINES;

  const projectRoot = await getProjectRoot(args.project);
  if (!projectRoot) {
    return {
      error: 'unknown_project',
      message: `Projekt "${args.project}" nicht registriert`,
    };
  }

  const gate = await isProjectActive(args.project);
  if (!gate.active) {
    return {
      error: 'project_inactive',
      reason: gate.reason,
      message: `Projekt "${args.project}" ist auf dem Host inaktiv. User muss im Tray aktivieren.`,
    };
  }

  return new Promise((resolve) => {
    ensureStreamsDir();
    cleanupOldStreams();

    const streamId = crypto.randomBytes(8).toString('hex');
    const cwd = args.cwd_relative
      ? path.resolve(projectRoot, args.cwd_relative)
      : projectRoot;

    const relCheck = path.relative(projectRoot, cwd);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      resolve({
        error: 'cwd_outside_project',
        message: 'cwd_relative darf nicht aus dem Projekt-Root ausbrechen',
      });
      return;
    }

    const log = fs.openSync(logPath(streamId), 'w');
    const child = spawn('sh', ['-c', args.command], {
      cwd, env: process.env, stdio: ['ignore', log, log],
    });

    const meta: StreamMeta = {
      stream_id: streamId,
      project: args.project,
      command: args.command,
      started_ms: Date.now(),
      cwd,
      pid: child.pid,
      status: 'running',
      last_read_offset: 0,
      log_path: logPath(streamId),
    };
    writeMeta(meta);

    const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      resolve({
        status: 'running',
        stream_id: streamId,
        tail: tailLines(logPath(streamId), tailN),
        message: 'command still running — use action:"get_stream" with stream_id',
      });
    }, timeoutMs);

    child.on('exit', (code) => {
      clearTimeout(timeout);
      try { fs.closeSync(log); } catch { /* already closed */ }
      meta.status = code === 0 ? 'done' : 'failed';
      meta.exit_code = code ?? -1;
      writeMeta(meta);
      resolve({
        status: meta.status,
        stream_id: streamId,
        exit_code: meta.exit_code,
        tail: tailLines(logPath(streamId), tailN),
      });
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      try { fs.closeSync(log); } catch { /* ignore */ }
      meta.status = 'failed';
      meta.exit_code = -1;
      writeMeta(meta);
      resolve({
        status: 'failed',
        stream_id: streamId,
        error: err.message,
        tail: tailLines(logPath(streamId), tailN),
      });
    });
  });
}

export function getShellStream(args: ShellGetStreamArgs): Record<string, unknown> {
  const meta = readMeta(args.stream_id);
  if (!meta) return { error: 'unknown_stream', stream_id: args.stream_id };

  const tailN = args.tail_lines ?? DEFAULT_TAIL_LINES;
  const sinceLastRead = args.since_last_read !== false;

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
    stream_id: args.stream_id,
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
