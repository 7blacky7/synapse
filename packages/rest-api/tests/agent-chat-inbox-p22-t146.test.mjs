/**
 * P22-T146: GET /api/agent-runtimes/agent-chat/inbox inkrementell (additiv): ab_id (nur juengere, aufsteigend), vor_id (die limit
 * davor), mehr. NUR synapse_test:5433, gebaute Core/API-dists, privates Testschema (wie agent-chat-inbox-p22-t137).
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agent-chat-inbox-p22-t146.test.mjs
 * A ohne Parameter wie bisher (+ mehr, modus letzte); B ab_id; C vor_id; D ab_id gewinnt, ungueltige ids = letzte; E Schalter AUS.
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

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const C = await load('packages/core/dist/index.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t146_' + randomUUID().replaceAll('-', '');
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
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info) : '')); } };
const P = 'p22-t146-' + randomUUID().slice(0, 8);
const KOORD = randomUUID(), REA = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const inject = (request) => mitLesePool(pool, () => app.inject(request));
const inbox = async (q) => (await inject({ method: 'GET', url: '/api/agent-runtimes/agent-chat/inbox?identity_id=' + KOORD + q })).json();
const setzen = async (aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1 AND funktion='plattform_agent_chat'", [P]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'plattform_agent_chat',$2,'T146 Testfixture','user')", [P, aktiv]);
};
const zeile = async (von, an, text, o = {}) => (await pool.query(
  `INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [von, an, text, P, o.von_id ?? null, o.an_id ?? null, new Date(Date.UTC(2026, 9, 25, 10, o.min ?? 0)).toISOString()])).rows[0].id;
const idsVon = (j) => j.nachrichten.map((n) => n.id);
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(
    `INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES
      ($1,$3,'koordinator','koordinator','koordinator','aktiv','p22-t146-test'), ($2,$3,'rea4','rea4','subagent','aktiv','p22-t146-test')`, [KOORD, REA, P]);
  const n = [];
  for (let i = 0; i < 5; i++) {
    n.push(Number(await zeile(i % 2 ? 'koordinator' : 'user', i % 2 ? 'user' : 'koordinator', 'N' + i, i % 2 ? { von_id: KOORD, min: i } : { an_id: KOORD, min: i })));
    if (i === 2) await zeile('user', 'rea4', 'fremd dazwischen', { an_id: REA, min: i });
  }

  // E Schalter AUS zuerst (Standard)
  let j = await inbox('&ab_id=' + n[0]);
  check(j.aktiv === false && j.nachrichten.length === 0 && j.mehr === false, 'E Schalter AUS -> leer, mehr false', j);
  await setzen(true);

  // A ohne Parameter wie bisher
  j = await inbox('');
  check(gleich(idsVon(j), n) && j.mehr === false && j.debug?.modus === 'letzte' && j.debug?.limit === 40, 'A ohne Parameter: alle, aelteste zuerst, mehr false, modus letzte', j);
  j = await inbox('&limit=2');
  check(gleich(idsVon(j), n.slice(3)) && j.mehr === true, 'A limit=2: die zwei juengsten, mehr true', j);

  // B ab_id: nur juengere, aufsteigend; limit schneidet die juengsten ab (naechster Takt holt sie)
  j = await inbox('&ab_id=' + n[2]);
  check(gleich(idsVon(j), n.slice(3)) && j.mehr === false && j.debug?.modus === 'ab', 'B ab_id: nur juengere (ohne fremde Zeile)', j);
  j = await inbox('&ab_id=' + n[0] + '&limit=2');
  check(gleich(idsVon(j), n.slice(1, 3)) && j.mehr === true, 'B ab_id + limit=2: die naechsten zwei aufsteigend, mehr true', j);
  j = await inbox('&ab_id=' + n[4]);
  check(j.nachrichten.length === 0 && j.mehr === false, 'B ab_id = neueste: leer', j);

  // C vor_id: die limit davor, aelteste zuerst
  j = await inbox('&vor_id=' + n[4] + '&limit=2');
  check(gleich(idsVon(j), n.slice(2, 4)) && j.mehr === true && j.debug?.modus === 'vor', 'C vor_id + limit=2: die zwei davor, mehr true', j);
  j = await inbox('&vor_id=' + n[2] + '&limit=5');
  check(gleich(idsVon(j), n.slice(0, 2)) && j.mehr === false, 'C vor_id am Anfang: Rest, mehr false', j);

  // D ab_id gewinnt; ungueltige ids = letzte
  j = await inbox('&ab_id=' + n[3] + '&vor_id=' + n[1]);
  check(gleich(idsVon(j), [n[4]]) && j.debug?.modus === 'ab', 'D ab_id und vor_id: ab_id gewinnt', j);
  j = await inbox('&ab_id=abc&vor_id=-1');
  check(gleich(idsVon(j), n) && j.debug?.modus === 'letzte', 'D ungueltige ids -> wie ohne Parameter', j);
} finally {
  await app.close().catch(() => undefined);
  try { await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await basisPool.end(); }
}
console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
