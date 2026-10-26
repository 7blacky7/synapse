/**
 * P10-T88 N2: Aehnlichkeitspruefung beim Speichern (thought add/add_batch, memory write, proposal create, plan add_task/add_tasks_batch).
 * Sichert ab (Task P10-T88, User 26.10.2026 ~02:15 "User-Idee einmal semantisch automatisch durchsuchen", Bestandsaufnahme thought 3f904578):
 *   A Katalog: Produkt-Schalter speicher_aehnlichkeit/_pruefen nur ausdruecklich (core agent-profil-schalter.ts), intern-Override
 *     (intern-schalter.ts), Score-Zweck speicher_aehnlich (embeddings/modell-profil.ts), Schema 162 (db/speicher-aehnlichkeit-schema.ts).
 *   B Schalter AUS = Altverhalten: keine Suche, keine Zusatzfelder (services/speicher-aehnlichkeit.ts mitSpeicherAehnlichkeit).
 *   C Treffer aus thoughts+memories+tasks mit art/id/score/vorschau und aehnlich_debug; GEGENPROBE ohne Treffer (Pflicht).
 *   D User-Idee (Tags user-idee/user-entscheidung/user-grundsatz): aehnlich_ergaenzen; Modus pruefen_vor_anlegen (Schalter
 *     speicher_aehnlichkeit_pruefen): ohne bestaetigt NICHT angelegt, mit bestaetigt angelegt; Gegenprobe ohne Treffer angelegt;
 *     Eintrag ohne User-Tag trotz Treffer angelegt.
 *   E thought add_batch je Eintrag, memory write mit gleichem Namen zaehlt nicht, plan add_task/add_tasks_batch haengt an das
 *     vorhandene aehnlich (P22-T50) an, proposal create.
 *   F Schwelle: eigener Zweck, Rueckfall tasks, ohne Kalibrierung Hinweis und trotzdem angelegt.
 *   G Einstellwerte (Tabelle speicher_aehnlichkeit_einstellungen): Standard, setzen, Grenzen, null = Standard; max_treffer und
 *     zeitlimit_ms wirken.
 *   H intern-Override (SYNAPSE_INTERN_TOOL=1): EIN wirkt bei Produkt AUS, abgelaufen -> Produkt-Standard.
 *   J N1 Pins (core task-pins.ts ergaenzeTaskPins, plan-suche.ts pinsFuerTasks; Schalter task_pins): plan(get, task_id) ueber REST
 *     (mcp.ts) und stdio (consolidated/plan.ts) nennt thoughts/dateiversionen + juengste IDs; gebundene Tasks (Schluessel task_id,
 *     agent-profil-update.ts baueFortsetzungsErgaenzung); GEGENPROBE Schalter AUS = keine pins, kein pins_debug.
 *   I Beide Strecken echt: REST (rest-api routes/mcp.ts handleAuthentifiziertenToolCall) und stdio (mcp-server server.ts):
 *     thought add mit Treffer + Gegenprobe, Eintrag in PG; tools/list bietet bestaetigt fuer thought/memory/proposal.
 * Testdatenbank: privates Schema in synapse_test (Kopie der public-Tabellen); HTTP-Double fuer Ollama/Qdrant mit Vektor je
 * Stichwort (ALPHA aehnlich zueinander, OMEGA zu nichts). Kein KI-Browser, kein Daemon.
 * Aufruf (Repo-Root, nach Build von core, rest-api, mcp-server):
 *   DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/core/tests/speicher-aehnlichkeit-p10-t88.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pruefeTestDbUrl} from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('P10-T88');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.pathname, '/synapse_test', 'P10-T88: nur gegen synapse_test');
const schema = 'p10t88_' + randomUUID().replaceAll('-', '');
const project = 'p10-t88-' + randomUUID().slice(0, 8);
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const repo = new URL('../../../', import.meta.url);
const load = p => import(new URL(p, repo).href);

// Herkunft je Pruefung (Regel regel-tests-mit-herkunft-kommentieren): Label = Task + Einheit + Quelldatei; bei Fehlschlag Debugzeile.
const ok = (cond, label, detail) => {
  if (!cond) console.error('DEBUG ' + label + ' | tatsaechlich: ' + JSON.stringify(detail ?? null).slice(0, 800));
  assert.ok(cond, label);
  console.log('PASS ' + label);
};

// --- HTTP-Double Ollama + Qdrant -------------------------------------------------------------------------------
const points = new Map(), requests = [];
let suchVerzoegerung = 0;
// ZETA: zweites unverwandtes Thema, damit die stdio-Gegenprobe nicht die (korrekt gespeicherte) REST-Gegenprobe findet.
const vektor = t => /ALPHA/.test(t) ? [0, 1, 0, 0] : /OMEGA/.test(t) ? [0, 0, 1, 0] : /ZETA/.test(t) ? [1, 0, 0, 0] : [0, 0, 0, 1];
const passt = (p, f) => {
  if (!f) return true;
  const klausel = c => c.has_id ? c.has_id.map(String).includes(String(p.id))
    : c.key ? (c.match?.any ? c.match.any.includes(c.key.split('.').reduce((v, k) => v?.[k], p.payload))
      : c.key.split('.').reduce((v, k) => v?.[k], p.payload) === c.match?.value) : passt(p, c);
  return (f.must ?? []).every(klausel) && !(f.must_not ?? []).some(klausel) && (!(f.should ?? []).length || f.should.some(klausel));
};
const server = http.createServer((req, res) => {
  let raw = ''; req.on('data', d => raw += d); req.on('end', async () => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname, body = raw ? JSON.parse(raw) : {};
      requests.push({path, body});
      const reply = result => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({result, status: 'ok', time: 0})); };
      if (path === '/') return res.end(JSON.stringify({title: 'test', version: '1.15.0'}));
      if (path === '/api/tags') return res.end(JSON.stringify({models: [{name: 'p10-t88-fake', digest: 'b'.repeat(64)}]}));
      if (path === '/api/embed') {
        const texts = Array.isArray(body.input) ? body.input : [body.input];
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({embeddings: texts.map(vektor)}));
      }
      if (path === '/collections') return reply({collections: [...points.keys()].map(name => ({name}))});
      const col = decodeURIComponent(path.split('/')[2] ?? '');
      if (!points.has(col)) points.set(col, new Map());
      const data = points.get(col);
      if (path.endsWith('/points/search')) {
        if (suchVerzoegerung) await new Promise(r => setTimeout(r, suchVerzoegerung));
        const hits = [...data.values()].filter(p => passt(p, body.filter))
          .map(p => ({id: p.id, payload: p.payload, score: p.vector.reduce((n, v, i) => n + v * (body.vector[i] ?? 0), 0), version: 0}))
          .sort((a, b) => b.score - a.score);
        return reply(hits.slice(body.offset ?? 0, (body.offset ?? 0) + body.limit));
      }
      if (path.endsWith('/points/delete')) {
        for (const [id, p] of data) if (body.points?.map(String).includes(String(id)) || (body.filter && passt(p, body.filter))) data.delete(id);
        return reply({status: 'completed', operation_id: 1});
      }
      if (req.method === 'PUT' && path.endsWith('/points')) { for (const p of body.points) data.set(String(p.id), p); return reply({status: 'completed', operation_id: 1}); }
      if (path.endsWith('/points/count')) return reply({count: data.size});
      if (path.endsWith('/points/scroll')) return reply({points: [...data.values()], next_page_offset: null});
      if (path.endsWith('/points')) return reply([...data.values()].filter(p => body.ids?.map(String).includes(String(p.id))));
      return reply({config: {params: {vectors: {size: 4, distance: 'Cosine'}}}, points_count: data.size});
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({error: String(e)})); }
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const fake = 'http://127.0.0.1:' + server.address().port;
Object.assign(process.env, {
  DATABASE_URL: url.toString(), SYNAPSE_DATABASE_URL: url.toString(), SYNAPSE_SCHEMA: 'aus',
  EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: fake, OLLAMA_MODEL: 'p10-t88-fake', QDRANT_URL: fake, SKILL_QDRANT_URL: fake,
  EMBEDDING_TARGET_DIM: '4', EMBEDDING_PRAEFIXE: 'aus', EMBED_MIN_GAP_MS: '0', EMBEDDING_MAX_INPUT_CHARS: '100000',
  SYNAPSE_OLLAMA_MODEL_DIGEST: 'b'.repeat(64), SCORE_SCHWELLE_SPEICHER_AEHNLICH: '0.8', JEV_OPENROUTER_API_KEY: '',
  SYNAPSE_COMPUTE_ADMISSION: '0', SYNAPSE_INTERN_TOOL: '1',
});
delete process.env.SCORE_SCHWELLE_TASKS;
const unpack = r => { let x = r?.structuredContent ?? r; while (x?.content?.[0]?.text) x = JSON.parse(x.content[0].text); return x; };
// Nur Suchen in den Projekt-Collections (thoughts/memories/tasks) zaehlen; Skill-Hooks suchen nebenbei in der skills-Collection.
const suchen = () => requests.filter(r => r.path.endsWith('/points/search') && r.path.includes(project)).length;

let app, client, pool, db;
try {
  const core = await load('packages/core/dist/index.js');
  db = await load('packages/core/dist/db/client.js'); pool = db.getPool();
  await pool.query('CREATE SCHEMA "' + schema + '"');
  for (const {tablename} of (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows) {
    const q = '"' + tablename.replaceAll('"', '""') + '"';
    await pool.query('CREATE TABLE "' + schema + '".' + q + ' (LIKE public.' + q + ' INCLUDING ALL)');
  }
  await pool.query('ALTER TABLE chat_lesestand ADD COLUMN IF NOT EXISTS letzte_hinweis_id INTEGER NOT NULL DEFAULT 0');
  await pool.query((await load('packages/core/dist/db/plan-task-schema.js')).PLAN_TASK_SCHEMA_SQL);
  await pool.query(core.SPEICHER_AEHNLICHKEIT_SCHEMA_SQL);
  // P3-T16 (Schema 163, plans.wiederkehrend) liest plans.ts schon; die public-Kopie von synapse_test hat die Spalten evtl. noch nicht.
  try { await pool.query((await load('packages/core/dist/db/plan-wiederkehr-schema.js')).PLAN_WIEDERKEHR_SCHEMA_SQL); } catch (e) { console.log('HINWEIS P10-T88 Fixture: Schema 163 nicht nachgezogen: ' + String(e).slice(0, 120)); }
  const S = await load('packages/core/dist/services/speicher-aehnlichkeit.js');
  const P = await load('packages/core/dist/services/plans.js'), PS = await load('packages/core/dist/services/plan-suche.js');
  const T = await load('packages/core/dist/services/thoughts.js'), M = await load('packages/core/dist/services/memory.js');
  const I = await load('packages/core/dist/services/intern-schalter.js');
  P.planIndex.sync = async () => {};
  await I.setzeSchalter('embedding', {aktiv: false, agent: 'p10t88-fixture'});
  const schalter = (funktion, aktiv) => core.setzeProfilProduktSchalter({ebene: 'projekt', project, funktion, aktiv, grund: 'P10-T88 Testlauf'}, {system: 'user'});

  // A Katalog -------------------------------------------------------------------------------------------------
  ok(['speicher_aehnlichkeit', 'speicher_aehnlichkeit_pruefen'].every(f => core.PROFIL_PRODUKT_FUNKTIONEN.includes(f) && core.NUR_AUSDRUECKLICH.includes(f)),
    'P10-T88 A agent-profil-schalter.ts PROFIL_PRODUKT_FUNKTIONEN/NUR_AUSDRUECKLICH: beide Schalter, nur ausdruecklich');
  ok(I.INTERN_SCHALTER.speicher_aehnlichkeit?.[0] === 'freigegeben' && I.INTERN_SCHALTER.speicher_aehnlichkeit_pruefen?.[0] === 'freigegeben',
    'P10-T88 A intern-schalter.ts INTERN_SCHALTER: Test-Override freigegeben fuer beide');
  const MP = await load('packages/core/dist/embeddings/modell-profil.js');
  ok(typeof MP.SCORE_ZWECKE.speicher_aehnlich === 'string', 'P10-T88 A modell-profil.ts SCORE_ZWECKE: Zweck speicher_aehnlich kalibrierbar');
  const stand0 = await S.leseSpeicherAehnlichkeitStand(project);
  ok(stand0.aktiv === false && stand0.schalter.quelle === 'standard' && stand0.pruefen.aktiv === false,
    'P10-T88 A speicher-aehnlichkeit.ts leseSpeicherAehnlichkeitStand: Standard AUS (beide), Quelle standard', stand0);

  // Bestand: je ein ALPHA-Thought, -Memory, -Task (Vektoren synchron nachgezogen).
  const thoughtA = await T.addThought(project, 'p10t88-seed', 'ALPHA Idee: Speichern prueft vorher semantisch', ['user-idee']);
  await T.embeddeThoughtNach(project, thoughtA.id, {priority: 'interactive'});
  const memA = await M.writeMemory(project, 'p10t88-alpha-memory', 'ALPHA Wissen zur Aehnlichkeitspruefung', 'note', []);
  await M.embeddeMemoryNach(project, memA.id, {priority: 'interactive'});
  const plan = await P.createPlan(project, 'P10-T88 Testplan', 'Plan ohne Stichwort', []);
  const taskA = await P.addTask(project, 'ALPHA Aufgabe', 'ALPHA Aehnlichkeit beim Speichern', 'medium', plan.id);
  await PS.taskIndex.sync(await P.getPlan(project, plan.id));
  ok(points.size > 0 && [...points.values()].some(c => c.has(thoughtA.id)) && [...points.values()].some(c => c.has(memA.id)),
    'P10-T88 Fixture thoughts.ts/memory.ts embedde*Nach: Bestand im Vektorindex', [...points.keys()]);

  let runs = 0;
  const run = (antwort = {success: true, id: 'neu'}) => async () => { runs++; return antwort; };
  const thoughtArgs = (content, extra = {}) => ({action: 'add', project, source: 'p10t88-agent', content, ...extra});

  // B Schalter AUS = Altverhalten -----------------------------------------------------------------------------
  let vorher = suchen();
  let r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA bei Schalter AUS'), run());
  ok(runs === 1 && !('aehnlich' in r) && !('aehnlich_debug' in r) && suchen() === vorher,
    'P10-T88 B speicher-aehnlichkeit.ts mitSpeicherAehnlichkeit: Schalter AUS = Altverhalten (keine Suche, keine Felder)', r);
  r = await S.mitSpeicherAehnlichkeit('thought', {action: 'search', project, query: 'ALPHA'}, run({success: true, results: []}));
  ok(!('aehnlich_debug' in r), 'P10-T88 B speicher-aehnlichkeit.ts speicherZiel: Lesen ist kein Speicherweg', r);

  // C Treffer + Gegenprobe ------------------------------------------------------------------------------------
  await schalter('speicher_aehnlichkeit', true);
  runs = 0;
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA neue Notiz zum Speichern'), run());
  const arten = new Set((r.aehnlich ?? []).map(t => t.art));
  ok(runs === 1 && arten.has('thought') && arten.has('memory') && arten.has('task'),
    'P10-T88 C speicher-aehnlichkeit.ts sucheAehnliche: Treffer aus thoughts, memories und tasks', r);
  const th = r.aehnlich.find(t => t.art === 'thought'), me = r.aehnlich.find(t => t.art === 'memory'), ta = r.aehnlich.find(t => t.art === 'task');
  ok(th.id === thoughtA.id && me.id === 'p10t88-alpha-memory' && ta.id === taskA.kurz_id && ta.status === 'todo',
    'P10-T88 C speicher-aehnlichkeit.ts: IDs = Thought-UUID, Memory-Name, Task-Kurz-ID (+Status)', r.aehnlich);
  ok(r.aehnlich.every(t => typeof t.score === 'number' && t.score >= 0.8 && typeof t.vorschau === 'string' && t.vorschau.length > 0),
    'P10-T88 C speicher-aehnlichkeit.ts: je Treffer Score (>= Schwelle) und Vorschau', r.aehnlich);
  ok(/produkt-schalter\/projekt/.test(r.aehnlich_debug) && /schwelle 0\.8 \(env:SCORE_SCHWELLE_SPEICHER_AEHNLICH\)/.test(r.aehnlich_debug) && /3 Treffer/.test(r.aehnlich_debug),
    'P10-T88 C speicher-aehnlichkeit.ts aehnlich_debug: Schalterquelle, Schwelle mit Quelle, Trefferzahl', r.aehnlich_debug);
  ok(!('aehnlich_ergaenzen' in r), 'P10-T88 C speicher-aehnlichkeit.ts: ohne User-Tag kein aehnlich_ergaenzen', r);
  // GEGENPROBE (Pflicht): anderes Thema -> keine Treffer, kein aehnlich, angelegt.
  runs = 0;
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('OMEGA voellig anderes Thema'), run());
  ok(runs === 1 && !('aehnlich' in r) && /0 Treffer/.test(r.aehnlich_debug) && /angelegt/.test(r.aehnlich_debug),
    'P10-T88 C GEGENPROBE speicher-aehnlichkeit.ts: ohne Treffer kein aehnlich, angelegt', r);

  // D User-Idee + pruefen_vor_anlegen -------------------------------------------------------------------------
  runs = 0;
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA Idee nochmal vom User', {tags: ['user-idee']}), run());
  ok(runs === 1 && r.aehnlich_ergaenzen?.length === 1 && /ergaenzen statt neu/.test(r.aehnlich_ergaenzen[0]) && /pruefen aus/.test(r.aehnlich_debug),
    'P10-T88 D speicher-aehnlichkeit.ts ergaenzenText: User-Idee mit Treffer -> Hinweis ergaenzen, angelegt (pruefen AUS)', r);
  await schalter('speicher_aehnlichkeit_pruefen', true);
  runs = 0;
  r = await S.mitSpeicherAehnlichkeit('memory', {action: 'write', project, name: 'p10t88-neu', content: 'ALPHA User-Entscheidung', tags: ['user-entscheidung']}, run());
  ok(runs === 0 && r.success === false && r.angelegt === false && r.error === 'aehnliche_eintraege_vorhanden' && r.aehnlich.length > 0 && /nicht angelegt/.test(r.aehnlich_debug),
    'P10-T88 D speicher-aehnlichkeit.ts pruefen_vor_anlegen: User-Idee mit Treffern ohne bestaetigt NICHT angelegt', r);
  r = await S.mitSpeicherAehnlichkeit('memory', {action: 'write', project, name: 'p10t88-neu', content: 'ALPHA User-Entscheidung', tags: ['user-entscheidung'], bestaetigt: true}, run());
  ok(runs === 1 && r.success === true && /angelegt \(bestaetigt\)/.test(r.aehnlich_debug) && r.aehnlich_ergaenzen?.length === 1,
    'P10-T88 D speicher-aehnlichkeit.ts pruefen_vor_anlegen: mit bestaetigt:true angelegt, Hinweis bleibt', r);
  runs = 0;
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('OMEGA neue User-Idee', {tags: ['user-grundsatz']}), run());
  ok(runs === 1 && !('aehnlich' in r) && !('aehnlich_ergaenzen' in r),
    'P10-T88 D GEGENPROBE speicher-aehnlichkeit.ts pruefen_vor_anlegen: User-Idee ohne Treffer wird angelegt', r);
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA Befund ohne User-Tag'), run());
  ok(runs === 2 && r.aehnlich?.length > 0 && !('aehnlich_ergaenzen' in r),
    'P10-T88 D speicher-aehnlichkeit.ts pruefen_vor_anlegen: Eintrag ohne User-Tag trotz Treffer angelegt (nur Liste)', r);
  await schalter('speicher_aehnlichkeit_pruefen', false);

  // E Batch, memory-Name, plan, proposal ----------------------------------------------------------------------
  r = await S.mitSpeicherAehnlichkeit('thought', {action: 'add_batch', project, source: 'p10t88-agent', items: [{content: 'ALPHA eins'}, {content: 'OMEGA zwei'}]},
    run({success: true, count: 2}));
  ok(r.aehnlich?.length === 1 && r.aehnlich[0].eintrag === 0 && r.aehnlich[0].treffer.length > 0 && /2 Eintrag/.test(r.aehnlich_debug),
    'P10-T88 E speicher-aehnlichkeit.ts thought add_batch: aehnlich je Eintrag (nur Eintrag 0 hat Treffer)', r);
  r = await S.mitSpeicherAehnlichkeit('memory', {action: 'write', project, name: 'p10t88-alpha-memory', content: 'ALPHA Wissen ueberarbeitet'}, run());
  ok(!(r.aehnlich ?? []).some(t => t.art === 'memory' && t.id === 'p10t88-alpha-memory') && r.aehnlich?.length > 0,
    'P10-T88 E speicher-aehnlichkeit.ts sucheAehnliche: memory write mit gleichem Namen findet sich nicht selbst', r.aehnlich);
  const altAehnlich = [{task: 'P1-T9', status: 'todo', titel: 'Vorhandene Dublette', score: 0.9}];
  r = await S.mitSpeicherAehnlichkeit('plan', {action: 'add_task', project, title: 'ALPHA neue Task', description: 'x'},
    run({success: true, task: {id: 't'}, aehnlich: altAehnlich}));
  ok(r.aehnlich.length > 1 && JSON.stringify(r.aehnlich[0]) === JSON.stringify(altAehnlich[0]) && r.aehnlich.slice(1).every(t => ['thought', 'memory'].includes(t.art)),
    'P10-T88 E speicher-aehnlichkeit.ts planAehnlich: add_task haengt Wissen an vorhandenes aehnlich (P22-T50) an, keine Tasks doppelt', r.aehnlich);
  r = await S.mitSpeicherAehnlichkeit('plan', {action: 'add_tasks_batch', project, tasks: [{title: 'ALPHA a', description: 'x'}, {title: 'OMEGA b', description: 'y'}]},
    run({success: true, tasks: [{id: 'a', kurz_id: 'P1-T20'}, {id: 'b', kurz_id: 'P1-T21'}], aehnlich: [{task: 'P1-T20', treffer: [altAehnlich[0]]}]}));
  const t20 = r.aehnlich.find(a => a.task === 'P1-T20');
  ok(r.aehnlich.length === 1 && t20.treffer.length > 1 && t20.treffer[0] === altAehnlich[0] || (t20 && JSON.stringify(t20.treffer[0]) === JSON.stringify(altAehnlich[0]) && t20.treffer.length > 1 && r.aehnlich.length === 1),
    'P10-T88 E speicher-aehnlichkeit.ts planAehnlich: add_tasks_batch je Task-Kurz-ID ergaenzt, Task ohne Treffer bleibt aussen vor', r.aehnlich);
  r = await S.mitSpeicherAehnlichkeit('proposal', {action: 'create', project, file_path: 'x.ts', description: 'ALPHA Vorschlag', suggested_content: 'c', author: 'a'}, run());
  ok(r.aehnlich?.length > 0, 'P10-T88 E speicher-aehnlichkeit.ts speicherZiel: proposal create wird geprueft', r);
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA Fehlerfall'), run({success: false, message: 'kaputt'}));
  ok(r.success === false && !('aehnlich' in r) && /Speichern fehlgeschlagen/.test(r.aehnlich_debug),
    'P10-T88 E speicher-aehnlichkeit.ts: fehlgeschlagenes Speichern bekommt nur die Debugzeile', r);

  // F Schwelle ------------------------------------------------------------------------------------------------
  delete process.env.SCORE_SCHWELLE_SPEICHER_AEHNLICH; process.env.SCORE_SCHWELLE_TASKS = '0.8';
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA Rueckfall'), run());
  ok(r.aehnlich?.length > 0 && /rueckfall_tasks:env:SCORE_SCHWELLE_TASKS/.test(r.aehnlich_debug),
    'P10-T88 F speicher-aehnlichkeit.ts speicherAehnlichkeitSchwelle: Rueckfall auf Zweck tasks mit Quelle', r.aehnlich_debug);
  delete process.env.SCORE_SCHWELLE_TASKS;
  runs = 0;
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA ohne Schwelle'), run());
  ok(runs === 1 && !('aehnlich' in r) && /ohne Schwelle/.test(r.aehnlich_hinweis ?? ''),
    'P10-T88 F speicher-aehnlichkeit.ts: ohne Kalibrierung Hinweis, Speichern nicht blockiert', r);
  process.env.SCORE_SCHWELLE_SPEICHER_AEHNLICH = '0.8';

  // G Einstellwerte -------------------------------------------------------------------------------------------
  let e = await S.leseSpeicherAehnlichkeitEinstellungen();
  ok(e.werte.max_treffer === 5 && e.werte.vorschau_zeichen === 160 && e.werte.zeitlimit_ms === 3000 && e.einstellungen.max_treffer.quelle === 'standard',
    'P10-T88 G speicher-aehnlichkeit.ts leseSpeicherAehnlichkeitEinstellungen: Code-Standard mit Quelle', e);
  await assert.rejects(S.setzeSpeicherAehnlichkeitEinstellungen({max_treffer: 99}, 'P10-T88 Grenze', 'user'), /wert_ungueltig/);
  await assert.rejects(S.setzeSpeicherAehnlichkeitEinstellungen({max_treffer: 2}, 'kz', 'user'), /grund_fehlt/);
  console.log('PASS P10-T88 G speicher-aehnlichkeit.ts setzeSpeicherAehnlichkeitEinstellungen: Grenze und Grund geprueft');
  e = await S.setzeSpeicherAehnlichkeitEinstellungen({max_treffer: 1}, 'P10-T88 Test max_treffer', 'user');
  ok(e.werte.max_treffer === 1 && e.einstellungen.max_treffer.quelle === 'einstellung', 'P10-T88 G speicher-aehnlichkeit.ts: Einstellung gesetzt (Quelle einstellung)', e);
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA nur ein Treffer'), run());
  ok(r.aehnlich?.length === 1, 'P10-T88 G speicher-aehnlichkeit.ts: max_treffer wirkt', r.aehnlich);
  await S.setzeSpeicherAehnlichkeitEinstellungen({max_treffer: null, zeitlimit_ms: 200}, 'P10-T88 Test zeitlimit', 'user');
  suchVerzoegerung = 600; runs = 0;
  r = await S.mitSpeicherAehnlichkeit('thought', thoughtArgs('ALPHA zu langsam'), run());
  suchVerzoegerung = 0;
  ok(runs === 1 && /abgebrochen/.test(r.aehnlich_hinweis ?? '') && !('aehnlich' in r),
    'P10-T88 G speicher-aehnlichkeit.ts mitZeitlimit: Zeitlimit -> gespeichert ohne Pruefung, Hinweis', r);
  e = await S.setzeSpeicherAehnlichkeitEinstellungen({zeitlimit_ms: null}, 'P10-T88 zurueck auf Standard', 'user');
  ok(e.werte.zeitlimit_ms === 3000 && e.werte.max_treffer === 5 && e.einstellungen.zeitlimit_ms.quelle === 'standard',
    'P10-T88 G speicher-aehnlichkeit.ts: null = zurueck auf Code-Standard', e);
  await new Promise(r2 => setTimeout(r2, 700));

  // H intern-Override -----------------------------------------------------------------------------------------
  await schalter('speicher_aehnlichkeit', false);
  await I.setzeSchalter('speicher_aehnlichkeit', {aktiv: true, modus: 'freigegeben', dauer_min: 5, agent: 'p10t88', grund: 'P10-T88 Test intern-Override'});
  let st = await S.leseSpeicherAehnlichkeitSchalter('speicher_aehnlichkeit', project);
  ok(st.aktiv === true && st.quelle === 'intern' && st.bis, 'P10-T88 H speicher-aehnlichkeit.ts leseSpeicherAehnlichkeitSchalter: intern-Override EIN bei Produkt AUS', st);
  await pool.query("UPDATE intern_schalter SET bis = NOW() - interval '1 minute' WHERE name = 'speicher_aehnlichkeit'");
  st = await S.leseSpeicherAehnlichkeitSchalter('speicher_aehnlichkeit', project);
  ok(st.aktiv === false && st.quelle === 'produkt-schalter', 'P10-T88 H speicher-aehnlichkeit.ts: abgelaufener Override -> Produkt-Schalter gilt', st);

  // I Beide Strecken echt -------------------------------------------------------------------------------------
  await schalter('speicher_aehnlichkeit', true);
  const req = createRequire(new URL('packages/rest-api/package.json', repo)); app = req('fastify')({logger: false});
  await app.register((await load('packages/rest-api/dist/routes/mcp.js')).mcpRoutes); await app.ready();
  const {Client} = await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const {StdioClientTransport} = await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
  client = new Client({name: 'p10t88-test', version: '1'});
  const env = {...process.env}; delete env.SYNAPSE_AGENT_NAME;
  const prelude = 'const P=await import(' + JSON.stringify(new URL('packages/core/dist/services/plans.js', repo).href) + ');P.planIndex.sync=async()=>{};' +
    'const {createServer}=await import(' + JSON.stringify(new URL('packages/mcp-server/dist/server.js', repo).href) + ');' +
    'const {StdioServerTransport}=await import(' + JSON.stringify(new URL('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js', repo).href) + ');await createServer().connect(new StdioServerTransport());';
  const transport = new StdioClientTransport({command: process.execPath, args: ['--input-type=module', '--eval', prelude], env, stderr: 'pipe'});
  transport.stderr?.resume(); await client.connect(transport);
  for (const mode of ['rest', 'stdio']) {
    const call = async (name, args) => {
      const input = {name, arguments: {project, agent_id: 'p10t88-agent', ...args}};
      if (mode === 'stdio') return unpack(await client.callTool(input));
      const answer = (await app.inject({method: 'POST', url: '/', payload: {jsonrpc: '2.0', id: 1, method: 'tools/call', params: input}})).json();
      assert.ok(!answer.error, JSON.stringify(answer)); return unpack(answer.result);
    };
    const listed = mode === 'stdio' ? await client.listTools() : (await app.inject({method: 'POST', url: '/', payload: {jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}}})).json().result;
    ok(['thought', 'memory', 'proposal'].every(n => listed.tools.find(t => t.name === n)?.inputSchema?.properties?.bestaetigt?.type === 'boolean'),
      'P10-T88 I ' + mode + ' tools/list (mcp.ts MCP_TOOLS bzw. consolidated/*.ts): Parameter bestaetigt fuer thought/memory/proposal');
    const treffer = await call('thought', {action: 'add', source: 'p10t88-agent', content: 'ALPHA ueber ' + mode});
    const neueId = treffer.id ?? treffer.thought?.id;
    ok(treffer.aehnlich?.some(t => t.id === thoughtA.id) && /speicher_aehnlichkeit an/.test(treffer.aehnlich_debug ?? ''),
      'P10-T88 I ' + mode + ' thought add (' + (mode === 'rest' ? 'mcp.ts handleAuthentifiziertenToolCall' : 'server.ts') + '): aehnlich mit Bestands-Thought', treffer);
    ok(neueId && (await pool.query('SELECT 1 FROM thoughts WHERE id=$1', [neueId])).rowCount === 1,
      'P10-T88 I ' + mode + ' thought add: Eintrag trotz Hinweis in PG angelegt', {neueId});
    const gegen = await call('thought', {action: 'add', source: 'p10t88-agent', content: (mode === 'rest' ? 'OMEGA' : 'ZETA') + ' Gegenprobe ueber ' + mode});
    ok(!('aehnlich' in gegen) && /0 Treffer/.test(gegen.aehnlich_debug ?? ''),
      'P10-T88 I GEGENPROBE ' + mode + ' thought add: ohne Treffer kein aehnlich', gegen);
    const gesperrt = await call('thought', {action: 'add', source: 'p10t88-agent', content: 'ALPHA User-Idee ueber ' + mode, tags: ['user-idee']});
    ok(gesperrt.aehnlich_ergaenzen?.length === 1, 'P10-T88 I ' + mode + ' thought add mit Tag user-idee: aehnlich_ergaenzen', gesperrt);
  }

  // J N1 Pins ------------------------------------------------------------------------------------------------
  // Warum: Befund P10-T81 Nachtrag d0080771 - der Nachfolger sah vorhandene Arbeit an der Task nicht (nur plan(search) zaehlte).
  const pinThought = await T.addThought(project, 'p10t88-vorgaenger', 'OMEGA Checkpoint des Vorgaengers', ['checkpoint'], taskA.kurz_id);
  const planGet = async (mode, extra = {}) => {
    const input = {name: 'plan', arguments: {project, agent_id: 'p10t88-agent', action: 'get', task_id: taskA.kurz_id, ...extra}};
    if (mode === 'stdio') return unpack(await client.callTool(input));
    return unpack((await app.inject({method: 'POST', url: '/', payload: {jsonrpc: '2.0', id: 9, method: 'tools/call', params: input}})).json().result);
  };
  for (const mode of ['rest', 'stdio']) {
    const aus = await planGet(mode);
    ok(aus.tasks?.length === 1 && !('pins' in aus.tasks[0]) && !('pins_debug' in aus),
      'P10-T88 J GEGENPROBE ' + mode + ' plan(get, task_id): Schalter task_pins AUS = keine pins (Altverhalten)', aus.tasks);
  }
  await schalter('task_pins', true);
  for (const mode of ['rest', 'stdio']) {
    const an = await planGet(mode);
    const p = an.tasks?.[0]?.pins;
    ok(p && p.thoughts >= 1 && p.thought_ids?.includes(pinThought.id) && typeof p.dateiversionen === 'number' && /task_pins an \(produkt-schalter\/projekt\)/.test(an.pins_debug ?? ''),
      'P10-T88 J ' + mode + ' plan(get, task_id) (' + (mode === 'rest' ? 'mcp.ts' : 'consolidated/plan.ts') + ' -> task-pins.ts ergaenzeTaskPins): pins mit juengster Thought-ID + pins_debug', an.tasks?.[0]);
    const ohneId = await planGet(mode, {task_id: undefined});
    ok(!('pins_debug' in ohneId), 'P10-T88 J ' + mode + ' plan(get) ohne task_id: keine Pins (nur gezielte Task)', Object.keys(ohneId));
  }
  const TP = await load('packages/core/dist/services/task-pins.js');
  const geb = await TP.ergaenzeTaskPins(project, [{task_id: taskA.id, kurz_id: taskA.kurz_id, titel: 'x', status: 'todo', art: 'identitaet'}], 'task_id');
  ok(geb?.tasks[0]?.pins?.thought_ids?.includes(pinThought.id), 'P10-T88 J task-pins.ts ergaenzeTaskPins Schluessel task_id (gebundene Tasks bei chat(anmelden)): pins vorhanden', geb);
  await schalter('task_pins', false);
  ok(await TP.ergaenzeTaskPins(project, [{task_id: taskA.id}], 'task_id') === null, 'P10-T88 J GEGENPROBE task-pins.ts: Schalter AUS -> null (Aufrufer unveraendert)');

  // B' Schalter wieder AUS -> Altverhalten auch ueber REST.
  await schalter('speicher_aehnlichkeit', false);
  vorher = suchen();
  const aus = unpack((await app.inject({method: 'POST', url: '/', payload: {jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: {name: 'thought', arguments: {project, agent_id: 'p10t88-agent', action: 'add', source: 'p10t88-agent', content: 'ALPHA nach dem Ausschalten'}}}})).json().result);
  ok(!('aehnlich' in aus) && !('aehnlich_debug' in aus) && suchen() === vorher,
    'P10-T88 B rest mcp.ts: Schalter wieder AUS = Altverhalten', aus);
  console.log('PASS P10-T88 gesamt: Schalter, Treffer/Gegenprobe, User-Idee, pruefen_vor_anlegen, Batch/Plan/Proposal, Schwelle, Einstellwerte, intern, REST+stdio');
} finally {
  await client?.close(); await app?.close();
  if (pool) await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
  await db?.closePool(); server.closeAllConnections(); await new Promise(r => server.close(r));
}
