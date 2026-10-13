import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { ladeAssetKonfiguration, loeseAssetProjektoptionen, resetAssetKonfiguration } = await import(resolve(here, '../dist/config/asset-konfig.js'));
const { standardRegistry, inspectAsset } = await import(resolve(here, '../dist/asset-intel/index.js'));
const { getConfig, resetConfig } = await import(resolve(here, '../dist/config.js'));

test('P13-T22: feature-off defaults need no dataset mounts and preserve Inspector limits', () => {
  const c = ladeAssetKonfiguration({});
  assert.equal(c.aktiv, false);
  assert.equal(c.reverse.aktiv, false);
  assert.equal(c.speicher.root, null);
  assert.equal(c.speicher.reverseRoot, null);
  assert.deepEqual(c.inspektion, {
    maxFileBytes: 256 * 1024 * 1024,
    maxReadBytes: 64 * 1024 * 1024,
    maxObjects: 10_000,
    timeoutMs: 30_000,
    maxDepth: 8,
    maxHashBytes: 256 * 1024 * 1024,
  });
  assert.deepEqual(c.vorschau.formate, standardRegistry.formats());
});

test('P13-T22: project overrides can tighten but never exceed operator ceilings', () => {
  const c = ladeAssetKonfiguration({});
  const effective = loeseAssetProjektoptionen(c, {
    richtung: 'share_to_pc',
    maxDateiBytes: 1024,
    erlaubteTypen: [c.speicher.transferFormate[0]],
    vorschau: { maxBytes: 2048, offenSekundenStandard: 60 },
  });
  assert.equal(effective.richtung, 'share_to_pc');
  assert.equal(effective.maxDateiBytes, 1024);
  assert.deepEqual(effective.erlaubteTypen, [c.speicher.transferFormate[0]]);

  assert.equal(effective.vorschau.maxBytes, 2048);
  assert.equal(effective.vorschau.offenSekundenStandard, 60);
  assert.throws(
    () => loeseAssetProjektoptionen(c, { maxDateiBytes: c.speicher.maxDateiBytes + 1 }),
    /Betreibergrenze/,
  );
  assert.throws(
    () => loeseAssetProjektoptionen(c, { erlaubteTypen: ['not-a-registered-asset-format'] }),
    /nicht registrierte Formate/,
  );
});

test('P13-T22: enabled storage requires the exact Projects root env with an absolute path', () => {
  assert.throws(
    () => ladeAssetKonfiguration({ SYNAPSE_ASSET_ENABLED: '1' }),
    /SYNAPSE_PROJEKTE_ROOT/,
  );
  assert.throws(
    () => ladeAssetKonfiguration({ SYNAPSE_ASSET_ENABLED: '1', SYNAPSE_PROJEKTE_ROOT: 'relative/assets' }),
    /SYNAPSE_PROJEKTE_ROOT/,
  );
});

test('P13-T22: enabled reverse storage requires its own root', () => {
  assert.throws(
    () => ladeAssetKonfiguration({ SYNAPSE_REVERSE_ENABLED: 'true' }),
    /SYNAPSE_REVERSE_ROOT/,
  );
});

test('P13-T22: malformed and out-of-bound values fail instead of silently falling back or clamping', () => {
  const base = { SYNAPSE_ASSET_ENABLED: '1', SYNAPSE_PROJEKTE_ROOT: '/srv/synapse-projekte' };
  assert.throws(
    () => ladeAssetKonfiguration({ ...base, SYNAPSE_ASSET_MAX_FILE_BYTES: 'NaN' }),
    /SYNAPSE_ASSET_MAX_FILE_BYTES/,
  );
  assert.throws(
    () => ladeAssetKonfiguration({ ...base, SYNAPSE_ASSET_PARALLEL: '17' }),
    /SYNAPSE_ASSET_PARALLEL/,
  );
  assert.throws(
    () => ladeAssetKonfiguration({ ...base, SYNAPSE_ASSET_SYNC_DIRECTION: 'delete_everything' }),
    /SYNAPSE_ASSET_SYNC_DIRECTION/,
  );
  assert.equal(
    ladeAssetKonfiguration({ ...base, SYNAPSE_ASSET_MAX_FILE_BYTES: '4096' }).speicher.maxDateiBytes,
    4096,
  );
  assert.throws(
    () => ladeAssetKonfiguration({ ...base, SYNAPSE_PROJEKTE_ROOT: `/srv/${String.fromCharCode(0)}assets` }),
    /SYNAPSE_PROJEKTE_ROOT/,
  );
  assert.throws(
    () => ladeAssetKonfiguration({ SYNAPSE_ASSET_ASSETS_DIR: 'assets/subdir' }),
    /SYNAPSE_ASSET_ASSETS_DIR/,
  );
});

test('P13-T22: startup validates asset env and inspectAsset uses centralized inspector limits', async () => {
  const envKeys = [
    'SYNAPSE_ASSET_ENABLED',
    'SYNAPSE_PROJEKTE_ROOT',
    'SYNAPSE_ASSET_INSPECT_MAX_FILE_BYTES',
  ];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  const dir = await mkdtemp(join(tmpdir(), 'p13-a4-konfig-'));
  const file = join(dir, 'unbekannt.asset');
  try {
    delete process.env.SYNAPSE_PROJEKTE_ROOT;
    process.env.SYNAPSE_ASSET_ENABLED = '1';
    resetAssetKonfiguration();
    resetConfig();
    assert.throws(() => getConfig(), /SYNAPSE_PROJEKTE_ROOT/);

    process.env.SYNAPSE_ASSET_ENABLED = '0';
    process.env.SYNAPSE_ASSET_INSPECT_MAX_FILE_BYTES = '1';
    resetAssetKonfiguration();
    resetConfig();
    await writeFile(file, Buffer.from([0, 1]));
    const result = await inspectAsset(file);
    assert.ok(result.warnings.some((w) => w.code === 'datei_zu_gross'), JSON.stringify(result));
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetAssetKonfiguration();
    resetConfig();
    await rm(dir, { recursive: true, force: true });
  }
});
