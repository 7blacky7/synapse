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
import { StringDecoder } from 'node:string_decoder';
import {ShellAusgabePuffer} from './shell-ausgabe-puffer.js';
import {ladeShellWerte,maskiereShellDaten,maskiereShellText} from './shell-maske.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { getProjectRoot } from './project-registry.js';
import { baueJobUmgebung } from './shell-job-umgebung.js';
import { ermittleShellLage, type ShellLage, type ShellLageKontext } from './shell-lage.js';
import {pruefeShellStart,type ShellBestaetigung}from'./shell-start-sicherung.js';
import{holeShellStartKatalog,geschuetzteShellProzesse,beginneShellSicherungsJob,beendeShellSicherungsJob}from'./shell-sicherungs-lauf.js';
import { waehleShellStart } from './shell-start.js';
import type { SicherungsShell } from './shell-sicherung-parser.js';

const STREAMS_DIR = path.join(os.homedir(), '.synapse', 'shell-streams');
const DEFAULT_TAIL_LINES = 5;
const STREAM_TTL_MS = 60 * 60 * 1000;

/**
 * ABLOESEGRENZE (SH-1): nach dieser Zeit gilt der Job als "laeuft im Hintergrund".
 * Das bricht NICHTS ab — es meldet nur dem Aufrufer, dass er weiterarbeiten soll.
 * Frueher hiess dieser Wert timeout_ms und war auf 30 s: der Aufrufer bekam status
 * 'timeout', was jede KI als Fehlschlag las und mit immer hoeheren timeout_ms
 * beantwortete. Genau das Verhalten sollte weg.
 */
export const DEFAULT_DETACH_MS = 20_000;

/**
 * HARTE OBERGRENZE (SH-1, User-Entscheidung 08.08.2026: 3 h).
 * Erst hier wird wirklich abgebrochen — SIGTERM, nach der Gnadenfrist SIGKILL.
 * Eine Grenze ist noetig, weil Prozesse, die auf stdin warten (git commit ohne -m,
 * apt mit Rueckfrage), sonst unbegrenzt haengen und einen Slot belegen.
 */
export const DEFAULT_HARD_LIMIT_MS = 3 * 60 * 60 * 1000;

/** Zeit zwischen SIGTERM und SIGKILL beim Erreichen der harten Obergrenze. */
const KILL_GRACE_MS = 10_000;

/**
 * Dauer fuer Meldungen. Eine reine Minuten-Rundung schrieb bei kurzen Grenzen
 * "0 min" — die Meldung landet im Job-Ergebnis und wird gelesen, also lohnt
 * sich die Fallunterscheidung.
 */
function formatDauer(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  const h = ms / 3_600_000;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

export type ShellExecArgs = {
  project: string;
  command: string;
  cwd_relative?: string;
  /** P10-T36: native Shellwahl; Windows standardmäßig cmd, POSIX sh. */
  shell?: SicherungsShell;
  /** Fester Preflight-Anschluss; E3 nutzt ihn, E2 aktiviert keine Stufen. Maskierte Daten. */
  onLage?: (lage: ShellLage) => Promise<void> | void;
  agent_id?: string | null;
  bestaetigt?: ShellBestaetigung | null;
  /** Interne bestehende Queue-ID; keine neue Berechtigung. */
  sicherungs_job_id?: string;
  sicherungs_ursprung?: 'daemon' | 'mcp_local' | 'workspace';
  /** @deprecated Altname der Abloesegrenze. Wirkt als detach_after_ms. */
  timeout_ms?: number;
  /** Abloesegrenze in ms (Default DEFAULT_DETACH_MS). Bricht nichts ab. */
  detach_after_ms?: number;
  /** Harte Obergrenze in ms (Default DEFAULT_HARD_LIMIT_MS). Hier wird gekillt. */
  hard_limit_ms?: number;
  tail_lines?: number;
  /**
   * Wird EINMAL gefeuert, wenn die Abloesegrenze erreicht ist und der Prozess
   * weiterlaeuft. Der Aufrufer kann daraufhin seinem eigenen Aufrufer antworten;
   * das Promise von execShellInProject laeuft unabhaengig davon bis zum echten
   * Ende weiter und liefert dann das vollstaendige Ergebnis.
   */
  onDetached?: (info: { stream_id: string; pid?: number; tail: string[] }) => void;
  /**
   * Wird EINMAL gefeuert, sobald der Prozess gestartet ist. Liefert eine
   * Handhabe zum Beenden (SH-2, kill-Action). Ohne das haette der Aufrufer
   * keinen Zugriff auf den Kindprozess — er ist in dieser Funktion gekapselt.
   */
  onStarted?: (ctl: { pid?: number; stream_id: string; kill: () => void }) => void;
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
  maskiert?: number;
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

  // Nie die Daemon-Umgebung durchreichen: sie traegt DATABASE_URL der Synapse-DB
  // und Tokens. DATABASE_URL zeigt stattdessen auf die DB DIESES Projekts
  // (siehe shell-job-umgebung.ts). job_env meldet die Wahl ohne Passwort.
  const jobUmgebung = await baueJobUmgebung(args.project);
  const werte=await ladeShellWerte(args.project);
  const jobEnv = maskiereShellDaten(jobUmgebung.info,werte).daten;

  const cwd = args.cwd_relative ? path.resolve(projectRoot, args.cwd_relative) : projectRoot;
  const relCheck = path.relative(projectRoot, cwd);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    return { error: 'cwd_outside_project', message: 'cwd_relative darf nicht aus dem Projekt-Root ausbrechen' };
  }
  const start = waehleShellStart(args.shell);
  const lageKontext: ShellLageKontext = {
    shell: start.shell, os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.env.WSL_DISTRO_NAME ? 'wsl' : 'linux',
    cwd, project_root: projectRoot, env: jobUmgebung.env, env_vollstaendig: true,
  };
  let lage = await ermittleShellLage(args.command, lageKontext);
  if (args.onLage) {
    await args.onLage(maskiereShellDaten(lage, werte, true).daten);
    // Ein interner Observer darf die Bestätigung nicht über eine zwischenzeitliche Änderung retten.
    lage = await ermittleShellLage(args.command, lageKontext);
  }
  const prozesse = /\b(?:kill|pkill|killall|taskkill|stop-process)\b/i.test(args.command)
    ? await geschuetzteShellProzesse()
    : {pids:[process.pid,process.ppid],namen:[path.basename(process.execPath).toLowerCase()]};
  const katalog = await holeShellStartKatalog();
  const pruefung = pruefeShellStart({project:args.project,command:args.command,lage,
    agent_id:args.agent_id,bestaetigt:args.bestaetigt,rechner:os.hostname(),
    geschuetzte_pids:prozesse.pids,geschuetzte_namen:prozesse.namen},katalog);
  const sicherungsJob = await beginneShellSicherungsJob({project:args.project,command:args.command,
    cwd_relative:args.cwd_relative,agent_id:args.agent_id,job_id:args.sicherungs_job_id,
    entscheidung:pruefung,lage,rechner:os.hostname(),ursprung:args.sicherungs_ursprung});
  if (!pruefung.darf_starten) {
    return maskiereShellDaten({status:'rejected',error:pruefung.antwort?.error??'shell_anleitung',
      ...pruefung.antwort,...(sicherungsJob?{id:sicherungsJob}:{})},werte,true).daten;
  }
  const result = await new Promise<Record<string,unknown>>((resolve) => {
    ensureStreamsDir();
    cleanupOldStreams();
    const streamId = crypto.randomBytes(8).toString('hex');

    const log = fs.openSync(logPath(streamId), 'w');
    // detached:true gibt dem Kind eine EIGENE Prozessgruppe, und das ist die
    // Voraussetzung dafuer, dass sich ein Lauf ueberhaupt beenden laesst:
    //
    // Wir starten `sh -c "<kommando>"`. child.kill() trifft nur diese sh — das
    // eigentliche Kommando ist deren Kind und laeuft munter als Waise weiter.
    // Live gemessen am 08.08.2026: nach dem Abbruch war die sh weg, das
    // `sleep` lief weiter. Betraf gleichermassen die harte Obergrenze; ein
    // 3-Stunden-Limit haette also nur die Huelle beendet.
    //
    // Ohne detached liegt das Kind in der Prozessgruppe des DAEMONS (gemessen:
    // PGID des Waisen == Daemon-PID). Ein Gruppen-Kill haette damit den Daemon
    // selbst erschlagen. Deshalb: eigene Gruppe, dann gezielt -pgid beenden.
    const child = spawn(start.programm, [...start.prefix, args.command], {
      cwd, env: jobUmgebung.env, stdio: ['ignore', 'pipe', 'pipe'],
      detached: start.detached, windowsHide: true,
    });

    /**
     * Beendet die gesamte Prozessgruppe des Laufs. Faellt auf den direkten
     * Kindprozess zurueck, falls die Gruppe nicht (mehr) existiert.
     */
    const beendeGruppe = (signal: NodeJS.Signals): void => {
      if (process.platform === 'win32' && child.pid) {
        // Festes Programm + ausschließlich unsere Kind-PID, kein Nutzerbefehl.
        const stop = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])], { stdio: 'ignore', windowsHide: true });
        stop.on('error', () => { try { child.kill(signal); } catch { /* schon beendet */ } });
        return;
      }
      try {
        if (child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        try { child.kill(signal); } catch { /* schon tot */ }
      }
    };

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

    // P10-T33: Klartext darf nie in die Stream-Datei. UTF-8 und Geheimnisse ueber Chunk-Grenzen.
    const decoderOut=new StringDecoder('utf8'),decoderErr=new StringDecoder('utf8');
    let maskiert=0;
    const puffer=new ShellAusgabePuffer(werte,(text,anzahl)=>{maskiert+=anzahl;fs.writeSync(log,text);});
    child.stdout?.on('data',(chunk:Buffer)=>puffer.empfange(decoderOut.write(chunk)));
    child.stderr?.on('data',(chunk:Buffer)=>puffer.empfange(decoderErr.write(chunk)));
    const flush=()=>{puffer.empfange(decoderOut.end());puffer.empfange(decoderErr.end());puffer.ende();};

    // ── Abbruch von aussen (SH-2) ──
    // Der Aufrufer bekommt eine Handhabe auf den Kindprozess. Ohne sie koennte
    // niemand einen Job beenden, der stundenlang laeuft — der Prozess ist in
    // dieser Funktion gekapselt.
    let cancelled = false;
    let cancelKillTimer: NodeJS.Timeout | null = null;
    try {
      args.onStarted?.({
        pid: child.pid,
        stream_id: streamId,
        kill: () => {
          if (cancelled) return;
          cancelled = true;
          beendeGruppe('SIGTERM');
          cancelKillTimer = setTimeout(() => {
            beendeGruppe('SIGKILL');
          }, KILL_GRACE_MS);
          cancelKillTimer.unref?.();
        },
      });
    } catch { /* Callback-Fehler duerfen den Lauf nicht kippen */ }

    // ── Abloesung (SH-1) ──────────────────────────────────────────────────
    // WICHTIG: Der Detach-Timer loest das Promise NICHT auf. Genau das war der
    // alte Fehler: resolve() beim Timeout machte den spaeteren exit-Handler
    // wirkungslos (ein Promise loest nur einmal auf), der Aufrufer schrieb den
    // Job terminal als 'timeout' — und exit-Code sowie voller Output des noch
    // laufenden Prozesses gingen ERSATZLOS VERLOREN. Jetzt meldet der Timer nur
    // per Callback, dass abgeloest wurde; das Promise wartet auf das echte Ende.
    const detachMs = args.detach_after_ms ?? args.timeout_ms ?? DEFAULT_DETACH_MS;
    let detached = false;
    const detachTimer = setTimeout(() => {
      detached = true;
      try {
        args.onDetached?.({
          stream_id: streamId,
          pid: child.pid,
          tail: tailLines(logPath(streamId), tailN),
        });
      } catch { /* Callback-Fehler duerfen den Lauf nicht kippen */ }
    }, detachMs);

    // ── Harte Obergrenze ──────────────────────────────────────────────────
    const hardLimitMs = args.hard_limit_ms ?? DEFAULT_HARD_LIMIT_MS;
    let killTimer: NodeJS.Timeout | null = null;
    let hardLimitHit = false;
    const hardTimer = setTimeout(() => {
      hardLimitHit = true;
      beendeGruppe('SIGTERM');
      killTimer = setTimeout(() => {
        beendeGruppe('SIGKILL');
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, hardLimitMs);
    hardTimer.unref?.();

    const clearTimers = (): void => {
      clearTimeout(detachTimer);
      clearTimeout(hardTimer);
      if (killTimer) clearTimeout(killTimer);
      if (cancelKillTimer) clearTimeout(cancelKillTimer);
    };

    child.on('close', (code) => {
      flush();
      if(maskiert) meta.maskiert=maskiert;
      clearTimers();
      try { fs.closeSync(log); } catch { /* already closed */ }
      meta.status = (hardLimitHit || cancelled) ? 'failed' : (code === 0 ? 'done' : 'failed');
      meta.exit_code = code ?? -1;
      writeMeta(meta);
      // Reihenfolge der Faelle ist wichtig: ein abgebrochener Job ist kein
      // Fehlschlag des Kommandos, und die harte Obergrenze ist kein Abbruch
      // durch einen Agenten. Beides muss unterscheidbar bleiben.
      resolve({
        status: cancelled ? 'cancelled' : (hardLimitHit ? 'hard_limit' : meta.status),
        stream_id: streamId,
        exit_code: meta.exit_code,
        detached,
        tail: tailLines(logPath(streamId), tailN),
        job_env: jobEnv,
        ...(maskiert?{maskiert}:{}),
        ...(cancelled
          ? { message: 'Job wurde abgebrochen.' }
          : hardLimitHit
            ? { message: `Harte Obergrenze von ${formatDauer(hardLimitMs)} erreicht — Prozess wurde beendet.` }
            : {}),
      });
    });

    child.on('error', (err) => {
      flush();
      if(maskiert)meta.maskiert=maskiert;
      clearTimers();
      try { fs.closeSync(log); } catch { /* ignore */ }
      meta.status = 'failed';
      meta.exit_code = -1;
      writeMeta(meta);
      resolve({
        status: 'failed',
        stream_id: streamId,
        error: maskiereShellText(err.message,werte).text,
        detached,
        tail: tailLines(logPath(streamId), tailN),
        job_env: jobEnv,
      });
    });
  });
  if (sicherungsJob && !args.sicherungs_job_id) await beendeShellSicherungsJob(sicherungsJob,args.project,result);
  return pruefung.antwort
    ? maskiereShellDaten({...pruefung.antwort,...result,...(sicherungsJob?{id:sicherungsJob}:{})},werte,true).daten
    : result;
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
    ...(meta.maskiert?{maskiert:meta.maskiert}:{}),
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
