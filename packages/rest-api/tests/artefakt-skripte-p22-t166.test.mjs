/**
 * P22-T166: nur lesende Daten-Bruecke fuer Artefakte mit Skript (Top-Artefakte). NUR synapse_test:5433, privates Schema, gebaute
 * Core/API-dists, kein Docker. Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/artefakt-skripte-p22-t166.test.mjs
 * A Schalter artefakt_skripte Standard AUS: Route aus, Bruecke schalter_aus (409), Top-Liste skripte_aktiv false.
 * B Bruecke erlaubt: quelle plan.list/plan.alle im Render-Projekt, lese task (Lesefenster-Klartext).
 * C Abgelehnt: Urheber-Klammer (Ausweis fremdes Projekt), Main-Urheber darf alle, kein Skript, op/Vertrag/args/Art, Groesse, unbekannt.
 * D Debug: Zaehler ok/abgelehnt je Grund in /artefakt-skripte und /artefakt-vorlagen; artefakt(quellen) mit Schalter + Anleitung.
 * E Top-Liste: hat_skript je Eintrag, skripte_aktiv; reine Funktionen enthaeltSkript/urheberDarfProjekt.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const db = process.env.SYNAPSE_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
let testDb;
try { testDb = new URL(db); } catch { /* unten geschlossen abbrechen */ }
if (testDb?.pathname !== '/synapse_test' || testDb.port !== '5433') {
  console.error('Abbruch: SYNAPSE_DATABASE_URL muss auf synapse_test:5433 zeigen'); process.exit(2);
}
process.env.SYNAPSE_AUTH_DISABLED = '1';
process.env.DOCKER_SOCKET = '/nicht/vorhanden/docker.sock';
process.env.SYNAPSE_KI_BROWSER_URL = 'http://127.0.0.1:9';
process.env.SYNAPSE_W1B_GATE_TTL_MS = '0';

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const { Pool } = createRequire(join(repo, 'packages/core/package.json'))('pg');
const admin = new Pool({ connectionString: db });
const schema = 'p22_t166_' + randomUUID().replaceAll('-', '');
await admin.query('CREATE SCHEMA ' + schema);
for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox', 'agent_artifacts', 'hauptagent_verlauf', 'agent_runtime_sessions', 'agent_runtime_instances', 'plans']) {
  await admin.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
}
const url = new URL(db);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = url.href;
delete process.env.SYNAPSE_DATABASE_URL;
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const AT = await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
const C = await load('packages/core/dist/index.js');
const { default: Fastify } = await import('fastify');
const pool = C.getPool();

let fails = 0;
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 700) : '')); } };
const P = 'p22-t166-' + randomUUID().slice(0, 8);
const P2 = P + '-b';
const KOORD = randomUUID(), FREMD = randomUUID(), MAIN = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const mit = (f) => f();
const inject = (o) => app.inject(o);
const bezug = { modus: 'beide', standard: 'beide', quelle: 'standard', bis: null, letzter_fehler: null };
const tool = (identity, project, args) => mit(() => C.mitAgentAufrufKontext({ principal: { art: 'identity', project, agent_id: 'koordinator', identity_id: identity,
  rolle: 'koordinator', modell: null, context_epoch: 1, lauf_id: null }, bezug }, () => AT.fuehreArtefaktAus(args, 'koordinator')));
const schalter = async (funktion, aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1", [funktion]);
  if (aktiv !== null) await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T166 Testfixture','user')", [funktion, aktiv]);
};
const bruecke = (id, payload) => inject({ method: 'POST', url: '/api/main-agent/artefakte/' + id + '/bruecke', payload });
const SKRIPT = '<div id="x">Plaene</div><script>synapse.bereit(async function(s){document.getElementById("x").textContent=JSON.stringify(await s.quelle("plan.list"))})</script>';

try {
  await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL);
  await pool.query(C.ARTEFAKT_VORLAGEN_SCHEMA_SQL);
  await pool.query("INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES($1,$2,'koordinator','koordinator','koordinator','aktiv','t166'),"
    + "($3,$4,'fremd','fremd','koordinator','aktiv','t166'),($5,'synapse-hauptagent','hauptagent','hauptagent','main','aktiv','t166')", [KOORD, P, FREMD, P2, MAIN]);
  const task = (nr, status) => ({ id: randomUUID(), kurz_id: 'P1-T' + nr, title: 'Task ' + nr, description: 'BESCHREIBUNG ' + nr, status, priority: 'medium',
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:0' + nr + ':00Z' });
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id) VALUES($1,$2,'Hauptplan','Ziel',$3::jsonb,true,'P1')", [randomUUID(), P, JSON.stringify([task(1, 'todo'), task(2, 'done')])]);
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id) VALUES($1,$2,'Fremdplan','',$3::jsonb,true,'P1')", [randomUUID(), P2, JSON.stringify([task(1, 'todo')])]);
  await schalter('artefakt_ausweis_zeigen', true);
  await schalter('artefakt_bewertung', true);
  let j = await tool(KOORD, P, { action: 'zeigen', titel: 'Skript-Artefakt', html: SKRIPT });
  check(j.success === true, 'Fixture: Skript-Artefakt per Ausweis gespeichert (Skript bleibt in PG)', j);
  const A = j.artefakt_id;
  const gespeichert = (await pool.query('SELECT html FROM agent_artifacts WHERE id=$1', [A])).rows[0]?.html ?? '';
  check(gespeichert.includes('<script>'), 'Speicherung unveraendert: <script> steht in agent_artifacts.html');
  j = await tool(KOORD, P, { action: 'zeigen', titel: 'Ohne Skript', html: '<p>statisch</p>' });
  const A_OHNE = j.artefakt_id;
  const A_MAIN = randomUUID();
  await pool.query("INSERT INTO agent_artifacts(id, session_id, title, html, created_by, created_by_identity_id, modus) VALUES($1,NULL,'Main-Skript',$2,'hauptagent',$3,'fest')", [A_MAIN, SKRIPT, MAIN]);
  const A_LEGACY = randomUUID();
  await pool.query("INSERT INTO agent_artifacts(id, session_id, title, html, created_by, modus) VALUES($1,NULL,'Ohne Urheber',$2,'irgendwer','fest')", [A_LEGACY, SKRIPT]);

  // ---------------------------------------------------------------- A
  await schalter('artefakt_skripte', null);
  let r = await inject({ method: 'GET', url: '/api/main-agent/artefakt-skripte' });
  check(r.statusCode === 200 && r.json().aktiv === false && r.json().schalter?.quelle, 'A Schalter artefakt_skripte Standard AUS', r.json());
  r = await bruecke(A, { op: 'quelle', vertrag: 'plan.list', project: P });
  check(r.statusCode === 409 && r.json().error?.code === 'schalter_aus', 'A Bruecke bei Schalter AUS: schalter_aus 409', r.json());
  await inject({ method: 'POST', url: '/api/agent-runtimes/artefakt-bewertung', payload: { quelle_art: 'artefakt', quelle_ref: A, urteil: 'hoch' } });
  await inject({ method: 'POST', url: '/api/agent-runtimes/artefakt-bewertung', payload: { quelle_art: 'artefakt', quelle_ref: A_OHNE, urteil: 'hoch' } });
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakte/top?project=' + encodeURIComponent(P) });
  check(r.json().skripte_aktiv === false && r.json().eintraege?.length === 2, 'A Top-Liste: skripte_aktiv false', r.json());

  // ---------------------------------------------------------------- B
  await schalter('artefakt_skripte', true);
  C.setzeSkriptBrueckeStatusZurueck();
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakt-skripte' });
  check(r.json().aktiv === true, 'B Schalter EIN ueber die Route sichtbar', r.json());
  r = await bruecke(A, { op: 'quelle', vertrag: 'plan.list', project: P });
  check(r.statusCode === 200 && Array.isArray(r.json().daten) && r.json().daten[0]?.kurz_id === 'P1' && r.json().daten[0]?.name === 'Hauptplan' && r.json().project === P
    && r.json().debug?.vertrag === 'plan.list' && r.json().debug?.urheber === 'ausweis', 'B quelle plan.list im eigenen Projekt', r.json());
  r = await bruecke(A, { op: 'quelle', vertrag: 'plan.alle', args: { offen: true }, project: P });
  check(r.statusCode === 200 && r.json().daten?.plaene?.[0]?.tasks?.map((t) => t.kurz_id).join(',') === 'P1-T1' && !JSON.stringify(r.json()).includes('BESCHREIBUNG'),
    'B quelle plan.alle (offen, kompakt ohne Beschreibung)', r.json());
  r = await bruecke(A, { op: 'lese', art: 'task', ref: 'P1-T1', project: P });
  check(r.statusCode === 200 && /Task 1/.test(JSON.stringify(r.json().daten)) && r.json().debug?.art === 'task', 'B lese task (Lesefenster-Klartext)', r.json());

  // ---------------------------------------------------------------- C
  r = await bruecke(A, { op: 'quelle', vertrag: 'plan.list', project: P2 });
  check(r.statusCode === 403 && r.json().error?.code === 'urheber_fremd' && /Projekt/.test(r.json().error.message), 'C Urheber-Klammer: Ausweis-Artefakt liest kein fremdes Projekt', r.json());
  r = await bruecke(A_MAIN, { op: 'quelle', vertrag: 'plan.list', project: P2 });
  check(r.statusCode === 200 && r.json().daten?.[0]?.name === 'Fremdplan' && r.json().debug?.urheber === 'main', 'C Main-Urheber (Rolle main) darf jedes Projekt', r.json());
  r = await bruecke(A_LEGACY, { op: 'quelle', vertrag: 'plan.list', project: P });
  check(r.statusCode === 403 && r.json().error?.code === 'urheber_fremd' && /unbekannt/.test(r.json().error.message), 'C Urheber unbekannt -> keine Daten', r.json());
  r = await bruecke(A_OHNE, { op: 'quelle', vertrag: 'plan.list', project: P });
  check(r.statusCode === 409 && r.json().error?.code === 'kein_skript', 'C Artefakt ohne Skript: kein_skript', r.json());
  r = await bruecke(A, { op: 'schreibe', project: P });
  check(r.statusCode === 400 && r.json().error?.code === 'op_unbekannt', 'C op schreibe: op_unbekannt (nur lesend)', r.json());
  r = await bruecke(A, { op: 'quelle', vertrag: 'sql.frei', project: P });
  check(r.statusCode === 400 && r.json().error?.code === 'quelle_unbekannt', 'C unbekannter Vertrag', r.json());
  r = await bruecke(A, { op: 'quelle', vertrag: 'plan.list', args: { project: P2 }, project: P });
  check(r.statusCode === 400 && r.json().error?.code === 'quellen_ungueltig', 'C project in args abgelehnt', r.json());
  r = await bruecke(A, { op: 'lese', art: 'doc', ref: 'x', project: P });
  check(r.statusCode === 403 && r.json().error?.code === 'art_gesperrt', 'C lese art doc gesperrt (F3)', r.json());
  r = await bruecke(A, { op: 'lese', art: 'task', ref: 'P9-T9', project: P });
  check(r.statusCode === 404 && r.json().error?.code === 'nicht_gefunden', 'C lese nicht gefunden', r.json());
  r = await bruecke(A, { op: 'lese', art: 'task', ref: 'x'.repeat(5000), project: P });
  check(r.statusCode === 413 && r.json().error?.code === 'anfrage_zu_gross', 'C Anfrage zu gross', r.json());
  r = await bruecke(A, { op: 'quelle', vertrag: 'plan.list' });
  check(r.statusCode === 400 && r.json().error?.code === 'projekt_fehlt', 'C ohne project', r.json());
  r = await bruecke(randomUUID(), { op: 'quelle', vertrag: 'plan.list', project: P });
  check(r.statusCode === 404 && r.json().error?.code === 'artefakt_unbekannt', 'C unbekanntes Artefakt', r.json());
  const fremdB = await mit(() => C.artefaktSkriptBruecke(A, { op: 'quelle', vertrag: 'plan.list', project: P2 },
    { betrachter: { art: 'agent', identity_id: KOORD, agent_id: 'koordinator', project: P, main: false } }).then(() => 'ok', (e) => e.code));
  check(fremdB === 'projekt_fremd', 'C Betrachter-Recht: Agent-Betrachter mit fremdem Projekt -> projekt_fremd', fremdB);

  // ---------------------------------------------------------------- D
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakt-skripte' });
  const st = r.json().bruecke;
  check(st?.ok === 4 && st.abgelehnt?.urheber_fremd === 2 && st.abgelehnt?.kein_skript === 1 && st.abgelehnt?.op_unbekannt === 1 && st.abgelehnt?.art_gesperrt === 1
    && st.aufrufe === 16 && st.letzte?.length === 16 && !JSON.stringify(st).includes('Hauptplan'), 'D Debug-Zaehler ok/abgelehnt je Grund, letzte ohne Daten', st);
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakt-vorlagen' });
  check(r.json().schalter?.artefakt_skripte?.aktiv === true && r.json().skript_bruecke?.ok === 4, 'D Debug-Route der Vorlagen zeigt Schalter + Bruecke', r.json().schalter);
  j = await tool(KOORD, P, { action: 'quellen' });
  check(j.schalter?.artefakt_skripte?.aktiv === true && /synapse\.quelle/.test(j.skripte) && /Top-Artefakten/.test(j.skripte) && /Skript starten/.test(j.skripte), 'D artefakt(quellen): Schalter + kurze Anleitung', j.skripte);
  check(C.PRODUKT_FUNKTIONEN ? C.PRODUKT_FUNKTIONEN.includes('artefakt_skripte') : true, 'D Funktionskatalog kennt artefakt_skripte');

  // ---------------------------------------------------------------- E
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakte/top?project=' + encodeURIComponent(P) });
  const e = r.json().eintraege ?? [];
  check(r.json().skripte_aktiv === true && e.find((x) => x.quelle.ref === A)?.hat_skript === true && e.find((x) => x.quelle.ref === A_OHNE)?.hat_skript === false,
    'E Top-Liste: hat_skript je Eintrag, skripte_aktiv', e.map((x) => ({ ref: x.quelle.ref, hat_skript: x.hat_skript })));
  check(C.enthaeltSkript('<SCRIPT>') && C.enthaeltSkript('<script type="module">') && !C.enthaeltSkript('&lt;script&gt;') && !C.enthaeltSkript(null)
    && C.urheberDarfProjekt({ art: 'main', quelle: 'session' }, 'x') && C.urheberDarfProjekt({ art: 'ausweis', identity_id: 'i', project: 'x' }, 'x')
    && !C.urheberDarfProjekt({ art: 'ausweis', identity_id: 'i', project: 'x' }, 'y') && !C.urheberDarfProjekt({ art: 'unbekannt', grund: '' }, 'x'), 'E reine Funktionen');
} catch (error) {
  fails++;
  console.log('FAIL Ausnahme ' + (error?.stack ?? error));
} finally {
  await app.close().catch(() => undefined);
  await C.closePool().catch(() => undefined);
  await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => undefined);
  await admin.end().catch(() => undefined);
}
console.log(fails ? 'FAILS ' + fails : 'PASS artefakt-skripte-p22-t166');
process.exit(fails ? 1 : 0);
