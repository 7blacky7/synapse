import test from 'node:test';
import assert from 'node:assert/strict';
import { isBinaryExtension } from '../dist/watcher/binary.js';

test('P4-T73: normale .lock-Dateien bleiben Text, .lockb bleibt binaer', () => {
  for (const path of ['yarn.lock', 'Cargo.lock', 'composer.lock', 'nested/PNPM.LOCK']) {
    assert.equal(isBinaryExtension(path), false, path);
  }
  assert.equal(isBinaryExtension('pnpm-lock.yaml.lockb'), true);
});
