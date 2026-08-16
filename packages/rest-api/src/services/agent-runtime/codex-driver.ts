import Docker from 'dockerode';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AgentRuntimeRepository } from './repository.js';
import type {
  AgentRuntimeDriver,
  MainAgentSession,
  RuntimeConfiguration,
  RuntimeMessageResult,
  RuntimeStatus,
  RuntimeStreamEvent,
  TerminalSession,
} from './types.js';

const DEFAULT_IMAGE = 'node:22-bookworm-slim';
const DEFAULT_ROOT = '/mnt/user/synapse-agent-runtime/codex';
const INSTALL_COMMAND = 'mkdir -p /root/.local && npm install --global --prefix /root/.local @openai/codex@latest';

export function validateRuntimeImage(image: string): string {
  const value = image.trim();
  if (!value || value.length > 255 || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value)) {
    throw new Error('image ist keine gueltige Docker-Image-Referenz');
  }
  const allowed = (process.env.AGENT_RUNTIME_ALLOWED_IMAGES || DEFAULT_IMAGE)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!allowed.includes(value)) {
    throw new Error('image ist nicht in AGENT_RUNTIME_ALLOWED_IMAGES freigegeben');
  }
  return value;
}

export function persistentRuntimeBinds(root: string): string[] {
  return [
    root + '/home:/root',
    root + '/projects:/projects',
    root + '/state:/state',
    root + '/attachments:/attachments',
  ];
}

export function cumulativeTextDelta(previous: string, current: string): string {
  if (!previous) return current;
  if (current === previous) return '';
  return current.startsWith(previous) ? current.slice(previous.length) : current;
}

export function validateRuntimeRoot(rootPath: string): string {
  const value = rootPath.trim().replace(/\/+$/, '');
  if (!value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) {
    throw new Error('rootPath muss ein absoluter Pfad ohne Traversal sein');
  }
  const allowed = (process.env.AGENT_RUNTIME_ALLOWED_ROOTS || '/mnt/user')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (!allowed.some((base) => value === base || value.startsWith(base + '/'))) {
    throw new Error('rootPath liegt ausserhalb AGENT_RUNTIME_ALLOWED_ROOTS (' + allowed.join(', ') + ')');
  }
  return value;
}

export interface ParsedCodexEvent {
  runtimeSessionId?: string;
  messageId?: string;
  messageText?: string;
  usage?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export function parseCodexJsonLine(line: string): ParsedCodexEvent {
  const value = JSON.parse(line) as Record<string, unknown>;
  const type = String(value.type || '');
  if (type === 'thread.started') {
    return { runtimeSessionId: String(value.thread_id || value.threadId || '') || undefined };
  }
  if (type === 'item.completed' || type === 'item.updated') {
    const item = value.item as Record<string, unknown> | undefined;
    if (item?.type === 'agent_message') {
      const text = item.text ?? item.content;
      if (typeof text === 'string') {
        return {
          messageId: String(item.id ?? 'agent-message'),
          messageText: text,
        };
      }
    }
  }
  if (type === 'turn.completed') {
    const usage = value.usage as Record<string, unknown> | undefined;
    if (usage) {
      return {
        usage: {
          inputTokens: usage.input_tokens ?? usage.inputTokens,
          outputTokens: usage.output_tokens ?? usage.outputTokens,
          cachedInputTokens: usage.cached_input_tokens ?? usage.cachedInputTokens,
        },
        context: { usage },
      };
    }
  }
  return {};
}

export function buildCodexCommand(runtimeSessionId: string | null): string[] {
  const common = ['codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', '/projects'];
  return runtimeSessionId
    ? [...common, 'resume', runtimeSessionId, '-']
    : [...common, '-'];
}

export class CodexRuntimeDriver implements AgentRuntimeDriver {
  readonly runtime = 'codex' as const;
  readonly label = 'Codex CLI';
  private readonly docker: Docker;

  constructor(
    private readonly repository: AgentRuntimeRepository,
    docker?: Docker,
  ) {
    this.docker = docker ?? new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  }

  async configure(input: { rootPath: string; image?: string }): Promise<RuntimeStatus> {
    // Die gesamte neue Konfiguration wird validiert, bevor die laufende Runtime
    // auch nur beruehrt wird. Ein Tippfehler darf keinen gesunden Container stoppen.
    const rootPath = validateRuntimeRoot(input.rootPath);
    const image = validateRuntimeImage(input.image || DEFAULT_IMAGE);
    const previous = await this.repository.get('codex');
    if (previous && (previous.rootPath !== rootPath || previous.image !== image)) {
      await this.removeContainer(previous).catch(() => undefined);
    }
    await this.repository.configure('codex', rootPath, image);
    return this.status();
  }

  async setup(): Promise<RuntimeStatus> {
    const config = await this.ensureConfig();
    try {
      await this.ensureImage(config.image);
      const container = await this.ensureContainer(config);
      await this.ensureRunning(container);
      await this.ensureTrustStore(container);
      const installed = await this.execCapture(container, ['/bin/sh', '-lc', 'command -v codex >/dev/null 2>&1']);
      if (installed.exitCode !== 0) {
        const install = await this.execCapture(container, ['/bin/sh', '-lc', INSTALL_COMMAND], 300_000);
        if (install.exitCode !== 0) throw new Error('Codex-Installation fehlgeschlagen: ' + install.stderr.slice(-1000));
      }
      const version = await this.execCapture(container, ['codex', '--version']);
      await this.repository.updateObserved('codex', {
        containerId: container.id,
        status: 'running',
        installed: version.exitCode === 0,
        version: version.stdout.trim() || version.stderr.trim() || null,
        lastError: null,
      });
    } catch (error) {
      await this.repository.updateObserved('codex', { status: 'error', lastError: (error as Error).message });
      throw error;
    }
    return this.status();
  }

  async start(): Promise<RuntimeStatus> {
    const config = await this.ensureConfig();
    const container = await this.ensureContainer(config);
    await this.ensureRunning(container);
    await this.repository.updateObserved('codex', { containerId: container.id, status: 'running', lastError: null });
    return this.status();
  }

  async stop(): Promise<RuntimeStatus> {
    const config = await this.ensureConfig();
    try {
      const container = this.docker.getContainer(config.containerName);
      const info = await container.inspect();
      if (info.State?.Running) await container.stop({ t: 10 }).catch(() => undefined);
    } catch {
      // Ein noch nie erstellter oder bereits entfernter Container ist bereits gestoppt.
    }
    await this.repository.clearContainer('codex');
    return this.status();
  }

  async status(): Promise<RuntimeStatus> {
    const stored = await this.repository.get('codex');
    if (!stored) {
      return {
        runtime: 'codex',
        role: 'main',
        configured: false,
        installed: false,
        rootPath: DEFAULT_ROOT,
        image: DEFAULT_IMAGE,
        model: null,
        container: { name: 'synapse-runtime-codex', id: null, status: 'not_created' },
        authentication: { status: 'unknown' },
        version: null,
        lastError: null,
        assignedToMain: false,
      };
    }
    const config = stored;
    let containerState: RuntimeStatus['container']['status'] = 'not_created';
    let containerId: string | null = null;
    let installed = false;
    let version: string | null = null;
    let authStatus: RuntimeStatus['authentication']['status'] = 'unknown';
    let authMethod: string | undefined;
    let lastError: string | null = null;

    try {
      await this.docker.ping();
      const container = this.docker.getContainer(config.containerName);
      const info = await container.inspect();
      containerId = info.Id;
      containerState = info.State?.Running ? 'running' : info.State?.Status === 'created' ? 'created' : 'stopped';
      if (info.State?.Running) {
        const versionResult = await this.execCapture(container, ['codex', '--version']);
        installed = versionResult.exitCode === 0;
        version = installed ? (versionResult.stdout || versionResult.stderr).trim() : null;
        if (installed) {
          const login = await this.execCapture(container, ['codex', 'login', 'status']);
          const loginText = (login.stdout + '\n' + login.stderr).trim();
          authStatus = login.exitCode === 0 ? 'authenticated' : 'not_authenticated';
          if (login.exitCode === 0) authMethod = loginText.replace(/^Logged in using\s+/i, '').trim() || 'unknown';
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (!/no such container/i.test(message)) {
        containerState = 'error';
        lastError = message;
      }
    }

    await this.repository.updateObserved('codex', {
      containerId,
      status: containerState,
      installed,
      authStatus,
      authMethod: authMethod ?? null,
      version,
      lastError,
    }).catch(() => undefined);

    return {
      runtime: 'codex',
      role: 'main',
      configured: Boolean(stored),
      installed,
      rootPath: config.rootPath || DEFAULT_ROOT,
      image: config.image || DEFAULT_IMAGE,
      model: config.model,
      container: { name: config.containerName, id: containerId, status: containerState },
      authentication: { status: authStatus, ...(authMethod ? { method: authMethod } : {}) },
      version,
      lastError,
      assignedToMain: config.assignedToMain,
    };
  }

  async openTerminal(input: { cols?: number; rows?: number; command?: string } = {}): Promise<TerminalSession> {
    const config = await this.ensureConfig();
    const container = await this.ensureContainer(config);
    await this.ensureRunning(container);
    await this.ensureTrustStore(container);
    const command = input.command?.trim() || 'exec /bin/sh';
    const exec = await container.exec({
      // Kein Login-Shell-Flag: -l würde den expliziten Runtime-PATH überschreiben
      // und /root/.local/bin/codex im interaktiven Terminal unsichtbar machen.
      Cmd: ['/bin/sh', '-c', command],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: '/projects',
      Env: this.runtimeEnv(),
    });
    const stream = await exec.start({
      hijack: true,
      stdin: true,
      Tty: true,
    }) as unknown as NodeJS.ReadWriteStream;
    await exec.resize({
      h: this.clamp(input.rows, 8, 200, 30),
      w: this.clamp(input.cols, 20, 400, 120),
    });
    return {
      id: randomUUID(),
      runtime: 'codex',
      stream,
      exec,
      createdAt: new Date(),
    };
  }

  async sendMessage(
    session: MainAgentSession,
    message: string,
    emit: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<RuntimeMessageResult> {
    if (!message.trim()) throw new Error('message darf nicht leer sein');
    const config = await this.ensureConfig();
    const container = await this.ensureContainer(config);
    await this.ensureRunning(container);
    await this.ensureTrustStore(container);

    const exec = await container.exec({
      Cmd: buildCodexCommand(session.runtimeSessionId),
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/projects',
      Env: this.runtimeEnv(),
    });
    const stream = await exec.start({ hijack: true, stdin: true }) as unknown as NodeJS.ReadWriteStream;
    const abort = (): void => (stream as NodeJS.ReadWriteStream & { destroy(error?: Error): void }).destroy(new Error('Client hat den Chat-Stream geschlossen'));
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);

    let runtimeSessionId = session.runtimeSessionId;
    let context: Record<string, unknown> | null = session.context;
    const messageSnapshots = new Map<string, string>();
    let pending = '';
    stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        emit({ event: 'runtime', data: { event: this.safeJson(line) } });
        try {
          const parsed = parseCodexJsonLine(line);
          if (parsed.runtimeSessionId) {
            runtimeSessionId = parsed.runtimeSessionId;
            void this.repository.updateSession(session.id, {
              runtimeSessionId,
              status: 'running',
            }).catch(() => undefined);
          }
          if (parsed.messageText !== undefined) {
            const key = parsed.messageId || 'agent-message';
            const delta = cumulativeTextDelta(messageSnapshots.get(key) ?? '', parsed.messageText);
            messageSnapshots.set(key, parsed.messageText);
            if (delta) emit({ event: 'delta', data: { content: delta } });
          }
          if (parsed.usage) emit({ event: 'usage', data: parsed.usage });
          if (parsed.context) context = parsed.context;
        } catch {
          // Nicht-JSON-Ausgabe wird als Runtime-Event sichtbar, aber bricht den Stream nicht.
        }
      }
    });
    stderr.on('data', (chunk: Buffer) => {
      emit({ event: 'runtime', data: { stream: 'stderr', content: chunk.toString('utf8') } });
    });

    try {
      stream.write(message);
      stream.end();
      await new Promise<void>((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
      });
      if (pending.trim()) emit({ event: 'runtime', data: { event: this.safeJson(pending) } });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
    const info = await exec.inspect();
    if (info.ExitCode !== 0) throw new Error('Codex exec endete mit Exit-Code ' + String(info.ExitCode));
    return { runtimeSessionId, context };
  }

  private async ensureConfig(): Promise<RuntimeConfiguration> {
    return this.repository.ensureCodex();
  }

  private runtimeEnv(): string[] {
    return [
      'HOME=/root',
      'CODEX_HOME=/root/.codex',
      'SSL_CERT_FILE=/root/.local/share/ca-certificates.crt',
      'PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ];
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
      return;
    } catch {
      const stream = await this.docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (error) => error ? reject(error) : resolve());
      });
    }
  }

  private async ensureContainer(config: RuntimeConfiguration): Promise<Docker.Container> {
    try {
      const existing = this.docker.getContainer(config.containerName);
      const info = await existing.inspect();
      this.assertOwnedContainer(config, info);
      return existing;
    } catch (error) {
      if (!/no such container/i.test((error as Error).message)) throw error;
      const root = validateRuntimeRoot(config.rootPath);
      return this.docker.createContainer({
        name: config.containerName,
        Image: config.image,
        Labels: {
          'synapse.agent-runtime': 'true',
          'synapse.runtime': 'codex',
          'synapse.agent-role': 'main',
          'synapse.runtime-root': root,
        },
        Env: this.runtimeEnv(),
        WorkingDir: '/projects',
        Tty: false,
        OpenStdin: false,
        Cmd: ['/bin/sh', '-lc', 'mkdir -p /root/.local /root/.codex /projects /state /attachments; exec tail -f /dev/null'],
        HostConfig: {
          NetworkMode: process.env.AGENT_RUNTIME_DOCKER_NETWORK || 'proxynet',
          AutoRemove: false,
          Init: true,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          // Docker legt fehlende Bind-Source-Verzeichnisse auf dem Host an.
          // Der Container-Start initialisiert darin HOME sowie alle vier Runtime-Bereiche.
          Binds: persistentRuntimeBinds(root),
          Memory: 2 * 1024 * 1024 * 1024,
          MemorySwap: 2 * 1024 * 1024 * 1024,
          PidsLimit: 256,
          SecurityOpt: ['no-new-privileges:true'],
          Tmpfs: { '/tmp': 'size=256m,exec' },
        },
      });
    }
  }

  private assertOwnedContainer(config: RuntimeConfiguration, info: Docker.ContainerInspectInfo): void {
    const labels = info.Config?.Labels ?? {};
    const expectedBinds = persistentRuntimeBinds(validateRuntimeRoot(config.rootPath)).sort();
    const actualBinds = [...(info.HostConfig?.Binds ?? [])].sort();
    const owned = labels['synapse.agent-runtime'] === 'true'
      && labels['synapse.runtime'] === this.runtime
      && labels['synapse.agent-role'] === 'main'
      && labels['synapse.runtime-root'] === config.rootPath
      && info.Config?.Image === config.image
      && JSON.stringify(actualBinds) === JSON.stringify(expectedBinds);
    if (!owned) throw new Error('Containername ist durch einen fremden oder abweichend konfigurierten Container belegt');
  }

  private async ensureRunning(container: Docker.Container): Promise<void> {
    const info = await container.inspect();
    if (!info.State?.Running) await container.start();
  }

  private async removeContainer(config: RuntimeConfiguration): Promise<void> {
    try {
      const container = this.docker.getContainer(config.containerName);
      const info = await container.inspect();
      this.assertOwnedContainer(config, info);
      await container.remove({ force: true });
    } catch (error) {
      if (!/no such container/i.test((error as Error).message)) throw error;
    }
    await this.repository.clearContainer('codex');
  }

  private async ensureTrustStore(container: Docker.Container): Promise<void> {
    const sourcePath = process.env.AGENT_RUNTIME_CA_BUNDLE || '/etc/ssl/certs/ca-certificates.crt';
    const certificateBundle = await readFile(sourcePath);
    if (certificateBundle.length === 0) {
      throw new Error('CA-Zertifikatsspeicher ist leer: ' + sourcePath);
    }

    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', 'mkdir -p /root/.local/share && cat > /root/.local/share/ca-certificates.crt'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Env: this.runtimeEnv(),
      WorkingDir: '/projects',
    });
    const stream = await exec.start({ hijack: true, stdin: true }) as unknown as NodeJS.ReadWriteStream;
    stream.end(certificateBundle);
    await new Promise<void>((resolve, reject) => {
      stream.once('end', resolve);
      stream.once('error', reject);
    });
    const info = await exec.inspect();
    if (info.ExitCode !== 0) {
      throw new Error('CA-Zertifikatsspeicher konnte nicht in das persistente Runtime-HOME geschrieben werden');
    }
  }

  private async execCapture(
    container: Docker.Container,
    command: string[],
    timeoutMs = 30_000,
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const exec = await container.exec({
      Cmd: command,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Env: this.runtimeEnv(),
      WorkingDir: '/projects',
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    const err = new PassThrough();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    out.on('data', (chunk: Buffer) => stdout.push(chunk));
    err.on('data', (chunk: Buffer) => stderr.push(chunk));
    this.docker.modem.demuxStream(stream, out, err);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        stream.destroy();
        reject(new Error('Runtime-Kommando Timeout nach ' + timeoutMs + 'ms'));
      }, timeoutMs);
      stream.once('end', () => { clearTimeout(timer); resolve(); });
      stream.once('error', (error: Error) => { clearTimeout(timer); reject(error); });
    });
    const info = await exec.inspect();
    return {
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      exitCode: info.ExitCode ?? null,
    };
  }

  private safeJson(line: string): unknown {
    try { return JSON.parse(line); } catch { return { type: 'raw', content: line }; }
  }

  private clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    const numeric = Number(value ?? fallback);
    return Math.max(min, Math.min(max, Number.isFinite(numeric) ? Math.round(numeric) : fallback));
  }
}
