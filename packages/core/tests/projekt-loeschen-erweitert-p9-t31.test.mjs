/**
 * P9-T31 Testphase (TP-B, claude-tpb2): erweiterte Faelle zum sicheren Loeschen.
 *
 * ABSICHERUNG: NUR gegen synapse_test (:5433/synapse_test, DATABASE_URL des Shell-Jobs), sonst wird alles
 * uebersprungen. Eigene Testprojekte t31x-*, synthetische Rechner pc-t31x-*, Pfade /synthetic/… (nie ~/dev).
 * Qdrant und psql sind Fakes (es wird KEINE Datenbank gedroppt). Zwei Probe-Tabellen (t31x_probe,
 * t31x_kaskade) entstehen nur kurz in synapse_test und werden im finally/after wieder entfernt.
 * Ein Login-TOTP (auth_totp id=1) wird nur angelegt, wenn synapse_test keinen hat, und danach entfernt.
 * Voraussetzung: core gebaut (pnpm --filter @synapse/core build).
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
const testDb = url.port === '5433' && url.pathname === '/synapse_test';
process.env.SYNAPSE_DATABASE_URL = url.href;
const skip = !testDb && 'kein synapse_test';

const H = { a: 'pc-t31x-a', b: 'pc-t31x-b', c: 'pc-t31x-c', d: 'pc-t31x-d', e: 'pc-t31x-e', f: 'pc-t31x-f', g: 'pc-t31x-g', s: 'pc-t31x-s', n: 'pc-t31x-n', l: 'pc-t31x-l' };
const HOSTS = Object.values(H);
const PR = {
  r: 't31x-r', blk: 't31x-blk', f: 't31x-f', fn: 't31x-fn', u: 't31x-u', k: 't31x-k', s: 't31x-s',
  n: 't31x-n', l: 't31x-l', db: 't31x-db', db2: 't31x-db2', db2n: 't31x_db2',
};
const PROJEKTE = Object.values(PR);
let core, pool, loginAngelegt = false;
const fakeQdrant = { geloescht: [], liste: async () => PROJEKTE.flatMap((p) => core.projektCollections(p)), punkte: async () => 3, loesche: async (n) => { fakeQdrant.geloescht.push(n); } };
const geheim = {};
const DB_KONFIG = { host: '192.168.50.65', port: 5433, container: 'postgresql16_2', adminUser: 'postgres' };

const codeFuer = (host, versatz = 0) => core.totpCode(core.base32Dekodieren(geheim[host]), core.zeitschrittVon(Date.now()) + versatz);
async function richteEin(host) {
  const e = await core.loeschTokenEinrichten(host, { db: pool, von: 'test-t31x' });
  geheim[host] = new URL(e.otpauth_uri.replace('otpauth://', 'http://x/')).searchParams.get('secret');
  await core.loeschTokenBestaetigen(host, codeFuer(host, -1), { db: pool });
}
async function seed(p, hosts) {
  for (const h of hosts) {
    await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)', [p, h, `/synthetic/${h}/${p}`]);
    await pool.query('INSERT INTO project_host_bindings(project,hostname,enabled,updated_at) VALUES($1,$2,true,NOW())', [p, h]);
  }
  await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'rest-api','/virtual/rest-api',true)", [p]);
  for (let i = 0; i < 3; i++) await pool.query("INSERT INTO memories(id,project,name,content) VALUES($1,$2,$3,'t31x')", [`${p}-m${i}`, p, 'm' + i]);
  await pool.query("INSERT INTO thoughts(id,project,source,content) VALUES($1,$2,'test-t31x','t31x')", [p + '-t', p]);
}
async function zaehle(p) {
  const n = async (sql, args = [p]) => Number((await pool.query(sql, args)).rows[0].n);
  return {
    projects: await n('SELECT count(*) n FROM projects WHERE name=$1'),
    bindings: await n('SELECT count(*) n FROM project_host_bindings WHERE project=$1'),
    memories: await n('SELECT count(*) n FROM memories WHERE project=$1'),
    thoughts: await n('SELECT count(*) n FROM thoughts WHERE project=$1'),
    file_versions: await n('SELECT count(*) n FROM file_versions WHERE project=$1'),
    projekt_db: await n('SELECT count(*) n FROM projekt_datenbanken WHERE project=$1'),
  };
}
async function aufraeumen() {
  await pool.query('DROP TABLE IF EXISTS t31x_kaskade');
  await pool.query('DROP TABLE IF EXISTS t31x_probe');
  for (const p of PROJEKTE) {
    // Kinder zuerst (SET-NULL-Verweis zwischen t31x-fn und t31x-f).
    await pool.query('UPDATE file_versions SET parent_version_id = NULL WHERE project=$1', [p]);
  }
  for (const p of PROJEKTE) {
    for (const [t, c] of [['file_versions', 'project'], ['memories', 'project'], ['thoughts', 'project'], ['project_host_bindings', 'project'],
      ['asset_projekt_optionen', 'project'], ['project_workspaces', 'project'], ['projekt_datenbanken', 'project'], ['projects', 'name'], ['loesch_auftraege', 'project']]) {
      await pool.query(`DELETE FROM ${t} WHERE ${c}=$1`, [p]);
    }
  }
  await pool.query('DELETE FROM loesch_auftraege WHERE hostname = ANY($1::text[])', [HOSTS]);
  await pool.query('DELETE FROM loesch_geheimnisse WHERE hostname = ANY($1::text[])', [HOSTS]);
}
const vorschau = (o) => core.projektLoeschenVorschau({ db: pool, qdrant: fakeQdrant, konfig: null, agent: 'test-t31x', ...o });
const ausfuehren = (o) => core.projektLoeschenAusfuehren({ db: pool, qdrant: fakeQdrant, konfig: null, agent: 'test-t31x', ...o });
const auftragStatus = async (id) => (await pool.query('SELECT status, fehlversuche FROM loesch_auftraege WHERE id=$1', [id])).rows[0];

before(async () => {
  if (!testDb) return;
  core = await import('../dist/index.js');
  pool = core.getPool();
  assert.equal((await pool.query('SELECT current_database() d')).rows[0].d, 'synapse_test');
  await pool.query(core.LOESCH_TOKEN_SCHEMA_SQL);
  await aufraeumen();
  for (const h of [H.a, H.b, H.d, H.e, H.f, H.g, H.s, H.n, H.l]) await richteEin(h);
});
after(async () => { if (testDb) { await aufraeumen(); await core.closePool?.(); } });

test('umfang rechner: nur Zeilen dieses Rechners weg, zentrale Daten + anderer Rechner bleiben; danach komplett vom letzten Rechner', { skip }, async () => {
  await seed(PR.r, [H.a, H.b]);
  const vorher = await zaehle(PR.r);
  assert.deepEqual(vorher, { projects: 3, bindings: 2, memories: 3, thoughts: 1, file_versions: 0, projekt_db: 0 });
  // komplett auf B ist blockiert, solange A gebunden ist
  const blockiert = await vorschau({ project: PR.r, hostname: H.b });
  assert.equal(blockiert.status, 'blockiert');
  assert.ok(blockiert.blockiert.some((b) => b.grund === 'weitere_rechner' && b.detail.includes(H.a)));

  const v = await vorschau({ project: PR.r, hostname: H.b, umfang: 'rechner' });
  assert.equal(v.status, 'vorschau', JSON.stringify(v.blockiert));
  assert.equal(v.zentral, null, 'rechner-Umfang zeigt keine zentralen Daten');
  assert.deepEqual(v.ordner && [v.ordner.hostname, v.ordner.pfad], [H.b, `/synthetic/${H.b}/${PR.r}`]);
  const r = await ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(H.b) });
  assert.equal(r.success, true);
  assert.deepEqual(await zaehle(PR.r), { ...vorher, projects: 2, bindings: 1 }, 'nur Registry-Zeile + Bindung von B weg');
  const rest = (await pool.query('SELECT hostname FROM projects WHERE name=$1 ORDER BY hostname', [PR.r])).rows.map((z) => z.hostname);
  assert.deepEqual(rest, [H.a, 'rest-api']);
  assert.deepEqual(fakeQdrant.geloescht, [], 'rechner-Umfang loescht keine Collections');
  const jobsB = await core.claimOrdnerLoeschungen(H.b, pool);
  assert.deepEqual(jobsB.map((j) => j.pfad), [`/synthetic/${H.b}/${PR.r}`]);
  assert.deepEqual(await core.claimOrdnerLoeschungen(H.a, pool), []);
  // Fremder Rechner darf den Ordner-Auftrag von B nicht abschliessen
  await assert.rejects(core.schliesseOrdnerLoeschung(jobsB[0].id, H.a, { status: 'done' }, pool), (e) => e.code === 'ordner_job_unbekannt');
  await core.schliesseOrdnerLoeschung(jobsB[0].id, H.b, { status: 'done', message: 'test' }, pool);

  // Jetzt ist nur noch A gebunden -> komplett auf A erlaubt
  const k = await vorschau({ project: PR.r, hostname: H.a });
  assert.equal(k.status, 'vorschau', JSON.stringify(k.blockiert));
  const rk = await ausfuehren({ loesch_auftrag_id: k.loesch_auftrag_id, loesch_code: codeFuer(H.a) });
  assert.equal(rk.status, 'geloescht');
  assert.deepEqual(await zaehle(PR.r), { projects: 0, bindings: 0, memories: 0, thoughts: 0, file_versions: 0, projekt_db: 0 });
  assert.deepEqual([...fakeQdrant.geloescht].sort(), core.projektCollections(PR.r).sort());
  fakeQdrant.geloescht.length = 0;
});

test('Blockaden: kein Rechner/kein Loesch-Code, Assets, Workspace-Container -> kein Auftrag, nichts geloescht', { skip }, async () => {
  await seed(PR.blk, [H.a]);
  const vorher = await zaehle(PR.blk);
  const c = await vorschau({ project: PR.blk, hostname: H.c, umfang: 'rechner' });
  assert.equal(c.status, 'blockiert');
  assert.deepEqual(c.blockiert.map((b) => b.grund).sort(), ['kein_loesch_token', 'nicht_auf_rechner']);
  assert.equal(c.loesch_auftrag_id, null);
  await pool.query('INSERT INTO asset_projekt_optionen(project) VALUES($1)', [PR.blk]);
  await pool.query("INSERT INTO project_workspaces(project, container_id) VALUES($1, 'c-t31x')", [PR.blk]);
  const v = await vorschau({ project: PR.blk, hostname: H.a });
  assert.equal(v.status, 'blockiert');
  const gruende = v.blockiert.map((b) => b.grund);
  assert.ok(gruende.includes('assets_vorhanden') && gruende.includes('workspace_container'), gruende.join(','));
  assert.equal((await pool.query('SELECT count(*) n FROM loesch_auftraege WHERE project=$1', [PR.blk])).rows[0].n, '0', 'kein Auftrag angelegt');
  assert.deepEqual(await zaehle(PR.blk), vorher);
});

test('SET-NULL-Verweis eines anderen Projekts: Vorschau blockiert (B1); nach der Vorschau entstanden -> Auftrag verfaellt ohne Code-Verbrauch; Ausfuehrung prueft zusaetzlich (ROLLBACK)', { skip }, async () => {
  await seed(PR.f, [H.d]);
  await seed(PR.fn, [H.n]);
  const v1 = (await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,size_bytes) VALUES($1,'a.ts','x','h',1) RETURNING id", [PR.f])).rows[0].id;
  const fnId = (await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,size_bytes,parent_version_id) VALUES($1,'a.ts','y','h2',1,$2) RETURNING id", [PR.fn, v1])).rows[0].id;
  const setzeVerweis = (wert) => pool.query('UPDATE file_versions SET parent_version_id = $2 WHERE id = $1', [fnId, wert]);
  const verweis = async () => (await pool.query('SELECT parent_version_id p FROM file_versions WHERE id=$1', [fnId])).rows[0].p;
  const schritt = async () => (await pool.query('SELECT letzter_zeitschritt s FROM loesch_geheimnisse WHERE hostname=$1', [H.d])).rows[0].s;
  const vorher = { f: await zaehle(PR.f), fn: await zaehle(PR.fn) };

  // a) B1: Verweis besteht -> Vorschau blockiert, KEIN Auftrag (kein Code wird angefragt/verbraucht).
  const b = await vorschau({ project: PR.f, hostname: H.d });
  assert.equal(b.status, 'blockiert');
  assert.equal(b.loesch_auftrag_id, null);
  assert.ok(b.blockiert.some((x) => x.grund === 'fremde_verweise' && x.detail.startsWith('file_versions:') && x.detail.includes(PR.f)), JSON.stringify(b.blockiert));
  assert.equal((await pool.query('SELECT count(*) n FROM loesch_auftraege WHERE project=$1', [PR.f])).rows[0].n, '0', 'kein Auftrag angelegt');

  // b) Verweis entsteht erst NACH der Vorschau -> erneute Erhebung blockiert vor der Code-Pruefung: verfallen, Code nicht verbraucht.
  await setzeVerweis(null);
  const v = await vorschau({ project: PR.f, hostname: H.d });
  assert.equal(v.status, 'vorschau', JSON.stringify(v.blockiert));
  await setzeVerweis(v1);
  const code = codeFuer(H.d);
  const schrittVorher = await schritt();
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: code }),
    (e) => e.code === 'umfang_geaendert' && e.details?.blockiert?.some((x) => x.grund === 'fremde_verweise'));
  assert.deepEqual(await auftragStatus(v.loesch_auftrag_id), { status: 'verfallen', fehlversuche: 0 });
  assert.equal(String(await schritt()), String(schrittVorher), 'Loesch-Code nicht verbraucht');
  assert.deepEqual({ f: await zaehle(PR.f), fn: await zaehle(PR.fn) }, vorher, 'nichts geloescht');

  // c) Ausfuehrung behaelt die Pruefung: Verweis entsteht zwischen erneuter Erhebung und Transaktion
  //    (Fake-Qdrant setzt ihn waehrend der Erhebung der Ausfuehrung, nach deren SET-NULL-Pruefung) -> fremde_verweise, ROLLBACK.
  await setzeVerweis(null);
  const v2 = await vorschau({ project: PR.f, hostname: H.d });
  assert.equal(v2.status, 'vorschau', JSON.stringify(v2.blockiert));
  let einmal = true;
  const qdrantMitVerweis = { ...fakeQdrant, liste: async () => { if (einmal) { einmal = false; await setzeVerweis(v1); } return fakeQdrant.liste(); } };
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v2.loesch_auftrag_id, loesch_code: code, qdrant: qdrantMitVerweis }), (e) => e.code === 'fremde_verweise');
  assert.equal(einmal, false, 'Verweis wurde waehrend der Ausfuehrung gesetzt');
  assert.deepEqual({ f: await zaehle(PR.f), fn: await zaehle(PR.fn) }, vorher, 'nichts geloescht');
  assert.equal(String(await verweis()), String(v1), 'Verweis des Nachbarn nicht auf NULL gesetzt');
  assert.equal((await auftragStatus(v2.loesch_auftrag_id)).status, 'fehlgeschlagen');
  assert.deepEqual(fakeQdrant.geloescht, [], 'keine Collection geloescht');
});

test('unbekannte Tabelle mit Projektdaten blockiert die Vorschau; unbekannte CASCADE bricht die Ausfuehrung ab', { skip }, async () => {
  await seed(PR.u, [H.e]);
  await seed(PR.k, [H.e]);
  try {
    await pool.query('CREATE TABLE t31x_probe (project text, wert int)');
    await pool.query('INSERT INTO t31x_probe VALUES ($1, 1)', [PR.u]);
    const u = await vorschau({ project: PR.u, hostname: H.e });
    assert.equal(u.status, 'blockiert');
    assert.ok(u.blockiert.some((b) => b.grund === 'unbekannte_tabelle' && b.detail.startsWith('t31x_probe.project')), JSON.stringify(u.blockiert));
  } finally {
    await pool.query('DROP TABLE IF EXISTS t31x_probe');
  }
  // t31x-k ist nur auf E gebunden; u auch -> erst u's Bindung loesen ist nicht noetig, eigene Projekte.
  const vorher = await zaehle(PR.k);
  const v = await vorschau({ project: PR.k, hostname: H.e });
  assert.equal(v.status, 'vorschau', JSON.stringify(v.blockiert));
  try {
    await pool.query('CREATE TABLE t31x_kaskade (id serial PRIMARY KEY, mem_id text REFERENCES memories(id) ON DELETE CASCADE)');
    await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(H.e) }),
      (e) => e.code === 'unbekannte_kaskade' && e.message.includes('t31x_kaskade'));
  } finally {
    await pool.query('DROP TABLE IF EXISTS t31x_kaskade');
  }
  assert.deepEqual(await zaehle(PR.k), vorher, 'nichts geloescht');
  assert.equal((await auftragStatus(v.loesch_auftrag_id)).status, 'fehlgeschlagen');
});

test('Host-Sperre: 5 Fehlversuche je Rechner in 15 Min -> 429, auch mit richtigem Code; nurHost fremd -> 403 ohne Fehlversuch', { skip }, async () => {
  await seed(PR.s, [H.s]);
  const v1 = await vorschau({ project: PR.s, hostname: H.s });
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v1.loesch_auftrag_id, loesch_code: codeFuer(H.s), nurHost: H.a }),
    (e) => e.code === 'host_verboten' && e.httpStatus === 403);
  assert.deepEqual(await auftragStatus(v1.loesch_auftrag_id), { status: 'offen', fehlversuche: 0 });
  const falsch = (c) => String((Number(c) + 1) % 1e6).padStart(6, '0');
  for (let i = 0; i < 3; i++) await assert.rejects(ausfuehren({ loesch_auftrag_id: v1.loesch_auftrag_id, loesch_code: falsch(codeFuer(H.s)) }), (e) => e.code === 'code_ungueltig');
  assert.equal((await auftragStatus(v1.loesch_auftrag_id)).status, 'verfallen');
  const v2 = await vorschau({ project: PR.s, hostname: H.s });
  for (let i = 0; i < 2; i++) await assert.rejects(ausfuehren({ loesch_auftrag_id: v2.loesch_auftrag_id, loesch_code: 'abc' }), (e) => e.code === 'code_ungueltig');
  const vorher = await zaehle(PR.s);
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v2.loesch_auftrag_id, loesch_code: codeFuer(H.s) }), (e) => e.code === 'host_gesperrt' && e.httpStatus === 429);
  assert.deepEqual(await zaehle(PR.s), vorher, 'gesperrt -> nichts geloescht');
  assert.equal((await auftragStatus(v2.loesch_auftrag_id)).status, 'offen');
  // Andere Rechner sind von der Sperre nicht betroffen (Sperre ist je Rechner).
  const gesperrtA = Number((await pool.query('SELECT COALESCE(sum(fehlversuche),0) n FROM loesch_auftraege WHERE hostname=$1', [H.a])).rows[0].n);
  assert.ok(gesperrtA < 5);
});

test('neues Geheimnis gilt erst nach Bestaetigung; danach ist das alte ungueltig', { skip }, async () => {
  const pruefe = async (code) => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); return await core.pruefeLoeschCode(c, H.f, code); } finally { await c.query('ROLLBACK'); c.release(); }
  };
  const alt = geheim[H.f];
  const e = await core.loeschTokenEinrichten(H.f, { db: pool, von: 'test-t31x' });
  assert.equal(e.ersetzt_bestehendes, true);
  const neu = new URL(e.otpauth_uri.replace('otpauth://', 'http://x/')).searchParams.get('secret');
  assert.notEqual(neu, alt);
  const st = await core.loeschTokenStatus(H.f, pool);
  assert.deepEqual([st.eingerichtet, st.einrichtung_offen], [true, true]);
  assert.equal(JSON.stringify(st).includes(neu) || JSON.stringify(st).includes(alt), false, 'Status nennt kein Geheimnis');
  const neuCode = (v) => core.totpCode(core.base32Dekodieren(neu), core.zeitschrittVon(Date.now()) + v);
  assert.equal(await pruefe(codeFuer(H.f)), true, 'altes Geheimnis gilt bis zur Bestaetigung');
  assert.equal(await pruefe(neuCode(0)), false, 'neues Geheimnis vor Bestaetigung unwirksam');
  await assert.rejects(core.loeschTokenBestaetigen(H.f, codeFuer(H.f, -1), { db: pool }), (x) => x.code === 'code_ungueltig', 'Bestaetigung nur mit Code des NEUEN Geheimnisses');
  await core.loeschTokenBestaetigen(H.f, neuCode(-1), { db: pool });
  geheim[H.f] = neu;
  assert.equal(await pruefe(core.totpCode(core.base32Dekodieren(alt), core.zeitschrittVon(Date.now()))), false, 'altes Geheimnis nach Bestaetigung ungueltig');
  assert.equal(await pruefe(neuCode(0)), true);
  await assert.rejects(core.loeschTokenBestaetigen(H.f, neuCode(0), { db: pool }), (x) => x.code === 'keine_einrichtung_offen');
  await assert.rejects(core.loeschTokenEinrichten('rest-api', { db: pool }), (x) => x.code === 'virtueller_host');
});

test('Login-TOTP (auth_totp) als Loesch-Code -> abgelehnt (deterministisch mit Test-Login-Geheimnis)', { skip }, async () => {
  await seed(PR.l, [H.l]);
  let login = (await pool.query('SELECT secret FROM auth_totp WHERE id=1')).rows[0]?.secret;
  if (!login) {
    login = core.base32Kodieren(Buffer.from('t31x-login-geheimnis'));
    await pool.query('INSERT INTO auth_totp(id, secret, confirmed_at) VALUES(1, $1, NOW())', [login]);
    loginAngelegt = true;
  }
  try {
    const loginCode = core.totpCode(core.base32Dekodieren(login), core.zeitschrittVon(Date.now()));
    if (loginCode === codeFuer(H.l)) return; // 1:10^6-Zufall: Codes zufaellig gleich, Fall nicht aussagekraeftig
    const v = await vorschau({ project: PR.l, hostname: H.l });
    const vorher = await zaehle(PR.l);
    await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: loginCode }), (e) => e.code === 'code_ungueltig');
    assert.deepEqual(await zaehle(PR.l), vorher);
    assert.deepEqual(await auftragStatus(v.loesch_auftrag_id), { status: 'offen', fehlversuche: 1 });
  } finally {
    if (loginAngelegt) { await pool.query('DELETE FROM auth_totp WHERE id=1 AND secret=$1', [login]); loginAngelegt = false; }
  }
});

test('Projekt-DB: Rueckbau nur fuer eigene Synapse-DB (Fake-psql), nicht bei gleichem DB-Namen eines anderen Projekts', { skip }, async () => {
  const reg = (p, db) => pool.query("INSERT INTO projekt_datenbanken(project,host,port,db,db_user,passwort) VALUES($1,'192.168.50.65',5433,$2,$3,'test-nicht-echt')", [p, db, db + '_user']);
  // a) eigene DB -> wird_geloescht, psql bekommt genau das Rueckbau-SQL dieser DB
  await seed(PR.db, [H.g]);
  await reg(PR.db, 't31x_db');
  const psqlAufrufe = [];
  const psql = async (sql, datenbank) => { psqlAufrufe.push([sql, datenbank]); return ''; };
  const v = await vorschau({ project: PR.db, hostname: H.g, konfig: DB_KONFIG });
  assert.equal(v.status, 'vorschau', JSON.stringify(v.blockiert));
  assert.equal(v.zentral.projekt_db.wird_geloescht, true, JSON.stringify(v.zentral.projekt_db));
  const r = await ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(H.g), konfig: DB_KONFIG, psql });
  assert.equal(r.status, 'geloescht');
  assert.equal(psqlAufrufe.length, 1);
  assert.match(psqlAufrufe[0][0], /datname = 't31x_db' AND r\.rolname = 't31x_db_user'/);
  assert.match(psqlAufrufe[0][0], /DROP ROLE IF EXISTS "t31x_db_user"/);
  assert.equal(psqlAufrufe[0][1], 'postgres');
  assert.equal((await zaehle(PR.db)).projekt_db, 0, 'Registrierung entfernt');

  // b) anderes Projekt ergibt denselben DB-Namen (t31x-db2 vs t31x_db2) -> DB + Registrierung bleiben
  await seed(PR.db2, [H.g]);
  await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'rest-api','/virtual/rest-api',true)", [PR.db2n]);
  await reg(PR.db2, 't31x_db2');
  const v2 = await vorschau({ project: PR.db2, hostname: H.g, konfig: DB_KONFIG });
  assert.equal(v2.status, 'vorschau', JSON.stringify(v2.blockiert));
  assert.equal(v2.zentral.projekt_db.wird_geloescht, false);
  assert.ok(v2.zentral.projekt_db.gruende.some((g) => g.includes(PR.db2n)), JSON.stringify(v2.zentral.projekt_db.gruende));
  const psql2 = [];
  const r2 = await ausfuehren({ loesch_auftrag_id: v2.loesch_auftrag_id, loesch_code: codeFuer(H.g, 1), konfig: DB_KONFIG, psql: async (s) => { psql2.push(s); return ''; } });
  assert.equal(r2.success, true);
  assert.deepEqual(psql2, [], 'kein psql-Aufruf');
  assert.equal((await zaehle(PR.db2)).projekt_db, 1, 'Registrierung bleibt');
  assert.equal((await zaehle(PR.db2n)).projects, 1, 'Nachbar t31x_db2 unveraendert');
});

test('loesch_code wird auch gekuerzt, verschachtelt und in Schreibvarianten geschwaerzt', async () => {
  const s = await import('../dist/services/tool-args-schwaerzen.js');
  for (const text of [
    '{"action":"loeschen","loesch_auftrag_id":"x","loesch_code":"4938', // argsPreview mitten im Wert gekappt
    '{"loesch_code":"493 817"}', '{"loeschCode":"493817"}', '{"loesch-code":493817}', 'loesch_code=493817',
    '{"args":{"loesch_code":"493817"}}', '{"loesch_code": "493817" }',
  ]) {
    const neu = s.schwaerzeToolLogText(text);
    assert.ok(!/4938|493 817/.test(neu), `${text} -> ${neu}`);
  }
});
