/**
 * P9-T31 Testphase (TP-B, claude-tpb2): Loesch-Routen ueber echtes Fastify (inject).
 *
 * ABSICHERUNG: NUR gegen synapse_test (:5433/synapse_test, DATABASE_URL des Shell-Jobs), sonst uebersprungen.
 * Auth ist ein Fake (validateToken/verifyTotp/daemonHost), Qdrant ein lokaler Fake-HTTP-Server auf 127.0.0.1
 * (leere Collection-Liste), psql gibt es nicht. Eigene Testprojekte t31r-*, synthetische Rechner pc-t31r-*.
 * Aufraeumen: nur Zeilen dieser Testprojekte/Testrechner.
 * Voraussetzung: core + rest-api gebaut.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import * as http from 'node:http';
import { createRequire } from 'node:module';

const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
const testDb = url.port === '5433' && url.pathname === '/synapse_test';
const skip = !testDb && 'kein synapse_test';
process.env.SYNAPSE_DATABASE_URL = url.href;
process.env.SYNAPSE_PROJEKTDB_ENV = '/nonexistent/t31r-projektdb.env';
process.env.SYNAPSE_API_FEATURE_CATALOG = 'asset_sync';
process.env.SYNAPSE_API_FEATURES = 'asset_sync';

const HA = 'pc-t31r-a', HB = 'pc-t31r-b';
const P = 't31r-p', N = 't31r-p-2';
const TOKENS = {
  'daemon-a': { kind: 'service', scope: 'daemon', token_hash: 'h-t31r-a' },
  'daemon-b': { kind: 'service', scope: 'daemon:pc', token_hash: 'h-t31r-b' },
  'daemon-x': { kind: 'service', scope: 'daemon', token_hash: 'h-t31r-x' },
  web: { kind: 'session', scope: null, token_hash: 'h-t31r-web' },
  oauth: { kind: 'session', scope: 'mcp', token_hash: 'h-t31r-oauth' },
  access: { kind: 'access', scope: null, token_hash: 'h-t31r-access' },
};
const HOSTS = { 'h-t31r-a': HA, 'h-t31r-b': HB };
let core, pool, f, qdrantServer, geheimA, qdrantAnfragen = 0, totpAufrufe = 0;

const qdrantFake = () => new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    qdrantAnfragen++;
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/collections')) res.end(JSON.stringify({ result: { collections: [] }, status: 'ok', time: 0 }));
    else res.end(JSON.stringify({ title: 'qdrant - fake t31r', version: '1.13.0' }));
  });
  s.listen(0, '127.0.0.1', () => resolve(s));
});

async function call(method, pfad, token, body, { vertrag = true } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (vertrag) headers[core.API_CONTRACT_HEADER] = '1';
  const r = await f.inject({ method, url: pfad, headers, ...(body !== undefined ? { payload: body } : {}) });
  let json = null;
  try { json = r.json(); } catch { /* leer */ }
  return { status: r.statusCode, json, text: r.body, headers: r.headers };
}
const codeA = (v = 0) => core.totpCode(core.base32Dekodieren(geheimA), core.zeitschrittVon(Date.now()) + v);
async function seed(p) {
  await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true),($1,'rest-api','/virtual/rest-api',true)", [p, HA, '/synthetic/' + p]);
  await pool.query('INSERT INTO project_host_bindings(project,hostname,enabled,updated_at) VALUES($1,$2,true,NOW())', [p, HA]);
  await pool.query("INSERT INTO memories(id,project,name,content) VALUES($1,$2,'m','t31r')", [p + '-m', p]);
}
const zaehle = async (p) => Number((await pool.query(
  'SELECT (SELECT count(*) FROM projects WHERE name=$1) + (SELECT count(*) FROM memories WHERE project=$1) + (SELECT count(*) FROM project_host_bindings WHERE project=$1) AS n', [p])).rows[0].n);
async function aufraeumen() {
  for (const p of [P, N]) {
    for (const [t, c] of [['memories', 'project'], ['project_host_bindings', 'project'], ['projects', 'name'], ['loesch_auftraege', 'project']]) {
      await pool.query(`DELETE FROM ${t} WHERE ${c}=$1`, [p]);
    }
  }
  await pool.query('DELETE FROM loesch_auftraege WHERE hostname = ANY($1::text[])', [[HA, HB]]);
  await pool.query('DELETE FROM loesch_geheimnisse WHERE hostname = ANY($1::text[])', [[HA, HB]]);
  await pool.query('DELETE FROM loesch_login_fehlversuche WHERE hostname = ANY($1::text[])', [[HA, HB]]);
}

before(async () => {
  if (!testDb) return;
  qdrantServer = await qdrantFake();
  process.env.QDRANT_URL = `http://127.0.0.1:${qdrantServer.address().port}`;
  delete process.env.QDRANT_API_KEY;
  core = await import('@synapse/core');
  pool = core.getPool();
  assert.equal((await pool.query('SELECT current_database() d')).rows[0].d, 'synapse_test');
  await pool.query(core.LOESCH_TOKEN_SCHEMA_SQL);
  await aufraeumen();
  await seed(P); await seed(N);
  const { registerLoeschRoutes } = await import('../dist/routes/loesch-routes.js');
  const Fastify = createRequire(new URL('../package.json', import.meta.url))('fastify');
  f = Fastify({ logger: false });
  await registerLoeschRoutes(f, {
    validateToken: async (t) => TOKENS[t] ?? null,
    verifyTotp: async (c) => { totpAufrufe++; return c === '111111'; },
    service: { daemonHost: async (h) => HOSTS[h] ?? null },
    psql: () => undefined,
  });
  await f.ready();
});
after(async () => {
  if (!testDb) return;
  await aufraeumen();
  await f?.close();
  await core.closePool?.();
  qdrantServer?.close();
});

test('Zugang: ohne Token 401, ohne Vertrag 426', { skip }, async () => {
  assert.equal((await call('GET', '/api/loesch-token/status', null)).status, 401);
  assert.equal((await call('GET', '/api/loesch-token/status', 'daemon-a', undefined, { vertrag: false })).status, 426);
});

test('Einrichten nur mit Daemon-Zugang des eigenen Rechners + Login-Code; QR nur in dieser Antwort', { skip }, async () => {
  for (const [tok, code] of [['web', 'daemon_host_erforderlich'], ['access', 'daemon_host_erforderlich'], ['oauth', 'daemon_host_erforderlich'], ['daemon-x', 'daemon_host_nicht_gebunden']]) {
    const r = await call('POST', '/api/loesch-token/einrichten', tok, { login_code: '111111' });
    assert.deepEqual([r.status, r.json?.error?.code], [403, code], tok);
  }
  const falsch = await call('POST', '/api/loesch-token/einrichten', 'daemon-a', { login_code: '222222' });
  assert.deepEqual([falsch.status, falsch.json.error.code], [403, 'login_code_ungueltig']);
  assert.equal((await pool.query('SELECT count(*) n FROM loesch_geheimnisse WHERE hostname=$1', [HA])).rows[0].n, '0', 'nichts angelegt');
  const ok = await call('POST', '/api/loesch-token/einrichten', 'daemon-a', { login_code: '111 111' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.hostname, HA);
  assert.match(ok.json.qr, /^data:image\/png;base64,/);
  assert.match(ok.json.otpauth_uri, /^otpauth:\/\/totp\/Synapse-Loeschen%3Apc-t31r-a\?secret=[A-Z2-7]+&issuer=Synapse-Loeschen/);
  assert.equal(ok.headers['cache-control'], 'no-store');
  geheimA = new URL(ok.json.otpauth_uri.replace('otpauth://', 'http://x/')).searchParams.get('secret');
  // Rechner B kann die Einrichtung von A nicht bestaetigen (bestaetigt nur seine eigene, die es nicht gibt)
  const b = await call('POST', '/api/loesch-token/bestaetigen', 'daemon-b', { code: codeA(-1) });
  assert.deepEqual([b.status, b.json.error.code], [409, 'keine_einrichtung_offen']);
  const web = await call('POST', '/api/loesch-token/bestaetigen', 'web', { code: codeA(-1) });
  assert.equal(web.status, 403);
  const best = await call('POST', '/api/loesch-token/bestaetigen', 'daemon-a', { code: codeA(-1) });
  assert.equal(best.status, 200, best.text);
  assert.equal(best.json.eingerichtet, true);
  const st = await call('GET', '/api/loesch-token/status', 'daemon-a');
  assert.deepEqual([st.json.hostname, st.json.eingerichtet, st.json.einrichtung_offen], [HA, true, false]);
  assert.ok(!st.text.includes(geheimA), 'Status nennt kein Geheimnis');
  const stWeb = await call('GET', `/api/loesch-token/status?hostname=${HA}`, 'web');
  assert.equal(stWeb.json.eingerichtet, true);
  assert.equal((await call('GET', `/api/loesch-token/status?hostname=${HA}`, 'access')).status, 403);
});

test('Vorschau/Ausfuehren: Rechner-Bindung des Zugangs, falscher Code zaehlt, richtiger Code loescht nur das Projekt', { skip }, async () => {
  const vorher = { p: await zaehle(P), n: await zaehle(N) };
  assert.equal((await call('POST', `/api/projects/${P}/loeschen/vorschau`, 'access', { hostname: HA })).status, 403);
  assert.equal((await call('POST', `/api/projects/${P}/loeschen/vorschau`, 'oauth', { hostname: HA })).status, 403);
  const fremd = await call('POST', `/api/projects/${P}/loeschen/vorschau`, 'daemon-b', { hostname: HA });
  assert.deepEqual([fremd.status, fremd.json.error.code], [403, 'host_verboten']);
  const gesch = await call('POST', '/api/projects/synapse/loeschen/vorschau', 'web', { hostname: HA });
  assert.deepEqual([gesch.status, gesch.json.error.code], [403, 'geschuetztes_projekt']);

  const v = await call('POST', `/api/projects/${P}/loeschen/vorschau`, 'daemon-a', {});
  assert.equal(v.status, 200, v.text);
  assert.equal(v.json.status, 'vorschau', JSON.stringify(v.json.blockiert));
  assert.equal(v.json.hostname, HA);
  assert.ok(qdrantAnfragen > 0, 'Vorschau fragt nur den Fake-Qdrant (127.0.0.1)');
  assert.ok(!v.text.includes(geheimA) && !v.text.includes(codeA()), 'kein Geheimnis/Code in der Vorschau');
  const id = v.json.loesch_auftrag_id;
  const auftrag = (await pool.query('SELECT erstellt_von FROM loesch_auftraege WHERE id=$1', [id])).rows[0];
  assert.equal(auftrag.erstellt_von, 'tray:' + HA);

  const b = await call('POST', `/api/loesch-auftraege/${id}/ausfuehren`, 'daemon-b', { loesch_code: codeA() });
  assert.deepEqual([b.status, b.json.error.code], [403, 'host_verboten']);
  assert.equal((await call('POST', `/api/loesch-auftraege/${id}/ausfuehren`, 'access', { loesch_code: codeA() })).status, 403);
  const ohne = await call('POST', `/api/loesch-auftraege/${id}/ausfuehren`, 'web', {});
  assert.deepEqual([ohne.status, ohne.json.error.code], [403, 'code_ungueltig'], 'ohne Code kein Loeschen');
  const st = (await pool.query('SELECT status, fehlversuche FROM loesch_auftraege WHERE id=$1', [id])).rows[0];
  assert.deepEqual(st, { status: 'offen', fehlversuche: 1 }, 'host_verboten/403 zaehlen nicht, fehlender Code zaehlt');
  assert.deepEqual({ p: await zaehle(P), n: await zaehle(N) }, vorher, 'noch nichts geloescht');
  assert.equal((await call('GET', `/api/loesch-auftraege/${id}`, 'access')).status, 403);

  const ok = await call('POST', `/api/loesch-auftraege/${id}/ausfuehren`, 'web', { loesch_code: codeA() });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.status, 'geloescht');
  assert.equal(await zaehle(P), 0, 'Projekt weg');
  assert.equal(await zaehle(N), vorher.n, 'Nachbar t31r-p-2 unveraendert');
  const nochmal = await call('POST', `/api/loesch-auftraege/${id}/ausfuehren`, 'web', { loesch_code: codeA() });
  assert.deepEqual([nochmal.status, nochmal.json.error.code], [409, 'auftrag_nicht_offen']);

  // Daemon-Ordnerauftrag: nur Rechner A holt ab und schliesst ab
  const cb = await call('POST', '/api/project-init/projekt-loeschen/claim', 'daemon-b', {});
  assert.deepEqual(cb.json.jobs, []);
  assert.equal((await call('POST', '/api/project-init/projekt-loeschen/claim', 'web', {})).status, 403);
  const ca = await call('POST', '/api/project-init/projekt-loeschen/claim', 'daemon-a', {});
  assert.deepEqual(ca.json.jobs.map((j) => [j.project, j.pfad]), [[P, '/synthetic/' + P]]);
  const jid = ca.json.jobs[0].id;
  assert.equal((await call('POST', `/api/project-init/projekt-loeschen/${jid}/complete`, 'daemon-b', { status: 'done' })).status, 404);
  assert.equal((await call('POST', `/api/project-init/projekt-loeschen/${jid}/complete`, 'daemon-a', { status: 'kaputt' })).status, 400);
  assert.equal((await call('POST', `/api/project-init/projekt-loeschen/${jid}/complete`, 'daemon-a', { status: 'done', message: 't31r' })).status, 200);
  const fertig = await call('GET', `/api/loesch-auftraege/${id}`, 'web');
  assert.deepEqual([fertig.json.loesch_auftrag.status, fertig.json.loesch_auftrag.ordner_status], ['ausgefuehrt', 'done']);

  // B2: Daemon-Zugang sieht nur Auftraege SEINES Rechners; fremd = 404 wie eine unbekannte ID, ohne Details.
  const eigen = await call('GET', `/api/loesch-auftraege/${id}`, 'daemon-a');
  assert.equal(eigen.status, 200, eigen.text);
  assert.equal(eigen.json.loesch_auftrag.hostname, HA);
  const fremdSt = await call('GET', `/api/loesch-auftraege/${id}`, 'daemon-b');
  assert.deepEqual([fremdSt.status, fremdSt.json.error.code], [404, 'auftrag_unbekannt']);
  assert.ok(!fremdSt.text.includes(P) && !fremdSt.text.includes('/synthetic/') && !fremdSt.text.includes(HA), 'keine Details: ' + fremdSt.text);
  const unbekannt = await call('GET', '/api/loesch-auftraege/00000000-0000-4000-8000-000000000000', 'daemon-b');
  assert.deepEqual([unbekannt.status, unbekannt.text], [fremdSt.status, fremdSt.text], 'fremder Auftrag nicht von unbekannter ID unterscheidbar');
  const ungebunden = await call('GET', `/api/loesch-auftraege/${id}`, 'daemon-x');
  assert.deepEqual([ungebunden.status, ungebunden.json.error.code], [403, 'daemon_host_nicht_gebunden']);
  assert.equal((await call('GET', `/api/loesch-auftraege/${id}`, 'web')).status, 200, 'Web-UI-User sieht weiter jeden Auftrag');
});

test('B3: Login-Code beim Einrichten je Rechner begrenzt: 5 Fehlversuche -> 429 auch mit richtigem Code (ohne Pruefung), anderer Rechner frei, Sperre laeuft ab', { skip }, async () => {
  await pool.query('DELETE FROM loesch_login_fehlversuche WHERE hostname=$1', [HB]);
  for (const login of ['abc', '222221', '222222', '222223', '222224']) {
    const r = await call('POST', '/api/loesch-token/einrichten', 'daemon-b', { login_code: login });
    assert.deepEqual([r.status, r.json.error.code], [403, 'login_code_ungueltig'], login);
  }
  assert.equal((await pool.query('SELECT count(*) n FROM loesch_login_fehlversuche WHERE hostname=$1', [HB])).rows[0].n, '5');
  const vorAufrufe = totpAufrufe;
  const gesperrt = await call('POST', '/api/loesch-token/einrichten', 'daemon-b', { login_code: '111111' });
  assert.deepEqual([gesperrt.status, gesperrt.json.error.code], [429, 'login_gesperrt'], gesperrt.text);
  assert.equal(totpAufrufe, vorAufrufe, 'gesperrt -> Login-Code wird gar nicht geprueft');
  assert.equal(gesperrt.headers['cache-control'], 'no-store');
  assert.equal((await pool.query('SELECT count(*) n FROM loesch_geheimnisse WHERE hostname=$1', [HB])).rows[0].n, '0', 'nichts eingerichtet');
  assert.equal((await pool.query('SELECT count(*) n FROM loesch_login_fehlversuche WHERE hostname=$1', [HB])).rows[0].n, '5', 'gesperrter Versuch zaehlt nicht weiter');
  // Sperre ist je Rechner: Rechner A wird normal geprueft (falscher Code -> 403, nicht 429).
  const a = await call('POST', '/api/loesch-token/einrichten', 'daemon-a', { login_code: '333333' });
  assert.deepEqual([a.status, a.json.error.code], [403, 'login_code_ungueltig']);
  // Ablauf: Fehlversuche aelter als das Fenster (15 Min) -> wieder frei.
  await pool.query("UPDATE loesch_login_fehlversuche SET created_at = NOW() - interval '16 minutes' WHERE hostname=$1", [HB]);
  const ok = await call('POST', '/api/loesch-token/einrichten', 'daemon-b', { login_code: '111111' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.hostname, HB);
  const bestaetigungsFehlversuche = ['222220', '222221', '222222', '222223', '222224'];
  for (const code of bestaetigungsFehlversuche) {
    const r = await call('POST', '/api/loesch-token/bestaetigen', 'daemon-b', { code });
    assert.equal(r.status, 403, r.text);
  }
  assert.equal((await pool.query('SELECT count(*) n FROM loesch_login_fehlversuche WHERE hostname=$1', [HB])).rows[0].n, '10');
  const gesperrteBestaetigung = await call('POST', '/api/loesch-token/bestaetigen', 'daemon-b', { code: '111111' });
  assert.deepEqual([gesperrteBestaetigung.status, gesperrteBestaetigung.json.error.code], [429, 'login_gesperrt']);
  assert.equal((await pool.query('SELECT neues_geheimnis FROM loesch_geheimnisse WHERE hostname=$1', [HB])).rows[0].neues_geheimnis !== null, true, 'Sperre lässt Einrichtung offen');
});
