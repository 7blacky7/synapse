/**
 * Medien-Inspektoren (P4-T65): WAV, OGG, FLAC, MP3, MP4, MKV, AVI gegen gebautes dist.
 * Zwei Wege werden getestet:
 *   - ffprobe (primaer; Tests mit ffprobe werden uebersprungen, wenn es fehlt)
 *   - Header-Fallback in reinem TypeScript (ffprobePfad auf eine nicht existierende Datei bzw. null)
 * Dateien: handgebaute Spec-Fixtures, ffmpeg-erzeugte Dateien (scripts/asset-fixtures-medien.mjs) und —
 * optional, ASSET_SAMPLES_DIR, Standard ~/dev/synapse-testdaten/asset-samples — ECHTE Fremddateien (fehlen sie, wird uebersprungen).
 * AUFRUF: ASSET_TEST_DIST=/tmp/asset-medien/dist node --test packages/core/tests/asset-intel-medien.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const hier = dirname(fileURLToPath(import.meta.url));
const dist = process.env.ASSET_TEST_DIST || join(hier, '..', 'dist');
const A = await import(join(dist, 'asset-intel', 'index.js'));
const M = await import(join(dist, 'asset-intel', 'inspectors', 'medien', 'index.js'));
const { inspectAsset, AssetRegistry, detectAsset } = A;
const { erzeugeMedienInspektoren, assetMedienInspektoren, baueFfprobeArgs } = M;
const { erzeugeMedienFixtures } = await import(pathToFileURL(join(hier, '..', 'scripts', 'asset-fixtures-medien.mjs')).href);

const NICHT_VORHANDEN = '/nonexistent/ffprobe-gibt-es-nicht';
const OHNE = null; // ffprobe abgeschaltet
const MIT = undefined; // Standard: ffprobe aus dem PATH

function ffprobeDa() {
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
const HAT_FFPROBE = ffprobeDa();
const SKIP_FF = HAT_FFPROBE ? false : 'ffprobe nicht vorhanden';

const KERNFELDER = [
  'asset_type', 'format', 'file_path', 'size', 'sha256', 'status', 'inspector', 'metadata',
  'references', 'objects', 'warnings', 'parser_version', 'extracted_at', 'format_specific',
];
const codes = r => r.warnings.map(w => w.code);
const sha = pfad => createHash('sha256').update(readFileSync(pfad)).digest('hex');

function pruefeSchema(r, wo) {
  for (const k of KERNFELDER) assert.ok(k in r, `${wo}: Feld fehlt: ${k}`);
  assert.ok(['audio', 'video', 'unbekannt'].includes(r.asset_type), `${wo} asset_type ${r.asset_type}`);
  assert.ok(r.format === null || typeof r.format === 'string', wo + ' format');
  assert.ok(Number.isInteger(r.size) && r.size >= 0, wo + ' size');
  assert.ok(r.sha256 === null || /^[0-9a-f]{64}$/.test(r.sha256), wo + ' sha256');
  assert.ok(['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'].includes(r.status), wo + ' status');
  for (const k of ['metadata', 'format_specific']) assert.ok(r[k] && typeof r[k] === 'object' && !Array.isArray(r[k]), `${wo} ${k}`);
  for (const k of ['references', 'objects', 'warnings']) assert.ok(Array.isArray(r[k]), `${wo} ${k}`);
  for (const w of r.warnings) assert.ok(typeof w.code === 'string' && w.code && typeof w.message === 'string', wo + ' warning-Form');
  for (const o of r.objects) {
    assert.ok(typeof o.kind === 'string' && o.kind, wo + ' object.kind');
    assert.ok(o.name === null || typeof o.name === 'string', wo + ' object.name');
    assert.ok(o.data && typeof o.data === 'object', wo + ' object.data');
    if (o.source_range) {
      assert.ok(Number.isInteger(o.source_range.offset) && Number.isInteger(o.source_range.length), wo + ' source_range Form');
      assert.ok(o.source_range.offset >= 0 && o.source_range.length > 0 && o.source_range.offset + o.source_range.length <= r.size, `${wo} source_range ausserhalb (${JSON.stringify(o.source_range)} bei size ${r.size})`);
    }
  }
  assert.ok(!Number.isNaN(Date.parse(r.extracted_at)) && r.extracted_at.endsWith('Z'), wo + ' extracted_at');
  assert.equal(JSON.parse(JSON.stringify(r)).file_path, r.file_path, wo + ' JSON-Roundtrip');
}

function registry(ffprobePfad) {
  const reg = new AssetRegistry();
  for (const i of erzeugeMedienInspektoren({ ffprobePfad })) reg.register(i);
  return reg;
}

let fx;
let P;
let fake;
const aufraeumer = [];
before(async () => {
  fx = await erzeugeMedienFixtures();
  P = fx.pfade;
  // Attrappen-ffprobe: zeichnen Argumente/Umgebung auf bzw. verhalten sich schlecht.
  const dirFake = join(fx.dir, 'fake');
  mkdirSync(dirFake, { recursive: true });
  const skript = (name, inhalt) => {
    const p = join(dirFake, name);
    writeFileSync(p, '#!/bin/sh\n' + inhalt + '\n');
    chmodSync(p, 0o755);
    return p;
  };
  fake = {
    dir: dirFake,
    argsDatei: join(dirFake, 'args.txt'),
    envDatei: join(dirFake, 'env.txt'),
    args: null,
    schlaeft: skript('schlaeft.sh', 'exec sleep 20'),
    muell: skript('muell.sh', 'echo "das ist kein json"'),
    exit1: skript('exit1.sh', 'echo "Boom: kaputt" >&2\nexit 1'),
    gross: skript('gross.sh', "head -c 6000000 /dev/zero | tr '\\0' 'a'"),
    leer: skript('leer.sh', "echo '{}'"),
  };
  fake.args = skript(
    'args.sh',
    `printf '%s\\n' "$@" > '${fake.argsDatei}'\nenv > '${fake.envDatei}'\n` +
      `echo '{"format":{"format_name":"wav","duration":"2.0","bit_rate":"1000","size":"10"},"streams":[{"index":0,"codec_type":"audio","codec_name":"pcm_s16le","sample_rate":"8000","channels":1}]}'`
  );
  aufraeumer.push(() => fx.aufraeumen());
});
after(async () => {
  for (const f of aufraeumer) await f();
});

// ------------------------------------------------------------------ Registrierung und Erkennung

test('Export: zwei Inspektoren, registrierbar, Formate vollstaendig', () => {
  assert.equal(assetMedienInspektoren.length, 2);
  const ids = assetMedienInspektoren.map(i => i.id);
  assert.deepEqual(ids, ['medien-audio', 'medien-video']);
  const reg = new AssetRegistry();
  for (const i of assetMedienInspektoren) reg.register(i);
  assert.deepEqual(reg.formats(), ['avi', 'flac', 'mkv', 'mp3', 'mp4', 'ogg', 'wav']);
  for (const i of assetMedienInspektoren) assert.ok(Number.isInteger(i.version) && i.version >= 1);
});

test('Erkennung per Magic: jedes der sieben Formate trifft den richtigen Inspektor', () => {
  const reg = registry(OHNE);
  const erwartet = {
    handWav: ['medien-audio', 'wav'], handFlac: ['medien-audio', 'flac'], handOgg: ['medien-audio', 'ogg'],
    handMp3: ['medien-audio', 'mp3'], handMp3V1: ['medien-audio', 'mp3'], handMp4: ['medien-video', 'mp4'],
    handMkv: ['medien-video', 'mkv'], handAvi: ['medien-video', 'avi'],
  };
  for (const [k, [id, format]] of Object.entries(erwartet)) {
    const head = readFileSync(P[k]).subarray(0, 4096);
    const d = detectAsset(P[k], head, reg);
    assert.equal(d.inspector?.id, id, k);
    assert.equal(d.format, format, k);
    assert.equal(d.via, 'magic', k);
  }
});

test('RIFF: WAV und AVI werden am Formtyp (Offset 8) unterschieden, nicht an RIFF@0', () => {
  const reg = registry(OHNE);
  const wav = readFileSync(P.handWav).subarray(0, 64);
  const avi = readFileSync(P.handAvi).subarray(0, 64);
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(avi.toString('latin1', 0, 4), 'RIFF');
  assert.equal(detectAsset('x.bin', wav, reg).format, 'wav');
  assert.equal(detectAsset('x.bin', avi, reg).format, 'avi');
  // Endung widerspricht dem Inhalt: der Inhalt gilt, mit Warnung.
  const d = detectAsset('film.avi', wav, reg);
  assert.equal(d.format, 'wav');
  assert.ok(d.warnings.some(w => w.code === 'endung_widerspricht_inhalt'));
});

test('Kollisionsfreiheit: ein WebP-Inspektor mit WEBP@8 stoert WAV/AVI nicht', () => {
  const reg = registry(OHNE);
  reg.register({
    id: 'fremd-webp', formats: ['webp'], extensions: ['.webp'], version: 1,
    magic: [{ offset: 8, bytes: [0x57, 0x45, 0x42, 0x50], format: 'webp' }],
    inspect: async () => ({}),
  });
  const wav = readFileSync(P.handWav).subarray(0, 64);
  const d = detectAsset('a.wav', wav, reg);
  assert.equal(d.inspector.id, 'medien-audio');
  assert.deepEqual(d.warnings, []);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
  assert.equal(detectAsset('a.webp', webp, reg).inspector.id, 'fremd-webp');
});

// ------------------------------------------------------------------ Header-Fallback: exakte Felder

const MODI_OHNE = [['Fallback (ffprobe nicht vorhanden)', NICHT_VORHANDEN], ['Fallback (ffprobe abgeschaltet)', OHNE]];

for (const [modus, ffp] of MODI_OHNE) {
  test(`${modus}: WAV exakt`, async () => {
    const r = await inspectAsset(P.handWav, { registry: registry(ffp) });
    pruefeSchema(r, 'wav');
    assert.equal(r.status, 'teilweise');
    assert.ok(codes(r).includes('ffprobe_nicht_verfuegbar'));
    assert.equal(r.format, 'wav');
    assert.equal(r.asset_type, 'audio');
    assert.equal(r.inspector, 'medien-audio');
    assert.equal(r.parser_version, 1);
    assert.equal(r.format_specific.quelle, 'header_fallback');
    assert.equal(r.metadata.container, 'wav');
    assert.equal(r.metadata.duration_s, 2);
    assert.equal(r.metadata.bit_rate, 128000);
    assert.equal(r.metadata.stream_count, 1);
    assert.deepEqual(r.metadata.tags, { title: 'Handton', artist: 'Tester' });
    assert.equal(r.objects.length, 1);
    const s = r.objects[0];
    assert.equal(s.kind, 'audio_stream');
    assert.equal(s.data.codec_name, 'pcm_s16le');
    assert.equal(s.data.sample_rate, 8000);
    assert.equal(s.data.channels, 1);
    assert.equal(s.data.bits_per_sample, 16);
    assert.deepEqual(s.source_range, { offset: 12, length: 24 });
    assert.equal(readFileSync(P.handWav).toString('latin1', 12, 16), 'fmt ');
  });
}

test('Fallback: FLAC exakt (STREAMINFO + VORBIS_COMMENT)', async () => {
  const r = await inspectAsset(P.handFlac, { registry: registry(OHNE) });
  pruefeSchema(r, 'flac');
  assert.equal(r.format, 'flac');
  assert.equal(r.metadata.duration_s, 2);
  assert.deepEqual(r.metadata.tags, { encoder: 'Handschrift 1.0', title: 'Handklang', artist: 'Tester' });
  const s = r.objects[0];
  assert.equal(s.kind, 'audio_stream');
  assert.deepEqual([s.data.codec_name, s.data.sample_rate, s.data.channels, s.data.bits_per_sample, s.data.total_samples], ['flac', 44100, 2, 16, 88200]);
  assert.deepEqual(s.source_range, { offset: 4, length: 38 });
  assert.equal(r.format_specific.bit_rate_geschaetzt, true);
});

test('Fallback: OGG Vorbis exakt, Dauer aus der letzten Seite', async () => {
  const r = await inspectAsset(P.handOgg, { registry: registry(OHNE) });
  pruefeSchema(r, 'ogg');
  assert.equal(r.format, 'ogg');
  assert.equal(r.metadata.duration_s, 1);
  assert.equal(r.metadata.tags.title, 'Handvogel');
  assert.equal(r.metadata.tags.artist, 'Tester');
  const s = r.objects[0];
  assert.deepEqual([s.kind, s.data.codec_name, s.data.sample_rate, s.data.channels, s.data.bit_rate], ['audio_stream', 'vorbis', 44100, 2, 128000]);
  assert.deepEqual(s.source_range, { offset: 0, length: 58 });
});

test('Fallback: OGG Opus exakt (Pre-Skip wird abgezogen)', async () => {
  const r = await inspectAsset(P.handOpus, { registry: registry(OHNE) });
  pruefeSchema(r, 'opus');
  assert.equal(r.metadata.duration_s, 1);
  assert.equal(r.metadata.tags.title, 'Handopus');
  const s = r.objects[0];
  assert.deepEqual([s.data.codec_name, s.data.sample_rate, s.data.channels, s.data.pre_skip], ['opus', 48000, 2, 312]);
});

test('Fallback: MP3 mit ID3v2.3, CBR-Dauer als Schaetzung gekennzeichnet', async () => {
  const r = await inspectAsset(P.handMp3, { registry: registry(OHNE) });
  pruefeSchema(r, 'mp3');
  assert.equal(r.format, 'mp3');
  assert.deepEqual(r.metadata.tags, { title: 'Handlied', artist: 'Tester', album: 'Handalbum' });
  const s = r.objects[0];
  assert.deepEqual([s.data.codec_name, s.data.sample_rate, s.data.channels, s.data.bit_rate, s.data.mpeg_version, s.data.layer, s.data.vbr], ['mp3', 44100, 2, 128000, 1, 3, false]);
  assert.equal(r.metadata.duration_s, 0.52125);
  assert.equal(r.format_specific.dauer_geschaetzt, true);
  assert.equal(r.format_specific.id3v2, '2.3.0');
  assert.equal(s.source_range.length, 417);
});

test('Fallback: MP3 mit Xing-Kopf (Frames -> Dauer, LAME-Kennung), ID3v1, Cover', async () => {
  const x = await inspectAsset(P.handMp3Xing, { registry: registry(OHNE) });
  pruefeSchema(x, 'xing');
  assert.equal(x.format_specific.vbr_kopf, 'Xing');
  assert.equal(x.format_specific.dauer_geschaetzt, false);
  assert.equal(x.metadata.duration_s, 2.612245);
  assert.equal(x.objects[0].data.vbr, true);
  assert.equal(x.objects[0].data.frames, 100);
  assert.equal(x.metadata.tags.encoder, 'LAME3.100');

  const v1 = await inspectAsset(P.handMp3V1, { registry: registry(OHNE) });
  pruefeSchema(v1, 'id3v1');
  assert.equal(v1.format_specific.id3v1, true);
  assert.equal(v1.format_specific.id3v2, null);
  assert.deepEqual([v1.metadata.tags.title, v1.metadata.tags.artist], ['Altlied', 'Altkuenstler']);

  const c = await inspectAsset(P.handMp3Cover, { registry: registry(OHNE) });
  pruefeSchema(c, 'cover');
  const anh = c.objects.filter(o => o.kind === 'attachment');
  assert.equal(anh.length, 1);
  assert.equal(anh[0].data.typ, 'id3_apic');
  assert.ok(anh[0].source_range.length > 20);
});

test('Fallback: MP4 exakt (ftyp, mvhd, zwei Tracks mit Codec, Abmessungen, Sprache)', async () => {
  const r = await inspectAsset(P.handMp4, { registry: registry(OHNE) });
  pruefeSchema(r, 'mp4');
  assert.equal(r.format, 'mp4');
  assert.equal(r.asset_type, 'video');
  assert.equal(r.inspector, 'medien-video');
  assert.equal(r.metadata.container, 'mp4');
  assert.equal(r.metadata.duration_s, 2);
  assert.equal(r.format_specific.major_brand, 'isom');
  assert.deepEqual(r.format_specific.compatible_brands, ['isom', 'mp42']);
  const v = r.objects.find(o => o.kind === 'video_stream');
  const a = r.objects.find(o => o.kind === 'audio_stream');
  assert.deepEqual([v.data.codec_name, v.data.codec_tag, v.data.width, v.data.height, v.data.nb_frames, v.data.avg_frame_rate, v.data.language], ['h264', 'avc1', 64, 48, 20, 10, 'eng']);
  assert.deepEqual([a.data.codec_name, a.data.sample_rate, a.data.channels, a.data.bits_per_sample, a.data.duration_s], ['aac', 44100, 2, 16, 2]);
  assert.equal(r.metadata.width, 64);
  assert.equal(r.metadata.audio_codec, 'aac');
  const bytes = readFileSync(P.handMp4);
  for (const o of [v, a]) assert.equal(bytes.toString('latin1', o.source_range.offset + 4, o.source_range.offset + 8), 'trak');
});

test('Fallback: MKV exakt (EBML, Info, Tracks mit Video/Audio/Untertitel)', async () => {
  const r = await inspectAsset(P.handMkv, { registry: registry(OHNE) });
  pruefeSchema(r, 'mkv');
  assert.equal(r.format, 'mkv');
  assert.equal(r.metadata.container, 'matroska');
  assert.equal(r.format_specific.doc_type, 'matroska');
  assert.equal(r.metadata.duration_s, 2);
  assert.equal(r.metadata.tags.title, 'Handfilm');
  assert.deepEqual(r.objects.map(o => o.kind), ['video_stream', 'audio_stream', 'subtitle_stream']);
  const [v, a, s] = r.objects;
  assert.deepEqual([v.name, v.data.codec_name, v.data.codec_id, v.data.width, v.data.height, v.data.avg_frame_rate], ['Bild', 'vp9', 'V_VP9', 320, 240, 24]);
  assert.deepEqual([a.data.codec_name, a.data.sample_rate, a.data.channels, a.data.language], ['opus', 48000, 2, 'ger']);
  assert.deepEqual([s.data.codec_name, s.data.language], ['subrip', 'eng']);
  const bytes = readFileSync(P.handMkv);
  for (const o of r.objects) assert.equal(bytes[o.source_range.offset], 0xae);
});

test('Fallback: AVI exakt (avih, strh/strf je Stream, INFO-Tag)', async () => {
  const r = await inspectAsset(P.handAvi, { registry: registry(OHNE) });
  pruefeSchema(r, 'avi');
  assert.equal(r.format, 'avi');
  assert.equal(r.metadata.duration_s, 2);
  assert.equal(r.metadata.tags.title, 'Handfilm');
  assert.equal(r.format_specific.avih.mikrosekunden_pro_frame, 40000);
  const [v, a] = r.objects;
  assert.deepEqual([v.kind, v.name, v.data.codec_name, v.data.codec_tag, v.data.width, v.data.height, v.data.avg_frame_rate, v.data.nb_frames], ['video_stream', 'Bild', 'mpeg4', 'XVID', 64, 48, 25, 50]);
  assert.deepEqual([a.kind, a.data.codec_name, a.data.sample_rate, a.data.channels, a.data.duration_s], ['audio_stream', 'pcm_s16le', 44100, 2, 2]);
  const bytes = readFileSync(P.handAvi);
  for (const o of r.objects) assert.equal(bytes.toString('latin1', o.source_range.offset, o.source_range.offset + 4), 'LIST');
});

// ------------------------------------------------------------------ ffprobe-Weg

test('ffprobe: ffmpeg-erzeugte Audiodateien (echte Fremdwerkzeug-Dateien) exakt', { skip: SKIP_FF }, async () => {
  if (!fx.ffmpeg) return;
  const reg = registry(MIT);
  const erwartet = [
    ['ffWav', 'wav', 'pcm_s16le', 44100, 1],
    ['ffFlac', 'flac', 'flac', 44100, 1],
    ['ffOgg', 'ogg', 'vorbis', 44100, 1],
    ['ffMp3', 'mp3', 'mp3', 44100, 1],
  ];
  for (const [k, format, codec, rate, ch] of erwartet) {
    if (!P[k]) continue; // Encoder fehlt in dieser ffmpeg-Version
    const r = await inspectAsset(P[k], { registry: reg });
    pruefeSchema(r, k);
    assert.equal(r.status, 'ok', `${k}: ${JSON.stringify(r.warnings)}`);
    assert.equal(r.format_specific.quelle, 'ffprobe');
    assert.equal(r.format, format);
    assert.equal(r.asset_type, 'audio');
    const s = r.objects.find(o => o.kind === 'audio_stream');
    assert.deepEqual([s.data.codec_name, s.data.sample_rate, s.data.channels], [codec, rate, ch], k);
    assert.ok(Math.abs(r.metadata.duration_s - 1) < 0.06, `${k} Dauer ${r.metadata.duration_s}`);
    assert.equal(r.metadata.tags.title, 'Sinus', k);
    assert.equal(r.metadata.tags.artist, 'Tester', k);
    assert.ok(r.metadata.bit_rate > 0);
  }
});

test('ffprobe: ffmpeg-erzeugte Videodateien — Streams, Framerate als Zahl+Bruch, Kapitel, Untertitel, Sprache', { skip: SKIP_FF }, async () => {
  if (!P.ffMp4) return;
  const reg = registry(MIT);
  for (const k of ['ffMp4', 'ffMkv', 'ffAvi']) {
    if (!P[k]) continue;
    const r = await inspectAsset(P[k], { registry: reg });
    pruefeSchema(r, k);
    assert.equal(r.status, 'ok', `${k}: ${JSON.stringify(r.warnings)}`);
    assert.equal(r.asset_type, 'video');
    assert.equal(r.metadata.tags.title, 'Testfilm', k);
    const v = r.objects.find(o => o.kind === 'video_stream');
    const a = r.objects.find(o => o.kind === 'audio_stream');
    assert.deepEqual([v.data.codec_name, v.data.width, v.data.height, v.data.avg_frame_rate, v.data.avg_frame_rate_bruch], ['mpeg4', 64, 64, 10, '10/1'], k);
    assert.ok(v.data.pix_fmt, k);
    assert.equal(a.data.sample_rate, 44100);
    assert.equal(r.metadata.video_codec, 'mpeg4');
    assert.equal(r.metadata.audio_codec, a.data.codec_name);
    assert.ok(Math.abs(r.metadata.duration_s - 2) < 0.1, `${k} Dauer ${r.metadata.duration_s}`);
  }
  for (const k of ['ffMp4', 'ffMkv']) {
    if (!P[k]) continue;
    const r = await inspectAsset(P[k], { registry: reg });
    const kap = r.objects.filter(o => o.kind === 'chapter');
    assert.deepEqual(kap.map(o => o.name), ['Eins', 'Zwei'], k);
    assert.deepEqual([kap[0].data.start_s, kap[0].data.end_s, kap[1].data.start_s, kap[1].data.end_s], [0, 1, 1, 2], k);
    const aud = r.objects.find(o => o.kind === 'audio_stream');
    assert.equal(aud.data.language, 'deu', k);
  }
  if (P.ffMkv) {
    const r = await inspectAsset(P.ffMkv, { registry: reg });
    const sub = r.objects.find(o => o.kind === 'subtitle_stream');
    assert.equal(sub.data.codec_name, 'subrip');
  }
});

test('ffprobe: Handdateien liefern dieselben Eckwerte wie der Header-Fallback (Gegenprobe der beiden Wege)', { skip: SKIP_FF }, async () => {
  const mit = registry(MIT);
  const ohne = registry(OHNE);
  for (const k of ['handWav', 'handFlac', 'handOpus', 'handMp3', 'handMp3V1', 'handMp4', 'handMkv', 'handAvi']) {
    const a = await inspectAsset(P[k], { registry: mit });
    const b = await inspectAsset(P[k], { registry: ohne });
    assert.equal(a.format_specific.quelle, 'ffprobe', `${k}: ${JSON.stringify(a.warnings)}`);
    assert.equal(b.format_specific.quelle, 'header_fallback', k);
    assert.equal(a.format, b.format, k);
    assert.equal(a.asset_type, b.asset_type, k);
    assert.ok(Math.abs(a.metadata.duration_s - b.metadata.duration_s) < 0.02, `${k}: ${a.metadata.duration_s} vs ${b.metadata.duration_s}`);
    const hauptstreams = r => r.objects.filter(o => ['audio_stream', 'video_stream'].includes(o.kind)).map(o => [o.kind, o.data.codec_name, o.data.sample_rate ?? o.data.width, o.data.channels ?? o.data.height]);
    assert.deepEqual(hauptstreams(a), hauptstreams(b), k);
  }
});

test('ffprobe: Gegenpruefung ergaenzt source_range und meldet abgeschnittene Datei, die ffprobe selbst nicht bemaengelt', { skip: SKIP_FF }, async () => {
  const ok = await inspectAsset(P.handMp4, { registry: registry(MIT) });
  assert.equal(ok.status, 'ok');
  assert.equal(ok.format_specific.header_pruefung, 'bestanden');
  for (const o of ok.objects) assert.ok(o.source_range, 'source_range fehlt bei ' + o.kind);
  const bad = await inspectAsset(P.wavAbgeschnitten, { registry: registry(MIT) });
  assert.equal(bad.format_specific.quelle, 'ffprobe');
  assert.equal(bad.status, 'teilweise');
  assert.ok(codes(bad).includes('datei_abgeschnitten'));
  assert.equal(bad.format_specific.header_pruefung, 'auffaellig');
});

// ------------------------------------------------------------------ Verfuegbarkeit / Fehlverhalten von ffprobe

test('ffprobe fehlt: Warnung ffprobe_nicht_verfuegbar, Fallback laeuft, kein Absturz', async () => {
  const r = await inspectAsset(P.handMp3, { registry: registry(NICHT_VORHANDEN) });
  assert.ok(codes(r).includes('ffprobe_nicht_verfuegbar'));
  assert.equal(r.status, 'teilweise');
  assert.equal(r.objects[0].data.codec_name, 'mp3');
});

test('ffprobe misslingt (Exit != 0, kaputtes JSON, leeres JSON, riesige Ausgabe): Warnung ffprobe_fehlgeschlagen + Fallback', async () => {
  const faelle = [
    [fake.exit1, /Exit 1.*Boom/],
    [fake.muell, /kein gueltiges JSON/],
    [fake.leer, /keine Streams/],
    [fake.gross, /Ausgabe ueber/],
  ];
  for (const [skript, muster] of faelle) {
    const r = await inspectAsset(P.handWav, { registry: registry(skript) });
    pruefeSchema(r, skript);
    const w = r.warnings.find(x => x.code === 'ffprobe_fehlgeschlagen');
    assert.ok(w, `${skript}: ${JSON.stringify(r.warnings)}`);
    assert.match(w.message, muster, skript);
    assert.equal(r.status, 'teilweise');
    assert.equal(r.format_specific.quelle, 'header_fallback');
    assert.equal(r.metadata.duration_s, 2);
  }
});

test('ffprobe haengt: Timeout beendet es, Fallback liefert trotzdem ein Ergebnis', async () => {
  const t0 = Date.now();
  const r = await inspectAsset(P.handWav, { registry: registry(fake.schlaeft), timeoutMs: 2000 });
  const dauer = Date.now() - t0;
  assert.ok(dauer < 4000, `dauerte ${dauer} ms`);
  const w = r.warnings.find(x => x.code === 'ffprobe_fehlgeschlagen');
  assert.ok(w && /Zeitgrenze/.test(w.message), JSON.stringify(r.warnings));
  assert.equal(r.status, 'teilweise');
  assert.equal(r.metadata.duration_s, 2);
});

test('Aufruf: festes Argument-Array, file:-Praefix, Whitelists, minimale Umgebung (kein Shell-String)', async () => {
  process.env.SYNAPSE_TEST_SENTINEL = 'darf-nicht-durchkommen';
  try {
    const r = await inspectAsset(P.handWav, { registry: registry(fake.args) });
    assert.equal(r.format_specific.quelle, 'ffprobe', JSON.stringify(r.warnings));
    const args = readFileSync(fake.argsDatei, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(args.slice(-2), ['-i', 'file:' + resolve(P.handWav)]);
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file');
    assert.ok(args[args.indexOf('-format_whitelist') + 1].includes('mov'));
    assert.equal(args[args.indexOf('-print_format') + 1], 'json');
    assert.ok(args.includes('-show_streams') && args.includes('-show_format') && args.includes('-show_chapters'));
    const env = readFileSync(fake.envDatei, 'utf8');
    assert.ok(!env.includes('SYNAPSE_TEST_SENTINEL'), 'Umgebung wurde durchgereicht');
    assert.ok(!/^HOME=/m.test(env), 'HOME wurde durchgereicht');
    assert.ok(/^PATH=/m.test(env));
  } finally {
    delete process.env.SYNAPSE_TEST_SENTINEL;
  }
});

test('baueFfprobeArgs: relativer und fuehrend-minus-Pfad werden absolut mit file:-Praefix', () => {
  const a = baueFfprobeArgs('-evil.wav', 1024 * 1024);
  assert.equal(a[a.length - 2], '-i');
  assert.equal(a[a.length - 1], 'file:' + resolve('-evil.wav'));
  assert.ok(a[a.length - 1].startsWith('file:/'));
  for (const p of ['http://x/y.wav', 'concat:a|b', 'pipe:0', 'x:y.wav']) {
    assert.equal(baueFfprobeArgs(p, 1).at(-1), 'file:' + resolve(p));
  }
  assert.ok(Array.isArray(a) && a.every(x => typeof x === 'string'));
});

test('Umgebungsvariable SYNAPSE_FFPROBE_PATH waehlt den ffprobe, ffprobePfad hat Vorrang', async () => {
  const insp = erzeugeMedienInspektoren(); // keine Option
  const reg = new AssetRegistry();
  for (const i of insp) reg.register(i);
  process.env.SYNAPSE_FFPROBE_PATH = fake.args;
  try {
    const r = await inspectAsset(P.handWav, { registry: reg });
    assert.equal(r.format_specific.quelle, 'ffprobe');
    assert.equal(r.metadata.bit_rate, 1000, 'Attrappe muss gelaufen sein');
    process.env.SYNAPSE_FFPROBE_PATH = NICHT_VORHANDEN;
    const r2 = await inspectAsset(P.handWav, { registry: reg });
    assert.ok(codes(r2).includes('ffprobe_nicht_verfuegbar'));
    // Option schlaegt die Variable
    const r3 = await inspectAsset(P.handWav, { registry: registry(fake.args) });
    assert.equal(r3.metadata.bit_rate, 1000);
  } finally {
    delete process.env.SYNAPSE_FFPROBE_PATH;
  }
});

// ------------------------------------------------------------------ Pfade und Sicherheit

for (const [modus, ffp] of [['ffprobe', MIT], ['Fallback', NICHT_VORHANDEN]]) {
  test(`Schwierige Dateinamen (Leerzeichen/Umlaut, fuehrendes '-', 'x:y.wav', 'http:'-Name, Sonderzeichen) — ${modus}`, { skip: ffp === MIT ? SKIP_FF : false }, async () => {
    const reg = registry(ffp);
    for (const k of ['sonderLeerzeichenUmlaut', 'sonderFuehrendBindestrich', 'sonderDoppelpunkt', 'sonderProtokoll', 'sonderZeichen']) {
      const r = await inspectAsset(P[k], { registry: reg });
      pruefeSchema(r, k);
      assert.equal(r.file_path, P[k]);
      assert.equal(r.format_specific.quelle, ffp === MIT ? 'ffprobe' : 'header_fallback', `${k}: ${JSON.stringify(r.warnings)}`);
      assert.equal(r.metadata.duration_s, 2, k);
      assert.equal(r.objects[0].data.sample_rate, 8000, k);
      assert.equal(r.format, 'wav', k);
    }
  });
}

test('Sicherheit: Textdatei mit ffconcat-Inhalt unter .mp4 wird nicht als Demuxer-Skript ausgefuehrt', { skip: SKIP_FF }, async () => {
  const r = await inspectAsset(P.ffconcatMp4, { registry: registry(MIT) });
  pruefeSchema(r, 'ffconcat');
  assert.equal(r.status, 'fehler');
  const w = r.warnings.find(x => x.code === 'ffprobe_fehlgeschlagen');
  assert.ok(w && /whitelist/i.test(w.message), JSON.stringify(r.warnings));
  assert.equal(r.objects.length, 0);
});

test('Nur lesend: Hash und mtime der Fixtures bleiben nach beiden Wegen unveraendert', async () => {
  const p = P.handMp4;
  const vorher = { sha: sha(p), mtime: statSync(p).mtimeMs };
  for (const ffp of [MIT, OHNE, NICHT_VORHANDEN]) await inspectAsset(p, { registry: registry(ffp) });
  assert.equal(sha(p), vorher.sha);
  assert.equal(statSync(p).mtimeMs, vorher.mtime);
  const r = await inspectAsset(p, { registry: registry(OHNE) });
  assert.equal(r.sha256, vorher.sha);
});

// ------------------------------------------------------------------ kaputte, abgeschnittene, falsche, absurde Dateien

const BEIDE = [['ffprobe', MIT], ['Fallback', OHNE]];

for (const [modus, ffp] of BEIDE) {
  test(`abgeschnittene Dateien werfen nie und tragen Warnungen — ${modus}`, { skip: ffp === MIT ? SKIP_FF : false }, async () => {
    const reg = registry(ffp);
    const erwartetCode = {
      wavAbgeschnitten: 'datei_abgeschnitten', wavKopfNur: 'fmt_chunk_zu_kurz', flacAbgeschnitten: 'datei_abgeschnitten',
      oggAbgeschnitten: 'dauer_unbekannt', mp3Abgeschnitten: 'kein_frame_gefunden', mp4Abgeschnitten: 'moov_abgeschnitten',
      mkvAbgeschnitten: 'info_fehlt', aviAbgeschnitten: 'datei_abgeschnitten',
    };
    for (const [k, code] of Object.entries(erwartetCode)) {
      const r = await inspectAsset(P[k], { registry: reg });
      pruefeSchema(r, k);
      assert.notEqual(r.status, 'ok', `${k}: abgeschnittene Datei darf nicht 'ok' sein`);
      assert.ok(['teilweise', 'fehler'].includes(r.status), k);
      assert.ok(r.warnings.length > 0, k);
      assert.ok(codes(r).includes(code), `${k}: erwartet ${code}, war ${codes(r)}`);
    }
    // gekuerztes WAV: die Dauer folgt dem tatsaechlich Vorhandenen (10000 - 44 - INFO-Liste Bytes)
    const w = await inspectAsset(P.wavAbgeschnitten, { registry: reg });
    assert.ok(Math.abs(w.metadata.duration_s - 0.6195) < 0.001, String(w.metadata.duration_s));
  });

  test(`leere Datei, falsche Magic, Endung passt nicht zum Inhalt — ${modus}`, { skip: ffp === MIT ? SKIP_FF : false }, async () => {
    const reg = registry(ffp);
    const leer = await inspectAsset(P.leer, { registry: reg });
    pruefeSchema(leer, 'leer');
    assert.ok(codes(leer).includes('datei_leer'));
    assert.equal(leer.objects.length, 0);

    const png = await inspectAsset(P.pngAlsWav, { registry: reg });
    pruefeSchema(png, 'png-als-wav');
    assert.equal(png.status, 'fehler');
    assert.ok(codes(png).includes('magic_fehlt'));
    assert.ok(codes(png).includes('header_ungueltig'));

    const muell = await inspectAsset(P.muellMp3, { registry: reg });
    assert.equal(muell.status, 'fehler');
    assert.ok(codes(muell).includes('header_ungueltig'));

    // WAV-Inhalt unter .mp3: der Inhalt (Magic) gilt
    const wavMp3 = await inspectAsset(P.wavAlsMp3, { registry: reg });
    pruefeSchema(wavMp3, 'wav-als-mp3');
    assert.equal(wavMp3.format, 'wav');
    assert.equal(wavMp3.asset_type, 'audio');
    assert.equal(wavMp3.metadata.duration_s, 2);
  });

  test(`boesartige Laengen/Werte (absurde Chunk-, Tag-, Box-, Elementgroessen) — ${modus}`, { skip: ffp === MIT ? SKIP_FF : false }, async () => {
    const reg = registry(ffp);
    const t0 = Date.now();
    for (const k of ['wavAbsurd', 'wavDataRiesig', 'flacKommentarRiesig', 'mp3Id3Riesig', 'mp4MoovRiesig', 'mkvInfoRiesig']) {
      const r = await inspectAsset(P[k], { registry: reg });
      pruefeSchema(r, k);
      assert.ok(['ok', 'teilweise', 'fehler'].includes(r.status), k);
    }
    assert.ok(Date.now() - t0 < 20000, 'zu langsam');
    const a = await inspectAsset(P.wavAbsurd, { registry: registry(OHNE) });
    assert.ok(codes(a).includes('werte_unplausibel'));
    assert.equal(a.metadata.duration_s, null);
    const d = await inspectAsset(P.wavDataRiesig, { registry: registry(OHNE) });
    assert.ok(codes(d).includes('datei_abgeschnitten'));
    assert.equal(d.metadata.duration_s, 2, 'Dauer folgt den vorhandenen Bytes, nicht den behaupteten 4 GiB');
    const f = await inspectAsset(P.flacKommentarRiesig, { registry: registry(OHNE) });
    assert.ok(codes(f).includes('tags_unvollstaendig'));
    assert.deepEqual(f.metadata.tags, {});
    const m = await inspectAsset(P.mp3Id3Riesig, { registry: registry(OHNE) });
    assert.ok(codes(m).includes('id3_ueberschreitet_datei'));
    const mp = await inspectAsset(P.mp4MoovRiesig, { registry: registry(OHNE) });
    assert.ok(codes(mp).includes('moov_abgeschnitten'));
    assert.equal(mp.objects.length, 2, 'lesbarer Teil der moov-Box wird trotzdem ausgewertet');
  });

  test(`Grenzen: maxObjects kappt Streams mit Warnung, maxFileBytes, maxReadBytes — ${modus}`, { skip: ffp === MIT ? SKIP_FF : false }, async () => {
    const reg = registry(ffp);
    const k = await inspectAsset(P.handMkvVieleTracks, { registry: reg, maxObjects: 10 });
    pruefeSchema(k, 'viele-tracks');
    assert.equal(k.objects.length, 10);
    // Der Header-Parser kappt selbst ('streams_gekappt'), der ffprobe-Weg ueber baueErgebnis ('objekte_gekappt').
    assert.ok(codes(k).some(c => c === 'objekte_gekappt' || c === 'streams_gekappt'), JSON.stringify(codes(k)));
    assert.equal(k.status, 'teilweise');
    const voll = await inspectAsset(P.handMkvVieleTracks, { registry: reg });
    assert.equal(voll.objects.length, 53);
    assert.equal(voll.metadata.stream_count, 53);

    const zuGross = await inspectAsset(P.handWav, { registry: reg, maxFileBytes: 100 });
    assert.ok(codes(zuGross).includes('datei_zu_gross'));
    assert.equal(zuGross.objects.length, 0);

    const lese = await inspectAsset(P.handFlac, { registry: reg, maxReadBytes: 16 });
    pruefeSchema(lese, 'lesegrenze');
    if (ffp === OHNE) {
      assert.equal(lese.status, 'fehler');
      assert.ok(codes(lese).includes('lesegrenze_ueberschritten'));
    }
  });
}

// ------------------------------------------------------------------ Fixtures

test('Fixtures deterministisch: Handdateien bei jedem Lauf byte-gleich, keine Binaerdateien im Repo', async () => {
  const zweit = await erzeugeMedienFixtures(undefined, { ffmpeg: false });
  try {
    for (const k of Object.keys(P).filter(n => !n.startsWith('ff') || n === 'ffconcatMp4')) {
      assert.equal(sha(zweit.pfade[k]), sha(P[k]), k);
    }
  } finally {
    await zweit.aufraeumen();
  }
  if (fx.ffmpeg) {
    // ffmpeg mit +bitexact: die Fremdwerkzeug-Dateien sind stabil — ausser ffOgg (libvorbis) und ffMkv (Matroska-Muxer),
    // die bei jedem Lauf andere Bytes liefern (gemessen); Tests pruefen dort nur Werte, nie den Hash.
    const dritt = await erzeugeMedienFixtures();
    try {
      for (const k of Object.keys(P).filter(n => /^ff[A-Z]/.test(n) && n !== 'ffOgg' && n !== 'ffMkv')) assert.equal(sha(dritt.pfade[k]), sha(P[k]), k);
    } finally {
      await dritt.aufraeumen();
    }
  }
});

test('Ergebnisschema vollstaendig und serialisierbar fuer ALLE Fixtures in beiden Wegen', async () => {
  for (const ffp of [OHNE, ...(HAT_FFPROBE ? [MIT] : [])]) {
    const reg = registry(ffp);
    for (const [k, p] of Object.entries(P)) {
      const r = await inspectAsset(p, { registry: reg });
      pruefeSchema(r, `${k}/${ffp === MIT ? 'ffprobe' : 'fallback'}`);
      if (r.status === 'ok') assert.ok(r.inspector === 'medien-audio' || r.inspector === 'medien-video', k);
      if (r.inspector) assert.equal(r.parser_version, 1, k);
    }
  }
});

// ------------------------------------------------------------------ echte Fremddateien (optional)

const SAMPLES = process.env.ASSET_SAMPLES_DIR || [process.env.HOME, 'dev', 'synapse-testdaten', 'asset-samples'].join('/');
const ECHT = [
  // [Datei, erwartetes Format, Fallback kennt die Dauer]
  ['wav/Ashukuwa.wav', 'wav', true],
  ['flac/bear.flac', 'flac', true],
  ['flac/Zotero_pronunciation_CC0.flac', 'flac', true],
  ['mp3/Lb-queckselwer2.mp3', 'mp3', true],
  ['ogg/Example_sound_file_in_Ogg_Vorbis_format.ogg', 'ogg', true],
  ['ogv/Night_phase.ogv', 'ogg', true],
  ['webm/Glitch1.webm', 'mkv', true],
  ['mp4/bear.mp4', 'mp4', true],
  ['mp4/bear-320x240-v_frag-vp9.mp4', 'mp4', false], // fragmentiert: mvhd ohne Dauer, ffprobe liest die Fragmente
  ['mkv/testsrc-no-durations-h264.mkv', 'mkv', true], // beide Wege: keine Dauer
  ['mkv/vorbis_audio_wmv_video.mkv', 'mkv', true],
  ['avi/bear.avi', 'avi', true],
];

function rohProbe(pfad) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', 'file:' + pfad], { encoding: 'utf8', timeout: 20000 });
  return JSON.parse(out);
}

function vergleicheMitRoh(r, roh, wo, dauerBekannt) {
  const fd = roh.format.duration;
  if (fd === undefined || fd === 'N/A') {
    assert.equal(r.metadata.duration_s, null, wo + ' Dauer (ffprobe CLI kennt keine)');
  } else if (dauerBekannt) {
    assert.ok(Math.abs(r.metadata.duration_s - Number(fd)) <= 0.02, `${wo}: Dauer ${r.metadata.duration_s} vs ffprobe CLI ${fd}`);
  } else {
    assert.equal(r.metadata.duration_s, null, wo + ' Dauer (Fallback kennt sie nicht)');
    assert.ok(codes(r).includes('mvhd_fehlt'), wo);
  }
  const rohAudio = roh.streams.filter(s => s.codec_type === 'audio');
  const rohVideo = roh.streams.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = r.objects.filter(o => o.kind === 'audio_stream');
  const video = r.objects.filter(o => o.kind === 'video_stream');
  assert.equal(audio.length, rohAudio.length, wo + ' Anzahl Audiostreams');
  assert.equal(video.length, rohVideo.length, wo + ' Anzahl Videostreams');
  rohAudio.forEach((s, i) => {
    assert.deepEqual([audio[i].data.codec_name, audio[i].data.sample_rate, audio[i].data.channels], [s.codec_name, Number(s.sample_rate), s.channels], `${wo} Audio ${i}`);
  });
  rohVideo.forEach((s, i) => {
    assert.deepEqual([video[i].data.codec_name, video[i].data.width, video[i].data.height], [s.codec_name, s.width, s.height], `${wo} Video ${i}`);
  });
}

for (const [datei, format, dauerBekannt] of ECHT) {
  const pfad = join(SAMPLES, datei);
  const da = existsSync(pfad);
  test(`ECHTE Datei ${datei}: ffprobe-Weg stimmt mit dem ffprobe-CLI ueberein`, { skip: !da ? 'Probe fehlt' : SKIP_FF }, async () => {
    const r = await inspectAsset(pfad, { registry: registry(MIT) });
    pruefeSchema(r, datei);
    assert.equal(r.format_specific.quelle, 'ffprobe', JSON.stringify(r.warnings));
    assert.equal(r.format, format);
    vergleicheMitRoh(r, rohProbe(pfad), datei + ' [ffprobe]', true);
  });
  test(`ECHTE Datei ${datei}: Header-Fallback stimmt mit dem ffprobe-CLI ueberein`, { skip: !da ? 'Probe fehlt' : SKIP_FF }, async () => {
    const r = await inspectAsset(pfad, { registry: registry(OHNE) });
    pruefeSchema(r, datei);
    assert.equal(r.format_specific.quelle, 'header_fallback');
    assert.equal(r.format, format);
    assert.equal(r.status, 'teilweise');
    vergleicheMitRoh(r, rohProbe(pfad), datei + ' [fallback]', dauerBekannt);
    for (const o of r.objects) if (o.source_range) assert.ok(o.source_range.offset + o.source_range.length <= r.size, datei);
  });
}

test('ECHTE Datei .ogv (Theora+Skeleton): asset_type video unter dem Audio-Inspektor, beide Wege', { skip: !existsSync(join(SAMPLES, 'ogv/Night_phase.ogv')) ? 'Probe fehlt' : false }, async () => {
  const pfad = join(SAMPLES, 'ogv/Night_phase.ogv');
  for (const ffp of [OHNE, ...(HAT_FFPROBE ? [MIT] : [])]) {
    const r = await inspectAsset(pfad, { registry: registry(ffp) });
    assert.equal(r.asset_type, 'video');
    assert.equal(r.objects.find(o => o.kind === 'video_stream').data.codec_name, 'theora');
  }
});

test('ECHTE Dateien ohne Endung: Erkennung rein ueber Magic (wav, flac, ogg, mp3, mp4, mkv, avi)', async t => {
  const reg = registry(OHNE);
  let geprueft = 0;
  for (const [datei, format] of ECHT) {
    const pfad = join(SAMPLES, datei);
    if (!existsSync(pfad)) continue;
    const head = readFileSync(pfad).subarray(0, 4096);
    const d = detectAsset('/tmp/ohne-endung', head, reg);
    assert.ok(d.inspector, datei);
    assert.equal(d.format, format, datei);
    geprueft++;
  }
  if (geprueft === 0) t.skip('Proben fehlen');
});
