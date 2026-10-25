/**
 * P22-T137 (Punkt 5): GET /api/agent-runtimes/agent-chat/inbox - Inbox zwischen User und einer Identitaet (beide Richtungen) fuer das
 * Koordinator-Fenster. NUR synapse_test:5433, gebaute Core/API-dists, privates Testschema (wie plattform-agent-chat-p22-t112).
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/agent-chat-inbox-p22-t137.test.mjs
 * A Eingabefehler; B Schalter plattform_agent_chat AUS -> aktiv false, leer; C Zuordnung (Identitaet und Name, beide Richtungen, nur
 * Projekt der Identitaet, keine fremden Agenten), aelteste zuerst; D limit; E nur lesend (processed unveraendert); F Debug.
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
const schema = 'p22_t137_' + randomUUID().replaceAll('-', '');
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
const P = 'p22-t137-' + randomUUID().slice(0, 8), Q = P + '-anderes';
const KOORD = randomUUID(), ANDERER = randomUUID(), REA = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const inject = (request) => mitLesePool(pool, () => app.inject(request));
const inbox = (q) => inject({ method: 'GET', url: '/api/agent-runtimes/agent-chat/inbox' + q });
const setzen = async (project, aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1 AND funktion='plattform_agent_chat'", [project]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'plattform_agent_chat',$2,'T137 Testfixture','user')", [project, aktiv]);
};
const zeile = async (von, an, text, project, o = {}) => (await pool.query(
  `INSERT INTO specialist_inbox(from_agent,to_agent,content,project,from_identity_id,to_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
  [von, an, text, project, o.von_id ?? null, o.an_id ?? null, o.zeit ?? new Date().toISOString()])).rows[0].id;

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(
    `INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES
      ($1,$4,'koordinator','koordinator','koordinator','aktiv','p22-t137-test'),
      ($2,$5,'koordinator','koordinator','koordinator','aktiv','p22-t137-test'),
      ($3,$4,'rea4','rea4','subagent','aktiv','p22-t137-test')`,
    [KOORD, ANDERER, REA, P, Q]);
  const t = (min) => new Date(Date.UTC(2026, 9, 25, 10, min)).toISOString();
  const web = await zeile('user', 'koordinator', 'aus der Web-UI', P, { an_id: KOORD, zeit: t(1) });
  const html = await zeile('koordinator', 'user', '<div><b>HTML</b></div>', P, { von_id: KOORD, zeit: t(2) });
  const altName = await zeile('koordinator', 'user', 'Antwort ohne Identitaet', P, { zeit: t(3) });
  const altEin = await zeile('user', 'koordinator', 'Eingabe ohne Identitaet', P, { zeit: t(4) });
  await zeile('user', 'rea4', 'an rea4', P, { an_id: REA, zeit: t(5) });
  await zeile('koordinator', 'rea4', 'Koordinator an rea4', P, { von_id: KOORD, an_id: REA, zeit: t(6) });
  await zeile('koordinator', 'user', 'anderes Projekt', Q, { von_id: ANDERER, zeit: t(7) });
  await zeile('user', 'koordinator', 'an fremde Identitaet gleichen Namens', P, { an_id: ANDERER, zeit: t(8) });

  // A Eingabefehler
  let r = await inbox('');
  check(r.statusCode === 400 && r.json().error.code === 'identity_id_fehlt', 'A ohne identity_id 400', r.json());
  r = await inbox('?identity_id=' + randomUUID());
  check(r.statusCode === 404 && r.json().error.code === 'identitaet_unbekannt', 'A unbekannte Identitaet 404', r.json());

  // B Schalter AUS (Standard) -> leer, Schalter sichtbar
  r = await inbox('?identity_id=' + KOORD);
  let j = r.json();
  check(r.statusCode === 200 && j.success === true && j.aktiv === false && j.nachrichten.length === 0 && j.schalter?.name === 'plattform_agent_chat', 'B Schalter AUS -> aktiv false, leer', j);

  // C Zuordnung, aelteste zuerst
  await setzen(P, true);
  r = await inbox('?identity_id=' + KOORD);
  j = r.json();
  check(r.statusCode === 200 && j.aktiv === true, 'C Schalter EIN -> aktiv', j);
  check(JSON.stringify(j.nachrichten.map((n) => n.id)) === JSON.stringify([web, html, altName, altEin]),
    'C genau User<->Koordinator (Identitaet und Name), ohne rea4/anderes Projekt/fremde Identitaet, aelteste zuerst', j.nachrichten);
  check(JSON.stringify(j.nachrichten.map((n) => n.richtung)) === JSON.stringify(['ein', 'aus', 'aus', 'ein']), 'C Richtung ein/aus', j.nachrichten);
  const h = j.nachrichten.find((n) => n.id === html);
  check(h?.text === '<div><b>HTML</b></div>' && h.von === 'koordinator' && h.an === 'user' && h.erstellt_am === t(2), 'C Inhalt unveraendert, Zeit ISO', h);
  r = await inbox('?identity_id=' + ANDERER);
  check(r.json().aktiv === false, 'C Schalter gilt je Projekt der Identitaet (Q aus)', r.json());

  // D limit: die juengsten n, weiterhin aelteste zuerst
  j = (await inbox('?identity_id=' + KOORD + '&limit=2')).json();
  check(JSON.stringify(j.nachrichten.map((n) => n.id)) === JSON.stringify([altName, altEin]) && j.debug?.limit === 2, 'D limit=2 -> die zwei juengsten', j);
  j = (await inbox('?identity_id=' + KOORD + '&limit=abc')).json();
  check(j.debug?.limit === 40, 'D ungueltiges limit -> Standard 40', j.debug);

  // E nur lesend
  const offen = (await pool.query('SELECT count(*)::int n FROM specialist_inbox WHERE processed = false')).rows[0].n;
  check(offen === 8, 'E processed bleibt unveraendert', offen);

  // F Debug
  j = (await inbox('?identity_id=' + KOORD)).json();
  check(j.debug?.anzahl === 4 && j.debug?.schalter_quelle === 'produkt-schalter' && j.agent_id === 'koordinator' && j.project === P, 'F Debug: anzahl, Schalterquelle, Ziel', j.debug);
} finally {
  await app.close().catch(() => undefined);
  try { await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await basisPool.end(); }
}
console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
