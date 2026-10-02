/**
 * MODUL: Asset-Intel PE-Inspektor (T66b)
 * ZWECK: Liest Windows-PE-Dateien (.exe/.dll/.sys/.ocx/...) rein lesend und liefert
 *        Architektur, Sektionen, Importe/Exporte, Ressourcen-Typen, Versionsinfo,
 *        Debug-/PDB-Angaben, Authenticode-Vorhandensein und .NET-Erkennung.
 *
 * Das Programm wird NIE ausgefuehrt; es werden nur Bytes ueber AssetSource.readRange gelesen.
 * Alle RVAs/Offsets werden gegen Dateigroesse und Sektionsgrenzen geprueft (RVA -> Dateioffset
 * nur innerhalb der Rohdaten einer Sektion). Schleifen sind durch Zaehler gekappt und rufen
 * ctx.pruefeAbbruch(). Jede Phase laeuft isoliert (util.phase): ein kaputter Verweis kostet nur
 * seine Phase, nicht das ganze Ergebnis.
 *
 * Authenticode wird NICHT validiert, nur als vorhanden/nicht vorhanden gemeldet.
 */

import { BinaryReader } from '../../binary-reader.js';
import { erzeugeAssetResult } from '../../types.js';
import type {
  AssetContext,
  AssetInspector,
  AssetObject,
  AssetReference,
  AssetResult,
  AssetSource,
  AssetStatus,
} from '../../types.js';
import { MAX_NAME, WarnSammler, bereinige, cstringAus, entropie, hexZahl, isoAusSekunden, phase } from './util.js';

const INSPEKTOR_VERSION = 1;

const MACHINE: Record<number, string> = {
  0x14c: 'x86 (i386)',
  0x8664: 'x64 (AMD64)',
  0x1c0: 'ARM',
  0x1c2: 'ARM Thumb',
  0x1c4: 'ARM Thumb-2 (ARMNT)',
  0xaa64: 'ARM64',
  0xa641: 'ARM64EC',
  0x200: 'Itanium (IA-64)',
  0x166: 'MIPS R4000',
  0x1f0: 'PowerPC',
  0x1f1: 'PowerPC mit FPU',
  0x5032: 'RISC-V 32',
  0x5064: 'RISC-V 64',
  0x6232: 'LoongArch 32',
  0x6264: 'LoongArch 64',
  0xebc: 'EFI Byte Code',
};

const SUBSYSTEM: Record<number, string> = {
  0: 'unbekannt',
  1: 'native',
  2: 'windows_gui',
  3: 'windows_cui',
  5: 'os2_cui',
  7: 'posix_cui',
  9: 'windows_ce_gui',
  10: 'efi_application',
  11: 'efi_boot_service_driver',
  12: 'efi_runtime_driver',
  13: 'efi_rom',
  14: 'xbox',
  16: 'windows_boot_application',
};

const RESSOURCEN_TYP: Record<number, string> = {
  1: 'CURSOR',
  2: 'BITMAP',
  3: 'ICON',
  4: 'MENU',
  5: 'DIALOG',
  6: 'STRING',
  7: 'FONTDIR',
  8: 'FONT',
  9: 'ACCELERATOR',
  10: 'RCDATA',
  11: 'MESSAGETABLE',
  12: 'GROUP_CURSOR',
  14: 'GROUP_ICON',
  16: 'VERSION',
  17: 'DLGINCLUDE',
  19: 'PLUGPLAY',
  20: 'VXD',
  21: 'ANICURSOR',
  22: 'ANIICON',
  23: 'HTML',
  24: 'MANIFEST',
};

const DEBUG_TYP: Record<number, string> = {
  1: 'COFF',
  2: 'CODEVIEW',
  3: 'FPO',
  4: 'MISC',
  5: 'EXCEPTION',
  6: 'FIXUP',
  9: 'BORLAND',
  11: 'CLSID',
  12: 'VC_FEATURE',
  13: 'POGO',
  14: 'ILTCG',
  16: 'REPRO',
  20: 'EX_DLLCHARACTERISTICS',
};

/** Obergrenzen: schuetzen vor absurden Zahlen in fremden Headern. */
const MAX_SEKTIONEN = 96; // Grenze des Windows-Loaders
const MAX_DLLS = 256;
const MAX_THUNKS_JE_DLL = 4096;
const MAX_NAMEN_JE_DLL = 100;
const MAX_NAMEN_GESAMT = 4000;
const MAX_EXPORT_NAMEN = 200;
const MAX_RES_TYPEN = 64;
const MAX_DEBUG_EINTRAEGE = 16;
const MAX_VERSION_BYTES = 16 * 1024;
const ENTROPIE_STICHPROBE = 4096;
const ENTROPIE_MAX_SEKTIONEN = 32;
const ENTROPIE_PACKER = 7.2;

interface Sektion {
  index: number;
  name: string;
  virtualSize: number;
  va: number;
  rawSize: number;
  rawPtr: number;
  flags: number;
  /** Nutzbare Rohdaten-Laenge innerhalb der Datei (0 = nicht in der Datei). */
  rawLaenge: number;
}

interface Verzeichnis {
  rva: number;
  size: number;
}

const rechte = (f: number): string =>
  (f & 0x40000000 ? 'r' : '-') + (f & 0x80000000 ? 'w' : '-') + (f & 0x20000000 ? 'x' : '-');

const guidText = (b: Buffer, o: number): string => {
  const h = (x: number, n: number): string => x.toString(16).padStart(n, '0');
  const d4 = b.subarray(o + 8, o + 16).toString('hex');
  return `${h(b.readUInt32LE(o), 8)}-${h(b.readUInt16LE(o + 4), 4)}-${h(b.readUInt16LE(o + 6), 4)}-${d4.slice(0, 4)}-${d4.slice(4)}`;
};

const versionText = (ms: number, ls: number): string => `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;

/** Ergebnis der Versions-Ressource: Zeichenketten + feste Versionsnummern. */
function parseVersion(buf: Buffer): { strings: Record<string, string>; datei_version?: string; produkt_version?: string } {
  const strings: Record<string, string> = {};
  const aus: { strings: Record<string, string>; datei_version?: string; produkt_version?: string } = { strings };
  let knoten = 0;
  const align4 = (n: number): number => (n + 3) & ~3;

  const liesKnoten = (pos: number, grenze: number) => {
    if (pos + 6 > grenze) return null;
    const len = buf.readUInt16LE(pos);
    const valLen = buf.readUInt16LE(pos + 2);
    const typ = buf.readUInt16LE(pos + 4);
    if (len < 6) return null;
    const ende = Math.min(pos + len, grenze);
    let p = pos + 6;
    let key = '';
    while (p + 2 <= ende) {
      const c = buf.readUInt16LE(p);
      p += 2;
      if (c === 0) break;
      if (key.length < 64) key += String.fromCharCode(c);
    }
    const valStart = align4(p);
    const valBytes = typ === 1 ? valLen * 2 : valLen;
    return { key, typ, valStart, valBytes, kinderStart: align4(valStart + valBytes), ende, len };
  };

  const kinder = (start: number, ende: number, handler: (k: NonNullable<ReturnType<typeof liesKnoten>>) => void): void => {
    let pos = start;
    while (pos + 6 <= ende && knoten < 200) {
      const k = liesKnoten(pos, ende);
      if (!k) break;
      knoten++;
      handler(k);
      pos = align4(pos + k.len);
    }
  };

  const wurzel = liesKnoten(0, buf.length);
  if (!wurzel) return aus;
  if (wurzel.valBytes >= 52 && wurzel.valStart + 52 <= wurzel.ende && buf.readUInt32LE(wurzel.valStart) === 0xfeef04bd) {
    aus.datei_version = versionText(buf.readUInt32LE(wurzel.valStart + 8), buf.readUInt32LE(wurzel.valStart + 12));
    aus.produkt_version = versionText(buf.readUInt32LE(wurzel.valStart + 16), buf.readUInt32LE(wurzel.valStart + 20));
  }
  kinder(wurzel.kinderStart, wurzel.ende, info => {
    if (info.key !== 'StringFileInfo') return;
    kinder(info.kinderStart, info.ende, tabelle => {
      kinder(tabelle.kinderStart, tabelle.ende, eintrag => {
        if (eintrag.typ !== 1 || !eintrag.key || Object.keys(strings).length >= 40) return;
        const bis = Math.min(eintrag.valStart + eintrag.valBytes, eintrag.ende);
        if (eintrag.valStart >= bis) return;
        const text = bereinige(buf.toString('utf16le', eintrag.valStart, bis - ((bis - eintrag.valStart) % 2)).replace(/\u0000+$/, '')).slice(0, 256);
        if (!(eintrag.key in strings)) strings[bereinige(eintrag.key)] = text;
      });
    });
  });
  return aus;
}

async function inspectPe(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
  const w = new WarnSammler();
  const metadata: Record<string, unknown> = {};
  const spezifisch: Record<string, unknown> = {};
  const objekte: AssetObject[] = [];
  const referenzen: AssetReference[] = [];
  const refSet = new Set<string>();
  const maxObj = ctx.limits.maxObjects;
  let gekappt = false;

  const addObj = (o: AssetObject): void => {
    if (objekte.length >= maxObj) {
      gekappt = true;
      return;
    }
    objekte.push(o);
  };
  const addRef = (target: string, kind: string): void => {
    const k = kind + '\0' + target.toLowerCase();
    if (refSet.has(k)) return;
    if (referenzen.length >= maxObj) {
      gekappt = true;
      return;
    }
    refSet.add(k);
    referenzen.push({ target, kind });
  };
  const ergebnis = (status?: AssetStatus): AssetResult => {
    if (gekappt) w.add('objekte_gekappt_exe', `maxObjects=${maxObj} erreicht; weitere Objekte/Referenzen nicht aufgenommen.`);
    return erzeugeAssetResult(src.filePath, src.size, {
      asset_type: 'executable',
      format: 'pe',
      inspector: 'exe-pe',
      parser_version: INSPEKTOR_VERSION,
      status: status ?? (w.anzahl > 0 ? 'teilweise' : 'ok'),
      metadata,
      references: referenzen,
      objects: objekte,
      warnings: w.liste(),
      format_specific: spezifisch,
    });
  };

  // --- DOS-Header ---
  const dos = await src.readRange(0, 64);
  if (dos.length < 2 || dos[0] !== 0x4d || dos[1] !== 0x5a) {
    w.add('keine_mz_signatur', 'Kein "MZ" am Dateianfang; kein PE/DOS-Programm.');
    return ergebnis('fehler');
  }
  if (dos.length < 64) {
    w.add('dos_header_abgeschnitten', `Datei hat nur ${dos.length} Bytes, ein DOS-Header braucht 64.`);
    return ergebnis();
  }
  const lfanew = dos.readUInt32LE(0x3c);
  metadata.pe_header_offset = lfanew;
  if (lfanew < 4 || lfanew + 24 > src.size) {
    w.add('pe_header_ausserhalb_datei', `e_lfanew=${lfanew} verweist ausserhalb der Datei (${src.size} Bytes); abgeschnitten oder reiner DOS-Stub.`);
    return ergebnis();
  }

  // --- Signatur + COFF-Header ---
  const coffBuf = await src.readRange(lfanew, 24);
  if (coffBuf.length < 24) {
    w.add('pe_header_abgeschnitten', 'COFF-Header unvollstaendig lesbar.');
    return ergebnis();
  }
  if (coffBuf[0] !== 0x50 || coffBuf[1] !== 0x45 || coffBuf[2] !== 0 || coffBuf[3] !== 0) {
    const kennung = coffBuf.toString('latin1', 0, 2);
    const art = kennung === 'NE' ? 'ne' : kennung === 'LE' || kennung === 'LX' ? 'le' : 'dos_mz';
    spezifisch.dateityp = art;
    w.add('kein_pe_header', `An e_lfanew=${lfanew} steht keine "PE\\0\\0"-Signatur (${art}); kein Windows-PE.`);
    return ergebnis();
  }
  const coff = new BinaryReader(coffBuf, lfanew);
  coff.skip(4);
  const maschine = coff.u16le();
  const sektionenAngabe = coff.u16le();
  const zeitstempel = coff.u32le();
  const symbolZeiger = coff.u32le();
  const symbolAnzahl = coff.u32le();
  const optGroesse = coff.u16le();
  const merkmale = coff.u16le();

  const istDll = (merkmale & 0x2000) !== 0;
  metadata.architektur = MACHINE[maschine] ?? `unbekannt (0x${maschine.toString(16)})`;
  metadata.maschine_code = hexZahl(maschine);
  metadata.typ = istDll ? 'dll' : 'exe';
  metadata.zeitstempel = isoAusSekunden(zeitstempel);
  metadata.zeitstempel_roh = zeitstempel;
  if (zeitstempel * 1000 > Date.now() + 86_400_000) metadata.zeitstempel_hinweis = 'liegt_in_der_zukunft_evtl_reproduzierbarer_build';
  metadata.merkmale = {
    wert: hexZahl(merkmale),
    ausfuehrbar: (merkmale & 0x2) !== 0,
    dll: istDll,
    gross_adressierbar: (merkmale & 0x20) !== 0,
    relocs_entfernt: (merkmale & 0x1) !== 0,
    debug_entfernt: (merkmale & 0x200) !== 0,
    system: (merkmale & 0x1000) !== 0,
  };
  metadata.sektionen_laut_header = sektionenAngabe;
  if (symbolZeiger !== 0) spezifisch.coff_symboltabelle = { offset: symbolZeiger, anzahl: symbolAnzahl };

  const optStart = lfanew + 24;
  const sektStart = optStart + optGroesse;

  // --- Optional Header ---
  let plus = false;
  let imageBase = 0n;
  let sizeOfHeaders = 0;
  let einstiegRva = 0;
  const verz: Verzeichnis[] = [];
  let optBekannt = false;
  if (optGroesse === 0) {
    w.add('optional_header_fehlt', 'SizeOfOptionalHeader = 0: kein Optional Header (Objektdatei oder kaputtes PE).');
  } else {
    await phase('optional_header', w, async () => {
      if (optStart + optGroesse > src.size) w.add('optional_header_abgeschnitten', `Optional Header (${optGroesse} Bytes ab ${optStart}) reicht ueber das Dateiende.`);
      const buf = await src.readRange(optStart, Math.min(optGroesse, 240));
      const r = new BinaryReader(buf, optStart);
      const magic = r.u16le();
      if (magic !== 0x10b && magic !== 0x20b) {
        w.add('optional_header_magic_unbekannt', `Optional-Header-Magic 0x${magic.toString(16)} ist weder PE32 (0x10b) noch PE32+ (0x20b); Verzeichnisse werden nicht gelesen.`);
        return;
      }
      optBekannt = true;
      plus = magic === 0x20b;
      metadata.pe_variante = plus ? 'PE32+' : 'PE32';
      metadata.bits = plus ? 64 : 32;
      const linkerMajor = r.u8();
      const linkerMinor = r.u8();
      metadata.linker_version = `${linkerMajor}.${linkerMinor}`;
      const codeGroesse = r.u32le();
      r.skip(8); // SizeOfInitializedData, SizeOfUninitializedData
      einstiegRva = r.u32le();
      r.skip(4); // BaseOfCode
      if (!plus) r.skip(4); // BaseOfData
      imageBase = plus ? r.u64le() : BigInt(r.u32le());
      const sektAusrichtung = r.u32le();
      const dateiAusrichtung = r.u32le();
      r.skip(12); // OS-/Image-/Subsystem-Versionen (je zwei u16)
      r.skip(4); // Win32VersionValue
      const bildGroesse = r.u32le();
      sizeOfHeaders = r.u32le();
      const pruefsumme = r.u32le();
      const subsystem = r.u16le();
      const dllMerkmale = r.u16le();
      metadata.code_groesse = codeGroesse;
      metadata.einstiegspunkt_rva = hexZahl(einstiegRva);
      metadata.image_base = hexZahl(imageBase);
      metadata.image_groesse = bildGroesse;
      metadata.ausrichtung = { sektion: sektAusrichtung, datei: dateiAusrichtung };
      metadata.pruefsumme = pruefsumme;
      metadata.pruefsumme_gesetzt = pruefsumme !== 0;
      metadata.subsystem = SUBSYSTEM[subsystem] ?? `unbekannt (${subsystem})`;
      metadata.haertung = {
        aslr: (dllMerkmale & 0x40) !== 0,
        high_entropy_va: (dllMerkmale & 0x20) !== 0,
        dep_nx: (dllMerkmale & 0x100) !== 0,
        cfg: (dllMerkmale & 0x4000) !== 0,
        seh_aus: (dllMerkmale & 0x400) !== 0,
        appcontainer: (dllMerkmale & 0x1000) !== 0,
        signaturpflicht: (dllMerkmale & 0x80) !== 0,
        dll_merkmale: hexZahl(dllMerkmale),
      };
      r.skip(plus ? 32 : 16); // Stack-/Heap-Reserve/Commit
      r.skip(4); // LoaderFlags
      const anzahlVerz = r.u32le();
      if (anzahlVerz > 16) w.add('datenverzeichnisse_unplausibel', `NumberOfRvaAndSizes=${anzahlVerz} (erwartet <= 16); gelesen werden 16.`);
      const lesen = Math.min(anzahlVerz, 16, Math.floor(r.remaining / 8));
      if (lesen < Math.min(anzahlVerz, 16)) w.add('datenverzeichnisse_abgeschnitten', `Nur ${lesen} von ${Math.min(anzahlVerz, 16)} Datenverzeichnissen im Optional Header.`);
      for (let i = 0; i < lesen; i++) verz.push({ rva: r.u32le(), size: r.u32le() });
    });
  }

  // --- Sektionstabelle ---
  let nSekt = sektionenAngabe;
  if (nSekt > MAX_SEKTIONEN) {
    w.add('sektionszahl_unplausibel', `NumberOfSections=${sektionenAngabe} (Loader-Grenze ${MAX_SEKTIONEN}); gelesen werden hoechstens ${MAX_SEKTIONEN}.`);
    nSekt = MAX_SEKTIONEN;
  }
  const verfuegbar = sektStart < src.size ? Math.floor((src.size - sektStart) / 40) : 0;
  if (nSekt > verfuegbar) {
    if (sektionenAngabe > 0) w.add('sektionstabelle_abgeschnitten', `Sektionstabelle (${nSekt} Eintraege ab ${sektStart}) reicht ueber das Dateiende; lesbar: ${verfuegbar}.`);
    nSekt = verfuegbar;
  }
  const abschnitte: Sektion[] = [];
  const stringTabelleBasis = symbolZeiger !== 0 ? symbolZeiger + symbolAnzahl * 18 : 0;

  await phase('sektionen', w, async () => {
    if (nSekt <= 0) return;
    const buf = await src.readRange(sektStart, nSekt * 40);
    const n = Math.floor(buf.length / 40);
    const hohe: string[] = [];
    let ausserhalb = 0;
    let ueberlappt = false;
    for (let i = 0; i < n; i++) {
      ctx.pruefeAbbruch();
      const o = i * 40;
      let nameEnde = 0;
      while (nameEnde < 8 && buf[o + nameEnde] !== 0) nameEnde++;
      let name = bereinige(buf.toString('latin1', o, o + nameEnde));
      // Lange Namen ("/4", "/19") verweisen in die COFF-String-Tabelle (z. B. mingw-Debug-Sektionen).
      const lang = /^\/(\d{1,7})$/.exec(name);
      if (lang && stringTabelleBasis > 0) {
        const nb = stringTabelleBasis + Number(lang[1]);
        if (nb < src.size) {
          const rohName = await src.readRange(nb, MAX_NAME);
          const c = cstringAus(rohName, 0);
          if (c && c.text) name = c.text;
        }
      }
      const virtualSize = buf.readUInt32LE(o + 8);
      const va = buf.readUInt32LE(o + 12);
      const rawSize = buf.readUInt32LE(o + 16);
      const rawPtr = buf.readUInt32LE(o + 20);
      const flags = buf.readUInt32LE(o + 36);
      const rawLaenge = rawSize > 0 && rawPtr < src.size ? Math.min(rawSize, src.size - rawPtr) : 0;
      if (rawSize > 0 && rawPtr + rawSize > src.size) ausserhalb++;
      if (abschnitte.some(a => va < a.va + Math.max(a.virtualSize, a.rawSize) && a.va < va + Math.max(virtualSize, rawSize) && a.rawSize + a.virtualSize > 0 && rawSize + virtualSize > 0)) ueberlappt = true;
      const s: Sektion = { index: i, name, virtualSize, va, rawSize, rawPtr, flags, rawLaenge };
      abschnitte.push(s);

      let entro: number | null = null;
      if (rawLaenge > 0 && i < ENTROPIE_MAX_SEKTIONEN) {
        const stich = await src.readRange(rawPtr, Math.min(ENTROPIE_STICHPROBE, rawLaenge));
        entro = entropie(stich);
        if (entro >= ENTROPIE_PACKER && stich.length >= 512) hohe.push(name);
      }
      addObj({
        name,
        kind: 'sektion',
        data: {
          index: i,
          virtuelle_groesse: virtualSize,
          virtuelle_adresse: hexZahl(va),
          rohdaten_groesse: rawSize,
          rohdaten_offset: rawPtr,
          rechte: rechte(flags),
          schreibbar_und_ausfuehrbar: (flags & 0x80000000) !== 0 && (flags & 0x20000000) !== 0,
          enthaelt_code: (flags & 0x20) !== 0,
          merkmale: hexZahl(flags),
          entropie: entro,
          rohdaten_in_datei: rawSize === 0 || rawLaenge === rawSize,
        },
        source_range: rawLaenge > 0 ? { offset: rawPtr, length: rawLaenge } : { offset: sektStart + o, length: 40 },
      });
    }
    if (ausserhalb > 0) w.add('sektion_ausserhalb_datei', `${ausserhalb} Sektion(en) mit Rohdaten ausserhalb der Datei (${src.size} Bytes); dort wird nichts gelesen.`);
    if (ueberlappt) w.add('sektionen_ueberlappen', 'Sektionen ueberlappen im Adressraum; RVA-Aufloesung nimmt die erste passende.');
    metadata.sektionen_anzahl = n;
    metadata.packer_hinweis = hohe.length > 0 ? { sektionen_mit_hoher_entropie: hohe, schwelle: ENTROPIE_PACKER } : null;
  });

  // --- RVA-Aufloesung ---
  const rvaZuOffset = (rva: number): { offset: number; verfuegbar: number } | null => {
    if (!Number.isSafeInteger(rva) || rva < 0) return null;
    for (const s of abschnitte) {
      if (s.rawLaenge > 0 && rva >= s.va && rva - s.va < s.rawLaenge) {
        return { offset: s.rawPtr + (rva - s.va), verfuegbar: s.rawLaenge - (rva - s.va) };
      }
    }
    if (sizeOfHeaders > 0 && rva < sizeOfHeaders && rva < src.size) {
      return { offset: rva, verfuegbar: Math.min(sizeOfHeaders, src.size) - rva };
    }
    return null;
  };
  const leseRva = async (rva: number, len: number): Promise<Buffer | null> => {
    const m = rvaZuOffset(rva);
    if (!m) return null;
    const n = Math.min(len, m.verfuegbar);
    if (n <= 0) return null;
    const b = await src.readRange(m.offset, n);
    return b.length > 0 ? b : null;
  };
  const leseNameRva = async (rva: number, was: string): Promise<string | null> => {
    const buf = await leseRva(rva, MAX_NAME);
    if (!buf) return null;
    const c = cstringAus(buf, 0, MAX_NAME);
    if (!c) return null;
    if (!c.terminiert) w.add('name_ohne_nullterminator', `${was}: Name ohne Nullterminator (Sektionsende oder laenger als ${MAX_NAME} Bytes), gekappt.`);
    return c.text;
  };

  if (optBekannt) {
    // Einstiegspunkt
    if (einstiegRva !== 0) {
      const sek = abschnitte.find(s => einstiegRva >= s.va && einstiegRva < s.va + Math.max(s.virtualSize, s.rawSize));
      metadata.einstiegspunkt_sektion = sek ? sek.name : null;
      if (!sek && abschnitte.length > 0) w.add('einstiegspunkt_ausserhalb_sektionen', `Einstiegspunkt-RVA ${hexZahl(einstiegRva)} liegt in keiner Sektion.`);
    }

    let namenBudget = MAX_NAMEN_GESAMT;

    /** Liest eine Thunk-Liste (Import-Lookup-Tabelle); Namen nur fuer die ersten namenMax Eintraege. */
    const liesThunks = async (rva: number, namenMax: number): Promise<{ anzahl: number; eintraege: string[]; gekappt: boolean } | null> => {
      const es = plus ? 8 : 4;
      const m = rvaZuOffset(rva);
      if (!m) return null;
      const buf = await src.readRange(m.offset, Math.min(MAX_THUNKS_JE_DLL * es, m.verfuegbar));
      const n = Math.floor(buf.length / es);
      const eintraege: string[] = [];
      let anzahl = 0;
      let terminiert = false;
      for (let i = 0; i < n; i++) {
        if ((i & 255) === 0) ctx.pruefeAbbruch();
        const wert = plus ? buf.readBigUInt64LE(i * es) : BigInt(buf.readUInt32LE(i * es));
        if (wert === 0n) {
          terminiert = true;
          break;
        }
        anzahl++;
        if (eintraege.length >= namenMax) continue;
        const ordinal = plus ? wert >> 63n === 1n : wert >> 31n === 1n;
        if (ordinal) {
          eintraege.push('#' + Number(wert & 0xffffn));
        } else if (namenBudget > 0) {
          namenBudget--;
          const hn = await leseRva(Number(wert & 0x7fffffffn), 2 + MAX_NAME);
          const c = hn && hn.length > 2 ? cstringAus(hn, 2) : null;
          if (c && c.text) {
            if (!c.terminiert) w.add('name_ohne_nullterminator', 'Funktionsname ohne Nullterminator, gekappt.');
            eintraege.push(c.text);
          } else {
            w.add('import_name_ungueltig', 'Funktionsname-RVA verweist ausserhalb der Datei oder ins Leere.');
          }
        }
      }
      const kappung = !terminiert && n >= MAX_THUNKS_JE_DLL;
      if (!terminiert && !kappung) w.add('thunks_ohne_terminator', 'Import-Thunk-Liste endet ohne Null-Abschluss (Sektionsende erreicht).');
      return { anzahl, eintraege, gekappt: kappung };
    };

    // --- Import-Verzeichnis ---
    await phase('importe', w, async () => {
      const d = verz[1];
      if (!d || d.rva === 0) return;
      const m = rvaZuOffset(d.rva);
      if (!m) {
        w.add('import_verzeichnis_ausserhalb', `Import-Verzeichnis-RVA ${hexZahl(d.rva)} liegt ausserhalb der Sektionen/Datei.`);
        return;
      }
      const buf = await src.readRange(m.offset, Math.min((MAX_DLLS + 1) * 20, m.verfuegbar));
      const n = Math.floor(buf.length / 20);
      const gesehen = new Set<string>();
      let terminiert = false;
      let dlls = 0;
      for (let i = 0; i < n; i++) {
        ctx.pruefeAbbruch();
        const o = i * 20;
        const oft = buf.readUInt32LE(o);
        const zeit = buf.readUInt32LE(o + 4);
        const nameRva = buf.readUInt32LE(o + 12);
        const ft = buf.readUInt32LE(o + 16);
        if (nameRva === 0) {
          terminiert = true;
          break;
        }
        if (i >= MAX_DLLS) break;
        const schluessel = `${oft}:${ft}:${nameRva}`;
        if (gesehen.has(schluessel)) {
          w.add('import_zyklus', 'Import-Deskriptor wiederholt sich (zyklische oder gespiegelte Tabelle); Auswertung des Verzeichnisses hier beendet.');
          terminiert = true;
          break;
        }
        gesehen.add(schluessel);
        const dll = await leseNameRva(nameRva, 'DLL-Name');
        if (!dll) {
          w.add('import_name_ungueltig', 'DLL-Name-RVA verweist ausserhalb der Datei oder ins Leere.');
          continue;
        }
        const th = await liesThunks(oft !== 0 ? oft : ft, MAX_NAMEN_JE_DLL);
        if (!th) w.add('import_thunks_ausserhalb', `Thunk-Tabelle von "${dll}" liegt ausserhalb der Datei.`);
        addRef(dll, 'library');
        dlls++;
        addObj({
          name: dll,
          kind: 'import_dll',
          data: {
            funktionen_anzahl: th ? th.anzahl : null,
            funktionen: th ? th.eintraege : [],
            funktionen_gekappt: th ? th.gekappt || th.anzahl > th.eintraege.length : false,
            gebunden: zeit !== 0,
          },
          source_range: { offset: m.offset + o, length: 20 },
        });
      }
      if (!terminiert && n > MAX_DLLS) w.add('import_verzeichnis_gekappt', `Mehr als ${MAX_DLLS} Import-Deskriptoren; Rest nicht gelesen.`);
      else if (!terminiert) w.add('import_verzeichnis_ohne_ende', 'Import-Verzeichnis endet ohne Null-Deskriptor (Sektionsende erreicht).');
      spezifisch.import_dll_anzahl = dlls;
    });

    // --- Delay-Imports ---
    await phase('delay_importe', w, async () => {
      const d = verz[13];
      if (!d || d.rva === 0) return;
      const m = rvaZuOffset(d.rva);
      if (!m) {
        w.add('delay_import_verzeichnis_ausserhalb', `Delay-Import-RVA ${hexZahl(d.rva)} liegt ausserhalb der Datei.`);
        return;
      }
      const buf = await src.readRange(m.offset, Math.min((MAX_DLLS + 1) * 32, m.verfuegbar));
      const n = Math.floor(buf.length / 32);
      const gesehen = new Set<string>();
      let dlls = 0;
      for (let i = 0; i < n && i < MAX_DLLS; i++) {
        ctx.pruefeAbbruch();
        const o = i * 32;
        const attr = buf.readUInt32LE(o);
        const rohName = buf.readUInt32LE(o + 4);
        const rohInt = buf.readUInt32LE(o + 16);
        if (rohName === 0) break;
        // Attributes Bit 0: Felder sind RVAs; sonst (alte Linker) virtuelle Adressen.
        const zuRva = (v: number): number => ((attr & 1) !== 0 ? v : v - Number(imageBase & 0xffffffffn));
        const schluessel = `${rohName}:${rohInt}`;
        if (gesehen.has(schluessel)) {
          w.add('delay_import_zyklus', 'Delay-Import-Deskriptor wiederholt sich; Auswertung beendet.');
          break;
        }
        gesehen.add(schluessel);
        const dll = await leseNameRva(zuRva(rohName), 'Delay-Import-DLL');
        if (!dll) {
          w.add('delay_import_name_ungueltig', 'Delay-Import-DLL-Name verweist ausserhalb der Datei.');
          continue;
        }
        const th = rohInt !== 0 ? await liesThunks(zuRva(rohInt), MAX_NAMEN_JE_DLL) : null;
        addRef(dll, 'library');
        dlls++;
        addObj({
          name: dll,
          kind: 'delay_import_dll',
          data: {
            funktionen_anzahl: th ? th.anzahl : null,
            funktionen: th ? th.eintraege : [],
            funktionen_gekappt: th ? th.gekappt || th.anzahl > th.eintraege.length : false,
          },
          source_range: { offset: m.offset + o, length: 32 },
        });
      }
      spezifisch.delay_import_dll_anzahl = dlls;
    });

    // --- Export-Verzeichnis ---
    await phase('exporte', w, async () => {
      const d = verz[0];
      if (!d || d.rva === 0 || d.size === 0) return;
      const m = rvaZuOffset(d.rva);
      const kopf = await leseRva(d.rva, 40);
      if (!m || !kopf) {
        w.add('export_verzeichnis_ausserhalb', `Export-Verzeichnis-RVA ${hexZahl(d.rva)} liegt ausserhalb der Datei.`);
        return;
      }
      if (kopf.length < 40) {
        w.add('export_verzeichnis_abgeschnitten', 'Export-Verzeichnis unvollstaendig (weniger als 40 Bytes).');
        return;
      }
      const dllName = await leseNameRva(kopf.readUInt32LE(12), 'Export-DLL-Name');
      const basis = kopf.readUInt32LE(16);
      const nFunk = kopf.readUInt32LE(20);
      const nNamen = kopf.readUInt32LE(24);
      const funkRva = kopf.readUInt32LE(28);
      const namenRva = kopf.readUInt32LE(32);
      const ordRva = kopf.readUInt32LE(36);
      if (nFunk > 0xffff || nNamen > nFunk) {
        w.add('export_anzahl_unplausibel', `NumberOfFunctions=${nFunk}, NumberOfNames=${nNamen} (erwartet Namen <= Funktionen <= 65535).`);
      }
      const lesen = Math.min(nNamen, MAX_EXPORT_NAMEN);
      const namenBuf = lesen > 0 ? await leseRva(namenRva, lesen * 4) : null;
      const ordBuf = lesen > 0 ? await leseRva(ordRva, lesen * 2) : null;
      const eintraege: Array<Record<string, unknown>> = [];
      if (lesen > 0 && (!namenBuf || !ordBuf)) {
        w.add('export_namenstabelle_ausserhalb', 'Namens-/Ordinal-Tabelle des Export-Verzeichnisses liegt ausserhalb der Datei.');
      } else if (namenBuf && ordBuf) {
        const k = Math.min(lesen, Math.floor(namenBuf.length / 4), Math.floor(ordBuf.length / 2));
        if (k < lesen) w.add('export_namenstabelle_abgeschnitten', `Nur ${k} von ${lesen} Export-Namen lesbar.`);
        for (let i = 0; i < k; i++) {
          ctx.pruefeAbbruch();
          const name = await leseNameRva(namenBuf.readUInt32LE(i * 4), 'Export-Name');
          const idx = ordBuf.readUInt16LE(i * 2);
          if (name === null) {
            w.add('export_name_ungueltig', 'Export-Name-RVA verweist ausserhalb der Datei.');
            continue;
          }
          const e: Record<string, unknown> = { name, ordinal: basis + idx };
          if (idx < nFunk) {
            const fb = await leseRva(funkRva + idx * 4, 4);
            if (fb && fb.length === 4) {
              const frva = fb.readUInt32LE(0);
              if (frva >= d.rva && frva < d.rva + d.size) {
                const fw = await leseNameRva(frva, 'Export-Weiterleitung');
                if (fw) e.weiterleitung = fw;
              }
            }
          } else {
            w.add('export_ordinal_ausserhalb', 'Ein Namens-Ordinal zeigt hinter die Funktionstabelle.');
          }
          eintraege.push(e);
        }
      }
      addObj({
        name: dllName,
        kind: 'export_verzeichnis',
        data: {
          ordinal_basis: basis,
          funktionen_anzahl: nFunk,
          namen_anzahl: nNamen,
          nur_ordinal_anzahl: Math.max(0, nFunk - nNamen),
          namen: eintraege,
          namen_gekappt: nNamen > eintraege.length,
        },
        source_range: { offset: m.offset, length: Math.min(40, m.verfuegbar) },
      });
      metadata.export_dll_name = dllName;
    });

    // --- Ressourcen (nur oberste Ebene, plus Versionsinfo) ---
    await phase('ressourcen', w, async () => {
      const d = verz[2];
      if (!d || d.rva === 0) return;
      const m = rvaZuOffset(d.rva);
      if (!m) {
        w.add('ressourcen_verzeichnis_ausserhalb', `Ressourcen-RVA ${hexZahl(d.rva)} liegt ausserhalb der Datei.`);
        return;
      }
      const besucht = new Set<number>();
      const liesDir = async (off: number, maxEintraege: number) => {
        if (besucht.has(off)) {
          w.add('ressourcen_zyklus', 'Ressourcen-Verzeichnis verweist auf einen bereits besuchten Knoten (Zyklus); nicht weiter verfolgt.');
          return null;
        }
        besucht.add(off);
        const b = await leseRva(d.rva + off, 16 + maxEintraege * 8);
        if (!b || b.length < 16) {
          w.add('ressourcen_knoten_ausserhalb', 'Ressourcen-Knoten liegt ausserhalb der Datei.');
          return null;
        }
        const gesamt = b.readUInt16LE(12) + b.readUInt16LE(14);
        const n = Math.min(gesamt, maxEintraege, Math.floor((b.length - 16) / 8));
        const eintraege: Array<{ id: number; benannt: boolean; unter: boolean; offset: number }> = [];
        for (let i = 0; i < n; i++) {
          const name = b.readUInt32LE(16 + i * 8);
          const ziel = b.readUInt32LE(20 + i * 8);
          eintraege.push({ id: name & 0x7fffffff, benannt: name >>> 31 === 1, unter: ziel >>> 31 === 1, offset: ziel & 0x7fffffff });
        }
        return { gesamt, eintraege };
      };
      const wurzel = await liesDir(0, MAX_RES_TYPEN);
      if (!wurzel) return;
      const typen: Array<{ typ: string; anzahl: number }> = [];
      for (let i = 0; i < wurzel.eintraege.length; i++) {
        ctx.pruefeAbbruch();
        const e = wurzel.eintraege[i];
        let label: string;
        if (e.benannt) {
          const nb = await leseRva(d.rva + e.id, 2 + 128);
          const len = nb && nb.length >= 2 ? Math.min(nb.readUInt16LE(0), 64, Math.floor((nb.length - 2) / 2)) : 0;
          label = nb && len > 0 ? bereinige(nb.toString('utf16le', 2, 2 + len * 2)) : `benannt_${i}`;
        } else {
          label = RESSOURCEN_TYP[e.id] ?? `#${e.id}`;
        }
        let anzahl = 1;
        let sub: Awaited<ReturnType<typeof liesDir>> = null;
        if (e.unter) {
          sub = await liesDir(e.offset, 4);
          anzahl = sub ? sub.gesamt : 0;
        }
        typen.push({ typ: label, anzahl });
        addObj({
          name: label,
          kind: 'ressourcen_typ',
          data: { typ_id: e.benannt ? null : e.id, anzahl },
          source_range: { offset: m.offset + 16 + i * 8, length: 8 },
        });
        if (!e.benannt && e.id === 16 && sub && sub.eintraege.length > 0 && sub.eintraege[0].unter) {
          const sprache = await liesDir(sub.eintraege[0].offset, 2);
          if (sprache && sprache.eintraege.length > 0 && !sprache.eintraege[0].unter) {
            const de = await leseRva(d.rva + sprache.eintraege[0].offset, 16);
            if (de && de.length >= 8) {
              const dataRva = de.readUInt32LE(0);
              const groesse = de.readUInt32LE(4);
              const vb = groesse > 0 ? await leseRva(dataRva, Math.min(groesse, MAX_VERSION_BYTES)) : null;
              if (vb && vb.length >= 6) {
                const v = parseVersion(vb);
                metadata.versionsinfo = v.strings;
                if (v.datei_version) metadata.datei_version = v.datei_version;
                if (v.produkt_version) metadata.produkt_version = v.produkt_version;
              } else {
                w.add('versionsinfo_ausserhalb', 'Versions-Ressource liegt ausserhalb der Datei.');
              }
            }
          }
        }
      }
      spezifisch.ressourcen_typen = typen;
      if (wurzel.gesamt > wurzel.eintraege.length) w.add('ressourcen_typen_gekappt', `${wurzel.gesamt} Ressourcen-Typen, gelesen ${wurzel.eintraege.length}.`);
    });

    // --- Debug-Verzeichnis (PDB) ---
    await phase('debug', w, async () => {
      const d = verz[6];
      if (!d || d.rva === 0 || d.size === 0) return;
      const anzahl = Math.min(Math.floor(d.size / 28), MAX_DEBUG_EINTRAEGE);
      const buf = anzahl > 0 ? await leseRva(d.rva, anzahl * 28) : null;
      if (!buf) {
        w.add('debug_verzeichnis_ausserhalb', `Debug-Verzeichnis-RVA ${hexZahl(d.rva)} liegt ausserhalb der Datei.`);
        return;
      }
      const m = rvaZuOffset(d.rva);
      const typen: string[] = [];
      for (let i = 0; i < Math.floor(buf.length / 28); i++) {
        ctx.pruefeAbbruch();
        const o = i * 28;
        const typ = buf.readUInt32LE(o + 12);
        const groesse = buf.readUInt32LE(o + 16);
        const zeiger = buf.readUInt32LE(o + 24);
        const name = DEBUG_TYP[typ] ?? `#${typ}`;
        typen.push(name);
        addObj({
          name,
          kind: 'debug_eintrag',
          data: { typ, groesse, datei_offset: zeiger },
          source_range: { offset: (m?.offset ?? 0) + o, length: 28 },
        });
        if (typ === 2 && groesse >= 20 && zeiger > 0 && zeiger + 20 <= src.size) {
          const cv = await src.readRange(zeiger, Math.min(groesse, 20 + MAX_NAME));
          if (cv.length >= 24 && cv.toString('latin1', 0, 4) === 'RSDS') {
            const pfad = cstringAus(cv, 24);
            metadata.pdb = { pfad: pfad ? pfad.text : null, guid: guidText(cv, 4), alter: cv.readUInt32LE(20), format: 'RSDS' };
          } else if (cv.length >= 17 && cv.toString('latin1', 0, 4) === 'NB10') {
            const pfad = cstringAus(cv, 16);
            metadata.pdb = { pfad: pfad ? pfad.text : null, guid: null, alter: cv.readUInt32LE(12), format: 'NB10' };
          }
        } else if (typ === 2) {
          w.add('debug_codeview_ausserhalb', 'CodeView-Eintrag zeigt ausserhalb der Datei oder ist zu klein.');
        }
      }
      spezifisch.debug_typen = typen;
    });

    // --- Security-Verzeichnis (Authenticode: nur Vorhandensein) ---
    {
      const d = verz[4];
      const vorhanden = !!d && d.rva !== 0 && d.size !== 0;
      metadata.authenticode = {
        vorhanden,
        offset: vorhanden ? d.rva : null,
        groesse: vorhanden ? d.size : null,
        validiert: false,
      };
      if (vorhanden && d.rva + d.size > src.size) {
        w.add('security_verzeichnis_ausserhalb', `Security-Verzeichnis (${d.rva}+${d.size}) reicht ueber das Dateiende (${src.size}).`);
      }
    }

    // --- CLR-Header (.NET) ---
    await phase('clr', w, async () => {
      const d = verz[14];
      if (!d || d.rva === 0) {
        metadata.dotnet = { vorhanden: false };
        return;
      }
      const b = await leseRva(d.rva, 72);
      if (!b || b.length < 20) {
        w.add('clr_header_ungueltig', 'CLR-Header liegt ausserhalb der Datei oder ist abgeschnitten.');
        metadata.dotnet = { vorhanden: true, gueltig: false };
        return;
      }
      const flags = b.readUInt32LE(16);
      let laufzeit: string | null = null;
      const mdRva = b.readUInt32LE(8);
      const mb = mdRva !== 0 ? await leseRva(mdRva, 16 + MAX_NAME) : null;
      if (mb && mb.length >= 16 && mb.readUInt32LE(0) === 0x424a5342) {
        const len = Math.min(mb.readUInt32LE(12), MAX_NAME, mb.length - 16);
        const c = cstringAus(mb.subarray(16, 16 + len), 0, len);
        laufzeit = c ? c.text : null;
      }
      metadata.dotnet = {
        vorhanden: true,
        gueltig: true,
        clr_header_version: `${b.readUInt16LE(4)}.${b.readUInt16LE(6)}`,
        nur_il: (flags & 1) !== 0,
        strong_name_signiert: (flags & 8) !== 0,
        flags: hexZahl(flags),
        laufzeit_version: laufzeit,
      };
    });
  }

  // --- Overlay: Bytes hinter der letzten Sektion, ohne COFF-Symboltabelle und Zertifikat ---
  await phase('overlay', w, async () => {
    let start = abschnitte.reduce((m, a) => Math.max(m, a.rawLaenge > 0 ? a.rawPtr + a.rawLaenge : 0), 0);
    if (start === 0) return;
    if (symbolZeiger >= start && symbolZeiger < src.size) {
      const strGroesse = await src.readRange(symbolZeiger + symbolAnzahl * 18, 4);
      start = Math.max(start, symbolZeiger + symbolAnzahl * 18 + (strGroesse.length === 4 ? strGroesse.readUInt32LE(0) : 0));
    }
    const sec = verz[4];
    let rest = src.size - start;
    if (sec && sec.rva >= start && sec.rva + sec.size <= src.size) rest -= sec.size;
    if (rest > 0) metadata.overlay_bytes = rest;
  });

  spezifisch.sektionen_gelesen = abschnitte.length;
  return ergebnis();
}

/** PE-Inspektor: Magic 'MZ' am Dateianfang, Endungen der Windows-Programmdateien. */
export const peInspector: AssetInspector = {
  id: 'exe-pe',
  formats: ['pe'],
  extensions: ['.exe', '.dll', '.sys', '.ocx', '.scr', '.cpl', '.efi', '.drv'],
  magic: [{ offset: 0, bytes: [0x4d, 0x5a], format: 'pe' }],
  version: INSPEKTOR_VERSION,
  inspect: inspectPe,
};

