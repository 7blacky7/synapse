/**
 * P10-T74 (14.10.2026): intern tool_calls_nachschwaerzen.
 * ZUSAGEN (nur synapse_test, eigenes Testprojekt, Aufraeumen in finally):
 *   D0 Dispatcher: Action steht in INTERN_DEFINITION (enum + Parameter ids/ab_id/max_pruefen) und laeuft ueber fuehreInternAus.
 *   V1 Vorschau zaehlt betroffene Zeilen je Feld/Tool, listet IDs mit Feldnamen, schreibt nichts und enthaelt
 *      KEINEN Klartext (auch keine Teilstuecke der Geheimnisse).
 *   V2 ids-Filter: gefunden / nicht_gefunden / ohne_treffer; bereits geschwaerzte Zeile gilt als ohne Treffer.
 *   V3 Erkennung = Schreibweg: betroffen genau dann, wenn schwaerzeToolLogText ein Feld aendert.
 *   R1 Nicht-Koordinator: Vorschau und Ausfuehren -> nicht_erlaubt, nichts geschrieben.
 *   F1 tools-Filter, ungueltige seit/ids -> parameter_ungueltig.
 *   G1 max_pruefen begrenzt die gescannte ID-Spanne (auch bei Filter ohne Treffer, N1), naechste_ab_id setzt
 *      luecklos fort.
 *   N2 limit/max_pruefen 0, negativ, Text, Bruch, zu gross -> parameter_ungueltig; limit:0 schreibt NICHTS.
 *   M1 Gesperrte Zeile beim Ausfuehren: fehler 1, vollstaendig:false, nicht_geschrieben_ids, kein 'Fertig'.
 *   A1 ausfuehren mit limit 1 -> genau eine Zeile, vollstaendig:false; Fortsetzung schreibt den Rest.
 *   A2 Nach dem Lauf: kein Klartext mehr, Felder == schwaerzeToolLogText(alt); harmlose und schon geschwaerzte
 *      Zeilen bytegleich; result_bytes/result_truncated unveraendert.
 *   A3 Zweiter Lauf: 0 betroffen, 0 geschrieben.
 *   L1 Neuer Eintrag ueber logToolCall (projekt_db-Antwort mit Passwort/DATABASE_URL) landet ohne Klartext
 *      und ist fuer das Werkzeug nicht betroffen.
 */
import assert from 'node:assert/strict';

const url = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(url.pathname, '/synapse_test', 'nur synapse_test');
assert.equal(url.port, '5433', 'nur Test-Instanz');

process.env.SYNAPSE_INTERN_TOOL = '1';
const { getPool, closePool } = await import('../dist/db/client.js');
const { fuehreToolCallsSchwaerzenAus, schwaerzeToolCallZeile } = await import('../dist/services/intern-tool-calls-schwaerzen.js');
const { schwaerzeToolLogText } = await import('../dist/services/tool-args-schwaerzen.js');
const { logToolCall } = await import('../dist/services/tool-call-log.js');
const T = await import('../dist/services/intern-tool.js');

const A = 'tool_calls_nachschwaerzen';
const P = 'test-p10-t74-nachschwaerzen-' + Date.now();
const PW = 'Kl4rtextT74pw!q';
const PW2 = 'Zw31tesT74geheim';
const KLAR = [PW, PW2, 'Kl4rtext', 'Zw31tes', 'sk-t74-abcdef123456'];
const pool = getPool();

const projektDbAntwort = JSON.stringify({
  success: true,
  projekt_db: { vorhanden: true, host: '192.168.50.65', port: 5433, database: 't74_db', user: 't74_user', passwort: PW,
    database_url: `postgresql://t74_user:${PW}@192.168.50.65:5433/t74_db` },
});
const zeilen = {
  projektDb: { tool_name: 'project', args_preview: JSON.stringify({ action: 'projekt_db', project: 'x' }), result: projektDbAntwort, error: null },
  argsUebernehmen: { tool_name: 'project', args_preview: JSON.stringify({ action: 'projekt_db', uebernehmen: { database: 'd', user: 'u', host: 'h', port: 5433, passwort: PW2 } }), result: '{"success":true}', error: null },
  fehlerText: { tool_name: 'shell', args_preview: '{"command":"ls"}', result: null, error: 'Verbindung fehlgeschlagen: API_KEY=sk-t74-abcdef123456 abgelehnt' },
  harmlos: { tool_name: 'memory', args_preview: '{"action":"read","name":"x"}', result: '{"success":true,"content":"Build ok, 42 Dateien, Port 5433"}', error: null },
};
zeilen.schonGeschwaerzt = { tool_name: 'project', args_preview: '{"action":"projekt_db"}', result: schwaerzeToolLogText(projektDbAntwort), error: null };

const ids = {};
async function lese() {
  return (await pool.query('SELECT id::text AS id, tool_name, args_preview, result, error, result_bytes, result_truncated FROM tool_calls WHERE project=$1 ORDER BY id', [P])).rows;
}
function ohneKlartext(obj, was) {
  const s = JSON.stringify(obj);
  for (const k of KLAR) assert.equal(s.includes(k), false, `${was}: Klartext-Teil sichtbar: ${k.slice(0, 3)}…`);
}

try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db, 'synapse_test');
  for (const [name, z] of Object.entries(zeilen)) {
    ids[name] = (await pool.query(
      'INSERT INTO tool_calls(project,tool_name,args_preview,result,error,ok,result_bytes,result_truncated) VALUES ($1,$2,$3,$4,$5,true,$6,false) RETURNING id::text AS id',
      [P, z.tool_name, z.args_preview, z.result, z.error, z.result ? Buffer.byteLength(z.result) : null])).rows[0].id;
  }
  const vorher = await lese();

  // D0
  const def = T.INTERN_DEFINITION.inputSchema;
  assert.ok(def.properties.action.enum.includes(A), 'Action im enum');
  for (const p of ['ids', 'ab_id', 'max_pruefen', 'tools', 'seit', 'bis', 'limit', 'ausfuehren']) assert.ok(def.properties[p], 'Parameter ' + p);
  const d = await T.fuehreInternAus({ action: A, project: P }, 'koordinator');
  assert.equal(d.success, true, JSON.stringify(d));
  assert.equal(d.modus, 'vorschau');

  // V1
  const v = await fuehreToolCallsSchwaerzenAus(A, { project: P }, 'koordinator');
  assert.equal(v.success, true, JSON.stringify(v));
  assert.equal(v.geprueft, 5);
  assert.equal(v.betroffen, 3, 'projektDb, argsUebernehmen, fehlerText');
  assert.deepEqual(v.felder, { args_preview: 1, result: 1, error: 1 });
  assert.deepEqual(v.je_tool, { project: 2, shell: 1 });
  assert.ok(v.ersetzungen >= 3, 'Platzhalter gezaehlt');
  assert.deepEqual(v.ids.map((x) => x.id).sort(), [ids.projektDb, ids.argsUebernehmen, ids.fehlerText].sort());
  assert.deepEqual(v.ids.find((x) => x.id === ids.projektDb).felder, ['result']);
  assert.equal(v.vollstaendig, true);
  assert.equal(v.naechste_ab_id, null);
  ohneKlartext(v, 'Vorschau');
  assert.deepEqual(await lese(), vorher, 'Vorschau schreibt nichts');

  // V2
  const fremd = '987654321012345';
  const vi = await fuehreToolCallsSchwaerzenAus(A, { ids: [ids.projektDb, ids.harmlos, Number(ids.schonGeschwaerzt), fremd] }, 'koordinator');
  assert.equal(vi.success, true, JSON.stringify(vi));
  assert.equal(vi.betroffen, 1);
  assert.deepEqual(vi.angefragte_ids.nicht_gefunden, [fremd]);
  assert.deepEqual(vi.angefragte_ids.ohne_treffer.sort(), [ids.harmlos, ids.schonGeschwaerzt].sort());
  assert.equal(vi.angefragte_ids.gefunden, 3);
  ohneKlartext(vi, 'Vorschau ids');
  const viText = await fuehreToolCallsSchwaerzenAus(A, { ids: `${ids.projektDb},${ids.fehlerText}` }, 'koordinator');
  assert.equal(viText.betroffen, 2, 'ids als Komma-Text');

  // V3
  for (const r of vorher) {
    const erwartet = ['args_preview', 'result', 'error'].some((f) => typeof r[f] === 'string' && schwaerzeToolLogText(r[f]) !== r[f]);
    assert.equal(schwaerzeToolCallZeile(r).felder.length > 0, erwartet, 'Erkennung = Schreibweg fuer ' + r.id);
  }

  // R1
  for (const args of [{ project: P }, { project: P, ausfuehren: true }]) {
    const n = await fuehreToolCallsSchwaerzenAus(A, args, 'sol-1');
    assert.equal(n.success, false);
    assert.equal(n.error, 'nicht_erlaubt');
    assert.equal(JSON.stringify(n).includes(ids.projektDb), false, 'keine IDs fuer Unberechtigte');
  }
  assert.deepEqual(await lese(), vorher, 'ohne Rolle nichts geschrieben');

  // F1
  assert.equal((await fuehreToolCallsSchwaerzenAus(A, { project: P, tools: ['memory'] }, 'koordinator')).betroffen, 0);
  assert.equal((await fuehreToolCallsSchwaerzenAus(A, { project: P, tools: 'shell' }, 'koordinator')).betroffen, 1);
  assert.equal((await fuehreToolCallsSchwaerzenAus(A, { project: P, seit: '2000-01-01T00:00:00Z', bis: '2000-01-02T00:00:00Z' }, 'koordinator')).geprueft, 0);
  assert.equal((await fuehreToolCallsSchwaerzenAus(A, { project: P, seit: 'gestern' }, 'koordinator')).error, 'parameter_ungueltig');
  assert.equal((await fuehreToolCallsSchwaerzenAus(A, { ids: ['1; DROP TABLE x'] }, 'koordinator')).error, 'parameter_ungueltig');
  assert.equal((await fuehreToolCallsSchwaerzenAus(A, { project: P, ab_id: 'abc' }, 'koordinator')).error, 'parameter_ungueltig');

  // G1
  let summeGeprueft = 0, summeBetroffen = 0, aufrufe = 0, ab;
  while (true) {
    const g = await fuehreToolCallsSchwaerzenAus(A, { project: P, max_pruefen: 1, ...(ab ? { ab_id: ab } : {}) }, 'koordinator');
    assert.equal(g.success, true, JSON.stringify(g));
    assert.ok(g.gescannt_id_spanne <= 1, 'Spanne je Aufruf <= max_pruefen');
    summeGeprueft += g.geprueft; summeBetroffen += g.betroffen; aufrufe++;
    if (g.vollstaendig) break;
    assert.ok(g.naechste_ab_id, 'Fortsetzungspunkt');
    ab = g.naechste_ab_id;
    assert.ok(aufrufe < 1000, 'keine Endlosschleife');
  }
  assert.equal(summeGeprueft, 5, 'Fortsetzung luecklos (geprueft)');
  assert.equal(summeBetroffen, 3, 'Fortsetzung luecklos (betroffen)');
  // N1: Filter ohne Treffer scannt trotzdem nur die ID-Spanne max_pruefen
  const n1 = await fuehreToolCallsSchwaerzenAus(A, { tools: ['t74-gibt-es-nicht'], ab_id: 0, max_pruefen: 50 }, 'koordinator');
  assert.equal(n1.success, true, JSON.stringify(n1));
  assert.equal(n1.gescannt_id_spanne, 50);
  assert.equal(n1.geprueft, 0);
  assert.equal(n1.vollstaendig, false);
  assert.equal(n1.naechste_ab_id, '50');
  assert.deepEqual(await lese(), vorher);

  // N2
  for (const [args, was] of [
    [{ limit: 0, ausfuehren: true }, 'limit 0'], [{ limit: -1, ausfuehren: true }, 'limit -1'], [{ limit: 'abc', ausfuehren: true }, 'limit Text'],
    [{ limit: 2.5, ausfuehren: true }, 'limit Bruch'], [{ limit: '', ausfuehren: true }, 'limit leer'],
    [{ max_pruefen: 0 }, 'max_pruefen 0'], [{ max_pruefen: '-3' }, 'max_pruefen -3'], [{ max_pruefen: 'x' }, 'max_pruefen Text'],
    [{ max_pruefen: 500001 }, 'max_pruefen zu gross'],
  ]) {
    const r = await fuehreToolCallsSchwaerzenAus(A, { project: P, ...args }, 'koordinator');
    assert.equal(r.success, false, was + ': ' + JSON.stringify(r));
    assert.equal(r.error, 'parameter_ungueltig', was);
  }
  assert.deepEqual(await lese(), vorher, 'N2: ungueltige Werte schreiben nichts (limit:0 ist NICHT unbegrenzt)');
  assert.equal((await fuehreToolCallsSchwaerzenAus(A, { project: P, limit: '2', max_pruefen: '100000' }, 'koordinator')).success, true, 'Ganzzahl als Text ok');

  // M1
  const sperre = await pool.connect();
  try {
    await sperre.query('BEGIN');
    await sperre.query('SELECT id FROM tool_calls WHERE id=$1::bigint FOR UPDATE', [ids.fehlerText]);
    const m1 = await fuehreToolCallsSchwaerzenAus(A, { ids: [ids.fehlerText], ausfuehren: true }, 'koordinator');
    assert.equal(m1.success, true, JSON.stringify(m1));
    assert.equal(m1.fehler, 1);
    assert.equal(m1.geschrieben, 0);
    assert.equal(m1.vollstaendig, false, 'fehler>0 ist nie vollstaendig');
    assert.deepEqual(m1.nicht_geschrieben_ids, [ids.fehlerText]);
    assert.ok(/NICHT geschrieben/.test(m1.hinweis) && !/Fertig/.test(m1.hinweis), 'Hinweis erneut ausfuehren');
    ohneKlartext(m1, 'M1-Antwort');
    const m1b = await fuehreToolCallsSchwaerzenAus(A, { project: P, ausfuehren: true, max_pruefen: 1, ab_id: String(BigInt(ids.fehlerText) - 1n) }, 'koordinator');
    assert.equal(m1b.fehler, 1);
    assert.equal(m1b.vollstaendig, false, 'auch im Fenster-Modus');
    assert.deepEqual(m1b.nicht_geschrieben_ids, [ids.fehlerText]);
  } finally {
    await sperre.query('ROLLBACK').catch(() => {});
    sperre.release();
  }
  assert.deepEqual(await lese(), vorher, 'M1: gesperrte Zeile unveraendert');

  // A1
  const a1 = await fuehreToolCallsSchwaerzenAus(A, { project: P, ausfuehren: true, limit: 1 }, 'koordinator');
  assert.equal(a1.success, true, JSON.stringify(a1));
  assert.equal(a1.modus, 'ausgefuehrt');
  assert.equal(a1.geschrieben, 1);
  assert.equal(a1.vollstaendig, false);
  assert.equal(a1.naechste_ab_id, ids.projektDb);
  ohneKlartext(a1, 'Ausfuehren-Antwort');
  const a2 = await fuehreToolCallsSchwaerzenAus(A, { project: P, ausfuehren: true, ab_id: a1.naechste_ab_id }, 'koordinator');
  assert.equal(a2.geschrieben, 2, JSON.stringify(a2));
  assert.equal(a2.fehler, 0);
  assert.equal(a2.vollstaendig, true);

  // A2
  const nach = await lese();
  ohneKlartext(nach, 'DB nach dem Lauf');
  const nachId = Object.fromEntries(nach.map((r) => [r.id, r]));
  const vorId = Object.fromEntries(vorher.map((r) => [r.id, r]));
  for (const name of ['projektDb', 'argsUebernehmen', 'fehlerText']) {
    const alt = vorId[ids[name]], neu = nachId[ids[name]];
    for (const f of ['args_preview', 'result', 'error']) assert.equal(neu[f], schwaerzeToolLogText(alt[f]) ?? null, `${name}.${f} == Schreibweg`);
    assert.equal(neu.result_bytes, alt.result_bytes, 'result_bytes unveraendert');
    assert.equal(neu.result_truncated, alt.result_truncated);
  }
  assert.ok(nachId[ids.projektDb].result.includes('[WERT]'));
  assert.ok(nachId[ids.projektDb].result.includes('t74_user'), 'Nicht-Geheimes bleibt lesbar');
  assert.deepEqual(nachId[ids.harmlos], vorId[ids.harmlos], 'harmlos bytegleich');
  assert.deepEqual(nachId[ids.schonGeschwaerzt], vorId[ids.schonGeschwaerzt], 'schon geschwaerzt bytegleich');

  // A3
  const a3 = await fuehreToolCallsSchwaerzenAus(A, { project: P, ausfuehren: true }, 'koordinator');
  assert.equal(a3.betroffen, 0);
  assert.equal(a3.geschrieben, 0);
  assert.deepEqual(await lese(), nach);

  // L1
  await logToolCall({ project: P, agentId: 'test-t74', tool: 'project', action: 'projekt_db', argsPreview: JSON.stringify({ action: 'projekt_db', project: P }), ok: true, result: projektDbAntwort });
  const l = (await pool.query("SELECT id::text AS id, result FROM tool_calls WHERE project=$1 AND agent_id='test-t74'", [P])).rows;
  assert.equal(l.length, 1);
  ohneKlartext(l, 'logToolCall projekt_db');
  const l1 = await fuehreToolCallsSchwaerzenAus(A, { ids: [l[0].id] }, 'koordinator');
  assert.equal(l1.betroffen, 0, 'neuer Eintrag ist schon geschwaerzt');

  console.log('OK P10-T74 tool_calls_nachschwaerzen: D0 V1-V3 R1 F1 G1/N1 N2 M1 A1-A3 L1 gruen');
} finally {
  await pool.query('DELETE FROM tool_calls WHERE project=$1', [P]).catch(() => {});
  await closePool();
}
