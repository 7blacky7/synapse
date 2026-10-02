/**
 * MODUL: Medien-Inspektoren — Header-Fallback fuer RIFF (WAV, AVI)
 * ZWECK: Liest ohne ffprobe nur die Header: Chunk-Liste, fmt/avih/strh/strf, LIST/INFO-Tags.
 *        Nie die Nutzdaten (data/movi), nie mehr als 256 KiB je Listenchunk.
 */

import { BinaryReader, leseReader } from '../../binary-reader.js';
import type { AssetContext, AssetSource } from '../../types.js';
import { MedienFormatFehler, ascii4, kappeText, leererBefund, rund, setzeTag } from './gemeinsam.js';
import type { MedienBefund, StreamBefund } from './gemeinsam.js';

/** Hoechste Anzahl Top-Level-Chunks, die wir ansehen. */
const MAX_TOP_CHUNKS = 256;
/** Groesste LIST-Nutzlast, die wir lesen. */
const MAX_LIST_BYTES = 256 * 1024;

interface RiffKopf {
  id: string;
  /** Groesse laut Header (kann die Datei ueberragen). */
  size: number;
  /** Dateioffset des Chunk-Headers. */
  offset: number;
  /** Bei LIST/RIFF: der Listentyp, sonst null. */
  typ: string | null;
  /** Der Chunk endet laut Header hinter dem Dateiende. */
  ueberlaenge: boolean;
}

/** Top-Level-Chunks ab start (nur Header, ueberspringt die Nutzlast per Offset). */
async function topChunks(src: AssetSource, ctx: AssetContext, start: number): Promise<{ chunks: RiffKopf[]; gekappt: boolean }> {
  const chunks: RiffKopf[] = [];
  let pos = start;
  while (pos + 8 <= src.size) {
    if (chunks.length >= MAX_TOP_CHUNKS) return { chunks, gekappt: true };
    ctx.pruefeAbbruch();
    const h = await src.readRange(pos, 12);
    if (h.length < 8) break;
    // Nachlauf nach dem letzten Chunk (z. B. Fuellbytes) hat keine ASCII-Kennung: kein Chunk, kein Befund.
    if (![0, 1, 2, 3].every(i => h[i] >= 0x20 && h[i] < 0x7f)) break;
    const id = ascii4(h, 0);
    const size = h.readUInt32LE(4);
    const typ = (id === 'LIST' || id === 'RIFF') && h.length >= 12 ? ascii4(h, 8) : null;
    const ueberlaenge = pos + 8 + size > src.size;
    chunks.push({ id, size, offset: pos, typ, ueberlaenge });
    if (ueberlaenge) break;
    pos += 8 + size + (size & 1);
  }
  return { chunks, gekappt: false };
}

/** Chunk-Iteration im Speicher (fuer die bereits gelesene hdrl-/INFO-Nutzlast). */
function* chunksImSpeicher(buf: Buffer, von: number, bis: number): Generator<{ id: string; start: number; datenStart: number; ende: number; typ: string | null }> {
  let pos = von;
  while (pos + 8 <= bis) {
    const id = ascii4(buf, pos);
    const size = buf.readUInt32LE(pos + 4);
    const datenStart = pos + 8;
    const ende = Math.min(datenStart + size, bis);
    const typ = id === 'LIST' && ende - datenStart >= 4 ? ascii4(buf, datenStart) : null;
    yield { id, start: pos, datenStart, ende, typ };
    pos = datenStart + size + (size & 1);
  }
}

const INFO_TAGS: Record<string, string> = {
  INAM: 'title', IART: 'artist', IPRD: 'album', ISFT: 'encoder', ICRD: 'creation_time',
  ICMT: 'comment', IGNR: 'genre', ITRK: 'track', ICOP: 'copyright', ISBJ: 'subject',
};

/** Liest eine LIST/INFO-Nutzlast (ohne den 4-Byte-Typ) in tags. */
function leseInfo(buf: Buffer, von: number, bis: number, tags: Record<string, string>): void {
  for (const c of chunksImSpeicher(buf, von, bis)) {
    const schluessel = INFO_TAGS[c.id];
    if (!schluessel) continue;
    const roh = buf.subarray(c.datenStart, c.ende);
    const nul = roh.indexOf(0);
    setzeTag(tags, schluessel, roh.subarray(0, nul < 0 ? roh.length : nul).toString('utf8'));
  }
}

/** Codecname zu einer WAVEFORMATEX-Formatkennung. */
export function wavCodecName(tag: number, bits: number): string {
  switch (tag) {
    case 1:
      return bits === 8 ? 'pcm_u8' : bits === 16 ? 'pcm_s16le' : bits === 24 ? 'pcm_s24le' : bits === 32 ? 'pcm_s32le' : 'pcm';
    case 3:
      return bits === 64 ? 'pcm_f64le' : 'pcm_f32le';
    case 2: return 'adpcm_ms';
    case 6: return 'pcm_alaw';
    case 7: return 'pcm_mulaw';
    case 0x11: return 'adpcm_ima_wav';
    case 0x50: return 'mp2';
    case 0x55: return 'mp3';
    case 0xff: return 'aac';
    case 0x2000: return 'ac3';
    case 0xfffe: return 'wave_format_extensible';
    default: return `wave_format_0x${tag.toString(16)}`;
  }
}

/** Gemeinsames Stueck von WAV-fmt-Chunk und AVI-Audio-strf (WAVEFORMATEX). */
function leseWaveFormat(buf: Buffer): { tag: number; kanaele: number; rate: number; byterate: number; blockAlign: number; bits: number } | null {
  if (buf.length < 16) return null;
  const r = new BinaryReader(buf);
  let tag = r.u16le();
  const kanaele = r.u16le();
  const rate = r.u32le();
  const byterate = r.u32le();
  const blockAlign = r.u16le();
  const bits = r.u16le();
  if (tag === 0xfffe && buf.length >= 26) {
    // WAVE_FORMAT_EXTENSIBLE: cbSize(2) gueltigeBits(2) Kanalmaske(4) UnterformatGUID(16, die ersten 2 Bytes = echte Kennung)
    tag = buf.readUInt16LE(24);
  }
  return { tag, kanaele, rate, byterate, blockAlign, bits };
}

export async function wavFallback(src: AssetSource, ctx: AssetContext): Promise<MedienBefund> {
  const kopf = await leseReader(src, 0, 12);
  const riff = ascii4(kopf.bytes(4), 0);
  kopf.u32le();
  const wave = ascii4(kopf.bytes(4), 0);
  if (riff !== 'RIFF' || wave !== 'WAVE') {
    throw new MedienFormatFehler('signatur_ungueltig', `Kein RIFF/WAVE-Kopf (gefunden "${riff}"/"${wave}").`);
  }
  const b = leererBefund('wav');
  const { chunks, gekappt } = await topChunks(src, ctx, 12);
  if (gekappt) b.warnings.push({ code: 'chunks_gekappt', message: `Mehr als ${MAX_TOP_CHUNKS} Top-Level-Chunks; Rest nicht gelesen.` });

  if (chunks.some(c => c.ueberlaenge && c.id !== 'data')) {
    b.warnings.push({ code: 'datei_abgeschnitten', message: 'Ein Chunk ragt ueber das Dateiende (Datei abgeschnitten oder Laengenangabe falsch).' });
  }
  let fmt: ReturnType<typeof leseWaveFormat> = null;
  let fmtChunk: RiffKopf | null = null;
  let datenBytes: number | null = null;
  let datenAbgeschnitten = false;
  const chunkIds: string[] = [];
  for (const c of chunks) {
    ctx.pruefeAbbruch();
    chunkIds.push(c.id);
    if (c.id === 'fmt ' && !fmt) {
      fmtChunk = c;
      const buf = await src.readRange(c.offset + 8, Math.min(c.size, 40));
      fmt = leseWaveFormat(buf);
      if (!fmt) b.warnings.push({ code: 'fmt_chunk_zu_kurz', message: `fmt-Chunk hat nur ${c.size} Bytes (mind. 16 noetig).` });
    } else if (c.id === 'data' && datenBytes === null) {
      const verfuegbar = Math.max(0, src.size - (c.offset + 8));
      datenBytes = Math.min(c.size, verfuegbar);
      if (c.ueberlaenge) {
        datenAbgeschnitten = true;
        b.warnings.push({
          code: 'datei_abgeschnitten',
          message: `data-Chunk meldet ${c.size} Bytes, die Datei hat ab dort nur ${verfuegbar}; Dauer aus dem tatsaechlich Vorhandenen.`,
        });
      }
    } else if (c.id === 'LIST' && c.typ === 'INFO' && c.size > 4) {
      const buf = await src.readRange(c.offset + 12, Math.min(c.size - 4, MAX_LIST_BYTES));
      leseInfo(buf, 0, buf.length, b.tags);
    }
  }
  if (!fmt) {
    if (!fmtChunk) b.warnings.push({ code: 'fmt_chunk_fehlt', message: 'Kein fmt-Chunk gefunden; Audioformat unbekannt.' });
    b.format_specific = { chunks: chunkIds.slice(0, 32) };
    return b;
  }

  const unplausibel = fmt.kanaele === 0 || fmt.rate === 0 || fmt.bits > 64 || fmt.kanaele > 1024;
  if (unplausibel) {
    b.warnings.push({
      code: 'werte_unplausibel',
      message: `fmt-Chunk mit unplausiblen Werten (Kanaele ${fmt.kanaele}, Rate ${fmt.rate}, Bits ${fmt.bits}); Dauer nicht berechnet.`,
    });
  }
  const byterate = fmt.byterate > 0 ? fmt.byterate : fmt.rate * fmt.blockAlign;
  const dauer = !unplausibel && datenBytes !== null && byterate > 0 ? rund(datenBytes / byterate) : null;
  b.duration_s = dauer;
  b.bit_rate = byterate > 0 && !unplausibel ? byterate * 8 : null;
  const s: StreamBefund = {
    kind: 'audio_stream',
    name: null,
    data: {
      index: 0,
      codec_name: wavCodecName(fmt.tag, fmt.bits),
      format_tag: fmt.tag,
      sample_rate: fmt.rate,
      channels: fmt.kanaele,
      bits_per_sample: fmt.bits || null,
      block_align: fmt.blockAlign,
      bit_rate: b.bit_rate,
      duration_s: dauer,
      data_bytes: datenBytes,
    },
  };
  if (fmtChunk) s.source_range = { offset: fmtChunk.offset, length: 8 + fmtChunk.size };
  b.streams.push(s);
  b.format_specific = { chunks: chunkIds.slice(0, 32), daten_abgeschnitten: datenAbgeschnitten };
  return b;
}

const AVI_VIDEO_CODECS: Record<string, string> = {
  h264: 'h264', x264: 'h264', avc1: 'h264', xvid: 'mpeg4', divx: 'mpeg4', dx50: 'mpeg4', fmp4: 'mpeg4',
  mp4v: 'mpeg4', mjpg: 'mjpeg', mpg2: 'mpeg2video', wmv1: 'wmv1', wmv2: 'wmv2', wmv3: 'wmv3',
};

export async function aviFallback(src: AssetSource, ctx: AssetContext): Promise<MedienBefund> {
  const kopf = await leseReader(src, 0, 12);
  const riff = ascii4(kopf.bytes(4), 0);
  kopf.u32le();
  const avi = ascii4(kopf.bytes(4), 0);
  if (riff !== 'RIFF' || avi !== 'AVI ') {
    throw new MedienFormatFehler('signatur_ungueltig', `Kein RIFF/AVI-Kopf (gefunden "${riff}"/"${avi}").`);
  }
  const b = leererBefund('avi');
  const { chunks, gekappt } = await topChunks(src, ctx, 12);
  if (gekappt) b.warnings.push({ code: 'chunks_gekappt', message: `Mehr als ${MAX_TOP_CHUNKS} Top-Level-Chunks; Rest nicht gelesen.` });

  if (chunks.some(c => c.ueberlaenge && c.typ !== 'movi')) {
    b.warnings.push({ code: 'datei_abgeschnitten', message: 'Ein Chunk ragt ueber das Dateiende (Datei abgeschnitten oder Laengenangabe falsch).' });
  }
  let avih: { usec: number; frames: number; breite: number; hoehe: number } | null = null;
  let hdrlGesehen = false;
  let moviGesehen = false;
  const maxStreams = Math.min(256, ctx.limits.maxObjects);
  const streamDauern: number[] = [];
  for (const c of chunks) {
    ctx.pruefeAbbruch();
    if (c.id === 'LIST' && c.typ === 'hdrl' && c.size > 4) {
      hdrlGesehen = true;
      const laenge = Math.min(c.size - 4, MAX_LIST_BYTES);
      if (laenge < c.size - 4) b.warnings.push({ code: 'hdrl_gekappt', message: `hdrl-Liste (${c.size} Bytes) ueber ${MAX_LIST_BYTES}; nur der Anfang wurde gelesen.` });
      const buf = await src.readRange(c.offset + 12, laenge);
      const basis = c.offset + 12;
      for (const e of chunksImSpeicher(buf, 0, buf.length)) {
        if (e.id === 'avih' && e.ende - e.datenStart >= 40) {
          avih = {
            usec: buf.readUInt32LE(e.datenStart),
            frames: buf.readUInt32LE(e.datenStart + 16),
            breite: buf.readUInt32LE(e.datenStart + 32),
            hoehe: buf.readUInt32LE(e.datenStart + 36),
          };
        } else if (e.id === 'LIST' && e.typ === 'strl') {
          if (b.streams.length >= maxStreams) {
            b.warnings.push({ code: 'streams_gekappt', message: `Mehr als ${maxStreams} Streams; Rest nicht gelesen.` });
            break;
          }
          const s = leseStrl(buf, e.datenStart + 4, e.ende, basis, e.start, b.streams.length);
          if (s) {
            b.streams.push(s.stream);
            if (s.dauer !== null) streamDauern.push(s.dauer);
          }
        }
      }
    } else if (c.id === 'LIST' && c.typ === 'INFO' && c.size > 4) {
      const buf = await src.readRange(c.offset + 12, Math.min(c.size - 4, MAX_LIST_BYTES));
      leseInfo(buf, 0, buf.length, b.tags);
    } else if (c.id === 'LIST' && c.typ === 'movi') {
      moviGesehen = true;
      if (c.ueberlaenge) b.warnings.push({ code: 'datei_abgeschnitten', message: 'movi-Liste ragt ueber das Dateiende (Datei abgeschnitten).' });
    }
  }
  if (!hdrlGesehen) b.warnings.push({ code: 'hdrl_fehlt', message: 'Keine hdrl-Liste gefunden; Kopfdaten fehlen.' });
  b.duration_s = streamDauern.length > 0 ? rund(Math.max(...streamDauern)) : avih && avih.usec > 0 ? rund((avih.frames * avih.usec) / 1e6) : null;
  b.bit_rate = b.duration_s && b.duration_s > 0 ? Math.round((src.size * 8) / b.duration_s) : null;
  b.format_specific = {
    bit_rate_geschaetzt: b.bit_rate !== null,
    movi_vorhanden: moviGesehen,
    ...(avih ? { avih: { mikrosekunden_pro_frame: avih.usec, frames: avih.frames, breite: avih.breite, hoehe: avih.hoehe } } : {}),
  };
  return b;
}

/** Liest eine strl-Liste (strh + strf + optional strn) zu einem Stream. */
function leseStrl(buf: Buffer, von: number, bis: number, basis: number, listStart: number, index: number): { stream: StreamBefund; dauer: number | null } | null {
  let typ: string | null = null;
  let handler = '';
  let skala = 0;
  let rate = 0;
  let laenge = 0;
  let strf: Buffer | null = null;
  let name: string | null = null;
  for (const c of chunksImSpeicher(buf, von, bis)) {
    if (c.id === 'strh' && c.ende - c.datenStart >= 36) {
      typ = ascii4(buf, c.datenStart);
      handler = ascii4(buf, c.datenStart + 4);
      skala = buf.readUInt32LE(c.datenStart + 20);
      rate = buf.readUInt32LE(c.datenStart + 24);
      laenge = buf.readUInt32LE(c.datenStart + 32);
    } else if (c.id === 'strf') {
      strf = buf.subarray(c.datenStart, c.ende);
    } else if (c.id === 'strn') {
      const nul = buf.subarray(c.datenStart, c.ende).indexOf(0);
      name = kappeText(buf.subarray(c.datenStart, nul < 0 ? c.ende : c.datenStart + nul).toString('utf8'), 128) || null;
    }
  }
  if (!typ) return null;
  const range = { offset: basis + listStart, length: Math.max(0, bis - listStart) + 8 };
  const dauer = skala > 0 && rate > 0 ? rund((laenge * skala) / rate) : null;
  const fps = skala > 0 && rate > 0 ? rund(rate / skala, 3) : null;
  if (typ === 'vids') {
    let breite: number | null = null;
    let hoehe: number | null = null;
    let kompression = handler;
    if (strf && strf.length >= 20) {
      breite = strf.readInt32LE(4);
      hoehe = Math.abs(strf.readInt32LE(8));
      kompression = strf.readUInt32LE(16) === 0 ? 'raw ' : ascii4(strf, 16);
    }
    const kn = kompression.trim().toLowerCase();
    return {
      dauer,
      stream: {
        kind: 'video_stream',
        name,
        data: {
          index,
          codec_name: kn === 'raw' ? 'rawvideo' : (AVI_VIDEO_CODECS[kn] ?? (kn || null)),
          codec_tag: kompression.trim() || null,
          width: breite,
          height: hoehe,
          avg_frame_rate: fps,
          nb_frames: laenge,
          duration_s: dauer,
        },
        source_range: range,
      },
    };
  }
  if (typ === 'auds') {
    const f = strf ? leseWaveFormat(strf) : null;
    return {
      dauer,
      stream: {
        kind: 'audio_stream',
        name,
        data: {
          index,
          codec_name: f ? wavCodecName(f.tag, f.bits) : null,
          format_tag: f?.tag ?? null,
          sample_rate: f?.rate ?? null,
          channels: f?.kanaele ?? null,
          bits_per_sample: f?.bits || null,
          bit_rate: f && f.byterate > 0 ? f.byterate * 8 : null,
          duration_s: dauer,
        },
        source_range: range,
      },
    };
  }
  return {
    dauer: null,
    stream: { kind: typ === 'txts' ? 'subtitle_stream' : 'data_stream', name, data: { index, strh_typ: typ }, source_range: range },
  };
}
