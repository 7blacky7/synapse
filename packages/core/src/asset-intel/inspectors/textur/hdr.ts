/**
 * MODUL: Textur-Inspektor Radiance HDR (RGBE)
 * ZWECK: Kopfzeile '#?RADIANCE' bzw. '#?RGBE', Variablen (FORMAT=, EXPOSURE=, ...), Kommentare und die
 *        Aufloesungszeile (-Y h +X w) (P4-T64). Pixeldaten (RGBE, ggf. RLE) werden nie gelesen.
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector } from '../../types.js';
import { bildMetadata, kuerze, pruefeAbmessungen, sicher, warnung } from './util.js';

const ID = 'textur-hdr';
const VERSION = 1;
/** So viel vom Dateianfang wird fuer den Textkopf gelesen. */
const KOPF_MAX = 8192;
const ZEILE_MAX = 1024;

const ASCII = (s: string): number[] => [...s].map(c => c.charCodeAt(0));

export const hdrInspector: AssetInspector = {
  id: ID,
  formats: ['hdr'],
  extensions: ['.hdr', '.pic'],
  magic: [
    { offset: 0, bytes: ASCII('#?RADIANCE'), format: 'hdr' },
    { offset: 0, bytes: ASCII('#?RGBE'), format: 'hdr' },
  ],
  version: VERSION,
  async inspect(src, ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'hdr', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const buf = await src.readRange(0, Math.min(src.size, KOPF_MAX));
      const text = buf.toString('latin1');
      if (!text.startsWith('#?')) {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', "Radiance-Kopf '#?' fehlt (Endung passt nicht zum Inhalt).");
        return;
      }

      // Zeilen bis zur Leerzeile, danach die Aufloesungszeile.
      const programm = text.slice(2, text.indexOf('\n') >= 0 ? text.indexOf('\n') : text.length).trim();
      let pos = 0;
      let zeilenNr = 0;
      const variablen: Record<string, string> = {};
      const kommentare: string[] = [];
      let belichtung = 1;
      let belichtungsAnzahl = 0;
      let leerzeilePos = -1;
      while (pos < buf.length) {
        ctx.pruefeAbbruch();
        const nl = buf.indexOf(0x0a, pos);
        if (nl < 0) break;
        const zeile = buf.toString('latin1', pos, nl);
        zeilenNr++;
        pos = nl + 1;
        if (zeile.length > ZEILE_MAX) {
          warnung(res, 'kopfzeile_zu_lang', `Kopfzeile ${zeilenNr} ist ${zeile.length} Zeichen lang (> ${ZEILE_MAX}); vermutlich kein Textkopf.`);
          break;
        }
        if (zeile.trim() === '' && zeile.length === 0) {
          leerzeilePos = pos;
          break;
        }
        if (zeilenNr === 1) continue;
        if (zeile.startsWith('#')) {
          if (kommentare.length < 32) kommentare.push(kuerze(zeile.slice(1).trim(), 200));
          continue;
        }
        const eq = zeile.indexOf('=');
        if (eq > 0) {
          const k = zeile.slice(0, eq).trim();
          const v = zeile.slice(eq + 1).trim();
          variablen[k] = kuerze(v, 200);
          if (k === 'EXPOSURE') {
            const f = Number(v);
            if (Number.isFinite(f) && f > 0) {
              belichtung *= f;
              belichtungsAnzahl++;
            }
          }
        }
      }
      if (leerzeilePos < 0) {
        warnung(res, 'leerzeile_fehlt', buf.length < src.size ? `Keine Leerzeile nach dem Kopf in den ersten ${buf.length} Bytes.` : 'Keine Leerzeile nach dem Kopf (Datei abgeschnitten oder kein Radiance-Bild).');
        res.objects.push({ name: 'header', kind: 'header', data: { programm, variablen }, source_range: { offset: 0, length: buf.length } });
        return;
      }

      // Aufloesungszeile.
      const nl2 = buf.indexOf(0x0a, leerzeilePos);
      let aufloesung = '';
      let datenOffset = leerzeilePos;
      if (nl2 >= 0) {
        aufloesung = buf.toString('latin1', leerzeilePos, nl2).trim();
        datenOffset = nl2 + 1;
      } else {
        warnung(res, 'aufloesung_fehlt', 'Keine Aufloesungszeile nach der Leerzeile (Datei abgeschnitten).');
      }
      const m = /^([+-])([XY])\s+(\d+)\s+([+-])([XY])\s+(\d+)$/.exec(aufloesung);
      let breite: number | null = null;
      let hoehe: number | null = null;
      if (m && m[2] !== m[5]) {
        const n1 = Number(m[3]);
        const n2 = Number(m[6]);
        breite = m[2] === 'X' ? n1 : n2;
        hoehe = m[2] === 'Y' ? n1 : n2;
        if (m[2] !== 'Y' || m[1] !== '-' || m[4] !== '+') {
          warnung(res, 'orientierung_unueblich', `Aufloesungszeile "${aufloesung}" weicht von der Standardorientierung "-Y h +X w" ab.`, false);
        }
        pruefeAbmessungen(res, breite, hoehe);
      } else if (nl2 >= 0) {
        warnung(res, 'aufloesung_ungueltig', `Aufloesungszeile nicht lesbar: ${JSON.stringify(kuerze(aufloesung, 60))}.`);
      }

      const format = variablen['FORMAT'] ?? null;
      if (format === null) warnung(res, 'format_fehlt', 'Kein FORMAT=-Eintrag im Kopf.', false);
      else if (format !== '32-bit_rle_rgbe' && format !== '32-bit_rle_xyze') warnung(res, 'format_unbekannt', `FORMAT=${format} ist nicht 32-bit_rle_rgbe/xyze.`, false);
      const xyz = format === '32-bit_rle_xyze';

      res.objects.push({ name: 'header', kind: 'header', data: { programm, variablen, kommentare: kommentare.length }, source_range: { offset: 0, length: leerzeilePos } });
      if (nl2 >= 0) res.objects.push({ name: 'resolution', kind: 'resolution', data: { zeile: aufloesung, breite, hoehe }, source_range: { offset: leerzeilePos, length: nl2 + 1 - leerzeilePos } });

      res.metadata = bildMetadata(
        {
          kind: 'texture',
          width: breite,
          height: hoehe,
          has_alpha: false,
          channels: 3,
          bits_per_channel: 8,
          color_space: xyz ? 'CIE XYZ' : 'Radiance RGB (linear)',
          transfer: 'linear',
          format_name: xyz ? 'XYZE (8:8:8:8 shared exponent)' : 'RGBE (8:8:8:8 shared exponent)',
          fmt: { bw: 1, bh: 1, bits: 32 },
        },
        {
          belichtung: belichtungsAnzahl > 0 ? belichtung : null,
          rle: format !== null && format.includes('rle'),
          aufloesungszeile: aufloesung || null,
          programm,
        }
      );
      res.format_specific = {
        format,
        variablen,
        kommentare,
        aufloesungszeile: aufloesung,
        pixel_daten_offset: datenOffset,
        pixel_daten_bytes: Math.max(0, src.size - datenOffset),
      };
    });
    return res;
  },
};
