/**
 * P22-T65 Testphase (nur synapse_test:5433, eigenes privates Schema, Fake-Katalog, kein Netz/Docker):
 *  A pruefeEffortFuerModell: gueltig, Stufe nicht fuer das Modell, ungueltige Form, Modell ohne Stufen, ohne Liste
 *  B Kurznamen: provider_alias_targets vor neuester ID der Familie; Effort gegen diesen Eintrag
 *  C effortFuerStart: standard_effort, gespeicherte Wahl, ungueltige Wahl -> Standard mit Hinweis, Schalter AUS -> null
 *  D Persistenz: completed Wechsel mit effort -> effort_je_modell; Claim liefert effort_konfiguriert; Failover schreibt nicht
 *  E Start: stelleMainLaufSicher setzt die Stufe in die Spawn-Argumente; Ausfuehrer/Selbstwechsel lehnen ungueltige Stufe ab
 *  F Route: effort ungueltig -> 400, Effort ohne Modell = modellwechsel auf aktuelles Modell, Schalter AUS -> effort_nur_mit_modellwahl
 *  G CLI-Argumente: Claude --effort, Codex -c model_reasoning_effort (agents codex-runtime + Altweg), effortFuerCli
 *   node packages/rest-api/tests/hauptagent-effort-p22-t65.test.mjs
 */
import fastify from 'fastify';
import { baueUmgebung, load } from './helfer-hauptagent-modelle.mjs';

const U = await baueUmgebung('p22_t65');
const { C, pool, kat, USER, main, HP, check, section, err, schalterCli, startrezept, offeneWeg } = U;
const MAIN = main.identity_id;
const MA = { art: 'identitaet', principal: { art: 'identity', project: HP, agent_id: 'hauptagent', identity_id: MAIN, rolle: 'main', modell: null, context_epoch: 1, lauf_id: null } };
const sr = async () => (await pool.query('SELECT startrezept, modell_bestaetigt FROM agent_identitaeten WHERE id=$1', [MAIN])).rows[0];

await section('C0 Schalter AUS', async () => {
  check((await C.effortFuerStart('codex', 'codex/gpt-6-luna')).effort === null, 'AUS: kein Effort');
});
await schalterCli(true);

await section('A pruefeEffortFuerModell', async () => {
  const a = await C.pruefeEffortFuerModell('codex', 'codex/gpt-6-luna', 'ultra');
  check(a.ok && a.effort === 'ultra' && a.stufen.includes('ultra'), 'Codex ultra gueltig');
  const b = await C.pruefeEffortFuerModell('claude', 'claude-haiku-5-5', 'ultra');
  check(!b.ok && b.grund === 'effort_nicht_fuer_modell' && b.stufen.join() === 'low,medium,high,xhigh,max', 'Claude ultra ungueltig, Stufen genannt');
  check((await C.pruefeEffortFuerModell('claude', 'claude-haiku-5-5', 'HIGH!')).grund === 'effort_ungueltig', 'ungueltige Form');
  check((await C.pruefeEffortFuerModell('claude', 'claude-haiku-5-5', ' High ')).effort === 'high', 'Gross-/Leerzeichen normalisiert');
  check((await C.pruefeEffortFuerModell('claude', 'claude-haiku-4-5-20251001', 'low')).grund === 'modell_ohne_effort_stufen', 'Modell ohne Stufen -> ehrlich');
  const sic = kat.codex; kat.codex = { modelle: [], grund: 'container_laeuft_nicht' };
  const o = await C.pruefeEffortFuerModell('codex', 'codex/gpt-6-luna', 'high');
  check(o.ok && /Liste nicht lesbar/.test(o.grund), 'ohne Liste: angenommen mit Hinweis');
  kat.codex = sic;
});

await section('B Kurznamen ueber den Katalog', async () => {
  check(C.loeseClaudeKurznamenAuf('opus', kat.claude) === 'claude-opus-5', 'opus -> provider_alias_targets (claude-opus-5)');
  check(C.loeseClaudeKurznamenAuf('sonnet[1m]', kat.claude) === 'claude-sonnet-5-5', 'sonnet ohne Ziel -> neueste ID der Familie');
  check(C.loeseClaudeKurznamenAuf('fable', kat.claude) === 'claude-fable-5-1', 'fable -> neueste der Familie');
  check(C.loeseClaudeKurznamenAuf('claude-opus-5-5', kat.claude) === null && C.loeseClaudeKurznamenAuf('api-opus', kat.claude) === null, 'nur Kurznamen');
  const kaputt = { ...kat.claude, alias_ziele: { opus: 'claude-gibts-nicht' } };
  check(C.loeseClaudeKurznamenAuf('opus', kaputt) === 'claude-opus-5-5', 'Alias-Ziel nicht gelistet -> neueste der Familie');
  check((await C.pruefeEffortFuerModell('claude', 'opus', 'xhigh')).grund === 'effort_nicht_fuer_modell', 'opus -> claude-opus-5 (low..high): xhigh abgelehnt');
  check((await C.pruefeEffortFuerModell('claude', 'opus', 'high')).ok, 'opus high ok');
  check((await C.pruefeEffortFuerModell('claude', 'haiku', 'low')).grund === 'modell_ohne_effort_stufen', 'haiku -> claude-haiku-4-5 ohne Stufen');
  check((await C.effortFuerStart('claude', 'sonnet')).effort === 'medium', 'Kurzname: standard_effort des aufgeloesten Eintrags');
});

await section('C effortFuerStart', async () => {
  const s = await C.effortFuerStart('claude', 'claude-fable-5-1');
  check(s.effort === 'high' && s.quelle === 'standard_effort', 'Standard = standard_effort');
  await startrezept({ effort_je_modell: { 'claude-fable-5-1': 'max', 'codex/gpt-6-luna': 'ultra', 'claude-haiku-5-5': 'ultra' } });
  check((await C.effortFuerStart('claude', 'claude-fable-5-1')).effort === 'max', 'gespeicherte Wahl');
  check((await C.effortFuerStart('codex', 'codex/gpt-6-luna')).quelle === 'user_wahl', 'Codex-Wahl je Modell');
  const u = await C.effortFuerStart('claude', 'claude-haiku-5-5');
  check(u.effort === 'medium' && u.quelle === 'standard_effort' && /effort_wahl_ungueltig: ultra/.test(u.grund), 'ungueltige Wahl -> Standard mit Hinweis');
  const k = await C.effortFuerStart('claude', 'claude-weg-1');
  check(k.effort === null && k.quelle === 'keins', 'unbekanntes Modell -> keins');
  check((await C.leseEffortWahl())['codex/gpt-6-luna'] === 'ultra', 'leseEffortWahl');
});

const claimMelde = async (tatsaechlich) => {
  const [a] = await C.claimeRuntimeAuftraege({ projekte: [HP], arten: ['modellwechsel', 'runtime_wechsel', 'neustart'] });
  if (!a) return null;
  if (tatsaechlich) await C.meldeRuntimeAuftrag({ projekte: [HP], auftrag_id: a.auftrag_id, claim_revision: a.claim_revision, meldung: { schritt: 'completed', tatsaechlich } });
  return a;
};

await section('D Persistenz je Modell', async () => {
  await offeneWeg();
  await startrezept({ effort_je_modell: {}, runtime: 'claude' });
  await C.legeRuntimeAuftragAn(USER, { art: 'modellwechsel', gewuenscht: { modell: 'claude-sonnet-5-5', effort: 'xhigh' }, grund: 'Test T65 Persistenz' });
  const a = await claimMelde({ modell: 'claude-sonnet-5-5', runtime: 'claude' });
  check(a?.gewuenscht?.effort === 'xhigh', 'Daemon bekommt gewuenscht.effort');
  const z = await sr();
  check(z.startrezept.effort_je_modell?.['claude-sonnet-5-5'] === 'xhigh' && z.modell_bestaetigt === 'claude-sonnet-5-5', 'effort_je_modell gespeichert');
  await C.legeRuntimeAuftragAn(USER, { art: 'neustart', grund: 'Test T65 Neustart' });
  const n = await claimMelde(null);
  check(n?.art === 'neustart' && n.effort_konfiguriert === 'xhigh' && n.modell_konfiguriert === 'claude-sonnet-5-5', 'Neustart-Claim: effort_konfiguriert des konfigurierten Modells');
  await offeneWeg();
  await pool.query(`INSERT INTO agent_runtime_auftraege (id, identity_id, art, status, gewuenscht, grund, erstellt_von)
    VALUES (gen_random_uuid(), $1, 'runtime_wechsel', 'pending', '{"runtime":"claude","modell":"claude-sonnet-5-5","effort":"low","failover":"ja"}', 'zurueck:test', 'runtime-ueberwachung')`, [MAIN]);
  await claimMelde({ modell: 'claude-sonnet-5-5', runtime: 'claude' });
  check((await sr()).startrezept.effort_je_modell?.['claude-sonnet-5-5'] === 'xhigh', 'Ueberwachung ueberschreibt die Effort-Wahl nicht');
});

await section('E Start und Ablehnung', async () => {
  await offeneWeg();
  await pool.query("DELETE FROM specialist_jobs WHERE project=$1", [HP]).catch(() => undefined);
  await C.stelleMainLaufSicher({ identity_id: MAIN, runtime: 'claude', modell: 'claude-sonnet-5-5', warte_ms: 0 });
  let j = (await pool.query("SELECT args FROM specialist_jobs WHERE project=$1 AND action='spawn' ORDER BY created_at DESC LIMIT 1", [HP])).rows[0];
  check(j?.args?.model === 'claude-sonnet-5-5' && j.args.effort === 'xhigh', 'Spawn: gespeicherte Stufe des Modells');
  await pool.query("DELETE FROM specialist_jobs WHERE project=$1", [HP]);
  await C.stelleMainLaufSicher({ identity_id: MAIN, runtime: 'codex', modell: 'codex/gpt-6-sol', warte_ms: 0, modell_explizit: true });
  j = (await pool.query("SELECT args FROM specialist_jobs WHERE project=$1 AND action='spawn' ORDER BY created_at DESC LIMIT 1", [HP])).rows[0];
  check(j?.args?.model === 'codex/gpt-6-sol' && j.args.effort === 'medium', 'Spawn ohne Wahl: standard_effort');
  await pool.query("DELETE FROM specialist_jobs WHERE project=$1", [HP]);
  await pool.query(`INSERT INTO agent_runtime_auftraege (id, identity_id, art, status, gewuenscht, grund, erstellt_von)
    VALUES (gen_random_uuid(), $1, 'runtime_wechsel', 'pending', '{"runtime":"claude","modell":"claude-haiku-5-5","effort":"ultra"}', 'Test T65 Ausfuehrer', 'user')`, [MAIN]);
  await C.fuehreRuntimeWechselAus({ weiseMainZu: async () => undefined, zugewiesen: async () => 'claude', standardModell: async () => 'x', warte_ms: 1 });
  const a = (await pool.query("SELECT status, letzter_fehler FROM agent_runtime_auftraege WHERE grund='Test T65 Ausfuehrer'")).rows[0];
  check(a.status === 'rejected' && a.letzter_fehler === 'effort_nicht_fuer_modell', 'Ausfuehrer: ungueltige Stufe -> rejected');
  await startrezept({ erlaubte_modelle: ['claude-sonnet-5-5'], erlaubte_runtimes: ['claude'], runtime: 'claude' });
  check(await err(() => C.legeRuntimeAuftragAn(MA, { art: 'modellwechsel', gewuenscht: { modell: 'claude-sonnet-5-5', effort: 'ultra' }, hands_off: { s: 1 }, grund: 'Test T65 selbst' })) === 'effort_nicht_fuer_modell',
    'Selbstwechsel: ungueltige Stufe abgelehnt');
  const ok = await C.legeRuntimeAuftragAn(MA, { art: 'modellwechsel', gewuenscht: { modell: 'claude-sonnet-5-5', effort: 'High' }, hands_off: { s: 1 }, grund: 'Test T65 selbst' });
  check(ok.auftrag?.gewuenscht?.effort === 'high', 'Selbstwechsel gueltig, Stufe normalisiert');
});

await section('F Route', async () => {
  await offeneWeg();
  const auth = await load('packages/rest-api/dist/services/auth.js');
  const MG = await load('packages/rest-api/dist/services/agent-runtime/manager.js');
  const mgr = MG.getAgentRuntimeManager();
  C.registriereCliModellKatalog(async (rt) => kat[rt]);
  mgr.assertMainRuntimeReady = async () => ({});
  const { agentRuntimeRoutes } = await load('packages/rest-api/dist/routes/agent-runtimes.js');
  const app = fastify(); await app.register(async (f) => agentRuntimeRoutes(f)); await app.ready();
  const SESS = (await auth.issueSessionToken(null, 60_000)).token;
  const post = (body) => app.inject({ method: 'POST', url: '/api/main-agent/wechsel', headers: { authorization: 'Bearer ' + SESS }, payload: body });
  let r = await post({ runtime: 'claude', modell: 'claude-haiku-5-5', effort: 'ultra', grund: 'Test T65 Route' });
  check(r.statusCode === 400 && r.json().error?.code === 'effort_nicht_fuer_modell' && r.json().error?.details?.stufen?.length === 5, 'Route: ungueltige Stufe -> 400 mit Stufen');
  r = await post({ runtime: 'claude', effort: 'low', grund: 'Test T65 Route' });
  const g = r.json().auftrag?.gewuenscht;
  check(r.statusCode === 200 && r.json().auftrag?.art === 'modellwechsel' && g?.modell && g.effort === 'low', 'Effort ohne Modell -> modellwechsel auf aktuelles Modell');
  await offeneWeg();
  await startrezept({ effort_je_modell: { 'codex/gpt-6-luna': 'xhigh' } });
  r = await post({ runtime: 'codex', modell: 'gpt-6-luna', grund: 'Test T65 Route' });
  check(r.statusCode === 200 && r.json().auftrag?.gewuenscht?.effort === 'xhigh', 'Modellwechsel ohne effort: gespeicherte Stufe des Modells');
  await offeneWeg();
  await schalterCli(false);
  r = await post({ runtime: 'claude', modell: 'opus', effort: 'high', grund: 'Test T65 Route AUS' });
  check(r.statusCode === 400 && r.json().error?.code === 'effort_nur_mit_modellwahl', 'Schalter AUS: effort abgelehnt');
  r = await post({ runtime: 'claude', modell: 'opus', grund: 'Test T65 Route AUS' });
  check(r.statusCode === 200 && r.json().auftrag?.gewuenscht?.effort === undefined, 'Schalter AUS: ohne effort unveraendert');
  await schalterCli(true);
  await app.close();
  MG.shutdownAgentRuntimeManager();
});

await section('G CLI-Argumente', async () => {
  const M = await load('packages/agents/dist/models.js');
  const R = await load('packages/agents/dist/codex-runtime.js');
  const CD = await load('packages/rest-api/dist/services/agent-runtime/claude-driver.js');
  const XD = await load('packages/rest-api/dist/services/agent-runtime/codex-driver.js');
  const args = R.baueCodexArgs({ threadId: null, cwd: '/p', modell: 'gpt-6-luna', deaktiviert: [], mcpOverrides: [], effort: 'ultra' });
  const i = args.indexOf('model_reasoning_effort="ultra"');
  check(i > 0 && args[i - 1] === '-c' && args.includes('-m'), 'codex-runtime: -c model_reasoning_effort="ultra"');
  check(!R.baueCodexArgs({ threadId: 't', cwd: '/p', modell: null, deaktiviert: [], mcpOverrides: [] }).some((a) => /reasoning/.test(a)), 'codex-runtime ohne Stufe unveraendert');
  check(!R.baueCodexArgs({ threadId: null, cwd: '/p', modell: null, deaktiviert: [], mcpOverrides: [], effort: 'x"; rm' }).some((a) => /reasoning/.test(a)), 'unsichere Stufe nie in argv');
  const c = CD.buildClaudeCommand(null, 'claude-haiku-5-5', null, 'artefakt-only', null, 'xhigh');
  check(c[c.indexOf('--effort') + 1] === 'xhigh', 'Altweg Claude: --effort');
  const x = XD.buildCodexCommand(null, 'high');
  check(x[x.indexOf('-c') + 1] === 'model_reasoning_effort="high"', 'Altweg Codex: -c model_reasoning_effort');
  const e = M.resolveModel('codex/gpt-6-luna');
  check(e?.fullId === 'gpt-6-luna' && M.effortFuerCli(e, 'ultra') === 'ultra' && M.effortFuerCli(e, undefined) === undefined, 'effortFuerCli Codex: Stufe durchreichen, ohne -> kein Flag');
  // P22-T75: claude-haiku-5-5 steht jetzt in der Registry (alias haiku, 1M, Stufen low..max); der Katalogweg gilt fuer IDs, die die
  // Registry NICHT kennt (neue CLI-Version).
  const h = M.resolveModel('claude-haiku-5-5');
  check(h?.alias === 'haiku' && !h.ausCliKatalog && h.contextWindow === 1_000_000 && M.effortFuerCli(h, 'xhigh') === 'xhigh' && M.cliModelArgFuer('claude-haiku-5-5', h) === 'claude-haiku-5-5', 'Registry-Claude haiku 5.5: Stufe aus der Registry, --model unveraendert');
  const k = M.resolveModel('claude-haiku-9-9');
  check(k?.ausCliKatalog === true && M.effortFuerCli(k, 'xhigh') === 'xhigh' && M.cliModelArgFuer('claude-haiku-9-9', k) === 'claude-haiku-9-9', 'Katalog-Claude: --effort durchgereicht, --model unveraendert');
  check(M.cliModelArgFuer('claude-opus-5-5', M.resolveModel('claude-opus-5-5')) === 'claude-opus-5-5', 'Katalog-ID nicht auf Kurznamen zurueckgefallen');
  let geworfen = false; try { M.effortFuerCli(e, 'HIGH!'); } catch { geworfen = true; }
  check(geworfen, 'ungueltige Form -> Fehler vor dem Start');
  check(M.effortFuerCli(M.resolveModel('opus'), undefined) === 'medium', 'Registry-Modelle unveraendert (default_effort)');
});

await U.ende('P22-T65');
