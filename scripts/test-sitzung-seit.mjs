/**
 * P15-T30 (11.10.2026): Sitzungsbeginn getrennt von Erstregistrierung (Konzept thought 0c9242d5).
 *
 * agent_sessions.registered_at bleibt "erstmals registriert". Neu:
 *   sitzung_seit = Beginn der laufenden Sitzung (jede Registrierung)        -> Fehlermuster-gesehen, Reaper, chat list
 *   aktiv_seit   = Beginn der laufenden Lebensphase (neu oder vorher nicht 'active') -> Events
 * Leser nehmen COALESCE(neue Spalte, registered_at): Altzeilen verhalten sich wie bisher.
 *
 * ZUSAGEN:
 *   S1 Wiederverwendeter Name (Vorsitzung inactive) + chat register: Alt-Event NICHT mehr offen, neues Event offen.
 *   S2 Handoff (Vorsitzung active) + chat register: unquittiertes Event der Vorsitzung BLEIBT offen,
 *      Fehlermuster gilt als NICHT gesehen (neue Sitzung).
 *   S3 Reaper: wieder angemeldeter Agent ohne Tool-Aufruf bleibt active (Anmeldung = Lebenszeichen).
 *   S4 Onboarding (project-status.registerAgent) eines stillgelegten Agenten: wieder active, Alt-Event weg.
 *   S5 Onboarding eines noch aktiven Agenten (neuer Serverprozess): nichts zurueckgesetzt (Event bleibt, Muster gesehen).
 *   S6 chat list/register: registeredAt = erstmals (auch bei Wiederanmeldung), sitzungSeit = jetzt.
 *   S7 Altzeile (nur registered_at): Events wie bisher ab registered_at.
 *   S8 Neuer Name: Alt-Event nicht offen.
 *   S9 Spalten: registered_at alt, sitzung_seit und aktiv_seit frisch.
 *   H1/H2/H4 Der echte Hook (scripts/event-check.mjs, gemeinsame Quelle event-sichtbarkeit.ts) liefert
 *       dieselbe Menge wie getPendingEvents (requires_ack, erste 5).
 *   S10 Onboarding-Ruhefenster (onboarding_ruhe aktiv, Agent unter anderer Server-Kennung bekannt):
 *       kein erneutes Onboarding; aktiver Agent unberuehrt (Event bleibt), stillgelegter wird active.
 *       Die Zeile onboarding_ruhe der Test-DB wird danach wiederhergestellt.
 * POSITIVKONTROLLE: am alten Stand (vor P15-T30) schlagen S1, S2 (Muster), S3, S4, S6, S9 fehl.
 * ABSICHERUNG: nur Test-DB (...:5433/synapse_test); Ollama und Qdrant sind eigene Fakes.
 *   expireIdleAgentSessions(8) wirkt auf ALLE Sessions der Test-DB (nur Status, keine Loeschung).
 * AUFRUF: set -a; . <test-db.env>; set +a; node scripts/test-sitzung-seit.mjs
 */
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}

const MODELL = 'fake-t30-embed:latest';
const MUSTER = 'f0f0f0f0-3030-4e00-8a30-0000000000a1';
const P = 'zz-sitzung-t30';
const A = Object.fromEntries(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's10a', 's10b'].map((k) => [k, 'zz-t30-' + k]));
const AGENTEN = Object.values(A);

const ollama = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: MODELL, model: MODELL, digest: 'cd'.repeat(32), size: 1000 }] }));
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [] }));
    if (req.url === '/api/show') return res.end(JSON.stringify({ model_info: { 'general.architecture': 'fake', 'fake.embedding_length': 8, 'fake.context_length': 999999 } }));
    if (req.url === '/api/embed') {
      const a = JSON.parse(body);
      const liste = Array.isArray(a.input) ? a.input : [a.input];
      return res.end(JSON.stringify({ embeddings: liste.map((t) => (/PASSEND/.test(t) ? [1, 0, 0, 0, 0, 0, 0, 0] : [0, 1, 0, 0, 0, 0, 0, 0])) }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
let ERRP = '';
const qdrant = http.createServer((req, res) => {
  let body = '';
  req.on('data', (s) => { body += s; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/') return res.end(JSON.stringify({ title: 'qdrant', version: '1.13.0' }));
    const m = /^\/collections\/([^/]+)\/points\/search$/.exec(u.pathname);
    if (m) {
      const b = JSON.parse(body || '{}');
      if (decodeURIComponent(m[1]) !== ERRP || b.vector?.[0] !== 1) return res.end(JSON.stringify({ status: 'ok', time: 0, result: [] }));
      return res.end(JSON.stringify({ status: 'ok', time: 0, result: [
        { id: MUSTER, version: 0, score: 0.8, payload: { id: MUSTER, model_scope: 'all', severity: 'error' } },
      ] }));
    }
    res.end(JSON.stringify({ status: 'ok', time: 0, result: {} }));
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
await new Promise((r) => qdrant.listen(0, '127.0.0.1', r));

process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
process.env.OLLAMA_MODEL = MODELL;
process.env.QDRANT_URL = `http://127.0.0.1:${qdrant.address().port}`;
process.env.EMBED_MIN_GAP_MS = '0';
process.env.SCORE_SCHWELLE_ERROR_PATTERNS = '0.5';
for (const name of ['EMBEDDING_TARGET_DIM', 'EMBEDDING_PRAEFIXE', 'SYNAPSE_OLLAMA_MODEL_DIGEST', 'SYNAPSE_COMPUTE_NODE',
  'FEHLERMUSTER_UNBEKANNT_SIEHT_ALLE', 'FEHLERMUSTER_GESEHEN_STUNDEN', 'SYNAPSE_SESSION_IDLE_HOURS']) delete process.env[name];
process.env.EMBEDDING_QUERY_PREFIX = '';
process.env.EMBEDDING_DOC_PREFIX = '';
// Kein Ruhefenster: sonst haengt S4/S5 am Prozessstart anderer Tests.
process.env.SYNAPSE_ONBOARDING_RUHE_MIN = '0';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = join(hier, '..', 'packages', 'core', 'dist');
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const { getConfig } = await lade(dist, 'config.js');
if (/192\.168\.50\.65/.test(getConfig().embeddings.ollama.url + getConfig().qdrant.url)) {
  console.error('ABBRUCH: Ollama/Qdrant zeigen auf Produktion.');
  process.exit(2);
}
const CH = await lade(dist, 'services', 'chat.js');
const PS = await lade(dist, 'services', 'project-status.js');
const EV = await lade(dist, 'services', 'events.js');
const EP = await lade(dist, 'services', 'error-patterns.js');
const db = await lade(dist, 'db', 'client.js');
const { COLLECTIONS } = await lade(dist, 'types', 'index.js');
ERRP = COLLECTIONS.globalErrorPatterns;
const pool = db.getPool();

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail !== undefined ? '\n        ' + JSON.stringify(detail).slice(0, 800) : '')); }
}
async function sitzung(id, status, registriert) {
  await pool.query(`INSERT INTO agent_sessions (id, project, status, registered_at) VALUES ($1, $2, $3, NOW() - $4::interval)`, [id, P, status, registriert]);
}
async function ev(name, alter, scope = 'all') {
  const r = await pool.query(
    `INSERT INTO agent_events (project, event_type, priority, scope, source_id, payload, requires_ack, created_at)
     VALUES ($1, 'ANNOUNCEMENT', 'normal', $2, 'test-p15-t30', $3, true, NOW() - $4::interval) RETURNING id`,
    [P, scope, 'TESTEVENT P15-T30 ' + name, alter]);
  return Number(r.rows[0].id);
}
const offen = async (agent) => (await EV.getPendingEvents(P, agent, 100)).map((e) => Number(e.id));
async function gesehen(agent, alter) {
  await pool.query(`INSERT INTO error_pattern_seen (pattern_id, session_id, shown_at) VALUES ($1, $2, NOW() - $3::interval)`, [MUSTER, agent, alter]);
}
const muster = async (agent) => (await EP.checkErrorPatterns('PASSEND code', agent)).map((w) => w.id);
const zeile = async (agent) => (await pool.query('SELECT * FROM agent_sessions WHERE id = $1', [agent])).rows[0];
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));
// Echter PostToolUse-Hook (laedt dist/services/event-sichtbarkeit.js): dieselbe Menge wie der Server
// (nur requires_ack, die ersten 5 in Server-Reihenfolge).
const hook = (agent) => JSON.parse(execFileSync('node', [join(hier, 'event-check.mjs'), agent, P, DB_URL], { encoding: 'utf8' })).map((e) => Number(e.id));
async function hookGleichServer(agent, text) {
  const h = hook(agent);
  const s = (await EV.getPendingEvents(P, agent, 100)).filter((e) => e.requiresAck).map((e) => Number(e.id)).slice(0, 5);
  pruefe(JSON.stringify(h) === JSON.stringify(s), text, { hook: h, server: s });
  return h;
}

async function aufraeumen() {
  await pool.query('DELETE FROM agent_events WHERE project = $1', [P]);
  await pool.query('DELETE FROM error_pattern_seen WHERE session_id = ANY($1)', [AGENTEN]);
  await pool.query('DELETE FROM error_patterns WHERE id = $1::uuid', [MUSTER]);
  await pool.query('DELETE FROM agent_onboardings WHERE agent_id = ANY($1)', [AGENTEN]);
  await pool.query('DELETE FROM agent_sessions WHERE id = ANY($1)', [AGENTEN]);
}

try {
  await aufraeumen();
  await pool.query(`INSERT INTO error_patterns (id, description, fix, severity, model_scope, found_by, found_in_model)
    VALUES ($1, 'ZZ-TEST T30', 'ZZ-TEST fix T30', 'error', 'all', 'zz', 'opus')`, [MUSTER]);

  // ---- S1: wiederverwendeter Name, Vorsitzung stillgelegt ----
  await sitzung(A.s1, 'inactive', '30 days');
  await gesehen(A.s1, '1 hour');
  const e1alt = await ev('s1-alt', '10 days');
  const s1vorher = await zeile(A.s1);
  await schlaf(5);
  await CH.registerAgent(A.s1, P);
  const e1neu = await ev('s1-neu', '0 seconds');
  const o1 = await offen(A.s1);
  pruefe(!o1.includes(e1alt), 'S1 wiederverwendeter Name (vorher inactive): Alt-Event nicht mehr offen', o1);
  pruefe(o1.includes(e1neu), 'S1 Gegenprobe: Event nach der Anmeldung offen', o1);
  const h1 = await hookGleichServer(A.s1, 'H1 Hook == Server nach Wiederanmeldung (vorher inactive)');
  pruefe(!h1.includes(e1alt) && h1.includes(e1neu), 'H1 Hook zeigt kein Alt-Event, aber das neue', h1);
  const m1 = await muster(A.s1);
  pruefe(m1.includes(MUSTER), 'S1 Fehlermuster der Vorsitzung gilt nicht als gesehen', m1);

  // ---- S9: Spalten ----
  const z1 = await zeile(A.s1);
  pruefe(new Date(z1.registered_at).getTime() === new Date(s1vorher.registered_at).getTime(), 'S9 registered_at bleibt erstmals', z1.registered_at);
  const frisch = (t) => t && Date.now() - new Date(t).getTime() < 60_000;
  pruefe(frisch(z1.sitzung_seit) && frisch(z1.aktiv_seit), 'S9 sitzung_seit und aktiv_seit frisch', { sitzung_seit: z1.sitzung_seit, aktiv_seit: z1.aktiv_seit });

  // ---- S2: Handoff, Vorsitzung noch aktiv ----
  await sitzung(A.s2, 'active', '2 hours');
  const e2 = await ev('s2-vorsitzung', '30 minutes');
  await gesehen(A.s2, '10 minutes');
  const m2vorher = await muster(A.s2);
  pruefe(!m2vorher.includes(MUSTER), 'S2 Anker: vor der Wiederanmeldung gilt das Muster als gesehen', m2vorher);
  await CH.registerAgent(A.s2, P);
  const o2 = await offen(A.s2);
  pruefe(o2.includes(e2), 'S2 Handoff: unquittiertes Event der Vorsitzung bleibt offen', o2);
  const h2 = await hookGleichServer(A.s2, 'H2 Hook == Server nach Handoff');
  pruefe(h2.includes(e2), 'H2 Hook zeigt das unquittierte Event der Vorsitzung', h2);
  const m2 = await muster(A.s2);
  pruefe(m2.includes(MUSTER), 'S2 Handoff: neue Sitzung sieht das Muster wieder', m2);

  // ---- S3: Reaper ----
  await sitzung(A.s3, 'inactive', '10 hours');
  await CH.registerAgent(A.s3, P);
  await CH.expireIdleAgentSessions(8);
  const z3 = await zeile(A.s3);
  pruefe(z3.status === 'active', 'S3 Reaper: wieder angemeldeter Agent ohne Tool-Aufruf bleibt active', z3.status);

  // ---- S4: Onboarding eines stillgelegten Agenten ----
  await sitzung(A.s4, 'inactive', '30 days');
  const e4alt = await ev('s4-alt', '10 days');
  const neu4 = await PS.registerAgent(P, A.s4, 'zz-t30-inst-a-' + Date.now());
  const z4 = await zeile(A.s4);
  pruefe(neu4 === true, 'S4 Anker: Onboarding meldet ersten Besuch', neu4);
  pruefe(z4.status === 'active', 'S4 Onboarding holt stillgelegten Agenten zurueck (active)', z4.status);
  const o4 = await offen(A.s4);
  pruefe(!o4.includes(e4alt), 'S4 Onboarding nach Stilllegung: Alt-Event nicht mehr offen', o4);
  await hookGleichServer(A.s4, 'H4 Hook == Server nach Onboarding eines stillgelegten Agenten');

  // ---- S5: Onboarding eines aktiven Agenten (neuer Serverprozess) ----
  await sitzung(A.s5, 'active', '2 hours');
  const e5 = await ev('s5-laufend', '30 minutes');
  await gesehen(A.s5, '10 minutes');
  const z5vorher = await zeile(A.s5);
  await PS.registerAgent(P, A.s5, 'zz-t30-inst-b-' + Date.now());
  const z5 = await zeile(A.s5);
  const o5 = await offen(A.s5);
  pruefe(o5.includes(e5), 'S5 aktiver Agent, neuer Serverprozess: Event bleibt offen', o5);
  const m5 = await muster(A.s5);
  pruefe(!m5.includes(MUSTER), 'S5 aktiver Agent: Muster bleibt gesehen (keine neue Sitzung)', m5);
  pruefe(String(z5.sitzung_seit) === String(z5vorher.sitzung_seit) && String(z5.aktiv_seit) === String(z5vorher.aktiv_seit),
    'S5 sitzung_seit/aktiv_seit unveraendert', { vorher: [z5vorher.sitzung_seit, z5vorher.aktiv_seit], nachher: [z5.sitzung_seit, z5.aktiv_seit] });

  // ---- S6: chat register/list ----
  const r6a = await CH.registerAgent(A.s6, P);
  await schlaf(30);
  const r6b = await CH.registerAgent(A.s6, P);
  const z6 = await zeile(A.s6);
  pruefe(new Date(r6b.registeredAt).getTime() === new Date(z6.registered_at).getTime(), 'S6 register liefert echtes registeredAt (erstmals) bei Wiederanmeldung', { r6a: r6a.registeredAt, r6b: r6b.registeredAt, db: z6.registered_at });
  pruefe(r6b.sitzungSeit && new Date(r6b.sitzungSeit).getTime() > new Date(r6b.registeredAt).getTime(), 'S6 register liefert sitzungSeit der neuen Sitzung', r6b);
  const liste = await CH.listActiveAgents(P);
  const l6 = liste.find((a) => a.id === A.s6);
  pruefe(l6 && l6.sitzungSeit && new Date(l6.registeredAt).getTime() === new Date(z6.registered_at).getTime(), 'S6 list: registeredAt erstmals + sitzungSeit', l6);
  pruefe(liste[0]?.id === A.s6, 'S6 list sortiert nach Sitzungsbeginn (neueste zuerst)', liste.map((a) => a.id));

  // ---- S7: Altzeile nur mit registered_at ----
  await sitzung(A.s7, 'active', '1 hour');
  const e7a = await ev('s7-davor', '2 hours');
  const e7b = await ev('s7-danach', '30 minutes');
  const o7 = await offen(A.s7);
  pruefe(!o7.includes(e7a) && o7.includes(e7b), 'S7 Altzeile: Events ab registered_at wie bisher', o7);

  // ---- S8: neuer Name ----
  const e8 = await ev('s8-alt', '1 day');
  await CH.registerAgent(A.s8, P);
  const o8 = await offen(A.s8);
  pruefe(!o8.includes(e8), 'S8 neuer Name: Alt-Event nicht offen', o8);

  // ---- S10: Onboarding-Ruhefenster ----
  const ruheAlt = (await pool.query('SELECT ruhe_bis, gesetzt_von, gesetzt_am FROM onboarding_ruhe WHERE id = 1')).rows[0] ?? null;
  const ruheVorher = process.env.SYNAPSE_ONBOARDING_RUHE_MIN;
  try {
    delete process.env.SYNAPSE_ONBOARDING_RUHE_MIN;
    await pool.query(`INSERT INTO onboarding_ruhe (id, ruhe_bis, gesetzt_von) VALUES (1, NOW() + interval '10 minutes', 'test-p15-t30')
      ON CONFLICT (id) DO UPDATE SET ruhe_bis = EXCLUDED.ruhe_bis, gesetzt_von = EXCLUDED.gesetzt_von`);
    for (const a of [A.s10a, A.s10b]) {
      await pool.query(`INSERT INTO agent_onboardings (agent_id, project, server_instance_id) VALUES ($1, $2, 'zz-t30-inst-alt')`, [a, P]);
    }
    await sitzung(A.s10a, 'active', '2 hours');
    await sitzung(A.s10b, 'inactive', '30 days');
    const e10 = await ev('s10-laufend', '30 minutes');
    const e10alt = await ev('s10-alt', '10 days');
    const z10vorher = await zeile(A.s10a);
    const inst = 'zz-t30-inst-c-' + Date.now();
    const neu10a = await PS.registerAgent(P, A.s10a, inst);
    const neu10b = await PS.registerAgent(P, A.s10b, inst);
    pruefe(neu10a === false && neu10b === false, 'S10 Ruhefenster: kein erneutes Onboarding', { neu10a, neu10b });
    const z10a = await zeile(A.s10a);
    pruefe(String(z10a.sitzung_seit) === String(z10vorher.sitzung_seit) && String(z10a.aktiv_seit) === String(z10vorher.aktiv_seit),
      'S10 Ruhefenster: aktiver Agent unberuehrt', { vorher: z10vorher, nachher: z10a });
    const o10a = await offen(A.s10a);
    pruefe(o10a.includes(e10), 'S10 Ruhefenster: Event des aktiven Agenten bleibt offen', o10a);
    const z10b = await zeile(A.s10b);
    pruefe(z10b.status === 'active', 'S10 Ruhefenster: stillgelegter Agent wird trotzdem active', z10b.status);
    const o10b = await offen(A.s10b);
    pruefe(!o10b.includes(e10alt), 'S10 Ruhefenster: stillgelegter Agent bekommt kein Alt-Event', o10b);
  } finally {
    if (ruheAlt) await pool.query('UPDATE onboarding_ruhe SET ruhe_bis = $1, gesetzt_von = $2, gesetzt_am = $3 WHERE id = 1', [ruheAlt.ruhe_bis, ruheAlt.gesetzt_von, ruheAlt.gesetzt_am]);
    else await pool.query('DELETE FROM onboarding_ruhe WHERE id = 1');
    if (ruheVorher !== undefined) process.env.SYNAPSE_ONBOARDING_RUHE_MIN = ruheVorher;
  }
} catch (err) {
  fehler++;
  console.log('FEHLER  Ausnahme: ' + (err?.stack ?? err));
} finally {
  await aufraeumen();
  const rest = (await pool.query('SELECT count(*)::int AS n FROM agent_sessions WHERE id = ANY($1)', [AGENTEN])).rows[0].n;
  pruefe(rest === 0, 'Z Testdaten entfernt', rest);
  await pool.end();
  ollama.close();
  qdrant.close();
}
console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
