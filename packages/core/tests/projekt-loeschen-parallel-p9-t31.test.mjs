/**
 * P9-T31 Nachbesserung (claude-f9, Abnahme 8e99d12d):
 *  HOCH     Fehlversuchs-Sperre je Rechner haelt auch bei PARALLELEN Anfragen; offene Auftraege je Rechner begrenzt;
 *           dieselbe Rennbedingung geprueft bei Login-Sperre (F7) und Replay-Schutz (letzter_zeitschritt).
 *  MITTEL 2 Fremdschluessel-Pruefung auch unterhalb der Kaskaden-Kinder (zweistufige Probe-Kaskade).
 *  NIEDRIG 4 Ansicht-Links (ansicht_tokens) blockieren die Loeschung nicht mehr; Audit bleibt; aktive Reverse-Links blockieren.
 *
 * ABSICHERUNG: NUR gegen synapse_test (:5433/synapse_test, DATABASE_URL des Shell-Jobs), sonst alles uebersprungen.
 * Eigene Testprojekte t31p-*, synthetische Rechner pc-t31p-*, Pfade /synthetic/… (nie ~/dev). Qdrant ist ein Fake,
 * kein psql. Probe-Tabellen t31p_* entstehen nur kurz und werden im finally/after entfernt.
 * Voraussetzung: core gebaut (pnpm --filter @synapse/core build).
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
const testDb = url.port === '5433' && url.pathname === '/synapse_test';
process.env.SYNAPSE_DATABASE_URL = url.href;
const skip = !testDb && 'kein synapse_test';

const H = { p: 'pc-t31p-p', q: 'pc-t31p-q', r: 'pc-t31p-r', l: 'pc-t31p-l', k: 'pc-t31p-k', k2: 'pc-t31p-k2', v: 'pc-t31p-v' };
const HOSTS = Object.values(H);
const PR = {
  p1: 't31p-p1', p2: 't31p-p2', p3: 't31p-p3', p4: 't31p-p4',
  q1: 't31p-q1', q2: 't31p-q2', q3: 't31p-q3', q4: 't31p-q4', q5: 't31p-q5', q6: 't31p-q6',
  r1: 't31p-r1', r2: 't31p-r2', r3: 't31p-r3',
  k: 't31p-k', k2: 't31p-k2', v: 't31p-v', vx: 't31p-vx', w: 't31p-w',
};
const PROJEKTE = Object.values(PR);
const PROBEN = ['t31p_kaskade2', 't31p_setnull2'];
let core, pool, pl;
const fakeQdrant = { geloescht: [], liste: async () => PROJEKTE.flatMap((p) => core.projektCollections(p)), punkte: async () => 1, loesche: async (n) => { fakeQdrant.geloescht.push(n); } };
const geheim = {};

const codeFuer = (host, versatz = 0) => core.totpCode(core.base32Dekodieren(geheim[host]), core.zeitschrittVon(Date.now()) + versatz);
const falsch = (c) => String((Number(c) + 1) % 1e6).padStart(6, '0');
async function richteEin(host) {
  const e = await core.loeschTokenEinrichten(host, { db: pool, von: 'test-t31p' });
  geheim[host] = new URL(e.otpauth_uri.replace('otpauth://', 'http://x/')).searchParams.get('secret');
  await core.loeschTokenBestaetigen(host, codeFuer(host, -1), { db: pool });
}
async function seed(p, host) {
  await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)', [p, host, `/synthetic/${host}/${p}`]);
  await pool.query('INSERT INTO project_host_bindings(project,hostname,enabled,updated_at) VALUES($1,$2,true,NOW())', [p, host]);
  await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'rest-api','/virtual/rest-api',true)", [p]);
  for (let i = 0; i < 2; i++) await pool.query("INSERT INTO memories(id,project,name,content) VALUES($1,$2,$3,'t31p')", [`${p}-m${i}`, p, 'm' + i]);
}
const memories = async (p) => Number((await pool.query('SELECT count(*) n FROM memories WHERE project=$1', [p])).rows[0].n);
const schritt = async (h) => String((await pool.query('SELECT letzter_zeitschritt s FROM loesch_geheimnisse WHERE hostname=$1', [h])).rows[0].s);
const summeFehlversuche = async (h) => Number((await pool.query('SELECT COALESCE(sum(fehlversuche),0) n FROM loesch_auftraege WHERE hostname=$1', [h])).rows[0].n);

async function aufraeumen() {
  for (const t of PROBEN) await pool.query(`DROP TABLE IF EXISTS ${t}`);
  await pool.query("DELETE FROM ansicht_token_audit WHERE akteur = 'test-t31p'").catch(() => undefined);
  await pool.query("DELETE FROM ansicht_tokens WHERE retention_ref LIKE 't31p-%'").catch(() => undefined);
  for (const p of PROJEKTE) {
    await pool.query('DELETE FROM specialist_channel_messages WHERE channel_id IN (SELECT id FROM specialist_channels WHERE project=$1)', [p]);
    for (const [t, c] of [['memories', 'project'], ['specialist_channels', 'project'], ['project_host_bindings', 'project'], ['projects', 'name'], ['loesch_auftraege', 'project']]) {
      await pool.query(`DELETE FROM ${t} WHERE ${c}=$1`, [p]);
    }
  }
  await pool.query('DELETE FROM loesch_auftraege WHERE hostname = ANY($1::text[])', [HOSTS]);
  await pool.query('DELETE FROM loesch_geheimnisse WHERE hostname = ANY($1::text[])', [HOSTS]);
  await pool.query('DELETE FROM loesch_login_fehlversuche WHERE hostname = ANY($1::text[])', [HOSTS]);
}
const vorschau = (o) => core.projektLoeschenVorschau({ db: pool, qdrant: fakeQdrant, konfig: null, agent: 'test-t31p', env: {}, ...o });
const ausfuehren = (o) => core.projektLoeschenAusfuehren({ db: pool, qdrant: fakeQdrant, konfig: null, agent: 'test-t31p', env: {}, ...o });
const ergebnis = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e.code, status: e.httpStatus }));

before(async () => {
  if (!testDb) return;
  core = await import('../dist/index.js');
  pl = await import('../dist/services/projekt-loeschen.js');
  pool = core.getPool();
  assert.equal((await pool.query('SELECT current_database() d')).rows[0].d, 'synapse_test');
  await pool.query(core.LOESCH_TOKEN_SCHEMA_SQL);
  await aufraeumen();
  for (const h of [H.p, H.q, H.r, H.k, H.k2, H.v]) await richteEin(h);
});
after(async () => { if (testDb) { await aufraeumen(); await core.closePool?.(); } });

test('HOCH: 24 parallele falsche Codes auf 3 Auftraege -> hoechstens 5 geprueft, danach host_gesperrt; auch der richtige Code wird abgewiesen', { skip }, async () => {
  for (const p of [PR.p1, PR.p2, PR.p3, PR.p4]) await seed(p, H.p);
  const auftraege = [];
  for (const p of [PR.p1, PR.p2, PR.p3]) {
    const v = await vorschau({ project: p, hostname: H.p });
    assert.equal(v.status, 'vorschau', JSON.stringify(v.blockiert));
    auftraege.push(v.loesch_auftrag_id);
  }
  // Grenze offener Auftraege je Rechner (Standard 3).
  await assert.rejects(vorschau({ project: PR.p4, hostname: H.p }), (e) => e.code === 'zu_viele_auftraege' && e.httpStatus === 429);
  assert.equal((await pool.query('SELECT count(*) n FROM loesch_auftraege WHERE project=$1', [PR.p4])).rows[0].n, '0');

  const schrittVorher = await schritt(H.p);
  const code = codeFuer(H.p);
  const laeufe = [];
  for (const id of auftraege) for (let i = 0; i < 8; i++) laeufe.push(ergebnis(ausfuehren({ loesch_auftrag_id: id, loesch_code: falsch(code) })));
  const res = await Promise.all(laeufe);
  const codes = res.map((x) => x.code);
  const geprueft = codes.filter((c) => c === 'code_ungueltig').length;
  assert.equal(res.filter((x) => x.ok).length, 0, 'kein Erfolg mit falschem Code');
  assert.equal(geprueft, 5, 'genau 5 Codes geprueft: ' + JSON.stringify(codes));
  assert.ok(codes.every((c) => ['code_ungueltig', 'host_gesperrt', 'auftrag_nicht_offen'].includes(c)), JSON.stringify(codes));
  assert.ok(codes.filter((c) => c === 'host_gesperrt').length >= 1);
  assert.equal(await summeFehlversuche(H.p), 5, 'Fehlversuche je Rechner gesamt = 5');

  // Richtiger Code auf einem noch offenen Auftrag -> gesperrt, ohne Pruefung, ohne Verbrauch, nichts geloescht.
  const offen = (await pool.query("SELECT id FROM loesch_auftraege WHERE hostname=$1 AND status='offen' ORDER BY created_at LIMIT 1", [H.p])).rows[0];
  assert.ok(offen, 'mindestens ein Auftrag ist noch offen (5 Fehlversuche auf 3 Auftraege)');
  await assert.rejects(ausfuehren({ loesch_auftrag_id: offen.id, loesch_code: code }), (e) => e.code === 'host_gesperrt' && e.httpStatus === 429);
  assert.equal(await schritt(H.p), schrittVorher, 'richtiger Code nicht verbraucht');
  for (const p of [PR.p1, PR.p2, PR.p3]) assert.equal(await memories(p), 2, p + ' unveraendert');
});

test('HOCH: parallele Vorschauen -> hoechstens N offene Auftraege je Rechner; neue Vorschau ersetzt die alte; Konfiguration', { skip }, async () => {
  assert.equal(pl.loeschMaxOffeneAuftraege({}), 3);
  assert.equal(pl.loeschMaxOffeneAuftraege({ SYNAPSE_LOESCH_MAX_OFFENE_AUFTRAEGE: '5' }), 5);
  for (const roh of ['0', '21', 'x', '-1', '2.5']) assert.equal(pl.loeschMaxOffeneAuftraege({ SYNAPSE_LOESCH_MAX_OFFENE_AUFTRAEGE: roh }), 3, roh);

  const ps = [PR.q1, PR.q2, PR.q3, PR.q4, PR.q5, PR.q6];
  for (const p of ps) await seed(p, H.q);
  const res = await Promise.all(ps.map((p) => ergebnis(vorschau({ project: p, hostname: H.q }))));
  assert.equal(res.filter((x) => x.ok).length, 3, JSON.stringify(res.map((x) => x.code ?? x.r.status)));
  assert.equal(res.filter((x) => x.code === 'zu_viele_auftraege').length, 3);
  const offen = async () => Number((await pool.query("SELECT count(*) n FROM loesch_auftraege WHERE hostname=$1 AND status='offen'", [H.q])).rows[0].n);
  assert.equal(await offen(), 3);

  // Neue Vorschau fuer ein Projekt mit offenem Auftrag ersetzt den alten (alter verfaellt), Zahl bleibt.
  const alt = res.find((x) => x.ok).r;
  const neu = await vorschau({ project: alt.project, hostname: H.q });
  assert.equal(neu.status, 'vorschau');
  assert.equal((await pool.query('SELECT status FROM loesch_auftraege WHERE id=$1', [alt.loesch_auftrag_id])).rows[0].status, 'verfallen');
  assert.equal(await offen(), 3);
  await assert.rejects(ausfuehren({ loesch_auftrag_id: alt.loesch_auftrag_id, loesch_code: codeFuer(H.q) }), (e) => e.code === 'auftrag_nicht_offen');

  // Konfiguration 4 -> ein weiterer Auftrag moeglich.
  const ohne = [];
  for (const p of ps) if ((await pool.query("SELECT count(*) n FROM loesch_auftraege WHERE project=$1 AND status='offen'", [p])).rows[0].n === '0') ohne.push(p);
  assert.equal(ohne.length, 3);
  const v4 = await vorschau({ project: ohne[0], hostname: H.q, env: { SYNAPSE_LOESCH_MAX_OFFENE_AUFTRAEGE: '4' } });
  assert.equal(v4.status, 'vorschau');
  await assert.rejects(vorschau({ project: ohne[1], hostname: H.q, env: { SYNAPSE_LOESCH_MAX_OFFENE_AUFTRAEGE: '4' } }), (e) => e.code === 'zu_viele_auftraege');
});

test('Replay parallel: derselbe richtige Code auf 3 Auftraegen gleichzeitig -> genau eine Loeschung', { skip }, async () => {
  for (const p of [PR.r1, PR.r2, PR.r3]) await seed(p, H.r);
  const ids = [];
  for (const p of [PR.r1, PR.r2, PR.r3]) ids.push((await vorschau({ project: p, hostname: H.r })).loesch_auftrag_id);
  const code = codeFuer(H.r);
  const res = await Promise.all(ids.map((id) => ergebnis(ausfuehren({ loesch_auftrag_id: id, loesch_code: code }))));
  assert.equal(res.filter((x) => x.ok).length, 1, JSON.stringify(res.map((x) => x.code ?? x.r.status)));
  assert.equal(res.filter((x) => x.code === 'code_ungueltig').length, 2);
  const rest = [];
  for (const p of [PR.r1, PR.r2, PR.r3]) rest.push(await memories(p));
  assert.deepEqual([...rest].sort(), [0, 2, 2], 'genau ein Projekt geloescht');
});

test('Login-Sperre (F7) parallel: 12 gleichzeitige falsche Login-Codes -> genau 5 geprueft, danach auch der richtige gesperrt', { skip }, async () => {
  let aufrufe = 0;
  const falschPruefen = async () => { aufrufe++; await new Promise((r) => setTimeout(r, 5)); return false; };
  const res = await Promise.all(Array.from({ length: 12 }, () => ergebnis(core.pruefeLoeschLoginMitSperre(H.l, falschPruefen, { db: pool }))));
  assert.equal(aufrufe, 5, 'genau 5 Login-Pruefungen');
  assert.equal(res.filter((x) => x.ok && x.r === false).length, 5);
  assert.equal(res.filter((x) => x.code === 'login_gesperrt' && x.status === 429).length, 7);
  let richtigGeprueft = false;
  await assert.rejects(core.pruefeLoeschLoginMitSperre(H.l, async () => { richtigGeprueft = true; return true; }, { db: pool }), (e) => e.code === 'login_gesperrt');
  assert.equal(richtigGeprueft, false, 'richtiger Login-Code wird bei Sperre nicht geprueft');
});

test('MITTEL 2: zweistufige Probe-Kaskade unter einem Kaskaden-Kind (CASCADE und SET NULL) bricht ab, nichts geloescht', { skip }, async () => {
  await seed(PR.k, H.k);
  const ch = (await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('t31p-kanal',$1,'test-t31p') RETURNING id", [PR.k])).rows[0].id;
  const msg = (await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES($1,'test-t31p','x') RETURNING id", [ch])).rows[0].id;
  try {
    // Ebene 1: specialist_channels (geloescht) -> Ebene 2: specialist_channel_messages (erfasstes Kaskaden-Kind) -> Ebene 3: Probe.
    await pool.query('CREATE TABLE t31p_kaskade2 (id serial PRIMARY KEY, msg_id integer REFERENCES specialist_channel_messages(id) ON DELETE CASCADE)');
    await pool.query('INSERT INTO t31p_kaskade2(msg_id) VALUES($1)', [msg]);
    const v = await vorschau({ project: PR.k, hostname: H.k });
    assert.equal(v.status, 'vorschau', JSON.stringify(v.blockiert));
    // Der Code wird vor der Transaktion verbraucht (bekannt, Abnahme MITTEL 3) -> spaeter Schritt +1 auf H.k.
    await assert.rejects(ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(H.k) }),
      (e) => e.code === 'unbekannte_kaskade' && e.message.includes('t31p_kaskade2') && e.message.includes('specialist_channel_messages'));
    assert.equal(await memories(PR.k), 2, 'nichts geloescht');
    assert.equal((await pool.query('SELECT count(*) n FROM t31p_kaskade2')).rows[0].n, '1', 'Probe-Zeile unberuehrt');
    await pool.query('DROP TABLE t31p_kaskade2');

    // SET NULL auf ein Kaskaden-Kind (zusammengesetzter Schluessel von agent_event_acks).
    await seed(PR.k2, H.k2);
    const ev = (await pool.query("INSERT INTO agent_events(project,event_type,priority,scope,source_id) VALUES($1,'ANNOUNCEMENT','normal','all','test-t31p') RETURNING id", [PR.k2])).rows[0].id;
    await pool.query("INSERT INTO agent_event_acks(event_id,agent_id) VALUES($1,'test-t31p')", [ev]);
    await pool.query('CREATE TABLE t31p_setnull2 (id serial PRIMARY KEY, ev bigint, ag text, FOREIGN KEY (ev, ag) REFERENCES agent_event_acks(event_id, agent_id) ON DELETE SET NULL)');
    const v2 = await vorschau({ project: PR.k2, hostname: H.k2 });
    assert.equal(v2.status, 'vorschau', JSON.stringify(v2.blockiert));
    await assert.rejects(ausfuehren({ loesch_auftrag_id: v2.loesch_auftrag_id, loesch_code: codeFuer(H.k2) }),
      (e) => e.code === 'unbekannte_kaskade' && e.message.includes('t31p_setnull2'));
    assert.equal(await memories(PR.k2), 2, 'nichts geloescht');
    assert.equal((await pool.query('SELECT count(*) n FROM agent_event_acks WHERE event_id=$1', [ev])).rows[0].n, '1');
  } finally {
    for (const t of PROBEN) await pool.query(`DROP TABLE IF EXISTS ${t}`);
    await pool.query("DELETE FROM agent_event_acks WHERE agent_id='test-t31p'");
    await pool.query("DELETE FROM agent_events WHERE source_id='test-t31p'");
  }
  // Ohne Probe laeuft die Loeschung desselben Projekts durch (Kaskade ueber erfasste Kinder).
  const v3 = await vorschau({ project: PR.k, hostname: H.k });
  assert.equal(v3.status, 'vorschau', JSON.stringify(v3.blockiert));
  const r = await ausfuehren({ loesch_auftrag_id: v3.loesch_auftrag_id, loesch_code: codeFuer(H.k, 1) });
  assert.equal(r.status, 'geloescht');
  assert.equal((await pool.query('SELECT count(*) n FROM specialist_channel_messages WHERE id=$1', [msg])).rows[0].n, '0');
});

test('NIEDRIG 4: Ansicht-Links blockieren nicht mehr; eigene Tokens weg, Audit bleibt (token_id NULL), fremde unberuehrt; aktive Reverse-Links blockieren', { skip }, async () => {
  const da = (await pool.query("SELECT to_regclass('public.ansicht_tokens') IS NOT NULL AS t, to_regclass('public.ansicht_token_audit') IS NOT NULL AS a")).rows[0];
  if (!da.t || !da.a) return assert.fail('ansicht_tokens/ansicht_token_audit fehlen in synapse_test');
  await seed(PR.v, H.v);
  await seed(PR.vx, H.v);
  const token = async (bereich, zielRef, vonProjekt, { widerrufen = false, abgelaufen = false } = {}) => (await pool.query(
    `INSERT INTO ansicht_tokens(token_id, token_digest, bereich, ziel_ref, id, revision, sha256, offen_sekunden, expires_at, revoked_at, retention_ref, erstellt_von_projekt)
     VALUES (gen_random_uuid(), encode(sha256(gen_random_uuid()::text::bytea),'hex'), $1, $2, '1', 'r1', repeat('a',64), 60,
             NOW() + CASE WHEN $5 THEN interval '-1 hour' ELSE interval '1 hour' END, CASE WHEN $4 THEN NOW() ELSE NULL END,
             't31p-' || gen_random_uuid()::text, $3)
     RETURNING token_id`, [bereich, zielRef, vonProjekt, widerrufen, abgelaufen])).rows[0].token_id;
  const audit = (tid) => pool.query("INSERT INTO ansicht_token_audit(token_id, ereignis, ergebnis, akteur) VALUES($1,'abruf','ok','test-t31p')", [tid]);
  const eigen = [
    await token('projekt', PR.v, PR.v),
    await token('projekt', PR.v, PR.vx, { widerrufen: true }),
    await token('reverse', 'rev-eintrag-t31p', PR.v, { widerrufen: true }),
    await token('reverse', 'rev-eintrag-t31p', PR.v, { abgelaufen: true }),
  ];
  const fremd = [await token('projekt', PR.vx, PR.v), await token('reverse', 'rev-eintrag-t31p', PR.vx)];
  for (const t of [...eigen, ...fremd]) await audit(t);

  const v = await vorschau({ project: PR.v, hostname: H.v });
  assert.equal(v.status, 'vorschau', JSON.stringify(v.blockiert));
  assert.deepEqual(v.zentral.tabellen.find((z) => z.tabelle === 'ansicht_tokens'), { tabelle: 'ansicht_tokens', gruppe: 'ansicht_links', anzahl: 4 });
  const r = await ausfuehren({ loesch_auftrag_id: v.loesch_auftrag_id, loesch_code: codeFuer(H.v) });
  assert.equal(r.status, 'geloescht', JSON.stringify(r));
  const n = async (sql, args) => Number((await pool.query(sql, args)).rows[0].n);
  assert.equal(await n('SELECT count(*) n FROM ansicht_tokens WHERE token_id = ANY($1::uuid[])', [eigen]), 0, 'eigene Tokens weg');
  assert.equal(await n('SELECT count(*) n FROM ansicht_tokens WHERE token_id = ANY($1::uuid[])', [fremd]), 2, 'fremde Tokens bleiben');
  assert.equal(await n("SELECT count(*) n FROM ansicht_token_audit WHERE akteur='test-t31p' AND token_id IS NULL", []), 4, 'Audit der eigenen Tokens bleibt (token_id NULL)');
  assert.equal(await n('SELECT count(*) n FROM ansicht_token_audit WHERE token_id = ANY($1::uuid[])', [fremd]), 2, 'Audit fremder Tokens unveraendert');
  assert.equal(await memories(PR.vx), 2, 'Nachbarprojekt unveraendert');

  // Aktiver Reverse-Link aus einem Projekt -> Vorschau blockiert, kein Auftrag.
  await seed(PR.w, H.v);
  await token('reverse', 'rev-eintrag-t31p', PR.w);
  const w = await vorschau({ project: PR.w, hostname: H.v });
  assert.equal(w.status, 'blockiert');
  assert.ok(w.blockiert.some((b) => b.grund === 'ansicht_links_aktiv' && b.detail.startsWith('ansicht_tokens: 1')), JSON.stringify(w.blockiert));
  assert.ok(!w.blockiert.some((b) => b.grund === 'unbekannte_tabelle'), 'ansicht_tokens ist erfasst');
  assert.equal(w.loesch_auftrag_id, null);
});
