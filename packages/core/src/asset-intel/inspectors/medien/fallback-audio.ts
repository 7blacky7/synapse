/**
 * MODUL: Medien-Inspektoren — Header-Fallback fuer FLAC, OGG und MP3
 * ZWECK: Liest ohne ffprobe nur Header: FLAC-Metadatenbloecke, erste/zweite OGG-Seite plus die letzte
 *        Seite fuer die Dauer, MP3-ID3-Tags und den ersten Frame (mit Xing/Info/VBRI).
 */

import { BinaryReader, leseReader } from '../../binary-reader.js';
import { AssetReadError } from '../../errors.js';
import type { AssetContext, AssetSource } from '../../types.js';
import { MedienFormatFehler, ascii4, kappeText, leererBefund, rund, setzeTag } from './gemeinsam.js';
import type { MedienBefund, StreamBefund } from './gemeinsam.js';

const MAX_FLAC_BLOECKE = 128;
const MAX_KOMMENTARE = 1000;
const MAX_KOMMENTAR_BYTES = 1024 * 1024;
/** Groesste moegliche Ogg-Seite: 27 Header + 255 Segmenttabelle + 255*255 Daten. */
const OGG_SEITE_MAX = 27 + 255 + 255 * 255;

/**
 * Liest einen Vorbis-Kommentar-Block (FLAC, Vorbis, Opus) ab start in tags.
 * @returns vendor und ob der Block vollstaendig lesbar war.
 */
export function leseVorbisKommentar(buf: Buffer, start: number, tags: Record<string, string>): { vendor: string | null; vollstaendig: boolean } {
  let vendor: string | null = null;
  try {
    const r = new BinaryReader(buf);
    r.seek(start);
    const vlen = r.u32le();
    vendor = kappeText(Buffer.from(r.bytes(vlen)).toString('utf8'), 256) || null;
    if (vendor && !('encoder' in tags)) setzeTag(tags, 'encoder', vendor);
    const anzahl = r.u32le();
    for (let i = 0; i < Math.min(anzahl, MAX_KOMMENTARE); i++) {
      const len = r.u32le();
      const s = Buffer.from(r.bytes(len)).toString('utf8');
      const eq = s.indexOf('=');
      if (eq <= 0) continue;
      const key = s.slice(0, eq).toLowerCase();
      if (key === 'metadata_block_picture' || key in tags) continue;
      setzeTag(tags, key, s.slice(eq + 1));
    }
    return { vendor, vollstaendig: anzahl <= MAX_KOMMENTARE };
  } catch (e) {
    if (e instanceof AssetReadError) return { vendor, vollstaendig: false };
    throw e;
  }
}

// ---------------------------------------------------------------- FLAC

export async function flacFallback(src: AssetSource, ctx: AssetContext): Promise<MedienBefund> {
  const sig = await leseReader(src, 0, 4);
  if (ascii4(sig.bytes(4), 0) !== 'fLaC') throw new MedienFormatFehler('signatur_ungueltig', 'Kein fLaC-Kopf.');
  const b = leererBefund('flac');
  let pos = 4;
  let info: StreamBefund | null = null;
  let letzter = false;
  let nr = 0;
  while (!letzter && nr < MAX_FLAC_BLOECKE) {
    ctx.pruefeAbbruch();
    const h = await src.readRange(pos, 4);
    if (h.length < 4) {
      b.warnings.push({ code: 'datei_abgeschnitten', message: `Metadatenblock-Header bei Offset ${pos} fehlt (Datei endet).` });
      break;
    }
    letzter = (h[0] & 0x80) !== 0;
    const typ = h[0] & 0x7f;
    const len = h.readUIntBE(1, 3);
    if (pos + 4 + len > src.size) {
      b.warnings.push({ code: 'datei_abgeschnitten', message: `Metadatenblock Typ ${typ} (${len} Bytes) ragt ueber das Dateiende.` });
      break;
    }
    if (typ === 0 && len >= 34 && !info) {
      const d = await src.readRange(pos + 4, 34);
      const rate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
      const kanaele = ((d[12] >> 1) & 7) + 1;
      const bits = (((d[12] & 1) << 4) | (d[13] >> 4)) + 1;
      const samples = (d[13] & 0x0f) * 2 ** 32 + d.readUInt32BE(14);
      const dauer = rate > 0 && samples > 0 ? rund(samples / rate) : null;
      info = {
        kind: 'audio_stream',
        name: null,
        data: { index: 0, codec_name: 'flac', sample_rate: rate, channels: kanaele, bits_per_sample: bits, total_samples: samples, duration_s: dauer },
        source_range: { offset: pos, length: 4 + len },
      };
      b.duration_s = dauer;
      if (rate === 0) b.warnings.push({ code: 'werte_unplausibel', message: 'STREAMINFO meldet Samplerate 0.' });
    } else if (typ === 4) {
      const d = await src.readRange(pos + 4, Math.min(len, MAX_KOMMENTAR_BYTES));
      const r = leseVorbisKommentar(d, 0, b.tags);
      if (!r.vollstaendig) b.warnings.push({ code: 'tags_unvollstaendig', message: 'VORBIS_COMMENT nur teilweise lesbar (Laengenangaben ueber den Block oder zu viele Eintraege).' });
    } else if (typ === 6) {
      b.streams.push({
        kind: 'attachment',
        name: 'cover',
        data: { typ: 'flac_picture', groesse_bytes: len },
        source_range: { offset: pos, length: 4 + len },
      });
    }
    pos += 4 + len;
    nr++;
  }
  if (!info) b.warnings.push({ code: 'streaminfo_fehlt', message: 'Kein STREAMINFO-Block gefunden; Audioformat unbekannt.' });
  else b.streams.unshift(info);
  b.bit_rate = b.duration_s && b.duration_s > 0 ? Math.round((src.size * 8) / b.duration_s) : null;
  b.format_specific = { bit_rate_geschaetzt: b.bit_rate !== null, metadatenbloecke: nr, audio_beginn: pos };
  return b;
}

// ---------------------------------------------------------------- OGG

const MAX_OGG_STREAMS = 16;

interface OggSeite {
  granule: bigint;
  htype: number;
  serial: number;
  daten: Buffer;
  /** Gesamtlaenge Header + Daten laut Segmenttabelle. */
  laenge: number;
  vollstaendig: boolean;
}

function parseOggSeite(buf: Buffer, off: number): OggSeite | null {
  if (off + 27 > buf.length || ascii4(buf, off) !== 'OggS' || buf[off + 4] !== 0) return null;
  const nseg = buf[off + 26];
  if (off + 27 + nseg > buf.length) return null;
  let daten = 0;
  for (let i = 0; i < nseg; i++) daten += buf[off + 27 + i];
  const start = off + 27 + nseg;
  const ende = Math.min(start + daten, buf.length);
  return {
    granule: buf.readBigInt64LE(off + 6),
    htype: buf[off + 5],
    serial: buf.readUInt32LE(off + 14),
    daten: buf.subarray(start, ende),
    laenge: 27 + nseg + daten,
    vollstaendig: start + daten <= buf.length,
  };
}

interface OggStream {
  befund: StreamBefund;
  serial: number;
  codec: string;
  rate: number;
  vorspann: number;
  kfgshift: number;
  frn: number;
  frd: number;
  /** Beginn des Kommentarblocks im zweiten Paket (-1: kein Kommentarblock lesbar). */
  kommentarStart: number;
}

/** Erkennt den Codec am ersten Paket einer BOS-Seite. 'skeleton': Ogg-Skeleton (kein eigener Stream). */
function erkenneOggStream(d: Buffer, serial: number, index: number, range: { offset: number; length: number }): OggStream | 'skeleton' | null {
  const roh = { serial, vorspann: 0, kfgshift: 0, frn: 0, frd: 0, kommentarStart: -1, rate: 0 };
  if (d.length >= 30 && d[0] === 1 && d.toString('latin1', 1, 7) === 'vorbis') {
    const rate = d.readUInt32LE(12);
    const nominal = d.readInt32LE(20);
    return {
      ...roh, codec: 'vorbis', rate, kommentarStart: 7,
      befund: { kind: 'audio_stream', name: null, source_range: range, data: { index, codec_name: 'vorbis', sample_rate: rate, channels: d[11], bit_rate: nominal > 0 ? nominal : null } },
    };
  }
  if (d.length >= 19 && d.toString('latin1', 0, 8) === 'OpusHead') {
    const vorspann = d.readUInt16LE(10);
    return {
      ...roh, codec: 'opus', rate: 48000, vorspann, kommentarStart: 8,
      befund: { kind: 'audio_stream', name: null, source_range: range, data: { index, codec_name: 'opus', sample_rate: 48000, input_sample_rate: d.readUInt32LE(12), channels: d[9], pre_skip: vorspann } },
    };
  }
  if (d.length >= 51 && d[0] === 0x7f && d.toString('latin1', 1, 5) === 'FLAC') {
    const rate = (d[27] << 12) | (d[28] << 4) | (d[29] >> 4);
    const bits = (((d[29] & 1) << 4) | (d[30] >> 4)) + 1;
    return {
      ...roh, codec: 'flac', rate,
      befund: { kind: 'audio_stream', name: null, source_range: range, data: { index, codec_name: 'flac', sample_rate: rate, channels: ((d[29] >> 1) & 7) + 1, bits_per_sample: bits } },
    };
  }
  if (d.length >= 42 && d[0] === 0x80 && d.toString('latin1', 1, 7) === 'theora') {
    const frn = d.readUInt32BE(22);
    const frd = d.readUInt32BE(26);
    return {
      ...roh, codec: 'theora', frn, frd, kfgshift: (d.readUInt16BE(40) >> 5) & 0x1f,
      befund: {
        kind: 'video_stream', name: null, source_range: range,
        data: { index, codec_name: 'theora', width: d.readUIntBE(14, 3), height: d.readUIntBE(17, 3), avg_frame_rate: frn > 0 && frd > 0 ? rund(frn / frd, 3) : null },
      },
    };
  }
  if (d.length >= 52 && d.toString('latin1', 0, 8) === 'Speex   ') {
    const rate = d.readUInt32LE(36);
    return {
      ...roh, codec: 'speex', rate,
      befund: { kind: 'audio_stream', name: null, source_range: range, data: { index, codec_name: 'speex', sample_rate: rate, channels: d.readUInt32LE(48) } },
    };
  }
  if (d.length >= 8 && d.toString('latin1', 0, 8) === 'fishead\u0000') return 'skeleton';
  return null;
}

export async function oggFallback(src: AssetSource, ctx: AssetContext): Promise<MedienBefund> {
  const kopfBuf = await src.readRange(0, Math.min(src.size, 2 * OGG_SEITE_MAX));
  const b = leererBefund('ogg');
  const streams: OggStream[] = [];

  // BOS-Seiten: je logischer Stream eine (Theora+Vorbis, Skeleton, ...).
  let pos = 0;
  let bosSeiten = 0;
  while (bosSeiten < MAX_OGG_STREAMS) {
    const p = parseOggSeite(kopfBuf, pos);
    if (!p || !(p.htype & 2)) break;
    if (!p.vollstaendig) b.warnings.push({ code: 'datei_abgeschnitten', message: `Ogg-Seite bei Offset ${pos} ragt ueber das Dateiende.` });
    const s = erkenneOggStream(p.daten, p.serial, streams.length, { offset: pos, length: p.laenge });
    if (s && s !== 'skeleton') streams.push(s);
    pos += p.laenge;
    bosSeiten++;
  }
  if (bosSeiten === 0) throw new MedienFormatFehler('signatur_ungueltig', 'Keine gueltige erste Ogg-Seite (OggS mit BOS-Flag).');
  if (streams.length === 0) {
    b.warnings.push({ code: 'codec_unbekannt', message: 'Keine bekannte Codec-Kennung auf den Anfangsseiten (Vorbis, Opus, FLAC, Theora, Speex).' });
    b.format_specific = { codec: null };
    return b;
  }
  ctx.pruefeAbbruch();

  // Tags: zweites Paket des ersten Vorbis/Opus-Streams, soweit es auf einer der naechsten Seiten liegt.
  const tagStream = streams.find(s => s.kommentarStart >= 0);
  if (tagStream) {
    const sig = tagStream.codec === 'vorbis' ? '\u0003vorbis' : 'OpusTags';
    let q = pos;
    for (let i = 0; i < 8; i++) {
      const pg = parseOggSeite(kopfBuf, q);
      if (!pg) break;
      if (pg.serial === tagStream.serial && pg.daten.toString('latin1', 0, sig.length) === sig) {
        const r = leseVorbisKommentar(pg.daten, tagStream.kommentarStart, b.tags);
        if (!r.vollstaendig) b.warnings.push({ code: 'tags_unvollstaendig', message: 'Kommentarblock nur teilweise lesbar (ueber die erste Seite hinaus oder zu viele Eintraege).' });
        break;
      }
      q += pg.laenge;
    }
  }

  // Dauer: letzte Seite je logischem Stream (begrenzter Rueckwaerts-Scan, hoechstens zwei Seitenlaengen).
  const tailStart = Math.max(0, src.size - 2 * OGG_SEITE_MAX);
  const tail = await src.readRange(tailStart, src.size - tailStart);
  const letzteJeSerial = new Map<number, OggSeite>();
  let idx = tail.length;
  for (let versuch = 0; versuch < 64 && idx > 0 && letzteJeSerial.size < streams.length; versuch++) {
    idx = tail.lastIndexOf('OggS', idx - 1, 'latin1');
    if (idx < 0) break;
    const p = parseOggSeite(tail, idx);
    if (p && p.vollstaendig && !letzteJeSerial.has(p.serial)) letzteJeSerial.set(p.serial, p);
  }
  let gesamt: number | null = null;
  for (const s of streams) {
    const l = letzteJeSerial.get(s.serial);
    let dauer: number | null = null;
    if (l && l.granule > 0n) {
      if (s.codec === 'opus') dauer = Math.max(0, Number(l.granule) - s.vorspann) / 48000;
      else if (s.codec === 'theora') {
        if (s.frn > 0 && s.frd > 0) {
          const sh = BigInt(s.kfgshift);
          const bilder = Number((l.granule >> sh) + (l.granule & ((1n << sh) - 1n)));
          dauer = (bilder * s.frd) / s.frn;
        }
      } else if (s.rate > 0) dauer = Number(l.granule) / s.rate;
    }
    const d = rund(dauer);
    if (d !== null) {
      s.befund.data.duration_s = d;
      gesamt = Math.max(gesamt ?? 0, d);
    }
  }
  if (gesamt === null) {
    b.warnings.push(
      letzteJeSerial.size === 0
        ? { code: 'letzte_seite_fehlt', message: 'Keine vollstaendige letzte Ogg-Seite gefunden (Datei abgeschnitten?); Dauer unbekannt.' }
        : { code: 'dauer_unbekannt', message: 'Die letzten lesbaren Ogg-Seiten tragen keine verwertbare Granule-Position; Dauer unbekannt.' }
    );
  }
  b.duration_s = gesamt;
  b.bit_rate = gesamt && gesamt > 0 ? Math.round((src.size * 8) / gesamt) : null;
  for (const s of streams) b.streams.push(s.befund);
  b.format_specific = { codecs: streams.map(s => s.codec), logische_streams: streams.length, bit_rate_geschaetzt: b.bit_rate !== null };
  return b;
}


// ---------------------------------------------------------------- MP3

const BR_V1: Record<number, number[]> = {
  1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
};
const BR_V2_L1 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256];
const BR_V2_L23 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR: Record<string, number[]> = { '1': [44100, 48000, 32000], '2': [22050, 24000, 16000], '2.5': [11025, 12000, 8000] };
const MODI = ['stereo', 'joint_stereo', 'dual_channel', 'mono'];

interface Mp3Frame {
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  bitrate: number;
  samplerate: number;
  mono: boolean;
  modus: string;
  crc: boolean;
  samples: number;
  laenge: number;
}

function parseMp3Kopf(b: Buffer, o: number): Mp3Frame | null {
  if (o < 0 || o + 4 > b.length || b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (b[o + 1] >> 3) & 3;
  const layerBits = (b[o + 1] >> 1) & 3;
  const brIdx = (b[o + 2] >> 4) & 15;
  const srIdx = (b[o + 2] >> 2) & 3;
  if (verBits === 1 || layerBits === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const version = verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const br = (version === 1 ? BR_V1[layer] : layer === 1 ? BR_V2_L1 : BR_V2_L23)[brIdx];
  const sr = SR[String(version)][srIdx];
  const pad = (b[o + 2] >> 1) & 1;
  const modusBits = (b[o + 3] >> 6) & 3;
  const samples = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
  const laenge =
    layer === 1
      ? (Math.floor((12 * br * 1000) / sr) + pad) * 4
      : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * br * 1000) / sr) + pad;
  return { version, layer, bitrate: br * 1000, samplerate: sr, mono: modusBits === 3, modus: MODI[modusBits], crc: (b[o + 1] & 1) === 0, samples, laenge };
}

function synchsafe(b: Buffer, o: number): number {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}

/** ID3-Textframe (erstes Byte = Kodierung) in einen String. */
function id3Text(d: Buffer): string {
  if (d.length < 1) return '';
  const enc = d[0];
  let body = d.subarray(1);
  let s: string;
  if (enc === 1 || enc === 2) {
    let be = enc === 2;
    if (enc === 1 && body.length >= 2) {
      if (body[0] === 0xfe && body[1] === 0xff) { be = true; body = body.subarray(2); }
      else if (body[0] === 0xff && body[1] === 0xfe) { be = false; body = body.subarray(2); }
    }
    const gerade = Buffer.from(body.subarray(0, body.length & ~1));
    s = (be ? gerade.swap16() : gerade).toString('utf16le');
  } else {
    s = body.toString(enc === 3 ? 'utf8' : 'latin1');
  }
  return s.split('\u0000')[0];
}

const ID3_V3: Record<string, string> = {
  TIT2: 'title', TPE1: 'artist', TALB: 'album', TSSE: 'encoder', TENC: 'encoded_by', TDRC: 'date', TYER: 'date',
  TCON: 'genre', TRCK: 'track', TPE2: 'album_artist', TCOM: 'composer', TPOS: 'disc',
};
const ID3_V2: Record<string, string> = { TT2: 'title', TP1: 'artist', TAL: 'album', TSS: 'encoder', TYE: 'date', TCO: 'genre', TRK: 'track' };

function leseId3v2(buf: Buffer, major: number, flags: number, b: MedienBefund): void {
  let pos = 0;
  if (flags & 0x40 && buf.length >= 4) {
    // Erweiterter Header: Groesse ueberspringen.
    pos = major === 4 ? synchsafe(buf, 0) : buf.readUInt32BE(0) + 4;
  }
  const kopf = major === 2 ? 6 : 10;
  for (let n = 0; n < 4096 && pos + kopf <= buf.length; n++) {
    const id = buf.toString('latin1', pos, pos + (major === 2 ? 3 : 4));
    if (id.charCodeAt(0) === 0) break;
    const size = major === 2 ? buf.readUIntBE(pos + 3, 3) : major === 4 ? synchsafe(buf, pos + 4) : buf.readUInt32BE(pos + 4);
    const datenStart = pos + kopf;
    if (size <= 0 || datenStart + size > buf.length) break;
    const schluessel = (major === 2 ? ID3_V2 : ID3_V3)[id];
    if (schluessel) {
      if (!(schluessel in b.tags)) setzeTag(b.tags, schluessel, id3Text(buf.subarray(datenStart, datenStart + size)));
    } else if (id === 'APIC' || id === 'PIC') {
      b.streams.push({
        kind: 'attachment',
        name: 'cover',
        data: { typ: 'id3_apic', groesse_bytes: size },
        // +10: Offset des ID3-Hauptheaders, die Frames beginnen dahinter.
        source_range: { offset: 10 + pos, length: kopf + size },
      });
    }
    pos = datenStart + size;
  }
}

export async function mp3Fallback(src: AssetSource, ctx: AssetContext): Promise<MedienBefund> {
  const b = leererBefund('mp3');
  const kopf = await src.readRange(0, 10);
  let audioStart = 0;
  let id3Version: string | null = null;
  let id3Groesse = 0;
  if (kopf.length >= 10 && kopf.toString('latin1', 0, 3) === 'ID3') {
    const major = kopf[3];
    const tagGroesse = synchsafe(kopf, 6);
    id3Groesse = 10 + tagGroesse + (kopf[5] & 0x10 ? 10 : 0);
    audioStart = id3Groesse;
    id3Version = `2.${major}.${kopf[4]}`;
    if (audioStart > src.size) {
      b.warnings.push({ code: 'id3_ueberschreitet_datei', message: `ID3v2-Tag meldet ${id3Groesse} Bytes, die Datei hat nur ${src.size}.` });
    }
    if (major >= 2 && major <= 4) {
      const lesen = Math.min(tagGroesse, Math.max(0, src.size - 10), 256 * 1024);
      if (lesen < tagGroesse && audioStart <= src.size) {
        b.warnings.push({ code: 'id3_gekappt', message: `ID3v2-Tag (${tagGroesse} Bytes) ueber 256 KiB; nur der Anfang wurde gelesen.` });
      }
      const tagBuf = await src.readRange(10, lesen);
      try {
        leseId3v2(tagBuf, major, kopf[5], b);
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        b.warnings.push({ code: 'id3_unlesbar', message: 'ID3v2-Frames nicht lesbar.' });
      }
    } else {
      b.warnings.push({ code: 'id3_version_unbekannt', message: `ID3v2.${major} wird nicht gelesen.` });
    }
  }

  // Erster Frame: bis zu 64 KiB nach dem Tag suchen, Treffer mit einem Folgeframe bestaetigen.
  const fenster = await src.readRange(audioStart, 64 * 1024 + 4096);
  let frameOff = -1;
  let frame: Mp3Frame | null = null;
  for (let i = 0; i < Math.min(fenster.length - 3, 64 * 1024); i++) {
    if (fenster[i] !== 0xff) continue;
    if ((i & 0xfff) === 0) ctx.pruefeAbbruch();
    const f = parseMp3Kopf(fenster, i);
    if (!f) continue;
    const naechster = i + f.laenge;
    const ende = audioStart + naechster >= src.size; // Datei endet genau mit diesem Frame
    if (ende || naechster + 4 > fenster.length) {
      if (audioStart + i + f.laenge <= src.size) { frameOff = i; frame = f; break; }
      continue;
    }
    const n = parseMp3Kopf(fenster, naechster);
    if (n && n.samplerate === f.samplerate && n.layer === f.layer) {
      frameOff = i;
      frame = f;
      break;
    }
  }

  // ID3v1 (letzte 128 Bytes) — nur fehlende Tags auffuellen.
  let id3v1 = false;
  if (src.size >= audioStart + 128) {
    const v1 = await src.readRange(src.size - 128, 128);
    if (v1.toString('latin1', 0, 3) === 'TAG') {
      id3v1 = true;
      const feld = (a: number, e: number): string => v1.toString('latin1', a, e).split('\u0000')[0].trim();
      for (const [k, a, e] of [['title', 3, 33], ['artist', 33, 63], ['album', 63, 93], ['date', 93, 97], ['comment', 97, 127]] as const) {
        if (!(k in b.tags)) setzeTag(b.tags, k, feld(a, e));
      }
    }
  }

  if (!frame) {
    if (id3Version === null) throw new MedienFormatFehler('kein_frame', 'Weder ID3-Tag noch gueltiger MPEG-Audio-Frame in den ersten 64 KiB.');
    b.warnings.push({ code: 'kein_frame_gefunden', message: 'ID3-Tag vorhanden, aber kein gueltiger MPEG-Audio-Frame dahinter (abgeschnitten oder andere Nutzdaten).' });
    b.format_specific = { id3v2: id3Version, id3v1, audio_beginn: audioStart };
    return b;
  }

  // Xing/Info/VBRI im ersten Frame.
  const seite = frame.version === 1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xingPos = frameOff + 4 + (frame.crc ? 2 : 0) + seite;
  const vbriPos = frameOff + 4 + 32;
  let vbrKennung: string | null = null;
  let frames: number | null = null;
  let bytes: number | null = null;
  if (xingPos + 8 <= fenster.length) {
    const k = fenster.toString('latin1', xingPos, xingPos + 4);
    if (k === 'Xing' || k === 'Info') {
      vbrKennung = k;
      const flags = fenster.readUInt32BE(xingPos + 4);
      let o = xingPos + 8;
      if (flags & 1 && o + 4 <= fenster.length) { frames = fenster.readUInt32BE(o); o += 4; }
      if (flags & 2 && o + 4 <= fenster.length) { bytes = fenster.readUInt32BE(o); }
      if (xingPos + 129 <= fenster.length) {
        const enc = fenster.toString('latin1', xingPos + 120, xingPos + 129);
        if (/^(LAME|Lavf|Lavc|GOGO)/.test(enc) && !('encoder' in b.tags)) setzeTag(b.tags, 'encoder', enc.replace(/[^\x20-\x7e]/g, ''));
      }
    }
  }
  if (!vbrKennung && vbriPos + 18 <= fenster.length && fenster.toString('latin1', vbriPos, vbriPos + 4) === 'VBRI') {
    vbrKennung = 'VBRI';
    bytes = fenster.readUInt32BE(vbriPos + 10);
    frames = fenster.readUInt32BE(vbriPos + 14);
  }

  const nutzbytes = Math.max(0, src.size - audioStart - (id3v1 ? 128 : 0));
  let dauer: number | null = null;
  let bitrate: number | null = frame.bitrate;
  let geschaetzt = false;
  const istVbr = vbrKennung === 'Xing' || vbrKennung === 'VBRI';
  if (frames !== null && frames > 0) {
    dauer = rund((frames * frame.samples) / frame.samplerate);
    if (istVbr && dauer !== null && dauer > 0) bitrate = Math.round(((bytes ?? nutzbytes) * 8) / dauer);
  } else {
    dauer = rund((nutzbytes * 8) / frame.bitrate);
    geschaetzt = true;
  }
  b.duration_s = dauer;
  b.bit_rate = bitrate;
  b.streams.unshift({
    kind: 'audio_stream',
    name: null,
    data: {
      index: 0,
      codec_name: frame.layer === 3 ? 'mp3' : frame.layer === 2 ? 'mp2' : 'mp1',
      sample_rate: frame.samplerate,
      channels: frame.mono ? 1 : 2,
      channel_mode: frame.modus,
      bit_rate: bitrate,
      duration_s: dauer,
      mpeg_version: frame.version,
      layer: frame.layer,
      vbr: istVbr,
      frames,
    },
    source_range: { offset: audioStart + frameOff, length: frame.laenge },
  });
  b.format_specific = {
    id3v2: id3Version,
    id3v2_bytes: id3Groesse || null,
    id3v1,
    vbr_kopf: vbrKennung,
    audio_beginn: audioStart,
    dauer_geschaetzt: geschaetzt,
  };
  return b;
}
