/**
 * P22-T154: Artefakte als Datenvorlagen. NUR synapse_test:5433, privates Schema, gebaute Core/API-dists, kein Docker/Browser
 * (Abbild-Schritte des Main-Wegs scheitern absichtlich laut, die PG-Zeile bleibt; wie artefakt-bewertung-p22-t141).
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/artefakt-vorlagen-p22-t154.test.mjs
 * A Schema 152 idempotent (2x), Spiegel SQL = TS, session_id optional, NOTIFY synapse_plan bei Plan-Aenderung.
 * B Schalter AUS: zeigen per Ausweis -> kein_hauptagent_kontext (wie bisher), Vorlage -> funktion_aus, fertiges HTML unveraendert.
 * C Koordinator per Ausweis: zeigen mit vorlage + plan.list -> Renderung mit echten Plandaten, Verlaufszeile (artefakte), Liste.
 * D Pruefungen: unbekannter Vertrag, deploy.stand geplant, project in args, kaputte Vorlage, html+vorlage, Main ohne project.
 * E Rechte: Ausweis fremdes Projekt -> projekt_fremd (zeigen, neu_zeichnen); User rendert in jedem Projekt (Auswahl, projekte).
 * F Ersetzen nur Urheber (nicht_urheber), neu zeichnen jeder mit Leserecht.
 * G stand vs neu zeichnen: Anzeigen zeigt die Momentaufnahme, neu zeichnen die neuen Daten, Verlauf rev steigt; gleiche Daten -> gleiche Revision.
 * H live: Abo, Plan-Aenderung -> 'artefakt'-Ereignis mit neuer Revision, Verlaufszeile aktualisiert; Schalter live AUS -> Strom 'aus'.
 * I Main-Session mit Vorlage (project Pflicht), Einstellungen (Pruefung, Debug-Route mit Katalog), Bewertung am Vorlagen-Artefakt.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const db = process.env.SYNAPSE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
let testDb;
try { testDb = new URL(db); } catch { /* unten geschlossen abbrechen */ }
if (testDb?.pathname !== '/synapse_test' || testDb.port !== '5433') {
  console.error('Abbruch: SYNAPSE_DATABASE_URL muss auf synapse_test:5433 zeigen'); process.exit(2);
}
process.env.DATABASE_URL = db;
process.env.SYNAPSE_AUTH_DISABLED = '1';
process.env.DOCKER_SOCKET = '/nicht/vorhanden/docker.sock';
process.env.SYNAPSE_KI_BROWSER_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_W1B_GATE_TTL_MS = '0';

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const AT = await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
const L = await load('packages/rest-api/dist/services/artefakt-live.js');
const C = await load('packages/core/dist/index.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t154_' + randomUUID().replaceAll('-', '');
const pool = {
  async connect() {
    const client = await basisPool.connect();
    try { await client.query('SET search_path TO ' + schema + ',public'); return client; }
    catch (error) { client.release(); throw error; }
  },
  async query(...args) {
    const client = await this.connect();
    try { return await client.query(...args); } finally { client.release(); }
  },
};

let fails = 0;
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 700) : '')); } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const P = 'p22-t154-' + randomUUID().slice(0, 8);
const P2 = P + '-b';
const KOORD = randomUUID(), ANDERER = randomUUID(), FREMD = randomUUID(), MAIN = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const mit = (f) => mitLesePool(pool, f);
const inject = (o) => mit(() => app.inject(o));
const bezug = { modus: 'beide', standard: 'beide', quelle: 'standard', bis: null, letzter_fehler: null };
const als = (identity, agent, project, f) => mit(() => C.mitAgentAufrufKontext({ principal: { art: 'identity', project, agent_id: agent, identity_id: identity,
  rolle: 'koordinator', modell: null, context_epoch: 1, lauf_id: null }, bezug }, f));
const tool = (identity, agent, args, project = P) => als(identity, agent, project, () => AT.fuehreArtefaktAus(args, agent));
const schalter = async (funktion, aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1", [funktion]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T154 Testfixture','user')", [funktion, aktiv]);
};
const tasks = (done, offen) => JSON.stringify([
  ...Array.from({ length: done }, (_, i) => ({ id: randomUUID(), kurz_id: 'P1-T' + (i + 1), title: 'erledigt ' + i, description: '', status: 'done', priority: 'medium' })),
  ...Array.from({ length: offen }, (_, i) => ({ id: randomUUID(), kurz_id: 'P1-T' + (done + i + 1), title: 'offen ' + i, description: '', status: 'todo', priority: 'medium' })),
]);
const VORLAGE = '<div class="fs"><h2>{{_meta.project}}</h2>{{#each plaene as p}}<p data-plan="{{p.kurz_id}}">{{p.name}}: {{p.tasks_erledigt}}/{{p.tasks_gesamt}} ({{prozent(p.tasks_erledigt, p.tasks_gesamt)}}%)</p>{{/each}}</div>';
const QUELLEN = [{ name: 'plaene', vertrag: 'plan.list' }];

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox', 'agent_artifacts', 'hauptagent_verlauf', 'agent_runtime_sessions', 'agent_runtime_instances', 'plans']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL);

  // ---------------------------------------------------------------- A
  await pool.query(C.ARTEFAKT_VORLAGEN_SCHEMA_SQL);
  await pool.query(C.ARTEFAKT_VORLAGEN_SCHEMA_SQL);
  const spalten = (await pool.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_artifacts'", [schema])).rows;
  const sp = Object.fromEntries(spalten.map((s) => [s.column_name, s.is_nullable]));
  check(sp.vorlage && sp.quellen && sp.modus === 'NO' && sp.standard_project && sp.session_id === 'YES', 'A Schema 152: Spalten da, modus NOT NULL, session_id optional (2x idempotent)', sp);
  check((await pool.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('artefakt_renderungen','artefakt_vorlagen_einstellungen')", [schema])).rows[0].n === 2, 'A zwei neue Tabellen');
  check(readFileSync(join(repo, 'packages/core/src/db/schema-sql/152_artefakt_vorlagen.sql'), 'utf8').trim() === C.ARTEFAKT_VORLAGEN_SCHEMA_SQL.trim(), 'A Spiegel SQL = TS-Konstante');
  const lausch = await C.verbindeListenClient();
  const gehoert = [];
  lausch.on('notification', (n) => { if (n.channel === 'synapse_plan') gehoert.push(JSON.parse(n.payload)); });
  await lausch.query('LISTEN synapse_plan');
  const PLAN = randomUUID();
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id) VALUES($1,$2,'Fortschritt','',$3::jsonb,true,'P1')", [PLAN, P, tasks(3, 1)]);
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id) VALUES($1,$2,'Anderes Projekt','',$3::jsonb,true,'P1')", [randomUUID(), P2, tasks(1, 1)]);
  for (let i = 0; i < 20 && !gehoert.some((g) => g.project === P && g.id === PLAN); i++) await pause(100);
  check(gehoert.some((g) => g.project === P && g.id === PLAN && g.op === 'INSERT'), 'A NOTIFY synapse_plan mit project, id, op', gehoert);
  await lausch.end();

  await pool.query("INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES($1,$2,'koordinator','koordinator','koordinator','aktiv','t154'),($3,$2,'helfer','helfer','subagent','aktiv','t154'),($4,$5,'fremd','fremd','koordinator','aktiv','t154'),($6,$2,'hauptagent-t154','hauptagent-t154','main','aktiv','t154')",
    [KOORD, P, ANDERER, FREMD, P2, MAIN]);
  await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES('claude','claude','main','/mnt/z/x','img','synapse-runtime-t154',true) ON CONFLICT DO NOTHING");
  const S1 = randomUUID();
  await pool.query("INSERT INTO agent_runtime_sessions(id,agent_role,runtime,status,identity_id) VALUES($1,'main','claude','running',$2)", [S1, MAIN]);

  // ---------------------------------------------------------------- B
  for (const f of ['artefakt_vorlagen', 'artefakt_vorlagen_live', 'artefakt_ausweis_zeigen', 'artefakt_bewertung']) await schalter(f, false);
  let j = await tool(KOORD, 'koordinator', { action: 'zeigen', html: '<div><b>x</b></div>' });
  check(j.success === false && j.error === 'kein_hauptagent_kontext' && /artefakt_ausweis_zeigen/.test(j.message), 'B AUS: zeigen per Ausweis wie bisher abgelehnt (mit Schalter-Hinweis)', j);
  j = await mit(() => AT.fuehreArtefaktAus({ action: 'zeigen', session_id: S1, vorlage: VORLAGE, quellen: QUELLEN, project: P }, 'hauptagent-t154'));
  check(j.success === false && j.error === 'funktion_aus', 'B AUS: Vorlage -> funktion_aus', j);
  j = await mit(() => AT.fuehreArtefaktAus({ action: 'zeigen', session_id: S1, html: '<div><b>fertig</b></div>', titel: 'Fertig' }, 'hauptagent-t154'));
  const FERTIG = j.artefakt_id;
  check(j.success === true && !('vorlage' in j), 'B AUS: fertiges HTML ueber die Main-Session wie bisher', j);
  let r = await inject({ method: 'GET', url: '/api/main-agent/artefakte/' + FERTIG });
  check(r.json().artefakt?.html === '<div><b>fertig</b></div>' && r.json().artefakt.modus === 'fest' && !r.json().render, 'B GET fertiges Artefakt unveraendert (modus fest, ohne render)', r.json());

  // ---------------------------------------------------------------- C
  await schalter('artefakt_vorlagen', true); await schalter('artefakt_ausweis_zeigen', true);
  j = await tool(KOORD, 'koordinator', { action: 'zeigen', titel: 'Projektfortschritt', vorlage: VORLAGE, quellen: QUELLEN });
  const A1 = j.artefakt_id;
  check(j.success === true && j.weg === 'ausweis' && j.vorlage === true && j.modus === 'stand' && j.project === P && j.render_revision === 1 && j.verlauf_id, 'C Koordinator: zeigen mit Vorlage per Ausweis', j);
  check(j.debug?.quellen?.[0]?.vertrag === 'plan.list' && !j.debug.quellen[0].fehler && /^[0-9a-f]{64}$/.test(j.debug.daten_hash), 'C Debug: Quellenstand + daten_hash', j.debug);
  const zeile = async (id) => (await pool.query("SELECT rev::text AS rev, artefakte, meta FROM hauptagent_verlauf WHERE quelle_ref = 'artefakt:' || $1", [id])).rows[0];
  let v = await zeile(A1);
  check(v?.artefakte?.[0]?.html?.includes('Fortschritt: 3/4 (75%)') && v.artefakte[0].vorlage === true && v.meta.project === P, 'C Verlaufszeile mit gerenderten Plandaten', v);
  const art = (await pool.query('SELECT html, session_id, created_by_identity_id, standard_project, modus FROM agent_artifacts WHERE id=$1', [A1])).rows[0];
  check(art.session_id === null && art.created_by_identity_id === KOORD && art.standard_project === P && art.html.includes('<h2>' + P + '</h2>'), 'C agent_artifacts: ohne Session, Urheber-Identitaet, Standardprojekt, html = Renderung', art);
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakte?limit=50' });
  const eintrag = r.json().artefakte.find((a) => a.id === A1);
  check(eintrag?.hatVorlage === true && eintrag.modus === 'stand' && eintrag.standardProject === P, 'C Persoenliche Artefakte: Vorlage, modus, Standardprojekt', eintrag);
  j = await tool(KOORD, 'koordinator', { action: 'quellen' });
  check(j.success === true && j.katalog.some((k) => k.vertrag === 'agentennetzwerk.snapshot') && j.katalog.some((k) => k.vertrag === 'deploy.stand' && k.geplant === true), 'C quellen: Katalog mit API-Quelle und geplantem deploy.stand', j.katalog?.map((k) => k.vertrag));

  // ---------------------------------------------------------------- D
  const zeige = (extra) => tool(KOORD, 'koordinator', { action: 'zeigen', vorlage: VORLAGE, quellen: QUELLEN, ...extra });
  j = await zeige({ quellen: [{ name: 'x', vertrag: 'gibt.es_nicht' }] });
  check(j.error === 'quelle_unbekannt', 'D unbekannter Vertrag', j);
  j = await zeige({ quellen: [{ name: 'd', vertrag: 'deploy.stand' }] });
  check(j.error === 'quelle_geplant', 'D deploy.stand ist reserviert', j);
  j = await zeige({ quellen: [{ name: 'p', vertrag: 'plan.list', args: { project: 'andere' } }] });
  check(j.error === 'quellen_ungueltig' && /project ist kein Argument/.test(j.message), 'D project in args abgelehnt', j);
  j = await zeige({ vorlage: '{{#each plaene as p}}offen' });
  check(j.error === 'vorlage_ungueltig', 'D kaputte Vorlage', j);
  j = await zeige({ html: '<b>x</b>' });
  check(j.error === 'html_und_vorlage', 'D html und vorlage zugleich', j);
  j = await mit(() => AT.fuehreArtefaktAus({ action: 'zeigen', session_id: S1, vorlage: VORLAGE, quellen: QUELLEN }, 'hauptagent-t154'));
  check(j.error === 'projekt_fehlt', 'D Main-Session: Vorlage ohne project', j);

  // ---------------------------------------------------------------- E
  j = await zeige({ project: P2 });
  check(j.error === 'projekt_fremd', 'E Ausweis: zeigen fuer fremdes Projekt', j);
  j = await tool(FREMD, 'fremd', { action: 'neu_zeichnen', artefakt_id: A1 }, P2);
  check(j.success === false && j.error === 'projekt_fremd', 'E Ausweis aus anderem Projekt: neu_zeichnen im Standardprojekt verweigert', j);
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakte/' + A1 + '?project=' + encodeURIComponent(P2) });
  check(r.statusCode === 200 && r.json().artefakt.html.includes('Anderes Projekt: 1/2 (50%)') && r.json().render.project === P2, 'E User: dieselbe Vorlage mit Daten aus einem anderen Projekt', r.json());
  check(r.json().projekte.map((p) => p.project).sort().join(',') === [P, P2].sort().join(','), 'E projekte: beide Renderungen fuer das Auswahlfeld', r.json().projekte);
  const std = (await pool.query('SELECT html FROM agent_artifacts WHERE id=$1', [A1])).rows[0].html;
  check(std.includes('Fortschritt: 3/4') && !std.includes('Anderes Projekt'), 'E Renderung im Fremdprojekt aendert agent_artifacts.html (Standardprojekt) nicht');

  // ---------------------------------------------------------------- F
  j = await tool(ANDERER, 'helfer', { action: 'zeigen', artefakt_id: A1, vorlage: VORLAGE.replace('<h2>', '<h3>').replace('</h2>', '</h3>'), quellen: QUELLEN });
  check(j.success === false && j.error === 'nicht_urheber', 'F Ersetzen durch andere Identitaet verweigert', j);
  j = await tool(ANDERER, 'helfer', { action: 'neu_zeichnen', artefakt_id: A1 });
  check(j.success === true && j.artefakt_id === A1 && j.project === P, 'F neu zeichnen durch andere Identitaet mit Leserecht erlaubt', j);

  // ---------------------------------------------------------------- G
  await pool.query('UPDATE plans SET tasks = $2::jsonb, updated_at = NOW() WHERE id = $1', [PLAN, tasks(4, 0)]);
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakte/' + A1 });
  check(r.json().artefakt.html.includes('3/4 (75%)') && r.json().render.neu === false, 'G stand: Anzeigen zeigt die Momentaufnahme (alte Daten)', r.json().render);
  const revVorher = (await zeile(A1)).rev;
  r = await inject({ method: 'POST', url: '/api/main-agent/artefakte/' + A1 + '/neu-zeichnen', payload: {} });
  const rev2 = r.json().render?.revision;
  check(r.statusCode === 200 && r.json().html.includes('4/4 (100%)') && r.json().render.neu === true && rev2 >= 2, 'G neu zeichnen: neue Daten, neue Revision', r.json());
  v = await zeile(A1);
  check(BigInt(v.rev) > BigInt(revVorher) && v.artefakte[0].html.includes('4/4 (100%)') && v.artefakte[0].revision === rev2, 'G Verlaufszeile aktualisiert (rev steigt, Fenster holt sie per seit_rev)', v);
  r = await inject({ method: 'POST', url: '/api/main-agent/artefakte/' + A1 + '/neu-zeichnen', payload: {} });
  check(r.json().render?.revision === rev2, 'G gleiche Daten -> gleiche Revision (keine Revisionsflut)', r.json().render);

  // ---------------------------------------------------------------- H
  j = await tool(KOORD, 'koordinator', { action: 'zeigen', titel: 'Live', vorlage: VORLAGE, quellen: QUELLEN, modus: 'live' });
  const A2 = j.artefakt_id;
  check(j.success === true && j.modus === 'live', 'H live-Artefakt angelegt', j);
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakte/' + A2 + '/stream' });
  check(r.body.includes('event: aus') && r.body.includes('schalter'), 'H Schalter live AUS: Strom meldet aus', r.body.slice(0, 200));
  await schalter('artefakt_vorlagen_live', true);
  r = await inject({ method: 'PUT', url: '/api/main-agent/artefakt-vorlagen/einstellungen', payload: { werte: { drossel_ms: 5 }, grund: 'T154 Test' } });
  check(r.statusCode === 400 && r.json().error.code === 'wert_ungueltig', 'I Einstellung ausserhalb min/max abgelehnt', r.json());
  r = await inject({ method: 'PUT', url: '/api/main-agent/artefakt-vorlagen/einstellungen', payload: { werte: { drossel_ms: 1000, buendel_ms: 0 }, grund: 'T154 Test' } });
  check(r.statusCode === 200 && r.json().werte?.drossel_ms === 1000 && r.json().werte.buendel_ms === 0 && r.json().einstellungen.drossel_ms.quelle === 'einstellung',
    'I Einstellungen ueber die Route gesetzt (Quelle einstellung)', r.json());
  const ereignisse = [];
  const abo = await mit(() => L.abonniereArtefaktLive(A2, P, { art: 'user' }, (event, data) => ereignisse.push({ event, data })));
  check(abo.kanaele.includes('synapse_plan'), 'H Abo hoert auf synapse_plan', abo.kanaele);
  await pause(1100);
  await pool.query('UPDATE plans SET tasks = $2::jsonb, updated_at = NOW() WHERE id = $1', [PLAN, tasks(2, 2)]);
  await mit(async () => L.verarbeiteBenachrichtigung('synapse_plan', JSON.stringify({ project: P, id: PLAN, op: 'UPDATE' })));
  for (let i = 0; i < 40 && !ereignisse.some((e) => e.event === 'artefakt'); i++) await pause(100);
  const live = ereignisse.find((e) => e.event === 'artefakt');
  check(live?.data?.html?.includes('2/4 (50%)') && live.data.artefakt_id === A2 && live.data.project === P, 'H Plan-Aenderung -> live neu gezeichnet und an den Betrachter gesendet', ereignisse.map((e) => e.event));
  v = await zeile(A2);
  check(v?.artefakte?.[0]?.html?.includes('2/4 (50%)'), 'H Verlaufszeile des Koordinators mit der Live-Renderung', v?.artefakte?.[0]?.html);
  check(L.verarbeiteBenachrichtigung('synapse_plan', JSON.stringify({ project: 'anderes-projekt' })).length === 0, 'H Ereignis eines anderen Projekts trifft nichts');
  check(L.artefaktLiveStatus().abonnenten >= 1, 'H Debug: Live-Status zaehlt Abonnenten', L.artefaktLiveStatus());
  abo.abmelden();
  check(L.artefaktLiveStatus().abonnenten === 0, 'H abmelden gibt das Abo frei', L.artefaktLiveStatus());

  // ---------------------------------------------------------------- I
  j = await mit(() => AT.fuehreArtefaktAus({ action: 'zeigen', session_id: S1, vorlage: VORLAGE, quellen: QUELLEN, project: P, titel: 'Main-Vorlage' }, 'hauptagent-t154'));
  check(j.success === true && j.vorlage === true && j.project === P && j.stream_zugestellt === false && Array.isArray(j.hinweise), 'I Main-Session: Vorlage mit project (Abbilder scheitern laut, PG bleibt)', j);
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakt-vorlagen' });
  check(r.json().schalter?.artefakt_vorlagen?.aktiv === true && r.json().einstellungen?.werte?.drossel_ms === 1000 && r.json().katalog.length >= 4, 'I Debug-Route: Schalter, Einstellungen, Katalog', r.json());
  await schalter('artefakt_bewertung', true);
  r = await inject({ method: 'POST', url: '/api/agent-runtimes/artefakt-bewertung', payload: { quelle_art: 'artefakt', quelle_ref: A1, urteil: 'hoch' } });
  check(r.statusCode === 200 && r.json().bewertung?.zustand === 'vorbild', 'I Bewertung am Vorlagen-Artefakt (Schnappschuss = Renderung)', r.json());
  const snap = (await pool.query("SELECT html FROM artefakt_bewertungen WHERE quelle_art='artefakt' AND quelle_ref=$1", [A1])).rows[0]?.html ?? '';
  check(snap.includes('4/4 (100%)'), 'I Schnappschuss enthaelt die gerenderten Daten', snap.slice(0, 200));
} catch (error) {
  fails++;
  console.log('FAIL Ausnahme ' + (error?.stack ?? error));
} finally {
  await app.close().catch(() => undefined);
  await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => undefined);
  await C.closePool().catch(() => undefined);
}
console.log(fails ? 'FAILS ' + fails : 'PASS artefakt-vorlagen-p22-t154');
process.exit(fails ? 1 : 0);
