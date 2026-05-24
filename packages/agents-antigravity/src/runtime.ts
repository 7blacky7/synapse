#!/usr/bin/env node
/**
 * Synapse Antigravity (agy) Specialist Runtime
 *
 * Treibt den OFFIZIELLEN `agy` CLI (Google Antigravity) headless via `agy -p`.
 *
 * ABRECHNUNG: Pro-Abo-Quota/Credits ueber die OS-Keyring-Session — KEIN API-Key.
 * Strikt getrennt vom Gemini-Adapter (@synapse/agents-gemini), der GOOGLE_API_KEY
 * (Pay-per-Token) nutzt. Provider hier: 'antigravity'. Haertung: GOOGLE_API_KEY /
 * GEMINI_API_KEY werden aus dem agy-Subprozess-env ENTFERNT, damit agy unter keinen
 * Umstaenden auf API-Key-Billing ausweichen kann.
 *
 * Zwei Modi:
 *  (A) STANDALONE (Default): `node dist/runtime.js "<prompt>"` — einmal agy -p.
 *  (B) WRAPPER_MODE (SYNAPSE_WRAPPER_MODE=1): vom Synapse-Wrapper gespawnt.
 *      Spricht das Claude-CLI-Stream-JSON-Protokoll auf stdout, liest Messages
 *      zeilenweise von stdin. Pro Inbound-Message ein `agy -p` (Folge-Turns via
 *      --continue). System-Prompt wird beim ersten Turn vorangestellt (agy hat
 *      kein --system-prompt-Flag).
 *      ENV: SYNAPSE_AGENT_NAME, SYNAPSE_AGENT_MODEL, SYNAPSE_PROJECT_PATH,
 *           SYNAPSE_PROJECT_NAME, SYNAPSE_SYSTEM_PROMPT_FILE, SYNAPSE_SESSION_ID,
 *           SYNAPSE_AGENT_EXPERTISE (optional), SYNAPSE_AGENT_TASK (optional)
 *
 * HINWEIS Kontext/Token: agy laeuft auf der Pro-Quota (nicht Token-billed) und
 * verwaltet seinen Kontext selbst. Synapses Token-Korridor/Auto-Handoff ist daher
 * fuer agy deaktiviert (corridorMin hoch); das JSONL-Token-Log ist nur eine grobe
 * Schaetzung fuer wrapper.ts:syncTokensFromHistory.
 *
 * CAVEAT (v1): Folge-Turns nutzen `agy --continue` ("juengste Conversation"). Mehrere
 * agy-Spezialisten parallel auf demselben Host koennen sich so die Conversation
 * streitig machen (Race). Fuer echte Parallelitaet braucht es spaeter pro-Agent
 * isolierte agy-Profile (eigenes Config-Home). Fuer einen einzelnen Spezialisten ok.
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { resolveModel } from '@synapse/agents';

const isWrapperMode = process.env.SYNAPSE_WRAPPER_MODE === '1';

/** Stream-JSON-Event auf stdout schreiben (Claude-CLI-Format) */
function emitStdout(event: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/** Claude CLI nutzt '-home-blacky-dev-synapse' fuer '/home/blacky/dev/synapse' */
function dashedPath(p: string): string {
  return p.replace(/\//g, '-');
}

interface AgyResult {
  text: string;
  code: number;
}

/**
 * Ruft `agy -p` einmal auf und liefert den Antworttext.
 * firstTurn=false haengt --continue an (Folge-Turn der juengsten Conversation).
 * GOOGLE_API_KEY/GEMINI_API_KEY werden aus dem env entfernt (Trennung Pro-Abo vs API-Key).
 */
function runAgy(
  prompt: string,
  opts: { projectPath: string; firstTurn: boolean },
): Promise<AgyResult> {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--dangerously-skip-permissions', '--add-dir', opts.projectPath];
    if (!opts.firstTurn) args.push('--continue');

    const env = { ...process.env };
    delete env.GOOGLE_API_KEY;
    delete env.GEMINI_API_KEY;

    const proc = spawn('agy', args, { env, cwd: opts.projectPath, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    proc.on('error', (e) => {
      resolve({ text: `agy-Start fehlgeschlagen: ${e instanceof Error ? e.message : String(e)} (ist 'agy' im PATH?)`, code: 127 });
    });
    proc.on('exit', (code) => {
      if ((code ?? 0) !== 0 && !out.trim()) {
        resolve({ text: `agy exit ${code}: ${err.trim() || '(keine Ausgabe)'}`, code: code ?? 1 });
      } else {
        resolve({ text: out.trim(), code: code ?? 0 });
      }
    });
  });
}

// ---------------------------------------------------------------------------
// (A) Standalone — Direkt-Test ohne Wrapper
// ---------------------------------------------------------------------------

async function runStandalone(): Promise<void> {
  const prompt = process.argv.slice(2).join(' ') || 'Antworte mit exakt: ANTIGRAVITY_RUNTIME_OK';
  const { text, code } = await runAgy(prompt, { projectPath: process.cwd(), firstTurn: true });
  process.stdout.write(text + '\n');
  process.exit(code);
}

// ---------------------------------------------------------------------------
// (B) Wrapper Mode — vom Synapse-Wrapper gespawnt
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
    sessionId: required('SYNAPSE_SESSION_ID'),
  };
}

function extractUserInput(line: string): string {
  try {
    const msg = JSON.parse(line) as
      | string
      | { text?: string; message?: { content?: Array<{ type: string; text?: string }> } };
    if (typeof msg === 'string') return msg;
    if (msg.message?.content) {
      return msg.message.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    }
    if (msg.text) return msg.text;
    return JSON.stringify(msg);
  } catch {
    return line;
  }
}

async function runWrapperMode(): Promise<void> {
  const env = readWrapperEnv();
  const model = resolveModel(env.modelAlias);
  const fullId = model?.fullId ?? env.modelAlias;

  // System-Prompt: process.ts schreibt ihn IMMER in SYNAPSE_SYSTEM_PROMPT_FILE.
  let systemPrompt = '';
  if (env.systemPromptFile) {
    try { systemPrompt = await readFile(env.systemPromptFile, 'utf-8'); } catch { /* tolerant */ }
  }

  // Init-Event MUSS die allererste stdout-Zeile sein.
  emitStdout({ type: 'system', subtype: 'init', session_id: env.sessionId, cwd: env.projectPath, model: fullId });

  // JSONL-Token-Log (Stub) fuer wrapper.ts:syncTokensFromHistory.
  const claudeProjectsDir = join(homedir(), '.claude', 'projects', dashedPath(env.projectPath));
  await mkdir(claudeProjectsDir, { recursive: true });
  const jsonlPath = join(claudeProjectsDir, `${env.sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  const stdinReader = createInterface({ input: process.stdin });
  let firstTurn = true;

  for await (const line of stdinReader) {
    if (!line.trim()) continue;
    const userInput = extractUserInput(line);

    // Beim ersten Turn System-Prompt voranstellen (agy hat kein --system-prompt-Flag).
    const prompt = firstTurn && systemPrompt
      ? `${systemPrompt}\n\n--- AUFGABE ---\n\n${userInput}`
      : userInput;

    // Ping-Heartbeat: Manager killt nach 120s ohne Event. agy-Tasks dauern laenger.
    const pingTimer = setInterval(() => emitStdout({ type: 'ping' }), 30_000);

    let result: AgyResult;
    try {
      result = await runAgy(prompt, { projectPath: env.projectPath, firstTurn });
    } finally {
      clearInterval(pingTimer);
    }
    firstTurn = false;

    emitStdout({ type: 'assistant', message: { content: [{ type: 'text', text: result.text }] } });

    // Token-Schaetzung (agy liefert keine echten Zahlen — ~4 Zeichen/Token).
    const estIn = Math.ceil(prompt.length / 4);
    const estOut = Math.ceil(result.text.length / 4);
    await appendFile(jsonlPath, JSON.stringify({
      message: { usage: { input_tokens: estIn, output_tokens: estOut, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    }) + '\n');

    // Result-Event: Turn-Ende-Signal fuer wrapper.ts.
    emitStdout({ type: 'result', result: result.text, usage: { input_tokens: estIn, output_tokens: estOut } });
  }
}

async function main(): Promise<void> {
  if (isWrapperMode) await runWrapperMode();
  else await runStandalone();
}

main().catch((err) => {
  console.error('[Antigravity Runtime] Fataler Fehler:', err);
  process.exit(1);
});
