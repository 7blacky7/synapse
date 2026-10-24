/**
 * P22-T112: Plattform-Agentenchat mit PG-Produkt-Schalter im Zielprojekt, Standard AUS.
 * NUR synapse_test:5433, gebaute Core/API-dists; keine echte CLI-/Container-Aufweckung.
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@localhost:5433/synapse_test SYNAPSE_AUTH_DISABLED=1 \
 *   node packages/rest-api/tests/plattform-agent-chat-p22-t112.test.mjs
 * A async PG-Schalter/Quelle/Projekt/ENV ohne Wirkung; B AUS schreibt nichts;
 * C Eingabefehler; D Main/inaktiv abgewiesen; E Inbox-Zustellung; F identity_id-Status.
 * Eigene Tabellen im privaten Testschema verhindern Einfluesse globaler Test-Schalter.
 */
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const db = process.env.SYNAPSE_DATABASE_URL ?? '';
let testDb;
try { testDb = new URL(db); } catch { /* unten geschlossen abbrechen */ }
if (testDb?.pathname !== '/synapse_test' || testDb.port !== '5433') {
  console.error('Abbruch: SYNAPSE_DATABASE_URL muss auf synapse_test:5433 zeigen'); process.exit(2);
}
process.env.DATABASE_URL = db;
process.env.SYNAPSE_AUTH_DISABLED = '1';
const envVorher = process.env.SYNAPSE_PLATTFORM_AGENT_CHAT;
delete process.env.SYNAPSE_PLATTFORM_AGENT_CHAT;

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const C = await load('packages/core/dist/index.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t112_' + randomUUID().replaceAll('-', '');
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
const P = 'p22-t112-' + randomUUID().slice(0, 8), Q = P + '-anderes-projekt';
const KOORD = randomUUID(), MAIN = randomUUID(), INAKTIV = randomUUID(), ANDERER = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const inject = (request) => mitLesePool(pool, () => app.inject(request));
const post = (body) => inject({ method: 'POST', url: '/api/agent-runtimes/agent-chat', payload: body });
const status = (id) => inject({ method: 'GET', url: '/api/agent-runtimes/agent-chat/status' + (id === undefined ? '' : '?identity_id=' + encodeURIComponent(id)) });
const schalter = (project) => mitLesePool(pool, () => R.plattformAgentChatSchalter(project));
const setzen = async (project, aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='projekt' AND project=$1 AND funktion='plattform_agent_chat'", [project]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'plattform_agent_chat',$2,'T112 Testfixture','user')", [project, aktiv]);
};

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(
    `INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES
      ($1,$5,'koordinator','koordinator','koordinator','aktiv','p22-t112-test'),
      ($2,$5,'hauptagent-t112','hauptagent-t112','main','aktiv','p22-t112-test'),
      ($3,$5,'alt-t112','alt-t112','subagent','deaktiviert','p22-t112-test'),
      ($4,$6,'anderer-koord','anderer-koord','koordinator','aktiv','p22-t112-test')`,
    [KOORD, MAIN, INAKTIV, ANDERER, P, Q]);

  // A Asynchroner Leser und persistente Projektfreigabe statt ENV.
  let s = await schalter(P);
  check(s.aktiv === false && s.standard === false && s.quelle === 'standard' && s.project === P && s.name === 'plattform_agent_chat', 'A PG-Standard AUS mit Quelle und Projekt', s);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'alle',true,'T112 alle soll Chat nicht freigeben','user')");
  check((await schalter(P)).aktiv === false, 'A alle aktiviert plattform_agent_chat nicht');
  process.env.SYNAPSE_PLATTFORM_AGENT_CHAT = 'ein';
  check((await schalter(P)).aktiv === false, 'A ENV ein aktiviert den PG-Schalter nicht');

  // B Standard/AUS darf keine Nachricht schreiben.
  let r = await post({ identity_id: KOORD, text: 'hallo' });
  check(r.statusCode === 409 && r.json().error.code === 'funktion_aus', 'B Schalter AUS -> 409 funktion_aus', r.json());
  check((await pool.query('SELECT count(*)::int n FROM specialist_inbox')).rows[0].n === 0, 'B AUS schreibt nichts');

  await setzen(P, true);
  process.env.SYNAPSE_PLATTFORM_AGENT_CHAT = 'aus';
  s = await schalter(P);
  check(s.aktiv === true && s.quelle === 'produkt-schalter' && s.ebene === 'projekt' && s.project === P && s.wert === 'ein', 'A Projekt-PG EIN trotz ENV aus, Quelle sichtbar', s);
  check((await schalter(Q)).aktiv === false, 'A Freigabe von P gilt nicht fuer Q');
  r = await post({ identity_id: ANDERER, text: 'darf nicht an Q gehen' });
  check(r.statusCode === 409 && r.json().error.code === 'funktion_aus', 'B POST verwendet Projekt der Zielidentitaet', r.json());
  check((await pool.query('SELECT count(*)::int n FROM specialist_inbox')).rows[0].n === 0, 'B fremdes AUS-Projekt schreibt nichts');

  // C Eingabepruefung vor dem projektbezogenen Gate, dessen Ziel erst aufgeloest werden muss.
  check((await post({ text: 'x' })).json().error.code === 'identity_id_fehlt', 'C ohne identity_id');
  check((await post({ identity_id: KOORD, text: '   ' })).json().error.code === 'text_fehlt', 'C leerer Text');
  check((await post({ identity_id: KOORD, text: 'x'.repeat(20_001) })).json().error.code === 'text_zu_lang', 'C Text zu lang');
  check((await post({ identity_id: randomUUID(), text: 'x' })).statusCode === 404, 'C unbekannte Identitaet 404');
  // D Main / inaktiv
  check((await post({ identity_id: MAIN, text: 'x' })).json().error.code === 'hauptagent_eigener_chat', 'D Main abgewiesen');
  check((await post({ identity_id: INAKTIV, text: 'x' })).json().error.code === 'identitaet_inaktiv', 'D inaktiv abgewiesen');

  // E Bestehender Inbox-Vertrag bleibt unveraendert.
  r = await post({ identity_id: KOORD, text: 'Bitte Status melden' });
  const j = r.json();
  check(r.statusCode === 200 && j.success === true && j.weg === 'inbox' && Number.isFinite(Number(j.inbox_id)), 'E Erfolg mit inbox_id', j);
  const row = (await pool.query('SELECT from_agent, to_agent, to_identity_id, content, processed FROM specialist_inbox WHERE id=$1', [j.inbox_id])).rows[0];
  check(row?.from_agent === 'user' && row.to_agent === 'koordinator' && row.content === 'Bitte Status melden' && row.processed === false, 'E Inbox-Zeile user -> koordinator, unverarbeitet', row);
  check(row?.to_identity_id === null || row?.to_identity_id === KOORD, 'E to_identity_id = Koordinator (bei aktivem Agent-Bezug)', row?.to_identity_id);

  // F Status liest dieselbe Zielprojekt-Freigabe, nie einen frei behaupteten Projektwert.
  r = await status(KOORD);
  s = r.json();
  check(r.statusCode === 200 && s.success === true && s.schalter.aktiv === true && s.schalter.name === 'plattform_agent_chat' && s.schalter.project === P && s.schalter.quelle === 'produkt-schalter', 'F Statusroute zeigt PG-Schalter der identity_id', s);
  s = (await status(ANDERER)).json();
  check(s.success === true && s.schalter.aktiv === false && s.schalter.project === Q, 'F andere identity_id liest anderes Projekt', s);
  r = await status();
  check(r.statusCode === 400 && r.json().error.code === 'identity_id_fehlt', 'F Status ohne identity_id abgewiesen', r.json());
  r = await status(randomUUID());
  check(r.statusCode === 404 && r.json().error.code === 'identitaet_unbekannt', 'F Status unbekannter identity_id abgewiesen', r.json());

  await setzen(P, false);
  process.env.SYNAPSE_PLATTFORM_AGENT_CHAT = 'ein';
  s = (await status(KOORD)).json();
  check(s.schalter.aktiv === false && s.schalter.quelle === 'produkt-schalter', 'F PG AUS sofort sichtbar trotz ENV ein', s);
  r = await post({ identity_id: KOORD, text: 'darf nicht mehr zugestellt werden' });
  check(r.statusCode === 409 && r.json().error.code === 'funktion_aus', 'B PG-Abschaltung sperrt weitere Zustellung', r.json());
  check((await pool.query('SELECT count(*)::int n FROM specialist_inbox')).rows[0].n === 1, 'B Abschaltung erhaelt vorhandene Nachricht ohne neue Zustellung');
} finally {
  if (envVorher === undefined) delete process.env.SYNAPSE_PLATTFORM_AGENT_CHAT;
  else process.env.SYNAPSE_PLATTFORM_AGENT_CHAT = envVorher;
  await app.close().catch(() => undefined);
  try { await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await basisPool.end(); }
}
console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
