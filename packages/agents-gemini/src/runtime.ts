#!/usr/bin/env node
/**
 * Synapse Gemini Specialist Runtime — Iter 1 (Standalone PoC)
 *
 * Direkt-Aufruf ohne Wrapper-Integration.
 * Demonstriert:
 *   - @google/genai SDK mit gemini-3.1-flash-lite-preview
 *   - Alle 18 Synapse-MCP-Tools als FunctionDeclarations
 *   - Manueller Tool-Use-Loop (parallel-fähig)
 *   - Token-Tracking aus usageMetadata
 *   - AbortController-faehige Streaming-Architektur
 *   - Live-Monitor via HTTP+SSE (Browser-View)
 *   - JSONL-Logging
 *
 * Nutzung:
 *   GOOGLE_API_KEY=... node dist/runtime.js "<task>" [--monitor-port 4789] [--max-turns 30]
 */

import { GoogleGenAI } from '@google/genai';
import type { Content, FunctionCall, GenerateContentResponse, FunctionResponse } from '@google/genai';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToolBridge } from './tool-bridge.js';
import { MonitorServer } from './monitor-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MODEL = 'gemini-3.1-flash-lite-preview';
const CONTEXT_CEILING = 1_000_000;
const HANDOFF_THRESHOLD = 0.80; // 80% Korridor wie bei opus[1m]
const RESPAWN_MARKER_PREFIX = '/tmp/.specialist-rotate-pending-';

interface CliArgs {
  task: string;
  monitorPort: number;
  maxTurns: number;
  agentName: string;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let task = '';
  let monitorPort = 4789;
  let maxTurns = 30;
  let agentName = 'gemini-iter1-test';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--monitor-port') monitorPort = parseInt(args[++i], 10);
    else if (args[i] === '--max-turns') maxTurns = parseInt(args[++i], 10);
    else if (args[i] === '--agent-name') agentName = args[++i];
    else if (!task) task = args[i];
  }
  if (!task) {
    console.error('Usage: gemini-runtime.js "<task>" [--monitor-port N] [--max-turns N] [--agent-name N]');
    process.exit(1);
  }
  return { task, monitorPort, maxTurns, agentName };
}

async function main(): Promise<void> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error('FEHLER: GOOGLE_API_KEY nicht gesetzt. Setze die Env-Variable.');
    process.exit(1);
  }

  const cli = parseArgs();
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
  for (const w of bridge.warnings.slice(0, 5)) console.error(`  ⚠ ${w}`);
  if (bridge.warnings.length > 5) console.error(`  ... + ${bridge.warnings.length - 5} weitere`);

  await log('start', {
    runId,
    model: MODEL,
    contextCeiling: CONTEXT_CEILING,
    task: cli.task,
    toolCount: bridge.declarations.length,
    schemaWarnings: bridge.warnings.length,
  });

  const ai = new GoogleGenAI({ apiKey });

  const history: Content[] = [
    {
      role: 'user',
      parts: [{ text: cli.task }],
    },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let cachedTokens = 0;
  let handoffWarned = false;

  for (let turn = 1; turn <= cli.maxTurns; turn++) {
    let response: GenerateContentResponse;
    try {
      response = await ai.models.generateContent({
        model: MODEL,
        contents: history,
        config: {
          tools: [{ functionDeclarations: bridge.declarations }],
          systemInstruction: `Du bist ein Synapse-Specialist (${cli.agentName}). Du hast Zugriff auf alle Synapse-MCP-Tools (project, search, memory, thought, channel, chat, code_intel, files, etc.). Arbeite die User-Aufgabe systematisch ab. Bei Erkundungs-Aufgaben: nutze code_intel(tree/file/search). Bei Notizen: thought(add). Bei Status-Reports: channel(post). Antworte konkret und faktisch.`,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log('error', { turn, message: msg });
      console.error(`[Gemini Runtime] Turn ${turn} API-Fehler:`, msg);
      break;
    }

    // Token-Tracking
    const usage = response.usageMetadata ?? {};
    totalInput = Number(usage.promptTokenCount ?? totalInput);
    totalOutput += Number(usage.candidatesTokenCount ?? 0);
    cachedTokens = Number(usage.cachedContentTokenCount ?? cachedTokens);
    await log('usage', {
      turn,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedTokens,
      thoughtsTokens: usage.thoughtsTokenCount ?? 0,
    });

    // Assistant Text + ggf. FunctionCalls
    const text = response.text ?? '';
    if (text) await log('assistant', { turn, text });

    const functionCalls: FunctionCall[] = response.functionCalls ?? [];

    // Wenn keine Function-Calls → Konversation beendet
    if (functionCalls.length === 0) {
      // Assistant-Antwort in History eintragen
      if (response.candidates?.[0]?.content) {
        history.push(response.candidates[0].content);
      }
      console.error(`[Gemini Runtime] Turn ${turn}: keine Function-Calls — Konversation beendet.`);
      break;
    }

    // Function-Calls verarbeiten (parallel)
    if (response.candidates?.[0]?.content) {
      history.push(response.candidates[0].content);
    }

    const responseParts: { functionResponse: FunctionResponse }[] = [];
    await Promise.all(functionCalls.map(async (call) => {
      await log('function_call', { turn, name: call.name, args: call.args ?? {}, id: call.id });
      const result = await bridge.dispatch(call.name ?? '', (call.args ?? {}) as Record<string, unknown>);
      await log('function_response', { turn, name: call.name, id: call.id, result });
      responseParts.push({
        functionResponse: {
          id: call.id,
          name: call.name ?? '',
          response: { result } as Record<string, unknown>,
        },
      });
    }));

    history.push({ role: 'user', parts: responseParts });

    // Auto-Handoff-Hinweis bei Korridor (analog zu wrapper.ts)
    const totalTokens = totalInput + totalOutput;
    const ctxFraction = totalTokens / CONTEXT_CEILING;
    if (!handoffWarned && ctxFraction >= HANDOFF_THRESHOLD) {
      handoffWarned = true;
      const markerPath = `${RESPAWN_MARKER_PREFIX}${cli.agentName}`;
      try {
        await writeFile(markerPath, new Date().toISOString() + '\n', 'utf-8');
        await log('respawn_marker', { path: markerPath });
        console.error(`[Gemini Runtime] AUTO-HANDOFF Schwelle ${Math.round(ctxFraction * 100)}% erreicht. Marker: ${markerPath}`);
      } catch (err) {
        await log('error', { turn, message: `Marker-Schreib-Fehler: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
  }

  await log('done', { totalInput, totalOutput, cachedTokens });
  console.error(`[Gemini Runtime] Done. Total: in=${totalInput} out=${totalOutput} cached=${cachedTokens}`);
  console.error(`[Gemini Runtime] Log: ${logPath}`);
  console.error(`[Gemini Runtime] Monitor laeuft weiter auf ${url} (Ctrl+C zum Beenden)`);
}

main().catch((err) => {
  console.error('[Gemini Runtime] Fataler Fehler:', err);
  process.exit(1);
});
