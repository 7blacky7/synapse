import test from 'node:test';
import assert from 'node:assert/strict';
import { isBinaryExtension, isBinaryFile } from '../dist/watcher/binary.js';

test('P4-T45: Netpbm-Familie ist binaer und SVG bleibt Text', () => {
  for (const ext of ['.pbm', '.pgm', '.ppm']) {
    assert.equal(isBinaryExtension('bild' + ext), true, ext);
    assert.equal(isBinaryFile('bild' + ext, Buffer.from('P3 header 1 1 255 255 0 0')), true, ext);
  }
  assert.equal(isBinaryExtension('icon.svg'), false);
  assert.equal(isBinaryFile('icon.svg', Buffer.from('<svg></svg>')), false);
});
