/**
 * Fixture-Generator fuer die Medien-Inspektoren (P4-T65).
 * Erzeugt Dateien in einem Verzeichnis unter os.tmpdir() — es werden KEINE Binaerdateien eingecheckt.
 *  - 'hand-*': von Hand nach Spezifikation gebaut, DETERMINISTISCH (gleiche Bytes bei jedem Lauf).
 *  - 'ff-*': mit ffmpeg erzeugt (nur wenn ffmpeg und der jeweilige Encoder vorhanden sind), mit
 *    +bitexact, damit die Bytes stabil sind. Das sind ECHTE, von einem Fremdwerkzeug erzeugte Dateien.
 *  - Sonderfaelle: abgeschnittene, falsch benannte, absurde Dateien und schwierige Dateinamen.
 * AUFRUF: node packages/core/scripts/asset-fixtures-medien.mjs   (gibt das Verzeichnis aus)
 * ALS MODUL: const { dir, pfade, ffmpeg, aufraeumen } = await erzeugeMedienFixtures();
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ascii = s => Buffer.from(s, 'latin1');
const u8 = n => Buffer.from([n & 0xff]);
const u16le = n => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u16be = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32le = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u32be = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const i32le = n => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const f64be = x => { const b = Buffer.alloc(8); b.writeDoubleBE(x); return b; };
const cat = (...teile) => Buffer.concat(teile.flat());

function fuell(n, start = 1) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (start + i * 7) & 0xff;
  return b;
}

// ------------------------------------------------------------------ RIFF (WAV, AVI)
const riffChunk = (id, daten) => cat(ascii(id), u32le(daten.length), daten, daten.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0));
const riffList = (typ, ...kinder) => riffChunk('LIST', cat(ascii(typ), ...kinder));
const cstr = s => cat(Buffer.from(s, 'utf8'), Buffer.alloc(1));
const riffDatei = (formtyp, ...teile) => {
  const body = cat(ascii(formtyp), ...teile);
  return cat(ascii('RIFF'), u32le(body.length), body);
};

export function bauWav({ kanaele = 1, rate = 8000, bits = 16, sekunden = 2, info = true, behauptet } = {}) {
  const byterate = rate * kanaele * (bits / 8);
  const fmt = cat(u16le(1), u16le(kanaele), u32le(rate), u32le(byterate), u16le(kanaele * (bits / 8)), u16le(bits));
  const daten = fuell(byterate * sekunden);
  const dataChunk = behauptet === undefined ? riffChunk('data', daten) : cat(ascii('data'), u32le(behauptet), daten);
  return riffDatei(
    'WAVE',
    riffChunk('fmt ', fmt),
    info ? riffList('INFO', riffChunk('INAM', cstr('Handton')), riffChunk('IART', cstr('Tester'))) : Buffer.alloc(0),
    dataChunk
  );
}

export function bauAvi() {
  const avih = cat(u32le(40000), u32le(0), u32le(0), u32le(0x10), u32le(50), u32le(0), u32le(2), u32le(0), u32le(64), u32le(48), Buffer.alloc(16));
  const strhVid = cat(ascii('vids'), ascii('XVID'), u32le(0), u16le(0), u16le(0), u32le(0), u32le(1), u32le(25), u32le(0), u32le(50), u32le(0), u32le(0), u32le(0), Buffer.alloc(8));
  const strfVid = cat(u32le(40), i32le(64), i32le(48), u16le(1), u16le(24), ascii('XVID'), u32le(64 * 48 * 3), Buffer.alloc(16));
  const strhAud = cat(ascii('auds'), u32le(0), u32le(0), u16le(0), u16le(0), u32le(0), u32le(1), u32le(44100), u32le(0), u32le(88200), u32le(0), u32le(0), u32le(4), Buffer.alloc(8));
  const strfAud = cat(u16le(1), u16le(2), u32le(44100), u32le(176400), u16le(4), u16le(16), u16le(0));
  return riffDatei(
    'AVI ',
    riffList(
      'hdrl',
      riffChunk('avih', avih),
      riffList('strl', riffChunk('strh', strhVid), riffChunk('strf', strfVid), riffChunk('strn', cstr('Bild'))),
      riffList('strl', riffChunk('strh', strhAud), riffChunk('strf', strfAud))
    ),
    riffList('INFO', riffChunk('INAM', cstr('Handfilm'))),
    riffList('movi'),
    riffChunk('idx1', Buffer.alloc(0))
  );
}

// ------------------------------------------------------------------ FLAC / OGG
const vorbisKommentar = (vendor, paare) =>
  cat(u32le(Buffer.byteLength(vendor)), Buffer.from(vendor), u32le(paare.length), ...paare.map(p => cat(u32le(Buffer.byteLength(p)), Buffer.from(p))));

export function bauFlac({ rate = 44100, kanaele = 2, bits = 16, samples = 88200, kommentar } = {}) {
  const gepackt = (BigInt(rate) << 44n) | (BigInt(kanaele - 1) << 41n) | (BigInt(bits - 1) << 36n) | BigInt(samples);
  const packed = Buffer.alloc(8);
  packed.writeBigUInt64BE(gepackt);
  const info = cat(u16be(4096), u16be(4096), Buffer.alloc(6), packed, Buffer.alloc(16));
  const vc = kommentar ?? vorbisKommentar('Handschrift 1.0', ['TITLE=Handklang', 'ARTIST=Tester']);
  const blockKopf = (typ, letzter, len) => cat(u8((letzter ? 0x80 : 0) | typ), Buffer.from([(len >> 16) & 255, (len >> 8) & 255, len & 255]));
  return cat(ascii('fLaC'), blockKopf(0, false, info.length), info, blockKopf(4, true, vc.length), vc);
}

// Ogg-CRC: Polynom 0x04c11db7, Startwert 0, keine Spiegelung — damit sind die Handdateien auch fuer ffprobe gueltig.
const OGG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function oggCrc(buf) {
  let c = 0;
  for (const b of buf) c = ((c << 8) ^ OGG_CRC[((c >>> 24) ^ b) & 0xff]) >>> 0;
  return c;
}

function oggSeite({ htype, granule, seq, paket, serial = 0x4242 }) {
  const n = Math.floor(paket.length / 255);
  const tabelle = cat(Buffer.alloc(n, 255), u8(paket.length % 255));
  const g = Buffer.alloc(8);
  g.writeBigInt64LE(BigInt(granule));
  const seite = cat(ascii('OggS'), u8(0), u8(htype), g, u32le(serial), u32le(seq), u32le(0), u8(tabelle.length), tabelle, paket);
  seite.writeUInt32LE(oggCrc(seite), 22);
  return seite;
}

export function bauOggVorbis({ granuleEnde = 44100 } = {}) {
  const ident = cat(u8(1), ascii('vorbis'), u32le(0), u8(2), u32le(44100), i32le(0), i32le(128000), i32le(0), u8(0xb8), u8(1));
  const komm = cat(u8(3), ascii('vorbis'), vorbisKommentar('Handschrift 1.0', ['TITLE=Handvogel', 'ARTIST=Tester']), u8(1));
  return cat(
    oggSeite({ htype: 2, granule: 0, seq: 0, paket: ident }),
    oggSeite({ htype: 0, granule: 0, seq: 1, paket: komm }),
    oggSeite({ htype: 4, granule: granuleEnde, seq: 2, paket: fuell(10) })
  );
}

export function bauOggOpus() {
  const kopf = cat(ascii('OpusHead'), u8(1), u8(2), u16le(312), u32le(44100), u16le(0), u8(0));
  const tags = cat(ascii('OpusTags'), vorbisKommentar('Handschrift 1.0', ['TITLE=Handopus']));
  return cat(
    oggSeite({ htype: 2, granule: 0, seq: 0, paket: kopf }),
    oggSeite({ htype: 0, granule: 0, seq: 1, paket: tags }),
    oggSeite({ htype: 4, granule: 48312, seq: 2, paket: fuell(10) })
  );
}

// ------------------------------------------------------------------ MP3
const synchsafe = n => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const id3Frame = (id, daten) => cat(ascii(id), u32be(daten.length), u16be(0), daten);
const id3Text = (id, text) => id3Frame(id, cat(u8(0), ascii(text)));

/** Ein MPEG-1 Layer-III-Frame, 128 kbit/s, 44,1 kHz, Stereo: 417 Bytes. */
const mp3Frame = () => {
  const f = Buffer.alloc(417);
  f.set([0xff, 0xfb, 0x90, 0x00], 0);
  return f;
};

export function bauMp3({ frames = 20, id3v2 = true, id3v1 = false, xing = false, cover = false, id3Groesse } = {}) {
  const teile = [];
  if (id3v2) {
    const fr = cat(
      id3Text('TIT2', 'Handlied'),
      id3Text('TPE1', 'Tester'),
      id3Text('TALB', 'Handalbum'),
      cover ? id3Frame('APIC', cat(u8(0), cstr('image/png'), u8(3), u8(0), fuell(20))) : Buffer.alloc(0)
    );
    teile.push(ascii('ID3'), Buffer.from([3, 0, 0]), synchsafe(id3Groesse ?? fr.length), fr);
  }
  for (let i = 0; i < frames; i++) {
    const f = mp3Frame();
    if (xing && i === 0) {
      f.write('Xing', 36, 'latin1');
      f.writeUInt32BE(3, 40);
      f.writeUInt32BE(100, 44);
      f.writeUInt32BE(41700, 48);
      f.write('LAME3.100', 156, 'latin1');
    }
    teile.push(f);
  }
  if (id3v1) {
    const v1 = Buffer.alloc(128);
    v1.write('TAG', 0, 'latin1');
    v1.write('Altlied', 3, 'latin1');
    v1.write('Altkuenstler', 33, 'latin1');
    teile.push(v1);
  }
  return cat(...teile);
}

// ------------------------------------------------------------------ MP4
const box = (typ, ...inhalt) => {
  const body = cat(...inhalt);
  return cat(u32be(8 + body.length), ascii(typ), body);
};
const fullbox = (typ, ver, ...inhalt) => box(typ, u8(ver), Buffer.alloc(3), ...inhalt);
const MATRIX = cat(u32be(0x10000), u32be(0), u32be(0), u32be(0), u32be(0x10000), u32be(0), u32be(0), u32be(0), u32be(0x40000000));

function trak({ id, typ, ts, dauer, breite = 0, hoehe = 0, eintrag, stts }) {
  const tkhd = fullbox('tkhd', 0, u32be(0), u32be(0), u32be(id), u32be(0), u32be(dauer), Buffer.alloc(8), u16be(0), u16be(0), u16be(0), u16be(0), MATRIX, u32be(breite * 65536), u32be(hoehe * 65536));
  const mdhd = fullbox('mdhd', 0, u32be(0), u32be(0), u32be(ts), u32be(dauer), u16be(((5 << 10) | (14 << 5) | 7) & 0xffff), u16be(0)); // 'eng'
  const hdlr = fullbox('hdlr', 0, u32be(0), ascii(typ), Buffer.alloc(12), cstr('Handler'));
  const stsd = fullbox('stsd', 0, u32be(1), eintrag);
  const stbl = box('stbl', stsd, ...(stts ? [fullbox('stts', 0, u32be(1), u32be(stts), u32be(1))] : []));
  return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', stbl)));
}

export function bauMp4({ moovGroesse } = {}) {
  const videoEintrag = box('avc1', Buffer.alloc(6), u16be(1), u16be(0), u16be(0), Buffer.alloc(12), u16be(64), u16be(48), u32be(0x480000), u32be(0x480000), u32be(0), u16be(1), Buffer.alloc(32), u16be(24), u16be(0xffff));
  const audioEintrag = box('mp4a', Buffer.alloc(6), u16be(1), u16be(0), u16be(0), u32be(0), u16be(2), u16be(16), u16be(0), u16be(0), u32be(44100 * 65536));
  const moov = box(
    'moov',
    fullbox('mvhd', 0, u32be(0), u32be(0), u32be(1000), u32be(2000), u32be(0x10000), u16be(0x100), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32be(3)),
    trak({ id: 1, typ: 'vide', ts: 10, dauer: 20, breite: 64, hoehe: 48, eintrag: videoEintrag, stts: 20 }),
    trak({ id: 2, typ: 'soun', ts: 44100, dauer: 88200, eintrag: audioEintrag })
  );
  const ftyp = box('ftyp', ascii('isom'), u32be(512), ascii('isom'), ascii('mp42'));
  const mdat = box('mdat', fuell(64));
  if (moovGroesse !== undefined) moov.writeUInt32BE(moovGroesse, 0);
  return cat(ftyp, moov, mdat);
}

// ------------------------------------------------------------------ MKV
const uintBytes = n => {
  const b = [];
  let v = n;
  do { b.unshift(v % 256); v = Math.floor(v / 256); } while (v > 0);
  return Buffer.from(b);
};
const size4 = n => Buffer.from([0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const el = (id, ...inhalt) => {
  const body = cat(...inhalt);
  return cat(Buffer.from(id), size4(body.length), body);
};

function mkvTrack({ nr, typ, codec, name, sprache, defaultDauer, breite, hoehe, rate, kanaele }) {
  return el(
    [0xae],
    el([0xd7], uintBytes(nr)),
    el([0x73, 0xc5], uintBytes(nr)),
    el([0x83], uintBytes(typ)),
    el([0x86], ascii(codec)),
    name ? el([0x53, 0x6e], Buffer.from(name)) : Buffer.alloc(0),
    sprache ? el([0x22, 0xb5, 0x9c], ascii(sprache)) : Buffer.alloc(0),
    defaultDauer ? el([0x23, 0xe3, 0x83], uintBytes(defaultDauer)) : Buffer.alloc(0),
    breite ? el([0xe0], el([0xb0], uintBytes(breite)), el([0xba], uintBytes(hoehe))) : Buffer.alloc(0),
    rate ? el([0xe1], el([0xb5], f64be(rate)), el([0x9f], uintBytes(kanaele))) : Buffer.alloc(0)
  );
}

export function bauMkv({ extraTracks = 0, infoGroesse } = {}) {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii('matroska')), el([0x42, 0x87], uintBytes(4)));
  let info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], uintBytes(1000000)), el([0x44, 0x89], f64be(2000)), el([0x7b, 0xa9], Buffer.from('Handfilm')), el([0x4d, 0x80], ascii('handbau')));
  if (infoGroesse !== undefined) info = cat(info.subarray(0, 4), Buffer.from([0x1f, 0xff, 0xff, 0xfe]), info.subarray(8));
  const tracks = [
    mkvTrack({ nr: 1, typ: 1, codec: 'V_VP9', name: 'Bild', defaultDauer: 41666667, breite: 320, hoehe: 240 }),
    mkvTrack({ nr: 2, typ: 2, codec: 'A_OPUS', sprache: 'ger', rate: 48000, kanaele: 2 }),
    mkvTrack({ nr: 3, typ: 17, codec: 'S_TEXT/UTF8', sprache: 'eng' }),
  ];
  for (let i = 0; i < extraTracks; i++) tracks.push(mkvTrack({ nr: 10 + i, typ: 2, codec: 'A_AAC', rate: 44100, kanaele: 1 }));
  const segment = el([0x18, 0x53, 0x80, 0x67], info, el([0x16, 0x54, 0xae, 0x6b], ...tracks), el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], uintBytes(0))));
  return cat(ebml, segment);
}

// ------------------------------------------------------------------ ffmpeg
function ffmpegVorhanden() {
  try {
    const out = execFileSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 });
    const hat = n => new RegExp(`\\s${n}\\s`).test(out);
    return { ok: true, vorbis: hat('libvorbis'), mp3: hat('libmp3lame'), flac: hat('flac'), aac: hat('aac'), mpeg4: hat('mpeg4') };
  } catch {
    return { ok: false };
  }
}

function ff(args) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-flags:v', '+bitexact', ...args], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
}

async function erzeugeFfmpegDateien(dir, pfade, f) {
  const sinus = d => ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${d}:sample_rate=44100`];
  const meta = ['-metadata', 'title=Sinus', '-metadata', 'artist=Tester'];
  const versuch = (schluessel, name, args) => {
    const p = join(dir, name);
    try { ff([...args, p]); pfade[schluessel] = p; } catch { /* Encoder fehlt: Fixture entfaellt, Tests ueberspringen */ }
  };
  versuch('ffWav', 'ff-sinus.wav', [...sinus(1), '-ac', '1', '-c:a', 'pcm_s16le', ...meta]);
  if (f.flac) versuch('ffFlac', 'ff-sinus.flac', [...sinus(1), '-c:a', 'flac', ...meta]);
  if (f.vorbis) versuch('ffOgg', 'ff-sinus.ogg', [...sinus(1), '-c:a', 'libvorbis', ...meta]);
  if (f.mp3) versuch('ffMp3', 'ff-sinus.mp3', [...sinus(1), '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '3', ...meta]);
  if (f.mpeg4 && f.aac) {
    const metaDatei = join(dir, 'kapitel.ffmeta');
    await writeFile(
      metaDatei,
      ';FFMETADATA1\ntitle=Testfilm\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Eins\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=Zwei\n'
    );
    const srt = join(dir, 'sub.srt');
    await writeFile(srt, '1\n00:00:00,000 --> 00:00:01,000\nHallo\n\n2\n00:00:01,000 --> 00:00:02,000\nWelt\n');
    const bild = ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=2'];
    const ton = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2:sample_rate=44100'];
    // Alle Eingaben (-i) muessen VOR den Ausgabeoptionen stehen.
    const eingaben = [...bild, ...ton, '-i', metaDatei, '-i', srt];
    const ausgabe = ['-map_metadata', '2', '-map_chapters', '2', '-map', '0:v', '-map', '1:a'];
    versuch('ffMp4', 'ff-film.mp4', [...eingaben, ...ausgabe, '-c:v', 'mpeg4', '-c:a', 'aac', '-metadata:s:a:0', 'language=deu']);
    versuch('ffMkv', 'ff-film.mkv', [...eingaben, ...ausgabe, '-map', '3:s', '-c:v', 'mpeg4', '-c:a', 'aac', '-c:s', 'srt', '-metadata:s:a:0', 'language=deu']);
    versuch('ffAvi', 'ff-film.avi', [...bild, ...ton, '-map', '0:v', '-map', '1:a', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-metadata', 'title=Testfilm']);
  }
}

/**
 * @param {string} [ziel] Zielverzeichnis; fehlt es, wird ein neues unter os.tmpdir() angelegt.
 * @param {{ffmpeg?: boolean}} [opts] ffmpeg:false erzeugt nur die Handdateien.
 * @returns {Promise<{dir:string, pfade:Record<string,string>, ffmpeg:boolean, aufraeumen:()=>Promise<void>}>}
 */
export async function erzeugeMedienFixtures(ziel, opts = {}) {
  const dir = ziel ?? (await mkdtemp(join(tmpdir(), 'synapse-medien-fixtures-')));
  await mkdir(dir, { recursive: true });
  const wav = bauWav();
  const png = cat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), fuell(64, 9));
  const hand = {
    handWav: ['hand.wav', wav],
    handWavOhneInfo: ['hand-ohne-info.wav', bauWav({ info: false })],
    handFlac: ['hand.flac', bauFlac()],
    handOgg: ['hand.ogg', bauOggVorbis()],
    handOpus: ['hand-opus.ogg', bauOggOpus()],
    handMp3: ['hand.mp3', bauMp3()],
    handMp3V1: ['hand-v1.mp3', bauMp3({ id3v2: false, id3v1: true })],
    handMp3Xing: ['hand-xing.mp3', bauMp3({ frames: 5, xing: true })],
    handMp3Cover: ['hand-cover.mp3', bauMp3({ cover: true })],
    handMp4: ['hand.mp4', bauMp4()],
    handMkv: ['hand.mkv', bauMkv()],
    handMkvVieleTracks: ['hand-viele-tracks.mkv', bauMkv({ extraTracks: 50 })],
    handAvi: ['hand.avi', bauAvi()],
    // --- kaputt / abgeschnitten
    wavAbgeschnitten: ['abgeschnitten.wav', wav.subarray(0, 10000)],
    wavKopfNur: ['kopf-nur.wav', wav.subarray(0, 20)],
    flacAbgeschnitten: ['abgeschnitten.flac', bauFlac().subarray(0, 30)],
    oggAbgeschnitten: ['abgeschnitten.ogg', bauOggVorbis().subarray(0, 60)],
    mp3Abgeschnitten: ['abgeschnitten.mp3', bauMp3().subarray(0, 300)],
    mp4Abgeschnitten: ['abgeschnitten.mp4', bauMp4().subarray(0, 120)],
    mkvAbgeschnitten: ['abgeschnitten.mkv', bauMkv().subarray(0, 40)],
    aviAbgeschnitten: ['abgeschnitten.avi', bauAvi().subarray(0, 90)],
    // --- falsche Magic / Endung passt nicht zum Inhalt
    pngAlsWav: ['png-als.wav', png],
    muellMp3: ['muell.mp3', fuell(2000, 3)],
    wavAlsMp3: ['wav-als.mp3', wav],
    // --- absurde Werte
    wavAbsurd: ['absurd.wav', bauWav({ kanaele: 0, rate: 0, bits: 0 })],
    wavDataRiesig: ['data-riesig.wav', bauWav({ behauptet: 0xfffffff0 })],
    flacKommentarRiesig: [
      'kommentar-riesig.flac',
      bauFlac({ kommentar: cat(u32le(0x7fffffff), ascii('x'), u32le(0xffffffff)) }),
    ],
    mp3Id3Riesig: ['id3-riesig.mp3', bauMp3({ id3Groesse: 0x0fffffff })],
    mp4MoovRiesig: ['moov-riesig.mp4', bauMp4({ moovGroesse: 0x7fffffff })],
    mkvInfoRiesig: ['info-riesig.mkv', bauMkv({ infoGroesse: 1 })],
    // --- Sicherheit: Textdatei mit ffconcat-Inhalt unter Medienendung
    ffconcatMp4: ['ffconcat.mp4', ascii('ffconcat version 1.0\nfile http://127.0.0.1:1/x.mp4\nfile /etc/passwd\n')],
    leer: ['leer.wav', Buffer.alloc(0)],
  };
  const pfade = {};
  for (const [schluessel, [name, inhalt]] of Object.entries(hand)) {
    const p = join(dir, name);
    await writeFile(p, inhalt);
    pfade[schluessel] = p;
  }
  // Schwierige Dateinamen (Leerzeichen, Umlaute, fuehrendes '-', Doppelpunkt, Komma/Klammern/Hochkomma).
  const sonder = join(dir, 'sonder ordner äöü');
  await mkdir(sonder, { recursive: true });
  const namen = {
    sonderLeerzeichenUmlaut: 'mit Leerzeichen ÄÖÜ ß.wav',
    sonderFuehrendBindestrich: '-fuehrend.wav',
    sonderDoppelpunkt: 'x:y.wav',
    sonderProtokoll: 'http:evil.wav',
    sonderZeichen: "a,b;c(1)'d=e%20.wav",
  };
  for (const [schluessel, name] of Object.entries(namen)) {
    const p = join(sonder, name);
    await writeFile(p, wav);
    pfade[schluessel] = p;
  }
  const f = opts.ffmpeg === false ? { ok: false } : ffmpegVorhanden();
  if (f.ok) await erzeugeFfmpegDateien(dir, pfade, f);
  return { dir, pfade, ffmpeg: Boolean(f.ok), aufraeumen: () => rm(dir, { recursive: true, force: true }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, pfade, ffmpeg } = await erzeugeMedienFixtures();
  console.log(dir, ffmpeg ? '(mit ffmpeg)' : '(ohne ffmpeg)');
  for (const [k, p] of Object.entries(pfade)) console.log(`  ${k}: ${p}`);
}
