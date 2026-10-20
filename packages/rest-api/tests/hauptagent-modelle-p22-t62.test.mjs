/**
 * P22-T62 Testphase (nur synapse_test:5433, eigenes privates Schema, Fake-Katalog statt Container, kein Netz/Docker):
 *  A Schalter AUS: Altregel /^codex/, Standard = Altstandard, Befehle byte-gleich
 *  B pruefeModellFuerRuntime (EIN): gelistet, nicht gelistet, falsche Runtime, Kurzname, ohne Liste
 *  C waehleKleinstesModell: Familienordnung, nur sichtbar/main, Listenreihenfolge, unbekannte Familie, leere Liste
 *  D standardModellFuerRuntime: User-Wahl > Profil-Modell > kleinstes, 'Liste nicht lesbar', keins
 *  E Persistenz: completed Wechsel von User schreibt modell_je_runtime; Ueberwachung schreibt nie
 *  F Ablehnung: Ausfuehrer (runtime_wechsel mit ungelistetem Modell rejected), Selbstwechsel des Main gegen die Liste
 *  G Route POST /api/main-agent/wechsel: 400 bei ungelistetem Modell, Codex-slug normalisiert; GET /api/main-agent/modelle
 *   node packages/rest-api/tests/hauptagent-modelle-p22-t62.test.mjs
 */
import fastify from 'fastify';
import { baueUmgebung, load } from './helfer-hauptagent-modelle.mjs';

const U = await baueUmgebung('p22_t62');
const { C, pool, kat, USER, main, HP, check, section, err, schalterCli, startrezept, offeneWeg } = U;
const MAIN = main.identity_id;
const MA = { art: 'identitaet', principal: { art: 'identity', project: HP, agent_id: 'hauptagent', identity_id: MAIN, rolle: 'main', modell: null, context_epoch: 1, lauf_id: null } };

await section('A Schalter AUS = Altverhalten', async () => {
  check((await C.leseCliModelleSchalter()).aktiv === false, 'Standard AUS');
  const p = await C.pruefeModellFuerRuntime('gpt-6-luna', 'codex');
  check(p.quelle === 'schalter_aus' && p.passt === false && p.modell === 'gpt-6-luna', 'AUS: Codex nur codex* (Altregel), keine Normalisierung');
  check((await C.pruefeModellFuerRuntime('codex', 'codex')).passt && (await C.pruefeModellFuerRuntime('opus', 'claude')).passt, 'AUS: Aliase wie bisher');
  const s = await C.standardModellFuerRuntime('claude', async () => 'sonnet');
  check(s.modell === 'sonnet' && s.quelle === 'schalter_aus', 'AUS: Altstandard');
  const e = await C.effortFuerStart('claude', 'claude-haiku-5-5');
  check(e.effort === null && e.quelle === 'schalter_aus', 'AUS: kein Effort aus der Modellwahl');
  const CD = await load('packages/rest-api/dist/services/agent-runtime/claude-driver.js');
  const XD = await load('packages/rest-api/dist/services/agent-runtime/codex-driver.js');
  check(JSON.stringify(CD.buildClaudeCommand(null, 'sonnet')) === JSON.stringify(CD.buildClaudeCommand(null, 'sonnet', null, 'artefakt-only', null, null)), 'Claude-Befehl ohne Stufe byte-gleich');
  check(JSON.stringify(XD.buildCodexCommand('t-1')) === JSON.stringify(XD.buildCodexCommand('t-1', null)) && !XD.buildCodexCommand(null).includes('-c'), 'Codex-Befehl ohne Stufe byte-gleich');
  const sch = await load('packages/core/dist/services/agent-profil-schalter.js');
  check(sch.PROFIL_PRODUKT_FUNKTIONEN.includes('hauptagent_cli_modelle'), 'Schalter im Katalog');
  await C.setzeProfilProduktSchalter({ ebene: 'global', funktion: 'alle', aktiv: true, grund: 'Test T62 alle' }, { system: 'user' }).catch(() => undefined);
  check((await C.leseCliModelleSchalter()).aktiv === false, "'alle' schaltet hauptagent_cli_modelle nicht");
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='alle'");
});

await schalterCli(true);

await section('B pruefeModellFuerRuntime (EIN)', async () => {
  check((await C.leseCliModelleSchalter()).quelle === 'produkt-schalter', 'EIN ueber Produkt-Schalter, Quelle sichtbar');
  const a = await C.pruefeModellFuerRuntime('gpt-6-luna', 'codex');
  check(a.passt && a.modell === 'codex/gpt-6-luna' && a.gelistet === true && a.quelle === 'liste', 'Codex-slug -> codex/<slug>, gelistet');
  check((await C.pruefeModellFuerRuntime('codex/gpt-6-luna', 'codex')).passt, 'codex/<slug> gelistet');
  const b = await C.pruefeModellFuerRuntime('codex/gpt-9-weg', 'codex');
  check(!b.passt && b.grund === 'modell_nicht_gelistet' && b.gelistet === false, 'nicht gelistet -> ehrlich');
  check((await C.pruefeModellFuerRuntime('codex', 'codex')).passt, "'codex' = CLI-Standard");
  check((await C.pruefeModellFuerRuntime('claude-opus-5-5', 'codex')).grund === 'modell_gehoert_zu_claude', 'Claude-ID auf Codex abgelehnt');
  check((await C.pruefeModellFuerRuntime('codex/gpt-6-luna', 'claude')).grund === 'modell_gehoert_zu_codex', 'Codex-ID auf Claude abgelehnt');
  check((await C.pruefeModellFuerRuntime('gpt-6-luna', 'claude')).grund === 'modell_gehoert_zu_codex', 'Codex-slug ohne Praefix auf Claude erkannt');
  check((await C.pruefeModellFuerRuntime('claude-haiku-5-5', 'claude')).passt, 'Claude-Katalog-ID gelistet');
  check((await C.pruefeModellFuerRuntime('claude-weg-1', 'claude')).grund === 'modell_nicht_gelistet', 'Claude nicht gelistet');
  check((await C.pruefeModellFuerRuntime('opus[1m]', 'claude')).quelle === 'alias', 'Kurzname bleibt Alias');
  const sic = kat.claude; kat.claude = { modelle: [], grund: 'container_laeuft_nicht' };
  const o = await C.pruefeModellFuerRuntime('claude-haiku-5-5', 'claude');
  check(o.passt && o.quelle === 'ohne_liste' && /container_laeuft_nicht/.test(o.grund), 'ohne Liste: Zuordnung zur Runtime + Grund');
  kat.claude = sic;
});

await section('C waehleKleinstesModell (Familienordnung)', async () => {
  const c = C.waehleKleinstesModell('claude', kat.claude);
  check(c.id === 'claude-haiku-5-5' && /haiku < sonnet < opus < fable/.test(c.grund) && /section main/.test(c.grund), 'Claude: haiku aus section main');
  const x = C.waehleKleinstesModell('codex', kat.codex);
  check(x.id === 'gpt-6-luna' && /luna < terra < sol < astra/.test(x.grund) && /-> gpt-6-luna/.test(x.grund), 'Codex: luna, neueste laut Listenreihenfolge');
  check(C.FAMILIEN_ORDNUNG.claude.join() === 'haiku,sonnet,opus,fable' && C.FAMILIEN_ORDNUNG.codex.join() === 'luna,terra,sol,astra', 'Ordnung laut Entscheidung');
  const mitUnbekannt = { grund: null, modelle: [{ id: 'gpt-7-nova', sichtbar: true, familie: null }, ...kat.codex.modelle] };
  const u = C.waehleKleinstesModell('codex', mitUnbekannt);
  check(u.id === 'gpt-6-luna' && /unbekannte Familie.*gpt-7-nova=nova/.test(u.grund), 'unbekannte Familie genannt, nicht geraten');
  const nur = C.waehleKleinstesModell('codex', { grund: null, modelle: [{ id: 'gpt-7-nova', sichtbar: true }] });
  check(nur.id === null && /keine_bekannte_familie/.test(nur.grund), 'nur unbekannte Familie -> keins');
  check(C.waehleKleinstesModell('claude', { grund: 'x', modelle: [] }).id === null, 'leere Liste -> keins');
  check(C.waehleKleinstesModell('codex', { grund: null, modelle: [{ id: 'gpt-6-luna', sichtbar: false }] }).grund.startsWith('keine_sichtbaren'), 'nur versteckte -> keins');
});

await section('D Standard-Reihenfolge User-Wahl > Profil > kleinstes', async () => {
  const s0 = await C.standardModellFuerRuntime('claude', async () => 'sonnet');
  check(s0.modell === 'opus' && s0.quelle === 'profil', 'ohne User-Wahl: Profil-Modell (modell_bestaetigt opus)');
  const x0 = await C.standardModellFuerRuntime('codex', async () => 'codex');
  check(x0.modell === 'codex/gpt-6-luna' && x0.quelle === 'kleinstes', 'Codex: Profil gehoert zu Claude -> kleinstes');
  await startrezept({ modell_je_runtime: { claude: 'claude-sonnet-5-5', codex: 'codex/gpt-6-sol' } });
  check((await C.standardModellFuerRuntime('claude', async () => 'x')).modell === 'claude-sonnet-5-5', 'User-Wahl Claude');
  const x1 = await C.standardModellFuerRuntime('codex', async () => 'x');
  check(x1.modell === 'codex/gpt-6-sol' && x1.quelle === 'user_wahl', 'User-Wahl Codex');
  await startrezept({ modell_je_runtime: { claude: 'claude-weg-1' } });
  const s2 = await C.standardModellFuerRuntime('claude', async () => 'x');
  check(s2.quelle === 'profil' && /user_wahl_ungueltig: claude-weg-1/.test(s2.grund), 'ungelistete User-Wahl -> Profil mit Hinweis');
  await startrezept({ modell_je_runtime: { claude: 'claude-sonnet-5-5' } });
  const sic = kat.claude; kat.claude = { modelle: [], grund: 'abfrage_fehlgeschlagen: zeitlimit' };
  const s3 = await C.standardModellFuerRuntime('claude', async () => 'x');
  check(s3.modell === 'claude-sonnet-5-5' && s3.quelle === 'user_wahl' && /Liste nicht lesbar, gespeichertes Modell verwendet/.test(s3.grund), 'Liste nicht lesbar -> gespeicherte Wahl mit Hinweis, kein Abbruch');
  await startrezept({ modell_je_runtime: {} });
  await pool.query('UPDATE agent_identitaeten SET modell_bestaetigt=NULL WHERE id=$1', [MAIN]);
  const s4 = await C.standardModellFuerRuntime('claude', async () => 'x');
  check(s4.modell === null && s4.quelle === 'keins' && /modellliste_fehlt/.test(s4.grund), 'nichts gespeichert + keine Liste -> ehrlich keins');
  kat.claude = sic;
  await pool.query("UPDATE agent_identitaeten SET modell_bestaetigt='opus' WHERE id=$1", [MAIN]);
});

const claimMelde = async (tatsaechlich) => {
  const [a] = await C.claimeRuntimeAuftraege({ projekte: [HP], arten: ['modellwechsel', 'runtime_wechsel', 'neustart'] });
  if (!a) return null;
  await C.meldeRuntimeAuftrag({ projekte: [HP], auftrag_id: a.auftrag_id, claim_revision: a.claim_revision, meldung: { schritt: 'completed', tatsaechlich } });
  return a;
};
const sr = async () => (await pool.query('SELECT startrezept, modell_bestaetigt FROM agent_identitaeten WHERE id=$1', [MAIN])).rows[0];

await section('E Persistenz je Runtime', async () => {
  await offeneWeg();
  await C.legeRuntimeAuftragAn(USER, { art: 'runtime_wechsel', gewuenscht: { runtime: 'codex', modell: 'codex/gpt-6-astra' }, grund: 'Test T62 Persistenz' });
  check(!!(await claimMelde({ modell: 'codex/gpt-6-astra', runtime: 'codex' })), 'Auftrag ausgefuehrt');
  let z = await sr();
  check(z.startrezept.modell_je_runtime?.codex === 'codex/gpt-6-astra' && z.startrezept.runtime === 'codex' && z.modell_bestaetigt === 'codex/gpt-6-astra', 'User-Wechsel: modell_je_runtime.codex gespeichert');
  await pool.query(`INSERT INTO agent_runtime_auftraege (id, identity_id, art, status, gewuenscht, grund, erstellt_von)
    VALUES (gen_random_uuid(), $1, 'runtime_wechsel', 'pending', '{"runtime":"codex","modell":"codex/gpt-6-luna","failover":"ja"}', 'failover:test', 'runtime-ueberwachung')`, [MAIN]);
  await claimMelde({ modell: 'codex/gpt-6-luna', runtime: 'codex' });
  z = await sr();
  check(z.startrezept.modell_je_runtime?.codex === 'codex/gpt-6-astra', 'Failover ueberschreibt die User-Wahl nicht');
  check((await C.leseUserModellWahl()).codex === 'codex/gpt-6-astra', 'leseUserModellWahl');
  await schalterCli(false);
  await C.legeRuntimeAuftragAn(USER, { art: 'runtime_wechsel', gewuenscht: { runtime: 'claude', modell: 'sonnet' }, grund: 'Test T62 AUS' });
  await claimMelde({ modell: 'sonnet', runtime: 'claude' });
  check((await sr()).startrezept.modell_je_runtime?.claude === undefined, 'Schalter AUS: keine neue Ablage');
  await schalterCli(true);
});

await section('F Ablehnung: Ausfuehrer und Selbstwechsel', async () => {
  await offeneWeg();
  await pool.query(`INSERT INTO agent_runtime_auftraege (id, identity_id, art, status, gewuenscht, grund, erstellt_von)
    VALUES (gen_random_uuid(), $1, 'runtime_wechsel', 'pending', '{"runtime":"codex","modell":"codex/gpt-9-weg"}', 'Test T62 Ausfuehrer', 'user')`, [MAIN]);
  const n = await C.fuehreRuntimeWechselAus({ weiseMainZu: async () => undefined, zugewiesen: async () => 'claude', standardModell: async () => 'codex', warte_ms: 1 });
  const a = (await pool.query("SELECT status, letzter_fehler FROM agent_runtime_auftraege WHERE grund='Test T62 Ausfuehrer'")).rows[0];
  check(n === 1 && a.status === 'rejected' && a.letzter_fehler === 'modell_nicht_gelistet', 'Ausfuehrer: ungelistet -> rejected modell_nicht_gelistet (kein stilles Ersetzen)');
  await startrezept({ erlaubte_modelle: ['claude-weg-1', 'claude-sonnet-5-5'], erlaubte_runtimes: ['claude', 'codex'], runtime: 'claude' });
  await offeneWeg();
  check(await err(() => C.legeRuntimeAuftragAn(MA, { art: 'modellwechsel', gewuenscht: { modell: 'claude-weg-1' }, hands_off: { stand: 'x' }, grund: 'Test T62 selbst' })) === 'modell_nicht_gelistet',
    'Selbstwechsel: im Rahmen, aber nicht gelistet -> abgelehnt');
  check(await err(() => C.legeRuntimeAuftragAn(MA, { art: 'modellwechsel', gewuenscht: { modell: 'claude-opus-5-5' }, hands_off: { stand: 'x' }, grund: 'Test T62 selbst' })) === 'ausserhalb_rahmen',
    'Selbstwechsel: Rahmen gilt weiter');
  const ok = await C.legeRuntimeAuftragAn(MA, { art: 'modellwechsel', gewuenscht: { modell: 'claude-sonnet-5-5' }, hands_off: { stand: 'x' }, grund: 'Test T62 selbst' });
  check(ok.auftrag?.gewuenscht?.modell === 'claude-sonnet-5-5', 'Selbstwechsel gelistet + im Rahmen -> angelegt');
  const u = await C.legeRuntimeAuftragAn(USER, { art: 'runtime_wechsel', gewuenscht: { runtime: 'codex', modell: 'codex/gpt-6-luna' }, grund: 'Test T62 User ausserhalb Rahmen' });
  check(!!u.auftrag, 'User-Wechsel scheitert nicht am Rahmen');
});

await section('G Route /api/main-agent/wechsel und /modelle', async () => {
  await offeneWeg();
  const auth = await load('packages/rest-api/dist/services/auth.js');
  const MG = await load('packages/rest-api/dist/services/agent-runtime/manager.js');
  const mgr = MG.getAgentRuntimeManager();
  C.registriereCliModellKatalog(async (rt) => kat[rt]);
  mgr.assertMainRuntimeReady = async () => ({});
  const fakeStatus = (rt) => ({ runtime: rt, role: 'main', configured: true, installed: true, rootPath: '/r', image: 'i', model: null,
    container: { name: 'c', id: '1', status: rt === 'codex' ? 'stopped' : 'running' }, authentication: { status: 'authenticated' }, version: 'v', lastError: null, assignedToMain: rt === 'claude' });
  mgr.listStatuses = async () => [fakeStatus('claude'), fakeStatus('codex')];
  for (const rt of ['claude', 'codex']) mgr.driver(rt).modelle = async () => ({ ...kat[rt], runtime: rt, quelle: 'datei', quelle_detail: 'fake', stand: null, veraltet_ab: null, cli_version: 'fake', hinweise: [], abgefragt_am: new Date().toISOString(),
    modelle: kat[rt].modelle.map((m) => ({ ...m, kontext_ein: null, kontext_aus: null, effort_details: [] })) });
  const { agentRuntimeRoutes } = await load('packages/rest-api/dist/routes/agent-runtimes.js');
  const app = fastify(); await app.register(async (f) => agentRuntimeRoutes(f)); await app.ready();
  const SESS = (await auth.issueSessionToken(null, 60_000)).token;
  const post = (body) => app.inject({ method: 'POST', url: '/api/main-agent/wechsel', headers: { authorization: 'Bearer ' + SESS }, payload: body });
  let r = await post({ runtime: 'codex', modell: 'gpt-9-weg', grund: 'Test T62 Route' });
  check(r.statusCode === 400 && r.json().error?.code === 'modell_nicht_gelistet', 'Route: ungelistet -> 400 modell_nicht_gelistet');
  r = await post({ runtime: 'claude', modell: 'codex/gpt-6-luna', grund: 'Test T62 Route' });
  check(r.statusCode === 400 && r.json().error?.code === 'modell_gehoert_zu_codex', 'Route: falsche Runtime -> 400');
  r = await post({ runtime: 'codex', modell: 'gpt-6-luna', grund: 'Test T62 Route' });
  check(r.statusCode === 200 && r.json().auftrag?.gewuenscht?.modell === 'codex/gpt-6-luna', 'Route: Codex-slug normalisiert, Auftrag angelegt');
  const m = await app.inject({ method: 'GET', url: '/api/main-agent/modelle', headers: { authorization: 'Bearer ' + SESS } });
  const j = m.json();
  const cl = j.runtimes?.find((x) => x.runtime === 'claude'), cx = j.runtimes?.find((x) => x.runtime === 'codex');
  check(m.statusCode === 200 && j.schalter?.aktiv === true && cl?.bereit === true && cl.modelle.length === kat.claude.modelle.length, 'GET modelle: Claude bereit mit Liste');
  check(cx?.bereit === false && cx.grund === 'container_stopped' && cx.modelle.length === 0, 'GET modelle: Codex nicht bereit mit ehrlichem Grund, ohne Liste');
  check(typeof cl?.standard_grund === 'string' || cl?.standard_grund === null, 'standard_grund in der Antwort');
  check(cl.modelle.every((x) => typeof x.modell === 'string'), 'Synapse-ID je Modell');
  await schalterCli(false);
  r = await post({ runtime: 'codex', modell: 'gpt-9-weg', grund: 'Test T62 Route AUS' });
  check(r.statusCode !== 400 || r.json().error?.code !== 'modell_nicht_gelistet', 'Schalter AUS: keine Listenpruefung an der Route');
  await app.close();
  MG.shutdownAgentRuntimeManager();
});

await U.ende('P22-T62');
