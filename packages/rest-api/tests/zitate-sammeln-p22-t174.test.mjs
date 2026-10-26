/**
 * P22-T174: Gesammelte Zitate gehen vollstaendig mit EINER Nachricht an den EINEN Empfaenger des Chatfensters. NUR synapse_test:5433,
 * gebaute Core/API-dists, privates Testschema, keine echte CLI-/Container-Aufweckung.
 *   pnpm -C packages/core build && pnpm -C packages/rest-api build
 *   SYNAPSE_DATABASE_URL=postgresql://...@<host>:5433/synapse_test node --experimental-strip-types packages/rest-api/tests/zitate-sammeln-p22-t174.test.mjs
 * WARUM (User inbox 1275, 26.10.2026): "wenn ich zitate hinzufüge wird das vorige verworfen". Der Fix liegt in der Web-UI
 * (ZitatAnhaenge.tsx uebernimmt den offenen Editor, zitat-logik.ts uebernimmZitatEditor). Dieser Test belegt die Strecke dahinter:
 * der Entwurf, wie ihn die Web-UI-Logik nacheinander sammelt (Verweis, Ausschnitt, Pin; einzeln entfernbar), kommt ueber
 *   A POST /api/agent-runtimes/agent-chat (rest-api routes/agent-runtimes.ts, Koordinator-/Agentenfenster) und
 *   B mainNachrichtEingang (Main-Chat)
 * vollstaendig und in Reihenfolge an: genau EIN Inbox-Eintrag an die angeschriebene identity_id, Block mit allen Zitaten, kein anderer
 * Empfaenger, kein Channel. Schalter: chat_zitate (Produkt-Schalter im Testschema), plattform_agent_chat.
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
const ZL = await load('packages/web-ui/src/components/zitat-logik.ts');
const { mitLesePool } = await load('packages/core/dist/db/client.js');
const { default: Fastify } = await import('fastify');
const basisPool = C.getPool();
const schema = 'p22_t174_' + randomUUID().replaceAll('-', '');
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
// Herkunft im Label; FAIL-Zeile mit tatsaechlichem Wert (regel-tests-mit-herkunft-kommentieren).
const check = (ok, name, info) => { checks++; if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' | tatsaechlich: ' + JSON.stringify(info).slice(0, 700) : '')); } };
const P = 'p22-t174-' + randomUUID().slice(0, 8);
const A = randomUUID(), B = randomUUID();
const app = Fastify();
await app.register(R.agentRuntimeRoutes);
await app.ready();
const inject = (request) => mitLesePool(pool, () => app.inject(request));
const post = (body) => inject({ method: 'POST', url: '/api/agent-runtimes/agent-chat', payload: body });
const zaehle = async (sql, params = []) => Number((await pool.query(sql, params)).rows[0].n);
const schalter = async (funktion, ebene, project, aktiv) => {
  await pool.query("DELETE FROM agent_profil_schalter WHERE funktion=$1 AND ebene=$2 AND COALESCE(project,'')=COALESCE($3,'')", [funktion, ebene, project]);
  await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES($1,$2,$3,$4,'T174 Testfixture','user')", [ebene, project, funktion, aktiv]);
};

// Entwurf wie im Chatfenster: drei Zitate nacheinander, jedes ueber uebernimmZitatEditor (Speichern bzw. Uebernehmen beim naechsten).
const G = ZL.ZITAT_GRENZEN_STANDARD;
const sammle = (eintraege) => eintraege.reduce((liste, [vorlage, anmerkung], i) => ZL.uebernimmZitatEditor(liste, { vorlage, schluessel: null, anmerkung }, G, 'k' + i).liste, []);
const entwurf = sammle([
  [{ art: 'task', id: 'P1-T2', projekt: P, titel: 'Zweite Aufgabe' }, 'Bitte zuerst'],
  [{ art: 'ausschnitt', id: null, projekt: P, titel: '', ausschnitt: 'markierter Satz', quelle: 'inbox:9' }, ''],
  [ZL.pinVorlage({ thoughtId: 'th-174', projekt: P, kopf: 'Task P1-T3', titel: 'Dritte Aufgabe', text: 'So umsetzen.' }, G.ausschnitt_max), 'Pin dazu'],
]);

try {
  await basisPool.query('CREATE SCHEMA ' + schema);
  for (const table of ['agent_profil_schalter', 'agent_identitaeten', 'specialist_inbox', 'intern_schalter', 'specialist_channel_messages']) {
    await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING DEFAULTS INCLUDING INDEXES)');
  }
  await pool.query(C.CHAT_ZITATE_SCHEMA_SQL.replace('CREATE TABLE IF NOT EXISTS chat_zitate_einstellungen', 'CREATE TABLE IF NOT EXISTS ' + schema + '.chat_zitate_einstellungen'));
  await pool.query(
    `INSERT INTO agent_identitaeten(id, project, name, agent_id, rolle, status, erstellt_von) VALUES
      ($1,$3,'koordinator','koordinator','koordinator','aktiv','p22-t174-test'), ($2,$3,'rea4','rea4','subagent','aktiv','p22-t174-test')`, [A, B, P]);
  await schalter('plattform_agent_chat', 'projekt', P, true);
  await schalter('chat_zitate', 'projekt', P, true);
  check(entwurf.length === 3 && entwurf.map((z) => z.schluessel).join(',') === 'k0,k1,k2', 'P22-T174 zitat-logik.ts uebernimmZitatEditor: Entwurf sammelt drei Zitate', entwurf);

  // A Koordinator-/Agentenfenster: drei Zitate -> genau EIN Inbox-Eintrag an A mit Block 3 in Reihenfolge
  const vorAlle = await zaehle('SELECT count(*) n FROM specialist_inbox'), vorB = await zaehle("SELECT count(*) n FROM specialist_inbox WHERE to_agent='rea4' OR to_identity_id=$1", [B]);
  let r = await post({ identity_id: A, text: 'Drei Zitate', zitate: ZL.zuSendeZitaten(entwurf) });
  const j = r.json();
  check(r.statusCode === 200 && j.zitate?.anzahl === 3 && j.zitate.empfaenger === A, 'P22-T174 routes/agent-runtimes.ts POST agent-chat: 200, zitate.anzahl 3, Empfaenger A', j);
  check(await zaehle('SELECT count(*) n FROM specialist_inbox') === vorAlle + 1, 'P22-T174 routes/agent-runtimes.ts POST agent-chat: genau EIN Inbox-Eintrag fuer drei Zitate');
  const row = (await pool.query('SELECT to_agent, to_identity_id, content FROM specialist_inbox WHERE id=$1', [j.inbox_id])).rows[0];
  const kopf = [...(row?.content ?? '').matchAll(/^(\d+)\) (.+)$/gm)].map((m) => m[2]);
  check(row?.to_agent === 'koordinator' && /\n\n\[Synapse-Zitate: 3\]\n/.test(row.content), 'P22-T174 routes/agent-runtimes.ts: Inhalt an A mit Block [Synapse-Zitate: 3]', row);
  check(kopf.join(' | ') === 'Task P1-T2 | Ausschnitt | Angepinnte User-Entscheidung an Task P1-T3', 'P22-T174 core chat-zitate.ts Block: Reihenfolge wie gesammelt (Verweis, Ausschnitt, Pin)', kopf);
  const zurueck = ZL.zerlegeZitatBlock(row.content);
  check(zurueck.text === 'Drei Zitate' && zurueck.zitate.length === 3 && zurueck.zitate[0].anmerkung === 'Bitte zuerst' && zurueck.zitate[2].pin === 'Task P1-T3',
    'P22-T174 zitat-logik.ts zerlegeZitatBlock: Web-UI liest alle drei als Kaertchen zurueck', zurueck);
  check(await zaehle("SELECT count(*) n FROM specialist_inbox WHERE to_agent='rea4' OR to_identity_id=$1", [B]) === vorB, 'P22-T174 routes/agent-runtimes.ts: anderer Agent bekommt nichts (kein Rundversand)');
  check(await zaehle('SELECT count(*) n FROM specialist_channel_messages') === 0, 'P22-T174 routes/agent-runtimes.ts: kein Channel-Beitrag');

  // A2 einzeln entfernt (x auf das mittlere) -> zwei gehen mit, nur Zitate ohne Text (F3)
  const zwei = ZL.entferneZitat(entwurf, 'k1');
  r = await post({ identity_id: A, text: '', zitate: ZL.zuSendeZitaten(zwei) });
  const z2 = (await pool.query('SELECT content FROM specialist_inbox WHERE id=$1', [r.json().inbox_id])).rows[0];
  check(r.statusCode === 200 && z2?.content.startsWith('[Synapse-Zitate: 2]\n1) Task P1-T2') && !/Ausschnitt/.test(z2.content),
    'P22-T174 routes/agent-runtimes.ts: nach Entfernen des mittleren gehen genau die zwei uebrigen mit', z2);

  // A3 Senden mit offenem Editor (Koordinator 26.10.2026): die Web-UI nimmt den offenen Editor wie Speichern in sendeZitate auf,
  //    leere Anmerkung = Zitat ohne Anmerkung. Payload so gebaut, wie ZitatAnhaenge.tsx es tut (uebernimmZitatEditor auf den Entwurf).
  const offen = ZL.uebernimmZitatEditor(zwei, { vorlage: { art: 'task', id: 'P1-T1', projekt: P, titel: 'Erste Aufgabe' }, schluessel: null, anmerkung: '' }, G, 'offen');
  r = await post({ identity_id: A, text: 'Mit offenem Editor', zitate: ZL.zuSendeZitaten(offen.liste) });
  const z3 = (await pool.query('SELECT content FROM specialist_inbox WHERE id=$1', [r.json().inbox_id])).rows[0];
  const k3 = [...(z3?.content ?? '').matchAll(/^(\d+)\) (.+)$/gm)].map((m) => m[2]);
  const t1Block = (z3?.content ?? '').split(/^3\) /m)[1] ?? '';
  check(r.statusCode === 200 && offen.fehler === null && z3?.content.startsWith('Mit offenem Editor\n\n[Synapse-Zitate: 3]\n')
    && k3.join(' | ') === 'Task P1-T2 | Angepinnte User-Entscheidung an Task P1-T3 | Task P1-T1' && !/Anmerkung: \S/.test(t1Block.split('[/Synapse-Zitate]')[0]),
  'P22-T174 routes/agent-runtimes.ts: Senden mit offenem Editor (leere Anmerkung) -> Zitat ohne Anmerkung am Ende des Blocks', { k3, t1Block: t1Block.slice(0, 200) });

  // B Main-Chat: derselbe Entwurf ueber mainNachrichtEingang (Schalter global)
  await schalter('chat_zitate', 'global', null, true);
  const e = await mitLesePool(pool, () => R.mainNachrichtEingang({ message: 'An den Main', zitate: ZL.zuSendeZitaten(entwurf) }));
  check(e.ok && e.zitate?.anzahl === 3 && e.modellText.startsWith('An den Main\n\n[Synapse-Zitate: 3]') && e.anhaenge?.filter((a) => a.art === 'zitat').length === 3,
    'P22-T174 routes/agent-runtimes.ts mainNachrichtEingang: drei Zitate im Modelltext und als Verlauf-Anhaenge', e);
  check(ZL.anzeigeAusAnhaengen(e.anhaenge).map((z) => z.pin ?? z.id ?? z.art).join(',') === 'P1-T2,ausschnitt,Task P1-T3',
    'P22-T174 zitat-logik.ts anzeigeAusAnhaengen: Main-Verlauf zeigt alle drei in Reihenfolge', e.anhaenge);
} finally {
  await app.close().catch(() => undefined);
  try { await basisPool.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await basisPool.end(); }
}
console.log(fails ? `FEHLER: ${fails} von ${checks}` : 'PASS P22-T174 rest-api Zitate sammeln: ' + checks + ' Pruefungen gruen');
process.exit(fails ? 1 : 0);
