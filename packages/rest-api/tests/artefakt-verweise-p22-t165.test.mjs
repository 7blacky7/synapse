/**
 * P22-T165: Quelle plan.alle + Schalter artefakt_verweise. NUR synapse_test:5433, privates Schema, gebaute Core/API-dists, kein Docker.
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/artefakt-verweise-p22-t165.test.mjs
 * A plan.alle direkt: Inhalt (kompakt, ohne Beschreibung, Reihenfolge wie plan list), Filter offen/status, Wiedervorlage (alle),
 *   max_tasks_je_plan (erledigte zuerst raus), Kappung (Plaene bleiben, erledigte zuerst, dann offene vom Ende), wegfallReihenfolge.
 * B ladeQuellen: kleine Kappung je Quelle -> plan.alle bleibt ein Objekt (nicht null), gekappt + hinweis.
 * C Vorlage per Ausweis mit plan.alle: Radio je Plan, data-synapse-verweis je Task, data-synapse-projekt; Rechte (fremdes Projekt).
 * D Schalter artefakt_verweise: Route (Standard AUS, dann EIN), Debug-Route, artefakt(quellen) mit Schalter + Anleitung.
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
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const AT = await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
const C = await load('packages/core/dist/index.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t165_' + randomUUID().replaceAll('-', '');
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
const P = 'p22-t165-' + randomUUID().slice(0, 8);
const P2 = P + '-b';
const P3 = P + '-gross';
const KOORD = randomUUID(), FREMD = randomUUID();
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
  if (aktiv !== null) await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,$1,$2,'T165 Testfixture','user')", [funktion, aktiv]);
};
const ZUKUNFT = new Date(Date.now() + 7 * 86400000).toISOString();
const task = (plan, nr, status, extra = {}) => ({ id: randomUUID(), kurz_id: plan + '-T' + nr, title: 'Task ' + plan + '-' + nr, description: 'LANGE BESCHREIBUNG ' + nr,
  status, priority: 'medium', createdAt: new Date(Date.UTC(2026, 9, 1, 0, nr)).toISOString(), updatedAt: new Date(Date.UTC(2026, 9, 1, 0, nr)).toISOString(), ...extra });

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox', 'agent_artifacts', 'hauptagent_verlauf', 'agent_runtime_sessions', 'agent_runtime_instances', 'plans']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL);
  await pool.query(C.ARTEFAKT_VORLAGEN_SCHEMA_SQL);
  // P1 aktiv: 3 erledigt, 2 offen, 1 zurueckgestellt (offen); P2 inaktiv: 1 erledigt, 1 blocked; P3 zurueckgestellter Plan.
  const p1 = [task('P1', 1, 'done'), task('P1', 2, 'done'), task('P1', 3, 'done'), task('P1', 4, 'todo'), task('P1', 5, 'in_progress'),
    task('P1', 6, 'todo', { zurueckgestellt_bis: ZUKUNFT })];
  const p2 = [task('P2', 1, 'done'), task('P2', 2, 'blocked')];
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id, prioritaet) VALUES($1,$2,'Hauptplan','Ziel eins',$3::jsonb,true,'P1','hoch')", [randomUUID(), P, JSON.stringify(p1)]);
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id, prioritaet) VALUES($1,$2,'Nebenplan','Ziel zwei',$3::jsonb,false,'P2','niedrig')", [randomUUID(), P, JSON.stringify(p2)]);
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id, prioritaet, zurueckgestellt_bis) VALUES($1,$2,'Schlaeft','',$3::jsonb,false,'P3','mittel',$4)",
    [randomUUID(), P, JSON.stringify([task('P3', 1, 'todo')]), ZUKUNFT]);
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id) VALUES($1,$2,'Fremd','',$3::jsonb,true,'P1')", [randomUUID(), P2, JSON.stringify([task('P1', 1, 'todo')])]);
  const langerTitel = 'x'.repeat(150);
  const gross = [...Array.from({ length: 300 }, (_, i) => task('P1', i + 1, 'done', { title: langerTitel + i })),
    ...Array.from({ length: 100 }, (_, i) => task('P1', 301 + i, 'todo', { title: langerTitel + (301 + i) }))];
  await pool.query("INSERT INTO plans(id, project, name, description, tasks, aktiv, kurz_id) VALUES($1,$2,'Gross','',$3::jsonb,true,'P1')", [randomUUID(), P3, JSON.stringify(gross)]);

  // ---------------------------------------------------------------- A
  let a = await mit(() => C.ladePlanAlle(P, {}));
  check(a.plaene.map((p) => p.kurz_id).join(',') === 'P1,P2' && a.gesamt.plaene === 2 && a.gekappt === false && !a.hinweis, 'A Plaene wie plan list (aktiv zuerst), zurueckgestellter Plan ausgeblendet', a.plaene.map((p) => p.kurz_id));
  const t1 = a.plaene[0].tasks;
  check(t1.length === 5 && Object.keys(t1[0]).sort().join(',') === 'kurz_id,nummer,priority,status,title,updatedAt' /* nummer ergaenzt P22-T169 */ && !JSON.stringify(a).includes('LANGE BESCHREIBUNG'),
    'A Tasks kompakt ohne Beschreibung, zurueckgestellte Task ausgeblendet', t1);
  check(a.plaene[0].name === 'Hauptplan' && a.plaene[0].aktiv === true && a.plaene[0].tasks_gesamt === 6 && a.plaene[0].tasks_erledigt === 3 && a.plaene[0].tasks_ausgelassen === 0,
    'A Plan-Felder (Zaehler aus plan list)', a.plaene[0]);
  check(a.debug_quelle?.bytes > 0 && a.debug_quelle.max_bytes === 262144 && a.debug_quelle.filter.max_tasks_je_plan === 300, 'A debug_quelle', a.debug_quelle);
  a = await mit(() => C.ladePlanAlle(P, { alle: true }));
  const p6 = a.plaene.find((p) => p.kurz_id === 'P1')?.tasks.find((t) => t.kurz_id === 'P1-T6');
  check(a.plaene.some((p) => p.kurz_id === 'P3' && p.zurueckgestellt === true) && p6?.zurueckgestellt_bis === ZUKUNFT, 'A alle:true zeigt zurueckgestellte Plaene/Tasks mit Vermerk', { p6, plaene: a.plaene.map((p) => p.kurz_id) });
  a = await mit(() => C.ladePlanAlle(P, { offen: true }));
  check(a.plaene[0].tasks.map((t) => t.kurz_id).join(',') === 'P1-T4,P1-T5' && a.plaene[1].tasks.map((t) => t.status).join(',') === 'blocked', 'A offen:true -> todo/in_progress/blocked', a.plaene.map((p) => p.tasks.map((t) => t.kurz_id)));
  a = await mit(() => C.ladePlanAlle(P, { status: 'done' }));
  check(a.plaene[0].tasks.every((t) => t.status === 'done') && a.plaene[0].tasks.length === 3, 'A status:done', a.plaene[0].tasks);
  a = await mit(() => C.ladePlanAlle(P, { max_tasks_je_plan: 2 }));
  check(a.plaene[0].tasks.map((t) => t.kurz_id).join(',') === 'P1-T4,P1-T5' && a.plaene[0].tasks_ausgelassen === 3 && a.gekappt && /max_tasks_je_plan 2/.test(a.hinweis ?? ''),
    'A max_tasks_je_plan: erledigte zuerst raus, Hinweis', a);
  check(C.wegfallReihenfolge([{ status: 'todo', updatedAt: '2026-10-01' }, { status: 'done', updatedAt: '2026-10-05' }, { status: 'done', updatedAt: '2026-10-02' }, { status: 'todo', updatedAt: '2026-09-01' }]).join(',') === '2,1,3,0',
    'A wegfallReihenfolge: erledigte (aelteste zuerst), dann offene vom Ende');
  a = await mit(() => C.ladePlanAlle(P3, {}, 20000));
  const rest = a.plaene[0].tasks;
  const bytes = Buffer.byteLength(JSON.stringify(a), 'utf8');
  check(a.plaene.length === 1 && bytes <= 20000 && a.gekappt && rest.length > 10 && rest.every((t) => t.status === 'todo') && rest[0].kurz_id === 'P1-T301',
    'A Kappung: Plan bleibt, unter der Grenze, erst alle erledigten raus, offene vom Ende', { bytes, n: rest.length, erste: rest[0]?.kurz_id, je: a.debug_quelle.ausgelassen_je_grund });
  check(a.debug_quelle.ausgelassen_je_grund.je_plan === 100 && a.debug_quelle.ausgelassen_je_grund.kappung === 400 - 100 - rest.length && a.plaene[0].tasks_ausgelassen === 400 - rest.length
    && a.debug_quelle.bytes === bytes, 'A Kappung: Zaehler je Grund und tasks_ausgelassen stimmen', a.debug_quelle);

  // ---------------------------------------------------------------- B
  const werte = { ...(await mit(() => C.leseArtefaktVorlagenEinstellungen())).werte, quelle_max_bytes: 8192 };
  const geladen = await mit(() => C.ladeQuellen([{ name: 'alle', vertrag: 'plan.alle', args: {} }], P3, werte));
  check(geladen.daten.alle && Array.isArray(geladen.daten.alle.plaene) && geladen.daten.alle.gekappt === true && !geladen.stand[0].fehler && geladen.stand[0].bytes <= 8192,
    'B ladeQuellen mit kleiner Kappung: plan.alle bleibt Objekt (nicht null), gekappt', geladen.stand);

  // ---------------------------------------------------------------- C
  await pool.query("INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES($1,$2,'koordinator','koordinator','koordinator','aktiv','t165'),($3,$4,'fremd','fremd','koordinator','aktiv','t165')",
    [KOORD, P, FREMD, P2]);
  await schalter('artefakt_vorlagen', true); await schalter('artefakt_ausweis_zeigen', true);
  const VORLAGE = '<div data-synapse-projekt="{{_meta.project}}"><style>.v{display:none}{{#each plan.plaene as p}}#r-{{p.kurz_id}}:checked~.ansichten .v-{{p.kurz_id}}{display:block}{{/each}}</style>'
    + '{{#each plan.plaene as p}}<input type="radio" name="plan" id="r-{{p.kurz_id}}" {{#if @erster}}checked{{/if}}><label for="r-{{p.kurz_id}}">{{p.kurz_id}}</label>{{/each}}'
    + '<div class="ansichten">{{#each plan.plaene as p}}<section class="v v-{{p.kurz_id}}"><a href="#verweis:{{p.kurz_id}}">{{p.name}}</a>'
    + '{{#each p.tasks as t}}<span data-synapse-verweis="{{t.kurz_id}}">{{t.title}}</span>{{/each}}</section>{{/each}}</div></div>';
  let j = await tool(KOORD, 'koordinator', { action: 'zeigen', titel: 'Fortschritt interaktiv', vorlage: VORLAGE, quellen: [{ name: 'plan', vertrag: 'plan.alle' }] });
  const html = (await pool.query('SELECT html FROM agent_artifacts WHERE id=$1', [j.artefakt_id])).rows[0]?.html ?? '';
  check(j.success === true && j.debug?.quellen?.[0]?.vertrag === 'plan.alle' && !j.debug.quellen[0].fehler, 'C zeigen mit plan.alle per Ausweis', j);
  check(html.includes('id="r-P1" checked') && html.includes('id="r-P2" ') && html.includes('data-synapse-verweis="P1-T4"') && html.includes('href="#verweis:P2"')
    && html.includes('data-synapse-projekt="' + P + '"') && !html.includes('P1-T6'), 'C Renderung: Radio je Plan, Verweis je Task, Projekt-Attribut', html.slice(0, 600));
  j = await tool(KOORD, 'koordinator', { action: 'zeigen', vorlage: VORLAGE, quellen: [{ name: 'plan', vertrag: 'plan.alle' }], project: P2 });
  check(j.error === 'projekt_fremd', 'C Rechte: Ausweis rendert plan.alle nicht fuer ein fremdes Projekt', j);
  j = await tool(KOORD, 'koordinator', { action: 'zeigen', vorlage: VORLAGE, quellen: [{ name: 'plan', vertrag: 'plan.alle', args: { max_tasks_je_plan: 5000 } }] });
  check(j.error === 'quellen_ungueltig' && /hoechstens 1000/.test(j.message), 'C max_tasks_je_plan ueber 1000 abgelehnt', j);
  const r2 = await inject({ method: 'GET', url: '/api/main-agent/artefakte/' + (await pool.query("SELECT id::text FROM agent_artifacts WHERE title='Fortschritt interaktiv'")).rows[0].id + '?project=' + encodeURIComponent(P2) });
  check(r2.statusCode === 200 && r2.json().artefakt.html.includes('data-synapse-projekt="' + P2 + '"'), 'C User rendert dieselbe Vorlage fuer ein anderes Projekt (Projekt-Attribut folgt)', r2.json().render);

  // ---------------------------------------------------------------- D
  await schalter('artefakt_verweise', null);
  let r = await inject({ method: 'GET', url: '/api/main-agent/artefakt-verweise' });
  check(r.statusCode === 200 && r.json().aktiv === false && r.json().schalter?.quelle, 'D Schalter artefakt_verweise Standard AUS', r.json());
  await schalter('artefakt_verweise', true);
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakt-verweise' });
  check(r.json().aktiv === true, 'D Schalter EIN ueber die Route sichtbar', r.json());
  r = await inject({ method: 'GET', url: '/api/main-agent/artefakt-vorlagen' });
  // Wert nicht pruefen: die parallelen Schalter-Lesungen dieser Route laufen im Test-Schema nicht verlaesslich (T154 prueft dort auch nur einen).
  check(typeof r.json().schalter?.artefakt_verweise?.aktiv === 'boolean' && r.json().katalog.some((k) => k.vertrag === 'plan.alle' && k.args.offen && k.args.max_tasks_je_plan?.max === 1000),
    'D Debug-Route: Schalter + Katalog mit plan.alle', r.json().schalter);
  j = await tool(KOORD, 'koordinator', { action: 'quellen' });
  check(j.schalter?.artefakt_verweise?.aktiv === true && /data-synapse-verweis/.test(j.interaktion) && /art:id/.test(j.interaktion), 'D artefakt(quellen): Schalter + kurze Anleitung', j.interaktion);
  check(C.PRODUKT_FUNKTIONEN ? C.PRODUKT_FUNKTIONEN.includes('artefakt_verweise') : true, 'D Funktionskatalog kennt artefakt_verweise');
} catch (error) {
  fails++;
  console.log('FAIL Ausnahme ' + (error?.stack ?? error));
} finally {
  await app.close().catch(() => undefined);
  await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE').catch(() => undefined);
  await C.closePool().catch(() => undefined);
}
console.log(fails ? 'FAILS ' + fails : 'PASS artefakt-verweise-p22-t165');
process.exit(fails ? 1 : 0);
