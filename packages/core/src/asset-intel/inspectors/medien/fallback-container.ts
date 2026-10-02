/**
 * MODUL: Medien-Inspektoren — Header-Fallback fuer MP4/MOV (ISO-BMFF) und MKV/WebM (EBML)
 * ZWECK: Liest ohne ffprobe nur die Strukturdaten: ftyp, moov/mvhd/trak/mdhd/hdlr/stsd/stts bei MP4,
 *        EBML-Kopf, Segment-Info und Tracks bei MKV. Nutzdaten (mdat, Cluster) werden nie gelesen.
 */

import { leseReader } from '../../binary-reader.js';
import type { AssetContext, AssetSource } from '../../types.js';
import { MedienFormatFehler, ascii4, kappeText, leererBefund, rund } from './gemeinsam.js';
import type { MedienBefund, StreamBefund } from './gemeinsam.js';

const MAX_TOP_BOXEN = 256;
const MAX_MOOV_BYTES = 16 * 1024 * 1024;
const MKV_KOPF_BYTES = 1024 * 1024;

// ---------------------------------------------------------------- MP4

interface Box {
  typ: string;
  start: number;
  datenStart: number;
  ende: number;
}

function* boxen(buf: Buffer, von: number, bis: number): Generator<Box> {
  let pos = von;
  while (pos + 8 <= bis) {
    let size = buf.readUInt32BE(pos);
    const typ = ascii4(buf, pos + 4);
    let hdr = 8;
    if (size === 1) {
      if (pos + 16 > bis) return;
      const gross = buf.readBigUInt64BE(pos + 8);
      if (gross > BigInt(Number.MAX_SAFE_INTEGER)) return;
      size = Number(gross);
      hdr = 16;
    } else if (size === 0) {
      size = bis - pos;
    }
    if (size < hdr) return;
    yield { typ, start: pos, datenStart: pos + hdr, ende: Math.min(pos + size, bis) };
    pos += size;
  }
}

function kind(buf: Buffer, von: number, bis: number, typ: string): Box | null {
  for (const b of boxen(buf, von, bis)) if (b.typ === typ) return b;
  return null;
}

const MP4_CODECS: Record<string, string> = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8', mp4v: 'mpeg4',
  mp4a: 'aac', 'ac-3': 'ac3', 'ec-3': 'eac3', opus: 'opus', flac: 'flac', alac: 'alac', '.mp3': 'mp3', mjpg: 'mjpeg',
  jpeg: 'mjpeg', tx3g: 'mov_text', wvtt: 'webvtt', samr: 'amr_nb', sowt: 'pcm_s16le', twos: 'pcm_s16be', 'raw ': 'rawvideo',
};

function sprache(code: number): string | null {
  if (code === 0) return null;
  const s = String.fromCharCode(((code >> 10) & 31) + 0x60, ((code >> 5) & 31) + 0x60, (code & 31) + 0x60);
  return /^[a-z]{3}$/.test(s) && s !== 'und' ? s : null;
}

function u64Zahl(buf: Buffer, o: number): number {
  const v = buf.readBigUInt64BE(o);
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v);
}

function leseTrak(buf: Buffer, trak: Box, basis: number, index: number): StreamBefund | null {
  const mdia = kind(buf, trak.datenStart, trak.ende, 'mdia');
  if (!mdia) return null;
  const hdlr = kind(buf, mdia.datenStart, mdia.ende, 'hdlr');
  const handler = hdlr && hdlr.ende - hdlr.datenStart >= 12 ? ascii4(buf, hdlr.datenStart + 8) : '';
  const art: StreamBefund['kind'] =
    handler === 'vide' ? 'video_stream' : handler === 'soun' ? 'audio_stream' : handler === 'subt' || handler === 'sbtl' || handler === 'text' ? 'subtitle_stream' : 'data_stream';

  let zeitskala = 0;
  let dauerRoh = 0;
  let lang: string | null = null;
  const mdhd = kind(buf, mdia.datenStart, mdia.ende, 'mdhd');
  if (mdhd && mdhd.ende - mdhd.datenStart >= 24) {
    const d = mdhd.datenStart;
    if (buf[d] === 1 && mdhd.ende - d >= 36) {
      zeitskala = buf.readUInt32BE(d + 20);
      dauerRoh = u64Zahl(buf, d + 24);
      lang = sprache(buf.readUInt16BE(d + 32));
    } else {
      zeitskala = buf.readUInt32BE(d + 12);
      dauerRoh = buf.readUInt32BE(d + 16);
      lang = sprache(buf.readUInt16BE(d + 20));
    }
  }
  const dauer = zeitskala > 0 && dauerRoh > 0 && dauerRoh < Number.MAX_SAFE_INTEGER ? rund(dauerRoh / zeitskala) : null;

  const data: Record<string, unknown> = { index, handler: handler || null };
  let tkhdBreite: number | null = null;
  let tkhdHoehe: number | null = null;
  const tkhd = kind(buf, trak.datenStart, trak.ende, 'tkhd');
  if (tkhd) {
    const d = tkhd.datenStart;
    const v1 = buf[d] === 1;
    const wo = v1 ? 88 : 76;
    if (tkhd.ende - d >= wo + 8) {
      tkhdBreite = Math.round(buf.readUInt32BE(d + wo) / 65536);
      tkhdHoehe = Math.round(buf.readUInt32BE(d + wo + 4) / 65536);
    }
  }

  const minf = kind(buf, mdia.datenStart, mdia.ende, 'minf');
  const stbl = minf ? kind(buf, minf.datenStart, minf.ende, 'stbl') : null;
  const stsd = stbl ? kind(buf, stbl.datenStart, stbl.ende, 'stsd') : null;
  let fourcc: string | null = null;
  if (stsd && stsd.ende - stsd.datenStart >= 16) {
    const e = stsd.datenStart + 8; // erster Sample-Eintrag
    fourcc = ascii4(buf, e + 4);
    if (art === 'audio_stream' && stsd.ende - e >= 36) {
      data.channels = buf.readUInt16BE(e + 24);
      data.bits_per_sample = buf.readUInt16BE(e + 26) || null;
      data.sample_rate = buf.readUInt32BE(e + 32) >>> 16;
    } else if (art === 'video_stream' && stsd.ende - e >= 36) {
      data.width = buf.readUInt16BE(e + 32);
      data.height = buf.readUInt16BE(e + 34);
    }
  }
  if (art === 'video_stream') {
    if (data.width === undefined && tkhdBreite) data.width = tkhdBreite;
    if (data.height === undefined && tkhdHoehe) data.height = tkhdHoehe;
    // Bildrate aus stts: Summe der Sample-Anzahlen durch Dauer.
    const stts = stbl ? kind(buf, stbl.datenStart, stbl.ende, 'stts') : null;
    if (stts && stts.ende - stts.datenStart >= 8) {
      const n = Math.min(buf.readUInt32BE(stts.datenStart + 4), 4096, Math.floor((stts.ende - stts.datenStart - 8) / 8));
      let summe = 0;
      for (let i = 0; i < n; i++) summe += buf.readUInt32BE(stts.datenStart + 8 + i * 8);
      data.nb_frames = summe > 0 ? summe : null;
      data.avg_frame_rate = dauer && dauer > 0 && summe > 0 ? rund(summe / dauer, 3) : null;
    }
  }
  data.codec_tag = fourcc;
  data.codec_name = fourcc ? (MP4_CODECS[fourcc.toLowerCase()] ?? fourcc.trim()) : null;
  data.duration_s = dauer;
  data.language = lang;
  return { kind: art, name: null, data, source_range: { offset: basis + trak.start, length: trak.ende - trak.start } };
}

export async function mp4Fallback(src: AssetSource, ctx: AssetContext): Promise<MedienBefund> {
  const b = leererBefund('mp4');
  let pos = 0;
  let n = 0;
  let ftyp = false;
  let moov: { start: number; hdr: number; size: number } | null = null;
  while (pos + 8 <= src.size && n < MAX_TOP_BOXEN) {
    ctx.pruefeAbbruch();
    const h = await src.readRange(pos, 16);
    if (h.length < 8) break;
    let size = h.readUInt32BE(0);
    const typ = ascii4(h, 4);
    let hdr = 8;
    if (n === 0 && typ !== 'ftyp') throw new MedienFormatFehler('signatur_ungueltig', `Erste Box ist "${typ}", nicht ftyp.`);
    if (size === 1) {
      if (h.length < 16) break;
      const gross = h.readBigUInt64BE(8);
      if (gross > BigInt(Number.MAX_SAFE_INTEGER)) {
        b.warnings.push({ code: 'box_ungueltig', message: `Box "${typ}" bei Offset ${pos} mit unmoeglicher 64-Bit-Groesse.` });
        break;
      }
      size = Number(gross);
      hdr = 16;
    } else if (size === 0) {
      size = src.size - pos;
    }
    if (size < hdr) {
      b.warnings.push({ code: 'box_ungueltig', message: `Box "${typ}" bei Offset ${pos} mit Groesse ${size} (< Header).` });
      break;
    }
    if (typ === 'ftyp') {
      ftyp = true;
      const f = await src.readRange(pos + hdr, Math.min(size - hdr, 256));
      if (f.length >= 8) {
        const brands: string[] = [];
        for (let o = 8; o + 4 <= f.length && brands.length < 16; o += 4) brands.push(ascii4(f, o));
        const major = ascii4(f, 0);
        b.container = major === 'qt  ' ? 'mov' : 'mp4';
        b.format_specific.major_brand = major;
        b.format_specific.minor_version = f.readUInt32BE(4);
        b.format_specific.compatible_brands = brands;
      }
    } else if (typ === 'moov' && !moov) {
      moov = { start: pos, hdr, size };
    }
    if (pos + size > src.size) {
      b.warnings.push({ code: 'box_abgeschnitten', message: `Box "${typ}" (${size} Bytes ab ${pos}) ragt ueber das Dateiende (${src.size}).` });
      break;
    }
    pos += size;
    n++;
  }
  if (!ftyp) throw new MedienFormatFehler('signatur_ungueltig', 'Keine ftyp-Box.');
  if (!moov) {
    b.warnings.push({ code: 'moov_fehlt', message: 'Keine moov-Box gefunden (Datei abgeschnitten oder moov hinter dem lesbaren Bereich); Streams und Dauer unbekannt.' });
    return b;
  }

  const verfuegbar = Math.max(0, src.size - (moov.start + moov.hdr));
  const nutz = Math.min(moov.size - moov.hdr, verfuegbar);
  if (nutz > Math.min(MAX_MOOV_BYTES, ctx.limits.maxReadBytes / 2)) {
    b.warnings.push({ code: 'moov_zu_gross', message: `moov-Box (${nutz} Bytes) ueber der Lesegrenze; keine Streams gelesen.` });
    return b;
  }
  if (nutz < moov.size - moov.hdr) b.warnings.push({ code: 'moov_abgeschnitten', message: `moov-Box meldet ${moov.size} Bytes, es sind nur ${nutz + moov.hdr} da; es wird gelesen, was vorhanden ist.` });
  const buf = await src.readRange(moov.start + moov.hdr, nutz);
  const basis = moov.start + moov.hdr;
  const maxStreams = Math.min(256, ctx.limits.maxObjects);
  let tracks = 0;
  for (const c of boxen(buf, 0, buf.length)) {
    ctx.pruefeAbbruch();
    if (c.typ === 'mvhd' && c.ende - c.datenStart >= 20) {
      const d = c.datenStart;
      const v1 = buf[d] === 1 && c.ende - d >= 32;
      const ts = v1 ? buf.readUInt32BE(d + 20) : buf.readUInt32BE(d + 12);
      const dur = v1 ? u64Zahl(buf, d + 24) : buf.readUInt32BE(d + 16);
      if (ts > 0 && dur > 0 && dur < Number.MAX_SAFE_INTEGER && !(dur === 0xffffffff && !v1)) b.duration_s = rund(dur / ts);
      b.format_specific.zeitskala = ts;
    } else if (c.typ === 'trak') {
      if (tracks >= maxStreams) {
        b.warnings.push({ code: 'streams_gekappt', message: `Mehr als ${maxStreams} Tracks; Rest nicht gelesen.` });
        break;
      }
      const s = leseTrak(buf, c, basis, tracks);
      if (s) b.streams.push(s);
      tracks++;
    }
  }
  b.bit_rate = b.duration_s && b.duration_s > 0 ? Math.round((src.size * 8) / b.duration_s) : null;
  b.format_specific.bit_rate_geschaetzt = b.bit_rate !== null;
  if (b.duration_s === null) b.warnings.push({ code: 'mvhd_fehlt', message: 'mvhd fehlt oder meldet keine Dauer (z. B. fragmentiertes MP4: die Dauer steht dann in den Fragmenten); Gesamtdauer unbekannt.' });
  return b;
}

// ---------------------------------------------------------------- MKV

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TRACKS = 0x1654ae6b;
const ID_CLUSTER = 0x1f43b675;
const ID_TRACKENTRY = 0xae;

interface Elem {
  id: number;
  start: number;
  datenStart: number;
  ende: number;
  unbekannt: boolean;
}

/** Elemente ab von bis bis (Elemente ueber bis werden auf bis gekappt). Beendet bei Muell-Kopf. */
function* elemente(buf: Buffer, von: number, bis: number): Generator<Elem> {
  let pos = von;
  while (pos < bis) {
    const b0 = buf[pos];
    if (b0 === 0 || b0 === undefined) return;
    const idLen = Math.clz32(b0) - 24 + 1;
    if (idLen > 4 || pos + idLen > bis) return;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + buf[pos + i];
    const sp = pos + idLen;
    const s0 = buf[sp];
    if (s0 === undefined || s0 === 0) return;
    const sLen = Math.clz32(s0) - 24 + 1;
    if (sp + sLen > bis) return;
    let wert = s0 & (0xff >> sLen);
    let alleEins = wert === 0xff >> sLen;
    for (let i = 1; i < sLen; i++) {
      wert = wert * 256 + buf[sp + i];
      if (buf[sp + i] !== 0xff) alleEins = false;
    }
    const datenStart = sp + sLen;
    const ende = alleEins ? bis : Math.min(datenStart + wert, bis);
    yield { id, start: pos, datenStart, ende, unbekannt: alleEins };
    if (alleEins) return;
    pos = datenStart + wert;
  }
}

function uint(buf: Buffer, e: Elem): number {
  let v = 0;
  for (let i = e.datenStart; i < Math.min(e.ende, e.datenStart + 8); i++) v = v * 256 + buf[i];
  return v;
}

function gleitkomma(buf: Buffer, e: Elem): number | null {
  const len = e.ende - e.datenStart;
  if (len === 4) return buf.readFloatBE(e.datenStart);
  if (len === 8) return buf.readDoubleBE(e.datenStart);
  return null;
}

function text(buf: Buffer, e: Elem): string {
  const roh = buf.subarray(e.datenStart, e.ende);
  const nul = roh.indexOf(0);
  return kappeText(roh.subarray(0, nul < 0 ? roh.length : nul).toString('utf8'), 256);
}

const MKV_CODECS: Record<string, string> = {
  'V_MPEG4/ISO/AVC': 'h264', 'V_MPEGH/ISO/HEVC': 'hevc', V_VP8: 'vp8', V_VP9: 'vp9', V_AV1: 'av1', 'V_MPEG4/ISO/ASP': 'mpeg4',
  V_MPEG2: 'mpeg2video', V_THEORA: 'theora', V_MS_VFW_FOURCC: 'vfw', A_AAC: 'aac', A_OPUS: 'opus', A_VORBIS: 'vorbis',
  A_FLAC: 'flac', A_AC3: 'ac3', A_EAC3: 'eac3', A_DTS: 'dts', 'A_PCM/INT/LIT': 'pcm_s16le', 'A_MPEG/L3': 'mp3',
  'S_TEXT/UTF8': 'subrip', 'S_TEXT/ASS': 'ass', 'S_TEXT/WEBVTT': 'webvtt', S_HDMV_PGS: 'hdmv_pgs_subtitle',
};

function leseTrackEntry(buf: Buffer, t: Elem, index: number): StreamBefund {
  let typ = 0;
  let codecId: string | null = null;
  let name: string | null = null;
  let sprachCode: string | null = null;
  let defaultDauer = 0;
  let nummer: number | null = null;
  let privat: Buffer | null = null;
  const video: Record<string, number> = {};
  const audio: Record<string, number> = {};
  for (const e of elemente(buf, t.datenStart, t.ende)) {
    switch (e.id) {
      case 0xd7: nummer = uint(buf, e); break;
      case 0x83: typ = uint(buf, e); break;
      case 0x86: codecId = text(buf, e) || null; break;
      case 0x536e: name = text(buf, e) || null; break;
      case 0x22b59c: sprachCode = text(buf, e) || null; break;
      case 0x23e383: defaultDauer = uint(buf, e); break;
      case 0x63a2: privat = buf.subarray(e.datenStart, Math.min(e.ende, e.datenStart + 64)); break;
      case 0xe0:
        for (const v of elemente(buf, e.datenStart, e.ende)) {
          if (v.id === 0xb0) video.width = uint(buf, v);
          else if (v.id === 0xba) video.height = uint(buf, v);
        }
        break;
      case 0xe1:
        for (const a of elemente(buf, e.datenStart, e.ende)) {
          if (a.id === 0x9f) audio.channels = uint(buf, a);
          else if (a.id === 0x6264) audio.bits = uint(buf, a);
          else if (a.id === 0xb5) audio.rate = gleitkomma(buf, a) ?? 0;
        }
        break;
      default:
    }
  }
  const art: StreamBefund['kind'] = typ === 1 ? 'video_stream' : typ === 2 ? 'audio_stream' : typ === 17 ? 'subtitle_stream' : 'data_stream';
  const data: Record<string, unknown> = {
    index,
    track_number: nummer,
    codec_id: codecId,
    codec_name: codecId ? (MKV_CODECS[codecId] ?? (codecId.startsWith('A_PCM') ? 'pcm' : codecId)) : null,
    language: sprachCode && sprachCode !== 'und' ? sprachCode : null,
  };
  if (codecId === 'V_MS/VFW/FOURCC' && privat && privat.length >= 20) {
    // Windows-Videocodec: die Kennung steht im BITMAPINFOHEADER (Offset 16) der CodecPrivate-Daten.
    const fourcc = ascii4(privat, 16).toLowerCase().trim();
    data.codec_tag = fourcc;
    data.codec_name = fourcc;
  }
  if (art === 'video_stream') {
    data.width = video.width ?? null;
    data.height = video.height ?? null;
    data.avg_frame_rate = defaultDauer > 0 ? rund(1e9 / defaultDauer, 3) : null;
  } else if (art === 'audio_stream') {
    data.sample_rate = audio.rate ? Math.round(audio.rate) : null;
    data.channels = audio.channels ?? null;
    data.bits_per_sample = audio.bits ?? null;
  }
  return { kind: art, name, data, source_range: { offset: t.start, length: t.ende - t.start } };
}

export async function mkvFallback(src: AssetSource, ctx: AssetContext): Promise<MedienBefund> {
  const laenge = Math.min(src.size, MKV_KOPF_BYTES, Math.floor(ctx.limits.maxReadBytes / 4));
  const rd = await leseReader(src, 0, laenge);
  const buf = Buffer.from(rd.bytes(laenge));
  const b = leererBefund('matroska');
  let ebml = false;
  let segment = false;
  let zeitskala = 1_000_000;
  let dauerRoh: number | null = null;
  let infoGesehen = false;
  let tracksGesehen = false;
  const maxStreams = Math.min(256, ctx.limits.maxObjects);

  for (const top of elemente(buf, 0, buf.length)) {
    ctx.pruefeAbbruch();
    if (top.id === ID_EBML) {
      ebml = true;
      for (const e of elemente(buf, top.datenStart, top.ende)) {
        if (e.id === 0x4282) {
          const dt = text(buf, e);
          b.format_specific.doc_type = dt;
          b.container = dt === 'webm' ? 'webm' : 'matroska';
        } else if (e.id === 0x4287) {
          b.format_specific.doc_type_version = uint(buf, e);
        }
      }
    } else if (top.id === ID_SEGMENT) {
      segment = true;
      for (const c of elemente(buf, top.datenStart, top.ende)) {
        ctx.pruefeAbbruch();
        if (c.id === ID_CLUSTER) break;
        if (c.id === ID_INFO) {
          infoGesehen = true;
          for (const e of elemente(buf, c.datenStart, c.ende)) {
            if (e.id === 0x2ad7b1) zeitskala = uint(buf, e) || zeitskala;
            else if (e.id === 0x4489) dauerRoh = gleitkomma(buf, e);
            else if (e.id === 0x7ba9) b.tags.title = text(buf, e);
            else if (e.id === 0x5741) b.tags.encoder = text(buf, e);
            else if (e.id === 0x4d80) b.format_specific.muxing_app = text(buf, e);
            else if (e.id === 0x4461 && e.ende - e.datenStart === 8) {
              const ns = Number(buf.readBigInt64BE(e.datenStart));
              const ms = Date.UTC(2001, 0, 1) + ns / 1e6;
              if (Number.isFinite(ms) && Math.abs(ms) < 8.64e15) b.tags.creation_time = new Date(ms).toISOString();
            }
          }
        } else if (c.id === ID_TRACKS) {
          tracksGesehen = true;
          for (const e of elemente(buf, c.datenStart, c.ende)) {
            if (e.id !== ID_TRACKENTRY) continue;
            if (b.streams.length >= maxStreams) {
              b.warnings.push({ code: 'streams_gekappt', message: `Mehr als ${maxStreams} Tracks; Rest nicht gelesen.` });
              break;
            }
            b.streams.push(leseTrackEntry(buf, e, b.streams.length));
          }
        }
      }
    }
  }
  if (!ebml) throw new MedienFormatFehler('signatur_ungueltig', 'Kein EBML-Kopf.');
  if (!segment) b.warnings.push({ code: 'segment_fehlt', message: 'Kein Segment-Element im lesbaren Kopfbereich.' });
  if (segment && !infoGesehen) b.warnings.push({ code: 'info_fehlt', message: 'Kein Info-Element im Kopfbereich (z. B. hinter den Clustern); Dauer unbekannt.' });
  if (segment && !tracksGesehen) b.warnings.push({ code: 'tracks_fehlen', message: 'Kein Tracks-Element im Kopfbereich; Streams unbekannt.' });
  if (dauerRoh !== null && Number.isFinite(dauerRoh) && dauerRoh > 0) b.duration_s = rund((dauerRoh * zeitskala) / 1e9);
  b.bit_rate = b.duration_s && b.duration_s > 0 ? Math.round((src.size * 8) / b.duration_s) : null;
  b.format_specific.bit_rate_geschaetzt = b.bit_rate !== null;
  b.format_specific.zeitskala_ns = zeitskala;
  return b;
}
