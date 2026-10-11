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
 *   P15-T32 (Spawn-Signal, Konzept thought b2293c76):
 *   S11 Spawn mit wiederverwendetem Namen, Vorsitzung noch active: OHNE Signal bleibt das Event (Kontrolle,
 *       = Handoff); mit beginneSitzung(...,'neu') ist der Broadcast weg, das direkt adressierte Event bleibt,
 *       das Fehlermuster gilt als nicht gesehen; H11 Hook == Server.
 *   S12 'fortsetzung' bei aktiver Vorsitzung: Event bleibt, aktiv_seit unveraendert, Muster frisch.
 *   S13 'fortsetzung' bei stillgelegter Vorsitzung: wie chat register (active, Alt-Event weg).
 *   S14 pruefeSitzungsArt: nur 'neu'|'fortsetzung', fehlend -> undefined, sonst Fehler.
 *   S15 REST tools/call admin index_stats mit sitzung:'neu' (inject): Antwortfeld sitzung, Alt-Event weg;
 *       ohne sitzung unveraendert (kein Feld, aktiv_seit gleich); ungueltiger Wert -> Fehler; ohne agent_id -> Hinweis.
 *   S16 stdio adminTool.handler index_stats mit sitzung:'neu': dieselbe Wirkung.
 *   S17 spawnSpecialistTool (mcp-server dist) ruft beginneSitzung(name, project, 'neu') - QUELLTEXT-ANKER,
 *       kein Laufzeittest (ein echter Spawn startet einen Wrapper-Prozess).
 * POSITIVKONTROLLE: am alten Stand (vor P15-T30) schlagen S1, S2 (Muster), S3, S4, S6, S9 fehl.
 *   Am Stand vor P15-T32 schlagen S11 (ausser Kontrolle), S12-S17 fehl.
 *   P15-T32 Folge (Onboarding erneut): S18 sitzung:'neu' -> registerAgent meldet im SELBEN Prozess wieder
 *       ersten Besuch, auch bei aktivem Ruhefenster und Eintrag unter alter Server-Kennung; 'fortsetzung' und
 *       ohne Parameter bleibt es bekannt. S19 REST: index_stats mit sitzung:'neu' traegt agentOnboarding erneut.
 *   Am Stand vor der Folge schlagen S18 (ausser Kontrollen) und S19 (dritter Aufruf) fehl.
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
const A = Object.fromEntries(['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's10a', 's10b', 's11', 's12', 's13', 's15', 's15b', 's16', 's18', 's18r', 's18f', 's18o', 's19'].map((k) => [k, 'zz-t30-' + k]));
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
    // P15-T32 Folge: Scroll leer beantworten, sonst scheitert das REST-Onboarding (Regel-Liste) still und S19 sieht nie agentOnboarding.
    if (/\/points\/scroll$/.test(u.pathname)) return res.end(JSON.stringify({ status: 'ok', time: 0, result: { points: [], next_page_offset: null } }));
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
  await pool.query('DELETE FROM tool_calls WHERE agent_id = ANY($1)', [AGENTEN]).catch(() => {});
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

  // ================= P15-T32: Spawn-Signal =================
  const hatSignal = typeof CH.beginneSitzung === 'function' && typeof CH.pruefeSitzungsArt === 'function';
  pruefe(hatSignal, 'S11 Anker: core chat.js exportiert beginneSitzung und pruefeSitzungsArt');
  const aktivAb = (z) => new Date(z.aktiv_seit ?? z.registered_at).getTime();

  // ---- S11: Spawn, wiederverwendeter Name, Vorsitzung noch active (< 4 h) ----
  await sitzung(A.s11, 'active', '2 hours');
  const e11 = await ev('s11-vorsitzung', '30 minutes');
  const e11d = await ev('s11-direkt', '30 minutes', 'agent:' + A.s11);
  await gesehen(A.s11, '10 minutes');
  await PS.registerAgent(P, A.s11, 'zz-t32-inst-' + Date.now());
  const o11vor = await offen(A.s11);
  pruefe(o11vor.includes(e11), 'S11 Kontrolle ohne Signal: Broadcast der Vorsitzung offen (heutiges Verhalten = Handoff)', o11vor);
  if (hatSignal) await CH.beginneSitzung(A.s11, P, 'neu');
  const o11 = await offen(A.s11);
  pruefe(!o11.includes(e11), "S11 sitzung 'neu': Broadcast der Vorsitzung nicht mehr offen", o11);
  pruefe(o11.includes(e11d), "S11 sitzung 'neu': direkt adressiertes Event bleibt offen", o11);
  const m11 = await muster(A.s11);
  pruefe(m11.includes(MUSTER), "S11 sitzung 'neu': Fehlermuster der Vorsitzung gilt nicht als gesehen", m11);
  const h11 = await hookGleichServer(A.s11, 'H11 Hook == Server nach Spawn-Signal');
  pruefe(!h11.includes(e11) && h11.includes(e11d), 'H11 Hook: kein Alt-Broadcast, direktes Event da', h11);
  await schlaf(5);
  const e11neu = await ev('s11-neu', '0 seconds');
  pruefe((await offen(A.s11)).includes(e11neu), 'S11 Gegenprobe: Broadcast nach dem Spawn offen');
  const z11 = await zeile(A.s11);
  pruefe(z11.status === 'active' && Date.now() - new Date(z11.registered_at).getTime() > 3600_000, 'S11 status active, registered_at bleibt erstmals', z11);

  // ---- S12: fortsetzung, Vorsitzung active ----
  await sitzung(A.s12, 'active', '2 hours');
  const e12 = await ev('s12-vorsitzung', '30 minutes');
  await gesehen(A.s12, '10 minutes');
  const z12vor = await zeile(A.s12);
  if (hatSignal) await CH.beginneSitzung(A.s12, P, 'fortsetzung');
  const z12 = await zeile(A.s12);
  const o12 = await offen(A.s12);
  pruefe(o12.includes(e12), "S12 sitzung 'fortsetzung': unquittiertes Event der Vorsitzung bleibt offen", o12);
  pruefe(aktivAb(z12) === aktivAb(z12vor), "S12 sitzung 'fortsetzung': Beginn der Lebensphase unveraendert", { vorher: z12vor, nachher: z12 });
  pruefe(z12.sitzung_seit && Date.now() - new Date(z12.sitzung_seit).getTime() < 60_000, "S12 sitzung 'fortsetzung': sitzung_seit frisch", z12.sitzung_seit);
  const m12 = await muster(A.s12);
  pruefe(m12.includes(MUSTER), "S12 sitzung 'fortsetzung': Fehlermuster im neuen Kontext frisch", m12);

  // ---- S13: fortsetzung, Vorsitzung stillgelegt ----
  await sitzung(A.s13, 'inactive', '30 days');
  const e13 = await ev('s13-alt', '10 days');
  if (hatSignal) await CH.beginneSitzung(A.s13, P, 'fortsetzung');
  const z13 = await zeile(A.s13);
  const o13 = await offen(A.s13);
  pruefe(z13.status === 'active' && !o13.includes(e13), "S13 sitzung 'fortsetzung' nach Stilllegung: active, Alt-Event weg (wie chat register)", { status: z13.status, o13 });

  // ---- S14: pruefeSitzungsArt ----
  if (hatSignal) {
    const art = (w) => { try { return CH.pruefeSitzungsArt(w); } catch (e) { return '!' + e.message; } };
    pruefe(art(undefined) === undefined && art(null) === undefined && art('') === undefined, 'S14 fehlend -> undefined', [art(undefined), art(null), art('')]);
    pruefe(art('neu') === 'neu' && art('fortsetzung') === 'fortsetzung', "S14 'neu' und 'fortsetzung' gueltig");
    const f = [art('NEU'), art('spawn'), art(42)];
    pruefe(f.every((x) => typeof x === 'string' && x.startsWith('!') && /neu/.test(x) && /fortsetzung/.test(x)), 'S14 ungueltig -> Fehler nennt die erlaubten Werte', f);
  } else pruefe(false, 'S14 pruefeSitzungsArt fehlt');

  // ---- S15: REST tools/call admin index_stats ----
  const { createRequire } = await import('node:module');
  const repo = join(hier, '..');
  const Fastify = createRequire(join(repo, 'packages', 'rest-api', 'package.json'))('fastify');
  const { mcpRoutes } = await lade(repo, 'packages', 'rest-api', 'dist', 'routes', 'mcp.js');
  const app = Fastify({ logger: false });
  await app.register(mcpRoutes);
  await app.ready();
  const rest = async (args) => {
    const res = await app.inject({ method: 'POST', url: '/', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'admin', arguments: { action: 'index_stats', project: P, ...args } } } });
    const body = res.json();
    try { return JSON.parse(body.result.content[0].text); } catch { return body; }
  };
  try {
    await sitzung(A.s15, 'active', '2 hours');
    await sitzung(A.s15b, 'active', '2 hours');
    const e15 = await ev('s15-vorsitzung', '30 minutes');
    const z15bvor = await zeile(A.s15b);
    const r15 = await rest({ agent_id: A.s15, sitzung: 'neu' });
    pruefe(r15?.sitzung?.art === 'neu' && r15?.sitzung?.aktiv_seit, "S15 REST index_stats sitzung:'neu' -> Antwortfeld sitzung", r15?.sitzung ?? r15);
    pruefe(!(await offen(A.s15)).includes(e15), "S15 REST sitzung:'neu': Broadcast der Vorsitzung nicht mehr offen");
    const r15b = await rest({ agent_id: A.s15b });
    const z15b = await zeile(A.s15b);
    pruefe(r15b && r15b.sitzung === undefined && (await offen(A.s15b)).includes(e15) && aktivAb(z15b) === aktivAb(z15bvor),
      'S15 REST ohne sitzung: unveraendert (kein Feld, Event offen, Lebensphase gleich)', { feld: r15b?.sitzung, z15b });
    const r15c = await rest({ agent_id: A.s15b, sitzung: 'spawn' });
    pruefe(JSON.stringify(r15c).includes('fortsetzung') && (await offen(A.s15b)).includes(e15), 'S15 REST ungueltiger Wert -> Fehler mit erlaubten Werten, nichts geaendert', r15c);
    const r15d = await rest({ sitzung: 'neu' });
    pruefe(r15d?.sitzung?.art === undefined && typeof r15d?.sitzung?.hinweis === 'string', 'S15 REST sitzung ohne agent_id -> Hinweis, nichts geaendert', r15d?.sitzung ?? r15d);
  } finally {
    await app.close();
  }

  // ---- S16: stdio adminTool.handler ----
  await sitzung(A.s16, 'active', '2 hours');
  const e16 = await ev('s16-vorsitzung', '30 minutes');
  const { adminTool } = await lade(repo, 'packages', 'mcp-server', 'dist', 'tools', 'consolidated', 'admin.js');
  let r16;
  try { r16 = await adminTool.handler({ action: 'index_stats', project: P, agent_id: A.s16, sitzung: 'neu' }); } catch (e) { r16 = { fehler: e.message }; }
  pruefe(r16?.sitzung?.art === 'neu', "S16 stdio index_stats sitzung:'neu' -> Antwortfeld sitzung", r16?.sitzung ?? r16);
  pruefe(!(await offen(A.s16)).includes(e16), "S16 stdio sitzung:'neu': Broadcast der Vorsitzung nicht mehr offen");

  // ---- S17: Spezialisten-Spawn (Quelltext-Anker im gebauten mcp-server) ----
  const { readFileSync } = await import('node:fs');
  const spez = readFileSync(join(repo, 'packages', 'mcp-server', 'dist', 'tools', 'specialists.js'), 'utf8');
  pruefe(/beginneSitzung\(name, project, 'neu'\)/.test(spez), "S17 spawnSpecialistTool ruft beginneSitzung(name, project, 'neu') (Quelltext-Anker, kein Laufzeittest)");

  // ---- S18: sitzung:'neu' liefert das Onboarding im selben Prozess erneut ----
  const signal = (agent, sitzungArt) => (hatSignal ? CH.wendeSitzungsSignalAn({ agentId: agent, project: P, sitzung: sitzungArt }) : undefined);
  const inst18 = 'zz-t32f-inst-' + Date.now();
  const erst18 = await PS.registerAgent(P, A.s18, inst18);
  const zweit18 = await PS.registerAgent(P, A.s18, inst18);
  pruefe(erst18 === true && zweit18 === false, 'S18 Kontrolle: erster Aufruf Onboarding, zweiter im selben Prozess nicht', { erst18, zweit18 });
  await signal(A.s18, 'neu');
  const dritt18 = await PS.registerAgent(P, A.s18, inst18);
  pruefe(dritt18 === true, "S18 sitzung 'neu': Onboarding im selben Prozess erneut (wiederverwendeter Name bekommt die Regeln)", dritt18);
  pruefe((await PS.registerAgent(P, A.s18, inst18)) === false, "S18 nach dem erneuten Onboarding wieder ruhig");
  // fortsetzung und ohne Parameter: bleibt bekannt
  await PS.registerAgent(P, A.s18f, inst18);
  await signal(A.s18f, 'fortsetzung');
  pruefe((await PS.registerAgent(P, A.s18f, inst18)) === false, "S18 sitzung 'fortsetzung': kein erneutes Onboarding");
  await PS.registerAgent(P, A.s18o, inst18);
  await signal(A.s18o, undefined);
  pruefe((await PS.registerAgent(P, A.s18o, inst18)) === false, 'S18 ohne sitzung: kein erneutes Onboarding');
  // Ruhefenster aktiv + Eintrag unter alter Server-Kennung (Lage nach einem Deploy)
  const ruheAlt18 = (await pool.query('SELECT ruhe_bis, gesetzt_von, gesetzt_am FROM onboarding_ruhe WHERE id = 1')).rows[0] ?? null;
  try {
    await pool.query(`INSERT INTO onboarding_ruhe (id, ruhe_bis, gesetzt_von) VALUES (1, NOW() + interval '10 minutes', 'test-p15-t32')
      ON CONFLICT (id) DO UPDATE SET ruhe_bis = EXCLUDED.ruhe_bis, gesetzt_von = EXCLUDED.gesetzt_von`);
    await pool.query(`INSERT INTO agent_onboardings (agent_id, project, server_instance_id) VALUES ($1, $2, 'zz-t32f-inst-alt')`, [A.s18r, P]);
    const instNeu = 'zz-t32f-inst-neu-' + Date.now();
    const kontrolle18r = await PS.registerAgent(P, A.s18r, instNeu);
    pruefe(kontrolle18r === false, 'S18 Kontrolle Ruhefenster: bekannter Agent bekommt nach Neustart kein Onboarding', kontrolle18r);
    await signal(A.s18r, 'neu');
    const neu18r = await PS.registerAgent(P, A.s18r, instNeu);
    pruefe(neu18r === true, "S18 sitzung 'neu' bei aktivem Ruhefenster: Onboarding trotzdem erneut", neu18r);
  } finally {
    if (ruheAlt18) await pool.query('UPDATE onboarding_ruhe SET ruhe_bis = $1, gesetzt_von = $2, gesetzt_am = $3 WHERE id = 1', [ruheAlt18.ruhe_bis, ruheAlt18.gesetzt_von, ruheAlt18.gesetzt_am]);
    else await pool.query('DELETE FROM onboarding_ruhe WHERE id = 1');
  }

  // ---- S19: REST Ende-zu-Ende, agentOnboarding in der index_stats-Antwort ----
  const app19 = Fastify({ logger: false });
  await app19.register(mcpRoutes);
  await app19.ready();
  const rest19 = async (args) => {
    const res = await app19.inject({ method: 'POST', url: '/', payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'admin', arguments: { action: 'index_stats', project: P, agent_id: A.s19, ...args } } } });
    try { return JSON.parse(res.json().result.content[0].text); } catch { return res.json(); }
  };
  try {
    const a19 = await rest19({});
    const b19 = await rest19({});
    pruefe(a19?.agentOnboarding?.isFirstVisit === true && b19?.agentOnboarding === undefined, 'S19 Kontrolle REST: erstes index_stats mit Onboarding, zweites ohne', { a: !!a19?.agentOnboarding, b: !!b19?.agentOnboarding });
    const c19 = await rest19({ sitzung: 'fortsetzung' });
    pruefe(c19?.agentOnboarding === undefined, "S19 REST sitzung 'fortsetzung': kein Onboarding", !!c19?.agentOnboarding);
    const d19 = await rest19({ sitzung: 'neu' });
    pruefe(d19?.agentOnboarding?.isFirstVisit === true && d19?.sitzung?.art === 'neu', "S19 REST sitzung 'neu': agentOnboarding erneut in der Antwort", { onboarding: !!d19?.agentOnboarding, sitzung: d19?.sitzung });
    const e19 = await rest19({});
    pruefe(e19?.agentOnboarding === undefined, 'S19 REST danach wieder ohne Onboarding', !!e19?.agentOnboarding);
  } finally {
    await app19.close();
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
