/**
 * P22-T311 (User-Grundsatz 08.11.2026, memory grundsatz-schalter-standard-ein-aktive-projekte; Konzept thought 11348d84).
 * Prueft packages/core/src/services/agent-profil-schalter.ts:
 *   A Katalog schalterKatalogEintrag: Ausnahmen (Memory), nicht abgenommen, reverse_*, Mechanik selbst nur ausdruecklich
 *   B Mechanik schalter_standard_aktive_projekte AUS = Bestand (Standard AUS, wert_quelle standard)
 *   C Mechanik EIN + aktives Projekt (projects.enabled): freigegebener Schalter EIN, wert_quelle standard_aktives_projekt;
 *     Ausnahme und nicht abgenommener Schalter bleiben AUS
 *   D inaktives bzw. unbekanntes Projekt: AUS; ohne Projekt (global gelesen): AUS
 *   E ausdruecklich gesetzt gewinnt (projekt AUS, global AUS), wert_quelle projekt/global
 *   F Notfall-Recht ohne Ausweis: nur mit schalter_setzen_ohne_ausweis + Mechanik, Grund >= 10, nicht 'alle',
 *     nicht unter Ausweis-Namen, fremdes Projekt braucht dessen Schalter, global ueber das Aufrufprojekt
 *   G Schalter-Verlauf (agent_profil_schalter_ziel_verlauf, ziel '-'): herkunft, alt/neu, gesetzt_von
 * Aufruf (Repo-Root, nach Build von core):
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/schalter-standard-p22-t311.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pruefeTestDbUrl} from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('P22-T311');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/synapse_test', 'P22-T311: nur gegen synapse_test');
const schema = 'p22t311_' + randomUUID().replaceAll('-', '');
const P = 'p22-t311-' + randomUUID().slice(0, 8);
const Q = P + '-fremd';
const AUS = P + '-aus';
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const repo = new URL('../../../', import.meta.url);
const load = p => import(new URL(p, repo).href);
Object.assign(process.env, {DATABASE_URL: url.toString(), SYNAPSE_DATABASE_URL: url.toString(), SYNAPSE_SCHEMA: 'aus', SYNAPSE_W1B_GATE_TTL_MS: '0',
  QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9'});

let pass = 0;
// Herkunft je Pruefung (regel-tests-mit-herkunft-kommentieren): Label = Task + Teil; bei Fehlschlag Debugzeile.
const ok = (cond, label, detail) => {
  if (!cond) console.error('DEBUG ' + label + ' | tatsaechlich: ' + JSON.stringify(detail ?? null).slice(0, 1500));
  assert.ok(cond, label);
  pass++; console.log('PASS ' + label);
};
const fehlerCode = async (fn) => { try { await fn(); return null; } catch (e) { return e?.code ?? String(e?.message ?? e); } };

let pool;
try {
  pool = (await load('packages/core/dist/db/client.js')).getPool();
  await pool.query('CREATE SCHEMA "' + schema + '"');
  for (const t of ['agent_profil_schalter', 'agent_identitaeten', 'agent_profil_schalter_ziel', 'agent_profil_schalter_ziel_verlauf', 'projects', 'intern_schalter', 'agent_namens_aliase']) {
    const ex = await pool.query("SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1", [t]);
    if (ex.rows.length) await pool.query('CREATE TABLE "' + schema + '"."' + t + '" (LIKE public."' + t + '" INCLUDING ALL)');
  }
  const S = await load('packages/core/dist/services/agent-profil-schalter.js');
  const F = 'tool_antworten_schlank';
  const USER = {system: 'user'};
  const setze = (e, akteur = USER) => S.setzeProfilProduktSchalter({grund: 'P22-T311 Testlauf', ...e}, akteur);
  const lies = (funktion = F, project = P) => S.leseProfilProduktSchalter(funktion, project);
  const projekt = (name, enabled) => pool.query(
    "INSERT INTO projects (name, hostname, path, created_at, last_access, enabled) VALUES ($1,'t311-host','/tmp/'||$1,NOW(),NOW(),$2)", [name, enabled]);
  await projekt(P, true);
  await projekt(Q, true);
  await projekt(AUS, false);
  S.leereProjektAktivPuffer();

  // A Katalog (SOLL 2)
  const k = S.schalterKatalogEintrag;
  ok(k(F).freigegeben && k(F).standard_aktive_projekte && k(F).ausnahme_grund === null, 'P22-T311 A freigegebener Schalter: Standard aktive Projekte', k(F));
  ok(!k('coedit_ohne_gate').standard_aktive_projekte && k('coedit_ohne_gate').ausnahme_grund === 'Sicherung weg', 'P22-T311 A Ausnahme coedit_ohne_gate (Memory) bleibt AUS', k('coedit_ohne_gate'));
  ok(!k('tool_ausgabe_seiten').freigegeben && !k('tool_ausgabe_seiten').standard_aktive_projekte, 'P22-T311 A nicht abgenommen (tool_ausgabe_seiten) bleibt AUS', k('tool_ausgabe_seiten'));
  ok(!k('reverse_leser').standard_aktive_projekte, 'P22-T311 A reverse_* bleibt wie er ist', k('reverse_leser'));
  ok(!k(S.SCHALTER_STANDARD_FUNKTION).standard_aktive_projekte && S.NUR_AUSDRUECKLICH.includes(S.SCHALTER_STANDARD_FUNKTION)
    && S.PROFIL_PRODUKT_FUNKTIONEN.includes(S.SCHALTER_STANDARD_FUNKTION), 'P22-T311 A Mechanik-Schalter im Katalog, nur ausdruecklich, nie automatisch');
  // Gegenpruefung claude-eiche: Mechanik ist eigene Ausnahme (unabhaengig von NICHT_FREIGEGEBEN, Schutz gegen Endlosrekursion).
  ok(k(S.SCHALTER_STANDARD_FUNKTION).ausnahme_grund === 'Mechanik selbst, nur ausdruecklich', 'P22-T311 A Mechanik als Ausnahme gefuehrt', k(S.SCHALTER_STANDARD_FUNKTION));
  // Koordinator 08.11.2026: Vorsichtsliste gestrichen - diese gehen in aktiven Projekten automatisch EIN.
  ok(['agenten_ausweis', 'mehrprojekt', 'main_agentenverwaltung', 'kontingent_delegiert'].every(f => k(f).standard_aktive_projekte && k(f).ausnahme_grund === null),
    'P22-T311 A Entscheid Koordinator: Ausweis/Visum/Main-Verwaltung/Kontingent keine Ausnahme');
  // Befund 08.11.2026 (thought 08c5c214, Koordinator): neues Schema/Verhalten bei Agenten, lokales Loeschen oder Last -> Ausnahme mit Grund.
  const NEU_AUSNAHMEN = ['inbox_quittung', 'runtime_tool_ausgabe', 'runtime_synapse_mods', 'cache_waechter', 'mod_inbox', 'mod_inbox_vorpruefung',
    'asset_tombstone_zustellung', 'asset_pc_zustellung', 'asset_transfer_generisch', 'anker_umrechnung'];
  ok(NEU_AUSNAHMEN.every(f => S.PROFIL_PRODUKT_FUNKTIONEN.includes(f) && !k(f).standard_aktive_projekte && typeof k(f).ausnahme_grund === 'string' && k(f).ausnahme_grund.length > 5),
    'P22-T311 A Befund 08c5c214: zehn Schalter bleiben Ausnahme mit Grund (agent-profil-schalter.ts STANDARD_AKTIVE_PROJEKTE_AUSNAHMEN)', NEU_AUSNAHMEN.map(k));
  ok(S.schalterKatalog().length === S.PROFIL_PRODUKT_FUNKTIONEN.length, 'P22-T311 A schalterKatalog deckt alle Produkt-Schalter ab');

  // B Mechanik AUS = Bestand
  let s = await lies();
  ok(s.aktiv === false && s.wert_quelle === 'standard' && s.standard_aktive_projekte?.mechanik === false, 'P22-T311 B Mechanik AUS: Standard AUS wie bisher', s);

  // C Mechanik EIN (global durch den User), aktives Projekt
  await setze({ebene: 'global', funktion: S.SCHALTER_STANDARD_FUNKTION, aktiv: true});
  s = await lies();
  ok(s.aktiv === true && s.quelle === 'standard' && s.wert_quelle === 'standard_aktives_projekt' && s.standard_aktive_projekte?.projekt_aktiv === true,
    'P22-T311 C/SOLL 1+5 aktives Projekt: freigegebener Schalter EIN, Quelle standard_aktives_projekt', s);
  ok((await lies('coedit_ohne_gate')).aktiv === false, 'P22-T311 C Ausnahme bleibt AUS im aktiven Projekt');
  const mi = await lies('mod_inbox');
  ok(mi.aktiv === false && mi.wert_quelle === 'standard' && (await lies('inbox_quittung')).aktiv === false, 'P22-T311 C Befund 08c5c214: mod_inbox/inbox_quittung bleiben AUS im aktiven Projekt', mi);
  ok((await lies('tool_ausgabe_seiten')).aktiv === false, 'P22-T311 C nicht abgenommener Schalter bleibt AUS im aktiven Projekt');
  ok((await lies('mehrprojekt')).aktiv === true && (await lies('agenten_ausweis')).wert_quelle === 'standard_aktives_projekt', 'P22-T311 C mehrprojekt/agenten_ausweis im aktiven Projekt EIN');
  ok((await S.leseProfilProduktSchalterGepuffert(F, P, null)).aktiv === true, 'P22-T311 C gepufferte Lesestelle liefert denselben Wert');

  // D inaktiv / unbekannt / ohne Projekt
  ok((await lies(F, AUS)).aktiv === false, 'P22-T311 D inaktives Projekt (Tray deaktiviert): AUS');
  ok((await lies(F, P + '-unbekannt')).aktiv === false, 'P22-T311 D unbekanntes Projekt: AUS');
  ok((await lies(F, null)).aktiv === false, 'P22-T311 D ohne Projekt (global gelesen): AUS');

  // E ausdruecklich gesetzt gewinnt
  await setze({ebene: 'projekt', project: P, funktion: F, aktiv: false});
  s = await lies();
  ok(s.aktiv === false && s.wert_quelle === 'projekt', 'P22-T311 E ausdruecklich AUS im Projekt gewinnt', s);
  await setze({ebene: 'global', funktion: F, aktiv: false});
  s = await lies(F, Q);
  ok(s.aktiv === false && s.wert_quelle === 'global', 'P22-T311 E ausdruecklich AUS global gewinnt im anderen aktiven Projekt', s);
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion=$1", [F]);
  S.leereAusweisKernCache();

  // F Notfall-Recht ohne Ausweis (SOLL 3)
  const ohne = (e, agent = 'luna-9', aufruf = P) => setze({grund: 'Notfall P22-T311: Schalter inkompatibel', ...e}, {ohne_ausweis: agent, aufruf_project: aufruf});
  // schalter_setzen_ohne_ausweis ist freigegeben: im aktiven Projekt mit Mechanik automatisch EIN; ausdruecklich AUS sperrt.
  await setze({ebene: 'projekt', project: P, funktion: 'schalter_setzen_ohne_ausweis', aktiv: false});
  ok(await fehlerCode(() => ohne({ebene: 'projekt', project: P, funktion: F, aktiv: false})) === 'ohne_ausweis_aus', 'P22-T311 F schalter_setzen_ohne_ausweis ausdruecklich AUS: abgelehnt');
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='schalter_setzen_ohne_ausweis'");
  S.leereAusweisKernCache();
  ok((await lies('schalter_setzen_ohne_ausweis')).wert_quelle === 'standard_aktives_projekt', 'P22-T311 F Notfall-Recht im aktiven Projekt automatisch EIN (freigegeben)');
  const r = await ohne({ebene: 'projekt', project: P, funktion: F, aktiv: false});
  ok(r.aktiv === false && r.gesetzt_von === 'ohne_ausweis:luna-9' && r.wert_quelle === 'projekt', 'P22-T311 F eigenes Projekt mit Pflichtgrund gesetzt, Audit ohne_ausweis', r);
  ok(await fehlerCode(() => ohne({ebene: 'projekt', project: P, funktion: F, aktiv: true, grund: 'kurz'})) === 'grund_fehlt', 'P22-T311 F Grund unter 10 Zeichen abgelehnt');
  // aktiv false: 'alle' mit aktiv true scheitert schon vorher an der Modus-Pruefung des Ausweis-Kerns (W12 V7).
  const alleCode = await fehlerCode(() => ohne({ebene: 'projekt', project: P, funktion: 'alle', aktiv: false}));
  ok(alleCode === 'recht_fehlt', "P22-T311 F 'alle' ohne Ausweis abgelehnt", alleCode);
  await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,'t311-mit','t311-mit','subagent','test')", [randomUUID(), P]);
  ok(await fehlerCode(() => ohne({ebene: 'projekt', project: P, funktion: F, aktiv: true}, 't311-mit')) === 'recht_fehlt', 'P22-T311 F Name einer Ausweis-Identitaet: abgelehnt');
  // Nachzug (Koordinator 08.11.2026): frueherer Name (Alias P22-T173) einer aktiven Ausweis-Identitaet zaehlt wie ihr Name.
  const umbenannt = randomUUID();
  await pool.query("INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von) VALUES ($1,$2,'t311-neu','t311-neu','subagent','test')", [umbenannt, P]);
  await pool.query("INSERT INTO agent_namens_aliase (project, identity_id, alter_name, neuer_name, umbenannt_von, grund) VALUES ($1,$2,'t311-alt','t311-neu','test','P22-T311 Alias')", [P, umbenannt]);
  ok(await fehlerCode(() => ohne({ebene: 'projekt', project: P, funktion: F, aktiv: true}, 't311-alt')) === 'recht_fehlt', 'P22-T311 F Alias-Name einer Ausweis-Identitaet: abgelehnt (agent-profil-schalter.ts)');
  await setze({ebene: 'projekt', project: Q, funktion: 'schalter_setzen_ohne_ausweis', aktiv: false});
  ok(await fehlerCode(() => ohne({ebene: 'projekt', project: Q, funktion: F, aktiv: false})) === 'ohne_ausweis_aus', 'P22-T311 F fremdes Projekt mit dessen Schalter AUS: abgelehnt');
  await setze({ebene: 'projekt', project: Q, funktion: 'schalter_setzen_ohne_ausweis', aktiv: true});
  ok((await ohne({ebene: 'projekt', project: Q, funktion: F, aktiv: false})).aktiv === false, 'P22-T311 F fremdes Projekt mit dessen Schalter: gesetzt');
  const g = await ohne({ebene: 'global', funktion: 'chat_zitate', aktiv: true});
  ok(g.ebene === 'global' && g.gesetzt_von === 'ohne_ausweis:luna-9', 'P22-T311 F global ueber das Aufrufprojekt: gesetzt', g);
  ok(await fehlerCode(() => ohne({ebene: 'global', funktion: 'chat_zitate', aktiv: false}, 'luna-9', AUS)) === 'ohne_ausweis_aus', 'P22-T311 F global aus Projekt ohne Schalter: abgelehnt');

  // F (ergaenzt Gegenpruefung claude-buche, 08.11.2026): derselbe Notfall-Weg ueber den admin-Dispatcher
  // (agent-profil-admin.ts fuehreW1bAdminAus profil_schalter_setzen ohne Akteur, mit agent_id, ohne ziel_ebene).
  const A = await load('packages/core/dist/services/agent-profil-admin.js');
  const ra = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, agent_id: 'luna-9', profil_funktion: F, aktiv: false, grund: 'Notfall P22-T311: admin-Weg'}, {akteur: null});
  ok(ra.success === true && ra.weg === 'ohne_ausweis' && ra.schalter?.gesetzt_von === 'ohne_ausweis:luna-9' && ra.schalter?.aktiv === false,
    'P22-T311 F admin profil_schalter_setzen ohne Ausweis: Notfall-Weg gesetzt (agent-profil-admin.ts)', ra);
  const rk = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, agent_id: 'luna-9', profil_funktion: F, aktiv: false, grund: 'kurz'}, {akteur: null});
  ok(rk.success === false, 'P22-T311 F admin-Weg: Grund unter 10 Zeichen abgelehnt', rk);
  const rm = await A.fuehreW1bAdminAus('profil_schalter_setzen', {project: P, agent_id: 't311-mit', profil_funktion: F, aktiv: false, grund: 'Notfall P22-T311: Ausweis-Name'}, {akteur: null});
  ok(rm.success === false, 'P22-T311 F admin-Weg: Name einer Ausweis-Identitaet abgelehnt', rm);

  // G Verlauf (Web-UI-Historie)
  const v = await S.leseSchalterVerlauf(P, 50);
  const notfall = v.find(z => z.herkunft === 'ohne_ausweis' && z.funktion === F && z.project === P);
  ok(notfall && notfall.neu === false && notfall.gesetzt_von === 'ohne_ausweis:luna-9' && notfall.setter_agent_id === 'luna-9' && /Notfall/.test(notfall.grund),
    'P22-T311 G Verlauf: Notfall-Aenderung mit Agent + Grund', v.slice(0, 3));
  ok(v.some(z => z.herkunft === 'user' && z.ebene === 'global' && z.funktion === S.SCHALTER_STANDARD_FUNKTION && z.alt === null && z.neu === true),
    'P22-T311 G Verlauf: User-Aenderung global mit alt/neu', v.map(z => [z.ebene, z.funktion, z.herkunft]));
  ok(v.some(z => z.ebene === 'global' && z.funktion === 'chat_zitate'), 'P22-T311 G Verlauf: globale Aenderungen in jeder Projektsicht');
  ok(!(await S.leseSchalterVerlauf(Q, 50)).some(z => z.project === P), 'P22-T311 G Verlauf: kein fremdes Projekt in der Projektsicht');

  console.log('TEST_GRUEN P22-T311 Schalter-Standard checks=' + pass);
} finally {
  if (pool) {
    try { await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE'); } catch (e) { console.error('DEBUG Schema-Rueckbau: ' + e.message); }
    await pool.end();
  }
}
