/** P13-T22 legacy baseline: current inspectAsset output, before central config is wired in. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(resolve(here, '../dist/asset-intel/index.js'));

test('P13-T22: inspectAsset legacy output stays unchanged for an unrecognized file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'p13-a4-golden-'));
  try {
    const file = join(root, 'untyped.p13');
    const bytes = Buffer.from('P13-T22 golden fixture');
    writeFileSync(file, bytes);

    const result = await core.inspectAsset(file, { registry: new core.AssetRegistry() });
    const normalized = { ...result, file_path: '<fixture>', extracted_at: '<timestamp>' };

    assert.deepEqual(normalized, {
      asset_type: 'unbekannt',
      format: null,
      file_path: '<fixture>',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: 'nicht_erkannt',
      inspector: null,
      metadata: {},
      references: [],
      objects: [],
      warnings: [{
        code: 'kein_inspektor',
        message: 'Kein Asset-Inspektor zustaendig (weder Magic noch Endung passt eindeutig).',
      }],
      parser_version: 0,
      extracted_at: '<timestamp>',
      format_specific: {},
    });
    assert.ok(Number.isFinite(Date.parse(result.extracted_at)), 'extracted_at bleibt ein ISO-Zeitwert');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
