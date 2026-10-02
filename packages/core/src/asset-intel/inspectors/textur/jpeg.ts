/**
 * MODUL: Textur-Inspektor JPEG
 * ZWECK: Marker-Durchlauf (SOI, APPn, DQT, SOFn, DHT, DRI, COM) bis zum ersten SOS (P4-T64).
 *        Abmessungen/Praezision/Komponenten/progressiv aus SOFn, JFIF-Dichte, Exif (nur Orientation
 *        und Vorhandensein), ICC-Profil (Vorhandensein, Groesse, Farbraum, Name), XMP-Flag, Kommentar.
 *
 * Bei SOS wird gestoppt: Entropiecodierte Daten werden nie gelesen oder dekodiert.
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector } from '../../types.js';
import { Lesefenster, bildMetadata, kuerze, pruefeAbmessungen, sicher, warnung } from './util.js';

const ID = 'textur-jpeg';
const VERSION = 1;

const SOF_NAMEN: Record<number, string> = {
  0xc0: 'baseline_dct',
  0xc1: 'extended_sequential_dct',
  0xc2: 'progressive_dct',
  0xc3: 'lossless',
  0xc5: 'differential_sequential_dct',
  0xc6: 'differential_progressive_dct',
  0xc7: 'differential_lossless',
  0xc9: 'extended_sequential_arithmetic',
  0xca: 'progressive_arithmetic',
  0xcb: 'lossless_arithmetic',
  0xcd: 'differential_sequential_arithmetic',
  0xce: 'differential_progressive_arithmetic',
  0xcf: 'differential_lossless_arithmetic',
};
const PROGRESSIV = new Set([0xc2, 0xc6, 0xca, 0xce]);

/** Exif-Orientation (Tag 0x0112) aus dem TIFF-Teil; null, wenn nicht lesbar/vorhanden. */
function exifOrientation(t: Buffer): number | null {
  if (t.length < 8) return null;
  const le = t[0] === 0x49 && t[1] === 0x49;
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
  const u16 = (o: number): number => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number): number => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > t.length) return null;
  const n = Math.min(u16(ifd), 256);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > t.length) break;
    if (u16(e) === 0x0112) return u16(e + 8);
  }
  return null;
}

/** Beschreibungstext aus einem ICC-Profil (v2 'desc' oder v4 'mluc'); null, wenn nicht auffindbar. */
function iccBeschreibung(p: Buffer): string | null {
  if (p.length < 132) return null;
  const n = Math.min(p.readUInt32BE(128), 64);
  for (let i = 0; i < n; i++) {
    const e = 132 + i * 12;
    if (e + 12 > p.length) return null;
    if (p.toString('latin1', e, e + 4) !== 'desc') continue;
    const off = p.readUInt32BE(e + 4);
    const sz = p.readUInt32BE(e + 8);
    if (sz < 12 || off + sz > p.length) return null;
    const typ = p.toString('latin1', off, off + 4);
    if (typ === 'desc') {
      const cnt = Math.min(p.readUInt32BE(off + 8), sz - 12);
      return kuerze(p.toString('latin1', off + 12, off + 12 + cnt).replace(/\0+$/, ''), 128);
    }
    if (typ === 'mluc' && sz >= 28 && p.readUInt32BE(off + 8) >= 1) {
      const rlen = p.readUInt32BE(off + 20);
      const roff = p.readUInt32BE(off + 24);
      if (roff + rlen > sz) return null;
      const roh = Buffer.from(p.subarray(off + roff, off + roff + (rlen & ~1)));
      return kuerze(roh.swap16().toString('utf16le').replace(/\0+$/, ''), 128);
    }
    return null;
  }
  return null;
}

function markerName(m: number): string {
  if (m >= 0xe0 && m <= 0xef) return 'APP' + (m - 0xe0);
  if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return 'SOF' + (m - 0xc0);
  const fest: Record<number, string> = { 0xc4: 'DHT', 0xdb: 'DQT', 0xda: 'SOS', 0xdd: 'DRI', 0xfe: 'COM', 0xdc: 'DNL', 0xc8: 'JPG', 0xcc: 'DAC' };
  return fest[m] ?? 'MARKER_' + m.toString(16).toUpperCase();
}

export const jpegInspector: AssetInspector = {
  id: ID,
  formats: ['jpeg'],
  extensions: ['.jpg', '.jpeg', '.jpe', '.jfif'],
  magic: [{ offset: 0, bytes: [0xff, 0xd8, 0xff], format: 'jpeg' }],
  version: VERSION,
  async inspect(src, ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'jpeg', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const win = new Lesefenster(src);
      const kopf = await win.lese(0, 2);
      if (kopf.length < 2 || kopf[0] !== 0xff || kopf[1] !== 0xd8) {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', 'JPEG-SOI (FF D8) fehlt (Endung passt nicht zum Inhalt).');
        return;
      }

      let pos = 2;
      let sof: { marker: number; precision: number; height: number; width: number; komponenten: Array<{ id: number; h: number; v: number; tq: number }> } | null = null;
      let jfif: Record<string, unknown> | null = null;
      let exif: { vorhanden: boolean; orientation: number | null } | null = null;
      let xmp = false;
      let adobeTransform: number | null = null;
      let icc: { chunks: number; groesse: number | null; farbraum: string | null; klasse: string | null; version: string | null; name: string | null } | null = null;
      const kommentare: string[] = [];
      let dqt = 0;
      let dht = 0;
      let dri: number | null = null;
      let sos = false;
      let eoi = false;
      const markerListe: string[] = [];

      for (;;) {
        ctx.pruefeAbbruch();
        const b = await win.lese(pos, 2);
        if (b.length < 2) {
          warnung(res, 'abgeschnitten', `Datei endet bei Offset ${pos} vor dem ersten SOS.`);
          break;
        }
        if (b[0] !== 0xff) {
          warnung(res, 'marker_erwartet', `An Offset ${pos} steht ${b[0].toString(16)} statt eines Markers (FF).`);
          break;
        }
        const m = b[1];
        if (m === 0xff) {
          pos += 1; // Fuellbyte
          continue;
        }
        if (m === 0x00) {
          warnung(res, 'marker_ungueltig', `Ungueltiger Marker FF00 an Offset ${pos}.`);
          break;
        }
        const mpos = pos;
        pos += 2;
        if (m === 0xd9) {
          eoi = true;
          break;
        }
        if (m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) continue; // ohne Laenge

        const lb = await win.lese(pos, 2);
        if (lb.length < 2) {
          warnung(res, 'abgeschnitten', `Segmentlaenge von ${markerName(m)} bei Offset ${mpos} fehlt.`);
          break;
        }
        const len = lb.readUInt16BE(0);
        if (len < 2) {
          warnung(res, 'segmentlaenge_ungueltig', `Segment ${markerName(m)} bei Offset ${mpos} hat Laenge ${len}.`);
          break;
        }
        const verfuegbar = Math.max(0, src.size - (pos + 2));
        const lesen = Math.min(len - 2, verfuegbar);
        const abgeschnitten = lesen < len - 2;
        const d = lesen > 0 ? await src.readRange(pos + 2, lesen) : Buffer.alloc(0);
        if (abgeschnitten) warnung(res, 'segment_abgeschnitten', `Segment ${markerName(m)} bei Offset ${mpos} ist ${len - 2} Bytes lang, die Datei hat nur ${lesen}.`);

        const name = markerName(m);
        const info: Record<string, unknown> = { length: len };
        const istSof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
        if (istSof) {
          if (d.length >= 6) {
            const n = d[5];
            const komponenten: Array<{ id: number; h: number; v: number; tq: number }> = [];
            for (let i = 0; i < n && 6 + i * 3 + 3 <= d.length; i++) {
              komponenten.push({ id: d[6 + i * 3], h: d[7 + i * 3] >> 4, v: d[7 + i * 3] & 15, tq: d[8 + i * 3] });
            }
            if (komponenten.length < n) warnung(res, 'sof_unvollstaendig', `SOF nennt ${n} Komponenten, gelesen ${komponenten.length}.`);
            if (sof) warnung(res, 'mehrere_sof', 'Mehr als ein SOF-Segment; das erste gilt.', false);
            else sof = { marker: m, precision: d[0], height: d.readUInt16BE(1), width: d.readUInt16BE(3), komponenten };
            Object.assign(info, { encoding: SOF_NAMEN[m] ?? name, precision: d[0], height: d.readUInt16BE(1), width: d.readUInt16BE(3), komponenten: n });
          } else warnung(res, 'sof_zu_kurz', `SOF hat nur ${d.length} Bytes.`);
        } else if (m === 0xe0 && d.length >= 14 && d.toString('latin1', 0, 5) === 'JFIF\0') {
          const einheit = d[7];
          const xd = d.readUInt16BE(8);
          const yd = d.readUInt16BE(10);
          jfif = { version: `${d[5]}.${String(d[6]).padStart(2, '0')}`, dichte_einheit: einheit === 1 ? 'dpi' : einheit === 2 ? 'dpcm' : 'seitenverhaeltnis', dichte_x: xd, dichte_y: yd, vorschau: [d[12], d[13]] };
          if (einheit === 1) Object.assign(jfif, { dpi_x: xd, dpi_y: yd });
          else if (einheit === 2) Object.assign(jfif, { dpi_x: Math.round(xd * 2.54 * 100) / 100, dpi_y: Math.round(yd * 2.54 * 100) / 100 });
          Object.assign(info, { typ: 'JFIF', ...jfif });
        } else if (m === 0xe0 && d.toString('latin1', 0, 5) === 'JFXX\0') {
          info.typ = 'JFXX';
        } else if (m === 0xe1 && d.toString('latin1', 0, 6) === 'Exif\0\0') {
          exif = { vorhanden: true, orientation: exifOrientation(d.subarray(6)) };
          Object.assign(info, { typ: 'Exif', orientation: exif.orientation });
        } else if (m === 0xe1 && d.toString('latin1', 0, 29) === 'http://ns.adobe.com/xap/1.0/\0') {
          xmp = true;
          info.typ = 'XMP';
        } else if (m === 0xe2 && d.length >= 14 && d.toString('latin1', 0, 12) === 'ICC_PROFILE\0') {
          const profil = d.subarray(14);
          if (!icc) icc = { chunks: 0, groesse: null, farbraum: null, klasse: null, version: null, name: null };
          icc.chunks++;
          if (d[12] === 1 && profil.length >= 40) {
            icc.groesse = profil.readUInt32BE(0);
            icc.version = `${profil[8]}.${profil[9] >> 4}`;
            icc.klasse = profil.toString('latin1', 12, 16);
            icc.farbraum = profil.toString('latin1', 16, 20);
            icc.name = iccBeschreibung(profil);
          }
          Object.assign(info, { typ: 'ICC_PROFILE', teil: `${d[12]}/${d[13]}` });
        } else if (m === 0xee && d.length >= 12 && d.toString('latin1', 0, 5) === 'Adobe') {
          adobeTransform = d[11];
          Object.assign(info, { typ: 'Adobe', transform: adobeTransform });
        } else if (m === 0xfe) {
          const t = kuerze(d.toString('utf8'));
          if (kommentare.length < 16) kommentare.push(t);
          info.text = t;
        } else if (m === 0xdb) {
          let p = 0;
          const tabellen: Array<{ id: number; praezision: number }> = [];
          while (p < d.length && tabellen.length < 8) {
            const pq = d[p] >> 4;
            tabellen.push({ id: d[p] & 15, praezision: pq ? 16 : 8 });
            p += 1 + (pq ? 128 : 64);
          }
          dqt += tabellen.length;
          info.tabellen = tabellen;
        } else if (m === 0xc4) {
          let p = 0;
          let n = 0;
          while (p + 17 <= d.length && n < 16) {
            let symbole = 0;
            for (let i = 1; i <= 16; i++) symbole += d[p + i];
            p += 17 + symbole;
            n++;
          }
          dht += n;
          info.tabellen = n;
        } else if (m === 0xdd && d.length >= 2) {
          dri = d.readUInt16BE(0);
          info.restart_intervall = dri;
        } else if (m === 0xda) {
          sos = true;
          info.komponenten = d[0] ?? null;
        }

        if (res.objects.length < ctx.limits.maxObjects) {
          res.objects.push({ name, kind: 'marker', data: info, source_range: { offset: mpos, length: Math.min(2 + len, src.size - mpos) } });
        } else if (!markerListe.includes('gekappt')) {
          markerListe.push('gekappt');
          warnung(res, 'marker_liste_gekappt', `Mehr als ${ctx.limits.maxObjects} Marker; Liste gekappt.`);
        }
        if (!markerListe.includes(name)) markerListe.push(name);

        if (sos || abgeschnitten) break;
        pos += len;
      }

      if (!sof) {
        res.status = 'fehler';
        warnung(res, 'sof_fehlt', 'Kein SOF-Segment vor SOS/Dateiende: Abmessungen unbekannt.');
        return;
      }
      if (!sos && !eoi) warnung(res, 'sos_fehlt', 'Kein SOS-Marker gefunden (Datei abgeschnitten oder defekt).', false);
      if (sof.width === 0 || sof.height === 0) {
        warnung(res, 'abmessung_null_oder_dnl', `SOF meldet ${sof.width}x${sof.height}; Hoehe 0 bedeutet "per DNL-Marker nach dem Scan" (nicht ausgewertet).`);
      } else pruefeAbmessungen(res, sof.width, sof.height);
      if (sof.precision !== 8 && sof.precision !== 12 && sof.precision !== 16 && sof.precision !== 2 && !(sof.precision >= 2 && sof.precision <= 16)) {
        warnung(res, 'praezision_ungueltig', `Abtastpraezision ${sof.precision} ausserhalb 2..16.`);
      }

      const n = sof.komponenten.length;
      const c0 = sof.komponenten[0];
      let chroma: string | null = null;
      if (n === 3 && c0 && sof.komponenten.slice(1).every(c => c.h === 1 && c.v === 1)) {
        const k = `${c0.h}x${c0.v}`;
        chroma = k === '1x1' ? '4:4:4' : k === '2x1' ? '4:2:2' : k === '2x2' ? '4:2:0' : k === '1x2' ? '4:4:0' : k === '4x1' ? '4:1:1' : `h${c0.h}v${c0.v}`;
      }
      let farbraum: string | null = null;
      if (n === 1) farbraum = 'Graustufen';
      else if (n === 3) farbraum = adobeTransform === 0 ? 'RGB' : 'YCbCr';
      else if (n === 4) farbraum = adobeTransform === 2 ? 'YCCK' : 'CMYK';
      const progressiv = PROGRESSIV.has(sof.marker);

      res.metadata = bildMetadata(
        {
          kind: 'image',
          width: sof.width,
          height: sof.height,
          has_alpha: false,
          channels: n,
          bits_per_channel: sof.precision,
          color_space: icc?.farbraum ? `${farbraum} (ICC ${icc.farbraum.trim()})` : farbraum,
          format_name: `JPEG ${progressiv ? 'progressiv' : SOF_NAMEN[sof.marker] === 'baseline_dct' ? 'baseline' : (SOF_NAMEN[sof.marker] ?? 'unbekannt')}`,
          fmt: n > 0 ? { bw: 1, bh: 1, bits: n * sof.precision } : null,
        },
        {
          progressive: progressiv,
          encoding: SOF_NAMEN[sof.marker] ?? `SOF${sof.marker - 0xc0}`,
          chroma_subsampling: chroma,
          dpi_x: (jfif?.dpi_x as number | undefined) ?? null,
          dpi_y: (jfif?.dpi_y as number | undefined) ?? null,
          hat_exif: exif !== null,
          exif_orientation: exif?.orientation ?? null,
          hat_icc_profil: icc !== null,
          icc_profil: icc?.name ?? null,
          hat_xmp: xmp,
          kommentar: kommentare.length > 0 ? kommentare[0] : null,
        }
      );
      res.format_specific = {
        sof_marker: `0xFF${sof.marker.toString(16).toUpperCase()}`,
        komponenten: sof.komponenten,
        jfif,
        exif,
        icc,
        adobe_transform: adobeTransform,
        dqt_tabellen: dqt,
        dht_tabellen: dht,
        restart_intervall: dri,
        kommentare,
        marker: markerListe.filter(x => x !== 'gekappt'),
        scan_gestoppt_bei_sos: sos,
      };
    });
    return res;
  },
};
