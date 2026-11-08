/**
 * P22-T287 S4a: Einstellwerte je Agent (Konzept ebe24645 S4, Uebergabe 9882522a Punkt 2, Pruefer d14c2951).
 * Prueft packages/core/src/services/agent-profil-schalter-ziel.ts (ZIEL_EINSTELLUNG_BEREICHE, leseZielWerte, setzeZielWerte,
 * listeZielWerte, raeumeZielRegelnAuf) und die Bereiche shell-ausgabe.ts (Abrufgrenzen fuer den Aufrufer), agent-ausweis-fristen.ts
 * (Teilmenge), runtime-tool-ausgabe.ts (Schalter + Werte mit Ziel) samt admin-Wegen (shell_ausgabe_einstellungen, ausweis_fristen,
 * runtime_ueberwachung) mit ziel_ebene.
 *   A Katalog: Bereichsnamen gehoeren zu ihren Bereichen, Werte je Job nicht ziel-faehig, runtime_tool_ausgabe ziel-faehig
 *   B Schema 182 (Nachtrag) idempotent
 *   C Mechanik AUS: Setzen funktion_aus, Zeilen wirkungslos, Stand ohne Ziel unveraendert (Form wie vor S4)
 *   D Rang identitaet > agent exakt > agent Muster > typ ueber projekt > global > Standard, je Name; P4 agent-Ebene nur ohne Ausweis
 *   E Validierung und Rechte (gleiche Pruefung wie Schalter), Audit + Verlauf, Entfernen = erben
 *   F Aufrufer-Lesestelle shell (begrenzeShellTailLines): Ziel nur aus dem eigenen Aufruf im selben Projekt
 *   G Fristen-Teilmenge: je Agent, Grenzen, Puffer der Basis unveraendert, admin ausweis_fristen
 *   H runtime_tool_ausgabe: Schalter + Werte je Agent (Daemon-Start-Weg), Grenzen, admin runtime_ueberwachung
 *   I admin shell_ausgabe_einstellungen je Agent + admin-schlank reicht den Zielweg durch
 *   J Puffer (TTL) und Leeren nach Schreiben; K Lesefehler -> Bestand + ziel_fehler; L Aufraeumen; M Mechanik wieder AUS
 *   N S4b Hintergrund-/Empfaengerpfade mit ausdruecklichem Ziel: startkontext (gestartete Identitaet), verlauf_uebergabe,
 *     koordinator_heartbeat (Spawn), ausweis_channels (Abgleich/leave); inbox_quittung/mod_inbox bleiben nicht ziel-faehig
 * Aufruf (Repo-Root, nach Build von core):
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/einstellung-ziel-p22-t287.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pruefeTestDbUrl} from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('P22-T287 S4');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/synapse_test', 'P22-T287 S4: nur gegen synapse_test');
const schema = 'p22t287s4_' + randomUUID().replaceAll('-', '');
const P = 'p22-t287s4-' + randomUUID().slice(0, 8);
const Q = P + '-fremd';
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const repo = new URL('../../../', import.meta.url);
const load = p => import(new URL(p, repo).href);
Object.assign(process.env, {DATABASE_URL: url.toString(), SYNAPSE_DATABASE_URL: url.toString(), SYNAPSE_SCHEMA: 'aus', SYNAPSE_W1B_GATE_TTL_MS: '0', SYNAPSE_INTERN_TOOL: '0',
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
  // Eigene Kopien aller beschriebenen Tabellen (search_path), damit nichts in public von synapse_test landet.
  for (const t of ['agent_profil_schalter', 'agent_identitaeten', 'agent_typen', 'agent_identitaet_audit', 'intern_schalter',
    'shell_ausgabe_einstellungen', 'agent_ausweis_fristen', 'runtime_ueberwachung_einstellungen', 'agent_sessions']) {
    const ex = await pool.query("SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=$1", [t]);
    if (ex.rows.length) await pool.query('CREATE TABLE "' + schema + '"."' + t + '" (LIKE public."' + t + '" INCLUDING ALL)');
  }
  const S = await load('packages/core/dist/services/agent-profil-schalter.js');
  const Z = await load('packages/core/dist/services/agent-profil-schalter-ziel.js');
  const A = await load('packages/core/dist/services/agent-profil-admin.js');
  const SL = await load('packages/core/dist/services/admin-schlank.js');
  const SH = await load('packages/core/dist/services/shell-ausgabe.js');
  const FR = await load('packages/core/dist/services/agent-ausweis-fristen.js');
  const RT = await load('packages/core/dist/services/runtime-tool-ausgabe.js');
  const RU = await load('packages/core/dist/services/runtime-ueberwachung.js');
  const USER = {art: 'user'};
  const G = 'P22-T287 S4 Testlauf';
  const ident = (id, agent, rolle, project = P, typ = null) => pool.query(
    'INSERT INTO agent_identitaeten (id, project, name, agent_id, rolle, erstellt_von, typ_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [id, project, agent, agent, rolle, 'test', typ]);
  const principal = (id, agent, rolle, project = P) => ({art: 'identity', project, agent_id: agent, identity_id: id, rolle, modell: null, context_epoch: 0, lauf_id: null});
  const akteurId = (id, agent, rolle, project = P) => ({art: 'identitaet', principal: principal(id, agent, rolle, project)});
  const projektSchalter = (funktion, aktiv, project = P) => S.setzeProfilProduktSchalter({ebene: 'projekt', project, funktion, aktiv, grund: G}, {system: 'user'});
  const setzeW = (bereich, ebene, ziel, werte, akteur = USER, grund = G) => Z.setzeZielWerte({bereich, ebene, project: P, ziel, werte, grund}, akteur);
  const shell = (ziel) => SH.leseShellAusgabeEinstellungen(P, ziel);
  const BEZUG = {modus: 'beide', standard: 'alt', quelle: 'standard', bis: null, letzter_fehler: null};
  const imKontext = (p, fn) => core.mitAgentAufrufKontext({bezug: BEZUG, principal: p}, fn);

  // A Katalog -------------------------------------------------------------------------------------------------
  const B = Z.ZIEL_EINSTELLUNG_BEREICHE;
  ok(B.shell_ausgabe.every(n => Object.hasOwn(SH.SHELL_AUSGABE_EINSTELLUNGEN, n)), 'P22-T287 S4 A agent-profil-schalter-ziel.ts: shell_ausgabe-Namen aus SHELL_AUSGABE_EINSTELLUNGEN');
  ok(!['max_bytes_je_job', 'ende_reserve_bytes', 'teil_bytes', 'live_intervall_s', 'suche_max_ms'].some(n => B.shell_ausgabe.includes(n)),
    'P22-T287 S4 A Werte je Job (Ablage/Uebertragung) und Zeitbudget bleiben projekt/global');
  ok(B.runtime_tool_ausgabe.every(n => RU.RUNTIME_UEBERWACHUNG_EINSTELLUNGEN[n]?.art === 'zahl'), 'P22-T287 S4 A runtime_tool_ausgabe-Namen sind Zahlwerte der Runtime-Ueberwachung');
  ok(B.ausweis_fristen.join() === 'anmeldung_plaene_minuten,shell_hinweis_minuten' && B.ausweis_fristen.every(n => FR.AUSWEIS_FRIST_NAMEN.includes(n)),
    'P22-T287 S4 A Fristen-Teilmenge: nur Fristen, die fuer EINEN Agenten entscheiden');
  ok(Z.ZIEL_FAEHIGE_FUNKTIONEN.includes('runtime_tool_ausgabe'), 'P22-T287 S4 A runtime_tool_ausgabe ziel-faehig (Lesestelle je Agent: Daemon-Start)');
  ok(/shell_ausgabe_einstellungen/.test(A.W1B_ADMIN_PARAMETER.ziel_ebene?.description ?? ''), 'P22-T287 S4 A Parameter ziel_ebene nennt die Einstellwert-Aktionen');

  // B Schema --------------------------------------------------------------------------------------------------
  await pool.query(core.AGENT_PROFIL_SCHALTER_ZIEL_SCHEMA_SQL);
  await pool.query(core.AGENT_PROFIL_SCHALTER_ZIEL_SCHEMA_SQL);
  ok((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname=$1 AND tablename LIKE 'agent_einstellung_ziel%'", [schema])).rows[0].n === 2,
    'P22-T287 S4 B Schema 182 (Nachtrag) zweimal ausgefuehrt, agent_einstellung_ziel + _verlauf im Testschema');

  await pool.query("INSERT INTO agent_typen(id,scope,project,schluessel,aktuelle_revision,erstellt_von) VALUES('t287s4-klein','projekt',$1,'klein-64k-s4',1,'test')", [P]);
  await ident('id-koord', 'koordinator-s4', 'koordinator');
  await ident('id-sub', 'sub-1', 'subagent', P, 't287s4-klein');
  await ident('id-sub2', 'sub-2', 'subagent', P, 't287s4-klein');
  await ident('id-andere', 'andere-1', 'subagent');
  await ident('id-fremd', 'fremd-1', 'subagent', Q);

  // C Mechanik AUS ---------------------------------------------------------------------------------------------
  const ohneZiel = await shell(null);
  ok(Object.keys(ohneZiel).join() === 'project,werte,einstellungen,schalter,letzter_fehler' && !('ziel' in ohneZiel.einstellungen.log_max_zeilen),
    'P22-T287 S4 C shell-ausgabe.ts: Stand ohne Ziel hat die Form vor S4 (keine neuen Felder)', Object.keys(ohneZiel));
  ok(await fehlerCode(() => setzeW('shell_ausgabe', 'identitaet', 'id-sub', {log_max_zeilen: 50})) === 'funktion_aus', 'P22-T287 S4 C Setzen bei schalter_identitaet AUS -> funktion_aus');
  await pool.query("INSERT INTO agent_einstellung_ziel (bereich,ebene,project,ziel,name,wert,grund,gesetzt_von) VALUES ('shell_ausgabe','identitaet',$1,'id-sub','log_max_zeilen',50,'direkt','test')", [P]);
  let st = await shell({identity_id: 'id-sub'});
  ok(st.werte.log_max_zeilen === 500 && st.einstellungen.log_max_zeilen.quelle === 'standard', 'P22-T287 S4 C vorhandene Zeile wirkungslos bei AUS (= Bestand)', st.einstellungen.log_max_zeilen);
  ok(Object.keys((await Z.leseZielWerte('shell_ausgabe', P, {identity_id: 'id-sub'})).werte).length === 0, 'P22-T287 S4 C leseZielWerte bei AUS leer');
  await pool.query('DELETE FROM agent_einstellung_ziel');
  await projektSchalter('schalter_identitaet', true);

  // D Rang ------------------------------------------------------------------------------------------------------
  let r = await setzeW('shell_ausgabe', 'identitaet', 'id-sub', {log_max_zeilen: 50});
  ok(r.aenderungen[0].geaendert === true && r.aenderungen[0].alt === null && r.aenderungen[0].neu === 50 && r.wer === 'user' && r.herkunft === 'user',
    'P22-T287 S4 D setzeZielWerte (User) identitaet', r);
  st = await shell({identity_id: 'id-sub'});
  ok(st.werte.log_max_zeilen === 50 && st.einstellungen.log_max_zeilen.quelle === 'identitaet' && st.einstellungen.log_max_zeilen.ziel === 'id-sub',
    'P22-T287 S4 D wirksam fuer die Identitaet, Quelle identitaet + ziel (Debug)', st.einstellungen.log_max_zeilen);
  ok((await shell({identity_id: 'id-andere'})).werte.log_max_zeilen === 500, 'P22-T287 S4 D andere Identitaet unberuehrt');
  ok((await shell(null)).werte.log_max_zeilen === 500, 'P22-T287 S4 D ohne Ziel = Projektsicht (Fremd-Empfaenger-Regel)');
  await setzeW('shell_ausgabe', 'typ', 't287s4-klein', {log_max_zeilen: 70, stream_max_zeilen: 71});
  st = await shell({identity_id: 'id-sub2'});
  ok(st.werte.log_max_zeilen === 70 && st.einstellungen.log_max_zeilen.quelle === 'typ', 'P22-T287 S4 D Typ-Regel fuer Identitaet dieses Typs', st.einstellungen.log_max_zeilen);
  st = await shell({identity_id: 'id-sub'});
  ok(st.werte.log_max_zeilen === 50 && st.werte.stream_max_zeilen === 71 && st.einstellungen.stream_max_zeilen.quelle === 'typ',
    'P22-T287 S4 D identitaet > typ je Name (anderer Name erbt vom Typ)', st.werte);
  await setzeW('shell_ausgabe', 'agent', 'luna-*', {log_max_zeilen: 80});
  await setzeW('shell_ausgabe', 'agent', 'luna-3', {log_max_zeilen: 81});
  const zl = await Z.leseZielWerte('shell_ausgabe', P, {agent_id: 'luna-4'});
  ok(zl.werte.log_max_zeilen?.wert === 80 && zl.werte.log_max_zeilen.ziel_muster === true, 'P22-T287 S4 D agent Muster (ohne Ausweis)', zl);
  ok((await shell({agent_id: 'luna-3'})).werte.log_max_zeilen === 81, 'P22-T287 S4 D agent exakt vor Muster');
  ok((await shell({identity_id: 'id-andere', agent_id: 'luna-3'})).werte.log_max_zeilen === 500, 'P22-T287 S4 D P4: mit identity_id keine agent-Ebene');
  await pool.query("INSERT INTO shell_ausgabe_einstellungen(ebene,project,name,wert,grund,gesetzt_von) VALUES('projekt',$1,'log_max_bytes',1000,'t','test')", [P]);
  st = await shell({identity_id: 'id-sub'});
  ok(st.werte.log_max_bytes === 1000 && st.einstellungen.log_max_bytes.quelle === 'projekt' && st.werte.log_max_zeilen === 50,
    'P22-T287 S4 D Projektwert gilt weiter fuer Namen ohne Agent-Regel', st.einstellungen.log_max_bytes);

  // E Validierung, Rechte, Audit ----------------------------------------------------------------------------------
  ok(await fehlerCode(() => setzeW('shell_ausgabe', 'identitaet', 'id-sub', {max_bytes_je_job: 5})) === 'wert_nicht_je_ziel', 'P22-T287 S4 E Wert je Job nicht je Agent');
  ok(await fehlerCode(() => setzeW('gibtsnicht', 'identitaet', 'id-sub', {x: 1})) === 'bereich_unbekannt', 'P22-T287 S4 E unbekannter Bereich');
  ok(await fehlerCode(() => setzeW('shell_ausgabe', 'identitaet', 'id-sub', {log_max_zeilen: -1})) === 'wert_ungueltig', 'P22-T287 S4 E negativer Wert');
  ok(await fehlerCode(() => setzeW('shell_ausgabe', 'identitaet', 'id-sub', {})) === 'werte_fehlen', 'P22-T287 S4 E ohne Werte');
  ok(await fehlerCode(() => setzeW('shell_ausgabe', 'identitaet', 'id-sub', {log_max_zeilen: 5}, USER, 'kurz')) === 'grund_fehlt', 'P22-T287 S4 E Grund Pflicht');
  ok(await fehlerCode(() => setzeW('shell_ausgabe', 'identitaet', 'id-fremd', {log_max_zeilen: 5})) === 'identitaet_unbekannt', 'P22-T287 S4 E Identitaet eines anderen Projekts');
  ok(await fehlerCode(() => setzeW('shell_ausgabe', 'agent', '*', {log_max_zeilen: 5})) === 'ziel_ungueltig', 'P22-T287 S4 E Muster nur * abgewiesen');
  ok(await fehlerCode(() => setzeW('shell_ausgabe', 'identitaet', 'id-sub', {log_max_zeilen: 5}, akteurId('id-sub', 'sub-1', 'subagent'))) === 'recht_fehlt',
    'P22-T287 S4 E Subagent nie (auch nicht fuer sich selbst)');
  r = await setzeW('shell_ausgabe', 'identitaet', 'id-sub', {log_max_zeilen: 55}, akteurId('id-koord', 'koordinator-s4', 'koordinator'));
  ok(r.wer === 'id-koord' && r.herkunft === 'ausweis' && r.aenderungen[0].alt === 50, 'P22-T287 S4 E Koordinator mit Ausweis setzt (alt -> neu)', r);
  const au = (await pool.query("SELECT aktion, alt, neu, actor_identity_id FROM agent_identitaet_audit WHERE identity_id='id-sub' ORDER BY id DESC LIMIT 1")).rows[0];
  ok(au?.aktion === 'einstellung_gesetzt' && au.neu?.bereich === 'shell_ausgabe' && au.neu?.wert === 55 && au.alt?.wert === 50 && au.actor_identity_id === 'id-koord',
    'P22-T287 S4 E agent_identitaet_audit (Verlauf des Ausweises)', au);
  const vl = (await pool.query("SELECT alt::int AS alt, neu::int AS neu, herkunft, gesetzt_von FROM agent_einstellung_ziel_verlauf WHERE ziel='id-sub' ORDER BY id DESC LIMIT 1")).rows[0];
  ok(vl?.alt === 50 && vl.neu === 55 && vl.herkunft === 'ausweis' && vl.gesetzt_von === 'id-koord', 'P22-T287 S4 E Verlauf mit Herkunft', vl);
  r = await setzeW('shell_ausgabe', 'identitaet', 'id-sub', {log_max_zeilen: null});
  st = await shell({identity_id: 'id-sub'});
  ok(r.aenderungen[0].geaendert && st.werte.log_max_zeilen === 70 && st.einstellungen.log_max_zeilen.quelle === 'typ', 'P22-T287 S4 E Entfernen = erben (Typ greift wieder)', st.einstellungen.log_max_zeilen);
  ok((await pool.query("SELECT aktion FROM agent_identitaet_audit WHERE identity_id='id-sub' ORDER BY id DESC LIMIT 1")).rows[0]?.aktion === 'einstellung_entfernt', 'P22-T287 S4 E Audit beim Entfernen');
  ok((await setzeW('shell_ausgabe', 'identitaet', 'id-sub', {log_max_zeilen: null})).aenderungen[0].geaendert === false, 'P22-T287 S4 E Entfernen ohne Regel: nichts geaendert');
  const liste = await Z.listeZielWerte(P, {bereich: 'shell_ausgabe', ebene: 'typ'});
  ok(liste.length === 2 && liste.every(x => x.ziel === 't287s4-klein' && typeof x.wert === 'number' && x.herkunft === 'user'), 'P22-T287 S4 E listeZielWerte (Debug)', liste);

  // F Aufrufer-Lesestelle shell -----------------------------------------------------------------------------------
  await projektSchalter('shell_ausgabe_voll', true);
  await setzeW('shell_ausgabe', 'identitaet', 'id-sub', {exec_tail_max_zeilen: 7});
  ok(await SH.begrenzeShellTailLines(P, 999) === 200, 'P22-T287 S4 F ohne Aufrufkontext: Projektsicht (200)');
  ok(await imKontext(principal('id-sub', 'sub-1', 'subagent'), () => SH.begrenzeShellTailLines(P, 999)) === 7, 'P22-T287 S4 F Aufrufer id-sub: eigener Wert 7');
  ok(await imKontext(principal('id-andere', 'andere-1', 'subagent'), () => SH.begrenzeShellTailLines(P, 999)) === 200, 'P22-T287 S4 F anderer Aufrufer: 200');
  ok(await imKontext(principal('id-sub', 'sub-1', 'subagent', Q), () => SH.begrenzeShellTailLines(P, 999)) === 200, 'P22-T287 S4 F Aufruf aus anderem Projekt: Projektsicht');

  // G Fristen-Teilmenge ---------------------------------------------------------------------------------------------
  await setzeW('ausweis_fristen', 'identitaet', 'id-sub', {shell_hinweis_minuten: 5});
  let fr = await FR.leseAusweisFristen(P, {ziel: {identity_id: 'id-sub'}});
  ok(fr.fristen.shell_hinweis_minuten.wert === 5 && fr.fristen.shell_hinweis_minuten.ms === 300000 && fr.fristen.shell_hinweis_minuten.quelle === 'identitaet'
    && fr.fristen.shell_hinweis_minuten.ziel === 'id-sub', 'P22-T287 S4 G agent-ausweis-fristen.ts: Frist je Identitaet (wert, ms, quelle, ziel)', fr.fristen.shell_hinweis_minuten);
  ok((await FR.leseAusweisFristen(P)).fristen.shell_hinweis_minuten.wert === 60, 'P22-T287 S4 G ohne Ziel Standard 60 (Bestand)');
  ok(!('ziel_fehler' in fr) && Object.keys(await FR.leseAusweisFristen(P)).join() === 'project,fristen,letzter_fehler,hinweis', 'P22-T287 S4 G Form ohne Ziel unveraendert');
  await pool.query("INSERT INTO agent_einstellung_ziel (bereich,ebene,project,ziel,name,wert,grund,gesetzt_von) VALUES ('ausweis_fristen','identitaet',$1,'id-andere','shell_hinweis_minuten',5000,'direkt','test')", [P]);
  ok((await FR.leseAusweisFristen(P, {ziel: {identity_id: 'id-andere'}})).fristen.shell_hinweis_minuten.wert === 60, 'P22-T287 S4 G Wert ausserhalb des Fristbereichs wird ignoriert');
  ok(await fehlerCode(() => setzeW('ausweis_fristen', 'identitaet', 'id-sub', {visum_minuten: 5})) === 'wert_nicht_je_ziel', 'P22-T287 S4 G visum_minuten nicht je Agent');
  let ad = await A.fuehreW1bAdminAus('ausweis_fristen', {project: P, modus: 'setzen', ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', anmeldung_plaene_minuten: 90, grund: G}, {akteur: USER});
  ok(ad.success && ad.aenderung?.aenderungen?.[0]?.neu === 90 && ad.ausweis_fristen?.fristen?.anmeldung_plaene_minuten?.wert === 90
    && ad.ausweis_fristen.fristen.anmeldung_plaene_minuten.quelle === 'identitaet' && ad.ziel_werte?.length === 2, 'P22-T287 S4 G admin ausweis_fristen setzen je Agent', ad);
  ad = await A.fuehreW1bAdminAus('ausweis_fristen', {project: P, modus: 'setzen', ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', anmeldung_plaene_minuten: 5000, grund: G}, {akteur: USER});
  ok(ad.success === false && ad.error === 'frist_ungueltig', 'P22-T287 S4 G admin: Fristbereich gilt auch je Agent', ad);
  ad = await A.fuehreW1bAdminAus('ausweis_fristen', {project: P, modus: 'setzen', ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', visum_minuten: 20, grund: G}, {akteur: USER});
  ok(ad.success === false && ad.error === 'wert_nicht_je_ziel', 'P22-T287 S4 G admin: nicht ziel-faehige Frist abgewiesen', ad);
  ad = await A.fuehreW1bAdminAus('ausweis_fristen', {project: P, modus: 'entfernen', ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', frist_namen: ['anmeldung_plaene_minuten'], grund: G}, {akteur: USER});
  ok(ad.success && ad.ausweis_fristen?.fristen?.anmeldung_plaene_minuten?.wert === 30, 'P22-T287 S4 G admin entfernen = erben (Standard 30)', ad.ausweis_fristen?.fristen?.anmeldung_plaene_minuten);
  ad = await A.fuehreW1bAdminAus('ausweis_fristen', {project: P}, {akteur: USER});
  ok(ad.success && ad.ausweis_fristen?.fristen?.shell_hinweis_minuten?.wert === 60 && !('ziel_werte' in ad), 'P22-T287 S4 G admin status ohne ziel_ebene = Bestand', ad);
  ad = await A.fuehreW1bAdminAus('ausweis_fristen', {project: P, modus: 'setzen', ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', shell_hinweis_minuten: 9, grund: G},
    {akteur: akteurId('id-sub', 'sub-1', 'subagent')});
  ok(ad.success === false && ad.error === 'recht_fehlt', 'P22-T287 S4 G admin: Subagent nicht', ad);

  // H runtime_tool_ausgabe -------------------------------------------------------------------------------------------
  let rt = await RT.leseRuntimeToolAusgabe(P, {identity_id: 'id-sub'});
  ok(rt.schalter.aktiv === false && rt.werte.claude_mcp_output_tokens === 100000 && rt.quellen.claude_mcp_output_tokens === 'standard' && !('ziel_fehler' in rt),
    'P22-T287 S4 H runtime-tool-ausgabe.ts: ohne Regeln Bestand', rt);
  await setzeW('runtime_tool_ausgabe', 'identitaet', 'id-sub', {claude_mcp_output_tokens: 5000});
  await Z.setzeZielSchalter({ebene: 'identitaet', project: P, ziel: 'id-sub', funktion: 'runtime_tool_ausgabe', aktiv: true, grund: G}, USER);
  rt = await RT.leseRuntimeToolAusgabe(P, {identity_id: 'id-sub'});
  ok(rt.schalter.aktiv === true && rt.schalter.ziel_ebene === 'identitaet' && rt.werte.claude_mcp_output_tokens === 5000 && rt.quellen.claude_mcp_output_tokens === 'identitaet',
    'P22-T287 S4 H Daemon-Start-Weg: Schalter + Wert der GESTARTETEN Identitaet', rt);
  const env = core.toolAusgabeUmgebung(rt);
  ok(env.SYNAPSE_TOOL_AUSGABE_AKTIV === '1' && env.SYNAPSE_CLAUDE_MCP_OUTPUT_TOKENS === '5000' && JSON.parse(env.SYNAPSE_TOOL_AUSGABE_QUELLE).werte.claude_mcp_output_tokens === 'identitaet',
    'P22-T287 S4 H Wrapper-Umgebung traegt Wert und Quelle', env);
  rt = await RT.leseRuntimeToolAusgabe(P);
  ok(rt.schalter.aktiv === false && rt.werte.claude_mcp_output_tokens === 100000, 'P22-T287 S4 H ohne Ziel (Main-Start/Status) Projektsicht', rt);
  ok((await RT.leseRuntimeToolAusgabe(P, {identity_id: 'id-andere'})).werte.claude_mcp_output_tokens === 100000, 'P22-T287 S4 H andere Identitaet unberuehrt');
  await pool.query("INSERT INTO agent_einstellung_ziel (bereich,ebene,project,ziel,name,wert,grund,gesetzt_von) VALUES ('runtime_tool_ausgabe','identitaet',$1,'id-andere','tool_ausgabe_kontext_prozent',99,'direkt','test')", [P]);
  ok((await RT.leseRuntimeToolAusgabe(P, {identity_id: 'id-andere'})).werte.tool_ausgabe_kontext_prozent === 25, 'P22-T287 S4 H Wert ausserhalb der Grenze (max 50) ignoriert');
  let ru = await RU.fuehreRuntimeUeberwachungAdminAus('runtime_ueberwachung', {project: P, ueberwachung_modus: 'setzen', ueberwachung_werte: {codex_tool_output_tokens: 2000},
    ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', grund: G}, USER);
  ok(ru.success && ru.tool_ausgabe?.werte?.codex_tool_output_tokens === 2000 && ru.aenderung?.bereich === 'runtime_tool_ausgabe', 'P22-T287 S4 H admin runtime_ueberwachung setzen je Agent', ru);
  ru = await RU.fuehreRuntimeUeberwachungAdminAus('runtime_ueberwachung', {project: P, ueberwachung_modus: 'setzen', ueberwachung_werte: {takt_sekunden: 30},
    ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', grund: G}, USER);
  ok(ru.success === false && ru.error === 'wert_nicht_je_ziel', 'P22-T287 S4 H admin: globaler Ueberwachungswert nicht je Agent', ru);
  ru = await RU.fuehreRuntimeUeberwachungAdminAus('runtime_ueberwachung', {project: P, ueberwachung_modus: 'setzen', ueberwachung_werte: {codex_tool_output_tokens: 5},
    ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', grund: G}, USER);
  ok(ru.success === false && ru.error === 'einstellung_ungueltig', 'P22-T287 S4 H admin: Grenzen wie der globale Wert', ru);
  ru = await RU.fuehreRuntimeUeberwachungAdminAus('runtime_ueberwachung', {project: P, ueberwachung_modus: 'status', ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub'}, USER);
  ok(ru.success && ru.ziel_werte?.length === 2 && ru.tool_ausgabe?.werte?.claude_mcp_output_tokens === 5000, 'P22-T287 S4 H admin status je Agent', ru);

  // I admin shell_ausgabe_einstellungen ------------------------------------------------------------------------------
  let sa = await SH.fuehreShellAusgabeAdminAus({project: P, modus: 'setzen', ziel_ebene: 'agent', ziel: 'luna-5', shell_ausgabe_werte: {stream_max_zeilen: 33}, grund: G}, USER);
  ok(sa.success && sa.wirksam?.werte?.stream_max_zeilen === 33 && sa.ziel_werte?.[0]?.ziel === 'luna-5', 'P22-T287 S4 I admin shell_ausgabe_einstellungen je Agent (Name ohne Ausweis)', sa);
  sa = await SH.fuehreShellAusgabeAdminAus({project: P, modus: 'setzen', ziel_ebene: 'galaxie', ziel: 'x', shell_ausgabe_werte: {stream_max_zeilen: 33}, grund: G}, USER);
  ok(sa.success === false && sa.error === 'ziel_ebene_ungueltig', 'P22-T287 S4 I admin: ungueltige ziel_ebene', sa);
  sa = await SH.fuehreShellAusgabeAdminAus({project: P, modus: 'setzen', ziel_ebene: 'identitaet', ziel_identity_id: 'id-sub', shell_ausgabe_werte: {teil_bytes: 1000}, grund: G}, USER);
  ok(sa.success === false && sa.error === 'wert_nicht_je_ziel' && sa.details?.name === 'teil_bytes', 'P22-T287 S4 I admin: Wert je Job abgewiesen (mit details)', sa);
  sa = await SH.fuehreShellAusgabeAdminAus({project: P}, USER);
  ok(sa.success && sa.einstellungen && !('ziel_werte' in sa), 'P22-T287 S4 I admin status ohne ziel_ebene = Bestand');
  let aufrufe = 0;
  const durch = await SL.fuehreAdminSchlankAus('shell_ausgabe_einstellungen', {project: P, modus: 'setzen', ziel_ebene: 'agent', ziel: 'luna-5', shell_ausgabe_werte: {stream_max_zeilen: 34}, grund: G},
    async () => { aufrufe++; return SH.fuehreShellAusgabeAdminAus({project: P, modus: 'setzen', ziel_ebene: 'agent', ziel: 'luna-5', shell_ausgabe_werte: {stream_max_zeilen: 34}, grund: G}, USER); });
  ok(aufrufe === 1 && durch.success && Array.isArray(durch.ziel_werte) && !('geaendert' in durch), 'P22-T287 S4 I admin-schlank.ts reicht den Zielweg unveraendert durch', durch);

  // J Puffer ---------------------------------------------------------------------------------------------------------
  process.env.SYNAPSE_W1B_GATE_TTL_MS = '60000';
  S.leereAusweisKernCache();
  Z.leereSchalterZielDiagnose();
  await Z.leseZielWerte('shell_ausgabe', P, {identity_id: 'id-sub2'});
  await Z.leseZielWerte('shell_ausgabe', P, {identity_id: 'id-sub2'});
  ok(Z.schalterZielDiagnose().abfragen === 1, 'P22-T287 S4 J zweite Lesung aus dem Puffer (eine Zielabfrage)', Z.schalterZielDiagnose());
  await setzeW('shell_ausgabe', 'identitaet', 'id-sub2', {log_max_zeilen: 66});
  ok((await Z.leseZielWerte('shell_ausgabe', P, {identity_id: 'id-sub2'})).werte.log_max_zeilen?.wert === 66, 'P22-T287 S4 J Schreiben leert den Puffer im eigenen Prozess sofort');
  process.env.SYNAPSE_W1B_GATE_TTL_MS = '0';
  S.leereAusweisKernCache();

  // K Lesefehler -------------------------------------------------------------------------------------------------------
  // Spalte umbenennen (nicht die Tabelle): sonst faellt die Abfrage ueber search_path still auf eine public-Tabelle zurueck.
  await pool.query('ALTER TABLE agent_einstellung_ziel RENAME COLUMN wert TO wert_weg');
  st = await shell({identity_id: 'id-sub2'});
  ok(st.ziel_fehler === 'einstellung_ziel_nicht_lesbar' && st.werte.log_max_zeilen === 500 && st.letzter_fehler === null, 'P22-T287 S4 K Lesefehler: Bestand + ziel_fehler', st);
  fr = await FR.leseAusweisFristen(P, {ziel: {identity_id: 'id-sub'}});
  ok(fr.ziel_fehler === 'einstellung_ziel_nicht_lesbar' && fr.fristen.shell_hinweis_minuten.wert === 60, 'P22-T287 S4 K Fristen: Lesefehler -> Bestand + ziel_fehler', fr.ziel_fehler);
  await pool.query('ALTER TABLE agent_einstellung_ziel RENAME COLUMN wert_weg TO wert');

  // L Aufraeumen ---------------------------------------------------------------------------------------------------------
  const c = await pool.connect();
  let weg = 0;
  try {
    await c.query('BEGIN');
    weg = await Z.raeumeZielRegelnAuf(c, {project: P, ebene: 'identitaet', ziel: 'id-sub', wer: 'user', actor_identity_id: null, grund: 'P22-T287 S4 Aufraeumen'});
    await c.query('COMMIT');
  } finally { c.release(); }
  const rest = (await pool.query("SELECT count(*)::int AS n FROM agent_einstellung_ziel WHERE ziel='id-sub'")).rows[0].n;
  const vAuf = (await pool.query("SELECT count(*)::int AS n FROM agent_einstellung_ziel_verlauf WHERE ziel='id-sub' AND herkunft='aufraeumen'")).rows[0].n;
  ok(weg >= 4 && rest === 0 && vAuf >= 3, 'P22-T287 S4 L raeumeZielRegelnAuf entfernt auch die Einstellwerte (Verlauf herkunft aufraeumen)', {weg, rest, vAuf});

  // N S4b Hintergrund-/Empfaengerpfade -----------------------------------------------------------------------------------
  const SV = await load('packages/core/dist/services/hauptagent-sonderstellung.js');
  const VT = await load('packages/core/dist/services/verlauf-tokens.js');
  const KH = await load('packages/core/dist/services/koordinator-heartbeat.js');
  const AC = await load('packages/core/dist/services/ausweis-channels.js');
  const AV = await load('packages/core/dist/services/agent-verlauf.js');
  const regel = (ziel, funktion, aktiv) => Z.setzeZielSchalter({ebene: 'identitaet', project: P, ziel, funktion, aktiv, grund: G}, USER);
  ok(['startkontext', 'verlauf_uebergabe', 'koordinator_heartbeat', 'ausweis_channels'].every(f => Z.istZielFaehig(f)) && !Z.istZielFaehig('inbox_quittung') && !Z.istZielFaehig('mod_inbox'),
    'P22-T287 S4b N agent-profil-schalter-ziel.ts: Positivliste um die Hintergrund-/Empfaengerpfade erweitert, Quittung/Mod-Inbox bewusst nicht');
  ok(await fehlerCode(() => regel('id-sub', 'inbox_quittung', true)) === 'funktion_nicht_je_ziel', 'P22-T287 S4b N inbox_quittung je Agent abgewiesen (Begruendung im Code)');
  const zSub = await Z.zielDerIdentitaet('id-sub');
  ok(zSub?.project === P && zSub.identity_id === 'id-sub' && (await Z.zielDerIdentitaet('gibts-nicht')) === null && (await Z.zielDerIdentitaet(null)) === null,
    'P22-T287 S4b N zielDerIdentitaet: {project, identity_id} bzw. null', zSub);
  // startkontext: Ziel = GESTARTETE Identitaet (agent-verlauf.ts baueStartkontext -> leseMainSchalter)
  let ms = await SV.leseMainSchalter('startkontext', zSub);
  ok(ms.aktiv === true && ms.quelle === 'standard' && !('ziel_ebene' in ms), 'P22-T287 S4b N hauptagent-sonderstellung.ts: ohne Regel Standard EIN (Bestand)', ms);
  await regel('id-sub', 'startkontext', false);
  ms = await SV.leseMainSchalter('startkontext', zSub);
  ok(ms.aktiv === false && ms.ziel_ebene === 'identitaet' && ms.quelle === 'produkt-schalter', 'P22-T287 S4b N startkontext je Identitaet AUS (Quelle + ziel_ebene)', ms);
  ok((await SV.leseMainSchalter('startkontext', await Z.zielDerIdentitaet('id-andere'))).aktiv === true, 'P22-T287 S4b N andere Identitaet: Standard EIN');
  ok((await SV.leseMainSchalter('startkontext')).aktiv === true, 'P22-T287 S4b N ohne Ziel: global wie bisher');
  ok(await AV.baueStartkontext('id-sub') === null, 'P22-T287 S4b N agent-verlauf.ts baueStartkontext: Regel der gestarteten Identitaet AUS -> kein Startkontext');
  // verlauf_uebergabe: Ziel = uebergebende Identitaet (hauptagent-verlauf.ts erzeugeVerlaufUebergabe -> leseVerlaufStufe2Schalter)
  ok((await VT.leseVerlaufStufe2Schalter('verlauf_uebergabe', zSub)).aktiv === false, 'P22-T287 S4b N verlauf-tokens.ts: ohne Regel Standard AUS');
  await regel('id-sub', 'verlauf_uebergabe', true);
  const vu = await VT.leseVerlaufStufe2Schalter('verlauf_uebergabe', zSub);
  ok(vu.aktiv === true && vu.ziel_ebene === 'identitaet', 'P22-T287 S4b N verlauf_uebergabe je Identitaet EIN', vu);
  ok((await VT.leseVerlaufStufe2Schalter('verlauf_uebergabe')).aktiv === false, 'P22-T287 S4b N ohne Ziel: global AUS wie bisher');
  const mk = await VT.leseVerlaufStufe2Schalter('main_korridor', zSub);
  ok(mk.aktiv === false && !('ziel_ebene' in mk), 'P22-T287 S4b N nicht ziel-faehige Stufe-2-Funktion ignoriert das Ziel', mk);
  // koordinator_heartbeat: Ziel = gestarteter Koordinator
  await pool.query(`UPDATE agent_identitaeten SET startrezept='{"heartbeat":{"aktiv":false,"intervall_ms":60000}}'::jsonb WHERE id='id-koord'`);
  ok(await KH.koordinatorHeartbeatBeimSpawn(P, 'id-koord') === null, 'P22-T287 S4b N koordinator-heartbeat.ts: Schalter AUS -> Spawn-Standard (null)');
  await regel('id-koord', 'koordinator_heartbeat', true);
  const hb = await KH.koordinatorHeartbeatBeimSpawn(P, 'id-koord');
  ok(hb?.enabled === false && hb.intervalMs === 60000, 'P22-T287 S4b N Regel je Koordinator EIN -> seine Einstellung beim Spawn', hb);
  const hst = await KH.fuehreKoordinatorHeartbeatAdminAus('koordinator_heartbeat', {project: P}, USER);
  ok(hst.success && hst.schalter?.aktiv === false, 'P22-T287 S4b N Status je Projekt bleibt Projektsicht', hst.schalter);
  // ausweis_channels: Ziel = die Identitaet, deren Mitgliedschaft geprueft wird
  ok((await AC.leseAusweisChannelsSchalter(P, 'id-sub')).aktiv === false, 'P22-T287 S4b N ausweis-channels.ts: ohne Regel Standard AUS');
  await pool.query(`UPDATE agent_identitaeten SET profil='{"channels":["s4-kanal"]}'::jsonb WHERE id IN ('id-sub','id-sub2')`);
  await regel('id-sub', 'ausweis_channels', true);
  const acs = await AC.leseAusweisChannelsSchalter(P, 'id-sub');
  ok(acs.aktiv === true && acs.ziel_ebene === 'identitaet' && acs.quelle === 'produkt-schalter', 'P22-T287 S4b N ausweis_channels je Identitaet EIN', acs);
  ok((await AC.leseAusweisChannelsSchalter(P)).aktiv === false, 'P22-T287 S4b N ohne Identitaet: Projektsicht');
  ok(await fehlerCode(() => AC.pruefeAusweisChannelVerlassen(P, 's4-kanal', 'id-sub')) === 'channel_im_ausweis_festgelegt', 'P22-T287 S4b N leave-Sperre fuer die Identitaet mit Regel');
  ok(await fehlerCode(() => AC.pruefeAusweisChannelVerlassen(P, 's4-kanal', 'id-sub2')) === null, 'P22-T287 S4b N andere Identitaet (ohne Regel) bleibt frei');

  // M Mechanik wieder AUS ------------------------------------------------------------------------------------------------
  await projektSchalter('schalter_identitaet', false);
  st = await shell({identity_id: 'id-sub2'});
  ok(st.werte.log_max_zeilen === 500 && st.werte.log_max_bytes === 1000 && (await pool.query('SELECT count(*)::int AS n FROM agent_einstellung_ziel')).rows[0].n > 0,
    'P22-T287 S4 M Mechanik AUS: Regeln bleiben gespeichert, wirken nicht (Projektwert gilt)', st.werte);
  ok((await SV.leseMainSchalter('startkontext', zSub)).aktiv === true && (await AC.leseAusweisChannelsSchalter(P, 'id-sub')).aktiv === false
    && await KH.koordinatorHeartbeatBeimSpawn(P, 'id-koord') === null, 'P22-T287 S4b M Mechanik AUS: Hintergrundpfade wieder Bestand');

  console.log(`\nP22-T287 S4: ${pass} Pruefungen, 0 Fehler`);
} finally {
  if (pool) {
    await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE').catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}
