#!/usr/bin/env node
/**
 * Synapse Gemini Specialist Runtime — Iter 2
 *
 * Zwei Modi:
 *
 * (A) STANDALONE (Default): wie Iter 1, CLI-Args + Live-Monitor.
 *     Nutzung: GOOGLE_API_KEY=... node dist/runtime.js "<task>"
 *              [--monitor-port 4789] [--max-turns 30] [--agent-name N]
 *
 * (B) WRAPPER_MODE (SYNAPSE_WRAPPER_MODE=1): vom Synapse-Wrapper gespawnt.
 *     Sprich Claude-CLI-Stream-JSON-Protocol auf stdout, lies Messages von
 *     stdin. JSONL-Output nach ~/.claude/projects/<dashed-cwd>/<sessionId>.jsonl
 *     fuer wrapper.ts:syncTokensFromHistory.
 *     ENV: SYNAPSE_AGENT_NAME, SYNAPSE_AGENT_MODEL, SYNAPSE_PROJECT_PATH,
 *          SYNAPSE_PROJECT_NAME, SYNAPSE_SYSTEM_PROMPT_FILE (optional),
 *          SYNAPSE_AGENT_EXPERTISE (optional), SYNAPSE_AGENT_TASK (optional)
 */

import { GoogleGenAI } from '@google/genai';
import type { Content, FunctionCall, GenerateContentResponse, FunctionResponse } from '@google/genai';
import { writeFile, appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolveModel, STATIC_FALLBACK, readAllSkillFiles, buildSpecialistPrompt } from '@synapse/agents';
import type { ModelEntry } from '@synapse/agents';
import { buildToolBridge } from './tool-bridge.js';
import { MonitorServer } from './monitor-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const RESPAWN_MARKER_PREFIX = '/tmp/.specialist-rotate-pending-';

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

const isWrapperMode = process.env.SYNAPSE_WRAPPER_MODE === '1';

async function main(): Promise<void> {
  const apiKey = await resolveApiKey();
  if (!apiKey) {
    console.error('FEHLER: GOOGLE_API_KEY nicht gesetzt. Setze ENV oder konfiguriere provider_credentials.');
    process.exit(1);
  }

  if (isWrapperMode) {
    await runWrapperMode(apiKey);
  } else {
    await runStandalone(apiKey);
  }
}

/**
 * API-Key-Resolution:
 * - SYNAPSE_GEMINI_USE_EMBEDDING_KEY=true (Default): nutzt GOOGLE_API_KEY env
 * - false: laedt aus DB (Iter 2.5: provider_credentials Tabelle)
 */
async function resolveApiKey(): Promise<string | null> {
  const useEnv = (process.env.SYNAPSE_GEMINI_USE_EMBEDDING_KEY ?? 'true').toLowerCase() !== 'false';
  if (useEnv) {
    return process.env.GOOGLE_API_KEY ?? null;
  }
  // Iter 2.5: DB-Lookup via provider_credentials. Fallback: ENV.
  try {
    const { getProviderCredential } = await import('@synapse/core');
    return (await getProviderCredential('google')) ?? process.env.GOOGLE_API_KEY ?? null;
  } catch {
    return process.env.GOOGLE_API_KEY ?? null;
  }
}

// ---------------------------------------------------------------------------
// (A) Standalone Mode (Iter 1 compat)
// ---------------------------------------------------------------------------

interface CliArgs {
  task: string;
  monitorPort: number;
  maxTurns: number;
  agentName: string;
  modelAlias: string;
}

function parseStandaloneArgs(): CliArgs {
  const args = process.argv.slice(2);
  let task = '';
  let monitorPort = 4789;
  let maxTurns = 30;
  let agentName = 'gemini-iter1-test';
  let modelAlias = 'gemini-flash-lite';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--monitor-port') monitorPort = parseInt(args[++i], 10);
    else if (args[i] === '--max-turns') maxTurns = parseInt(args[++i], 10);
    else if (args[i] === '--agent-name') agentName = args[++i];
    else if (args[i] === '--model') modelAlias = args[++i];
    else if (!task) task = args[i];
  }
  if (!task) {
    console.error('Usage: gemini-runtime.js "<task>" [--monitor-port N] [--max-turns N] [--agent-name N] [--model alias]');
    process.exit(1);
  }
  return { task, monitorPort, maxTurns, agentName, modelAlias };
}

async function runStandalone(apiKey: string): Promise<void> {
  const cli = parseStandaloneArgs();
  const model = resolveModel(cli.modelAlias) ?? STATIC_FALLBACK['gemini-flash-lite'];

  const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const logDir = join(__dirname, '..', 'logs');
  if (!existsSync(logDir)) await mkdir(logDir, { recursive: true });
  const logPath = join(logDir, `${runId}.jsonl`);
  await writeFile(logPath, '');

  const monitor = new MonitorServer(logPath);
  const url = await monitor.start(cli.monitorPort);
  console.error(`[Gemini Runtime] Live-Monitor: ${url}`);

  const log = async (type: Parameters<typeof monitor.emit>[0], payload: Record<string, unknown>) => {
    const ev = monitor.emit(type, payload);
    await appendFile(logPath, JSON.stringify(ev) + '\n');
  };

  const bridge = buildToolBridge();
  console.error(`[Gemini Runtime] ${bridge.declarations.length} Tools registriert. ${bridge.warnings.length} Schema-Warnings.`);

  await log('start', {
    runId, model: model.fullId, modelAlias: model.alias, provider: model.provider,
    contextCeiling: model.contextWindow, task: cli.task,
    toolCount: bridge.declarations.length, schemaWarnings: bridge.warnings.length,
  });

  const ai = new GoogleGenAI({ apiKey });
  const history: Content[] = [{ role: 'user', parts: [{ text: cli.task }] }];

  const systemInstruction = `Du bist ein Synapse-Specialist (${cli.agentName}). Du hast Zugriff auf alle Synapse-MCP-Tools (mcp__synapse__project, mcp__synapse__search, mcp__synapse__memory, mcp__synapse__thought, mcp__synapse__channel, mcp__synapse__chat, mcp__synapse__code_intel, mcp__synapse__files, etc.). Arbeite die User-Aufgabe systematisch ab. Antworte konkret und faktisch.`;

  await runConversationLoop({
    ai, model, bridge, history, systemInstruction,
    maxTurns: cli.maxTurns, agentName: cli.agentName,
    onEvent: log,
  });

  console.error(`[Gemini Runtime] Done. Log: ${logPath}`);
  console.error(`[Gemini Runtime] Monitor laeuft weiter auf ${url}`);
}

// ---------------------------------------------------------------------------
// (B) Wrapper Mode (vom Synapse-Wrapper gespawnt)
// ---------------------------------------------------------------------------

interface WrapperEnv {
  agentName: string;
  modelAlias: string;
  projectPath: string;
  projectName: string;
  systemPromptFile?: string;
  expertise?: string;
  task?: string;
  sessionId: string;
}

function readWrapperEnv(): WrapperEnv {
  const required = (key: string): string => {
    const v = process.env[key];
    if (!v) {
      console.error(`FEHLER: ENV ${key} nicht gesetzt (WRAPPER_MODE=1 erfordert das)`);
      process.exit(1);
    }
    return v;
  };
  return {
    agentName: required('SYNAPSE_AGENT_NAME'),
    modelAlias: required('SYNAPSE_AGENT_MODEL'),
    projectPath: required('SYNAPSE_PROJECT_PATH'),
    projectName: process.env.SYNAPSE_PROJECT_NAME ?? '',
    systemPromptFile: process.env.SYNAPSE_SYSTEM_PROMPT_FILE,
    expertise: process.env.SYNAPSE_AGENT_EXPERTISE,
    task: process.env.SYNAPSE_AGENT_TASK,
    sessionId: process.env.SYNAPSE_SESSION_ID ?? randomUUID(),
  };
}

/** Stream-JSON-Event auf stdout schreiben (Claude-CLI-Format) */
function emitStdout(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

async function runWrapperMode(apiKey: string): Promise<void> {
  const env = readWrapperEnv();
  const model = resolveModel(env.modelAlias);
  if (!model) {
    console.error(`FEHLER: Unbekannter Modell-Alias "${env.modelAlias}". Verfuegbar: ${Object.keys(STATIC_FALLBACK).join(', ')}`);
    process.exit(1);
  }

  // System-Prompt zusammenbauen: entweder aus File oder aus Skill-Files
  let systemInstruction: string;
  if (env.systemPromptFile) {
    systemInstruction = await readFile(env.systemPromptFile, 'utf-8');
  } else {
    const skillContent = await readAllSkillFiles(env.projectPath, env.agentName);
    systemInstruction = buildSpecialistPrompt(
      {
        name: env.agentName,
        // Cast: SpecialistConfig.model ist heute Claude-Union; Iter 2.5 erweitert.
        // buildSpecialistPrompt nutzt model nur als Display-String.
        model: model.fullId as never,
        expertise: env.expertise ?? '(unspezifiziert)',
        task: env.task ?? '(keine Aufgabe gesetzt)',
        project: env.projectName,
      },
      skillContent,
    );
  }

  // Init-Event als ALLERERSTE stdout-Zeile (B1/P12)
  emitStdout({
    type: 'system',
    subtype: 'init',
    session_id: env.sessionId,
    cwd: env.projectPath,
    model: model.fullId,
  });

  // JSONL-Writer fuer wrapper.ts:syncTokensFromHistory (P9)
  const claudeProjectsDir = join(homedir(), '.claude', 'projects', dashedPath(env.projectPath));
  await mkdir(claudeProjectsDir, { recursive: true });
  const jsonlPath = join(claudeProjectsDir, `${env.sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const writeJsonl = async (entry: Record<string, unknown>): Promise<void> => {
    // Append-only mit fsync (S2)
    await appendFile(jsonlPath, JSON.stringify(entry) + '\n');
  };

  const bridge = buildToolBridge();
  const ai = new GoogleGenAI({ apiKey });
  const history: Content[] = [];

  // Stdin-Reader fuer eingehende Messages vom Wrapper
  // Wrapper sendet stream-json: jede Zeile ein {type:"user", message:{content:[{type:"text",text:"..."}]}}
  const stdinReader = createInterface({ input: process.stdin });

  const handoffMin = model.corridorMin;
  let totalInput = 0;
  let totalOutput = 0;
  let handoffWarned = false;

  for await (const line of stdinReader) {
    if (!line.trim()) continue;
    let userInput: string;
    try {
      const msg = JSON.parse(line);
      // Wrapper-Format: { type: "user", message: { content: [{ type: "text", text: "..." }] } }
      // Oder einfacher String — tolerant beides
      if (typeof msg === 'string') {
        userInput = msg;
      } else if (msg.message?.content) {
        userInput = (msg.message.content as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'text')
          .map(b => b.text ?? '')
          .join('');
      } else if (msg.text) {
        userInput = msg.text;
      } else {
        userInput = JSON.stringify(msg);
      }
    } catch {
      userInput = line;
    }

    history.push({ role: 'user', parts: [{ text: userInput }] });

    // Conversation-Loop mit Ping-Heartbeat (S1/P13)
    let pingTimer: NodeJS.Timeout | null = null;
    const startPing = () => {
      pingTimer = setInterval(() => {
        emitStdout({ type: 'ping' });
      }, 30_000);
    };
    const stopPing = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    };

    const result = await runConversationLoop({
      ai, model, bridge, history, systemInstruction,
      maxTurns: 50, agentName: env.agentName,
      onEvent: async () => { /* no monitor in wrapper mode */ },
      onAssistantText: (text) => {
        emitStdout({
          type: 'assistant',
          message: { content: [{ type: 'text', text }] },
        });
      },
      onPingControl: (start) => start ? startPing() : stopPing(),
      onUsage: async (usage) => {
        totalInput = usage.totalInput;
        totalOutput = usage.totalOutput;
        // JSONL-Entry im Claude-Format fuer syncTokensFromHistory
        await writeJsonl({
          message: {
            usage: {
              input_tokens: totalInput,
              output_tokens: totalOutput,
              cache_read_input_tokens: usage.cachedTokens ?? 0,
              cache_creation_input_tokens: 0,
            },
          },
        });
      },
    });

    stopPing();

    // Auto-Handoff-Check: bei Korridor → mcp__synapse__thought trigger_respawn aufrufen
    // (P14 — KEIN direkter Marker-Write mehr im WRAPPER_MODE)
    const ctxPct = ((totalInput + totalOutput) / model.contextWindow) * 100;
    if (!handoffWarned && ctxPct >= handoffMin) {
      handoffWarned = true;
      try {
        await bridge.dispatch('thought', {
          action: 'add',
          project: env.projectName,
          source: env.agentName,
          content: `AUTO-HANDOFF: Context ${Math.round(ctxPct)}% erreicht (Korridor ${handoffMin}%)`,
          tags: ['auto-handoff'],
          trigger_respawn: true,
        });
      } catch (err) {
        console.error(`[Runtime] trigger_respawn fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Result-Event auf stdout (Claude-Format) — wrapper.ts braucht das fuer Turn-Ende-Erkennung
    emitStdout({
      type: 'result',
      result: result.lastText ?? '',
      usage: {
        input_tokens: totalInput,
        output_tokens: totalOutput,
      },
    });
  }
}

function dashedPath(p: string): string {
  // Claude CLI nutzt '-home-blacky-dev-synapse' fuer '/home/blacky/dev/synapse'
  return p.replace(/\//g, '-');
}

// ---------------------------------------------------------------------------
// Shared Conversation Loop
// ---------------------------------------------------------------------------

interface LoopOptions {
  ai: GoogleGenAI;
  model: ModelEntry;
  bridge: ReturnType<typeof buildToolBridge>;
  history: Content[];
  systemInstruction: string;
  maxTurns: number;
  agentName: string;
  onEvent: (type: 'start' | 'usage' | 'assistant' | 'function_call' | 'function_response' | 'error' | 'done' | 'respawn_marker', payload: Record<string, unknown>) => Promise<void>;
  onAssistantText?: (text: string) => void;
  onPingControl?: (start: boolean) => void;
  onUsage?: (usage: { totalInput: number; totalOutput: number; cachedTokens: number }) => Promise<void>;
}

async function runConversationLoop(opts: LoopOptions): Promise<{ lastText: string }> {
  let totalInput = 0;
  let totalOutput = 0;
  let cachedTokens = 0;
  let lastText = '';

  for (let turn = 1; turn <= opts.maxTurns; turn++) {
    let response: GenerateContentResponse;
    try {
      response = await opts.ai.models.generateContent({
        model: opts.model.fullId,
        contents: opts.history,
        config: {
          tools: [{ functionDeclarations: opts.bridge.declarations }],
          systemInstruction: opts.systemInstruction,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await opts.onEvent('error', { turn, message: msg });
      console.error(`[Runtime] Turn ${turn} API-Fehler: ${msg}`);
      break;
    }

    const usage = response.usageMetadata ?? {};
    totalInput = Number(usage.promptTokenCount ?? totalInput);
    totalOutput += Number(usage.candidatesTokenCount ?? 0);
    cachedTokens = Number(usage.cachedContentTokenCount ?? cachedTokens);

    if (opts.onUsage) {
      await opts.onUsage({ totalInput, totalOutput, cachedTokens });
    }
    await opts.onEvent('usage', { turn, inputTokens: totalInput, outputTokens: totalOutput, cachedTokens });

    const text = response.text ?? '';
    if (text) {
      lastText = text;
      await opts.onEvent('assistant', { turn, text });
      opts.onAssistantText?.(text);
    }

    const functionCalls: FunctionCall[] = response.functionCalls ?? [];
    if (functionCalls.length === 0) {
      if (response.candidates?.[0]?.content) {
        opts.history.push(response.candidates[0].content);
      }
      break;
    }

    if (response.candidates?.[0]?.content) {
      opts.history.push(response.candidates[0].content);
    }

    // Tool-Calls dispatchen — Ping einschalten weil das dauern kann (S1)
    opts.onPingControl?.(true);

    const responseParts: { functionResponse: FunctionResponse }[] = [];
    await Promise.all(functionCalls.map(async (call) => {
      await opts.onEvent('function_call', { turn, name: call.name, args: call.args ?? {}, id: call.id });
      const result = await opts.bridge.dispatch(call.name ?? '', (call.args ?? {}) as Record<string, unknown>);
      await opts.onEvent('function_response', { turn, name: call.name, id: call.id, result });
      responseParts.push({
        functionResponse: {
          id: call.id,
          name: call.name ?? '',
          response: { result } as Record<string, unknown>,
        },
      });
    }));

    opts.onPingControl?.(false);
    opts.history.push({ role: 'user', parts: responseParts });
  }

  await opts.onEvent('done', { totalInput, totalOutput, cachedTokens });
  return { lastText };
}

main().catch((err) => {
  console.error('[Gemini Runtime] Fataler Fehler:', err);
  process.exit(1);
});
