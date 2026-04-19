/**
 * MODUL: FileWatcher-Daemon-Client
 * ZWECK: MCP-Server spricht ueber HTTP mit dem PC-weiten moo-Daemon
 *        (~/.synapse/file-watcher/). Startet Daemon + Tray bei Bedarf.
 */

import { spawn, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

const DAEMON_HOME = path.join(os.homedir(), '.synapse', 'file-watcher');
const PORT_FILE = path.join(DAEMON_HOME, 'daemon.port');

const HERE = path.dirname(fileURLToPath(import.meta.url));
// HERE = <repo>/packages/mcp-server/dist → 3× '..' = <repo>
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

function readPort(): number | null {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function pingHealth(port: number, timeoutMs = 500): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function findBinary(kind: 'daemon' | 'tray'): string | null {
  const candidates = kind === 'daemon'
    ? [
        path.join(DAEMON_HOME, 'synapse-fwd'),
        path.join(REPO_ROOT, 'packages', 'file-watcher-daemon', 'bin', 'synapse-fwd'),
        '/tmp/synapse-fwd',
      ]
    : [
        path.join(DAEMON_HOME, 'tray'),
        path.join(REPO_ROOT, 'packages', 'file-watcher-daemon', 'tray', 'tray'),
      ];

  for (const c of candidates) {
    try {
      const st = fs.statSync(c);
      if (st.isFile() && (st.mode & 0o111)) return c;
    } catch {
      /* not found */
    }
  }
  return null;
}

async function startDaemon(): Promise<number> {
  const bin = findBinary('daemon');
  if (!bin) {
    throw new Error(
      'synapse-fwd Binary nicht gefunden. Erwartet in ~/.synapse/file-watcher/synapse-fwd oder packages/file-watcher-daemon/bin/synapse-fwd.'
    );
  }
  fs.mkdirSync(DAEMON_HOME, { recursive: true });
  const logFd = fs.openSync(path.join(DAEMON_HOME, 'daemon.log'), 'a');
  const child = spawn(bin, [], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, HOME: os.homedir() },
    cwd: DAEMON_HOME,
  });
  child.unref();

  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const p = readPort();
    if (p && (await pingHealth(p))) return p;
  }
  throw new Error('Daemon gestartet, aber /health nicht erreichbar (Log: ~/.synapse/file-watcher/daemon.log)');
}

async function ensureDaemon(): Promise<number> {
  const p = readPort();
  if (p && (await pingHealth(p))) return p;
  return startDaemon();
}

interface DaemonProject {
  name: string;
  pfad: string;
  enabled: boolean;
}

async function getProjects(port: number): Promise<DaemonProject[]> {
  const res = await fetch(`http://127.0.0.1:${port}/projects`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) throw new Error(`GET /projects: ${res.status}`);
  const json = (await res.json()) as { projekte?: DaemonProject[] };
  return json.projekte ?? [];
}

/**
 * Registriert ein Projekt idempotent beim Daemon.
 * - Daemon laeuft nicht → wird gestartet.
 * - Projekt unbekannt → POST /projects.
 * - Projekt bekannt + disabled → POST /projects/:name/enable.
 * - Projekt bereits aktiv → no-op.
 */
export async function ensureProjectInDaemon(name: string, pfad: string): Promise<{
  port: number;
  state: 'added' | 'enabled' | 'already-active';
}> {
  const port = await ensureDaemon();
  const projects = await getProjects(port);
  const existing = projects.find((p) => p.name === name);

  if (!existing) {
    const res = await fetch(`http://127.0.0.1:${port}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, pfad }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`POST /projects: ${res.status}`);
    return { port, state: 'added' };
  }

  if (!existing.enabled) {
    const res = await fetch(
      `http://127.0.0.1:${port}/projects/${encodeURIComponent(name)}/enable`,
      { method: 'POST', signal: AbortSignal.timeout(3000) }
    );
    if (!res.ok) throw new Error(`POST /projects/${name}/enable: ${res.status}`);
    return { port, state: 'enabled' };
  }

  return { port, state: 'already-active' };
}

/**
 * Disabled ein Projekt im Daemon (analog stopProjekt).
 */
export async function disableProjectInDaemon(name: string): Promise<boolean> {
  const port = readPort();
  if (!port || !(await pingHealth(port))) return false;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/projects/${encodeURIComponent(name)}/disable`,
      { method: 'POST', signal: AbortSignal.timeout(3000) }
    );
    return res.ok;
  } catch {
    return false;
  }
}

function trayRunning(): boolean {
  try {
    const out = execSync(
      'pgrep -af "(file-watcher-daemon/tray/tray|\\.synapse/file-watcher/tray)( |$)"',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function ensureAutostartEntry(bin: string): void {
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopFile = path.join(autostartDir, 'synapse-tray.desktop');
  if (fs.existsSync(desktopFile)) return;
  try {
    fs.mkdirSync(autostartDir, { recursive: true });
    fs.writeFileSync(
      desktopFile,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Synapse FileWatcher Tray',
        `Exec=${bin}`,
        'X-GNOME-Autostart-enabled=true',
        'Terminal=false',
        'Categories=Utility;',
        '',
      ].join('\n')
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Startet das Tray-Icon falls noch keines laeuft. No-op ohne GUI-Session.
 */
export function ensureTray(): void {
  if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return;
  if (trayRunning()) return;

  const bin = findBinary('tray');
  if (!bin) return;

  try {
    fs.mkdirSync(DAEMON_HOME, { recursive: true });
    const logFd = fs.openSync(path.join(DAEMON_HOME, 'tray.log'), 'a');
    const child = spawn(bin, [], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, HOME: os.homedir() },
    });
    child.unref();
    ensureAutostartEntry(bin);
  } catch {
    /* best-effort */
  }
}
