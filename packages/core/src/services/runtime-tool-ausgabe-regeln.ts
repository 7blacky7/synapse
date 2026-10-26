/** P22-T190: reine Spawn-Regeln; keine DB und keine neue lokale Konfigurationsquelle. */
export const TOOL_RESULTS_READ_REGEL = 'Read(~/.claude/projects/**/tool-results/**)' as const;
export interface ToolAusgabeWerte { claude_mcp_output_tokens: number; codex_tool_output_tokens: number; tool_ausgabe_kontext_prozent: number; tool_ausgabe_guard_sekunden: number }
export interface ToolAusgabeStand {
  schalter: { aktiv: boolean; quelle: string; bis: string | null; letzter_fehler: string | null };
  werte: ToolAusgabeWerte;
  quellen: Record<keyof ToolAusgabeWerte, string>;
}
/** Nur diese nicht geheimen Werte duerfen vom Server in eine Wrapper-Umgebung gelangen. AUS ueberschreibt Vererbung. */
export function toolAusgabeUmgebung(s: ToolAusgabeStand): Record<string, string> {
  return {
    SYNAPSE_TOOL_AUSGABE_AKTIV: s.schalter.aktiv ? '1' : '0',
    SYNAPSE_TOOL_AUSGABE_QUELLE: JSON.stringify({ schalter: s.schalter, werte: s.quellen }),
    SYNAPSE_CLAUDE_MCP_OUTPUT_TOKENS: String(s.werte.claude_mcp_output_tokens),
    SYNAPSE_CODEX_TOOL_OUTPUT_TOKENS: String(s.werte.codex_tool_output_tokens),
    SYNAPSE_TOOL_AUSGABE_KONTEXT_PROZENT: String(s.werte.tool_ausgabe_kontext_prozent),
    SYNAPSE_TOOL_AUSGABE_GUARD_SEKUNDEN: String(s.werte.tool_ausgabe_guard_sekunden),
  };
}
function positive(env: NodeJS.ProcessEnv, key: string): number | null {
  const n = Number(env[key]); return Number.isSafeInteger(n) && n > 0 ? n : null;
}
/** Eigenstaendiger Hook-Kern: wird als inline node -e ausgefuehrt, ohne installierten Mod/Projektdatei. */
function readGuard(): void {
  const { readFileSync, realpathSync, statSync } = require('node:fs') as typeof import('node:fs');
  const { resolve, relative, sep, isAbsolute, join } = require('node:path') as typeof import('node:path');
  const { homedir } = require('node:os') as typeof import('node:os');
  let erlaubt = false;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const name = input?.tool_name, path = input?.tool_input?.file_path;
    if (name !== 'Read' || typeof path !== 'string' || !path || path.includes('\0')) throw Error('ungueltiger Read-Aufruf');
    const root = join(homedir(), '.claude', 'projects');
    const angefragt = path.startsWith('~/') ? join(homedir(), path.slice(2)) : resolve(input.cwd || process.cwd(), path);
    const passt = (basis: string, datei: string) => {
      const rel = relative(basis, datei), teile = rel.split(sep);
      return !!rel && !isAbsolute(rel) && !teile.includes('..') && teile.length >= 3
        && teile.slice(1, -1).includes('tool-results');
    };
    // Sowohl angefragter als auch realer Pfad: Symlink aus tool-results nach aussen bleibt gesperrt.
    const real = realpathSync(angefragt);
    erlaubt = passt(root, angefragt) && passt(realpathSync(root), real) && statSync(real).isFile();
  } catch { erlaubt = false; }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
    permissionDecision: erlaubt ? 'allow' : 'deny',
    permissionDecisionReason: erlaubt ? 'Synapse: nur gespeichertes Tool-Ergebnis.' : 'Synapse: Read nur unter ~/.claude/projects/**/tool-results/** erlaubt.' } }));
}
export function toolResultsGuardQuelle(): string { return '(' + readGuard.toString() + ')()'; }
function shellZitat(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }

/** onFailure=block ist ab Claude Code 2.1.295 garantiert; alte/unbekannte CLI niemals mit freiem Read starten. */
export function pruefeToolAusgabeClaudeVersion(version: string | null | undefined): void {
  const m = version?.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  const v = m ? m.slice(1).map(Number) : null;
  if (!v || !(v[0] > 2 || v[0] === 2 && (v[1] > 1 || v[1] === 1 && v[2] >= 295))) {
    throw new Error('runtime_tool_ausgabe: Claude Code >=2.1.295 erforderlich (Read-Guard muss auch bei Fehler/Timeout blockieren); Version: ' + (version ?? 'unbekannt'));
  }
}

/** Basissperre bleibt byte-gleich; EIN schaltet ausschliesslich Read mit zwingendem Pfad-Guard frei. */
export function claudeToolAusgabe(env: NodeJS.ProcessEnv, container: boolean): {
  aktiv: boolean; flags: string[]; env: Record<string, string>; debug: Record<string, unknown>;
} {
  const tokens = positive(env, 'SYNAPSE_CLAUDE_MCP_OUTPUT_TOKENS');
  const timeout = positive(env, 'SYNAPSE_TOOL_AUSGABE_GUARD_SEKUNDEN');
  const aktiv = container && env.SYNAPSE_TOOL_AUSGABE_AKTIV === '1' && tokens !== null && timeout !== null;
  const flags = ['--tools', aktiv ? 'Read' : '', '--permission-mode', 'dontAsk'];
  if (aktiv) {
    const guard = 'node --input-type=commonjs -e ' + shellZitat(toolResultsGuardQuelle()) + ' || exit 2';
    flags.push('--allowedTools', TOOL_RESULTS_READ_REGEL, '--setting-sources', '', '--settings', JSON.stringify({
      disableAllHooks: false,
      hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: guard, timeout, onFailure: 'block' }] }] },
    }));
  }
  return { aktiv, flags, env: aktiv ? { MAX_MCP_OUTPUT_TOKENS: String(tokens) } : {},
    debug: { aktiv, quelle: env.SYNAPSE_TOOL_AUSGABE_QUELLE ?? 'standard', max_mcp_output_tokens: aktiv ? tokens : null,
      read: aktiv ? TOOL_RESULTS_READ_REGEL : 'gesperrt', guard: aktiv ? 'PreToolUse Read, onFailure=block (Claude >=2.1.295)' : 'aus',
      messaging_hooks: false, hinweis: 'Aenderungen gelten ab dem naechsten Wrapper-Start; grosse Antworten koennen weiterhin als Datei landen.' } };
}
/** Ein Ergebnis darf hoechstens den konfigurierten Anteil des bekannten Modellkontexts verbrauchen. */
export function codexToolAusgabe(env: NodeJS.ProcessEnv, contextWindow: number | null | undefined): {
  tokens: number | null; debug: Record<string, unknown>;
} {
  const wunsch = positive(env, 'SYNAPSE_CODEX_TOOL_OUTPUT_TOKENS'), prozent = positive(env, 'SYNAPSE_TOOL_AUSGABE_KONTEXT_PROZENT');
  const freigegeben = env.SYNAPSE_TOOL_AUSGABE_AKTIV === '1';
  const kontext = typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : null;
  const tokens = freigegeben && wunsch && prozent && prozent <= 50 && kontext
    ? Math.max(1, Math.min(wunsch, Math.floor(kontext * prozent / 100))) : null;
  return { tokens, debug: { aktiv: tokens !== null, quelle: env.SYNAPSE_TOOL_AUSGABE_QUELLE ?? 'standard', angefragt: wunsch,
    tool_output_token_limit: tokens, kontext, kontext_prozent: prozent,
    letzter_fehler: freigegeben && !tokens ? 'tool_ausgabe_wert_oder_modellkontext_fehlt' : null } };
}
