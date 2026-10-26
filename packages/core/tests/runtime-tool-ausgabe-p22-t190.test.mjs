/** P22-T190: PG-Freigabe/Einstellungen, echte Read-Guard-Prozesse und beide CLI-Argumentbuilder; nur synapse_test:5433.
 * Keine LLM-/Docker-Aufrufe. Temp-Dateien sind ausschliesslich Guard-Testdaten.
 * Nach mise run build:core, pnpm --filter @synapse/agents build und mise run build:api ausfuehren.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const url = new URL(process.env.SYNAPSE_DATABASE_URL || process.env.DATABASE_URL || 'http://invalid');
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
for (const k of ['SYNAPSE_DATABASE_URL', 'SYNAPSE_AGENT_TOKEN', 'SYNAPSE_AGENT_IDENTITY_ID']) delete process.env[k];
Object.assign(process.env, { SYNAPSE_SHELL_JOB: '1', SYNAPSE_SKIP_EMBEDDINGS: '1', PARSER_LOOP_DISABLED: '1', SYNAPSE_INTERN_TOOL: '1' });
const require = createRequire(new URL('../package.json', import.meta.url)), { Pool } = require('pg');
const admin = new Pool({ connectionString: url.href }), schema = 'p22_t190_' + randomUUID().replaceAll('-', '');
let C, dir, checks = 0;
const ok = (value, label, actual) => { const herkunft = 'P22-T190 runtime-tool-ausgabe.ts / runtime-tool-ausgabe-regeln.ts / intern-tool.ts / CLI-Builder: '; assert.ok(value, herkunft + label + ' | erwartet=true | ist=' + JSON.stringify(actual ?? value)); checks++; console.log('OK ' + herkunft + label); };
try {
  await admin.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'runtime_ueberwachung_einstellungen', 'intern_schalter']) {
    await admin.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING ALL)');
  }
  url.searchParams.set('options', '-c search_path=' + schema); process.env.DATABASE_URL = url.href;
  C = await import('../dist/index.js');
  const pool = C.getPool(), P = 'p22-t190-test';
  let s = await C.leseRuntimeToolAusgabe(P);
  ok(!s.schalter.aktiv && s.schalter.quelle === 'standard' && s.werte.claude_mcp_output_tokens === 100000 && s.werte.codex_tool_output_tokens === 100000, 'Standard AUS, beide Wunschspeicher100000', s);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',null,'alle',true,'Test','user')");
  ok(!(await C.leseRuntimeToolAusgabe(P)).schalter.aktiv, 'alle gibt Read/Limits nicht implizit frei');
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',null,'runtime_tool_ausgabe',true,'Test','user')");
  s = await C.leseRuntimeToolAusgabe(P);
  ok(s.schalter.aktiv && s.schalter.quelle === 'produkt-schalter', 'expliziter PG-Produktwert EIN', s);
  const setting = { claude_mcp_output_tokens: 120000, codex_tool_output_tokens: 90000, tool_ausgabe_kontext_prozent: 20, tool_ausgabe_guard_sekunden: 8 };
  await C.setzeRuntimeUeberwachungEinstellungen({ art: 'user' }, null, { werte: setting, grund: 'P22-T190 Test' });
  s = await C.leseRuntimeToolAusgabe(P);
  ok(JSON.stringify(s.werte) === JSON.stringify(setting) && Object.values(s.quellen).every(q => q === 'einstellung'), 'PG-Werte und Quellen frisch gelesen', s);
  await assert.rejects(() => C.setzeRuntimeUeberwachungEinstellungen({ art: 'user' }, null, { werte: { claude_mcp_output_tokens: 1 }, grund: 'Test' })); checks++;
  for (const version of ['2.1.295 (Claude Code)', '2.1.310 (Claude Code)', '2.2.0']) C.pruefeToolAusgabeClaudeVersion(version);
  for (const version of [null, 'unbekannt', '2.1.294 (Claude Code)', '2.0.999']) { assert.throws(() => C.pruefeToolAusgabeClaudeVersion(version)); checks++; }
  const env = C.toolAusgabeUmgebung(s), cl = C.claudeToolAusgabe(env, true);
  ok(cl.aktiv && cl.env.MAX_MCP_OUTPUT_TOKENS === '120000' && cl.flags[cl.flags.indexOf('--tools') + 1] === 'Read', 'Claude genau Read + einstellbares MAX_MCP_OUTPUT_TOKENS', cl);
  ok(cl.flags.includes(C.TOOL_RESULTS_READ_REGEL) && cl.flags.includes('--setting-sources'), 'enger Read-Pfad und isolierte Einstellquellen', cl.flags);
  const settings = JSON.parse(cl.flags[cl.flags.indexOf('--settings') + 1]);
  const hook = settings.hooks.PreToolUse[0].hooks[0];
  ok(!settings.disableAllHooks && Object.keys(settings.hooks).join() === 'PreToolUse' && settings.hooks.PreToolUse[0].matcher === 'Read' && hook.onFailure === 'block' && hook.timeout === 8,
    'nur Read-Guard, keine Messaging-Hooks; Fehler blockieren', settings);
  ok(!C.claudeToolAusgabe(env, false).aktiv, 'PC-Spawn bleibt ohne neue Rechte');
  const aus = C.claudeToolAusgabe({ ...env, SYNAPSE_TOOL_AUSGABE_AKTIV: '0' }, true);
  ok(!aus.aktiv && !Object.keys(aus.env).length && aus.flags[1] === '' && !aus.flags.includes('--settings'), 'AUS bleibt Altverhalten', aus);
  let cx = C.codexToolAusgabe(env, 200000);
  ok(cx.tokens === 40000 && cx.debug.kontext === 200000, 'Codex geklemmt auf PG-Anteil des Modellkontexts', cx);
  ok(C.codexToolAusgabe(env, 1000000).tokens === 90000, 'Codex Wunsch unter Kontextgrenze bleibt erhalten');
  ok(C.codexToolAusgabe(env, null).tokens === null && C.codexToolAusgabe({ ...env, SYNAPSE_TOOL_AUSGABE_AKTIV: '0' }, 1000000).tokens === null, 'Codex ohne Kontext/Freigabe kein geratenes Override');
  const { buildClaudeCommand } = await import('../../rest-api/dist/services/agent-runtime/claude-driver.js');
  const { buildCodexCommand } = await import('../../rest-api/dist/services/agent-runtime/codex-driver.js');
  const { baueCodexArgs } = await import('../../agents/dist/codex-runtime.js');
  const on = buildClaudeCommand(null, 'sonnet', '{}', 'main-synapse', null, null, env);
  ok(on[on.indexOf('--tools') + 1] === 'Read' && on.includes(C.TOOL_RESULTS_READ_REGEL) && !on.includes('--safe-mode'), 'Main-Fallback benutzt denselben Read-Guard', on);
  const ohneMcp = buildClaudeCommand(null, 'sonnet', null, 'artefakt-only', null, null, env);
  ok(ohneMcp[ohneMcp.indexOf('--tools') + 1] === '' && !ohneMcp.includes(C.TOOL_RESULTS_READ_REGEL), 'ohne MCP kein Read bei safe-mode/deaktiviertem Guard');
  const legacy = buildClaudeCommand(null, 'sonnet', '{}', 'main-synapse');
  ok(legacy[legacy.indexOf('--tools') + 1] === '' && !legacy.includes(C.TOOL_RESULTS_READ_REGEL), 'Main-Fallback ohne Freigabe unveraendert');
  const mainArgs = buildCodexCommand('thread-test', null, cx.tokens);
  const args = baueCodexArgs({ threadId: 'thread-test', cwd: '/projects/test', modell: 'codex', deaktiviert: [], mcpOverrides: [], toolOutputTokens: cx.tokens });
  ok(mainArgs.includes('tool_output_token_limit=40000') && args.includes('tool_output_token_limit=40000') && args.includes('resume'), 'Codex Main + Wrapper + Resume uebernehmen denselben Wert', { mainArgs, args });

  dir = await mkdtemp(join(tmpdir(), 'p22-t190-data-'));
  const results = join(dir, '.claude/projects/projekt/session/tool-results');
  await mkdir(results, { recursive: true });
  const allowed = join(results, 'antwort.txt'), outside = join(dir, 'projekt-code.txt'), link = join(results, 'ausbruch.txt');
  await writeFile(allowed, 'Testantwort'); await writeFile(outside, 'kein Read'); await symlink(outside, link);
  const quote = x => "'" + x.replace(/'/g, "'\\''") + "'";
  const originalCode = C.toolResultsGuardQuelle();
  const code = 'require("node:os").homedir=()=>'+JSON.stringify(dir)+';' + originalCode;
  // Derselbe erzeugte Shellbefehl, nur homedir() fuer Wegwerfdaten injiziert; kein Testskript auf Platte.
  const command = hook.command.replace(quote(originalCode), quote(code));
  const guard = input => {
    const r = spawnSync('/bin/sh', ['-c', command], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  };
  for (const [path, decision] of [[allowed, 'allow'], [outside, 'deny'], [link, 'deny'], [results, 'deny'], [join(results, 'fehlt.txt'), 'deny']]) {
    ok(guard({ tool_name: 'Read', cwd: dir, tool_input: { file_path: path } }) === decision, 'echter Guard '+decision+' '+path.replace(dir, '<test>'));
  }
  ok(guard('{kaputt') === 'deny' && guard({ tool_name: 'Bash', tool_input: { file_path: allowed } }) === 'deny', 'ungueltige Hook-Eingaben bleiben geschlossen');
  ok(guard({ tool_name: 'Read', cwd: dir, tool_input: { file_path: '~/.claude/projects/projekt/session/tool-results/antwort.txt' } }) === 'allow', 'Tilde im erlaubten tool-results-Pfad');

  await pool.query("UPDATE agent_profil_schalter SET aktiv=false WHERE funktion='runtime_tool_ausgabe'");
  process.env.SYNAPSE_INTERN_TOOL = '1';
  // User 0eb75179: den echten internen Einstellweg testen, keine handgesetzte Override-Fixture.
  const { fuehreInternAus: intern } = await import('../dist/services/intern-tool.js');
  const { mitUserHerkunft } = await import('../dist/services/user-herkunft.js');
  let ir = await intern({ action: 'schalter_setzen', name: 'runtime_tool_ausgabe', aktiv: true, dauer_min: 5, grund: 'P22-T190 Test' }, 'p22-t190-test');
  ok(ir.success && ir.schalter.bis && ir.schalter.modus === 'freigegeben', 'intern-schalter.ts echter schalter_setzen EIN mit Ablauf', ir);
  ir = await intern({ action: 'schalter_liste', project: P });
  ok(ir.success && ir.moegliche.runtime_tool_ausgabe && ir.runtime_tool_ausgabe.schalter.quelle === 'intern', 'intern-tool.ts schalter_liste zeigt Quelle und Werte', ir.runtime_tool_ausgabe);
  ir = await intern({ action: 'runtime_tool_ausgabe', project: P, tool_ausgabe_werte: setting, grund: 'P22-T190 Test' }, 'fremder-agent');
  ok(!ir.success && ir.error === 'recht_fehlt', 'intern-tool.ts Werte nicht ohne Verwaltungsrecht schreibbar', ir);
  ir = await mitUserHerkunft('web-ui-chat', () => intern({ action: 'runtime_tool_ausgabe', project: P, tool_ausgabe_werte: setting, grund: 'P22-T190 Test' }));
  ok(ir.success && ir.tool_ausgabe.werte.claude_mcp_output_tokens === 120000 && ir.tool_ausgabe.quellen.tool_ausgabe_kontext_prozent === 'einstellung', 'intern-tool.ts echte PG-Werte und Debugquelle', ir);
  ir = await mitUserHerkunft('web-ui-chat', () => intern({ action: 'runtime_tool_ausgabe', project: P, tool_ausgabe_werte: { takt_sekunden: 30 }, grund: 'P22-T190 Test' }));
  ok(!ir.success && ir.error === 'einstellung_unbekannt', 'intern-tool.ts auf vier Werte begrenzt', ir);
  ir = await intern({ action: 'schalter_setzen', name: 'runtime_tool_ausgabe', aktiv: false, dauer_min: 5 });
  ok(ir.success && ir.schalter.bis && ir.schalter.modus === 'freigegeben' && !(await C.leseRuntimeToolAusgabe(P)).schalter.aktiv, 'intern-schalter.ts auch AUS ist befristeter Override', ir);
  ir = await intern({ action: 'schalter_setzen', name: 'runtime_tool_ausgabe', aktiv: true, dauerhaft: true });
  ok(!ir.success && ir.error === 'ablauf_erforderlich', 'intern-schalter.ts kein dauerhafter Override', ir);
  await intern({ action: 'schalter_setzen', name: 'runtime_tool_ausgabe', aktiv: true, dauer_min: 5 });
  ok((await C.leseRuntimeToolAusgabe(P)).schalter.quelle === 'intern', 'befristeter intern-Override');
  // internToolAktiv ist ein Prozess-Startmodus: Produktion ehrlich in separatem Prozess pruefen.
  const prod = spawnSync(process.execPath, ['--input-type=module', '-e', "const {leseRuntimeToolAusgabe}=await import('./packages/core/dist/services/runtime-tool-ausgabe.js');const {getPool}=await import('./packages/core/dist/db/client.js');console.log(JSON.stringify(await leseRuntimeToolAusgabe('p22-t190-test')));await getPool().end();"], { env: { ...process.env, SYNAPSE_INTERN_TOOL: '0' }, encoding: 'utf8', timeout: 15000 });
  ok(prod.status === 0 && !JSON.parse(prod.stdout.trim()).schalter.aktiv, 'Produktion in eigenem Prozess ignoriert intern-Override', { status: prod.status, stdout: prod.stdout, stderr: prod.stderr });
  await pool.query("UPDATE intern_schalter SET bis=now()-interval '1 second'");
  ok(!(await C.leseRuntimeToolAusgabe(P)).schalter.aktiv, 'Ablauf faellt auf PG-AUS');
  await pool.query("UPDATE intern_schalter SET bis=null");
  ok(!(await C.leseRuntimeToolAusgabe(P)).schalter.aktiv, 'unbefristeter intern-Override gilt nicht');
  await pool.query('DROP TABLE intern_schalter');
  ok(!(await C.leseRuntimeToolAusgabe(P)).schalter.aktiv, 'intern-Ausfall faellt auf Produktwert');
  await pool.query("UPDATE agent_profil_schalter SET aktiv=true WHERE funktion='runtime_tool_ausgabe'");
  await pool.query('DROP TABLE runtime_ueberwachung_einstellungen');
  ok(!(await C.leseRuntimeToolAusgabe(P)).schalter.aktiv, 'unlesbare PG-Einstellungen geben kein Read frei');
  console.log('BESTANDEN ' + checks + ' P22-T190 gezielte PG/Guard/Spawn-Vertragspruefungen');
} finally {
  if (C) await C.getPool().end();
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end();
  if (dir) await rm(dir, { recursive: true, force: true });
}
