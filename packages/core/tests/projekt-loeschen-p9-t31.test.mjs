/**
 * P9-T31 Testphase: Sicheres Loeschen mit rechnergebundenem Loesch-Code.
 *
 * ABSICHERUNG: NUR gegen synapse_test (:5433/synapse_test, DATABASE_URL des Shell-Jobs). Eigene Testprojekte
 * t31-abc (wird geloescht), Nachbarn t31-abc-2 und t31-abc_x (muessen UNVERAENDERT bleiben), t31-q (Replay).
 * Rechner sind synthetisch (pc-t31-a, pc-t31-b), Pfade /synthetic/… (nie ~/dev). Qdrant ist ein Fake.
 * Aufraeumen am Ende: nur Zeilen dieser Testprojekte/Testrechner.
 * Voraussetzung: core gebaut (pnpm --filter @synapse/core build).
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
const testDb = url.port === '5433' && url.pathname === '/synapse_test';
process.env.SYNAPSE_DATABASE_URL = url.href;

const P = 't31-abc', N1 = 't31-abc-2', N2 = 't31-abc_x', Q = 't31-q';
const HA = 'pc-t31-a', HB = 'pc-t31-b';
const PROJEKTE = [P, N1, N2, Q];
let core, pool;
const fakeQdrant = { geloescht: [], liste: async () => [...PROJEKTE.flatMap((p) => core.projektCollections(p)), 'fremde_collection'], punkte: async () => 7, loesche: async (n) => { fakeQdrant.geloescht.push(n); } };
const geheim = {};

function codeFuer(host, versatzSchritte = 0) {
  return core.totpCode(core.base32Dekodieren(geheim[host]), core.zeitschrittVon(Date.now()) + versatzSchritte);
}
async function richteEin(host) {
  const e = await core.loeschTokenEinrichten(host, { db: pool, von: 'test-t31' });
  geheim[host] = new URL(e.otpauth_uri.replace('otpauth://', 'http://x/')).searchParams.get('secret');
  // Bestaetigung mit dem vorherigen Zeitschritt, damit der aktuelle Code danach noch frei ist.
  await core.loeschTokenBestaetigen(host, codeFuer(host, -1), { db: pool });
}
async function seed(p, host) {
  await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true),($1,'rest-api','/virtual/rest-api',true)", [p, host, '/synthetic/' + p]);
  await pool.query('INSERT INTO project_host_bindings(project,hostname,enabled,updated_at) VALUES($1,$2,true,NOW())', [p, host]);
  for (let i = 0; i < 3; i++) {
    await pool.query("INSERT INTO memories(id,project,name,content) VALUES($1,$2,$3,'t31')", [p + '-m' + i, p, 'm' + i]);
    await pool.query("INSERT INTO thoughts(id,project,source,content) VALUES($1,$2,'test-t31','t31')", [p + '-t' + i, p]);
  }
  await pool.query("INSERT INTO plans(id,project,name) VALUES($1,$2,'t31')", [p + '-plan', p]);
  await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,ignored) VALUES($1,$2,'a.ts','a.ts','ts','x',false)", [p + '-f', p]);
  const v1 = (await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,size_bytes) VALUES($1,'a.ts','x','h',1) RETURNING id", [p])).rows[0].id;
  await pool.query("INSERT INTO file_versions(project,file_path,content,content_hash,size_bytes,parent_version_id) VALUES($1,'a.ts','y','h2',1,$2)", [p, v1]);
  const ev = (await pool.query("INSERT INTO agent_events(project,event_type,priority,scope,source_id) VALUES($1,'ANNOUNCEMENT','normal','all','test-t31') RETURNING id", [p])).rows[0].id;
  await pool.query("INSERT INTO agent_event_acks(event_id,agent_id) VALUES($1,'test-t31')", [ev]);
  const ch = (await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('t31-kanal',$1,'test-t31') RETURNING id", [p])).rows[0].id;
  await pool.query("INSERT INTO specialist_channel_members(channel_id,agent_name,last_read_message_id,read_initialized_at) VALUES($1,'test-t31',0,NOW())", [ch]);
}
const ZAEHL = ['projects:name', 'project_host_bindings:project', 'memories:project', 'thoughts:project', 'plans:project', 'code_files:project', 'file_versions:project', 'agent_events:project', 'specialist_channels:project'];
async function stand(p) {
  const s = {};
  for (const z of ZAEHL) { const [t, c] = z.split(':'); s[t] = Number((await pool.query(`SELECT count(*) n FROM ${t} WHERE ${c}=$1`, [p])).rows[0].n); }
  s.acks = Number((await pool.query('SELECT count(*) n FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [p])).rows[0].n);
  s.members = Number((await pool.query('SELECT count(*) n FROM specialist_channel_members WHERE channel_id IN (SELECT id FROM specialist_channels WHERE project=$1)', [p])).rows[0].n);
  return s;
}
async function aufraeumen() {
  for (const p of PROJEKTE) {
    await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=$1)', [p]);
    await pool.query('DELETE FROM specialist_channel_members WHERE channel_id IN (SELECT id FROM specialist_channels WHERE project=$1)', [p]);
    for (const z of [...ZAEHL].reverse()) { const [t, c] = z.split(':'); await pool.query(`DELETE FROM ${t} WHERE ${c}=$1`, [p]); }
    await pool.query('DELETE FROM loesch_auftraege WHERE project=$1', [p]);
  }
  await pool.query('DELETE FROM loesch_geheimnisse WHERE hostname = ANY($1::text[])', [[HA, HB]]);
}
const vorschau = (o) => core.projektLoeschenVorschau({ db: pool, qdrant: fakeQdrant, konfig: null, agent: 'test-t31', ...o });
const ausfuehren = (o) => core.projektLoeschenAusfuehren({ db: pool, qdrant: fakeQdrant, konfig: null, agent: 'test-t31', ...o });

before(async () => {
  if (!testDb) return;
  core = await import('../dist/index.js');
  pool = core.getPool();
  assert.equal((await pool.query('SELECT current_database() d')).rows[0].d, 'synapse_test');
  await pool.query(core.LOESCH_TOKEN_SCHEMA_SQL);
  await aufraeumen();
  await seed(P, HB); await seed(N1, HA); await seed(N2, HB); await seed(Q, HB);
  await richteEin(HA); await richteEin(HB);
});
after(async () => { if (testDb) { await aufraeumen(); await core.closePool?.(); } });

test('Base32/TOTP: RFC-6238-Vektor (SHA1, 8 Stellen -> letzte 6)', { skip: !testDb && 'kein synapse_test' }, () => {
  const g = Buffer.from('12345678901234567890');
  assert.equal(core.base32Dekodieren(core.base32Kodieren(g)).toString(), g.toString());
  assert.equal(core.totpCode(g, Math.floor(59 / 30)), '287082'); // RFC 6238: 94287082
  assert.equal(core.normiereLoeschCode(12345), '012345');
  assert.equal(core.normiereLoeschCode('12a456'), null);
});

test('geschuetzte und ungueltige Projekte sind nie loeschbar', { skip: !testDb && 'kein synapse_test' }, async () => {
  for (const project of ['synapse', 'Synapse', 'reverse-bibliothek']) {
    await assert.rejects(vorschau({ project, hostname: HB }), (e) => e.code === 'geschuetztes_projekt');
  }
  for (const project of ['', 'a', '../x', 'x y', null]) {
    await assert.rejects(vorschau({ project, hostname: HB }), (e) => e.code === 'invalid_name');
  }
  await assert.rejects(vorschau({ project: P, hostname: 'rest-api' }), (e) => e.code === 'virtueller_host');
});

test('Vorschau loescht nichts, nennt keinen Code; zentral blockiert bei Rechner-Bindung', { skip: !testDb && 'kein synapse_test' }, async () => {
  const vorher = await stand(P);
  const v = await vorschau({ project: P, hostname: HB });
  assert.equal(v.status, 'vorschau');
  assert.match(v.loesch_auftrag_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await stand(P), vorher, 'Vorschau aendert nichts');
  const text = JSON.stringify(v);
  assert.ok(!text.includes(geheim[HB]) && !text.includes(codeFuer(HB)), 'kein Geheimnis/Code in der Antwort');
  const z = await vorschau({ project: P, hostname: HB, umfang: 'zentral' });
  assert.equal(z.status, 'blockiert');
  assert.ok(z.blockiert.some((b) => b.grund === 'weitere_rechner'));
  assert.equal(z.loesch_auftrag_id, null);
});

test('falscher, abgelaufener, Login- und Fremdrechner-Code werden abgelehnt; 3 Fehlversuche -> verfallen', { skip: !testDb && 'kein synapse_test' }, async () => {
  const v = await vorschau({ project: P, hostname: HB });
  const vorher = await stand(P);
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(HA) }), (e) => e.code === 'code_ungueltig', 'Code von Rechner A fuer Auftrag auf B');
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(HB, -8) }), (e) => e.code === 'code_ungueltig', 'abgelaufen (4 Min alt)');
  const login = (await pool.query('SELECT secret FROM auth_totp WHERE id=1')).rows[0]?.secret;
  const loginCode = login ? core.totpCode(core.base32Dekodieren(login), core.zeitschrittVon(Date.now())) : '000000';
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: loginCode }), (e) => e.code === 'code_ungueltig' || e.code === 'auftrag_nicht_offen', 'Login-TOTP');
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(HB) }), (e) => e.code === 'auftrag_nicht_offen', 'nach 3 Fehlversuchen verfallen');
  assert.deepEqual(await stand(P), vorher, 'nichts geloescht');
  // Sperre wieder loesen, damit die weiteren Faelle laufen.
  await pool.query('UPDATE loesch_auftraege SET fehlversuche=0 WHERE hostname = ANY($1::text[])', [[HA, HB]]);
});

test('Umfang geaendert -> Auftrag verfaellt, Code wird nicht verbraucht, nichts geloescht', { skip: !testDb && 'kein synapse_test' }, async () => {
  const v = await vorschau({ project: P, hostname: HB });
  await pool.query("INSERT INTO thoughts(id,project,source,content) VALUES($1,$2,'test-t31','neu')", [P + '-neu', P]);
  const vorher = await stand(P);
  await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(HB) }), (e) => e.code === 'umfang_geaendert');
  assert.deepEqual(await stand(P), vorher);
});

test('komplett: nur t31-abc weg, Nachbarn unveraendert, Ordner-Auftrag nur fuer Rechner B; Code nur einmal', { skip: !testDb && 'kein synapse_test' }, async () => {
  const nachbarn = { [N1]: await stand(N1), [N2]: await stand(N2), [Q]: await stand(Q) };
  const v = await vorschau({ project: P, hostname: HB });
  const code = codeFuer(HB);
  const r = await ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: code });
  assert.equal(r.success, true);
  const nach = await stand(P);
  assert.ok(Object.values(nach).every((n) => n === 0), 'alle Zeilen von t31-abc weg: ' + JSON.stringify(nach));
  for (const [p, s] of Object.entries(nachbarn)) assert.deepEqual(await stand(p), s, p + ' unveraendert');
  assert.deepEqual([...fakeQdrant.geloescht].sort(), core.projektCollections(P).sort(), 'nur exakt die Collections von t31-abc');
  assert.deepEqual(await core.claimOrdnerLoeschungen(HA, pool), [], 'Rechner A bekommt keinen Auftrag');
  const jobs = await core.claimOrdnerLoeschungen(HB, pool);
  assert.deepEqual(jobs.map((j) => [j.project, j.pfad]), [[P, '/synthetic/' + P]]);
  await core.schliesseOrdnerLoeschung(jobs[0].id, HB, { status: 'done', message: 'test' }, pool);
  // Replay: derselbe Code fuer einen neuen Auftrag (anderes Projekt, gleicher Rechner) gilt nicht mehr.
  await pool.query('DELETE FROM projects WHERE name=$1 AND hostname=$2', [Q, HB]);
  await pool.query('DELETE FROM project_host_bindings WHERE project=$1', [Q]);
  const vq = await vorschau({ project: Q, hostname: HB, umfang: 'zentral' });
  assert.equal(vq.status, 'vorschau');
  await assert.rejects(ausfuehren({ loesch_auftrag_id: vq.loesch_auftrag_id, loesch_code: code }), (e) => e.code === 'code_ungueltig', 'Code zweimal benutzt');
  const rq = (await pool.query('SELECT status FROM loesch_auftraege WHERE id=$1', [v.loesch_auftrag_id])).rows[0];
  assert.equal(rq.status, 'ausgefuehrt');
});

test('loesch_code taucht in keinem Tool-Log auf', { skip: !testDb && 'kein synapse_test' }, async () => {
  const s = await import('../dist/services/tool-args-schwaerzen.js');
  for (const args of [{ action: 'loeschen', loesch_auftrag_id: 'x', loesch_code: '493817' }, { action: 'loeschen', loesch_code: 493817 }]) {
    const text = s.schwaerzeToolLogText(JSON.stringify(args));
    assert.ok(!text.includes('493817'), text);
  }
});
