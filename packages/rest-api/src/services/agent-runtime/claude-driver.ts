import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { AgentRuntimeRepository } from './repository.js';
import {
  persistentRuntimeBinds,
  validateRuntimeImage,
  validateRuntimeRoot,
} from './codex-driver.js';
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
const DEFAULT_ROOT = '/mnt/user/synapse-agent-runtime/claude';
const DEFAULT_MODEL = 'sonnet';
const INSTALL_COMMAND = 'mkdir -p /root/.local && npm install --global --prefix /root/.local @anthropic-ai/claude-code@latest';
const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

export interface ParsedClaudeEvent {
  runtimeSessionId?: string;
  delta?: string;
  resultText?: string;
  usage?: Record<string, unknown>;
  context?: Record<string, unknown>;
  debug?: unknown;
  runtimeError?: string;
}

export function validateClaudeModel(model: string): string {
  const value = model.trim();
  if (!value || value.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)) {
    throw new Error('model ist keine gueltige Claude-Modell-ID');
  }
  return value;
}

export function buildClaudeCommand(runtimeSessionId: string | null, model = DEFAULT_MODEL): string[] {
  const validatedModel = validateClaudeModel(model);
  const command = [
    'claude',
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--safe-mode',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--mcp-config',
    EMPTY_MCP_CONFIG,
    '--model',
    validatedModel,
  ];
  return runtimeSessionId ? [...command, '--resume', runtimeSessionId] : command;
}

export function parseClaudeJsonLine(line: string): ParsedClaudeEvent {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { debug: { type: 'raw', content: line } };
  }

  const type = String(value.type || '');
  const sessionId = typeof value.session_id === 'string' ? value.session_id : undefined;
  if (type === 'system' && value.subtype === 'init') {
    return {
      runtimeSessionId: sessionId,
      context: {
        model: value.model,
        apiKeySource: value.apiKeySource,
      },
    };
  }

  if (type === 'stream_event') {
    const event = value.event as Record<string, unknown> | undefined;
    const delta = event?.delta as Record<string, unknown> | undefined;
    if (event?.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return { runtimeSessionId: sessionId, delta: delta.text };
    }
    if (event?.type === 'message_delta') {
      const usage = event.usage as Record<string, unknown> | undefined;
      return usage ? { runtimeSessionId: sessionId, usage: normalizeClaudeUsage(usage) } : {};
    }
  }

  if (type === 'result') {
    const usage = value.usage as Record<string, unknown> | undefined;
    return {
      runtimeSessionId: sessionId,
      resultText: typeof value.result === 'string' ? value.result : undefined,
      usage: usage ? normalizeClaudeUsage(usage) : undefined,
      runtimeError: value.is_error === true
        ? String(value.result || value.subtype || 'Claude Runtime meldete einen Fehler')
        : undefined,
      context: {
        subtype: value.subtype,
        isError: value.is_error,
        modelUsage: value.modelUsage,
        totalCostUsd: value.total_cost_usd,
        durationMs: value.duration_ms,
        durationApiMs: value.duration_api_ms,
        numTurns: value.num_turns,
        usage,
      },
    };
  }

  if (type === 'rate_limit_event') {
    return { runtimeSessionId: sessionId, debug: value };
  }
  if (type === 'assistant') {
    return { runtimeSessionId: sessionId };
  }
  return { runtimeSessionId: sessionId, debug: value };
}

function normalizeClaudeUsage(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens,
    outputTokens: usage.output_tokens ?? usage.outputTokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? usage.cacheReadInputTokens,
  };
}

export function appendClaudeJsonlChunk(pending: string, chunk: string): { lines: string[]; pending: string } {
  const parts = (pending + chunk).split('\n');
  return { lines: parts.slice(0, -1), pending: parts.at(-1) ?? '' };
}

export function buildClaudeRunnerCommand(): string {
  return [
    'child=""',
    'terminate() { if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; fi; }',
    'cleanup() { rm -f "$SYNAPSE_CLAUDE_PID_FILE"; }',
    "trap 'terminate' TERM INT",
    "trap 'cleanup' EXIT",
    '"$@" <&0 & child=$!',
    'printf "%s %s\\n" "$$" "$child" > "$SYNAPSE_CLAUDE_PID_FILE"',
    'wait "$child"',
  ].join('; ');
}

export function buildClaudeAbortCommand(pidPath: string): string[] {
  const script = [
    'pid_file="$1"',
    'attempt=0',
    'while [ ! -s "$pid_file" ] && [ "$attempt" -lt 40 ]; do sleep 0.05; attempt=$((attempt + 1)); done',
    'if [ ! -s "$pid_file" ]; then exit 0; fi',
    'read -r wrapper child < "$pid_file"',
    'is_pid() { case "$1" in ""|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }',
    'for pid in "$child" "$wrapper"; do if is_pid "$pid"; then kill -TERM "$pid" 2>/dev/null || true; fi; done',
    'sleep 1',
    'for pid in "$child" "$wrapper"; do if is_pid "$pid" && kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi; done',
    'rm -f -- "$pid_file"',
  ].join('; ');
  return ['/bin/sh', '-c', script, 'abort-claude', pidPath];
}

export class ClaudeRuntimeDriver implements AgentRuntimeDriver {
  readonly runtime = 'claude' as const;
  readonly label = 'Claude Code';
  private readonly docker: Docker;

  constructor(
    private readonly repository: AgentRuntimeRepository,
    docker?: Docker,
  ) {
    this.docker = docker ?? new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  }

  async configure(input: { rootPath: string; image?: string; model?: string }): Promise<RuntimeStatus> {
    const rootPath = validateRuntimeRoot(input.rootPath);
    const image = validateRuntimeImage(input.image || DEFAULT_IMAGE);
    const previous = await this.repository.get(this.runtime);
    const model = validateClaudeModel(input.model ?? previous?.model ?? DEFAULT_MODEL);
    if (previous && (previous.rootPath !== rootPath || previous.image !== image)) {
      await this.removeContainer(previous);
    }
    await this.repository.configure(this.runtime, rootPath, image, model);
    return this.status();
  }

  async setup(): Promise<RuntimeStatus> {
    const config = await this.ensureConfig();
    try {
      await this.ensureImage(config.image);
      const container = await this.ensureContainer(config);
      await this.ensureRunning(container);
      await this.ensureTrustStore(container);
      const installed = await this.execCapture(container, ['/usr/bin/env', '-u', 'ANTHROPIC_API_KEY', 'claude', '--version']);
      if (installed.exitCode !== 0) {
        const install = await this.execCapture(container, ['/bin/sh', '-lc', INSTALL_COMMAND], 300_000);
        if (install.exitCode !== 0) {
          throw new Error('Claude-Code-Installation fehlgeschlagen: ' + install.stderr.slice(-1000));
        }
      }
      const version = await this.execCapture(container, ['claude', '--version']);
      await this.repository.updateObserved(this.runtime, {
        containerId: container.id,
        status: 'running',
        installed: version.exitCode === 0,
        version: version.stdout.trim() || version.stderr.trim() || null,
        lastError: null,
      });
    } catch (error) {
      await this.repository.updateObserved(this.runtime, { status: 'error', lastError: (error as Error).message });
      throw error;
    }
    return this.status();
  }

  async start(): Promise<RuntimeStatus> {
    const config = await this.ensureConfig();
    const container = await this.ensureContainer(config);
    await this.ensureRunning(container);
    await this.repository.updateObserved(this.runtime, {
      containerId: container.id,
      status: 'running',
      lastError: null,
    });
    return this.status();
  }

  async stop(): Promise<RuntimeStatus> {
    const config = await this.ensureConfig();
    try {
      const container = this.docker.getContainer(config.containerName);
      const info = await container.inspect();
      this.assertOwnedContainer(config, info);
      if (info.State?.Running) await container.stop({ t: 10 });
    } catch (error) {
      if (!/no such container/i.test((error as Error).message)) throw error;
      // Ein noch nie erstellter oder bereits entfernter Container ist bereits gestoppt.
    }
    await this.repository.clearContainer(this.runtime);
    return this.status();
  }

  async status(): Promise<RuntimeStatus> {
    const stored = await this.repository.get(this.runtime);
    if (!stored) return this.unconfiguredStatus();

    let containerState: RuntimeStatus['container']['status'] = 'not_created';
    let containerId: string | null = null;
    let installed = false;
    let version: string | null = null;
    let authStatus: RuntimeStatus['authentication']['status'] = 'unknown';
    let authMethod: string | undefined;
    let lastError: string | null = null;

    try {
      await this.docker.ping();
      const container = this.docker.getContainer(stored.containerName);
      const info = await container.inspect();
      this.assertOwnedContainer(stored, info);
      containerId = info.Id;
      containerState = info.State?.Running ? 'running' : info.State?.Status === 'created' ? 'created' : 'stopped';
      if (info.State?.Running) {
        const versionResult = await this.execCapture(container, ['claude', '--version']);
        installed = versionResult.exitCode === 0;
        version = installed ? (versionResult.stdout || versionResult.stderr).trim() : null;
        if (installed) {
          const auth = await this.readAuthentication(container);
          authStatus = auth.status;
          authMethod = auth.method;
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      if (!/no such container/i.test(message)) {
        containerState = 'error';
        lastError = message;
      }
    }

    await this.repository.updateObserved(this.runtime, {
      containerId,
      status: containerState,
      installed,
      authStatus,
      authMethod: authMethod ?? null,
      version,
      lastError,
    }).catch(() => undefined);

    return {
      runtime: this.runtime,
      role: 'main',
      configured: true,
      installed,
      rootPath: stored.rootPath || DEFAULT_ROOT,
      image: stored.image || DEFAULT_IMAGE,
      model: stored.model ?? DEFAULT_MODEL,
      container: { name: stored.containerName, id: containerId, status: containerState },
      authentication: { status: authStatus, ...(authMethod ? { method: authMethod } : {}) },
      version,
      lastError,
      assignedToMain: stored.assignedToMain,
    };
  }

  async openTerminal(input: { cols?: number; rows?: number; command?: string } = {}): Promise<TerminalSession> {
    const config = await this.ensureConfig();
    const container = await this.ensureContainer(config);
    await this.ensureRunning(container);
    await this.ensureTrustStore(container);
    const command = input.command?.trim() || 'exec /bin/sh';
    const exec = await container.exec({
      Cmd: ['/usr/bin/env', '-u', 'ANTHROPIC_API_KEY', '/bin/sh', '-c', command],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: '/projects',
      Env: this.runtimeEnv(),
    });
    const stream = await exec.start({ hijack: true, stdin: true, Tty: true }) as unknown as NodeJS.ReadWriteStream;
    await exec.resize({
      h: this.clamp(input.rows, 8, 200, 30),
      w: this.clamp(input.cols, 20, 400, 120),
    });
    return {
      id: randomUUID(),
      runtime: this.runtime,
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

    const pidPath = '/tmp/synapse-claude-' + randomUUID() + '.pid';
    const command = [
      '/usr/bin/env',
      '-u',
      'ANTHROPIC_API_KEY',
      ...buildClaudeCommand(session.runtimeSessionId, config.model ?? DEFAULT_MODEL),
    ];
    const runner = buildClaudeRunnerCommand();
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', runner, 'synapse-claude', ...command],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/projects',
      Env: [...this.runtimeEnv(), 'SYNAPSE_CLAUDE_PID_FILE=' + pidPath],
    });
    const stream = await exec.start({ hijack: true, stdin: true }) as unknown as NodeJS.ReadWriteStream;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    this.docker.modem.demuxStream(stream, stdout, stderr);

    let runtimeSessionId = session.runtimeSessionId;
    let context: Record<string, unknown> | null = session.context;
    let pending = '';
    const decoder = new StringDecoder('utf8');
    let sawDelta = false;
    let runtimeFailure: string | null = null;
    let aborted = false;
    const abort = (): void => {
      if (aborted) return;
      aborted = true;
      void this.terminateExecution(container, pidPath).finally(() => {
        (stream as NodeJS.ReadWriteStream & { destroy(error?: Error): void })
          .destroy(new Error('Client hat den Claude-Stream geschlossen'));
      });
    };
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });

    const processLine = (line: string): void => {
      if (!line.trim()) return;
      const parsed = parseClaudeJsonLine(line);
      if (parsed.runtimeSessionId) {
        runtimeSessionId = parsed.runtimeSessionId;
        void this.repository.updateSession(session.id, {
          runtimeSessionId,
          status: 'running',
        }).catch(() => undefined);
      }
      if (parsed.delta) {
        sawDelta = true;
        emit({ event: 'delta', data: { content: parsed.delta } });
      }
      if (parsed.resultText && !sawDelta && !parsed.runtimeError) {
        sawDelta = true;
        emit({ event: 'delta', data: { content: parsed.resultText } });
      }
      if (parsed.usage) emit({ event: 'usage', data: parsed.usage });
      if (parsed.context) context = { ...(context ?? {}), ...parsed.context };
      if (parsed.debug) emit({ event: 'runtime', data: { event: parsed.debug } });
      if (parsed.runtimeError) runtimeFailure = parsed.runtimeError;
    };
    stdout.on('data', (chunk: Buffer) => {
      const framed = appendClaudeJsonlChunk(pending, decoder.write(chunk));
      pending = framed.pending;
      for (const line of framed.lines) processLine(line);
    });
    stderr.on('data', (chunk: Buffer) => {
      emit({ event: 'runtime', data: { stream: 'stderr', content: chunk.toString('utf8') } });
    });

    try {
      if (!aborted) stream.end(message);
      await new Promise<void>((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
      });
      const decoderTail = decoder.end();
      if (decoderTail) {
        const framed = appendClaudeJsonlChunk(pending, decoderTail);
        pending = framed.pending;
        for (const line of framed.lines) processLine(line);
      }
      if (pending.trim()) processLine(pending);
    } finally {
      signal?.removeEventListener('abort', abort);
      await this.removePidFile(container, pidPath).catch(() => undefined);
    }
    const info = await exec.inspect();
    if (runtimeFailure) throw new Error(runtimeFailure);
    if (info.ExitCode !== 0) throw new Error('Claude exec endete mit Exit-Code ' + String(info.ExitCode));
    return { runtimeSessionId, context };
  }

  private async ensureConfig(): Promise<RuntimeConfiguration> {
    return this.repository.ensureClaude();
  }

  private runtimeEnv(): string[] {
    // ANTHROPIC_API_KEY wird im OAuth-Modus absichtlich gar nicht gesetzt.
    // Ein leerer Wert wuerde Claudes persistente Account-Anmeldung ueberlagern.
    return [
      'HOME=/root',
      'CLAUDE_CONFIG_DIR=/root/.claude',
      'SSL_CERT_FILE=/root/.local/share/ca-certificates.crt',
      'NODE_EXTRA_CA_CERTS=/root/.local/share/ca-certificates.crt',
      'PATH=/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ];
  }

  private unconfiguredStatus(): RuntimeStatus {
    return {
      runtime: this.runtime,
      role: 'main',
      configured: false,
      installed: false,
      rootPath: DEFAULT_ROOT,
      image: DEFAULT_IMAGE,
      model: DEFAULT_MODEL,
      container: { name: 'synapse-runtime-claude', id: null, status: 'not_created' },
      authentication: { status: 'unknown' },
      version: null,
      lastError: null,
      assignedToMain: false,
    };
  }

  private async readAuthentication(container: Docker.Container): Promise<{
    status: RuntimeStatus['authentication']['status'];
    method?: string;
  }> {
    const result = await this.execCapture(
      container,
      ['/usr/bin/env', '-u', 'ANTHROPIC_API_KEY', 'claude', 'auth', 'status', '--json'],
    );
    const raw = (result.stdout || result.stderr).trim();
    try {
      const auth = JSON.parse(raw) as Record<string, unknown>;
      if (auth.loggedIn === true) {
        return {
          status: 'authenticated',
          method: typeof auth.authMethod === 'string' ? auth.authMethod : 'account',
        };
      }
      return { status: 'not_authenticated' };
    } catch {
      return result.exitCode === 0
        ? { status: 'unknown' }
        : { status: 'not_authenticated' };
    }
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
          'synapse.runtime': this.runtime,
          'synapse.agent-role': 'main',
          'synapse.runtime-root': root,
        },
        Env: this.runtimeEnv(),
        WorkingDir: '/projects',
        Tty: false,
        OpenStdin: false,
        Cmd: ['/bin/sh', '-lc', 'mkdir -p /root/.local /root/.claude /projects /state /attachments; exec tail -f /dev/null'],
        HostConfig: {
          NetworkMode: process.env.AGENT_RUNTIME_DOCKER_NETWORK || 'proxynet',
          AutoRemove: false,
          Init: true,
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
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
    await this.repository.clearContainer(this.runtime);
  }

  private async ensureTrustStore(container: Docker.Container): Promise<void> {
    const sourcePath = process.env.AGENT_RUNTIME_CA_BUNDLE || '/etc/ssl/certs/ca-certificates.crt';
    const certificateBundle = await readFile(sourcePath);
    if (certificateBundle.length === 0) throw new Error('CA-Zertifikatsspeicher ist leer: ' + sourcePath);
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
    if (info.ExitCode !== 0) throw new Error('CA-Zertifikatsspeicher konnte nicht ins Runtime-HOME geschrieben werden');
  }

  private async terminateExecution(container: Docker.Container, pidPath: string): Promise<void> {
    await this.execCapture(
      container,
      buildClaudeAbortCommand(pidPath),
      5_000,
    ).catch(() => undefined);
  }

  private async removePidFile(container: Docker.Container, pidPath: string): Promise<void> {
    await this.execCapture(container, ['/bin/sh', '-c', 'rm -f -- "$1"', 'cleanup-claude', pidPath], 5_000);
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

  private clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    const numeric = Number(value ?? fallback);
    return Math.max(min, Math.min(max, Number.isFinite(numeric) ? Math.round(numeric) : fallback));
  }
}
