/**
 * P22-T147: Bewertung haengt am Artefakt, nicht am Urheber. NUR synapse_test:5433, privates Schema, gebaute Core/API-dists, kein
 * Docker/Browser (Abbild-Schritte von zeigen scheitern absichtlich laut, die PG-Zeile bleibt; wie artefakt-bewertung-p22-t141).
 * Aufruf: SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/artefakt-bewertung-am-artefakt-p22-t147.test.mjs
 * A Hinweistext je Zustand (rein). B zeigen mit artefakt_id auf ein bewertetes Artefakt (anderer Agent als der Urheber) -> bewertung
 * mit Zustand, Kommentar, bewertet_am, hinweis; verbannt; unbewertet und neuer Block -> nichts; mit ueberarbeitet_aus -> versuch_gezeigt.
 * C vorbild -> bewertung. D Schalter AUS -> nichts (zeigen ohne bewertung, bewertungFuerArtefakt null, vorbild funktion_aus).
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

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const AT = await load('packages/rest-api/dist/services/agent-runtime/artefakt-tool.js');
const C = await load('packages/core/dist/index.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t147_' + randomUUID().replaceAll('-', '');
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
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 600) : '')); } };
const P = 'p22-t147-' + randomUUID().slice(0, 8);
const MAIN = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const mit = (f) => mitLesePool(pool, f);
const bewerte = async (body) => (await mit(() => app.inject({ method: 'POST', url: '/api/agent-runtimes/artefakt-bewertung', payload: body }))).json();
const tool = (args, agent) => mit(() => AT.fuehreArtefaktAus(args, agent));
const schalter = async (aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE ebene='global' AND funktion='artefakt_bewertung'");
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'artefakt_bewertung',$1,'T147 Testfixture','user')", [aktiv]);
};

// A Hinweistext je Zustand (rein)
check(/Vorbild/.test(C.bewertungsHinweisText({ id: '7', zustand: 'vorbild', nachfolger: null })), 'A vorbild');
check(/ueberarbeitet_aus:7/.test(C.bewertungsHinweisText({ id: '7', zustand: 'ueberarbeiten', nachfolger: null }))
  && /bewertung_id:7/.test(C.bewertungsHinweisText({ id: '7', zustand: 'ueberarbeiten', nachfolger: null })), 'A ueberarbeiten nennt ueberarbeitet_aus und versuch');
check(/nicht weiterverwenden/.test(C.bewertungsHinweisText({ id: '7', zustand: 'verbannt', nachfolger: null })), 'A verbannt');
check(/artefakt:x1/.test(C.bewertungsHinweisText({ id: '7', zustand: 'versuch_gezeigt', nachfolger: { art: 'artefakt', ref: 'x1' } })), 'A versuch_gezeigt nennt den Nachfolger');

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox', 'agent_artifacts', 'hauptagent_verlauf', 'agent_runtime_sessions', 'agent_runtime_instances']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(C.ARTEFAKT_BEWERTUNG_SCHEMA_SQL);
  await pool.query("INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES($1,$2,'hauptagent-t147','hauptagent-t147','main','aktiv','p22-t147-test')", [MAIN, P]);
  await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES('claude','claude','main','/mnt/z/x','img','synapse-runtime-t147',true) ON CONFLICT DO NOTHING");
  const S1 = randomUUID();
  await pool.query("INSERT INTO agent_runtime_sessions(id,agent_role,runtime,status,identity_id) VALUES($1,'main','claude','running',$2)", [S1, MAIN]);
  const artefakt = async (titel) => {
    const id = randomUUID();
    await pool.query('INSERT INTO agent_artifacts(id, session_id, title, html, created_by, created_by_identity_id) VALUES($1,$2,$3,$4,$5,$6)',
      [id, S1, titel, '<div style="background:#111418;color:#f97316"><h2>' + titel + '</h2></div>', 'hauptagent-t147', MAIN]);
    return id;
  };
  const A1 = await artefakt('Ueberarbeiten'), A2 = await artefakt('Verbannt'), A3 = await artefakt('Unbewertet'), A4 = await artefakt('Vorbild');
  await schalter(true);
  const BA = (await bewerte({ quelle_art: 'artefakt', quelle_ref: A1, urteil: 'runter', kommentar: 'Ueberschrift kleiner, mehr Luft' })).bewertung.id;
  const BV = (await bewerte({ quelle_art: 'artefakt', quelle_ref: A2, urteil: 'runter' })).bewertung.id;
  const BG = (await bewerte({ quelle_art: 'artefakt', quelle_ref: A4, urteil: 'hoch' })).bewertung.id;
  check(BA && BV && BG, 'Fixture: drei Bewertungen');

  // B zeigen mit artefakt_id (ein anderer Agent als der Urheber nutzt das Artefakt)
  let j = await tool({ action: 'zeigen', session_id: S1, artefakt_id: A1, html: '<div><h2>Ueberarbeiten neu</h2></div>' }, 'anderer-agent');
  check(j.success === true && j.artefakt_id === A1 && j.revision === 2, 'B zeigen ersetzt das bewertete Artefakt', j);
  check(j.bewertung?.id === BA && j.bewertung.zustand === 'ueberarbeiten' && j.bewertung.kommentar === 'Ueberschrift kleiner, mehr Luft'
    && !Number.isNaN(Date.parse(j.bewertung.bewertet_am)) && /ueberarbeitet_aus:/.test(j.bewertung.hinweis), 'B bewertung mit Zustand, Kommentar, bewertet_am, hinweis', j.bewertung);
  j = await tool({ action: 'zeigen', session_id: S1, artefakt_id: A2, html: '<div><h2>Verbannt neu</h2></div>' }, 'anderer-agent');
  check(j.success === true && j.bewertung?.zustand === 'verbannt' && j.bewertung.kommentar === null && /nicht weiterverwenden/.test(j.bewertung.hinweis), 'B verbannt mit Hinweis', j.bewertung);
  j = await tool({ action: 'zeigen', session_id: S1, artefakt_id: A3, html: '<div><h2>Unbewertet neu</h2></div>' }, 'anderer-agent');
  check(j.success === true && !('bewertung' in j), 'B unbewertet -> keine bewertung', j);
  j = await tool({ action: 'zeigen', session_id: S1, html: '<div><h2>Neuer Block</h2></div>' }, 'anderer-agent');
  check(j.success === true && !('bewertung' in j), 'B neuer Block (ohne artefakt_id) -> keine bewertung', j);
  j = await tool({ action: 'zeigen', session_id: S1, artefakt_id: A1, html: '<div><h2>Ueberarbeiten v3</h2></div>', ueberarbeitet_aus: Number(BA) }, 'anderer-agent');
  check(j.success === true && j.versuch?.zustand === 'versuch_gezeigt' && j.bewertung?.zustand === 'versuch_gezeigt' && j.bewertung.nachfolger?.ref === A1
    && /versuch_gezeigt/.test(j.bewertung.hinweis), 'B mit ueberarbeitet_aus: neuere Revision gilt als Versuch, bewertung zeigt versuch_gezeigt', { versuch: j.versuch, bewertung: j.bewertung });
  j = await tool({ action: 'zeigen', session_id: randomUUID(), artefakt_id: A2, html: '<p>x</p>' }, 'anderer-agent');
  check(j.success === false && !('bewertung' in j), 'B gescheitertes zeigen traegt nichts', j);

  // C vorbild
  j = await tool({ action: 'vorbild', bewertung_id: Number(BV) }, 'dritter-agent');
  check(j.success === true && j.bewertung?.zustand === 'verbannt' && /nicht weiterverwenden/.test(j.bewertung.hinweis) && typeof j.html === 'string', 'C vorbild (verbannt) -> bewertung mit Hinweis, HTML wie bisher', j.bewertung);
  j = await tool({ action: 'vorbild', bewertung_id: Number(BG) }, 'dritter-agent');
  check(j.success === true && j.zustand === 'vorbild' && j.bewertung?.zustand === 'vorbild' && j.bewertung.id === BG && /Vorbild/.test(j.bewertung.hinweis), 'C vorbild (vorbild) -> bewertung', j.bewertung);

  // D Schalter AUS -> nichts
  await schalter(false);
  j = await tool({ action: 'zeigen', session_id: S1, artefakt_id: A2, html: '<div><h2>Verbannt aus</h2></div>' }, 'anderer-agent');
  check(j.success === true && !('bewertung' in j) && !('design_vorlieben' in j), 'D AUS: zeigen ohne bewertung', j);
  check(await mit(() => C.bewertungFuerArtefakt(A2)) === null, 'D AUS: bewertungFuerArtefakt null');
  j = await tool({ action: 'vorbild', bewertung_id: Number(BV) }, 'dritter-agent');
  check(j.success === false && j.error === 'funktion_aus', 'D AUS: vorbild funktion_aus (unveraendert)', j);
  check(await mit(() => C.bewertungFuerArtefakt('kein gueltiger / Wert')) === null, 'D ungueltige ID -> null');
} finally {
  await app.close().catch(() => undefined);
  try { await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await basisPool.end(); }
}
console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
