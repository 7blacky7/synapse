/**
 * P27-T9: Daemon-Index-Slots, manager.ts/indexVorrangAktiv und Watcher-Herkunft.
 * Rein lokal, kein Daemon, keine Datenbank; INDEX_MAX_CONCURRENT=1 fuer reproduzierbare Reihenfolge.
 * Manueller Vorrang bleibt ueber dem automatischen Vorrang; AUS stellt FIFO wieder her.
 */
import assert from 'node:assert/strict';
process.env.INDEX_MAX_CONCURRENT = '1';
const M = await import('../dist/manager.js');
const C = await import('../../core/dist/services/warteschlangen-register.js');
const S = M.indexSlotsFuerTests;
const q = C.holeWarteschlange('index');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function checkOrder(aktiv, expected) {
  M.uebernehmeIndexVorrang({ index_live_vorrang: { aktiv, quelle: 'produkt-schalter' } });
  const result = [];
  await S.acquire('p', 'belegt');
  const p = S.acquire('p', 'initial', 'initial').then(() => result.push('initial'));
  const l = S.acquire('p', 'live', 'live').then(() => result.push('live'));
  const list = await q.liste({limit:10, offset:0});
  assert.equal(list.eintraege[0].details.scan_phase, expected[0]);
  assert.equal(typeof q.uebersicht().aelteste_live_wartezeit_s, 'number');
  S.release(); await tick(); S.release(); await tick(); S.release();
  await Promise.all([p,l]);
  assert.deepEqual(result, expected);
}
await checkOrder(true, ['live','initial']);
await checkOrder(false, ['initial','live']);
M.uebernehmeIndexVorrang({ index_live_vorrang: { aktiv: true, quelle: 'produkt-schalter' } });
await S.acquire('p', 'belegt');
const reihe = [];
const initial = S.acquire('p', 'initial', 'initial').then(() => reihe.push('initial'));
const live = S.acquire('q', 'live', 'live').then(() => reihe.push('live'));
q.verschieben({nach:'vorne', project:'p'});
S.release(); await tick(); S.release(); await tick(); S.release();
await Promise.all([initial,live]);
assert.deepEqual(reihe, ['initial','live']);
q.verschieben({nach:'einreihen',project:'p'});
M.uebernehmeIndexVorrang({ index_live_vorrang: { aktiv:true, quelle:'produkt-schalter', override:{aktiv:false,bis:new Date(Date.now()+10000).toISOString()} } });
assert.equal(q.uebersicht().live_vorrang.aktiv, false);
M.uebernehmeIndexVorrang(null);
assert.equal(q.uebersicht().live_vorrang.aktiv, true);
console.log('P27-T9: Live-Vorrang, FIFO AUS, manuelle Steuerung, Debug-Override OK');
