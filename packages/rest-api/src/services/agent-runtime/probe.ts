import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';

/** P22-T9: eine begrenzte Prüfung pro Treiber; Fehler werden ebenfalls kurz gecacht. */
export class RuntimeStatusProbe<T> {
  private flight: Promise<T> | null = null;
  private cached: { value: T; until: number } | null = null;
  private revision = 0;
  constructor(private readonly ttlMs = 5_000, private readonly now = Date.now) {}
  invalidate(): void { this.cached = null; this.revision++; }
  run(probe: () => Promise<T>): Promise<T> {
    if (this.flight) return this.flight;
    if (this.cached && this.cached.until > this.now()) return Promise.resolve(this.cached.value);
    const revision = this.revision;
    const flight = Promise.resolve().then(probe).then(value => {
      if (revision === this.revision) this.cached = { value, until: this.now() + this.ttlMs };
      return value;
    }).finally(() => { if (this.flight === flight) this.flight = null; });
    this.flight = flight;
    return flight;
  }
}

export class RuntimeProbeError extends Error {
  constructor(readonly code: 'pid_limit' | 'probe_timeout', message: string) { super(message); }
}

export function runtimeProbeDiagnostic(error: unknown): { code: 'pid_limit' | 'probe_timeout' | 'probe_error'; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof RuntimeProbeError) return { code: error.code, message };
  if (/cannot fork|can't fork|resource temporarily unavailable|pids? limit|unable to spawn|pthread_create.*failed/i.test(message)) {
    return { code: 'pid_limit', message: 'Container kann keine Prozesse starten (PID-/Thread-Limit). Laufende Prozesse durch den Betrieb prüfen lassen; Installation nicht erneut starten.' };
  }
  return { code: 'probe_error', message };
}

/** Docker-Stats lesen ohne im bereits vollen Container noch einen Prozess zu starten. */
export async function assertRuntimePidCapacity(container: Docker.Container, limit: number | undefined): Promise<void> {
  if (!limit || limit < 0) return;
  const stats = await container.stats({ stream: false }).catch(() => null);
  const current = stats?.pids_stats?.current;
  if (typeof current === 'number' && current >= limit) {
    throw new RuntimeProbeError('pid_limit', 'Container kann nicht forken: PID-/Thread-Limit erreicht (' + current + '/' + limit + '). Betrieb muss laufende Prozesse prüfen; Installation nicht erneut starten.');
  }
}

/**
 * Der Timer lebt IM Container, unabhängig von Docker-Stream/API-Lebensdauer.
 * Node gehört zum bestehenden node:22-Runtime-Image. Eigene Prozessgruppe statt
 * pkill/Containerstop: CLI-Wrapper UND dessen Binary/Threads gezielt beenden.
 */
export function buildRuntimeProbeCommand(command: string[], timeoutMs: number): string[] {
  const supervisor = [
    "const { spawn } = require('node:child_process');",
    "const [ms, ...cmd] = process.argv.slice(1);",
    "let child, expired = false, finished = false;",
    "const kill = signal => { if (child?.pid) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') console.error('Runtime-Watchdog: ' + e.message); } } };",
    "const finish = code => { if (finished) return; finished = true; clearTimeout(timer); process.exitCode = code; };",
    "const expire = () => { if (expired || finished) return; expired = true; kill('SIGTERM'); setTimeout(() => { kill('SIGKILL'); finish(124); }, 500); };",
    "const timer = setTimeout(expire, Number(ms));",
    "process.on('SIGTERM', expire); process.on('SIGINT', expire);",
    "child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
    "child.once('error', e => { console.error(e.message); if (!expired) finish(127); });",
    "child.once('close', code => { if (!expired) { kill('SIGKILL'); finish(code ?? 1); } });",
  ].join('\n');
  return ['/usr/local/bin/node', '-e', supervisor, String(timeoutMs), ...command];
}

export async function captureRuntimeProbe(
  docker: Docker, container: Docker.Container, command: string[], env: string[], timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const exec = await container.exec({
    Cmd: buildRuntimeProbeCommand(command, timeoutMs),
    AttachStdout: true, AttachStderr: true, Tty: false, Env: env, WorkingDir: '/projects',
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const containerDeadline = Date.now() + timeoutMs + 750;
  const out = new PassThrough(), err = new PassThrough();
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  out.on('data', (chunk: Buffer) => stdout.push(chunk));
  err.on('data', (chunk: Buffer) => stderr.push(chunk));
  await new Promise<void>((resolve, reject) => {
    // Transport-Sicherung erst NACH dem Container-Watchdog + Kill-Frist.
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new RuntimeProbeError('probe_timeout', 'Runtime-Prüfung ohne Docker-Antwort; Container-Watchdog beendet die eigene Prozessgruppe.'));
    }, timeoutMs + 3_000);
    const done = (error?: Error): void => {
      clearTimeout(timer);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.removeListener('close', onClose);
      // Bei fruehem Streamverlust laeuft der Containerprozess noch bis zum
      // Watchdog. Single-Flight erst DANACH freigeben, sonst startet der nächste
      // Poll einen zweiten Prozess, obwohl der erste noch lebt.
      if (error) setTimeout(() => reject(error), Math.max(0, containerDeadline - Date.now()));
      else resolve();
    };
    const onEnd = (): void => done();
    const onError = (error: Error): void => done(error);
    const onClose = (): void => { if (!stream.readableEnded) done(new Error('Runtime-Prüfung: Docker-Stream vorzeitig geschlossen')); };
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.once('close', onClose);
    docker.modem.demuxStream(stream, out, err);
  });
  const info = await exec.inspect();
  const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode: info.ExitCode ?? null };
  if (result.exitCode === 124) throw new RuntimeProbeError('probe_timeout', 'Runtime-Prüfung nach ' + timeoutMs + 'ms abgebrochen; eigene Prozessgruppe im Container beendet.');
  const diagnostic = runtimeProbeDiagnostic(result.stderr + '\n' + result.stdout);
  if (diagnostic.code === 'pid_limit') throw new RuntimeProbeError('pid_limit', diagnostic.message);
  return result;
}
