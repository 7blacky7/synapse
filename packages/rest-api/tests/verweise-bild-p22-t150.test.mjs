/**
 * P22-T150: Aufloesung von Bildverweisen aus Chats (rest-api services/verweise.ts) mit Attrappen fuer DB und Projektwurzeln.
 *   node --test packages/rest-api/tests/verweise-bild-p22-t150.test.mjs   (nach pnpm run build in rest-api)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assetPfadAusVerweis, loeseAssetVerweis } from '../dist/services/verweise.js';

const WURZELN = ['/home/blacky/dev/synapse', '/mnt/user/synapse/projekte/synapse/'];

test('assetPfadAusVerweis: relativ, absolut unter einer Projektwurzel, sonst nichts', () => {
  assert.equal(assetPfadAusVerweis('ui-screenshots/a.png', []), 'ui-screenshots/a.png');
  assert.equal(assetPfadAusVerweis('./ui-screenshots/a.png', []), 'ui-screenshots/a.png');
  assert.equal(assetPfadAusVerweis('/home/blacky/dev/synapse/ui-screenshots/p22-t149/13-hell-kopf.png', WURZELN), 'ui-screenshots/p22-t149/13-hell-kopf.png');
  assert.equal(assetPfadAusVerweis('/mnt/user/synapse/projekte/synapse/bilder/x.png', WURZELN), 'bilder/x.png', 'Wurzel mit Schraegstrich am Ende');
  assert.equal(assetPfadAusVerweis('/home/blacky/dev/synapse-andere/x.png', WURZELN), null, 'Nachbarordner zaehlt nicht');
  assert.equal(assetPfadAusVerweis('/etc/x.png', WURZELN), null, 'ausserhalb des Projekts');
  assert.equal(assetPfadAusVerweis('/home/blacky/dev/synapse/', WURZELN), null);
  assert.equal(assetPfadAusVerweis('/x.png', ['/']), null, 'Wurzel / nie');
  assert.equal(assetPfadAusVerweis('a/../b.png', []), null, '.. nie');
  assert.equal(assetPfadAusVerweis('/home/blacky/dev/synapse/../x.png', WURZELN), null);
});

function attrappe(zeilen = []) {
  const fragen = [];
  let wurzelAufrufe = 0;
  return {
    fragen,
    get wurzelAufrufe() { return wurzelAufrufe; },
    dienste: {
      frage: async (sql, params) => { fragen.push({ sql, params }); return zeilen; },
      wurzeln: async () => { wurzelAufrufe += 1; return WURZELN; },
    },
  };
}

test('loeseAssetVerweis: absoluter Pfad -> Asset-Pfad, nur Bilder, nicht geloescht', async () => {
  const a = attrappe([{ file_path: 'ui-screenshots/a.png', file_name: 'a.png' }]);
  const t = await loeseAssetVerweis('synapse', '/home/blacky/dev/synapse/ui-screenshots/a.png', a.dienste);
  assert.deepEqual(t, [{ art: 'asset', id: 'ui-screenshots/a.png', titel: 'a.png' }]);
  assert.equal(a.fragen.length, 1);
  assert.deepEqual(a.fragen[0].params, ['synapse', 'ui-screenshots/a.png']);
  assert.match(a.fragen[0].sql, /file_path = \$2/);
  assert.match(a.fragen[0].sql, /deleted_at IS NULL/);
  assert.match(a.fragen[0].sql, /mime_type LIKE 'image\/%'/);
});

test('loeseAssetVerweis: relativ ohne Wurzel-Abfrage, asset_id per id', async () => {
  const a = attrappe([{ file_path: 'bilder/b.png', file_name: 'b.png' }]);
  await loeseAssetVerweis('synapse', './bilder/b.png', a.dienste);
  assert.equal(a.wurzelAufrufe, 0, 'relative Pfade brauchen keine Registry');
  assert.deepEqual(a.fragen[0].params, ['synapse', 'bilder/b.png']);
  const i = attrappe([{ file_path: 'bilder/b.png', file_name: 'b.png' }]);
  const t = await loeseAssetVerweis('synapse', '42', i.dienste);
  assert.deepEqual(t, [{ art: 'asset', id: 'bilder/b.png', titel: 'b.png' }]);
  assert.match(i.fragen[0].sql, /id = \$2::bigint/);
  assert.deepEqual(i.fragen[0].params, ['synapse', '42']);
});

test('loeseAssetVerweis: nicht erreichbar -> keine Treffer, ausserhalb ohne DB-Abfrage', async () => {
  const leer = attrappe([]);
  assert.deepEqual(await loeseAssetVerweis('synapse', 'ui-screenshots/fehlt.png', leer.dienste), []);
  const aussen = attrappe([{ file_path: 'x', file_name: 'x' }]);
  assert.deepEqual(await loeseAssetVerweis('synapse', '/etc/passwd.png', aussen.dienste), []);
  assert.equal(aussen.fragen.length, 0, 'Pfad ausserhalb: keine Abfrage');
  assert.deepEqual(await loeseAssetVerweis('synapse', 'a/../b.png', aussen.dienste), []);
  assert.equal(aussen.fragen.length, 0);
});
