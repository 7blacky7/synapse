/** P22-T188 / ac1f8247 P2: echter PUT->GET-Vertrag, kein Nachbilden von gewuenscht in der Fixture. */
import assert from 'node:assert/strict';
import { heartbeatApiFixture, HEARTBEAT_IDS } from './agent-heartbeat-api-fixture.mjs';
const f = await heartbeatApiFixture();
let checks = 0;
try {
  const path = '/api/agent-runtimes/agent-heartbeat';
  const request = async (method, id, values = {}) => {
    const r = await f.app.inject(method === 'GET' ? { method, url: path + '?identity_id=' + id }
      : { method, url: path, payload: { identity_id: id, grund: 'P22-T188 REST-Vertrag', ...values } });
    assert.equal(r.statusCode, 200, method + ': ' + r.body); return r.json();
  };
  const id = HEARTBEAT_IDS['ko-a'];
  for (const [aktiv, intervall_ms] of [[false, 30000], [true, null]]) {
    const put = await request('PUT', id, { aktiv, intervall_ms });
    const get = await request('GET', id);
    for (const [label, s] of [['PUT', put], ['GET', get]]) {
      assert.equal(s.gewuenscht.aktiv, aktiv, 'P22-T188 ' + label + ' neuer Wunsch EIN/AUS');
      assert.equal(s.gewuenscht.intervall_ms, intervall_ms, 'P22-T188 ' + label + ' neuer Wunsch Intervall');
      assert.equal(s.tatsaechlich.aktiv, aktiv, 'P22-T188 ' + label + ' Wrapper EIN/AUS');
      assert.equal(s.tatsaechlich.intervall_ms, intervall_ms, 'P22-T188 ' + label + ' Wrapper Intervall');
      checks += 4;
    }
    assert.equal(put.wrapper_nachgezogen, true); checks++;
    assert.deepEqual(put.gewuenscht, get.gewuenscht, 'P22-T188 PUT und GET identisch'); checks++;
    // Genau das vom Regler uebernommene PUT-Ergebnis erneut speichern: kein Zurueckspringen.
    const repeat = await request('PUT', id, { aktiv: put.gewuenscht.aktiv, intervall_ms: put.gewuenscht.intervall_ms });
    assert.equal(repeat.gewuenscht.aktiv, aktiv); assert.equal(repeat.gewuenscht.intervall_ms, intervall_ms); checks += 2;
  }
  const other = await request('GET', HEARTBEAT_IDS['ko-b']);
  assert.equal(other.gewuenscht.aktiv, false); assert.equal(other.gewuenscht.intervall_ms, 60000); checks += 2;
  const sub = await request('PUT', HEARTBEAT_IDS['agent-a'], { aktiv: false, intervall_ms: 20000 });
  assert.equal(sub.gewuenscht, null); assert.equal(sub.tatsaechlich.aktiv, false); checks += 2;
  assert.equal((await request('GET', HEARTBEAT_IDS['agent-a'])).tatsaechlich.intervall_ms, 20000); checks++;
  await f.reset({ off: true });
  const off = await f.app.inject({ method: 'PUT', url: path, payload: { identity_id: id, aktiv: true, intervall_ms: 30000 } });
  assert.notEqual(off.statusCode, 200); assert.match(off.body, /funktion_aus/); checks += 2;
  console.log('BESTANDEN ' + checks + ' P22-T188 echte REST-PUT/GET-Vertragspruefungen');
} finally { await f.close(); }
