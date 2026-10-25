/**
 * P22-T160: Objekt-/Listen-Parameter als JSON-Text (MCP-Client mit Tool-Schema von vor dem Deploy). NUR synapse_test:5433,
 * privates Schema, gebaute Core/API-dists, kein Docker/Browser (Abbild-Schritte des Main-Wegs scheitern absichtlich laut).
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/json-text-parameter-p22-t160.test.mjs
 * A core baueJsonParameterTypen: nur type array/object (oneOf/Typliste mit string bleibt aussen vor).
 * B core koerziereJsonParameter: nur passender JSON-Text wird umgewandelt; kaputt, falscher Typ, Einzeltext, Liste bleiben.
 * C core pruefeQuellen: Liste und JSON-Text gleichwertig; kaputter Text / keine Liste -> quellen_ungueltig + 'MCP neu verbinden'.
 * D REST-Strecke handleToolCall('artefakt'): quellen als Liste und als JSON-Text -> gleiche Renderung und gleiche gespeicherte
 *   Quellen; kaputter Text -> klare Meldung; PA-1 (unbekannter Parameter) unveraendert.
 */
import { randomUUID } from 'node:crypto';
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
const C = await load('packages/core/dist/index.js');
const U = await load('packages/core/dist/services/unbekannte-parameter.js');
const AV = await load('packages/core/dist/services/artefakt-vorlagen.js');
const M = await load('packages/rest-api/dist/routes/mcp.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const basisPool = C.getPool();
const schema = 'p22_t160_' + randomUUID().replaceAll('-', '');
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
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const wirft = (f) => { try { f(); return null; } catch (error) { return error; } };
const P = 'p22-t160-' + randomUUID().slice(0, 8);
const MAIN = randomUUID();
const mit = (f) => mitLesePool(pool, f);
const schalter = async (funktion, aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion=$1", [funktion]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T160 Testfixture','user')", [funktion, aktiv]);
};
const VORLAGE = '<div>{{#each plaene as p}}<p data-plan="{{p.kurz_id}}">{{p.name}}: {{p.tasks_erledigt}}/{{p.tasks_gesamt}}</p>{{/each}}</div>';
const QUELLEN = [{ name: 'plaene', vertrag: 'plan.list' }];

try {
  // ---------------------------------------------------------------- A
  const defs = [{ name: 't', inputSchema: { properties: {
    liste: { type: 'array', items: { type: 'object' } }, obj: { type: 'object' }, text: { type: 'string' }, zahl: { type: 'number' },
    beides: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, typliste: { type: ['array', 'string'] },
  } } }, { name: 'ohne', inputSchema: { properties: { a: { type: 'string' } } } }, { name: 'leer' }];
  const typen = U.baueJsonParameterTypen(defs);
  check(gleich([...typen.get('t')], [['liste', 'array'], ['obj', 'object']]) && !typen.has('ohne') && !typen.has('leer'),
    'A Typen: nur genau array/object, oneOf/Typliste mit string aussen vor', [...typen.entries()].map(([k, v]) => [k, [...v]]));
  check(C.baueJsonParameterTypen === U.baueJsonParameterTypen && C.koerziereJsonParameter === U.koerziereJsonParameter, 'A Export aus core-Index');

  // ---------------------------------------------------------------- B
  const t = typen.get('t');
  let a = { liste: ' [{"x":1}] ', obj: '{"k":"v"}', beides: '["a"]', typliste: '["b"]', text: '[1]' };
  let k = U.koerziereJsonParameter(t, a);
  check(gleich(k, ['liste', 'obj']) && gleich(a.liste, [{ x: 1 }]) && gleich(a.obj, { k: 'v' }) && a.beides === '["a"]' && a.typliste === '["b"]' && a.text === '[1]',
    'B passender JSON-Text -> Liste/Objekt, Text-Parameter unveraendert', { k, a });
  a = { liste: '[{"x":', obj: '[1]' };
  k = U.koerziereJsonParameter(t, a);
  check(k.length === 0 && a.liste === '[{"x":' && a.obj === '[1]', 'B kaputtes JSON und falscher Typ bleiben unveraendert (Fachdienst meldet)', a);
  a = { liste: 'einzeln', obj: 'kein json' };
  k = U.koerziereJsonParameter(t, a);
  check(k.length === 0 && a.liste === 'einzeln' && a.obj === 'kein json', 'B Einzeltext bleibt (strArray-Regel der Handler)', a);
  const echt = [{ x: 2 }];
  a = { liste: echt };
  k = U.koerziereJsonParameter(t, a);
  check(k.length === 0 && a.liste === echt, 'B echte Liste unveraendert (gleiche Referenz)');
  check(U.koerziereJsonParameter(undefined, { liste: '[]' }).length === 0 && U.koerziereJsonParameter(t, undefined).length === 0, 'B ohne Typen/Args: nichts');

  // ---------------------------------------------------------------- C
  check(gleich(AV.pruefeQuellen(QUELLEN), AV.pruefeQuellen(JSON.stringify(QUELLEN))) && gleich(AV.pruefeQuellen(' ' + JSON.stringify(QUELLEN) + ' '), [{ name: 'plaene', vertrag: 'plan.list', args: {} }]),
    'C pruefeQuellen: Liste und JSON-Text gleichwertig');
  let e = wirft(() => AV.pruefeQuellen('[{"name":"plaene", vertrag:"plan.list"}]'));
  check(e?.code === 'quellen_ungueltig' && /kein gueltiges JSON/.test(e.message) && /MCP neu verbinden/.test(e.message), 'C kaputter Text -> quellen_ungueltig mit Hinweis MCP neu verbinden', e?.message);
  e = wirft(() => AV.pruefeQuellen('{"name":"plaene","vertrag":"plan.list"}'));
  check(e?.code === 'quellen_ungueltig' && /keine Liste/.test(e.message) && /MCP neu verbinden/.test(e.message), 'C JSON-Text ohne Liste -> quellen_ungueltig mit Hinweis', e?.message);
  e = wirft(() => AV.pruefeQuellen(42));
  check(e?.code === 'quellen_ungueltig' && e.message === 'quellen muss eine Liste [{name, vertrag, args?}] sein', 'C Regression: Nicht-Liste ohne Text wie bisher', e?.message);
  e = wirft(() => AV.pruefeQuellen(JSON.stringify([{ name: 'x', vertrag: 'gibt.es_nicht' }])));
  check(e?.code === 'quelle_unbekannt', 'C JSON-Text durchlaeuft dieselbe Pruefung (unbekannter Vertrag)', e?.message);

  // ---------------------------------------------------------------- D
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_artifacts', 'hauptagent_verlauf', 'agent_runtime_sessions', 'agent_runtime_instances', 'plans']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL);
  await pool.query(C.ARTEFAKT_VORLAGEN_SCHEMA_SQL);
  const tasks = JSON.stringify([{ id: randomUUID(), kurz_id: 'P1-T1', title: 'a', description: '', status: 'done', priority: 'medium' },
    { id: randomUUID(), kurz_id: 'P1-T2', title: 'b', description: '', status: 'todo', priority: 'medium' }]);
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id) VALUES($1,$2,'Fortschritt','',$3::jsonb,true,'P1')", [randomUUID(), P, tasks]);
  await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES('claude','claude','main','/mnt/z/x','img','synapse-runtime-t160',true) ON CONFLICT DO NOTHING");
  const S1 = randomUUID();
  await pool.query("INSERT INTO agent_runtime_sessions(id,agent_role,runtime,status,identity_id) VALUES($1,'main','claude','running',$2)", [S1, MAIN]);
  await schalter('artefakt_vorlagen', true);
  await schalter('artefakt_vorlagen_live', false);
  const rufe = (quellen) => mit(() => M.handleToolCall('artefakt', { action: 'zeigen', session_id: S1, vorlage: VORLAGE, quellen, project: P, titel: 'T160' }, 'hauptagent-t160'));
  const j1 = await rufe(QUELLEN);
  const j2 = await rufe(JSON.stringify(QUELLEN));
  check(j1?.success === true && j1.modus === 'stand' && j1.project === P, 'D REST artefakt: quellen als Liste', j1);
  check(j2?.success === true && j2.modus === 'stand' && j2.project === P && j2.artefakt_id !== j1.artefakt_id, 'D REST artefakt: quellen als JSON-Text (altes Client-Schema)', j2);
  const zeilen = (await pool.query('SELECT id::text AS id, html, quellen FROM agent_artifacts WHERE id = ANY($1::uuid[])', [[j1.artefakt_id, j2.artefakt_id].filter(Boolean)])).rows;
  const z1 = zeilen.find((z) => z.id === j1.artefakt_id), z2 = zeilen.find((z) => z.id === j2.artefakt_id);
  check(z1 && z2 && z1.html === z2.html && z1.html.includes('Fortschritt: 1/2') && gleich(z1.quellen, z2.quellen) && Array.isArray(z2.quellen),
    'D gleiche Renderung und gleiche gespeicherte Quellen (Liste, nicht Text)', { z1, z2 });
  const j3 = await rufe('[{"name":"plaene", vertrag:"plan.list"}]');
  check(j3?.success === false && j3.error === 'quellen_ungueltig' && /MCP neu verbinden/.test(j3.message), 'D kaputter Text -> klare Meldung mit Hinweis', j3);
  const j4 = await mit(() => M.handleToolCall('artefakt', { action: 'quellen', gibt_es_nicht: '[1]' }, 'hauptagent-t160'));
  check(j4?.success === false && j4.error === 'unbekannter_parameter', 'D PA-1 unveraendert: unbekannter Parameter abgelehnt', j4);
} catch (error) {
  fails++;
  console.log('FAIL Ausnahme ' + (error?.stack ?? error));
} finally {
  await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => undefined);
  await C.closePool().catch(() => undefined);
}
console.log(fails ? 'FAILS ' + fails : 'PASS json-text-parameter-p22-t160');
process.exit(fails ? 1 : 0);
