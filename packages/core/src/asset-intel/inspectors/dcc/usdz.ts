/**
 * MODUL: DCC USDZ-Inspektor
 * ZWECK: .usdz = Zip-Paket mit USD-Layer + Assets. EIGENER Mini-Zip-Leser (End-of-Central-
 *        Directory + Central Directory + lokale Koepfe), bewusst unabhaengig vom Archiv-Inspektor
 *        (ein spaeterer Abgleich der Duplikate ist beabsichtigt).
 *  - Eintragsliste; USDZ-Regeln: nur Methode 0 (gespeichert), Daten 64-Byte-ausgerichtet,
 *    keine Verschluesselung, erste Datei ist ein Layer (.usd/.usda/.usdc) -> Warnungen.
 *  - Der Hauptlayer wird, wenn gespeichert und klein genug, ueber eine AusschnittQuelle
 *    (Bereich der Zip-Datei) mit ctx.tiefer() an den eigenen USD-Inspektor gegeben; dessen
 *    Asset-Pfade werden gegen die Paketeintraege aufgeloest.
 *  - Uebrige Eintraege -> references (kind 'paket_inhalt').
 *
 * REGISTRIERUNG: Endung .usdz plus der enge Zip-Kopf eines USDZ (Methode 0, siehe USDZ_MAGIC). Passen dadurch
 * archiv-zip und dcc-usdz, entscheidet die Endung .usdz.
 * Zip64 wird erkannt, aber nicht gelesen (Warnung zip64_nicht_unterstuetzt).
 */

import * as path from 'path';
import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetMagic, AssetResult, AssetSource } from '../../types.js';
import { AssetLimitError } from '../../errors.js';
import { AusschnittQuelle, FensterLeser, Sammler, abbruchTakt } from './hilfen.js';
import { inspiziereUsd } from './usd.js';

const VERSION = 1;
const SIG_EOCD = 0x06054b50;
const SIG_CD = 0x02014b50;
const SIG_LOKAL = 0x04034b50;
/** Groesster Layer, der im Paket inspiziert wird. */
const MAX_LAYER_BYTES = 64 * 1024 * 1024;

interface Eintrag {
  name: string;
  methode: number;
  flags: number;
  gepackt: number;
  entpackt: number;
  lokal: number;
  daten: number;
}

const istLayer = (n: string): boolean => /\.(usd|usda|usdc)$/i.test(n);

/** Inspiziert eine .usdz-Datei. */
export async function inspiziereUsdz(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
  const res = erzeugeAssetResult(src.filePath, src.size, {
    asset_type: 'scene',
    format: 'usdz',
    inspector: 'dcc-usdz',
    parser_version: VERSION,
  });
  const s = new Sammler(ctx.limits.maxObjects);
  const fertig = (): AssetResult => {
    s.indErgebnis(res);
    return res;
  };
  const f = new FensterLeser(src, 64 * 1024);
  const takt = abbruchTakt(ctx, 256);

  // End-of-Central-Directory: letzte 22..65557 Bytes.
  const schwanzLen = Math.min(src.size, 22 + 0xffff);
  const schwanzStart = src.size - schwanzLen;
  const schwanz = await src.readRange(schwanzStart, schwanzLen);
  let eocd = -1;
  for (let i = schwanz.length - 22; i >= 0; i--) {
    if (schwanz.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    s.warn('kein_zip', 'Kein End-of-Central-Directory gefunden (keine Zip-Datei oder abgeschnitten).');
    res.status = 'fehler';
    return fertig();
  }
  const anzahl = schwanz.readUInt16LE(eocd + 10);
  const cdGroesse = schwanz.readUInt32LE(eocd + 12);
  const cdOffset = schwanz.readUInt32LE(eocd + 16);
  const eocdAbs = schwanzStart + eocd;
  if (anzahl === 0xffff || cdGroesse === 0xffffffff || cdOffset === 0xffffffff) {
    s.warn('zip64_nicht_unterstuetzt', 'Zip64-Paket erkannt; der Mini-Leser liest nur klassische Zip-Verzeichnisse.');
    res.status = 'teilweise';
    return fertig();
  }
  if (cdOffset + cdGroesse > eocdAbs) {
    s.warn('verzeichnis_ausserhalb', `Central Directory (${cdOffset}+${cdGroesse}) ragt ueber das Verzeichnisende bei ${eocdAbs}.`);
    res.status = 'fehler';
    return fertig();
  }

  const eintraege: Eintrag[] = [];
  const verstoesse = { methode: [] as string[], ausrichtung: [] as string[], verschluesselt: [] as string[] };
  let p = cdOffset;
  let intakt = true;
  for (let i = 0; i < anzahl; i++) {
    takt();
    if (p + 46 > cdOffset + cdGroesse) {
      s.warn('verzeichnis_abgeschnitten', `Central Directory endet nach ${i} von ${anzahl} Eintraegen.`);
      intakt = false;
      break;
    }
    const h = await f.genau(p, 46);
    if (h.readUInt32LE(0) !== SIG_CD) {
      s.warn('verzeichnis_ungueltig', `Eintrag ${i} bei ${p}: keine Central-Directory-Signatur.`);
      intakt = false;
      break;
    }
    const flags = h.readUInt16LE(8);
    const methode = h.readUInt16LE(10);
    const gepackt = h.readUInt32LE(20);
    const entpackt = h.readUInt32LE(24);
    const nLen = h.readUInt16LE(28);
    const xLen = h.readUInt16LE(30);
    const kLen = h.readUInt16LE(32);
    const lokal = h.readUInt32LE(42);
    const nameBuf = await f.genau(p + 46, nLen);
    const name = flags & 0x800 ? nameBuf.toString('utf8') : nameBuf.toString('latin1');
    p += 46 + nLen + xLen + kLen;
    // Lokaler Kopf: Datenoffset = lokal + 30 + Namens- + Extra-Laenge (des LOKALEN Kopfs).
    if (lokal + 30 > src.size) {
      s.warn('eintrag_ausserhalb', `"${name}": lokaler Kopf bei ${lokal} liegt hinter dem Dateiende.`);
      intakt = false;
      continue;
    }
    const lh = await f.genau(lokal, 30);
    if (lh.readUInt32LE(0) !== SIG_LOKAL) {
      s.warn('eintrag_ungueltig', `"${name}": keine lokale Kopf-Signatur bei ${lokal}.`);
      intakt = false;
      continue;
    }
    const daten = lokal + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    if (daten + gepackt > src.size) {
      s.warn('eintrag_ausserhalb', `"${name}": Daten (${daten}+${gepackt}) ragen ueber das Dateiende.`);
      intakt = false;
      continue;
    }
    const e: Eintrag = { name, methode, flags, gepackt, entpackt, lokal, daten };
    eintraege.push(e);
    if (methode !== 0) verstoesse.methode.push(name);
    if (flags & 1) verstoesse.verschluesselt.push(name);
    if (daten % 64 !== 0) verstoesse.ausrichtung.push(name);
    s.objekt({
      name,
      kind: 'paket_eintrag',
      data: { methode, groesse: entpackt, gepackt, ausgerichtet_64: daten % 64 === 0 },
      source_range: { offset: daten, length: gepackt },
    });
  }
  const liste = (n: string[]): string => n.slice(0, 5).join(', ') + (n.length > 5 ? ` (+${n.length - 5})` : '');
  if (verstoesse.methode.length) s.warn('usdz_komprimiert', `USDZ verlangt Methode 0 (gespeichert); komprimiert: ${liste(verstoesse.methode)}.`);
  if (verstoesse.verschluesselt.length) s.warn('usdz_verschluesselt', `USDZ verbietet Verschluesselung; betroffen: ${liste(verstoesse.verschluesselt)}.`);
  if (verstoesse.ausrichtung.length) s.warn('usdz_nicht_ausgerichtet', `USDZ verlangt 64-Byte-Ausrichtung der Daten; abweichend: ${liste(verstoesse.ausrichtung)}.`);
  res.metadata.eintraege = eintraege.length;
  res.metadata.regeln_eingehalten = !verstoesse.methode.length && !verstoesse.verschluesselt.length && !verstoesse.ausrichtung.length;

  const layer = eintraege.find(e => istLayer(e.name)) ?? null;
  if (eintraege.length > 0 && !istLayer(eintraege[0].name)) {
    s.warn('usdz_erste_datei_kein_layer', `Erste Datei "${eintraege[0].name}" ist kein USD-Layer.`);
  }
  if (!layer) {
    s.warn('usdz_ohne_layer', 'Paket enthaelt keinen USD-Layer (.usd/.usda/.usdc).');
    intakt = false;
  }
  const namen = new Set(eintraege.map(e => e.name));
  res.metadata.layer = layer?.name ?? null;

  if (layer) {
    const inspizierbar = layer.methode === 0 && !(layer.flags & 1) && layer.gepackt <= Math.min(MAX_LAYER_BYTES, ctx.limits.maxReadBytes);
    if (!inspizierbar) {
      s.warn('layer_nicht_inspiziert', `Layer "${layer.name}" ist komprimiert, verschluesselt oder zu gross; nicht inspiziert.`);
      intakt = false;
    } else {
      try {
        const unter = ctx.tiefer();
        const q = new AusschnittQuelle(`${src.filePath}[${layer.name}]`, src, layer.daten, layer.gepackt);
        const basis = path.posix.dirname(layer.name);
        const aufloeser = async (ziel: string): Promise<boolean | undefined> => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(ziel) || path.posix.isAbsolute(ziel)) return undefined;
          return namen.has(path.posix.normalize(path.posix.join(basis, ziel)));
        };
        const innen = await inspiziereUsd(q, unter, { aufloeser });
        res.format_specific.layer = {
          datei: layer.name,
          format: innen.format,
          status: innen.status,
          metadata: innen.metadata,
          format_specific: innen.format_specific,
        };
        for (const o of innen.objects) {
          const r = o.source_range;
          s.objekt({
            ...o,
            data: { ...o.data, paket_datei: layer.name },
            source_range: r && 'offset' in r ? { offset: r.offset + layer.daten, length: r.length } : r,
          });
        }
        for (const r of innen.references) s.referenz(r);
        for (const w of innen.warnings) s.warn(w.code, `[${layer.name}] ${w.message}`);
        if (innen.status !== 'ok') intakt = false;
      } catch (e) {
        if (!(e instanceof AssetLimitError) || e.grenze !== 'maxDepth') throw e;
        s.warn('tiefengrenze_ueberschritten', `Layer "${layer.name}" nicht inspiziert: ${e.message}`);
        intakt = false;
      }
    }
  }
  for (const e of eintraege) if (e !== layer) s.referenz({ target: e.name, kind: 'paket_inhalt', resolved: true });
  // Regelverstoesse allein sind Warnungen; 'teilweise' nur, wenn etwas nicht gelesen wurde.
  if (!intakt) res.status = 'teilweise';
  return fertig();
}

/**
 * Zip-Kopf eines USDZ: 'PK\3\4', Version (10/20/45), Flags (0 oder UTF-8-Bit), Methode 0 (gespeichert — USDZ-Pflicht).
 * Bewusst enger als das Zip-Magic von archiv-zip: ein normales Zip (deflate) bleibt ohne Endung eindeutig.
 * Die Endung .usdz entscheidet, wenn beide Inspektoren passen; ein USDZ mit anderem Kopf faellt auf archiv-zip
 * (Warnung endung_widerspricht_inhalt).
 */
const USDZ_MAGIC: AssetMagic[] = [0x0a, 0x14, 0x2d].flatMap(version =>
  [[0x00, 0x00], [0x00, 0x08]].map((flags): AssetMagic => ({
    offset: 0,
    bytes: [0x50, 0x4b, 0x03, 0x04, version, 0x00, flags[0], flags[1], 0x00, 0x00],
    format: 'usdz',
  }))
);

export const usdzInspektor: AssetInspector = {
  id: 'dcc-usdz',
  formats: ['usdz'],
  extensions: ['.usdz'],
  magic: USDZ_MAGIC,
  version: VERSION,
  inspect: (src, ctx) => inspiziereUsdz(src, ctx),
};
