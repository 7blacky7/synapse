/**
 * MODUL: Textur-Inspektor PNG
 * ZWECK: Chunk-Liste (source_range je Chunk), IHDR, PLTE, tRNS, gAMA/sRGB/iCCP/cHRM/cICP, pHYs,
 *        APNG (acTL/fcTL), Text-Chunks (tEXt/iTXt/zTXt, Werte gekappt), eXIf, tIME und CRC-Pruefung (P4-T64).
 *
 * Pixeldaten (IDAT) werden nie dekodiert. Aufeinanderfolgende IDAT-Chunks erscheinen als EIN
 * Objekt mit Zaehler und dem Gesamtbereich. CRC-Fehler sind Warnungen, kein Abbruch; Chunks ueber
 * 256 KiB (typisch IDAT) werden nicht gelesen und deshalb nicht auf CRC geprueft (crc.uebersprungen).
 */

import { inflateSync } from 'node:zlib';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector, AssetObject } from '../../types.js';
import { Lesefenster, bildMetadata, crc32, hex32, kuerze, pruefeAbmessungen, sicher, warnung } from './util.js';

const ID = 'textur-png';
const VERSION = 1;
const SIGNATUR = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Chunks bis zu dieser Groesse werden komplett gelesen und per CRC geprueft. */
const CRC_MAX = 256 * 1024;
/** So viel von groesseren Chunks wird fuer die Auswertung hoechstens gelesen. */
const PARSE_MAX = 64 * 1024;
const TEXT_EINTRAEGE_MAX = 64;

const FARBTYP: Record<number, { name: string; kurz: string; kanaele: number; tiefen: number[] }> = {
  0: { name: 'Graustufen', kurz: 'Gray', kanaele: 1, tiefen: [1, 2, 4, 8, 16] },
  2: { name: 'RGB', kurz: 'RGB', kanaele: 3, tiefen: [8, 16] },
  3: { name: 'Palette', kurz: 'Palette', kanaele: 1, tiefen: [1, 2, 4, 8] },
  4: { name: 'Graustufen+Alpha', kurz: 'GrayAlpha', kanaele: 2, tiefen: [8, 16] },
  6: { name: 'RGBA', kurz: 'RGBA', kanaele: 4, tiefen: [8, 16] },
};

const RENDERING_INTENT = ['perzeptuell', 'relativ_farbmetrisch', 'saettigung', 'absolut_farbmetrisch'];

/** Liest einen mit 0 abgeschlossenen Latin-1-Schluessel; null, wenn nicht abgeschlossen oder zu lang. */
function schluessel(d: Buffer, max = 80): { text: string; ende: number } | null {
  const nul = d.indexOf(0);
  if (nul < 0 || nul > max) return null;
  return { text: d.toString('latin1', 0, nul), ende: nul + 1 };
}

/** Entpackt zlib-Text mit hartem Deckel (Zip-Bomben); liefert Text oder einen Platzhalter. */
function entpacke(daten: Buffer, utf8: boolean): string {
  try {
    const roh = inflateSync(daten, { maxOutputLength: 4096 });
    return kuerze(roh.toString(utf8 ? 'utf8' : 'latin1'));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ? '(komprimiert, ueber 4096 Bytes)' : '(nicht dekomprimierbar)';
  }
}

export const pngInspector: AssetInspector = {
  id: ID,
  formats: ['png'],
  extensions: ['.png', '.apng'],
  magic: [{ offset: 0, bytes: SIGNATUR, format: 'png' }],
  version: VERSION,
  async inspect(src, ctx) {
    const res = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: 'png', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const win = new Lesefenster(src);
      const sig = await win.lese(0, 8);
      if (sig.length < 8 || !SIGNATUR.every((b, i) => sig[i] === b)) {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', 'PNG-Signatur fehlt oder ist falsch (Endung passt nicht zum Inhalt).');
        return;
      }

      let pos = 8;
      let ihdr: { width: number; height: number; bitDepth: number; colorType: number; compression: number; filter: number; interlace: number } | null = null;
      const fs: Record<string, unknown> = {};
      const texte: Array<Record<string, unknown>> = [];
      const typen: string[] = [];
      let erstes = true;
      let iend = false;
      let idatAnzahl = 0;
      let idatBytes = 0;
      let fcTL = 0;
      let actl: { frames: number; plays: number } | null = null;
      let trns = false;
      let plte: number | null = null;
      let srgb: number | null = null;
      let gama: number | null = null;
      let iccpName: string | null = null;
      let exif = false;
      let phys: { x: number; y: number; einheit: number } | null = null;
      const crc = { geprueft: 0, fehlerhaft: 0, uebersprungen: 0 };
      let idatObj: AssetObject | null = null;
      let idatEnde = -1;
      let gekappt = false;

      while (pos < src.size) {
        ctx.pruefeAbbruch();
        const h = await win.lese(pos, 8);
        if (h.length < 8) {
          warnung(res, 'abgeschnitten', `Chunk-Kopf bei Offset ${pos} unvollstaendig (${h.length} von 8 Bytes).`);
          break;
        }
        const len = h.readUInt32BE(0);
        const typ = h.toString('latin1', 4, 8);
        if (len > 0x7fffffff || !/^[A-Za-z]{4}$/.test(typ)) {
          warnung(res, 'chunk_ungueltig', `Ungueltiger Chunk bei Offset ${pos} (Laenge ${len}, Typ ${JSON.stringify(typ)}); Durchlauf beendet.`);
          break;
        }
        const verfuegbar = src.size - (pos + 8);
        let komplett = len + 4 <= verfuegbar;
        let daten: Buffer = Buffer.alloc(0);
        let crcOk: boolean | null = null;
        if (komplett && len <= CRC_MAX) {
          const roh = await win.lese(pos + 8, len + 4);
          if (roh.length < len + 4) {
            komplett = false;
            daten = roh.subarray(0, Math.min(len, roh.length));
          } else {
            daten = roh.subarray(0, len);
            const soll = roh.readUInt32BE(len);
            const ist = crc32(daten, crc32(Buffer.from(typ, 'latin1')));
            crcOk = soll === ist;
            crc.geprueft++;
            if (!crcOk) {
              crc.fehlerhaft++;
              warnung(res, 'crc_fehler', `CRC-Fehler im Chunk ${typ} bei Offset ${pos}: gespeichert ${hex32(soll)}, berechnet ${hex32(ist)}.`);
            }
          }
        } else {
          const n = Math.min(len, PARSE_MAX, Math.max(0, verfuegbar));
          daten = n > 0 ? await src.readRange(pos + 8, n) : Buffer.alloc(0);
          if (komplett) crc.uebersprungen++;
        }
        if (!komplett) {
          warnung(res, 'chunk_abgeschnitten', `Chunk ${typ} bei Offset ${pos} meldet ${len} Bytes Daten, die Datei hat nur noch ${Math.max(0, verfuegbar)} Bytes.`);
        }

        if (erstes && typ !== 'IHDR') warnung(res, 'ihdr_nicht_zuerst', `Erster Chunk ist ${typ}, erwartet IHDR.`);
        erstes = false;
        if (!typen.includes(typ)) typen.push(typ);

        const info: Record<string, unknown> = { length: len };
        if (crcOk !== null) info.crc_ok = crcOk;
        else if (komplett) info.crc_geprueft = false;

        switch (typ) {
          case 'IHDR':
            if (daten.length >= 13) {
              ihdr = {
                width: daten.readUInt32BE(0),
                height: daten.readUInt32BE(4),
                bitDepth: daten[8],
                colorType: daten[9],
                compression: daten[10],
                filter: daten[11],
                interlace: daten[12],
              };
              Object.assign(info, { width: ihdr.width, height: ihdr.height, bit_depth: ihdr.bitDepth, color_type: ihdr.colorType, interlace: ihdr.interlace });
            } else warnung(res, 'ihdr_zu_kurz', `IHDR hat ${daten.length} statt 13 Bytes.`);
            break;
          case 'PLTE':
            plte = Math.floor(daten.length / 3);
            info.eintraege = plte;
            if (len % 3 !== 0) warnung(res, 'plte_laenge', `PLTE-Laenge ${len} ist kein Vielfaches von 3.`);
            break;
          case 'tRNS':
            trns = true;
            info.laenge = len;
            break;
          case 'gAMA':
            if (daten.length >= 4) {
              gama = daten.readUInt32BE(0) / 100000;
              info.gamma = gama;
            }
            break;
          case 'sRGB':
            if (daten.length >= 1) {
              srgb = daten[0];
              info.rendering_intent = RENDERING_INTENT[srgb] ?? srgb;
            }
            break;
          case 'iCCP': {
            const k = schluessel(daten, 79);
            if (k) {
              iccpName = kuerze(k.text, 80);
              info.profilname = iccpName;
              info.kompressionsmethode = daten[k.ende] ?? null;
            }
            break;
          }
          case 'cHRM':
            if (daten.length >= 32) {
              const v = (i: number): number => daten.readUInt32BE(i * 4) / 100000;
              fs.chrm = { white: [v(0), v(1)], red: [v(2), v(3)], green: [v(4), v(5)], blue: [v(6), v(7)] };
              info.chrm = fs.chrm;
            }
            break;
          case 'cICP':
            if (daten.length >= 4) {
              fs.cicp = { primaries: daten[0], transfer: daten[1], matrix: daten[2], full_range: daten[3] === 1 };
              info.cicp = fs.cicp;
            }
            break;
          case 'pHYs':
            if (daten.length >= 9) {
              phys = { x: daten.readUInt32BE(0), y: daten.readUInt32BE(4), einheit: daten[8] };
              info.pixel_pro_einheit = [phys.x, phys.y];
              info.einheit = phys.einheit === 1 ? 'meter' : 'unbekannt';
            }
            break;
          case 'tIME':
            if (daten.length >= 7) {
              const z = (n: number): string => String(n).padStart(2, '0');
              fs.time = `${daten.readUInt16BE(0)}-${z(daten[2])}-${z(daten[3])}T${z(daten[4])}:${z(daten[5])}:${z(daten[6])}Z`;
              info.zeit = fs.time;
            }
            break;
          case 'eXIf':
            exif = true;
            info.exif_bytes = len;
            break;
          case 'acTL':
            if (daten.length >= 8) {
              actl = { frames: daten.readUInt32BE(0), plays: daten.readUInt32BE(4) };
              info.num_frames = actl.frames;
              info.num_plays = actl.plays;
            }
            break;
          case 'fcTL':
            fcTL++;
            if (daten.length >= 26) {
              Object.assign(info, {
                sequenz: daten.readUInt32BE(0),
                width: daten.readUInt32BE(4),
                height: daten.readUInt32BE(8),
                x_offset: daten.readUInt32BE(12),
                y_offset: daten.readUInt32BE(16),
                delay: daten.readUInt16BE(20) + '/' + (daten.readUInt16BE(22) || 100),
                dispose_op: daten[24],
                blend_op: daten[25],
              });
            }
            break;
          case 'tEXt': {
            const k = schluessel(daten);
            if (k) {
              info.schluessel = k.text;
              info.wert = kuerze(daten.toString('latin1', k.ende));
              if (texte.length < TEXT_EINTRAEGE_MAX) texte.push({ chunk: 'tEXt', schluessel: k.text, wert: info.wert });
            }
            break;
          }
          case 'zTXt': {
            const k = schluessel(daten);
            if (k) {
              info.schluessel = k.text;
              info.wert = entpacke(daten.subarray(k.ende + 1), false);
              if (texte.length < TEXT_EINTRAEGE_MAX) texte.push({ chunk: 'zTXt', schluessel: k.text, wert: info.wert });
            }
            break;
          }
          case 'iTXt': {
            const k = schluessel(daten);
            if (k && daten.length >= k.ende + 2) {
              const komprimiert = daten[k.ende] === 1;
              const rest = daten.subarray(k.ende + 2);
              const spr = rest.indexOf(0);
              const rest2 = spr >= 0 ? rest.subarray(spr + 1) : Buffer.alloc(0);
              const tr = rest2.indexOf(0);
              const text = tr >= 0 ? rest2.subarray(tr + 1) : Buffer.alloc(0);
              info.schluessel = k.text;
              info.sprache = spr >= 0 ? rest.toString('utf8', 0, spr) : null;
              info.wert = komprimiert ? entpacke(text, true) : kuerze(text.toString('utf8'));
              if (texte.length < TEXT_EINTRAEGE_MAX) texte.push({ chunk: 'iTXt', schluessel: k.text, wert: info.wert });
            }
            break;
          }
          case 'IDAT':
            idatAnzahl++;
            idatBytes += len;
            break;
          case 'IEND':
            iend = true;
            break;
          default:
            break;
        }

        const laenge = Math.min(12 + len, src.size - pos);
        if (typ === 'IDAT' && idatObj && idatEnde === pos) {
          const d = idatObj.data;
          d.anzahl_chunks = (d.anzahl_chunks as number) + 1;
          d.daten_bytes = (d.daten_bytes as number) + len;
          if (crcOk === false) d.crc_fehler = ((d.crc_fehler as number) ?? 0) + 1;
          idatObj.source_range = { offset: (idatObj.source_range as { offset: number }).offset, length: pos + laenge - (idatObj.source_range as { offset: number }).offset };
          idatEnde = pos + laenge;
        } else if (res.objects.length < ctx.limits.maxObjects) {
          const obj: AssetObject = { name: typ, kind: 'chunk', data: info, source_range: { offset: pos, length: laenge } };
          if (typ === 'IDAT') {
            info.anzahl_chunks = 1;
            info.daten_bytes = len;
            idatObj = obj;
            idatEnde = pos + laenge;
          }
          res.objects.push(obj);
        } else if (!gekappt) {
          gekappt = true;
          warnung(res, 'chunk_liste_gekappt', `Mehr als ${ctx.limits.maxObjects} Chunks; die Liste wird gekappt, die Metadaten bleiben aus dem bisher Gelesenen.`);
          break;
        }

        pos += 12 + len;
        if (iend) break;
      }

      if (!ihdr) {
        res.status = 'fehler';
        warnung(res, 'ihdr_fehlt', 'Kein lesbarer IHDR-Chunk; Abmessungen unbekannt.');
        return;
      }

      const ft = FARBTYP[ihdr.colorType];
      if (!ft) warnung(res, 'farbtyp_unbekannt', `Unbekannter Farbtyp ${ihdr.colorType}.`);
      else if (!ft.tiefen.includes(ihdr.bitDepth)) warnung(res, 'bittiefe_ungueltig', `Bittiefe ${ihdr.bitDepth} ist fuer Farbtyp ${ft.name} nicht erlaubt.`);
      if (ihdr.compression !== 0 || ihdr.filter !== 0) warnung(res, 'methode_unbekannt', `Kompressions-/Filtermethode ${ihdr.compression}/${ihdr.filter} ist nicht 0/0.`);
      if (ihdr.interlace > 1) warnung(res, 'interlace_unbekannt', `Interlace-Methode ${ihdr.interlace} unbekannt.`);
      pruefeAbmessungen(res, ihdr.width, ihdr.height);
      if (ihdr.width > 0x7fffffff || ihdr.height > 0x7fffffff) warnung(res, 'abmessung_ueber_spec', 'Breite/Hoehe ueberschreiten 2^31-1 (PNG-Spezifikation).');
      if (!iend && res.status !== 'fehler') warnung(res, 'iend_fehlt', 'Kein IEND-Chunk gefunden (Datei abgeschnitten oder Liste gekappt).');
      if (iend && pos < src.size) warnung(res, 'daten_nach_iend', `${src.size - pos} Bytes nach IEND.`, false);
      if (idatAnzahl === 0 && iend) warnung(res, 'idat_fehlt', 'Kein IDAT-Chunk: keine Bilddaten.');

      const bitsKanal = ihdr.bitDepth;
      const kan = ft?.kanaele ?? null;
      const alpha = ihdr.colorType === 4 || ihdr.colorType === 6 || trns;
      const animiert = actl !== null;
      if (actl && !gekappt && iend && fcTL !== actl.frames) {
        warnung(res, 'frames_zahl_abweichend', `acTL nennt ${actl.frames} Frames, gefunden wurden ${fcTL} fcTL-Chunks.`);
      }
      let colorSpace: string | null = null;
      let transfer: string | null = null;
      if (srgb !== null) {
        colorSpace = 'sRGB';
        transfer = 'sRGB';
      } else if (iccpName) {
        colorSpace = `ICC:${iccpName}`;
      } else if (gama !== null) {
        transfer = `gamma ${gama > 0 ? (1 / gama).toFixed(2) : 'ungueltig'}`;
      }

      res.metadata = bildMetadata(
        {
          kind: 'image',
          width: ihdr.width,
          height: ihdr.height,
          has_alpha: alpha,
          channels: kan,
          bits_per_channel: bitsKanal,
          color_space: colorSpace,
          transfer,
          format_name: ft ? `${ft.kurz}${bitsKanal}` : null,
          fmt: kan ? { bw: 1, bh: 1, bits: kan * bitsKanal } : null,
        },
        {
          color_type_name: ft?.name ?? null,
          interlaced: ihdr.interlace === 1,
          animated: animiert,
          frame_count: animiert ? actl!.frames : 1,
          loop_count: animiert ? actl!.plays : null,
          dpi_x: phys && phys.einheit === 1 ? Math.round(phys.x * 0.0254 * 100) / 100 : null,
          dpi_y: phys && phys.einheit === 1 ? Math.round(phys.y * 0.0254 * 100) / 100 : null,
          icc_profil: iccpName,
          hat_exif: exif,
          palette_eintraege: plte,
        }
      );
      fs.ihdr = { color_type: ihdr.colorType, bit_depth: ihdr.bitDepth, compression_method: ihdr.compression, filter_method: ihdr.filter, interlace_method: ihdr.interlace };
      fs.chunk_typen = typen;
      fs.idat = { chunks: idatAnzahl, bytes: idatBytes };
      fs.crc = crc;
      if (srgb !== null) fs.srgb_intent = RENDERING_INTENT[srgb] ?? srgb;
      if (gama !== null) fs.gamma = gama;
      if (iccpName) fs.iccp_name = iccpName;
      if (trns) fs.trns = true;
      if (texte.length > 0) fs.text = texte;
      res.format_specific = fs;
    });
    return res;
  },
};
