import Docker from 'dockerode';
import { RuntimeStatusProbe, assertRuntimePidCapacity, captureRuntimeProbe, runtimeProbeDiagnostic } from './probe.js';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { AgentRuntimeRepository } from './repository.js';
import { issueServiceToken } from '../auth.js';
import { leseMainProfil, mainProfileScope, hauptagentIdentitaetScope, type MainToolProfile } from './main-tool-profile.js';
import { leseHauptagentSchalter, hauptagentIdentitaetsId, ausweisFuerStart, HAUPTAGENT_PROJEKT } from '@synapse/core';
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
import { agentRuntimeBasisRoot, pruefeRuntimeRootPersistenz } from './runtime-root.js';

// EINE Quelle (runtime-root.ts) — /mnt/user war rootfs=RAM (Channel 19208).
const DEFAULT_ROOT = agentRuntimeBasisRoot() + '/claude';
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

/**
 * P22-T36 (W2-P1): Kontext fuer den Hauptagenten auf dem Identitaetsweg. Enthaelt NIE den Ausweis: der geht nur per
 * Header (Env-Referenz in der MCP-Config). Profil, Regeln, Nachrichten und Fortsetzung liefert der Server bei jedem Aufruf.
 */
export const HAUPTAGENT_SYSTEMPROMPT = 'Du bist der Synapse-Hauptagent (Identitaet "hauptagent") und sprichst im Web-UI-Chat mit dem User. '
  + 'Deine Identitaet ist dein Synapse-Agenten-Ausweis; die Verbindung schickt ihn bei JEDEM Synapse-Aufruf automatisch mit. '
  + 'Gib ihn nie aus, frage nicht danach und sende kein token-Argument. '
  + 'Zu Beginn einer Sitzung: chat(action:"identitaet") und admin(action:"hauptagent_status") aufrufen; Profil, Regeln, Nachrichten und Fortsetzung kommen mit den Antworten. '
  + 'Nachrichten von Projektkoordinatoren erreichen dich als Hinweise bei deinen Synapse-Aufrufen; beantworte sie ueber chat oder gib sie dem User weiter. '
  + 'Selbstverwaltung (Neustart, Update, Modell-/Runtime-Wechsel) nur ueber admin(action:"hauptagent_auftrag") im erlaubten Rahmen und mit hands_off (Arbeitsstand); '
  + 'Stoppen und Rechteaenderungen entscheidet der User.';

export function buildClaudeCommand(runtimeSessionId: string | null, model = DEFAULT_MODEL, mcpConfig: string | null = null, profile: MainToolProfile = 'artefakt-only', systemPrompt: string | null = null): string[] {
  const validatedModel = validateClaudeModel(model);
  const command = [
    'claude',
    '--print',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
  ];
  // GEMESSEN 26.08.2026 (Probe V1-V5 im echten Runtime-Container): --safe-mode
  // schaltet ALLE MCP-Server still ab (mcp_servers: []), waehrend --tools ''
  // nur die eingebauten Werkzeuge entfernt. Mit MCP-Config muss --safe-mode
  // deshalb WEG — uebrig bleibt genau ein Werkzeug: mcp__synapse__artefakt.
  // NICHT wieder unbedingt setzen: der Fehler ist unsichtbar (kein Fehlertext,
  // der Agent beschreibt Werkzeugaufrufe nur noch als Text).
  if (!mcpConfig) command.push('--safe-mode');
  command.push(
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig ?? EMPTY_MCP_CONFIG,
  );
  if (mcpConfig) {
    // Auflage (26.08.2026): der Hauptagent bekommt GENAU EIN Werkzeug
    // freigeschaltet — nicht den ganzen Synapse-Werkzeugkasten. Die Server-
    // Seite erzwingt dasselbe zusaetzlich (tools/list-Filter + Ablehnung).
    command.push('--allowedTools', profile === 'main-synapse' ? 'mcp__synapse__*' : 'mcp__synapse__artefakt');
  }
  // P22-T36: nur auf dem Identitaetsweg; ohne systemPrompt bleibt der Befehl byte-gleich.
  if (systemPrompt) command.push('--append-system-prompt', systemPrompt);
  command.push('--model', validatedModel);
  return runtimeSessionId ? [...command, '--resume', runtimeSessionId] : command;
}

/**
 * P22-T36: MCP-Config des Identitaetswegs. Bearer an die Main-Identitaet gebunden; der Ausweis steht nie in der Config,
 * sondern als Env-Referenz (die CLI expandiert ${SYNAPSE_AGENT_TOKEN}, Muster mcp-bruecke.ts baueBrueckenConfig).
 */
export function buildHauptagentIdentitaetMcpConfig(url: string, token: string, sessionId: string): string {
  return JSON.stringify({
    mcpServers: {
      synapse: {
        type: 'http',
        url,
        headers: {
          Authorization: 'Bearer ' + token,
          'X-Synapse-Hauptagent-Session': sessionId,
          'X-Synapse-Werkzeugprofil': 'main-synapse',
          'x-synapse-agent-token': '${SYNAPSE_AGENT_TOKEN}',
        },
      },
    },
  });
}

/**
 * Minimal-MCP-Config fuer den Hauptagenten-Container: GENAU EIN Server (die
 * Synapse-REST-Strecke) mit Session-Bindung per Header. Der Container erreicht
 * die API im proxynet unter http://synapse-api:3456 (GEMESSEN 26.08.2026:
 * getent hosts synapse-api -> 172.19.0.2, /health -> {"status":"ok"}).
 */
export function buildHauptagentMcpConfig(url: string, token: string, sessionId: string, profile: MainToolProfile = 'artefakt-only'): string {
  return JSON.stringify({
    mcpServers: {
      synapse: {
        type: 'http',
        url,
        headers: {
          Authorization: 'Bearer ' + token,
          'X-Synapse-Hauptagent-Session': sessionId,
          ...(profile === 'main-synapse' ? { 'X-Synapse-Werkzeugprofil': profile } : {}),
        },
      },
    },
  });
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
    // stdin VOR dem Backgrounding auf fd3 sichern: POSIX gibt einem '&'-Hintergrundjob
    // stdin=/dev/null, und dash (/bin/sh im Container) tut das AUCH bei '<&0' — die Umleitung
    // greift erst NACH der /dev/null-Zuweisung und dupliziert dann nur /dev/null. bash dagegen
    // laesst stdin bei expliziter Umleitung durch; deshalb fiel es lokal nie auf.
    // NICHT auf '<&0' zurueckvereinfachen (gemessen 26.08.2026, Channel 19192/19194).
    'exec 3<&0',
    '"$@" <&3 & child=$!',
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
  private readonly statusProbe = new RuntimeStatusProbe<RuntimeStatus>();

  constructor(
    private readonly repository: AgentRuntimeRepository,
    docker?: Docker,
  ) {
    this.docker = docker ?? new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
  }

  async configure(input: { rootPath: string; image?: string; model?: string }): Promise<RuntimeStatus> {
    this.statusProbe.invalidate();
    const rootPath = validateRuntimeRoot(input.rootPath);
    const image = validateRuntimeImage(input.image || DEFAULT_IMAGE);
    const previous = await this.repository.get(this.runtime);
    const model = validateClaudeModel(input.model ?? previous?.model ?? DEFAULT_MODEL);
    if (previous && (previous.rootPath !== rootPath || previous.image !== image)) {
      await this.removeContainer(previous);
    }
    await this.repository.configure(this.runtime, rootPath, image, model);
    this.statusProbe.invalidate();
    return this.status();
  }

  async setup(): Promise<RuntimeStatus> {
    this.statusProbe.invalidate();
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
    this.statusProbe.invalidate();
    return this.status();
  }

  async start(): Promise<RuntimeStatus> {
    this.statusProbe.invalidate();
    const config = await this.ensureConfig();
    const container = await this.ensureContainer(config);
    await this.ensureRunning(container);
    await this.repository.updateObserved(this.runtime, {
      containerId: container.id,
      status: 'running',
      lastError: null,
    });
    this.statusProbe.invalidate();
    return this.status();
  }

  async stop(): Promise<RuntimeStatus> {
    this.statusProbe.invalidate();
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
    this.statusProbe.invalidate();
    return this.status();
  }

  status(): Promise<RuntimeStatus> {
    return this.statusProbe.run(() => this.probeStatus());
  }

  private async probeStatus(): Promise<RuntimeStatus> {
    const stored = await this.repository.get(this.runtime);
    if (!stored) return this.unconfiguredStatus();

    let containerState: RuntimeStatus['container']['status'] = 'not_created';
    let containerId: string | null = null;
    let installed = false;
    let version: string | null = null;
    let authStatus: RuntimeStatus['authentication']['status'] = 'unknown';
    let authMethod: string | undefined;
    let lastError: string | null = null;
    let diagnostic: RuntimeStatus['diagnostic'];

    try {
      await this.docker.ping();
      const container = this.docker.getContainer(stored.containerName);
      const info = await container.inspect();
      this.assertOwnedContainer(stored, info);
      containerId = info.Id;
      containerState = info.State?.Running ? 'running' : info.State?.Status === 'created' ? 'created' : 'stopped';
      if (info.State?.Running) {
        await assertRuntimePidCapacity(container, info.HostConfig?.PidsLimit);
        const versionResult = await this.execCapture(container, ['claude', '--version'], 5_000);
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
        diagnostic = runtimeProbeDiagnostic(error);
        if (diagnostic.code !== 'pid_limit' && diagnostic.code !== 'probe_timeout') containerState = 'error';
        lastError = diagnostic.message;
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
      ...(diagnostic ? { diagnostic } : {}),
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
    // P22-T36: Identitaetsweg (Schalter hauptagent EIN, Session an die Main-Identitaet gebunden); sonst Altweg unveraendert.
    const haupt = await this.hauptagentIdentitaet(session, emit);
    let profile: MainToolProfile;
    let mcpConfig: string | null;
    if (haupt) {
      profile = 'main-synapse';
      emit({ event: 'runtime', data: { hauptagent: { weg: 'identitaet', identity_id: haupt.identityId } } });
      mcpConfig = await this.hauptagentIdentitaetMcpConfig(session.id, haupt.identityId);
    } else {
      const profilStand = await leseMainProfil();
      profile = profilStand.profile;
      if (profile === 'main-synapse' || profilStand.quelle === 'intern' || profilStand.letzterFehler) {
        emit({ event: 'runtime', data: { werkzeugprofil: profilStand } });
      }
      mcpConfig = await this.hauptagentMcpConfig(session.id, emit, profile);
    }
    const command = [
      '/usr/bin/env',
      '-u',
      'ANTHROPIC_API_KEY',
      ...buildClaudeCommand(session.runtimeSessionId, config.model ?? DEFAULT_MODEL, mcpConfig, profile, haupt ? HAUPTAGENT_SYSTEMPROMPT : null),
    ];
    const runner = buildClaudeRunnerCommand();
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', runner, 'synapse-claude', ...command],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      WorkingDir: '/projects',
      // P22-T36: Ausweis nur als Env fuer die Header-Referenz der MCP-Config (nie im Prompt/Befehl).
      Env: [...this.runtimeEnv(), 'SYNAPSE_CLAUDE_PID_FILE=' + pidPath, ...(haupt ? ['SYNAPSE_AGENT_TOKEN=' + haupt.token] : [])],
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

  /**
   * P22-T36: Identitaetsweg nur bei Schalter hauptagent EIN und wenn die Session an die Main-Identitaet gebunden ist.
   * Ausweis ueber den bestehenden Dienst (derselbe dauerhafte Ausweis, keine Rotation). Fehler: laut melden, Altweg.
   */
  private async hauptagentIdentitaet(
    session: MainAgentSession, emit: (event: RuntimeStreamEvent) => void,
  ): Promise<{ identityId: string; token: string } | null> {
    if (!session.identityId) return null;
    try {
      if (!(await leseHauptagentSchalter()).aktiv) return null;
      if ((await hauptagentIdentitaetsId()) !== session.identityId) return null;
      const a = await ausweisFuerStart(HAUPTAGENT_PROJEKT, session.identityId, { art: 'user' });
      return { identityId: session.identityId, token: a.token };
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      emit({ event: 'runtime', data: { stream: 'stderr',
        content: 'Hauptagent-Identitaet nicht verfuegbar (' + (typeof code === 'string' ? code : 'fehler') + '); Altweg.\n' } });
      return null;
    }
  }

  private async hauptagentIdentitaetMcpConfig(sessionId: string, identityId: string): Promise<string> {
    const issued = await issueServiceToken(hauptagentIdentitaetScope(identityId), 'main-identitaet', 24 * 60 * 60 * 1000);
    const url = process.env.SYNAPSE_HAUPTAGENT_MCP_URL || 'http://synapse-api:3456/';
    return buildHauptagentIdentitaetMcpConfig(url, issued.token, sessionId);
  }

  // Ein Service-Token je Prozesslauf reicht: es lebt nur in der exec-Env des
  // Containers und wird beim naechsten API-Start neu gepraegt (auth_tokens).
  private hauptagentTokenPromise: Promise<string> | null = null;

  private async hauptagentMcpConfig(
    sessionId: string,
    emit: (event: RuntimeStreamEvent) => void,
    profile: MainToolProfile = 'artefakt-only',
  ): Promise<string | null> {
    try {
      if (profile === 'main-synapse') {
        // Minimaler Sessionausweis fuer W0/W2. Kein Daemon-/Tray-Ausweis im CLIkind.
        // Ausstellen nur nach Freigabe; der MCP-Weg prueft sie bei JEDEM Aufruf erneut.
        const issued = await issueServiceToken(mainProfileScope(sessionId), 'main-synapse', 24 * 60 * 60 * 1000);
        const url = process.env.SYNAPSE_HAUPTAGENT_MCP_URL || 'http://synapse-api:3456/';
        return buildHauptagentMcpConfig(url, issued.token, sessionId, profile);
      }
      if (!this.hauptagentTokenPromise) {
        this.hauptagentTokenPromise = issueServiceToken(
          'hauptagent:claude',
          'hauptagent-claude',
          180 * 24 * 60 * 60 * 1000,
        ).then((issued) => issued.token);
      }
      const token = await this.hauptagentTokenPromise;
      const url = process.env.SYNAPSE_HAUPTAGENT_MCP_URL || 'http://synapse-api:3456/';
      return buildHauptagentMcpConfig(url, token, sessionId);
    } catch (error) {
      // Laut statt still (Muster stille Teilantwort): der Chat laeuft ohne das
      // Artefakt-Tool weiter, aber der Grund steht sichtbar im Strom.
      this.hauptagentTokenPromise = null;
      // Ein gebundener neuer Lauf faellt niemals auf privilegierteren Legacy-Zugang zurueck.
      if (profile === 'main-synapse') throw error;
      emit({
        event: 'runtime',
        data: {
          stream: 'stderr',
          content: 'Artefakt-Tool nicht verfuegbar (Service-Token fehlgeschlagen): ' + (error instanceof Error ? error.message : String(error)) + '\n',
        },
      });
      return null;
    }
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
      5_000,
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
      // ⭐ Persistenz-Wache: NIE wieder still eine Runtime ins RAM legen (19208).
      await pruefeRuntimeRootPersistenz(this.docker, config.image, root);
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
    return captureRuntimeProbe(this.docker, container, command, this.runtimeEnv(), timeoutMs);
  }

  private clamp(value: number | undefined, min: number, max: number, fallback: number): number {
    const numeric = Number(value ?? fallback);
    return Math.max(min, Math.min(max, Number.isFinite(numeric) ? Math.round(numeric) : fallback));
  }
}
