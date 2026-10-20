#!/usr/bin/env node
/**
 * MODUL: codex-runtime (P22-T6b, W2c; Vertrag thought 825fcb16, Konzept e7ed9291 Abschn. 8b / U3)
 * ZWECK: Codex-CLI als Agent im Synapse-Wrapper – nach demselben Muster wie die Gemini-Runtime (agents-gemini, WRAPPER_MODE):
 *        der Wrapper startet diesen node-Prozess ueber process.ts (binary 'node', runtimePath '@synapse/agents/codex-runtime')
 *        und spricht mit ihm das Claude-CLI-Stream-JSON-Protokoll (stdin: {type:'user', message}, stdout: system/init,
 *        assistant, result). Damit gelten Wake, Heartbeat, Rotation, Respawn und Stop des Wrappers unveraendert.
 *
 * GEDAECHTNIS: je Turn `codex exec --json`; der erste Turn startet einen Thread (Event thread.started), jeder weitere Turn
 *   laeuft als `codex exec resume <thread_id>` auf DEMSELBEN Thread. Ein Prozessneustart (Rotation/Neustart-Auftrag) beginnt
 *   wie beim Claude-Spezialisten (neue --session-id) einen neuen Thread; der Arbeitsstand kommt ueber Handoff/Synapse.
 * SYSTEM-PROMPT: steht vor der ersten Nachricht eines neuen Threads (Codex hat keinen --system-prompt; resume behaelt ihn).
 * WERKZEUGE (Werkzeugprofil Hauptagent: nur Synapse-Tools, kein eingebautes Bash): --ignore-user-config, --sandbox read-only,
 *   eingebaute Werkzeuge per --disable abgeschaltet (Liste SYNAPSE_CODEX_DEAKTIVIERT), genau EIN MCP-Server 'synapse' aus der
 *   MCP-Config des Wrappers (SYNAPSE_MCP_CONFIG_FILE, mcp-bruecke). Geheimnisse nie in argv: Bearer und Ausweis gehen als
 *   Env-Variablen (bearer_token_env_var, env_http_headers), die Header-Referenz ${VAR} wird auf den Env-Namen abgebildet.
 * VERBRAUCH: turn.completed.usage -> result.usage und JSONL im Claude-Format (fuer wrapper.ts syncTokensFromHistory).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, mkdir, appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveModel } from './models.js';

const STANDARD_DEAKTIVIERT = ['shell_tool', 'computer_use', 'browser_use', 'browser_use_external', 'in_app_browser',
  'image_generation', 'multi_agent', 'apps', 'plugins'];
/** Codex-Standardmodell (kein -m): Registry-Eintrag mit diesem fullId. */
export const CODEX_STANDARD_MODELL = 'codex-cli-standard';

export interface CodexMcpAbbildung {
  /** -c Overrides (ohne Geheimnisse). */
  overrides: string[];
  /** Zusaetzliche Env-Variablen fuer den codex-Prozess (Geheimnisse). */
  env: Record<string, string>;
}

function tomlString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Bildet die MCP-Config des Wrappers ({mcpServers:{synapse:{type:'http',url,headers}}}) auf Codex-Overrides ab.
 * Authorization 'Bearer <x>' -> Env SYNAPSE_CODEX_MCP_BEARER + bearer_token_env_var; Header-Wert '${VAR}' ->
 * env_http_headers (Codex liest VAR selbst aus der Umgebung); andere Literale -> http_headers.
 * P22-T72: codex exec ist nicht interaktiv und kann MCP-Aufrufe nicht genehmigen -> default_tools_approval_mode="approve"
 * je Server (Befund d372d83f; derselbe Weg wie im Test tool-antwort-kompakt-p10-t51).
 */
export function bildeMcpAufCodexAb(config: unknown): CodexMcpAbbildung {
  const servers = (config as { mcpServers?: Record<string, { type?: string; url?: string; headers?: Record<string, string> }> } | null)?.mcpServers ?? {};
  const overrides: string[] = [];
  const env: Record<string, string> = {};
  for (const [name, s] of Object.entries(servers)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !s || typeof s.url !== 'string') continue;
    const p = `mcp_servers.${name}`;
    overrides.push(`${p}.url=${tomlString(s.url)}`);
    overrides.push(`${p}.default_tools_approval_mode=${tomlString('approve')}`);
    const literal: Record<string, string> = {};
    const ausEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers ?? {})) {
      if (typeof v !== 'string') continue;
      const ref = /^\$\{([A-Z0-9_]+)\}$/.exec(v);
      if (ref) { ausEnv[k] = ref[1]; continue; }
      // P22-T66: 'Bearer ${VAR}' (MCP-Config des Hauptagenten im Container) -> Codex liest VAR selbst, kein Kopieren.
      const bearerRef = k.toLowerCase() === 'authorization' ? /^Bearer\s+\$\{([A-Z0-9_]+)\}$/i.exec(v) : null;
      if (bearerRef) { overrides.push(`${p}.bearer_token_env_var=${tomlString(bearerRef[1])}`); continue; }
      if (k.toLowerCase() === 'authorization' && /^Bearer\s+/i.test(v)) {
        const envName = `SYNAPSE_CODEX_MCP_BEARER_${name.toUpperCase().replace(/-/g, '_')}`;
        env[envName] = v.replace(/^Bearer\s+/i, '');
        overrides.push(`${p}.bearer_token_env_var=${tomlString(envName)}`);
        continue;
      }
      literal[k] = v;
    }
    const tabelle = (o: Record<string, string>) => '{' + Object.entries(o).map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`).join(',') + '}';
    if (Object.keys(literal).length) overrides.push(`${p}.http_headers=${tabelle(literal)}`);
    if (Object.keys(ausEnv).length) overrides.push(`${p}.env_http_headers=${tabelle(ausEnv)}`);
  }
  return { overrides, env };
}

export interface CodexBefehl { args: string[] }

/** Argumente eines Turns (ohne Prompt, der kommt ueber stdin '-'). */
export function baueCodexArgs(o: {
  threadId: string | null; cwd: string; modell: string | null; deaktiviert: string[]; mcpOverrides: string[];
  /** P22-T65: Reasoning-Stufe; codex-cli 0.163 kennt dafuer kein exec-Flag, nur den config-Schluessel model_reasoning_effort. */
  effort?: string | null;
}): string[] {
  const args = ['exec', '--json', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only', '-C', o.cwd];
  if (o.modell) args.push('-m', o.modell);
  if (o.effort && /^[a-z]{2,16}$/.test(o.effort)) args.push('-c', `model_reasoning_effort=${tomlString(o.effort)}`);
  for (const f of o.deaktiviert) args.push('--disable', f);
  for (const c of o.mcpOverrides) args.push('-c', c);
  return o.threadId ? [...args, 'resume', o.threadId, '-'] : [...args, '-'];
}

/** P22-T63: ein Werkzeugschritt bzw. eine Denkphase eines Codex-Turns (fuer die Inhalts-Zeilen der JSONL). */
export type CodexSchritt =
  | { art: 'werkzeug'; name: string; input: unknown; output: unknown; fehler: boolean }
  | { art: 'denken'; text: string };

export interface CodexEreignis {
  threadId?: string;
  text?: string;
  schritt?: CodexSchritt;
  usage?: { input_tokens: number; output_tokens: number; cached_input_tokens: number };
  fehler?: string;
}

/**
 * P22-T75: usage einer Antwortzeile der Claude-JSONL aus der Codex-usage. Codex zaehlt cached_input_tokens bereits IN input_tokens
 * mit; token-stand.ts summiert input + cache_read (Claude-Form, dort getrennt) -> ohne Abzug stuende der Cache doppelt im Kontext.
 */
export function jsonlUsageAusCodex(u: { input_tokens: number; output_tokens: number; cached_input_tokens: number }):
  { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
  return { input_tokens: Math.max(0, u.input_tokens - u.cached_input_tokens), output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cached_input_tokens, cache_creation_input_tokens: 0 };
}

/** Eine JSON-Zeile von `codex exec --json` (Form wie rest-api codex-driver parseCodexJsonLine). */
export function leseCodexZeile(line: string): CodexEreignis {
  let v: Record<string, unknown>;
  try { v = JSON.parse(line) as Record<string, unknown>; } catch { return {}; }
  const type = String(v.type ?? '');
  if (type === 'thread.started') {
    const id = String(v.thread_id ?? v.threadId ?? '');
    return id ? { threadId: id } : {};
  }
  if (type === 'item.completed') {
    const item = v.item as Record<string, unknown> | undefined;
    if (item?.type === 'agent_message') {
      const text = item.text ?? item.content;
      if (typeof text === 'string') return { text };
    }
    // P22-T63: Werkzeugschritte vollstaendig (MCP-Aufruf, Befehl) und Denkphasen fuer den Verlauf des Hauptagenten.
    if (item?.type === 'mcp_tool_call') {
      return { schritt: { art: 'werkzeug', name: String(item.server ? item.server + '.' : '') + String(item.tool ?? 'werkzeug'),
        input: item.arguments ?? null, output: item.result ?? item.error ?? null, fehler: item.status === 'failed' || !!item.error } };
    }
    if (item?.type === 'command_execution') {
      return { schritt: { art: 'werkzeug', name: 'command', input: item.command ?? null, output: item.aggregated_output ?? null,
        fehler: typeof item.exit_code === 'number' && item.exit_code !== 0 } };
    }
    if (item?.type === 'reasoning' && typeof item.text === 'string') return { schritt: { art: 'denken', text: item.text } };
  }
  if (type === 'turn.completed') {
    const u = (v.usage ?? {}) as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    return { usage: { input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens), cached_input_tokens: n(u.cached_input_tokens) } };
  }
  if (type === 'turn.failed' || type === 'error') {
    const e = (v.error ?? {}) as Record<string, unknown>;
    return { fehler: String(e.message ?? v.message ?? type) };
  }
  return {};
}

/**
 * P22-T58: Codex meldet ein erschoepftes Abo nur als Fehlertext (exec --json: turn.failed/error), z. B. "You've hit your usage
 * limit ... Try again in 2 days 3 hours" bzw. "Usage limit reached". resetsAt (Sekunden seit Epoch) nur bei relativer Angabe
 * "in ..."; sonst null (die API nimmt dann kontingent_ohne_reset_minuten).
 */
export function codexLimitAus(text: string, jetzt = Date.now()): { resetsAt: number | null } | null {
  if (!/usage limit|out of credits|rate limit reached/i.test(text)) return null;
  const rel = /try again in ([^.]+)/i.exec(text);
  if (!rel) return { resetsAt: null };
  const faktor: Record<string, number> = { day: 86_400, hour: 3_600, minute: 60, min: 60, second: 1, sec: 1 };
  let sek = 0;
  for (const m of rel[1].matchAll(/(\d+)\s*(day|hour|minute|min|second|sec)s?/gi)) sek += Number(m[1]) * (faktor[m[2].toLowerCase()] ?? 0);
  return { resetsAt: sek > 0 ? Math.round(jetzt / 1000) + sek : null };
}

function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function nachrichtAus(line: string): string {
  try {
    const msg = JSON.parse(line) as unknown;
    if (typeof msg === 'string') return msg;
    const content = (msg as { message?: { content?: Array<{ type: string; text?: string }> } }).message?.content;
    if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text ?? '').join('');
    return JSON.stringify(msg);
  } catch {
    return line;
  }
}

async function main(): Promise<void> {
  const agentName = process.env.SYNAPSE_AGENT_NAME ?? 'codex';
  const alias = process.env.SYNAPSE_AGENT_MODEL ?? '';
  const projectPath = process.env.SYNAPSE_PROJECT_PATH ?? process.cwd();
  const sessionId = process.env.SYNAPSE_SESSION_ID ?? String(Date.now());
  const eintrag = resolveModel(alias);
  const modell = eintrag && eintrag.fullId !== CODEX_STANDARD_MODELL ? eintrag.fullId : null;
  // P22-T65: Stufe vom Spawn (spawnSpecialistTool -> Wrapper-Env SYNAPSE_AGENT_EFFORT); leer = Standard der CLI.
  const effort = process.env.SYNAPSE_AGENT_EFFORT?.trim() || null;
  const deaktiviert = (process.env.SYNAPSE_CODEX_DEAKTIVIERT ?? STANDARD_DEAKTIVIERT.join(','))
    .split(',').map(s => s.trim()).filter(s => /^[a-z0-9_]+$/.test(s));
  const systemPrompt = process.env.SYNAPSE_SYSTEM_PROMPT_FILE ? await readFile(process.env.SYNAPSE_SYSTEM_PROMPT_FILE, 'utf8').catch(() => '') : '';
  let mcp: CodexMcpAbbildung = { overrides: [], env: {} };
  if (process.env.SYNAPSE_MCP_CONFIG_FILE) {
    try { mcp = bildeMcpAufCodexAb(JSON.parse(await readFile(process.env.SYNAPSE_MCP_CONFIG_FILE, 'utf8'))); }
    catch (err) { console.error(`[codex-runtime] MCP-Config nicht lesbar: ${(err as Error).message}`); }
  }

  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: projectPath, model: modell ?? CODEX_STANDARD_MODELL });

  // JSONL im Claude-Format fuer wrapper.ts syncTokensFromHistory (wie agents-gemini).
  const jsonlDir = join(homedir(), '.claude', 'projects', projectPath.replace(/\//g, '-'));
  await mkdir(jsonlDir, { recursive: true });
  const jsonlPath = join(jsonlDir, `${sessionId}.jsonl`);
  await writeFile(jsonlPath, '');

  let threadId: string | null = null;
  let turnNr = 0;
  const stdin = createInterface({ input: process.stdin });
  for await (const line of stdin) {
    if (!line.trim()) continue;
    const nachricht = nachrichtAus(line);
    const prompt = !threadId && systemPrompt.trim() ? `${systemPrompt}\n\n---\n\n${nachricht}` : nachricht;
    const args = baueCodexArgs({ threadId, cwd: projectPath, modell, deaktiviert, mcpOverrides: mcp.overrides, effort });
    const r = await fuehreTurnAus(args, prompt, { ...process.env, ...mcp.env });
    if (r.threadId) threadId = r.threadId;
    turnNr++;
    // P22-T63: Inhalt des Turns im Claude-Format (Eingabe, Werkzeugschritte, Antwort) fuer den Verlauf des Hauptagenten
    // (wrapper.ts meldeVerlauf); nur die Antwortzeile traegt usage, also zaehlen syncTokens/meldeVerbrauch wie bisher.
    const m = modell ?? CODEX_STANDARD_MODELL;
    const zeit = new Date().toISOString();
    const basis = `${sessionId}:${turnNr}`;
    const zeilen: Record<string, unknown>[] = [{ type: 'user', uuid: basis + ':u', timestamp: zeit, message: { role: 'user', content: prompt } }];
    r.schritte.forEach((s, i) => {
      if (s.art === 'denken') {
        zeilen.push({ type: 'assistant', uuid: `${basis}:d${i}`, timestamp: zeit, message: { role: 'assistant', model: m, content: [{ type: 'thinking', thinking: s.text }] } });
        return;
      }
      const id = `codex-${basis}-${i}`;
      zeilen.push({ type: 'assistant', uuid: `${basis}:w${i}`, timestamp: zeit, message: { role: 'assistant', model: m, content: [{ type: 'tool_use', id, name: s.name, input: s.input }] } });
      zeilen.push({ type: 'user', uuid: `${basis}:r${i}`, timestamp: zeit, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: s.output, is_error: s.fehler }] } });
    });
    // message.id je Turn: wrapper.ts meldeVerbrauch bucht jede Referenz genau einmal (P22-T7).
    zeilen.push({ type: 'assistant', uuid: basis + ':a', timestamp: zeit, message: { id: basis, role: 'assistant', model: m,
      content: [{ type: 'text', text: r.texte.join('\n\n') }],
      ...(r.usage ? { usage: jsonlUsageAusCodex(r.usage) } : {}) } });
    await appendFile(jsonlPath, zeilen.map((z) => JSON.stringify(z)).join('\n') + '\n').catch(() => undefined);
    for (const t of r.texte) emit({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'text', text: t }] } });
    // P22-T58: Kontingent im Claude-Format (rate_limit_event) an den Wrapper; der Wrapper meldet nur Zustandswechsel.
    const limit = r.fehler ? codexLimitAus(r.fehler) : null;
    if (limit) emit({ type: 'rate_limit_event', session_id: sessionId, rate_limit_info: { status: 'rejected', resetsAt: limit.resetsAt, rateLimitType: 'codex_usage_limit' } });
    else if (!r.fehler) emit({ type: 'rate_limit_event', session_id: sessionId, rate_limit_info: { status: 'allowed', rateLimitType: 'codex_usage_limit' } });
    emit({
      type: 'result', session_id: sessionId,
      result: r.fehler && !r.texte.length ? `Codex-Fehler: ${r.fehler}` : r.texte.join('\n\n'),
      is_error: !!r.fehler && !r.texte.length,
      usage: { input_tokens: r.usage?.input_tokens ?? 0, output_tokens: r.usage?.output_tokens ?? 0 },
    });
    console.error(`[codex-runtime:${agentName}] Turn fertig (thread ${threadId ?? '-'}, ${r.texte.length} Antwort(en)${r.fehler ? `, Fehler ${r.fehler}` : ''})`);
  }
}

async function fuehreTurnAus(args: string[], prompt: string, env: NodeJS.ProcessEnv): Promise<{
  threadId: string | null; texte: string[]; usage: CodexEreignis['usage'] | null; fehler: string | null; schritte: CodexSchritt[];
}> {
  return new Promise((resolve) => {
    const proc = spawn('codex', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const texte: string[] = [];
    const schritte: CodexSchritt[] = [];
    let threadId: string | null = null;
    let usage: CodexEreignis['usage'] | null = null;
    let fehler: string | null = null;
    let stderr = '';
    // Lebenszeichen fuer den Wrapper (Sliding-Timeout in process.ts), solange Codex arbeitet.
    const ping = setInterval(() => emit({ type: 'ping' }), 30_000);
    createInterface({ input: proc.stdout }).on('line', (l) => {
      const e = leseCodexZeile(l);
      if (e.threadId) threadId = e.threadId;
      if (e.text) texte.push(e.text);
      if (e.schritt) schritte.push(e.schritt);
      if (e.usage) usage = e.usage;
      if (e.fehler) fehler = e.fehler;
    });
    proc.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    proc.on('error', (err) => { fehler = err.message; });
    proc.on('close', (code) => {
      clearInterval(ping);
      if (code !== 0 && !fehler) fehler = `codex endete mit Exit-Code ${code}${stderr ? ': ' + stderr.trim().split('\n').slice(-3).join(' | ') : ''}`;
      resolve({ threadId, texte, usage, fehler, schritte });
    });
    proc.stdin.end(prompt);
  });
}

// Nur als Programm starten, nicht beim Import (Tests importieren die reinen Funktionen).
if (process.env.SYNAPSE_WRAPPER_MODE === '1') {
  main().catch((err) => {
    console.error('[codex-runtime] Fataler Fehler:', err);
    process.exit(1);
  });
}
