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
  // P18-T26: Vorschau-Katalog = Inspector-Formate PLUS Renderer-Formate (Blocker 238455c6); Transfer unveraendert.
  for (const f of standardRegistry.formats()) assert.ok(c.vorschau.formate.includes(f), f);
  assert.deepEqual(c.speicher.transferFormate, standardRegistry.formats());
});

test('P18-T26: Vorschau-Formate geben alle Formate mit echtem A14-Decoder frei (BMP), Transfer bleibt am Inspector-Katalog', async () => {
  const { ANSICHT_RENDERER_FORMATE, FfmpegAnsichtRenderer } = await import(resolve(here, '../dist/services/asset-ansicht-renderer.js'));
  const c = ladeAssetKonfiguration({});
  assert.ok(Array.isArray(ANSICHT_RENDERER_FORMATE) && ANSICHT_RENDERER_FORMATE.includes('bmp'));
  for (const f of ANSICHT_RENDERER_FORMATE) assert.ok(c.vorschau.formate.includes(f), 'Vorschau-Standard ohne ' + f);
  assert.ok(!c.speicher.transferFormate.includes('bmp'), 'Transfer-Katalog darf nicht still erweitert werden');
  // Explizite Betreiberliste mit bmp ist gueltig, unbekannte Formate bleiben Fehler.
  assert.deepEqual(ladeAssetKonfiguration({ SYNAPSE_ASSET_PREVIEW_FORMATS: 'png,BMP' }).vorschau.formate, ['bmp', 'png']);
  assert.throws(() => ladeAssetKonfiguration({ SYNAPSE_ASSET_PREVIEW_FORMATS: 'bmp,svg' }), /nicht registrierte Formate: svg/);
  assert.throws(() => ladeAssetKonfiguration({ SYNAPSE_ASSET_TRANSFER_FORMATS: 'bmp' }), /nicht registrierte Formate: bmp/);

  // Echter Decoder: 2x1-BMP (24 bit, BGR) -> PNG mit richtigen Abmessungen.
  const { execFileSync } = await import('node:child_process');
  try { execFileSync(c.vorschau.ffmpeg, ['-version'], { stdio: 'ignore' }); execFileSync(c.vorschau.prlimit, ['--version'], { stdio: 'ignore' }); }
  catch { console.log('# ffmpeg/prlimit fehlen: Render-Teil uebersprungen'); return; }
  const pixel = Buffer.from([0, 0, 255, 0, 255, 0, 0, 0]); // Zeile: rot, gruen + 2 Byte Padding
  const kopf = Buffer.alloc(54);
  kopf.write('BM', 0, 'ascii'); kopf.writeUInt32LE(54 + pixel.length, 2); kopf.writeUInt32LE(54, 10);
  kopf.writeUInt32LE(40, 14); kopf.writeInt32LE(2, 18); kopf.writeInt32LE(1, 22); kopf.writeUInt16LE(1, 26);
  kopf.writeUInt16LE(24, 28); kopf.writeUInt32LE(pixel.length, 34);
  const dir = await mkdtemp(join(tmpdir(), 'p18-t26-bmp-'));
  try {
    const datei = join(dir, 'probe.bmp');
    await writeFile(datei, Buffer.concat([kopf, pixel]));
    const { open } = await import('node:fs/promises');
    const fh = await open(datei, 'r');
    try {
      const v = c.vorschau;
      const r = await new FfmpegAnsichtRenderer(c).render(fh.fd, 'bmp', { maxPixel: v.maxPixel, maxBytes: v.maxBytes, maxRamBytes: v.maxRamBytes,
        timeoutMs: v.timeoutMs, maxKante: v.maxKante, maxFrames: v.maxFrames, maxDauerMs: v.maxDauerMs });
      assert.equal(r.breite, 2); assert.equal(r.hoehe, 1);
      assert.ok(r.png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
    } finally { await fh.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
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
