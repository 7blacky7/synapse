/**
 * P22-T168: Zitat-Anhaenge ueber die Senderouten. NUR synapse_test:5433, gebaute Core/API-dists, privates Testschema, keine
 * echte CLI-/Container-Aufweckung.
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node packages/rest-api/tests/chat-zitate-p22-t168.test.mjs
 * A Schalter chat_zitate AUS: Body mit zitate -> 409, nichts geschrieben; ohne zitate wie bisher (Bestand).
 * B EIN: genau EIN Inbox-Eintrag an die angegebene identity_id mit Block, kein anderer Empfaenger, kein Channel (Klarstellung 1210).
 * C nur Zitate ohne Text (F3); leer ohne Zitate weiter text_fehlt. D Formfehler/Grenzen (400), Gesamtlaenge.
 * E Status-/Einstellungsroute (Quelle, Grenzen aus PG). F Main-Eingang: Modelltext mit Block, Verlauf ohne Block + anhaenge, Schalter global.
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
process.env.SYNAPSE_INTERN_TOOL = '0';
process.env.SYNAPSE_W1B_GATE_TTL_MS = '0';

const load = (p) => import(pathToFileURL(join(repo, p)).href);
const R = await load('packages/rest-api/dist/routes/agent-runtimes.js');
const C = await load('packages/core/dist/index.js');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t168_' + randomUUID().replaceAll('-', '');
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

let fails = 0, checks = 0;
const check = (ok, name, info) => { checks++; if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 700) : '')); } };
const P = 'p22-t168-' + randomUUID().slice(0, 8);
const A = randomUUID(), B = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const inject = (request) => mitLesePool(pool, () => app.inject(request));
const post = (body) => inject({ method: 'POST', url: '/api/agent-runtimes/agent-chat', payload: body });
const zaehle = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);
const schalter = async (funktion, ebene, project, aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion=$1 AND ebene=$2 AND COALESCE(project,'')=COALESCE($3,'')", [funktion, ebene, project]);
  if (aktiv !== null) await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES($1,$2,$3,$4,'T168 Testfixture','user')", [ebene, project, funktion, aktiv]);
};
const z1 = { art: 'task', id: 'P1-T2', projekt: P, titel: 'Zweite Aufgabe', anmerkung: 'Bitte zuerst das hier' };
const z2 = { art: 'ausschnitt', projekt: P, ausschnitt: 'markierter Satz', quelle: { nachricht: 'inbox:9' }, anmerkung: '' };

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox', 'intern_schalter', 'specialist_channel_messages']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(C.CHAT_ZITATE_SCHEMA_SQL.replace('CREATE TABLE IF NOT EXISTS chat_zitate_einstellungen', 'CREATE TABLE IF NOT EXISTS ' + schema + '.chat_zitate_einstellungen'));
  await pool.query(
    `INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES
      ($1,$3,'koordinator','koordinator','koordinator','aktiv','p22-t168-test'), ($2,$3,'rea4','rea4','subagent','aktiv','p22-t168-test')`, [A, B, P]);
  await schalter('plattform_agent_chat', 'projekt', P, true);

  // A Schalter AUS
  let r = await post({ identity_id: A, text: 'Mit Zitat', zitate: [z1] });
  check(r.statusCode === 409 && r.json().error.code === 'funktion_aus' && r.json().error.details?.schalter?.funktion === 'chat_zitate', 'A chat_zitate AUS: 409 funktion_aus', r.json());
  check(await zaehle('SELECT count(*) n FROM specialist_inbox') === 0, 'A AUS schreibt nichts');
  r = await post({ identity_id: A, text: 'Ohne Zitat' });
  check(r.statusCode === 200 && !('zitate' in r.json()), 'A ohne zitate wie bisher (Bestand)', r.json());
  const ohne = (await pool.query('SELECT content FROM specialist_inbox WHERE id=$1', [r.json().inbox_id])).rows[0];
  check(ohne?.content === 'Ohne Zitat', 'A Inhalt unveraendert');
  r = await post({ identity_id: A, text: 'Leere Liste', zitate: [] });
  check(r.statusCode === 200, 'A leere zitate-Liste = ohne Zitate (auch bei AUS)');

  // B EIN: nur an den angeschriebenen Empfaenger
  await schalter('chat_zitate', 'projekt', P, true);
  const vorA = await zaehle('SELECT count(*) n FROM specialist_inbox'), vorB = await zaehle("SELECT count(*) n FROM specialist_inbox WHERE to_agent='rea4' OR to_identity_id=$1", [B]);
  r = await post({ identity_id: A, text: 'Bitte ansehen', zitate: [z1, z2] });
  const j = r.json();
  check(r.statusCode === 200 && j.success && j.zitate?.anzahl === 2 && j.zitate.empfaenger === A && j.zitate.schalter_quelle === 'produkt-schalter' && j.zitate.block_zeichen > 0,
    'B EIN: 200 mit Debug (anzahl, empfaenger, Quelle)', j);
  check(await zaehle('SELECT count(*) n FROM specialist_inbox') === vorA + 1, 'B genau EIN neuer Inbox-Eintrag');
  const row = (await pool.query('SELECT from_agent, to_agent, to_identity_id, content FROM specialist_inbox WHERE id=$1', [j.inbox_id])).rows[0];
  check(row.from_agent === 'user' && row.to_agent === 'koordinator' && (row.to_identity_id === null || row.to_identity_id === A), 'B an genau die angegebene Identitaet', row);
  check(row.content === C.textMitZitaten('Bitte ansehen', C.pruefeZitate([z1, z2], { max_anzahl: 10, anmerkung_max: 2000, ausschnitt_max: 600, titel_max: 160 }).zitate),
    'B Inhalt = Nachricht + Block (core textMitZitaten)', row.content);
  check(/\n\n\[Synapse-Zitate: 2\]\n1\) Task P1-T2\n   Projekt: /.test(row.content) && /Anmerkung: Bitte zuerst das hier/.test(row.content), 'B Block lesbar im Inhalt');
  check(await zaehle("SELECT count(*) n FROM specialist_inbox WHERE to_agent='rea4' OR to_identity_id=$1", [B]) === vorB, 'B anderer Agent bekommt nichts (kein Rundversand)');
  check(await zaehle('SELECT count(*) n FROM specialist_channel_messages') === 0, 'B kein Channel-Beitrag');

  // C nur Zitate
  r = await post({ identity_id: B, text: '', zitate: [z1] });
  const c = (await pool.query('SELECT content, to_agent FROM specialist_inbox WHERE id=$1', [r.json().inbox_id])).rows[0];
  check(r.statusCode === 200 && c.to_agent === 'rea4' && c.content.startsWith('[Synapse-Zitate: 1]\n1) Task P1-T2'), 'C nur Zitate ohne Text an B (F3)', c);
  r = await post({ identity_id: A, text: '   ' });
  check(r.statusCode === 400 && r.json().error.code === 'text_fehlt', 'C leer ohne Zitate weiter text_fehlt');

  // D Formfehler und Grenzen
  r = await post({ identity_id: A, text: 'x', zitate: [{ art: 'quatsch', id: 'x', projekt: P }] });
  check(r.statusCode === 400 && r.json().error.code === 'zitat_art_ungueltig', 'D unbekannte Art 400', r.json());
  r = await post({ identity_id: A, text: 'x', zitate: [{ ...z1, anmerkung: 'y'.repeat(2001) }] });
  check(r.statusCode === 400 && r.json().error.code === 'zitat_anmerkung_zu_lang', 'D Anmerkung zu lang 400');
  r = await post({ identity_id: A, text: 'x'.repeat(19_990), zitate: [z1] });
  check(r.statusCode === 400 && r.json().error.code === 'text_zu_lang', 'D Gesamtlaenge mit Block geprueft');
  const ungeschrieben = await zaehle('SELECT count(*) n FROM specialist_inbox');

  // E Status- und Einstellungsroute
  // GET-Anfragen lesen ueber den Lese-Pool der API (nicht ueber das private Testschema): die Route liefert Form und Projekt, die
  // Wirkung des Schalters belegt dieselbe Lesestelle im Testschema.
  let s = (await inject({ method: 'GET', url: '/api/main-agent/chat-zitate?project=' + encodeURIComponent(P) })).json();
  check(s.success && typeof s.aktiv === 'boolean' && s.schalter.funktion === 'chat_zitate' && s.schalter.project === P && typeof s.schalter.quelle === 'string'
    && Object.keys(s.grenzen).join(',') === 'max_anzahl,anmerkung_max,ausschnitt_max,titel_max' && s.einstellungen?.einstellungen?.max_anzahl?.quelle, 'E Status-Route: Schalter mit Quelle, Grenzen mit Quelle', s);
  s = (await inject({ method: 'GET', url: '/api/main-agent/chat-zitate' })).json();
  check(s.success && s.schalter.project === null, 'E Status-Route ohne Projekt = global (Main)');
  const sP = await mitLesePool(pool, () => C.leseChatZitateSchalter(P)), sG = await mitLesePool(pool, () => C.leseChatZitateSchalter(null));
  check(sP.aktiv && sP.quelle === 'produkt-schalter' && sP.ebene === 'projekt' && !sG.aktiv, 'E Lesestelle der Route: Projekt EIN, global AUS', { sP, sG });
  r = await inject({ method: 'PUT', url: '/api/main-agent/chat-zitate/einstellungen', payload: { werte: { max_anzahl: 1 }, grund: 'Test P22-T168 Grenze' } });
  check(r.statusCode === 200 && r.json().werte.max_anzahl === 1 && r.json().einstellungen.max_anzahl.quelle === 'einstellung', 'E Grenze gesetzt (Quelle einstellung)', r.json());
  r = await post({ identity_id: A, text: 'x', zitate: [z1, z2] });
  check(r.statusCode === 400 && r.json().error.code === 'zu_viele_zitate', 'E Grenze aus PG wirkt in der Route');
  r = await inject({ method: 'PUT', url: '/api/main-agent/chat-zitate/einstellungen', payload: { werte: { max_anzahl: 999 }, grund: 'Test P22-T168 Grenze' } });
  check(r.statusCode >= 400 && r.json().error?.code === 'wert_ungueltig', 'E ungueltiger Wert abgelehnt', r.json());
  await inject({ method: 'PUT', url: '/api/main-agent/chat-zitate/einstellungen', payload: { werte: { max_anzahl: null }, grund: 'Test P22-T168 zurueck' } });
  check(await zaehle('SELECT count(*) n FROM specialist_inbox') === ungeschrieben, 'D/E abgelehnte Nachrichten schreiben nichts');

  // F Main-Eingang (Schalter global)
  const eingang = (body) => mitLesePool(pool, () => R.mainNachrichtEingang(body));
  let e = await eingang({ message: 'Hallo' });
  check(e.ok && e.modellText === 'Hallo' && e.nachricht === 'Hallo' && e.zitate === null && e.anhaenge === undefined, 'F ohne Zitate wie bisher', e);
  e = await eingang({});
  check(!e.ok && e.status === 400 && e.code === 'message_fehlt', 'F leer ohne Zitate 400');
  e = await eingang({ message: 'Mit', zitate: [z1] });
  check(!e.ok && e.status === 409 && e.code === 'funktion_aus', 'F Main: Schalter global AUS -> 409 (Projekt-Freigabe gilt nicht fuer den Main)', e);
  await schalter('chat_zitate', 'global', null, true);
  e = await eingang({ message: 'Mit', anhaenge: [{ name: 'a.png', typ: 'image/png', groesse: 1 }], zitate: [z1, z2] });
  check(e.ok && e.nachricht === 'Mit' && e.modellText.startsWith('Mit\n\n[Synapse-Zitate: 2]') && e.zitate.anzahl === 2, 'F Modelltext = Nachricht + Block, Verlauf-Text ohne Block', e);
  check(Array.isArray(e.anhaenge) && e.anhaenge.length === 3 && e.anhaenge[0].name === 'a.png' && e.anhaenge[1].art === 'zitat' && e.anhaenge[2].verweis_art === 'ausschnitt', 'F Verlauf: Datei-Anhang bleibt, Zitate als anhaenge');
  check(C.mainTurnText(e.nachricht, e.anhaenge) === e.modellText, 'F Warteschlange baut aus dem Verlauf denselben Modelltext');
  e = await eingang({ message: '', zitate: [z1] });
  check(e.ok && e.modellText.startsWith('[Synapse-Zitate: 1]'), 'F Main: nur Zitate (F3)');
} finally {
  await app.close().catch(() => undefined);
  try { await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await basisPool.end(); }
}
console.log(fails ? `FEHLER: ${fails} von ${checks}` : 'P22-T168 rest-api: ' + checks + ' Pruefungen gruen');
process.exit(fails ? 1 : 0);
