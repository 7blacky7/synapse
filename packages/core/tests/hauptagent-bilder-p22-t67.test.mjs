/**
 * P22-T67: Bilder aus Synapse-Tools im Chatverlauf. DB-frei (Dienste per Parameter ersetzt):
 *   node packages/core/tests/hauptagent-bilder-p22-t67.test.mjs
 * A  Verlauf speichert nur den Asset-Verweis (nie Base64/data), begrenzt auf 8 Bilder
 * B  rendereToolBild: Erfolg, Revision-Rueckfall, Projekt nicht freigegeben, kein Asset, ungueltige Parameter, nicht darstellbar
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

const verlauf = await import('../dist/services/hauptagent-verlauf.js');
const bilder = await import('../dist/services/hauptagent-bilder.js');

const BASE64 = 'iVBORw0KGgo'.repeat(5000);

test('A bilderAusStrom: nur Verweisfelder, nie Daten', () => {
  const r = verlauf.bilderAusStrom([
    { mime_type: 'image/png', bytes: 1234, project: 'synapse', file_path: 'ui-screenshots/a.png', revision: '7', breite: 800, hoehe: 600, data: BASE64, source: { data: BASE64 } },
    { bytes: 5 },
    'kaputt',
    { mime_type: 'image/png', bytes: 1, project: 'synapse', revision: 'x1' },
  ]);
  assert.equal(r.length, 3);
  assert.deepEqual(r[0], { mime_type: 'image/png', bytes: 1234, project: 'synapse', file_path: 'ui-screenshots/a.png', revision: '7', breite: 800, hoehe: 600 });
  assert.equal(JSON.stringify(r).includes('iVBOR'), false, 'kein Base64 im Ergebnis');
  assert.deepEqual(r[1], { mime_type: 'image/png', bytes: 5 }, 'ohne project/file_path kein Verweis');
  assert.deepEqual(r[2], { mime_type: 'image/png', bytes: 1 }, 'project ohne file_path und ungueltige Revision verworfen');
  assert.equal(verlauf.bilderAusStrom(Array.from({ length: 20 }, () => ({ bytes: 1 }))).length, 8);
  assert.deepEqual(verlauf.bilderAusStrom(undefined), []);
});

test('A tool-Ereignis end speichert bilder am Aufruf (Verweis), start nicht', () => {
  const stand = verlauf.neuerAntwortStand();
  assert.ok(verlauf.wendeStromEreignisAn(stand, 'tool', { phase: 'start', id: 't1', name: 'mcp__synapse__code_intel', input: { action: 'file', project: 'synapse', file_path: 'ui-screenshots/a.png', ansicht: 'inline' } }));
  assert.equal(stand.werkzeuge.calls[0].bilder, undefined);
  assert.ok(verlauf.wendeStromEreignisAn(stand, 'tool', {
    phase: 'end', id: 't1', output: '{"success":true}', isError: false,
    bilder: [{ mime_type: 'image/png', bytes: 99, project: 'synapse', file_path: 'ui-screenshots/a.png', revision: '3', data: BASE64 }],
  }));
  const call = stand.werkzeuge.calls[0];
  assert.deepEqual(call.bilder, [{ mime_type: 'image/png', bytes: 99, project: 'synapse', file_path: 'ui-screenshots/a.png', revision: '3' }]);
  assert.equal(JSON.stringify(stand).includes('iVBOR'), false, 'Verlaufsstand ohne Base64');
  // Ende ohne Bilder lassen den Aufruf ohne bilder
  verlauf.wendeStromEreignisAn(stand, 'tool', { phase: 'start', id: 't2', name: 'x', input: {} });
  verlauf.wendeStromEreignisAn(stand, 'tool', { phase: 'end', id: 't2', output: 'ok' });
  assert.equal(stand.werkzeuge.calls[1].bilder, undefined);
});

const PNG = Buffer.from('png');
const okAnsicht = (revision = '5') => ({ success: true, mimeType: 'image/png', png: PNG, breite: 640, hoehe: 480, cacheKey: 'k', cacheTreffer: false, quelle: { bereich: 'projekt', ziel_ref: 'p', id: '9', revision, sha256: 'a'.repeat(64) } });
function dienste({ aktiv = true, asset = '9', antworten = [okAnsicht()] } = {}) {
  const refs = [];
  let n = 0;
  return {
    refs,
    d: {
      projektAktiv: async () => aktiv,
      assetId: async () => asset,
      ansicht: { ansichten: async (r) => { refs.push(...r); return [antworten[Math.min(n++, antworten.length - 1)]]; } },
    },
  };
}

test('B Erfolg: Bild + Masse + Revision, aktuell ohne Revisionsangabe', async () => {
  const { d, refs } = dienste();
  const r = await bilder.rendereToolBild({ project: 'p', file_path: 'ui-screenshots/a.png' }, d);
  assert.equal(r.ok, true);
  assert.deepEqual([r.breite, r.hoehe, r.revision, r.aktuell, r.png.toString()], [640, 480, '5', true, 'png']);
  assert.deepEqual(refs, [{ bereich: 'projekt', ziel_ref: 'p', id: '9' }]);
});

test('B gespeicherte Revision wird angefragt, Rueckfall auf aktuelle Fassung', async () => {
  let s = dienste({ antworten: [okAnsicht('3')] });
  let r = await bilder.rendereToolBild({ project: 'p', file_path: 'a.png', revision: '3' }, s.d);
  assert.equal(r.ok, true);
  assert.equal(r.aktuell, false);
  assert.equal(s.refs[0].revision, '3');
  s = dienste({ antworten: [{ success: false, fehlercode: 'ansicht_quelle_fehlt', grund: 'weg', link_rueckfall: null }, okAnsicht('8')] });
  r = await bilder.rendereToolBild({ project: 'p', file_path: 'a.png', revision: '3' }, s.d);
  assert.equal(r.ok, true);
  assert.deepEqual([r.revision, r.aktuell], ['8', true]);
  assert.equal(s.refs.length, 2);
  assert.equal(s.refs[1].revision, undefined);
});

test('B Fehlerfaelle mit Status', async () => {
  let r = await bilder.rendereToolBild({ project: 'p', file_path: 'a.png' }, dienste({ aktiv: false }).d);
  assert.deepEqual([r.ok, r.status, r.fehlercode], [false, 403, 'projekt_verboten']);
  r = await bilder.rendereToolBild({ project: 'p', file_path: 'a.png' }, dienste({ asset: null }).d);
  assert.deepEqual([r.ok, r.status, r.fehlercode], [false, 404, 'kein_asset']);
  r = await bilder.rendereToolBild({ project: 'p', file_path: 'a.psd' }, dienste({ antworten: [{ success: false, fehlercode: 'ansicht_nicht_darstellbar', grund: 'psd', link_rueckfall: null }] }).d);
  assert.deepEqual([r.ok, r.status, r.fehlercode], [false, 415, 'ansicht_nicht_darstellbar']);
  for (const e of [{}, { project: 'p' }, { project: 'p', file_path: '../x.png' }, { project: 'p', file_path: 'a\\..\\b.png' }, { project: 'p', file_path: 'a.png', revision: '0' }, { project: 'p', file_path: 'a.png', revision: 'abc' }]) {
    r = await bilder.rendereToolBild(e, dienste().d);
    assert.deepEqual([r.ok, r.status, r.fehlercode], [false, 400, 'parameter_ungueltig'], JSON.stringify(e));
  }
  r = await bilder.rendereToolBild({ project: 'p', file_path: 'a.png' }, { ...dienste().d, ansicht: { ansichten: async () => { throw new Error('boom'); } } });
  assert.deepEqual([r.ok, r.status, r.fehlercode], [false, 502, 'ansicht_fehler']);
});
