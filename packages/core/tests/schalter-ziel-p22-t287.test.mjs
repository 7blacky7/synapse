/**
 * P22-T287 S1: Produkt-Schalter je Agent (User 08.11.2026, Festlegung thought fa7c00cf, Konzept ebe24645).
 * Prueft packages/core/src/services/agent-profil-schalter-ziel.ts, die Lesestelle agent-profil-schalter.ts:leseProfilProduktSchalter
 * (Zielstufe, Puffer) und admin profil_schalter_setzen/status mit ziel_ebene (agent-profil-admin.ts).
 *   A Katalog: schalter_identitaet (nur ausdruecklich, Zweck), Positivliste im Katalog, Parameter ziel_ebene
 *   B rein: Namensmuster, Rang identitaet > agent exakt > agent Muster > typ
 *   C Schema 182 idempotent, Standard AUS
 *   D Mechanik AUS: Setzen funktion_aus, vorhandene Zielzeilen wirkungslos (= heutiges Verhalten)
 *   E Rechte: User, Koordinator mit Ausweis, Legacy-Koordinator ja; Subagent, Legacy-Nichtkoordinator, fremder Koordinator nein
 *   E2 User-Korrektur 27f9c071: Agent ohne Ausweis setzt nur mit Schalter schalter_setzen_ohne_ausweis, nur Projekt der Anfrage,
 *      Grund min. 10, nicht unter Ausweis-Namen, Audit herkunft/agent_id; Agenten MIT Ausweis weiterhin nicht
 *   F Validierung: nicht ziel-faehig, alle, unbekannte Identitaet/Typ, Muster nur *, Grund
 *   G Rang ueber projekt/global, andere Identitaet unberuehrt, ziel null = Projektsicht
 *   H Aufrufkontext: Ausweis, Legacy-Muster, fremdes Projekt
 *   I Puffer: Ziel im Schluessel, Schreiben leert sofort
 *   J Entfernen = erben, Verlauf + agent_identitaet_audit
 *   K admin-Dispatcher setzen/status mit ziel_ebene, Status ohne Ziel = Projektsicht
 *   L Mechanik wieder AUS: Regeln bleiben gespeichert, wirken nicht
 *   M Lesefehler (Tabelle fehlt): projekt/global + ziel_fehler
 *   O S2 kontextprofil-Bruecke: AUS = Altweg, EIN = identity:<id> ins Profil (stufe/budget/hinweise_aus/_nur, liste, entfernen), Rechte
 *   P S2 profil_antwortanpassung: Standard AUS, Produkt projekt/identitaet, Env-Rueckfall, Produkt-AUS > Env, intern-Override > Produkt
 *   E2 ergaenzt: ohne Ausweis nur ebene agent (identitaet/typ -> nur_ebene_agent)
 *   N Pruefer 9ff7ab0f P6: Regeln eines entfernten Agenten aufraeumen; P2 Main mit main_verwaltung (E); P4 agent-Ebene nur ohne Ausweis (G)
 * Aufruf (Repo-Root, nach Build von core):
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/schalter-ziel-p22-t287.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pruefeTestDbUrl} from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('P22-T287');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/synapse_test', 'P22-T287: nur gegen synapse_test');
const schema = 'p22t287_' + randomUUID().replaceAll('-', '');
const P = 'p22-t287-' + randomUUID().slice(0, 8);
const Q = P + '-fremd';
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const repo = new URL('../../../', import.meta.url);
const load = p => import(new URL(p, repo).href);
// SYNAPSE_INTERN_TOOL=1 beim Laden (internToolAktiv wird festgehalten) fuer den Vorrang-Test des intern-Overrides (Abschnitt P).
Object.assign(process.env, {DATABASE_URL: url.toString(), SYNAPSE_DATABASE_URL: url.toString(), SYNAPSE_SCHEMA: 'aus', SYNAPSE_W1B_GATE_TTL_MS: '0', SYNAPSE_INTERN_TOOL: '1',
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9'});

let pass = 0;
// Herkunft je Pruefung (regel-tests-mit-herkunft-kommentieren): Label = Task + Teil + Quelle; bei Fehlschlag Debugzeile.
const ok = (cond, label, detail) => {
  if (!cond) console.error('DEBUG ' + label + ' | tatsaechlich: ' + JSON.stringify(detail ?? null).slice(0, 1500));
  assert.ok(cond, label);
  pass++; console.log('PASS ' + label);
};
const fehlerCode = async (fn) => { try { await fn(); return null; } catch (e) { return e?.code ?? String(e?.message ?? e); } };

let pool;
try {
  const core = await load('packages/core/dist/index.js');
  pool = (await load('packages/core/dist/db/client.js')).getPool();
  await pool.query('CREATE SCHEMA "' + schema + '"');
  for (const t of ['agent_profil_schalter', 'agent_identitaeten', 'agent_typen', 'agent_identitaet_audit', 'agent_sessions',
    'agent_typ_revisionen', 'agent_profil_revisionen', 'agent_persona_zuweisungen', 'intern_schalter', 'memories']) {
    const ex = await pool.query("SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1", [t]);
    if (ex.rows.length) await pool.query('CREATE TABLE "' + schema + '"."' + t + '" (LIKE public."' + t + '" INCLUDING ALL)');
  }
  const S = await load('packages/core/dist/services/agent-profil-schalter.js');
  const Z = await load('packages/core/dist/services/agent-profil-schalter-ziel.js');
  const A = await load('packages/core/dist/services/agent-profil-admin.js');
  const SL = await load('packages/core/dist/services/admin-schlank.js');
  const F = 'tool_antworten_schlank';
  const USER = {art: 'user'};
  const ident = (id, agent, rolle, project = P, typ = null) => pool.query(
    'INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von, typ_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, project, agent, agent, rolle, 'test', typ]);
  const principal = (id, agent, rolle, project = P) => ({art: 'identity', project, agent_id: agent, identity_id: id, rolle, modell: null, context_epoch: 0, lauf_id: null});
  const akteurId = (id, agent, rolle, project = P) => ({art: 'identitaet', principal: principal(id, agent, rolle, project)});
  const projektSchalter = (funktion, aktiv, project = P) => S.setzeProfilProduktSchalter({ebene: 'projekt', project, funktion, aktiv, grund: 'P22-T287 Testlauf'}, {system: 'user'});
  const setze = (e, akteur = USER) => Z.setzeZielSchalter({project: P, funktion: F, grund: 'P22-T287 Testlauf', ...e}, akteur);
  const lies = (ziel, funktion = F, project = P) => S.leseProfilProduktSchalter(funktion, project, ziel);
  const BEZUG = {modus: 'beide', standard: 'alt', quelle: 'standard', bis: null, letzter_fehler: null};
  const imKontext = (p, fn) => core.mitAgentAufrufKontext({bezug: BEZUG, principal: p}, fn);

  // A Katalog -------------------------------------------------------------------------------------------------
  ok(S.PROFIL_PRODUKT_FUNKTIONEN.includes('schalter_identitaet') && S.NUR_AUSDRUECKLICH.includes('schalter_identitaet') && !S.STANDARD_EIN.includes('schalter_identitaet'),
    'P22-T287 A agent-profil-schalter.ts: schalter_identitaet im Katalog, nur ausdruecklich, Standard AUS');
  ok(typeof SL.PROFIL_SCHALTER_ZWECK.schalter_identitaet === 'string', 'P22-T287 A admin-schlank.ts: Zweckzeile schalter_identitaet');
  const fremdeNamen = Z.ZIEL_FAEHIGE_FUNKTIONEN.filter(f => !S.PROFIL_PRODUKT_FUNKTIONEN.includes(f));
  ok(fremdeNamen.length === 0 && !Z.ZIEL_FAEHIGE_FUNKTIONEN.includes('schalter_identitaet'), 'P22-T287 A Positivliste nur aus dem Katalog, Mechanik-Schalter selbst nicht je Agent', fremdeNamen);
  ok(A.W1B_ADMIN_PARAMETER.ziel_ebene?.enum?.join() === 'identitaet,agent,typ', 'P22-T287 A agent-profil-admin.ts: Parameter ziel_ebene', A.W1B_ADMIN_PARAMETER.ziel_ebene);

  // B rein ----------------------------------------------------------------------------------------------------
  ok(Z.agentMusterPasst('luna-*', 'luna-7') && !Z.agentMusterPasst('luna-*', 'xluna-7') && Z.agentMusterPasst('a.b', 'a.b') && !Z.agentMusterPasst('a.b', 'axb'),
    'P22-T287 B agentMusterPasst: * beliebig, Punkt woertlich');
  const z = (ebene, ziel, aktiv) => ({ebene, ziel, aktiv, grund: 'g', gesetzt_von: 'user', gesetzt_am: new Date(0)});
  const zeilen = [z('typ', 't', true), z('agent', 'luna-*', false), z('agent', 'lu*', true), z('agent', 'luna-7', true), z('agent', 'mars-*', true)];
  ok(Z.waehleZielTreffer(zeilen, 'luna-7').ziel === 'luna-7', 'P22-T287 B Rang: agent exakt vor Muster und Typ');
  ok(Z.waehleZielTreffer(zeilen.filter(x => x.ziel !== 'luna-7'), 'luna-7').ziel === 'luna-*', 'P22-T287 B Rang: laengeres Muster vor kuerzerem');
  ok(Z.waehleZielTreffer([...zeilen, z('identitaet', 'id-1', false)], 'luna-7').ebene === 'identitaet', 'P22-T287 B Rang: identitaet vor allem');
  ok(Z.waehleZielTreffer([z('typ', 't', true), z('agent', 'mars-*', false)], 'luna-7').ebene === 'typ', 'P22-T287 B fremdes Muster greift nicht, Typ bleibt');
  ok(Z.waehleZielTreffer([z('agent', 'luna-*', true)], null) === null, 'P22-T287 B ohne Agentnamen kein Agent-Treffer');

  // C Schema --------------------------------------------------------------------------------------------------
  await pool.query(core.AGENT_PROFIL_SCHALTER_ZIEL_SCHEMA_SQL);
  await pool.query(core.AGENT_PROFIL_SCHALTER_ZIEL_SCHEMA_SQL);
  ok((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'agent_profil_schalter_ziel%'", [schema])).rows[0].n === 2,
    'P22-T287 C Schema 182 zweimal ausgefuehrt (idempotent), beide Tabellen im Testschema');
  ok((await lies(null, 'schalter_identitaet')).aktiv === false, 'P22-T287 C schalter_identitaet Standard AUS');

  await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('t287-klein','projekt',$1,'klein-64k',1,'test'),('t287-global','global',NULL,'t287-global',1,'test'),('t287-fremd','projekt',$2,'t287-fremd',1,'test')", [P, Q]);
  await ident('id-koord', 'koordinator-t287', 'koordinator');
  await ident('id-sub', 'sub-1', 'subagent', P, 't287-klein');
  await ident('id-sub2', 'sub-2', 'subagent', P, 't287-klein');
  await ident('id-andere', 'andere-1', 'subagent');
  await ident('id-fremdkoord', 'koordinator-fremd', 'koordinator', Q);
  await ident('id-main', 'main', 'main', P);

  // D Mechanik AUS ---------------------------------------------------------------------------------------------
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: true})) === 'funktion_aus', 'P22-T287 D Setzen bei schalter_identitaet AUS -> funktion_aus');
  await pool.query("INSERT INTO agent_profil_schalter_ziel (ebene,project,ziel,funktion,aktiv,grund,gesetzt_von) VALUES ('identitaet',$1,'id-sub',$2,true,'direkt','test')", [P, F]);
  let st = await lies({identity_id: 'id-sub', agent_id: 'sub-1'});
  ok(st.aktiv === false && st.quelle === 'standard' && st.ziel_ebene === undefined, 'P22-T287 D vorhandene Zielzeile wirkungslos bei AUS (= heutiges Verhalten)', st);
  await pool.query('DELETE FROM agent_profil_schalter_ziel');
  await projektSchalter('schalter_identitaet', true);

  // E Rechte ---------------------------------------------------------------------------------------------------
  ok((await setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: true})).wer === 'user', 'P22-T287 E User setzt');
  ok((await setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: true}, akteurId('id-koord', 'koordinator-t287', 'koordinator'))).wer === 'id-koord', 'P22-T287 E Koordinator mit Ausweis setzt (eigenes Projekt)');
  ok((await setze({ebene: 'identitaet', ziel: 'id-koord', aktiv: true}, akteurId('id-koord', 'koordinator-t287', 'koordinator'))).geaendert === true,
    'P22-T287 E Koordinator darf fuer sich selbst (Festlegung fa7c00cf: nur normale Agenten nie)');
  ok((await setze({ebene: 'agent', ziel: 'luna-*', aktiv: true}, {art: 'legacy_koordinator', agent_id: 'koordinator'})).wer === 'legacy:koordinator', 'P22-T287 E Legacy-Koordinator ohne Ausweis setzt');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: false}, akteurId('id-sub', 'sub-1', 'subagent'))) === 'recht_fehlt', 'P22-T287 E Subagent nie, auch nicht fuer sich selbst');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-andere', aktiv: false}, akteurId('id-sub', 'sub-1', 'subagent'))) === 'recht_fehlt', 'P22-T287 E Subagent nicht fuer andere');
  ok(await fehlerCode(() => setze({ebene: 'agent', ziel: 'luna-*', aktiv: false}, {art: 'legacy_koordinator', agent_id: 'luna-1'})) === 'recht_fehlt', 'P22-T287 E Nichtkoordinator als Koordinator-Akteur nie (Weg ohne Ausweis: E2)');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: false}, akteurId('id-fremdkoord', 'koordinator-fremd', 'koordinator', Q))) === 'recht_fehlt', 'P22-T287 E Koordinator eines anderen Projekts nicht');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: false}, akteurId('id-main', 'main', 'main'))) === 'recht_fehlt', 'P22-T287 E Main nur ueber Agenten-Verwaltung (main_verwaltung), sonst nicht');
  const HP = (await load('packages/core/dist/services/virtuelle-projekte.js')).HAUPTAGENT_PROJEKT;
  await ident('id-main-echt', 'hauptagent-t287', 'main', HP);
  const mainP = principal('id-main-echt', 'hauptagent-t287', 'main', HP);
  const mr = await core.mitAgentAufrufKontext({bezug: BEZUG, principal: mainP, main_verwaltung: P},
    () => setze({ebene: 'identitaet', ziel: 'id-andere', aktiv: true}, {art: 'identitaet', principal: mainP}));
  ok(mr.wer === 'id-main-echt' && mr.herkunft === 'ausweis', 'P22-T287 E Main mit main_verwaltung des Zielprojekts setzt (Entscheidung 9ff7ab0f P2)', mr);
  ok(await fehlerCode(() => core.mitAgentAufrufKontext({bezug: BEZUG, principal: mainP, main_verwaltung: Q},
    () => setze({ebene: 'identitaet', ziel: 'id-andere', aktiv: true}, {art: 'identitaet', principal: mainP}))) === 'recht_fehlt', 'P22-T287 E Main mit Verwaltung eines anderen Projekts nicht');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: false}, null)) === 'recht_fehlt', 'P22-T287 E ohne Akteur recht_fehlt');

  // E2 Weg ohne Ausweis (User-Korrektur 27f9c071) -------------------------------------------------------------------
  const OHNE = (agent) => ({art: 'ohne_ausweis', agent_id: agent});
  const G10 = 'P22-T287 ohne Ausweis Testlauf';
  const setzeOhne = (agent, e = {}) => setze({ebene: 'agent', ziel: 'luna-1', aktiv: true, grund: G10, ...e}, OHNE(agent));
  let fe = null;
  try { await setzeOhne('luna-1'); } catch (e) { fe = e; }
  ok(fe?.code === 'funktion_aus' && fe.details?.funktion === 'schalter_setzen_ohne_ausweis', 'P22-T287 E2 ohne Ausweis: eigener Schalter Standard AUS -> funktion_aus', fe?.details);
  await projektSchalter('schalter_setzen_ohne_ausweis', true);
  const oa = await setzeOhne('luna-1');
  ok(oa.wer === 'ohne_ausweis:luna-1' && oa.herkunft === 'ohne_ausweis' && oa.setter_agent_id === 'luna-1', 'P22-T287 E2 Legacy-Agent ohne Ausweis setzt (Schalter EIN)', oa);
  const zeileOA = (await pool.query("SELECT herkunft, setter_agent_id, setter_identity_id FROM agent_profil_schalter_ziel WHERE ebene='agent' AND ziel='luna-1'")).rows[0];
  ok(zeileOA?.herkunft === 'ohne_ausweis' && zeileOA.setter_agent_id === 'luna-1' && zeileOA.setter_identity_id === null, 'P22-T287 E2 Regel traegt Herkunft und agent_id', zeileOA);
  const vOA = (await pool.query("SELECT herkunft, setter_agent_id, gesetzt_von FROM agent_profil_schalter_ziel_verlauf WHERE ebene='agent' AND ziel='luna-1' ORDER BY id DESC LIMIT 1")).rows[0];
  ok(vOA?.herkunft === 'ohne_ausweis' && vOA.setter_agent_id === 'luna-1' && vOA.gesetzt_von === 'ohne_ausweis:luna-1', 'P22-T287 E2 Verlauf mit Herkunft und agent_id', vOA);
  ok(await fehlerCode(() => setzeOhne('luna-1', {grund: 'zu kurz!'})) === 'grund_fehlt', 'P22-T287 E2 Grund Pflicht (min. 10 Zeichen ohne Ausweis)');
  ok(await fehlerCode(() => setzeOhne('sub-1')) === 'ausweis_erforderlich', 'P22-T287 E2 Name einer Ausweis-Identitaet -> ausweis_erforderlich');
  ok(await fehlerCode(() => setzeOhne('')) === 'recht_fehlt', 'P22-T287 E2 ohne agent_id recht_fehlt');
  ok(await fehlerCode(() => imKontext(principal('id-sub', 'sub-1', 'subagent'), () => setzeOhne('luna-1'))) === 'recht_fehlt', 'P22-T287 E2 Aufruf mit Ausweis nutzt nie den Weg ohne Ausweis');
  ok(await fehlerCode(() => imKontext({art: 'legacy', project: Q, agent_id: 'luna-1'}, () => setzeOhne('luna-1'))) === 'recht_fehlt', 'P22-T287 E2 nur im eigenen Projekt der Anfrage');
  ok(await fehlerCode(() => imKontext({art: 'legacy', project: P, agent_id: 'luna-9'}, () => setzeOhne('luna-1'))) === 'recht_fehlt', 'P22-T287 E2 agent_id muss zum Legacy-Kontext passen');
  let rd = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, agent_id: 'luna-2', profil_funktion: F, ziel_ebene: 'agent', ziel: 'luna-2', aktiv: true, grund: G10}, {akteur: null});
  ok(rd.success && rd.aenderung?.herkunft === 'ohne_ausweis' && rd.aenderung?.wer === 'ohne_ausweis:luna-2', 'P22-T287 E2 admin-Dispatcher: ohne Akteur + agent_id = Weg ohne Ausweis', rd);
  rd = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, agent_id: 'luna-2', profil_funktion: F, aktiv: true, grund: G10}, {akteur: null});
  ok(rd.success === false && rd.error === 'recht_fehlt', 'P22-T287 E2 ohne Ausweis Projekt-/Globalebene weiterhin nicht', rd);
  rd = await A.fuehreW1bAdminAus('profil_schalter_status', {project: P, agent_id: 'luna-2'}, {akteur: null});
  ok(rd.success === false && rd.error === 'recht_fehlt', 'P22-T287 E2 andere admin-Aktionen ohne Ausweis weiterhin nicht', rd);
  rd = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, agent_id: 'sub-1', profil_funktion: F, ziel_ebene: 'agent', ziel: 'luna-2', aktiv: false, grund: G10}, {akteur: akteurId('id-sub', 'sub-1', 'subagent')});
  ok(rd.success === false && rd.error === 'recht_fehlt', 'P22-T287 E2 Agent MIT Ausweis (Subagent) weiterhin nicht', rd);
  rd = await A.fuehreW1bAdminAus('profil_schalter_status', {project: P, ziel_ebene: 'agent', ziel: 'luna-2'}, {akteur: USER});
  ok(rd.ziel_regeln?.[0]?.herkunft === 'ohne_ausweis' && rd.ziel_regeln[0].setter_agent_id === 'luna-2'
    && rd.schalter?.find(x => x.funktion === F)?.gesetzt_von === 'ohne_ausweis:luna-2', 'P22-T287 E2 Debug-Quelle im Status (Herkunft, agent_id, gesetzt_von)', rd.ziel_regeln);
  ok(await fehlerCode(() => setzeOhne('luna-1', {ebene: 'identitaet', ziel: 'id-andere'})) === 'nur_ebene_agent', 'P22-T287 E2 ohne Ausweis nur ebene agent: identitaet abgewiesen (Koordinator-Entscheidung)');
  ok(await fehlerCode(() => setzeOhne('luna-1', {ebene: 'typ', ziel: 't287-klein'})) === 'nur_ebene_agent', 'P22-T287 E2 ohne Ausweis nur ebene agent: typ abgewiesen');
  rd = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, agent_id: 'luna-2', profil_funktion: F, ziel_ebene: 'identitaet', ziel_identity_id: 'id-andere', aktiv: true, grund: G10}, {akteur: null});
  ok(rd.success === false && rd.error === 'nur_ebene_agent', 'P22-T287 E2 admin ohne Ausweis: identitaet abgewiesen', rd);
  await projektSchalter('schalter_setzen_ohne_ausweis', false);
  ok(await fehlerCode(() => setzeOhne('luna-1')) === 'funktion_aus', 'P22-T287 E2 Schalter wieder AUS -> abgewiesen');
  ok(S.NUR_AUSDRUECKLICH.includes('schalter_setzen_ohne_ausweis') && typeof SL.PROFIL_SCHALTER_ZWECK.schalter_setzen_ohne_ausweis === 'string',
    'P22-T287 E2 Katalog: schalter_setzen_ohne_ausweis nur ausdruecklich, mit Zweck');

  // F Validierung ----------------------------------------------------------------------------------------------
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: true, funktion: 'web_ui_arbeitsbereich'})) === 'funktion_nicht_je_ziel', 'P22-T287 F nicht ziel-faehig abgewiesen');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: true, funktion: 'alle'})) === 'alle_nicht_je_ziel', 'P22-T287 F alle je Agent abgewiesen');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'gibt-es-nicht', aktiv: true})) === 'identitaet_unbekannt', 'P22-T287 F unbekannte Identitaet');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-fremdkoord', aktiv: true})) === 'identitaet_unbekannt', 'P22-T287 F Identitaet eines anderen Projekts');
  ok(await fehlerCode(() => setze({ebene: 'typ', ziel: 't287-fremd', aktiv: true})) === 'typ_unbekannt', 'P22-T287 F Typ eines anderen Projekts');
  ok(await fehlerCode(() => setze({ebene: 'agent', ziel: '**', aktiv: true})) === 'ziel_ungueltig', 'P22-T287 F Muster nur * abgewiesen');
  ok(await fehlerCode(() => setze({ebene: 'agent', ziel: undefined, aktiv: true})) === 'ziel_fehlt', 'P22-T287 F ziel fehlt');
  ok(await fehlerCode(() => setze({ebene: 'projekt', ziel: 'x', aktiv: true})) === 'ziel_ebene_ungueltig', 'P22-T287 F unbekannte Zielebene');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: true, grund: 'kurz'})) === 'grund_fehlt', 'P22-T287 F Grund Pflicht (min. 5)');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: 'ja'})) === 'aktiv_fehlt', 'P22-T287 F aktiv boolean');

  // G Rang ------------------------------------------------------------------------------------------------------
  await pool.query('DELETE FROM agent_profil_schalter_ziel');
  await projektSchalter(F, false);
  const sub1 = {identity_id: 'id-sub', agent_id: 'sub-1'};
  st = await lies(sub1);
  ok(st.aktiv === false && st.ebene === 'projekt' && !st.ziel_ebene, 'P22-T287 G ohne Zielregel gilt projekt', st);
  await setze({ebene: 'typ', ziel: 't287-klein', aktiv: true});
  st = await lies(sub1);
  ok(st.aktiv === true && st.ziel_ebene === 'typ' && st.ziel === 't287-klein' && st.ebene === 'projekt', 'P22-T287 G typ > projekt (Debug ziel_ebene/ziel)', st);
  await setze({ebene: 'agent', ziel: 'sub-*', aktiv: false});
  await setze({ebene: 'agent', ziel: 'sub-1', aktiv: false});
  st = await lies(sub1);
  ok(st.aktiv === true && st.ziel_ebene === 'typ', 'P22-T287 G P4 (9ff7ab0f): Name/Muster gilt nicht fuer Ausweis-Identitaeten, Typ bleibt', st);
  st = await lies({agent_id: 'sub-9'});
  ok(st.aktiv === false && st.ziel_ebene === 'agent' && st.ziel_muster === true, 'P22-T287 G Legacy ohne Ausweis: agent Muster > projekt', st);
  await setze({ebene: 'agent', ziel: 'sub-9', aktiv: true});
  st = await lies({agent_id: 'sub-9'});
  ok(st.aktiv === true && st.ziel === 'sub-9' && !st.ziel_muster, 'P22-T287 G Legacy: agent exakt > Muster', st);
  await setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: false});
  st = await lies(sub1);
  ok(st.aktiv === false && st.ziel_ebene === 'identitaet' && st.gesetzt_von === 'user' && st.grund === 'P22-T287 Testlauf', 'P22-T287 G identitaet > typ', st);
  st = await lies({identity_id: 'id-sub2', agent_id: 'sub-2'});
  ok(st.aktiv === true && st.ziel_ebene === 'typ', 'P22-T287 G andere Identitaet: eigener Typ statt fremder Identitaetsregel', st);
  st = await lies({identity_id: 'id-andere', agent_id: 'andere-1'});
  ok(st.aktiv === false && st.ebene === 'projekt' && !st.ziel_ebene, 'P22-T287 G unbeteiligte Identitaet: projekt', st);
  st = await lies(null);
  ok(!st.ziel_ebene && st.ebene === 'projekt', 'P22-T287 G ziel null = Projektsicht', st);
  st = await lies(sub1, 'web_ui_arbeitsbereich');
  ok(!st.ziel_ebene, 'P22-T287 G nicht ziel-faehige Funktion ohne Zielstufe', st);

  // H Aufrufkontext ---------------------------------------------------------------------------------------------
  st = await imKontext(principal('id-sub', 'sub-1', 'subagent'), async () => S.leseProfilProduktSchalter(F, P, await Z.zielDesAufrufers(P)));
  ok(st.ziel_ebene === 'identitaet' && st.aktiv === false, 'P22-T287 H Ausweis aus dem Aufrufkontext', st);
  await setze({ebene: 'agent', ziel: 'luna-*', aktiv: true});
  st = await imKontext({art: 'legacy', project: P, agent_id: 'luna-7'}, async () => S.leseProfilProduktSchalter(F, P, await Z.zielDesAufrufers(P)));
  ok(st.ziel === 'luna-*' && st.aktiv === true, 'P22-T287 H Legacy ohne Ausweis ueber Namensmuster', st);
  st = await imKontext({art: 'legacy', project: Q, agent_id: 'luna-7'}, async () => S.leseProfilProduktSchalter(F, P, await Z.zielDesAufrufers(P)));
  ok(!st.ziel_ebene, 'P22-T287 H Aufruf aus anderem Projekt: keine Zielregel', st);
  st = await S.leseProfilProduktSchalter(F, P);
  ok(!st.ziel_ebene, 'P22-T287 H ohne Kontext keine Zielregel', st);
  st = await imKontext(principal('id-sub', 'sub-1', 'subagent'), () => S.leseProfilProduktSchalter(F, P));
  ok(!st.ziel_ebene, 'P22-T287 H S3: ohne ausdrueckliches Ziel keine Zielregel, auch im Aufrufkontext (Fremd-Empfaenger-Regel)', st);

  // I Puffer ------------------------------------------------------------------------------------------------------
  process.env.SYNAPSE_W1B_GATE_TTL_MS = '60000';
  S.leereAusweisKernCache();
  const a1 = await imKontext(principal('id-sub', 'sub-1', 'subagent'), async () => S.leseProfilProduktSchalterGepuffert(F, P, await Z.zielDesAufrufers(P)));
  const a2 = await imKontext({art: 'legacy', project: P, agent_id: 'luna-7'}, async () => S.leseProfilProduktSchalterGepuffert(F, P, await Z.zielDesAufrufers(P)));
  ok(a1.aktiv === false && a2.aktiv === true, 'P22-T287 I Puffer trennt Agenten (Ziel im Schluessel)', {a1, a2});
  await setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: true});
  const a3 = await imKontext(principal('id-sub', 'sub-1', 'subagent'), async () => S.leseProfilProduktSchalterGepuffert(F, P, await Z.zielDesAufrufers(P)));
  ok(a3.aktiv === true, 'P22-T287 I Schreiben leert den Puffer im eigenen Prozess sofort', a3);
  process.env.SYNAPSE_W1B_GATE_TTL_MS = '0';
  S.leereAusweisKernCache();

  // J Entfernen, Verlauf, Audit -----------------------------------------------------------------------------------
  const ent = await setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: null});
  ok(ent.geaendert && ent.alt === true && ent.neu === null, 'P22-T287 J Entfernen meldet alt/neu', ent);
  st = await lies(sub1);
  ok(st.ziel_ebene === 'typ' && st.ziel === 't287-klein', 'P22-T287 J nach Entfernen erbt die Identitaet (Typ)', st);
  ok((await setze({ebene: 'identitaet', ziel: 'id-sub', aktiv: null})).geaendert === false, 'P22-T287 J Entfernen ohne Regel = keine Aenderung');
  const verlauf = (await pool.query("SELECT alt, neu, gesetzt_von FROM agent_profil_schalter_ziel_verlauf WHERE ebene='identitaet' AND ziel='id-sub' ORDER BY id")).rows;
  ok(verlauf.length >= 5 && verlauf.at(-1).neu === null && verlauf.at(-1).alt === true, 'P22-T287 J Verlauf je Aenderung (auch Entfernen)', verlauf);
  const audit = (await pool.query("SELECT aktion, neu, actor_identity_id FROM agent_identitaet_audit WHERE identity_id='id-sub' ORDER BY id")).rows;
  ok(audit.some(r => r.aktion === 'schalter_gesetzt' && r.neu?.funktion === F) && audit.at(-1).aktion === 'schalter_entfernt', 'P22-T287 J agent_identitaet_audit (Ausweis-Verlauf)', audit);
  ok(audit.some(r => r.actor_identity_id === 'id-koord'), 'P22-T287 J Audit nennt den setzenden Koordinator', audit);

  // K admin-Dispatcher --------------------------------------------------------------------------------------------
  let r = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, profil_funktion: F, ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub2', aktiv: true, grund: 'P22-T287 admin'}, {akteur: USER});
  ok(r.success && r.aenderung?.neu === true && r.wirksam?.ziel_ebene === 'identitaet' && r.wirksam?.aktiv === true && Array.isArray(r.ziel_regeln),
    'P22-T287 K admin setzen ziel_ebene identitaet (aenderung, wirksam, ziel_regeln)', r);
  r = await SL.fuehreAdminSchlankAus('profil_schalter_setzen', {project: P, profil_funktion: F, ziel_ebene: 'typ', typ_id: 't287-klein', modus: 'entfernen', grund: 'P22-T287 admin'},
    () => A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, profil_funktion: F, ziel_ebene: 'typ', typ_id: 't287-klein', modus: 'entfernen', grund: 'P22-T287 admin'}, {akteur: USER}));
  ok(r.success && r.aenderung?.neu === null && r.aenderung?.alt === true, 'P22-T287 K admin (schlank) modus entfernen auf ebene typ', r);
  r = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, profil_funktion: F, ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', aktiv: true, grund: 'P22-T287 admin', agent_id: 'sub-1'}, {akteur: akteurId('id-sub', 'sub-1', 'subagent')});
  ok(r.success === false && r.error === 'recht_fehlt', 'P22-T287 K admin: Subagent abgewiesen', r);
  r = await A.fuehreW1bAdminAus('profil_schalter_status', {project: P, ziel_identity_id: 'id-sub2'}, {akteur: USER});
  const eintrag = r.schalter?.find(x => x.funktion === F);
  ok(r.success && eintrag?.ziel_ebene === 'identitaet' && eintrag?.aktiv === true && r.ziel_ansicht?.wirksam_fuer === 'id-sub2', 'P22-T287 K status mit ziel_identity_id = Sicht dieser Identitaet', {eintrag, ansicht: r.ziel_ansicht});
  r = await A.fuehreW1bAdminAus('profil_schalter_status', {project: P}, {akteur: USER});
  const proj = r.schalter?.find(x => x.funktion === F);
  ok(r.success && !proj?.ziel_ebene && proj?.aktiv === false && r.ziel_regeln === undefined, 'P22-T287 K status ohne Ziel = Projektsicht wie bisher', proj);
  r = await imKontext(principal('id-sub2', 'sub-2', 'subagent'), () => A.fuehreW1bAdminAus('profil_schalter_status', {project: P}, {akteur: USER}));
  ok(!r.schalter?.find(x => x.funktion === F)?.ziel_ebene, 'P22-T287 K status ohne Ziel zeigt nie den Stand des aufrufenden Agenten');
  r = await A.fuehreW1bAdminAus('profil_schalter_status', {project: P, ziel_ebene: 'agent'}, {akteur: USER});
  ok(r.success && r.ziel_regeln?.every(x => x.ebene === 'agent') && r.ziel_regeln.length >= 2, 'P22-T287 K status ziel_ebene agent listet Agent-Regeln', r.ziel_regeln);

  // L Mechanik wieder AUS -----------------------------------------------------------------------------------------
  await projektSchalter('schalter_identitaet', false);
  st = await lies({identity_id: 'id-sub2', agent_id: 'sub-2'});
  const n = (await pool.query('SELECT count(*)::int AS n FROM agent_profil_schalter_ziel')).rows[0].n;
  ok(!st.ziel_ebene && st.aktiv === false && n > 0, 'P22-T287 L AUS: Regeln bleiben gespeichert, wirken nicht', {st, n});
  await projektSchalter('schalter_identitaet', true);

  // N P6 (Pruefer 9ff7ab0f): Regeln eines entfernten Agenten aufraeumen ---------------------------------------------
  await setze({ebene: 'identitaet', ziel: 'id-andere', aktiv: true});
  await setze({ebene: 'agent', ziel: 'alt-legacy', aktiv: true});
  const nI = await Z.raeumeZielRegelnAuf(pool, {project: P, ebene: 'identitaet', ziel: 'id-andere', wer: 'test', actor_identity_id: null, grund: 'P22-T287 Entfernen'});
  const nA = await Z.raeumeZielRegelnAuf(pool, {project: P, ebene: 'agent', ziel: 'alt-legacy', wer: 'test', actor_identity_id: null, grund: 'P22-T287 Entfernen'});
  const restN = (await pool.query("SELECT count(*)::int AS n FROM agent_profil_schalter_ziel WHERE ziel IN ('id-andere','alt-legacy')")).rows[0].n;
  const musterN = (await pool.query("SELECT count(*)::int AS n FROM agent_profil_schalter_ziel WHERE ziel='luna-*'")).rows[0].n;
  ok(nI === 1 && nA === 1 && restN === 0 && musterN === 1, 'P22-T287 N P6 raeumeZielRegelnAuf: eigene Regeln weg, Muster bleiben', {nI, nA, restN, musterN});
  const vN = (await pool.query("SELECT herkunft, neu, alt FROM agent_profil_schalter_ziel_verlauf WHERE ziel='id-andere' ORDER BY id DESC LIMIT 1")).rows[0];
  ok(vN?.herkunft === 'aufraeumen' && vN.neu === null && vN.alt === true, 'P22-T287 N P6 Verlaufszeile herkunft aufraeumen', vN);

  // O S2 kontextprofil-Bruecke ----------------------------------------------------------------------------------------
  const HB = await load('packages/core/dist/services/ausloeser-hinweise.js');
  const kp = (action, extra, agent = 'koordinator') => HB.fuehreHinweisprofilAdminAus(action,
    {project: P, ziel: 'identity:id-andere', grund: 'P22-T287 Bruecke Test', agent_id: agent, ...extra}, agent);
  let kb = await kp('kontextprofil_setzen', {stufe: 'kompakt'});
  ok(kb === null, 'P22-T287 O Bruecke AUS: Altweg (null -> coming_soon im Dispatcher)', kb);
  await projektSchalter('kontextprofil_bruecke', true);
  await projektSchalter('profilverwaltung', true);
  kb = await kp('kontextprofil_setzen', {stufe: 'kompakt', kontext_budget: 25000, hinweise_aus: ['shell_activity']});
  let prof = (await pool.query("SELECT profil, profil_revision FROM agent_identitaeten WHERE id='id-andere'")).rows[0];
  ok(kb?.success && kb.weg === 'kontextprofil_bruecke' && prof.profil.kontext_stufe === 'kompakt' && prof.profil.kontext_budget === 25000
    && prof.profil.hinweise?.shell_activity === false && prof.profil_revision === kb.profil_revision,
    'P22-T287 O Bruecke EIN: stufe/kontext_budget/hinweise_aus ins Profil (profil_aendern-Weg, Revision)', {kb, prof});
  const revN = (await pool.query("SELECT count(*)::int AS n FROM agent_profil_revisionen WHERE identity_id='id-andere'")).rows[0].n;
  ok(revN >= 1, 'P22-T287 O Profilrevision geschrieben', revN);
  kb = await kp('kontextprofil_setzen', {hinweise_nur: ['pending_events']});
  prof = (await pool.query("SELECT profil FROM agent_identitaeten WHERE id='id-andere'")).rows[0].profil;
  ok(kb?.success && prof.hinweise.pending_events === true && prof.hinweise.shell_activity === false && prof.hinweise.unread_channels === false
    && prof.kontext_stufe === 'kompakt', 'P22-T287 O hinweise_nur: nur genannte optionale Arten an, Stufe bleibt', {kb, prof});
  kb = await kp('kontextprofil_liste', {});
  ok(kb?.success && kb.kontextprofil?.kontext_stufe === 'kompakt' && kb.herkunft?.kontext_stufe === 'profil', 'P22-T287 O liste: wirksame Werte mit Herkunft', kb);
  kb = await kp('kontextprofil_setzen', {hinweise_aus: ['werkzeug_regeln']});
  ok(kb?.success === false && kb.error === 'hinweis_pflicht_nicht_abschaltbar', 'P22-T287 O Pflichthinweis nicht abschaltbar', kb);
  kb = await imKontext(principal('id-sub', 'sub-1', 'subagent'), () => kp('kontextprofil_setzen', {stufe: 'minimal'}, 'sub-1'));
  ok(kb?.success === false && /recht/.test(String(kb.error)), 'P22-T287 O Subagent mit Ausweis nicht', kb);
  kb = await kp('kontextprofil_setzen', {stufe: 'minimal'}, 'luna-1');
  ok(kb?.success === false && kb.error === 'recht_fehlt', 'P22-T287 O Legacy-Nichtkoordinator nicht', kb);
  kb = await HB.fuehreHinweisprofilAdminAus('kontextprofil_setzen', {project: P, ziel: 'identity:gibt-es-nicht', stufe: 'kompakt', grund: 'P22-T287 Bruecke Test', agent_id: 'koordinator'}, 'koordinator');
  ok(kb?.error === 'identitaet_unbekannt', 'P22-T287 O unbekannte Identitaet', kb);
  kb = await HB.fuehreHinweisprofilAdminAus('kontextprofil_setzen', {project: P, ziel: 'luna-*', stufe: 'kompakt', grund: 'P22-T287 Bruecke Test', agent_id: 'koordinator'}, 'koordinator');
  ok(kb === null, 'P22-T287 O Namensziel bleibt beim Altweg', kb);
  kb = await kp('kontextprofil_entfernen', {});
  prof = (await pool.query("SELECT profil FROM agent_identitaeten WHERE id='id-andere'")).rows[0].profil;
  ok(kb?.success && prof.kontext_stufe === 'normal' && prof.kontext_budget === null && Object.keys(prof.hinweise ?? {}).length === 0,
    'P22-T287 O entfernen: Standardverhalten', {kb, prof});
  kb = await kp('kontextprofil_setzen', {stufe: 'kompakt', grund: ''});
  ok(kb?.success === false && kb.error === 'grund_fehlt', 'P22-T287 O H3 (70f43eaf): leerer Grund abgewiesen wie bei profil_aendern', kb);
  await projektSchalter('kontextprofil_bruecke', false);

  // P S2 profil_antwortanpassung ------------------------------------------------------------------------------------
  const IS = await load('packages/core/dist/services/intern-schalter.js');
  const AW = (z, project = P) => S.leseAntwortanpassungSchalter(project, z);
  delete process.env.SYNAPSE_W1B_ANTWORTANPASSUNG;
  ok(S.PROFIL_PRODUKT_FUNKTIONEN.includes('profil_antwortanpassung') && S.NUR_AUSDRUECKLICH.includes('profil_antwortanpassung') && Z.istZielFaehig('profil_antwortanpassung')
    && S.PROFIL_PRODUKT_FUNKTIONEN.includes('kontextprofil_bruecke') && S.NUR_AUSDRUECKLICH.includes('kontextprofil_bruecke')
    && typeof SL.PROFIL_SCHALTER_ZWECK.profil_antwortanpassung === 'string' && typeof SL.PROFIL_SCHALTER_ZWECK.kontextprofil_bruecke === 'string',
    'P22-T287 P Katalog: beide S2-Schalter nur ausdruecklich mit Zweck, profil_antwortanpassung je Agent');
  let aw = await AW({identity_id: 'id-andere'});
  ok(aw.freigegeben === false && aw.quelle === 'standard' && aw.produkt?.quelle === 'standard', 'P22-T287 P Standard AUS (ohne Zeile, ohne Env)', aw);
  await projektSchalter('profil_antwortanpassung', true);
  aw = await AW({identity_id: 'id-andere'});
  ok(aw.freigegeben === true && aw.quelle === 'produkt-schalter' && aw.produkt?.ebene === 'projekt', 'P22-T287 P Produkt-Schalter projekt EIN', aw);
  await setze({ebene: 'identitaet', ziel: 'id-sub2', aktiv: false, funktion: 'profil_antwortanpassung'});
  aw = await AW({identity_id: 'id-sub2'});
  ok(aw.freigegeben === false && aw.produkt?.ziel_ebene === 'identitaet', 'P22-T287 P je Identitaet AUS ueber projekt EIN', aw);
  aw = await AW({identity_id: 'id-andere'});
  ok(aw.freigegeben === true, 'P22-T287 P andere Identitaet bleibt beim Projektwert', aw);
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='profil_antwortanpassung'");
  await pool.query("DELETE FROM agent_profil_schalter_ziel WHERE funktion='profil_antwortanpassung'");
  process.env.SYNAPSE_W1B_ANTWORTANPASSUNG = '1';
  aw = await AW({identity_id: 'id-andere'});
  ok(aw.freigegeben === true && aw.quelle === 'standard', 'P22-T287 P ohne Produktzeile gilt der Env-Standard wie bisher', aw);
  await projektSchalter('profil_antwortanpassung', false);
  aw = await AW({identity_id: 'id-andere'});
  ok(aw.freigegeben === false && aw.quelle === 'produkt-schalter', 'P22-T287 P ausdrueckliches Produkt-AUS schlaegt Env-EIN', aw);
  aw = await AW({identity_id: 'id-andere'}, null);
  ok(aw.freigegeben === true && aw.quelle === 'standard', 'P22-T287 P ohne Projekt wie bisher nur Env/intern', aw);
  await IS.setzeSchalter('w1b_antwortanpassung', {aktiv: true, dauer_min: 5, grund: 'p22-t287 test', agent: 'test'});
  aw = await AW({identity_id: 'id-andere'});
  ok(aw.freigegeben === true && aw.quelle === 'intern', 'P22-T287 P intern-Override hat Vorrang vor Produkt-AUS', aw);
  await pool.query("DELETE FROM intern_schalter WHERE name='w1b_antwortanpassung'");
  delete process.env.SYNAPSE_W1B_ANTWORTANPASSUNG;

  // Q S3: verdrahtete Lesestellen, Fremd-Empfaenger-Regel, Debug-Quelle, Messung (P5) -----------------------------------
  ok(!Z.istZielFaehig('mod_inbox') && Z.istZielFaehig('startkontext') && !Z.istZielFaehig('coedit_ohne_gate') && Z.istZielFaehig('task_pins')
    && Z.istZielFaehig('zwangs_pin') && Z.istZielFaehig('profil_antwortanpassung'), 'P22-T287 Q Positivliste = nur verdrahtete Lesestellen (S3; S4b: startkontext mit Ziel der gestarteten Identitaet)');
  ok(await fehlerCode(() => setze({ebene: 'identitaet', ziel: 'id-sub2', aktiv: true, funktion: 'mod_inbox'})) === 'funktion_nicht_je_ziel', 'P22-T287 Q nicht verdrahtete Funktion je Agent abgewiesen');
  const TAS = await load('packages/core/dist/services/tool-antworten-schlank.js');
  await setze({ebene: 'identitaet', ziel: 'id-sub2', aktiv: true});
  const qa = await imKontext(principal('id-sub2', 'sub-2', 'subagent'), async () => ({an: await TAS.toolAntwortenSchlank(P), quelle: await Z.schalterQuelleDesAufrufs()}));
  const qb = await imKontext(principal('id-andere', 'andere-1', 'subagent'), async () => ({an: await TAS.toolAntwortenSchlank(P), quelle: await Z.schalterQuelleDesAufrufs()}));
  ok(qa.an === true && qb.an === false, 'P22-T287 Q toolAntwortenSchlank entscheidet je Aufrufer (fall-skills.ts, Puffer je Ziel)', {qa, qb});
  ok(qa.quelle.length === 1 && qa.quelle[0].funktion === F && qa.quelle[0].ziel_ebene === 'identitaet' && qb.quelle.length === 0,
    'P22-T287 Q schalter_quelle nur bei Treffer einer Zielregel', {qa, qb});
  process.env.SYNAPSE_W1B_GATE_TTL_MS = '60000';
  S.leereAusweisKernCache();
  Z.leereSchalterZielDiagnose();
  const pz0 = S.produktPufferDiagnose();
  let tq = Date.now();
  for (let i = 0; i < 200; i++) await S.leseProfilProduktSchalterGepuffert(F, P, {identity_id: 'id-sub2'});
  const msEin = Date.now() - tq;
  const pz1 = S.produktPufferDiagnose();
  const zd = Z.schalterZielDiagnose();
  console.log('MESSUNG P5 mit Ziel ' + JSON.stringify({lesungen: 200, puffer_treffer: pz1.treffer - pz0.treffer, puffer_fehlgriffe: pz1.fehlgriffe - pz0.fehlgriffe, zielabfragen: zd.abfragen, ziel_ms: zd.ms, gesamt_ms: msEin}));
  ok(zd.abfragen <= 2 && pz1.treffer - pz0.treffer >= 198, 'P22-T287 Q P5: 200 gepufferte Lesungen bei EIN, hoechstens 2 Zielabfragen', {zd, pz0, pz1});
  Z.leereSchalterZielDiagnose();
  tq = Date.now();
  for (let i = 0; i < 200; i++) await S.leseProfilProduktSchalter(F, P, {identity_id: 'id-sub2'});
  const zu = Z.schalterZielDiagnose();
  console.log('MESSUNG P5 ungepuffert mit Ziel ' + JSON.stringify({lesungen: 200, zielabfragen: zu.abfragen, ziel_ms: zu.ms, gesamt_ms: Date.now() - tq}));
  Z.leereSchalterZielDiagnose();
  tq = Date.now();
  for (let i = 0; i < 200; i++) await S.leseProfilProduktSchalter(F, P);
  console.log('MESSUNG P5 ungepuffert ohne Ziel ' + JSON.stringify({lesungen: 200, zielabfragen: Z.schalterZielDiagnose().abfragen, gesamt_ms: Date.now() - tq}));
  ok(Z.schalterZielDiagnose().abfragen === 0 && zu.abfragen === 200, 'P22-T287 Q P5: ohne Ziel keine Zielabfrage, ungepuffert eine je Lesung', {zu});

  // Q2 S3b (Pruefer 2b71d432): N2 Debug-Quelle beim Puffertreffer, N3 Messung, H4 Puffer bei AUS, N1 Pflicht-Tag-Schutz ----------
  S.leereAusweisKernCache();
  const FSK = await load('packages/core/dist/services/fall-skills.js');
  FSK.leereFallSkillSchalterPuffer();
  const q2a = await imKontext(principal('id-sub2', 'sub-2', 'subagent'), async () => { await TAS.toolAntwortenSchlank(P); return Z.schalterQuelleDesAufrufs(); });
  const q2b = await imKontext(principal('id-sub2', 'sub-2', 'subagent'), async () => { await TAS.toolAntwortenSchlank(P); return Z.schalterQuelleDesAufrufs(); });
  ok(q2a.length === 1 && q2b.length === 1 && q2b[0].ziel_ebene === 'identitaet', 'P22-T287 Q2 N2: schalter_quelle auch beim Puffertreffer (fall-skills, zweiter Aufruf)', {q2a, q2b});
  await S.leseProfilProduktSchalterGepuffert(F, P, {identity_id: 'id-sub2'});
  const q2c = await imKontext(principal('id-sub2', 'sub-2', 'subagent'), async () => {
    const vor = S.produktPufferDiagnose().treffer;
    await S.leseProfilProduktSchalterGepuffert(F, P, {identity_id: 'id-sub2'});
    return {treffer: S.produktPufferDiagnose().treffer - vor, quelle: await Z.schalterQuelleDesAufrufs()};
  });
  ok(q2c.treffer >= 1 && q2c.quelle.length === 1, 'P22-T287 Q2 N2: schalter_quelle auch beim Treffer aus dem Kern-Puffer', q2c);
  S.leereAusweisKernCache();
  Z.leereSchalterZielDiagnose();
  let tm = Date.now();
  for (let i = 0; i < 200; i++) await S.leseProfilProduktSchalter(F, P, {identity_id: 'id-andere'});
  const ohneRegelUng = {ms: Date.now() - tm, ziel: Z.schalterZielDiagnose()};
  Z.leereSchalterZielDiagnose();
  const pzA = S.produktPufferDiagnose();
  tm = Date.now();
  for (let i = 0; i < 200; i++) await S.leseProfilProduktSchalterGepuffert(F, P, {identity_id: 'id-andere'});
  const pzB = S.produktPufferDiagnose();
  const ohneRegelGep = {ms: Date.now() - tm, puffer_treffer: pzB.treffer - pzA.treffer, puffer_fehlgriffe: pzB.fehlgriffe - pzA.fehlgriffe, ziel: Z.schalterZielDiagnose()};
  const agentenIds = ['id-sub', 'id-sub2', 'id-andere', 'id-koord', 'id-main'];
  S.leereAusweisKernCache();
  Z.leereSchalterZielDiagnose();
  const pzC = S.produktPufferDiagnose();
  tm = Date.now();
  for (let i = 0; i < 40; i++) for (const id of agentenIds) await S.leseProfilProduktSchalterGepuffert(F, P, {identity_id: id});
  const pzD = S.produktPufferDiagnose();
  const nAgenten = {agenten: 5, lesungen: 200, ms: Date.now() - tm, puffer_treffer: pzD.treffer - pzC.treffer, puffer_fehlgriffe: pzD.fehlgriffe - pzC.fehlgriffe, ziel: Z.schalterZielDiagnose()};
  console.log('MESSUNG P5 EIN ohne Regel ungepuffert ' + JSON.stringify(ohneRegelUng));
  console.log('MESSUNG P5 EIN ohne Regel gepuffert ' + JSON.stringify(ohneRegelGep));
  console.log('MESSUNG P5 5 Agenten gepuffert ' + JSON.stringify(nAgenten));
  ok(ohneRegelUng.ziel.abfragen === 200 && ohneRegelUng.ziel.treffer === 0 && ohneRegelGep.ziel.abfragen === 1 && nAgenten.ziel.abfragen === 5,
    'P22-T287 Q2 N3: EIN ohne Regel ungepuffert eine Zielabfrage je Lesung, gepuffert eine je Agent', {ohneRegelUng, ohneRegelGep, nAgenten});
  await projektSchalter('schalter_identitaet', false);
  S.leereAusweisKernCache();
  await S.leseProfilProduktSchalterGepuffert('schalter_identitaet', P, null);
  await S.leseProfilProduktSchalterGepuffert(F, P);
  const h4a = S.produktPufferDiagnose();
  await S.leseProfilProduktSchalterGepuffert(F, P, {identity_id: 'id-sub2'});
  const h4b = S.produktPufferDiagnose();
  ok(h4b.fehlgriffe - h4a.fehlgriffe === 0 && h4b.treffer - h4a.treffer >= 1, 'P22-T287 Q2 H4: bei schalter_identitaet AUS Puffer je Projekt (Ziel nicht im Schluessel)', {h4a, h4b});
  await projektSchalter('schalter_identitaet', true);
  S.leereAusweisKernCache();
  const ZP = await load('packages/core/dist/services/zwangs-pin.js');
  await projektSchalter('zwangs_pin', false);
  await pool.query("INSERT INTO memories (id, project, name, content, category, tags) VALUES ($1,$2,'pin-t287','Pflicht-Memory','rules',$3)", [randomUUID(), P, ['pflicht:src/']]);
  const schutzArgs = {tool: 'memory', action: 'update', args: {project: P, name: 'pin-t287', tags: []}, project: P, legacyAgent: 'luna-1'};
  ok(await S.zielRegelIrgendwoAktiv('zwangs_pin', P) === false && (await ZP.pruefePflichtTagSchutz(schutzArgs)) === null,
    'P22-T287 Q2 N1: ohne Projekt- und Zielregel kein Pflicht-Tag-Schutz (Bestand)');
  await setze({ebene: 'identitaet', ziel: 'id-sub2', aktiv: true, funktion: 'zwangs_pin'});
  const schutz = await ZP.pruefePflichtTagSchutz(schutzArgs);
  ok(await S.zielRegelIrgendwoAktiv('zwangs_pin', P) === true && schutz !== null && JSON.stringify(schutz).includes('pflicht'),
    'P22-T287 Q2 N1: zwangs_pin nur je Agent EIN -> Pflicht-Tag-Schutz trotzdem aktiv', schutz);
  process.env.SYNAPSE_W1B_GATE_TTL_MS = '0';
  S.leereAusweisKernCache();

  // M Lesefehler --------------------------------------------------------------------------------------------------
  // Spalte umbenennen statt DROP: seit Deploy t239 gibt es public.agent_profil_schalter_ziel in synapse_test, ein DROP im Testschema
  // liesse die Abfrage still auf public zurueckfallen (search_path). So bleibt die Testtabelle vorn und die Abfrage scheitert.
  await pool.query('ALTER TABLE agent_profil_schalter_ziel RENAME COLUMN ziel TO ziel_weg');
  st = await lies({identity_id: 'id-sub2', agent_id: 'sub-2'});
  ok(st.ziel_fehler === 'schalter_ziel_nicht_lesbar' && st.ebene === 'projekt' && st.aktiv === false && !st.letzter_fehler, 'P22-T287 M Lesefehler: projekt wie bisher + ziel_fehler', st);

  console.log(`\nP22-T287 S1: ${pass} Pruefungen bestanden`);
} finally {
  if (pool) {
    await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE').catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}
