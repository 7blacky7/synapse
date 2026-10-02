/**
 * MODUL: Medien-Inspektoren — gemeinsame Typen und Helfer
 * ZWECK: Einheitlicher Zwischenbefund (MedienBefund), den sowohl der ffprobe-Weg als auch die
 *        reinen TS-Header-Parser liefern. Daraus entsteht an EINER Stelle das AssetResult —
 *        so unterscheiden sich beide Wege nur in der Genauigkeit, nicht im Ausgabemodell.
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetObject, AssetResult, AssetSource, AssetSourceRange, AssetWarning } from '../../types.js';

/** Art eines Stream-Objekts im Ergebnis. */
export type StreamArt = 'audio_stream' | 'video_stream' | 'subtitle_stream' | 'data_stream' | 'attachment';

/** Ein Stream des Containers. */
export interface StreamBefund {
  kind: StreamArt;
  name: string | null;
  data: Record<string, unknown>;
  /** Nur gesetzt, wenn der Stream einen zusammenhaengenden Bytebereich hat (Header-Parser). */
  source_range?: AssetSourceRange;
}

/** Ein Kapitel des Containers. */
export interface KapitelBefund {
  name: string | null;
  data: Record<string, unknown>;
}

/** Zwischenbefund eines Mediencontainers. */
export interface MedienBefund {
  /** Containername, bei ffprobe format_name (z. B. 'mov,mp4,m4a,3gp,3g2,mj2'), sonst z. B. 'wav'. */
  container: string;
  /** Gesamtdauer in Sekunden; null wenn unbekannt. */
  duration_s: number | null;
  /** Gesamt-Bitrate in Bit/s; null wenn unbekannt. */
  bit_rate: number | null;
  /** Container-Tags (Schluessel klein), Laenge und Anzahl begrenzt. */
  tags: Record<string, string>;
  streams: StreamBefund[];
  chapters: KapitelBefund[];
  warnings: AssetWarning[];
  format_specific: Record<string, unknown>;
}

/** Ein Format ist erkannt, aber nicht lesbar (falsche Signatur, Pflichtteil fehlt). */
export class MedienFormatFehler extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'MedienFormatFehler';
  }
}

export const MAX_TAGS = 64;
export const MAX_TEXT = 512;

export function leererBefund(container: string): MedienBefund {
  return { container, duration_s: null, bit_rate: null, tags: {}, streams: [], chapters: [], warnings: [], format_specific: {} };
}

/** Steuerzeichen raus, Laenge kappen — Container-Texte sind Fremdeingaben. */
export function kappeText(s: unknown, max = MAX_TEXT): string {
  const t = typeof s === 'string' ? s : String(s ?? '');
  // eslint-disable-next-line no-control-regex
  const sauber = t.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return sauber.length > max ? sauber.slice(0, max) : sauber;
}

/** Setzt ein Tag (Schluessel klein), wenn noch Platz ist und der Wert nicht leer ist. */
export function setzeTag(tags: Record<string, string>, key: string, wert: unknown): void {
  const k = kappeText(key, 64).toLowerCase();
  const v = kappeText(wert);
  if (!k || !v) return;
  if (!(k in tags) && Object.keys(tags).length >= MAX_TAGS) return;
  tags[k] = v;
}

/** Endliche Zahl oder null. */
export function zahl(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && v !== 'N/A') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Auf n Nachkommastellen runden (Dauern sollen stabil und lesbar sein). */
export function rund(x: number | null, n = 6): number | null {
  if (x === null) return null;
  const f = 10 ** n;
  return Math.round(x * f) / f;
}

/** Vier Bytes ab off als ASCII (Nicht-Druckbares wird '.'). */
export function ascii4(b: Uint8Array, off: number): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    const c = b[off + i];
    s += c !== undefined && c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.';
  }
  return s;
}

/** Zusammenfassung der Hauptstreams fuer metadata (erster Audio-/Video-Stream). */
export function fasseZusammen(streams: StreamBefund[]): Record<string, unknown> {
  const a = streams.find(s => s.kind === 'audio_stream');
  const v = streams.find(s => s.kind === 'video_stream');
  const m: Record<string, unknown> = {};
  if (a) {
    m.audio_codec = a.data.codec_name ?? null;
    m.sample_rate = a.data.sample_rate ?? null;
    m.channels = a.data.channels ?? null;
  }
  if (v) {
    m.video_codec = v.data.codec_name ?? null;
    m.width = v.data.width ?? null;
    m.height = v.data.height ?? null;
    m.frame_rate = v.data.avg_frame_rate ?? v.data.r_frame_rate ?? null;
  }
  return m;
}

/**
 * Baut aus dem Zwischenbefund das AssetResult.
 * @param quelle 'ffprobe' (ok) oder 'header_fallback' (immer 'teilweise').
 * @param vorgabeTyp 'audio' | 'video', falls die Streams nichts Eindeutigeres hergeben.
 */
export function baueErgebnis(
  src: AssetSource,
  ctx: AssetContext,
  befund: MedienBefund,
  quelle: 'ffprobe' | 'header_fallback',
  vorgabeTyp: 'audio' | 'video',
  format: string,
  version: number,
  inspektorId: string,
  zusatzWarnungen: AssetWarning[]
): AssetResult {
  const warnings = [...zusatzWarnungen, ...befund.warnings];
  const objects: AssetObject[] = [];
  let gekappt = false;
  for (const s of befund.streams) {
    if (objects.length >= ctx.limits.maxObjects) {
      gekappt = true;
      break;
    }
    const o: AssetObject = { name: s.name, kind: s.kind, data: s.data };
    if (s.source_range) o.source_range = s.source_range;
    objects.push(o);
  }
  for (const k of befund.chapters) {
    if (objects.length >= ctx.limits.maxObjects) {
      gekappt = true;
      break;
    }
    objects.push({ name: k.name, kind: 'chapter', data: k.data });
  }
  if (gekappt) {
    warnings.push({ code: 'objekte_gekappt', message: `Mehr als ${ctx.limits.maxObjects} Streams/Kapitel; der Rest wurde nicht uebernommen.` });
  }
  const hatVideo = befund.streams.some(s => s.kind === 'video_stream');
  const hatAudio = befund.streams.some(s => s.kind === 'audio_stream');
  const assetType = hatVideo ? 'video' : hatAudio ? 'audio' : vorgabeTyp;
  // Jede Warnung ausser der reinen Formatkorrektur macht das Ergebnis 'teilweise'.
  const ok = quelle === 'ffprobe' && !gekappt && warnings.every(w => w.code === 'format_weicht_ab');
  return erzeugeAssetResult(src.filePath, src.size, {
    asset_type: assetType,
    format,
    inspector: inspektorId,
    parser_version: version,
    status: ok ? 'ok' : 'teilweise',
    metadata: {
      container: befund.container,
      duration_s: befund.duration_s,
      bit_rate: befund.bit_rate,
      size_bytes: src.size,
      stream_count: befund.streams.length,
      chapter_count: befund.chapters.length,
      tags: befund.tags,
      ...fasseZusammen(befund.streams),
    },
    objects,
    warnings,
    format_specific: { quelle, ...befund.format_specific },
  });
}
