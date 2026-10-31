/**
 * MODUL: Textur-Inspektor AVIF/HEIF (P22-T238 zusammen mit P4-T75, User 31.10.2026, thought 0e4c4c3f)
 * ZWECK: ISO-BMFF-Bildcontainer (HEIF): AVIF (AV1) und HEIC/HEIF (HEVC). Liest nur Box-Koepfe, die meta-Box
 *        (Items, Eigenschaften) und bei Bildfolgen die Sample-Tabelle - nie Bitstroeme.
 *        Metadaten wie textur-png: width/height (ispe des Primaer-Items), channels, has_alpha (auxC alpha),
 *        bits_per_channel (pixi bzw. av1C/hvcC), frame_count/animated (avis/msf1 + stsz), Farbraum (colr nclx/ICC).
 *
 * MAGIC: 'ftyp' + Major-Brand an Offset 4. Die Medien-Inspektoren nehmen diese Brands bewusst NICHT
 *        (inspectors/medien/index.ts MP4_BRANDS), daher keine Kollision mit mp4.
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetInspector, AssetMagic, AssetResult, AssetSource } from '../../types.js';
import { Lesefenster, bildMetadata, pruefeAbmessungen, sicher, vierZeichen, warnung } from './util.js';

const ID = 'textur-heif';
const VERSION = 1;
/** Groesste meta-Box, die vollstaendig gelesen wird (Items/Eigenschaften, keine Pixeldaten). */
const META_MAX = 4 * 1024 * 1024;
/** Hoechstzahl Boxen je Ebene beim Durchlauf (Schutz gegen kaputte Groessenangaben). */
const BOXEN_MAX = 4096;

const ASCII = (s: string): number[] => [...s].map(c => c.charCodeAt(0));
const AVIF_BRANDS = ['avif', 'avis'];
const HEIC_BRANDS = ['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs'];
const HEIF_BRANDS = ['mif1', 'msf1'];
const MAGIC: AssetMagic[] = [
  ...AVIF_BRANDS.map((b): AssetMagic => ({ offset: 4, bytes: ASCII('ftyp' + b), format: 'avif' })),
  ...HEIC_BRANDS.map((b): AssetMagic => ({ offset: 4, bytes: ASCII('ftyp' + b), format: 'heic' })),
  ...HEIF_BRANDS.map((b): AssetMagic => ({ offset: 4, bytes: ASCII('ftyp' + b), format: 'heif' })),
];

interface Box { typ: string; start: number; inhalt: number; ende: number }

/** Boxen in einem Buffer-Bereich [s, e). Kaputte Groessen beenden den Durchlauf. */
function bufBoxen(b: Buffer, s: number, e: number): Box[] {
  const aus: Box[] = [];
  let pos = s;
  while (pos + 8 <= e && aus.length < BOXEN_MAX) {
    let groesse = b.readUInt32BE(pos);
    const typ = vierZeichen(b, pos + 4);
    let kopf = 8;
    if (groesse === 1) {
      if (pos + 16 > e) break;
      const gross = b.readBigUInt64BE(pos + 8);
      if (gross > BigInt(e - pos)) break;
      groesse = Number(gross);
      kopf = 16;
    } else if (groesse === 0) groesse = e - pos;
    if (groesse < kopf || pos + groesse > e) break;
    aus.push({ typ, start: pos, inhalt: pos + kopf, ende: pos + groesse });
    pos += groesse;
  }
  return aus;
}

/** Boxen direkt aus der Datei in [s, e) (nur Koepfe gelesen). */
async function dateiBoxen(win: Lesefenster, s: number, e: number): Promise<Box[]> {
  const aus: Box[] = [];
  let pos = s;
  while (pos + 8 <= e && aus.length < BOXEN_MAX) {
    const h = await win.lese(pos, 16);
    if (h.length < 8) break;
    let groesse = h.readUInt32BE(0);
    const typ = vierZeichen(h, 4);
    let kopf = 8;
    if (groesse === 1) {
      if (h.length < 16) break;
      const gross = h.readBigUInt64BE(8);
      if (gross > BigInt(e - pos)) break;
      groesse = Number(gross);
      kopf = 16;
    } else if (groesse === 0) groesse = e - pos;
    if (groesse < kopf || pos + groesse > e) break;
    aus.push({ typ, start: pos, inhalt: pos + kopf, ende: pos + groesse });
    pos += groesse;
  }
  return aus;
}

const finde = (boxen: Box[], typ: string): Box | undefined => boxen.find(x => x.typ === typ);

interface Eigenschaft { typ: string; daten: Record<string, unknown> }

/** Eine ipco-Eigenschaft auswerten (nur die fuer Bildmetadaten noetigen). */
function eigenschaft(b: Buffer, box: Box): Eigenschaft {
  const p = box.inhalt;
  const d: Record<string, unknown> = {};
  const lang = (n: number) => p + n <= box.ende;
  switch (box.typ) {
    case 'ispe':
      if (lang(12)) { d.width = b.readUInt32BE(p + 4); d.height = b.readUInt32BE(p + 8); }
      break;
    case 'pixi':
      if (lang(5)) {
        const n = b[p + 4];
        const bits: number[] = [];
        for (let i = 0; i < n && p + 5 + i < box.ende; i++) bits.push(b[p + 5 + i]);
        d.num_channels = n; d.bits = bits;
      }
      break;
    case 'colr':
      if (lang(4)) {
        const art = vierZeichen(b, p);
        d.colour_type = art;
        if (art === 'nclx' && lang(11)) {
          d.primaries = b.readUInt16BE(p + 4); d.transfer = b.readUInt16BE(p + 6); d.matrix = b.readUInt16BE(p + 8);
          d.full_range = (b[p + 10] & 0x80) !== 0;
        }
      }
      break;
    case 'auxC': {
      if (lang(5)) {
        const ende = b.indexOf(0, p + 4);
        d.aux_type = b.toString('latin1', p + 4, ende >= 0 && ende < box.ende ? ende : box.ende).slice(0, 200);
      }
      break;
    }
    case 'av1C':
      if (lang(3)) {
        const x = b[p + 2];
        d.codec = 'av1'; d.high_bitdepth = (x & 0x40) !== 0; d.twelve_bit = (x & 0x20) !== 0; d.monochrome = (x & 0x10) !== 0;
        d.bit_depth = d.twelve_bit ? 12 : d.high_bitdepth ? 10 : 8;
      }
      break;
    case 'hvcC':
      if (lang(23)) {
        d.codec = 'hevc'; d.chroma_format = b[p + 16] & 3; d.bit_depth = (b[p + 17] & 7) + 8; d.monochrome = (b[p + 16] & 3) === 0;
      }
      break;
    case 'irot':
      if (lang(1)) d.winkel = (b[p] & 3) * 90;
      break;
    default:
      break;
  }
  return { typ: box.typ, daten: d };
}

const ALPHA_URN = /alpha|auxid:1$/i;

const FARBRAUM: Record<number, string> = { 1: 'BT.709/sRGB', 9: 'BT.2020', 12: 'Display P3', 11: 'DCI-P3', 2: 'unspezifiziert' };
const TRANSFER: Record<number, string> = { 1: 'BT.709', 13: 'sRGB', 16: 'PQ (SMPTE ST 2084)', 18: 'HLG', 8: 'linear', 2: 'unspezifiziert' };

/** Bildfolge (avis/msf1): erste Bild-Spur, Samplezahl aus stsz, Dauer aus mdhd. */
async function bildfolge(win: Lesefenster, src: AssetSource, moov: Box): Promise<{ frames: number | null; dauer_ms: number | null }> {
  const spuren = (await dateiBoxen(win, moov.inhalt, moov.ende)).filter(x => x.typ === 'trak');
  for (const trak of spuren) {
    const mdia = finde(await dateiBoxen(win, trak.inhalt, trak.ende), 'mdia');
    if (!mdia) continue;
    const mdiaKinder = await dateiBoxen(win, mdia.inhalt, mdia.ende);
    const hdlr = finde(mdiaKinder, 'hdlr');
    if (hdlr) {
      const h = await src.readRange(hdlr.inhalt, 12);
      if (h.length >= 12 && vierZeichen(h, 8) !== 'pict') continue;
    }
    let dauer_ms: number | null = null;
    const mdhd = finde(mdiaKinder, 'mdhd');
    if (mdhd) {
      const m = await src.readRange(mdhd.inhalt, 32);
      const v1 = m[0] === 1;
      if (v1 ? m.length >= 32 : m.length >= 20) {
        const timescale = v1 ? m.readUInt32BE(20) : m.readUInt32BE(12);
        const dauer = v1 ? Number(m.readBigUInt64BE(24)) : m.readUInt32BE(16);
        if (timescale > 0 && Number.isFinite(dauer)) dauer_ms = Math.round((dauer / timescale) * 1000);
      }
    }
    const minf = finde(mdiaKinder, 'minf');
    const stbl = minf ? finde(await dateiBoxen(win, minf.inhalt, minf.ende), 'stbl') : undefined;
    const stbl_k = stbl ? await dateiBoxen(win, stbl.inhalt, stbl.ende) : [];
    const stsz = finde(stbl_k, 'stsz') ?? finde(stbl_k, 'stz2');
    if (stsz) {
      const s = await src.readRange(stsz.inhalt, 12);
      if (s.length >= 12) return { frames: s.readUInt32BE(8), dauer_ms };
    }
    return { frames: null, dauer_ms };
  }
  return { frames: null, dauer_ms: null };
}

export const heifInspector: AssetInspector = {
  id: ID,
  formats: ['avif', 'heic', 'heif'],
  extensions: ['.avif', '.heic', '.heif', '.avifs', '.heics', '.heifs'],
  magic: MAGIC,
  version: VERSION,
  async inspect(src, ctx) {
    const res: AssetResult = erzeugeAssetResult(src.filePath, src.size, { asset_type: 'image', format: ctx.format ?? 'avif', inspector: ID, parser_version: VERSION });
    await sicher(res, async () => {
      const win = new Lesefenster(src);
      const oben = await dateiBoxen(win, 0, src.size);
      const ftyp = oben[0]?.typ === 'ftyp' ? oben[0] : undefined;
      if (!ftyp) {
        res.status = 'fehler';
        warnung(res, 'signatur_ungueltig', 'Keine ftyp-Box am Dateianfang (kein HEIF/AVIF).');
        return;
      }
      const f = await src.readRange(ftyp.inhalt, Math.min(ftyp.ende - ftyp.inhalt, 256));
      const major = f.length >= 4 ? vierZeichen(f, 0) : '????';
      const brands = [major];
      for (let o = 8; o + 4 <= f.length; o += 4) brands.push(vierZeichen(f, o));
      const format = brands.some(x => AVIF_BRANDS.includes(x)) ? 'avif' : brands.some(x => HEIC_BRANDS.includes(x)) ? 'heic' : 'heif';
      res.format = format;
      const folge = brands.includes('avis') || brands.includes('msf1') || brands.includes('hevs');

      const metaBox = finde(oben, 'meta');
      const items: Array<{ id: number; typ: string }> = [];
      const props: Eigenschaft[] = [];
      const zuordnung = new Map<number, number[]>();
      const auxl: Array<{ von: number; zu: number[] }> = [];
      let primaer: number | null = null;
      let handler: string | null = null;
      if (metaBox) {
        if (metaBox.ende - metaBox.inhalt > META_MAX) {
          warnung(res, 'meta_zu_gross', `meta-Box hat ${metaBox.ende - metaBox.inhalt} Bytes (Grenze ${META_MAX}); Eigenschaften nicht gelesen.`);
        } else {
          const b = await src.readRange(metaBox.inhalt, metaBox.ende - metaBox.inhalt);
          const kinder = bufBoxen(b, 4, b.length); // meta ist eine FullBox (4 Bytes Version/Flags)
          const hdlr = finde(kinder, 'hdlr');
          if (hdlr && hdlr.inhalt + 12 <= hdlr.ende) handler = vierZeichen(b, hdlr.inhalt + 8);
          const pitm = finde(kinder, 'pitm');
          if (pitm && pitm.inhalt + 6 <= pitm.ende) primaer = b[pitm.inhalt] === 0 ? b.readUInt16BE(pitm.inhalt + 4) : b.readUInt32BE(pitm.inhalt + 4);
          const iinf = finde(kinder, 'iinf');
          if (iinf) {
            const v = b[iinf.inhalt];
            const start = iinf.inhalt + (v === 0 ? 6 : 8);
            for (const infe of bufBoxen(b, start, iinf.ende).filter(x => x.typ === 'infe')) {
              const iv = b[infe.inhalt];
              if (iv < 2) continue;
              const idLaenge = iv === 2 ? 2 : 4;
              const o = infe.inhalt + 4;
              if (o + idLaenge + 2 + 4 > infe.ende) continue;
              const id = idLaenge === 2 ? b.readUInt16BE(o) : b.readUInt32BE(o);
              items.push({ id, typ: vierZeichen(b, o + idLaenge + 2) });
            }
          }
          const iref = finde(kinder, 'iref');
          if (iref) {
            const iv = b[iref.inhalt];
            const idL = iv === 0 ? 2 : 4;
            for (const r of bufBoxen(b, iref.inhalt + 4, iref.ende)) {
              if (r.typ !== 'auxl') continue;
              let o = r.inhalt;
              if (o + idL + 2 > r.ende) continue;
              const von = idL === 2 ? b.readUInt16BE(o) : b.readUInt32BE(o);
              o += idL;
              const n = b.readUInt16BE(o);
              o += 2;
              const zu: number[] = [];
              for (let i = 0; i < n && o + idL <= r.ende; i++, o += idL) zu.push(idL === 2 ? b.readUInt16BE(o) : b.readUInt32BE(o));
              auxl.push({ von, zu });
            }
          }
          const iprp = finde(kinder, 'iprp');
          if (iprp) {
            const iprpK = bufBoxen(b, iprp.inhalt, iprp.ende);
            const ipco = finde(iprpK, 'ipco');
            if (ipco) for (const p of bufBoxen(b, ipco.inhalt, ipco.ende)) props.push(eigenschaft(b, p));
            for (const ipma of iprpK.filter(x => x.typ === 'ipma')) {
              const v = b[ipma.inhalt];
              const flags = b.readUIntBE(ipma.inhalt + 1, 3);
              let o = ipma.inhalt + 4;
              if (o + 4 > ipma.ende) continue;
              const anzahl = b.readUInt32BE(o);
              o += 4;
              for (let i = 0; i < anzahl && o < ipma.ende; i++) {
                ctx.pruefeAbbruch();
                const idL = v < 1 ? 2 : 4;
                if (o + idL + 1 > ipma.ende) break;
                const id = idL === 2 ? b.readUInt16BE(o) : b.readUInt32BE(o);
                o += idL;
                const n = b[o];
                o += 1;
                const liste: number[] = [];
                for (let k = 0; k < n; k++) {
                  if (flags & 1) { if (o + 2 > ipma.ende) break; liste.push(b.readUInt16BE(o) & 0x7fff); o += 2; }
                  else { if (o + 1 > ipma.ende) break; liste.push(b[o] & 0x7f); o += 1; }
                }
                zuordnung.set(id, [...(zuordnung.get(id) ?? []), ...liste]);
              }
            }
          }
        }
      } else if (!folge) {
        warnung(res, 'meta_fehlt', 'Keine meta-Box: Bildeigenschaften unbekannt.');
      }

      const eigen = (id: number | null): Eigenschaft[] =>
        id === null ? [] : (zuordnung.get(id) ?? []).map(i => props[i - 1]).filter((x): x is Eigenschaft => !!x);
      const pe = eigen(primaer);
      const wahl = (typ: string) => pe.find(x => x.typ === typ) ?? props.find(x => x.typ === typ);
      const ispe = pe.find(x => x.typ === 'ispe')
        ?? props.filter(x => x.typ === 'ispe').sort((a, c) => Number(c.daten.width ?? 0) * Number(c.daten.height ?? 0) - Number(a.daten.width ?? 0) * Number(a.daten.height ?? 0))[0];
      const pixi = wahl('pixi');
      const codec = wahl('av1C') ?? wahl('hvcC');
      const colr = wahl('colr');
      const alphaItems = auxl.filter(a => primaer === null || a.zu.includes(primaer)).map(a => a.von);
      const alpha = alphaItems.some(id => eigen(id).some(x => x.typ === 'auxC' && ALPHA_URN.test(String(x.daten.aux_type ?? ''))))
        || (alphaItems.length === 0 && props.some(x => x.typ === 'auxC' && ALPHA_URN.test(String(x.daten.aux_type ?? ''))));

      let frames: number | null = 1;
      let dauer_ms: number | null = null;
      const moov = finde(oben, 'moov');
      if (moov) {
        const bf = await bildfolge(win, src, moov);
        frames = bf.frames;
        dauer_ms = bf.dauer_ms;
      }
      const animiert = !!moov && (frames ?? 0) > 1;

      const breite = typeof ispe?.daten.width === 'number' ? ispe.daten.width : null;
      const hoehe = typeof ispe?.daten.height === 'number' ? ispe.daten.height : null;
      if (breite === null || hoehe === null) {
        if (!moov) {
          res.status = 'teilweise';
          warnung(res, 'abmessungen_unbekannt', 'Keine ispe-Eigenschaft: Abmessungen unbekannt.', false);
        }
      } else pruefeAbmessungen(res, breite, hoehe);
      const mono = codec?.daten.monochrome === true || (pixi && Number(pixi.daten.num_channels) === 1);
      const farbKanaele = mono ? 1 : (pixi ? Number(pixi.daten.num_channels) : 3);
      const kanaele = farbKanaele + (alpha ? 1 : 0);
      const bits = pixi && Array.isArray(pixi.daten.bits) && (pixi.daten.bits as number[]).length
        ? (pixi.daten.bits as number[])[0]
        : codec ? Number(codec.daten.bit_depth) : null;
      const nclx = colr?.daten.colour_type === 'nclx' ? colr.daten : null;
      const codecName = codec ? String(codec.daten.codec) : format === 'avif' ? 'av1' : format === 'heic' ? 'hevc' : null;

      res.metadata = bildMetadata(
        {
          kind: 'image',
          width: breite,
          height: hoehe,
          has_alpha: alpha,
          channels: kanaele,
          bits_per_channel: bits,
          color_space: nclx ? (FARBRAUM[Number(nclx.primaries)] ?? 'CICP ' + nclx.primaries) : colr ? 'ICC-Profil eingebettet' : null,
          transfer: nclx ? (TRANSFER[Number(nclx.transfer)] ?? 'CICP ' + nclx.transfer) : null,
          format_name: (format === 'avif' ? 'AVIF' : format === 'heic' ? 'HEIC' : 'HEIF') + (bits ? ' ' + bits + ' bit' : '') + (animiert ? ' animiert' : ''),
          fmt: bits ? { bw: 1, bh: 1, bits: kanaele * bits } : null,
        },
        {
          animated: animiert,
          frame_count: frames,
          dauer_gesamt_ms: animiert ? dauer_ms : null,
          codec: codecName,
          item_count: items.length,
          primary_item: primaer,
          drehung_grad: wahl('irot')?.daten.winkel ?? 0,
          mime_type: format === 'avif' ? (folge ? 'image/avif-sequence' : 'image/avif') : (folge ? 'image/heic-sequence' : 'image/heic'),
        }
      );
      res.format_specific = {
        major_brand: major,
        brands,
        handler,
        items: items.slice(0, 64),
        alpha_items: alphaItems,
        eigenschaften: [...new Set(props.map(x => x.typ))],
        farbe: colr?.daten ?? null,
        bildfolge: !!moov,
      };
      for (const it of items) {
        if (res.objects.length >= ctx.limits.maxObjects) { warnung(res, 'objekte_gekappt', 'Mehr Items als die Objektgrenze.', false); break; }
        const e = eigen(it.id).find(x => x.typ === 'ispe');
        res.objects.push({ kind: 'item', name: it.typ, data: { id: it.id, typ: it.typ, primaer: it.id === primaer, width: e?.daten.width ?? null, height: e?.daten.height ?? null } });
      }
    });
    return res;
  },
};
