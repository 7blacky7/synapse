/**
 * MODUL: Medien-Inspektoren — ffprobe-Weg (primaer)
 * ZWECK: Startet ffprobe und uebersetzt dessen JSON ins Asset-Modell. Etablierte Werkzeuge statt
 *        eigener Container-Parser (Task-Vorgabe P4-T65).
 *
 * SICHERHEIT (einzige Ausnahme von der Prozess-Regel der Asset-Intel-Schicht):
 *  - child_process.execFile mit festem Argument-ARRAY, nie exec/Shell-String.
 *  - Der Pfad geht als 'file:'+absoluter Pfad hinein: das Praefix verhindert Protokolle
 *    (http:, concat:, pipe:, ...) und fuehrende '-' (Optionsinjektion) bei jedem Dateinamen.
 *  - -protocol_whitelist file und -format_whitelist: ffprobe erkennt Formate am INHALT; ohne
 *    Whitelist wuerde eine Textdatei namens x.mp4 mit 'ffconcat'-Inhalt den concat-Demuxer starten.
 *  - Timeout aus ctx.limits.timeoutMs, ctx.signal, maxBuffer begrenzt, stdin zu, minimale Umgebung.
 *  - ffprobe liest nur (kein Schreiben); es liest die Datei selbst, ZAEHLT also nicht gegen
 *    maxReadBytes. -probesize wird deshalb auf maxReadBytes (hoechstens 8 MiB) begrenzt.
 */

import { execFile } from 'child_process';
import * as path from 'path';
import type { AssetContext, AssetWarning } from '../../types.js';
import { kappeText, leererBefund, rund, setzeTag, zahl } from './gemeinsam.js';
import type { KapitelBefund, MedienBefund, StreamBefund } from './gemeinsam.js';

/** Hoechste ffprobe-Ausgabe, die wir annehmen (Bytes). */
const MAX_AUSGABE = 4 * 1024 * 1024;
/** Mehr Streams/Kapitel werden nicht uebersetzt (Schutz vor bösartigen Containern). */
const MAX_ELEMENTE = 1024;
/** Demuxer, die ffprobe fuer unsere Formate verwenden darf. */
const FORMAT_WHITELIST = 'wav,flac,ogg,mp3,mov,matroska,webm,avi';

/** Stream-Tags, die bei Ogg als Container-Tags gelten. */
const OGG_TAGS = new Set(['title', 'artist', 'album', 'encoder', 'creation_time', 'comment', 'genre', 'date', 'track', 'album_artist', 'composer']);

export type FfprobeAusgang =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; code: 'ffprobe_nicht_verfuegbar' | 'ffprobe_fehlgeschlagen'; message: string };

/** Welcher ffprobe gilt: Option, sonst Umgebungsvariable SYNAPSE_FFPROBE_PATH, sonst 'ffprobe' aus dem PATH. */
export function ermittleFfprobePfad(option: string | null | undefined): string | null {
  if (option === null) return null;
  if (typeof option === 'string' && option !== '') return option;
  const env = process.env.SYNAPSE_FFPROBE_PATH;
  return env && env.trim() !== '' ? env : 'ffprobe';
}

/** Baut das Argument-Array (exportiert, damit Tests die Sicherheitsmerkmale pruefen koennen). */
export function baueFfprobeArgs(dateiPfad: string, maxReadBytes: number): string[] {
  const probesize = Math.max(32 * 1024, Math.min(8 * 1024 * 1024, Math.floor(maxReadBytes)));
  return [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams', '-show_chapters',
    '-protocol_whitelist', 'file',
    '-format_whitelist', FORMAT_WHITELIST,
    '-probesize', String(probesize),
    '-analyzeduration', '5000000',
    '-i', 'file:' + path.resolve(dateiPfad),
  ];
}

/** Startet ffprobe. Wirft nie. */
export function starteFfprobe(ffprobePfad: string, dateiPfad: string, ctx: AssetContext): Promise<FfprobeAusgang> {
  return new Promise(resolve => {
    const nicht = (code: 'ffprobe_nicht_verfuegbar' | 'ffprobe_fehlgeschlagen', message: string): void =>
      resolve({ ok: false, code, message });
    try {
      // 60 % der Gesamtzeit: danach muss der Header-Fallback noch laufen koennen.
      const timeout = Math.max(1, Math.floor(ctx.limits.timeoutMs * 0.6));
      const child = execFile(
        ffprobePfad,
        baueFfprobeArgs(dateiPfad, ctx.limits.maxReadBytes),
        {
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: MAX_AUSGABE,
          encoding: 'utf8',
          windowsHide: true,
          signal: ctx.signal,
          env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C' },
        },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
            if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'ENOEXEC') {
              return nicht('ffprobe_nicht_verfuegbar', `ffprobe nicht startbar (${e.code}): ${kappeText(ffprobePfad, 200)}`);
            }
            if (e.code === 'ABORT_ERR' || e.name === 'AbortError') return nicht('ffprobe_fehlgeschlagen', 'ffprobe abgebrochen (Zeitgrenze des Laufs).');
            if (e.killed || e.signal) return nicht('ffprobe_fehlgeschlagen', `ffprobe nach ${timeout} ms beendet (Zeitgrenze).`);
            if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return nicht('ffprobe_fehlgeschlagen', `ffprobe-Ausgabe ueber ${MAX_AUSGABE} Bytes.`);
            const erste = kappeText(String(stderr ?? '').split('\n').find(z => z.trim() !== '') ?? '', 300);
            return nicht('ffprobe_fehlgeschlagen', `ffprobe Exit ${String(e.code ?? '?')}${erste ? ': ' + erste : ''}`);
          }
          try {
            const json = JSON.parse(String(stdout)) as unknown;
            if (!json || typeof json !== 'object' || Array.isArray(json)) return nicht('ffprobe_fehlgeschlagen', 'ffprobe-JSON ist kein Objekt.');
            resolve({ ok: true, json: json as Record<string, unknown> });
          } catch {
            nicht('ffprobe_fehlgeschlagen', 'ffprobe-Ausgabe ist kein gueltiges JSON.');
          }
        }
      );
      child.stdin?.end();
    } catch (e) {
      nicht('ffprobe_fehlgeschlagen', `ffprobe-Start warf: ${kappeText((e as Error)?.message ?? String(e), 200)}`);
    }
  });
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** '30000/1001' -> {wert, bruch}; '0/0' und Muell -> null. */
function bruchZahl(v: unknown): { wert: number; bruch: string } | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{1,12})\/(\d{1,12})$/.exec(v.trim());
  if (!m) return null;
  const z = Number(m[1]);
  const n = Number(m[2]);
  if (n === 0 || z === 0) return null;
  return { wert: rund(z / n, 3) as number, bruch: `${z}/${n}` };
}

function tagsAus(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, w] of Object.entries(obj(v))) setzeTag(out, k, w);
  return out;
}

function dispositionAus(v: unknown): string[] {
  return Object.entries(obj(v))
    .filter(([, w]) => w === 1)
    .map(([k]) => k)
    .slice(0, 32);
}

/** Nur gesetzte (nicht-null) Felder uebernehmen: kurze, lesbare data-Objekte. */
function ohneNull(d: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (v !== null && v !== undefined) o[k] = v;
  return o;
}

function uebersetzeStream(s: Record<string, unknown>, nr: number): StreamBefund {
  const typ = typeof s.codec_type === 'string' ? s.codec_type : '';
  const disposition = dispositionAus(s.disposition);
  const tags = tagsAus(s.tags);
  const titel = tags.title ?? null;
  let kind: StreamBefund['kind'] = 'data_stream';
  if (typ === 'audio') kind = 'audio_stream';
  else if (typ === 'video') kind = disposition.includes('attached_pic') ? 'attachment' : 'video_stream';
  else if (typ === 'subtitle') kind = 'subtitle_stream';
  else if (typ === 'attachment') kind = 'attachment';

  const index = zahl(s.index) ?? nr;
  const basis: Record<string, unknown> = {
    index,
    codec_name: typeof s.codec_name === 'string' ? kappeText(s.codec_name, 64) : null,
    profile: typeof s.profile === 'string' ? kappeText(s.profile, 64) : null,
    codec_tag: typeof s.codec_tag_string === 'string' && !s.codec_tag_string.startsWith('[') ? kappeText(s.codec_tag_string, 16) : null,
    bit_rate: zahl(s.bit_rate),
    duration_s: rund(zahl(s.duration)),
    nb_frames: zahl(s.nb_frames),
    language: tags.language ?? null,
    disposition: disposition.length > 0 ? disposition : null,
    tags: Object.keys(tags).length > 0 ? tags : null,
  };
  if (kind === 'audio_stream') {
    Object.assign(basis, {
      sample_rate: zahl(s.sample_rate),
      channels: zahl(s.channels),
      channel_layout: typeof s.channel_layout === 'string' ? kappeText(s.channel_layout, 64) : null,
      sample_fmt: typeof s.sample_fmt === 'string' ? kappeText(s.sample_fmt, 32) : null,
      bits_per_sample: zahl(s.bits_per_sample) || null,
      bits_per_raw_sample: zahl(s.bits_per_raw_sample),
    });
  } else if (kind === 'video_stream' || (kind === 'attachment' && typ === 'video')) {
    const avg = bruchZahl(s.avg_frame_rate);
    const r = bruchZahl(s.r_frame_rate);
    Object.assign(basis, {
      width: zahl(s.width),
      height: zahl(s.height),
      pix_fmt: typeof s.pix_fmt === 'string' ? kappeText(s.pix_fmt, 32) : null,
      avg_frame_rate: avg?.wert ?? null,
      avg_frame_rate_bruch: avg?.bruch ?? null,
      r_frame_rate: r?.wert ?? null,
      r_frame_rate_bruch: r?.bruch ?? null,
      color_space: typeof s.color_space === 'string' ? kappeText(s.color_space, 32) : null,
      color_range: typeof s.color_range === 'string' ? kappeText(s.color_range, 32) : null,
      color_transfer: typeof s.color_transfer === 'string' ? kappeText(s.color_transfer, 32) : null,
      color_primaries: typeof s.color_primaries === 'string' ? kappeText(s.color_primaries, 32) : null,
      field_order: typeof s.field_order === 'string' ? kappeText(s.field_order, 32) : null,
    });
  }
  return { kind, name: titel, data: ohneNull(basis) };
}

/**
 * Uebersetzt ffprobe-JSON ins Modell. null, wenn nichts Brauchbares drinsteht (kein format-Block
 * und keine Streams) — der Aufrufer behandelt das wie einen Fehlschlag und nutzt den Fallback.
 */
export function uebersetzeFfprobe(json: Record<string, unknown>, ctx: AssetContext): MedienBefund | null {
  const format = obj(json.format);
  const streamsRoh = Array.isArray(json.streams) ? json.streams : [];
  if (streamsRoh.length === 0 || typeof format.format_name !== 'string') return null;

  const b = leererBefund(kappeText(format.format_name, 128));
  b.duration_s = rund(zahl(format.duration));
  b.bit_rate = zahl(format.bit_rate);
  b.tags = tagsAus(format.tags);
  if (b.container.split(',').includes('ogg')) {
    // Ogg traegt die Kommentare im Stream, nicht im Format-Block.
    for (const s of streamsRoh.slice(0, 4)) {
      for (const [k, v] of Object.entries(tagsAus(obj(s).tags))) if (OGG_TAGS.has(k) && !(k in b.tags)) setzeTag(b.tags, k, v);
    }
  }

  let nr = 0;
  for (const s of streamsRoh) {
    if (nr >= MAX_ELEMENTE) {
      b.warnings.push({ code: 'streams_gekappt', message: `Mehr als ${MAX_ELEMENTE} Streams; der Rest wurde nicht uebersetzt.` });
      break;
    }
    ctx.pruefeAbbruch();
    b.streams.push(uebersetzeStream(obj(s), nr));
    nr++;
  }

  const kapitelRoh = Array.isArray(json.chapters) ? json.chapters : [];
  let kn = 0;
  for (const k of kapitelRoh) {
    if (kn >= MAX_ELEMENTE) {
      b.warnings.push({ code: 'kapitel_gekappt', message: `Mehr als ${MAX_ELEMENTE} Kapitel; der Rest wurde nicht uebersetzt.` });
      break;
    }
    ctx.pruefeAbbruch();
    const ko = obj(k);
    const tags = tagsAus(ko.tags);
    const kapitel: KapitelBefund = {
      name: tags.title ?? null,
      data: ohneNull({
        id: zahl(ko.id),
        start_s: rund(zahl(ko.start_time)),
        end_s: rund(zahl(ko.end_time)),
      }),
    };
    b.chapters.push(kapitel);
    kn++;
  }

  const fs: Record<string, unknown> = {
    format_long_name: typeof format.format_long_name === 'string' ? kappeText(format.format_long_name, 128) : null,
    probe_score: zahl(format.probe_score),
    nb_streams: zahl(format.nb_streams),
    nb_programs: zahl(format.nb_programs),
    start_time_s: rund(zahl(format.start_time)),
    ffprobe_size_bytes: zahl(format.size),
  };
  b.format_specific = ohneNull(fs);
  return b;
}

export type { AssetWarning };
