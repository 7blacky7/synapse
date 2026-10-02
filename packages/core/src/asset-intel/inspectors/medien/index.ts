/**
 * MODUL: Medien-Inspektoren (P4-T65, ASSET-6)
 * ZWECK: Audio (wav, ogg, flac, mp3) und Video/Container (mp4, mkv, avi).
 *
 * WEGE: primaer ffprobe (execFile, festes Argument-Array, siehe ffprobe.ts). Fehlt ffprobe oder scheitert
 *       es, liest ein Header-Parser in reinem TypeScript die Eckdaten; das Ergebnis hat dann Status
 *       'teilweise' und die Warnung 'ffprobe_nicht_verfuegbar' bzw. 'ffprobe_fehlgeschlagen'.
 *
 * MAGIC: RIFF-Formate werden NICHT ueber 'RIFF'@0 erkannt, sondern ueber den Formtyp ('WAVE'@8,
 *        'AVI '@8) — damit kollidiert nichts mit anderen RIFF-Formaten (WebP: 'WEBP'@8).
 *
 * NICHT registriert: weder asset-intel/index.ts noch die standardRegistry werden angefasst;
 * die Verdrahtung macht der Koordinator.
 */

import { AssetLimitError, AssetReadError } from '../../errors.js';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetMagic, AssetResult, AssetSource, AssetWarning } from '../../types.js';
import { MedienFormatFehler, baueErgebnis } from './gemeinsam.js';
import type { MedienBefund } from './gemeinsam.js';
import { ermittleFfprobePfad, starteFfprobe, uebersetzeFfprobe } from './ffprobe.js';
import { flacFallback, mp3Fallback, oggFallback } from './fallback-audio.js';
import { aviFallback, wavFallback } from './fallback-riff.js';
import { mkvFallback, mp4Fallback } from './fallback-container.js';

/** Optionen der Medien-Inspektoren. */
export interface MedienOptionen {
  /**
   * Pfad zu ffprobe. Nicht gesetzt: Umgebungsvariable SYNAPSE_FFPROBE_PATH, sonst 'ffprobe' aus dem PATH.
   * null: ffprobe nie verwenden (nur Header-Fallback). Ein nicht existierender Pfad prueft den Fallback-Zweig.
   */
  ffprobePfad?: string | null;
}

const ASCII = (s: string): number[] => [...s].map(c => c.charCodeAt(0));

const MAGIC_AUDIO: AssetMagic[] = [
  { offset: 8, bytes: ASCII('WAVE'), format: 'wav' },
  { offset: 0, bytes: ASCII('fLaC'), format: 'flac' },
  { offset: 0, bytes: ASCII('OggS'), format: 'ogg' },
  { offset: 0, bytes: ASCII('ID3'), format: 'mp3' },
  // MPEG-Audio-Frame-Sync, Layer III (MPEG-1, -2, -2.5; mit und ohne CRC)
  ...[0xfb, 0xfa, 0xf3, 0xf2, 0xe3, 0xe2].map((b): AssetMagic => ({ offset: 0, bytes: [0xff, b], format: 'mp3' })),
];

// MP4: 'ftyp' @4 allein trifft auch HEIF/AVIF (heic, mif1, avif), M4A, MOV ('qt  ') u. a. Darum nur 'ftyp' + bekannter
// Video-Brand (Major Brand @8). Andere Brands erkennt nur die Endung .mp4 (Warnung 'magic_fehlt').
const MP4_BRANDS = ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'M4VH', 'M4VP'];

const MAGIC_VIDEO: AssetMagic[] = [
  ...MP4_BRANDS.map((b): AssetMagic => ({ offset: 4, bytes: ASCII('ftyp' + b), format: 'mp4' })),
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], format: 'mkv' },
  { offset: 8, bytes: ASCII('AVI '), format: 'avi' },
];

/** Welches Format steckt laut ffprobe-Containername dahinter (null: nicht eines unserer sieben). */
function formatAusContainer(name: string): string | null {
  const teile = name.split(',').map(t => t.trim());
  if (teile.includes('wav')) return 'wav';
  if (teile.includes('flac')) return 'flac';
  if (teile.includes('ogg')) return 'ogg';
  if (teile.includes('mp3')) return 'mp3';
  if (teile.includes('avi')) return 'avi';
  if (teile.includes('mov') || teile.includes('mp4')) return 'mp4';
  if (teile.includes('matroska') || teile.includes('webm')) return 'mkv';
  return null;
}

function headerFallback(format: string, src: AssetSource, ctx: AssetContext): Promise<MedienBefund> {
  switch (format) {
    case 'wav': return wavFallback(src, ctx);
    case 'flac': return flacFallback(src, ctx);
    case 'ogg': return oggFallback(src, ctx);
    case 'mp3': return mp3Fallback(src, ctx);
    case 'mp4': return mp4Fallback(src, ctx);
    case 'mkv': return mkvFallback(src, ctx);
    case 'avi': return aviFallback(src, ctx);
    default: return Promise.reject(new MedienFormatFehler('format_unbekannt', `Kein Header-Parser fuer "${format}".`));
  }
}

/** Warnungen des Header-Parsers, die auch dann gelten, wenn ffprobe selbst nichts bemaengelt. */
const PRUEF_CODES = new Set(['datei_abgeschnitten', 'box_abgeschnitten', 'moov_abgeschnitten', 'id3_ueberschreitet_datei', 'werte_unplausibel']);

/**
 * Gegenpruefung nach erfolgreichem ffprobe: ffprobe meldet eine abgeschnittene Datei oder falsche
 * Laengenangaben oft NICHT. Der Header-Parser (liest nur Header) ergaenzt deshalb Warnungen und die
 * Byte-Positionen (source_range) der Streams. Schlaegt er fehl, bleibt ffprobe massgeblich.
 */
async function pruefeGegen(befund: MedienBefund, format: string, src: AssetSource, ctx: AssetContext): Promise<void> {
  let quer: MedienBefund;
  try {
    quer = await headerFallback(format, src, ctx);
  } catch (e) {
    // Nur die Zeitgrenze betrifft den ganzen Lauf; eine ueberschrittene Lesegrenze macht nur die Gegenpruefung unmoeglich.
    if (e instanceof AssetLimitError && e.grenze === 'timeoutMs') throw e;
    befund.format_specific.header_pruefung = 'nicht_lesbar';
    return;
  }
  let auffaellig = false;
  for (const w of quer.warnings) {
    if (PRUEF_CODES.has(w.code) && !befund.warnings.some(x => x.code === w.code)) {
      befund.warnings.push(w);
      auffaellig = true;
    }
  }
  // Streams gleicher Art nach Reihenfolge zuordnen; nur wenn die Codecs nicht widersprechen.
  const zaehler = new Map<string, number>();
  for (const s of befund.streams) {
    const n = zaehler.get(s.kind) ?? 0;
    zaehler.set(s.kind, n + 1);
    const q = quer.streams.filter(x => x.kind === s.kind)[n];
    const a = s.data.codec_name;
    const c = q?.data.codec_name;
    if (q?.source_range && !s.source_range && (a === undefined || c === undefined || a === c)) s.source_range = q.source_range;
  }
  befund.format_specific.header_pruefung = auffaellig ? 'auffaellig' : 'bestanden';
}

interface InspektorDef {
  id: string;
  typ: 'audio' | 'video';
  formate: string[];
  endungen: string[];
  magic: AssetMagic[];
  version: number;
}

async function inspiziere(src: AssetSource, ctx: AssetContext, opts: MedienOptionen, def: InspektorDef): Promise<AssetResult> {
  let format = (ctx.format ?? def.formate[0]).toLowerCase();
  const zusatz: AssetWarning[] = [];
  let befund: MedienBefund | null = null;
  let quelle: 'ffprobe' | 'header_fallback' = 'header_fallback';

  const ffprobePfad = ermittleFfprobePfad(opts.ffprobePfad);
  if (ffprobePfad === null) {
    zusatz.push({ code: 'ffprobe_nicht_verfuegbar', message: 'ffprobe ist abgeschaltet (ffprobePfad: null); es wurde nur der Header gelesen.' });
  } else {
    const r = await starteFfprobe(ffprobePfad, src.filePath, ctx);
    if (r.ok) {
      befund = uebersetzeFfprobe(r.json, ctx);
      if (befund) quelle = 'ffprobe';
      else zusatz.push({ code: 'ffprobe_fehlgeschlagen', message: 'ffprobe lieferte keine Streams/kein Format; es wurde nur der Header gelesen.' });
    } else {
      zusatz.push({ code: r.code, message: `${r.message} — es wurde nur der Header gelesen.` });
    }
  }

  if (befund) {
    const echt = formatAusContainer(befund.container);
    if (echt && echt !== format) {
      zusatz.push({ code: 'format_weicht_ab', message: `Erwartet "${format}", ffprobe erkennt den Container "${befund.container}" (${echt}); der Inhalt gilt.` });
      format = echt;
    }
    await pruefeGegen(befund, format, src, ctx);
  } else {
    try {
      befund = await headerFallback(format, src, ctx);
    } catch (e) {
      if (e instanceof AssetLimitError) throw e;
      const code = e instanceof MedienFormatFehler ? 'header_ungueltig' : e instanceof AssetReadError ? 'header_abgeschnitten' : 'header_nicht_lesbar';
      const w: AssetWarning[] = [...zusatz, { code, message: `Header als "${format}" nicht lesbar: ${(e as Error)?.message ?? String(e)}` }];
      return erzeugeAssetResult(src.filePath, src.size, {
        asset_type: def.typ,
        format,
        inspector: def.id,
        parser_version: def.version,
        status: 'fehler',
        metadata: { size_bytes: src.size },
        warnings: w,
        format_specific: { quelle: 'header_fallback' },
      });
    }
  }
  return baueErgebnis(src, ctx, befund, quelle, def.typ, format, def.version, def.id, zusatz);
}

const AUDIO_DEF: InspektorDef = {
  id: 'medien-audio',
  typ: 'audio',
  formate: ['wav', 'ogg', 'flac', 'mp3'],
  endungen: ['.wav', '.ogg', '.flac', '.mp3'],
  magic: MAGIC_AUDIO,
  version: 1,
};

const VIDEO_DEF: InspektorDef = {
  id: 'medien-video',
  typ: 'video',
  formate: ['mp4', 'mkv', 'avi'],
  endungen: ['.mp4', '.mkv', '.avi'],
  magic: MAGIC_VIDEO,
  version: 1,
};

/** Baut die beiden Inspektoren mit eigenen Optionen (Tests: ffprobePfad auf nicht Vorhandenes stellen). */
export function erzeugeMedienInspektoren(opts: MedienOptionen = {}): AssetInspector[] {
  return [AUDIO_DEF, VIDEO_DEF].map(def => ({
    id: def.id,
    formats: def.formate,
    extensions: def.endungen,
    magic: def.magic,
    version: def.version,
    inspect: (src: AssetSource, ctx: AssetContext) => inspiziere(src, ctx, opts, def),
  }));
}

/** Standard: ffprobe aus SYNAPSE_FFPROBE_PATH bzw. PATH, mit Header-Fallback. */
export const assetMedienInspektoren: AssetInspector[] = erzeugeMedienInspektoren();

export { baueFfprobeArgs, ermittleFfprobePfad } from './ffprobe.js';
