/**
 * MODUL: Asset-Intel ELF-Inspektor (T66b)
 * ZWECK: Liest Linux-ELF-Dateien (Binaries, .so, .o, Kernelmodule) rein lesend und liefert
 *        Klasse/Endian/ABI, Typ (EXEC/DYN/REL/CORE + PIE-Heuristik), Architektur, Programm-
 *        und Sektions-Header, DT_NEEDED-Abhaengigkeiten, SONAME/RPATH/RUNPATH, dynamische
 *        Symbole (importiert/exportiert), Symbolversionen (Verneed), Build-ID, ABI-Tag,
 *        Compiler-Kommentar, Kernelmodul-Infos und Haertungs-Merkmale.
 *
 * Das Programm wird NIE ausgefuehrt; es werden nur Bytes ueber AssetSource.readRange gelesen.
 * Alle Offsets/Groessen werden gegen die Dateigroesse geprueft; 64-Bit-Werte ueber 2^53 gelten
 * als "ausserhalb der Datei". Gestrippte Dateien und Dateien ohne Sektions-Header (nur
 * Programm-Header) werden sauber behandelt. Jede Phase laeuft isoliert (util.phase).
 *
 * GRENZE: Ohne Sektions-Header findet sich die dynamische Symboltabelle nur ueber DT_HASH; hat
 * eine solche Datei nur DT_GNU_HASH, wird die Symbolzahl mit Warnung 'dynsym_anzahl_unbekannt'
 * nicht ermittelt (DT_NEEDED, SONAME usw. bleiben davon unberuehrt).
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
import { MAX_NAME, WarnSammler, bereinige, cstringAus, hex, hexZahl, phase } from './util.js';

const INSPEKTOR_VERSION = 1;

const MACHINE: Record<number, string> = {
  0: 'keine',
  3: 'x86 (i386)',
  8: 'MIPS',
  20: 'PowerPC',
  21: 'PowerPC64',
  22: 'S390',
  40: 'ARM',
  42: 'SuperH',
  50: 'IA-64',
  62: 'x86-64',
  94: 'Xtensa',
  183: 'AArch64',
  243: 'RISC-V',
  247: 'eBPF',
  258: 'LoongArch',
};

const OS_ABI: Record<number, string> = {
  0: 'System V',
  1: 'HP-UX',
  2: 'NetBSD',
  3: 'GNU/Linux',
  6: 'Solaris',
  9: 'FreeBSD',
  12: 'OpenBSD',
  97: 'ARM',
  255: 'Standalone',
};

const E_TYP: Record<number, string> = { 0: 'NONE', 1: 'REL', 2: 'EXEC', 3: 'DYN', 4: 'CORE' };

const PT_NAME: Record<number, string> = {
  0: 'NULL',
  1: 'LOAD',
  2: 'DYNAMIC',
  3: 'INTERP',
  4: 'NOTE',
  5: 'SHLIB',
  6: 'PHDR',
  7: 'TLS',
  0x6474e550: 'GNU_EH_FRAME',
  0x6474e551: 'GNU_STACK',
  0x6474e552: 'GNU_RELRO',
  0x6474e553: 'GNU_PROPERTY',
};

const SHT_NAME: Record<number, string> = {
  0: 'NULL',
  1: 'PROGBITS',
  2: 'SYMTAB',
  3: 'STRTAB',
  4: 'RELA',
  5: 'HASH',
  6: 'DYNAMIC',
  7: 'NOTE',
  8: 'NOBITS',
  9: 'REL',
  10: 'SHLIB',
  11: 'DYNSYM',
  14: 'INIT_ARRAY',
  15: 'FINI_ARRAY',
  16: 'PREINIT_ARRAY',
  17: 'GROUP',
  18: 'SYMTAB_SHNDX',
  0x6ffffff6: 'GNU_HASH',
  0x6ffffffd: 'GNU_VERDEF',
  0x6ffffffe: 'GNU_VERNEED',
  0x6fffffff: 'GNU_VERSYM',
};

const SHT_NOBITS = 8;
const SHT_NOTE = 7;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_DYNAMIC = 6;
const SHT_DYNSYM = 11;
const SHT_VERNEED = 0x6ffffffe;

/** Obergrenzen gegen absurde Zahlen in fremden Headern. */
const MAX_PHNUM = 512;
const MAX_SHNUM = 4096;
const MAX_DYN_EINTRAEGE = 4096;
const MAX_NEEDED = 1024;
const MAX_SYMBOLE = 4_000_000;
const SYMBOL_CHUNK = 4096;
const MAX_SYMBOLNAMEN = 200;
const MAX_NOTES = 64;
const MAX_STRTAB_BYTES = 1024 * 1024;
const MAX_KLEIN = 64 * 1024;
const MAX_VERSIONS_ENTRIES = 256;
const MAXSAFE = BigInt(Number.MAX_SAFE_INTEGER);

interface Segment {
  index: number;
  typ: number;
  flags: number;
  offset: number;
  vaddr: number;
  filesz: number;
  memsz: number;
  align: number;
}

interface ElfSektion {
  index: number;
  name: string;
  typ: number;
  flags: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  info: number;
  entsize: number;
}

const rwx = (f: number): string => (f & 4 ? 'r' : '-') + (f & 2 ? 'w' : '-') + (f & 1 ? 'x' : '-');
const ausgerichtet4 = (n: number): number => (n + 3) & ~3;

function sektFlags(f: number): string {
  const low = Number.isFinite(f) ? f % 0x100000000 : 0;
  let s = '';
  if (low & 1) s += 'W';
  if (low & 2) s += 'A';
  if (low & 4) s += 'X';
  if (low & 0x10) s += 'M';
  if (low & 0x20) s += 'S';
  if (low & 0x400) s += 'T';
  return s;
}

/** Vergleichbare Zahl fuer "GLIBC_2.17" -> [2, 17] bzw. null. */
function glibcVersion(s: string): number[] | null {
  const m = /^GLIBC_(\d+(?:\.\d+)*)$/.exec(s);
  return m ? m[1].split('.').map(Number) : null;
}

function vergleiche(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function inspectElf(src: AssetSource, ctx: AssetContext): Promise<AssetResult> {
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
    const k = kind + '\0' + target;
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
      format: 'elf',
      inspector: 'exe-elf',
      parser_version: INSPEKTOR_VERSION,
      status: status ?? (w.anzahl > 0 ? 'teilweise' : 'ok'),
      metadata,
      references: referenzen,
      objects: objekte,
      warnings: w.liste(),
      format_specific: spezifisch,
    });
  };

  // --- e_ident ---
  const kopf = await src.readRange(0, 64);
  if (kopf.length < 4 || kopf[0] !== 0x7f || kopf[1] !== 0x45 || kopf[2] !== 0x4c || kopf[3] !== 0x46) {
    w.add('elf_magic_fehlt', 'Kein "\\x7fELF" am Dateianfang; kein ELF.');
    return ergebnis('fehler');
  }
  if (kopf.length < 16) {
    w.add('elf_header_abgeschnitten', `Datei hat nur ${kopf.length} Bytes, e_ident braucht 16.`);
    return ergebnis();
  }
  const klasse = kopf[4];
  const daten = kopf[5];
  if (klasse !== 1 && klasse !== 2) {
    w.add('elf_klasse_ungueltig', `EI_CLASS=${klasse} (erwartet 1=32 Bit, 2=64 Bit).`);
    return ergebnis();
  }
  if (daten !== 1 && daten !== 2) {
    w.add('elf_endian_ungueltig', `EI_DATA=${daten} (erwartet 1=little, 2=big).`);
    return ergebnis();
  }
  const is64 = klasse === 2;
  const le = daten === 1;
  metadata.bits = is64 ? 64 : 32;
  metadata.endian = le ? 'little' : 'big';
  metadata.os_abi = OS_ABI[kopf[7]] ?? `unbekannt (${kopf[7]})`;
  metadata.abi_version = kopf[8];
  metadata.ident_version = kopf[6];

  const rd16 = (b: Buffer, o: number): number => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const rd32 = (b: Buffer, o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  /** u64 als Zahl; ueber 2^53 -> Infinity (liegt dann sicher ausserhalb jeder Datei). */
  const rd64 = (b: Buffer, o: number): number => {
    const v = le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o);
    return v > MAXSAFE ? Number.POSITIVE_INFINITY : Number(v);
  };
  const rdWord = (b: Buffer, o: number): number => (is64 ? rd64(b, o) : rd32(b, o));
  const imDatei = (off: number, len: number): boolean =>
    Number.isFinite(off) && Number.isFinite(len) && off >= 0 && len >= 0 && off + len <= src.size;

  // --- ELF-Header ---
  let eTyp = -1;
  let maschine = -1;
  let entry = 0n;
  let phoff = 0;
  let shoff = 0;
  let phentsize = 0;
  let phnum = 0;
  let shentsize = 0;
  let shnum = 0;
  let shstrndx = 0;
  const hdrLen = is64 ? 64 : 52;
  const kopfOk = await phase('elf_header', w, async () => {
    if (kopf.length < hdrLen) w.add('elf_header_abgeschnitten', `ELF-Header unvollstaendig (${kopf.length} von ${hdrLen} Bytes); nur die lesbaren Felder werden ausgewertet.`);
    const r = new BinaryReader(kopf, 0);
    r.skip(16);
    const u16 = (): number => (le ? r.u16le() : r.u16be());
    const u32 = (): number => (le ? r.u32le() : r.u32be());
    const u64 = (): bigint => (le ? r.u64le() : r.u64be());
    const wort = (): bigint => (is64 ? u64() : BigInt(u32()));
    eTyp = u16();
    metadata.typ = E_TYP[eTyp] ?? `unbekannt (${eTyp})`;
    maschine = u16();
    metadata.architektur = MACHINE[maschine] ?? `unbekannt (${maschine})`;
    metadata.maschine_code = maschine;
    u32(); // e_version
    entry = wort();
    metadata.einstiegspunkt = hexZahl(entry);
    const po = wort();
    const so = wort();
    phoff = po > MAXSAFE ? Number.POSITIVE_INFINITY : Number(po);
    shoff = so > MAXSAFE ? Number.POSITIVE_INFINITY : Number(so);
    metadata.flags = hexZahl(u32());
    u16(); // e_ehsize
    phentsize = u16();
    phnum = u16();
    shentsize = u16();
    shnum = u16();
    shstrndx = u16();
  });
  if (!kopfOk) return ergebnis();

  // --- Hilfsleser ---
  /** Liest [off, off+len) wenn komplett in der Datei, sonst null. max kappt die Lesemenge. */
  const leseBereich = async (off: number, len: number, max: number): Promise<Buffer | null> => {
    if (!imDatei(off, len)) return null;
    if (len === 0) return Buffer.alloc(0);
    return src.readRange(off, Math.min(len, max));
  };

  // --- Programm-Header ---
  const segmente: Segment[] = [];
  await phase('programm_header', w, async () => {
    if (phoff === 0 || phnum === 0) return;
    const minEnt = is64 ? 56 : 32;
    if (phentsize < minEnt) {
      w.add('phentsize_ungueltig', `e_phentsize=${phentsize} ist kleiner als ${minEnt}; Programm-Header werden nicht gelesen.`);
      return;
    }
    let n = phnum;
    if (n > MAX_PHNUM) {
      w.add('phnum_unplausibel', `e_phnum=${phnum} (Grenze ${MAX_PHNUM}); gelesen werden hoechstens ${MAX_PHNUM}.`);
      n = MAX_PHNUM;
    }
    const verfuegbar = Number.isFinite(phoff) && phoff < src.size ? Math.floor((src.size - phoff) / phentsize) : 0;
    if (n > verfuegbar) {
      w.add('programm_header_abgeschnitten', `Programm-Header-Tabelle (${n} Eintraege ab ${phoff}) reicht ueber das Dateiende; lesbar: ${verfuegbar}.`);
      n = verfuegbar;
    }
    if (n <= 0) return;
    const buf = await src.readRange(phoff, n * phentsize);
    const lesbar = Math.floor(buf.length / phentsize);
    let ausserhalb = 0;
    for (let i = 0; i < lesbar; i++) {
      ctx.pruefeAbbruch();
      const o = i * phentsize;
      const s: Segment = is64
        ? { index: i, typ: rd32(buf, o), flags: rd32(buf, o + 4), offset: rd64(buf, o + 8), vaddr: rd64(buf, o + 16), filesz: rd64(buf, o + 32), memsz: rd64(buf, o + 40), align: rd64(buf, o + 48) }
        : { index: i, typ: rd32(buf, o), offset: rd32(buf, o + 4), vaddr: rd32(buf, o + 8), filesz: rd32(buf, o + 16), memsz: rd32(buf, o + 20), flags: rd32(buf, o + 24), align: rd32(buf, o + 28) };
      segmente.push(s);
      const inDatei = s.filesz > 0 && imDatei(s.offset, s.filesz);
      if (s.filesz > 0 && !inDatei) ausserhalb++;
      addObj({
        name: PT_NAME[s.typ] ?? `0x${s.typ.toString(16)}`,
        kind: 'segment',
        data: {
          index: i,
          typ: s.typ,
          rechte: rwx(s.flags),
          datei_offset: s.offset,
          virtuelle_adresse: Number.isFinite(s.vaddr) ? hexZahl(s.vaddr) : null,
          datei_groesse: s.filesz,
          speicher_groesse: s.memsz,
          ausrichtung: s.align,
          in_datei: s.filesz === 0 || inDatei,
        },
        source_range: inDatei ? { offset: s.offset, length: s.filesz } : { offset: phoff + o, length: phentsize },
      });
    }
    if (ausserhalb > 0) w.add('segment_ausserhalb_datei', `${ausserhalb} Segment(e) mit Dateibereich ausserhalb der Datei (${src.size} Bytes).`);
  });

  // PT_INTERP, Stack, RELRO
  let interpreter: string | null = null;
  const interpSeg = segmente.find(s => s.typ === 3);
  if (interpSeg) {
    await phase('interpreter', w, async () => {
      const b = await leseBereich(interpSeg.offset, Math.min(interpSeg.filesz, MAX_NAME), MAX_NAME);
      if (!b) {
        w.add('interpreter_ausserhalb', 'PT_INTERP zeigt ausserhalb der Datei.');
        return;
      }
      const c = cstringAus(b, 0);
      if (c) {
        interpreter = c.text;
        if (!c.terminiert) w.add('name_ohne_nullterminator', 'PT_INTERP-Pfad ohne Nullterminator, gekappt.');
      }
    });
  }
  const stackSeg = segmente.find(s => s.typ === 0x6474e551);
  const hatRelro = segmente.some(s => s.typ === 0x6474e552);

  // --- Sektions-Header ---
  const sekt: ElfSektion[] = [];
  let shstr: Buffer | null = null;
  const hatSektionsHeader = shoff !== 0;
  await phase('sektions_header', w, async () => {
    if (!hatSektionsHeader) return;
    const minEnt = is64 ? 64 : 40;
    if (shentsize < minEnt) {
      w.add('shentsize_ungueltig', `e_shentsize=${shentsize} ist kleiner als ${minEnt}; Sektions-Header werden nicht gelesen.`);
      return;
    }
    if (!Number.isFinite(shoff) || shoff >= src.size) {
      w.add('sektions_header_ausserhalb', `e_shoff=${Number.isFinite(shoff) ? shoff : '(> 2^53)'} liegt ausserhalb der Datei (${src.size} Bytes).`);
      return;
    }
    const lese = (buf: Buffer, o: number, index: number): ElfSektion =>
      is64
        ? { index, name: '', typ: rd32(buf, o + 4), flags: rd64(buf, o + 8), addr: rd64(buf, o + 16), offset: rd64(buf, o + 24), size: rd64(buf, o + 32), link: rd32(buf, o + 40), info: rd32(buf, o + 44), entsize: rd64(buf, o + 56) }
        : { index, name: '', typ: rd32(buf, o + 4), flags: rd32(buf, o + 8), addr: rd32(buf, o + 12), offset: rd32(buf, o + 16), size: rd32(buf, o + 20), link: rd32(buf, o + 24), info: rd32(buf, o + 28), entsize: rd32(buf, o + 36) };
    const nameOffs: number[] = [];
    let n = shnum;
    let strIdx = shstrndx;
    if (shnum === 0 || shstrndx === 0xffff) {
      // Erweiterte Zaehlung: die echte Zahl steht in sh_size, der echte shstrndx in sh_link der Sektion 0.
      const null0 = await leseBereich(shoff, shentsize, shentsize);
      if (null0 && null0.length >= minEnt) {
        const s0 = lese(null0, 0, 0);
        if (shnum === 0) n = Number.isFinite(s0.size) ? s0.size : 0;
        if (shstrndx === 0xffff) strIdx = s0.link;
      }
    }
    if (n > MAX_SHNUM) {
      w.add('shnum_unplausibel', `Sektionszahl ${n} (Grenze ${MAX_SHNUM}); gelesen werden hoechstens ${MAX_SHNUM}.`);
      n = MAX_SHNUM;
    }
    const verfuegbar = Math.floor((src.size - shoff) / shentsize);
    if (n > verfuegbar) {
      w.add('sektions_header_abgeschnitten', `Sektions-Header-Tabelle (${n} Eintraege ab ${shoff}) reicht ueber das Dateiende; lesbar: ${verfuegbar}.`);
      n = verfuegbar;
    }
    if (n <= 0) return;
    const buf = await src.readRange(shoff, n * shentsize);
    const lesbar = Math.floor(buf.length / shentsize);
    for (let i = 0; i < lesbar; i++) {
      ctx.pruefeAbbruch();
      const o = i * shentsize;
      sekt.push(lese(buf, o, i));
      nameOffs.push(rd32(buf, o));
    }
    // Namenstabelle
    if (strIdx >= sekt.length) {
      if (shstrndx !== 0) w.add('shstrndx_ungueltig', `e_shstrndx=${strIdx} zeigt hinter die ${sekt.length} Sektionen; Sektionsnamen unbekannt.`);
    } else {
      const st = sekt[strIdx];
      if (st.typ !== SHT_STRTAB) {
        w.add('shstrtab_falscher_typ', 'Die Sektionsnamen-Tabelle (e_shstrndx) ist keine STRTAB-Sektion.');
      } else {
        const b = await leseBereich(st.offset, st.size, MAX_STRTAB_BYTES);
        if (b) shstr = b;
        else w.add('shstrtab_ausserhalb', 'Sektionsnamen-Tabelle liegt ausserhalb der Datei.');
      }
    }
    let ausserhalb = 0;
    for (let i = 0; i < sekt.length; i++) {
      const s = sekt[i];
      if (shstr) {
        const c = cstringAus(shstr, nameOffs[i], MAX_NAME);
        if (c) {
          s.name = c.text;
          if (!c.terminiert) w.add('name_ohne_nullterminator', 'Sektionsname ohne Nullterminator (Tabellenende), gekappt.');
        } else if (i > 0) {
          w.add('sektionsname_ausserhalb', 'Ein Sektionsname zeigt hinter die Namenstabelle.');
        }
      }
      const hatDaten = s.typ !== SHT_NOBITS && s.typ !== 0 && s.size > 0;
      const inDatei = hatDaten && imDatei(s.offset, s.size);
      if (hatDaten && !inDatei) ausserhalb++;
      addObj({
        name: s.name,
        kind: 'sektion',
        data: {
          index: i,
          typ: SHT_NAME[s.typ] ?? `0x${s.typ.toString(16)}`,
          flags: sektFlags(s.flags),
          adresse: Number.isFinite(s.addr) ? hexZahl(s.addr) : null,
          datei_offset: s.offset,
          groesse: s.size,
          link: s.link,
          info: s.info,
          eintragsgroesse: s.entsize,
          in_datei: !hatDaten || inDatei,
        },
        source_range: inDatei ? { offset: s.offset, length: s.size } : { offset: shoff + i * shentsize, length: shentsize },
      });
    }
    if (ausserhalb > 0) w.add('sektion_ausserhalb_datei', `${ausserhalb} Sektion(en) mit Daten ausserhalb der Datei (${src.size} Bytes).`);
  });
  const sektNachName = (name: string): ElfSektion | undefined => sekt.find(s => s.name === name);

  /** Virtuelle Adresse -> Dateioffset ueber die LOAD-Segmente. */
  const vaddrZuOffset = (v: number): number | null => {
    for (const s of segmente) {
      if (s.typ === 1 && s.filesz > 0 && v >= s.vaddr && v - s.vaddr < s.filesz) {
        const off = s.offset + (v - s.vaddr);
        return imDatei(off, 1) ? off : null;
      }
    }
    return null;
  };

  // --- Dynamischer Abschnitt ---
  const dyn = {
    gefunden: false,
    needed: [] as number[],
    soname: -1,
    rpath: -1,
    runpath: -1,
    strtab: -1,
    strsz: 0,
    flags: 0,
    flags1: 0,
    bindNow: false,
    symtab: -1,
    hash: -1,
  };
  await phase('dynamic', w, async () => {
    const dynSek = sekt.find(s => s.typ === SHT_DYNAMIC);
    const dynSeg = segmente.find(s => s.typ === 2);
    const quelle = dynSeg ? { off: dynSeg.offset, len: dynSeg.filesz } : dynSek ? { off: dynSek.offset, len: dynSek.size } : null;
    if (!quelle) return;
    const buf = await leseBereich(quelle.off, quelle.len, MAX_KLEIN);
    if (!buf) {
      w.add('dynamic_ausserhalb', 'Der dynamische Abschnitt liegt ausserhalb der Datei.');
      return;
    }
    dyn.gefunden = true;
    const es = is64 ? 16 : 8;
    const n = Math.min(Math.floor(buf.length / es), MAX_DYN_EINTRAEGE);
    let ende = false;
    for (let i = 0; i < n; i++) {
      if ((i & 255) === 0) ctx.pruefeAbbruch();
      const tag = is64 ? rd64(buf, i * es) : rd32(buf, i * es);
      const val = is64 ? rd64(buf, i * es + 8) : rd32(buf, i * es + 4);
      if (tag === 0) {
        ende = true;
        break;
      }
      switch (tag) {
        case 1:
          if (dyn.needed.length < MAX_NEEDED) dyn.needed.push(val);
          break;
        case 4:
          dyn.hash = val;
          break;
        case 5:
          dyn.strtab = val;
          break;
        case 6:
          dyn.symtab = val;
          break;
        case 10:
          dyn.strsz = val;
          break;
        case 14:
          dyn.soname = val;
          break;
        case 15:
          dyn.rpath = val;
          break;
        case 24:
          dyn.bindNow = true;
          break;
        case 29:
          dyn.runpath = val;
          break;
        case 30:
          dyn.flags = val;
          break;
        case 0x6ffffffb:
          dyn.flags1 = val;
          break;
        default:
          break;
      }
    }
    if (!ende) w.add('dynamic_ohne_ende', 'Der dynamische Abschnitt endet ohne DT_NULL (gekappt oder abgeschnitten).');
  });

  // --- Dynamische String-Tabelle ---
  let dynstr: Buffer | null = null;
  await phase('dynstr', w, async () => {
    if (!dyn.gefunden && !sekt.some(s => s.typ === SHT_DYNSYM)) return;
    const dynSek = sekt.find(s => s.typ === SHT_DYNAMIC);
    const ausSektion = dynSek && dynSek.link > 0 && dynSek.link < sekt.length && sekt[dynSek.link].typ === SHT_STRTAB ? sekt[dynSek.link] : sektNachName('.dynstr');
    if (ausSektion && ausSektion.typ === SHT_STRTAB) {
      dynstr = await leseBereich(ausSektion.offset, ausSektion.size, MAX_STRTAB_BYTES);
      if (dynstr) return;
    }
    if (dyn.strtab >= 0 && dyn.strsz > 0) {
      const off = vaddrZuOffset(dyn.strtab);
      if (off !== null) {
        const len = Math.min(dyn.strsz, src.size - off);
        dynstr = await leseBereich(off, len, MAX_STRTAB_BYTES);
        if (dynstr) return;
      }
    }
    if (dyn.needed.length > 0 || dyn.soname >= 0) w.add('dynstr_nicht_lesbar', 'Die dynamische String-Tabelle (DT_STRTAB) ist nicht lesbar; Namen von Abhaengigkeiten fehlen.');
  });
  const dynName = (off: number, was: string): string | null => {
    if (!dynstr) return null;
    const c = cstringAus(dynstr, off, MAX_NAME);
    if (!c) {
      w.add('dynstr_offset_ausserhalb', `${was}: Offset in die String-Tabelle liegt hinter deren Ende.`);
      return null;
    }
    if (!c.terminiert) w.add('name_ohne_nullterminator', `${was}: Name ohne Nullterminator (Tabellenende), gekappt.`);
    return c.text;
  };
  const needed: string[] = [];
  for (const off of dyn.needed) {
    const n = dynName(off, 'DT_NEEDED');
    if (n) {
      needed.push(n);
      addRef(n, 'library');
    }
  }
  const soname = dyn.soname >= 0 ? dynName(dyn.soname, 'DT_SONAME') : null;
  const rpath = dyn.rpath >= 0 ? dynName(dyn.rpath, 'DT_RPATH') : null;
  const runpath = dyn.runpath >= 0 ? dynName(dyn.runpath, 'DT_RUNPATH') : null;

  // --- Dynamische Symbole ---
  let stackSchutz: boolean | null = null;
  let fortify: boolean | null = null;
  await phase('dynsym', w, async () => {
    const ent = is64 ? 24 : 16;
    let off = -1;
    let bytes = 0;
    let entsize = ent;
    const ds = sekt.find(s => s.typ === SHT_DYNSYM);
    if (ds) {
      off = ds.offset;
      bytes = ds.size;
      if (ds.entsize >= ent && Number.isFinite(ds.entsize)) entsize = ds.entsize;
    } else if (!hatSektionsHeader && dyn.symtab >= 0) {
      if (dyn.hash < 0) {
        w.add('dynsym_anzahl_unbekannt', 'Ohne Sektions-Header ist die Zahl der dynamischen Symbole nur ueber DT_HASH ermittelbar; diese Datei hat keins.');
        return;
      }
      const hOff = vaddrZuOffset(dyn.hash);
      const sOff = vaddrZuOffset(dyn.symtab);
      const hb = hOff !== null ? await leseBereich(hOff, 8, 8) : null;
      if (hb === null || sOff === null || hb.length < 8) {
        w.add('dynsym_ausserhalb', 'DT_HASH oder DT_SYMTAB liegen ausserhalb der Datei.');
        return;
      }
      off = sOff;
      bytes = rd32(hb, 4) * ent; // nchain = Zahl der Symbole
    } else {
      return;
    }
    if (!Number.isFinite(off) || off >= src.size) {
      w.add('dynsym_ausserhalb', 'Die dynamische Symboltabelle liegt ausserhalb der Datei.');
      return;
    }
    let anzahl = Math.floor(bytes / entsize);
    const inDatei = Math.floor((src.size - off) / entsize);
    if (anzahl > inDatei) {
      w.add('dynsym_abgeschnitten', `Die dynamische Symboltabelle (${anzahl} Eintraege) reicht ueber das Dateiende; lesbar: ${inDatei}.`);
      anzahl = inDatei;
    }
    if (anzahl > MAX_SYMBOLE) {
      w.add('dynsym_gekappt', `Mehr als ${MAX_SYMBOLE} dynamische Symbole; gezaehlt werden ${MAX_SYMBOLE}.`);
      anzahl = MAX_SYMBOLE;
    }
    let importiert = 0;
    let exportiert = 0;
    let lokal = 0;
    const impNamen: string[] = [];
    const expNamen: string[] = [];
    let stackChk = false;
    let chk = false;
    let gezaehlt = 0;
    try {
      for (let start = 0; start < anzahl; start += SYMBOL_CHUNK) {
        ctx.pruefeAbbruch();
        const cnt = Math.min(SYMBOL_CHUNK, anzahl - start);
        const buf = await src.readRange(off + start * entsize, cnt * entsize);
        const lesbar = Math.floor(buf.length / entsize);
        for (let k = 0; k < lesbar; k++) {
          const o = k * entsize;
          const idx = start + k;
          gezaehlt++;
          if (idx === 0) continue;
          const nameOff = rd32(buf, o);
          const info = is64 ? buf[o + 4] : buf[o + 12];
          const shndx = is64 ? rd16(buf, o + 6) : rd16(buf, o + 14);
          const bind = info >> 4;
          const undef = shndx === 0;
          const global = bind === 1 || bind === 2 || bind === 10;
          if (!undef && !global) {
            lokal++;
            continue;
          }
          const c = dynstr ? cstringAus(dynstr, nameOff, MAX_NAME) : null;
          const name = c ? c.text : '';
          if (undef) {
            if (name === '') continue;
            importiert++;
            if (name === '__stack_chk_fail') stackChk = true;
            if (name.startsWith('__') && name.endsWith('_chk')) chk = true;
            if (impNamen.length < MAX_SYMBOLNAMEN) impNamen.push(name);
          } else {
            exportiert++;
            if (expNamen.length < MAX_SYMBOLNAMEN) expNamen.push(name);
          }
        }
        if (lesbar < cnt) break;
      }
    } finally {
      // Auch bei Lesegrenze/Abbruch: was gezaehlt wurde, bleibt als Teilergebnis stehen.
      metadata.dynsym_gezaehlt = gezaehlt;
    }
    if (dynstr) {
      stackSchutz = stackChk;
      fortify = chk;
    }
    addObj({
      name: '.dynsym',
      kind: 'dynamische_symbole',
      data: {
        anzahl_eintraege: anzahl,
        importiert_anzahl: importiert,
        exportiert_anzahl: exportiert,
        lokal_anzahl: lokal,
        importiert: impNamen,
        importiert_gekappt: importiert > impNamen.length,
        exportiert: expNamen,
        exportiert_gekappt: exportiert > expNamen.length,
      },
      source_range: { offset: off, length: anzahl * entsize },
    });
    metadata.symbole = { importiert: importiert, exportiert: exportiert };
  });

  // --- Symbolversionen (Verneed) ---
  await phase('symbolversionen', w, async () => {
    const vn = sekt.find(s => s.typ === SHT_VERNEED);
    if (!vn) return;
    const buf = await leseBereich(vn.offset, vn.size, MAX_KLEIN);
    if (!buf) {
      w.add('verneed_ausserhalb', 'Die Versions-Anforderungen (.gnu.version_r) liegen ausserhalb der Datei.');
      return;
    }
    let strs: Buffer | null = dynstr;
    if (vn.link > 0 && vn.link < sekt.length && sekt[vn.link].typ === SHT_STRTAB) {
      strs = (await leseBereich(sekt[vn.link].offset, sekt[vn.link].size, MAX_STRTAB_BYTES)) ?? dynstr;
    }
    if (!strs) return;
    const name = (o: number): string => {
      const c = cstringAus(strs as Buffer, o, MAX_NAME);
      return c ? c.text : '';
    };
    const gesehen = new Set<number>();
    const liste: Array<{ datei: string; versionen: string[] }> = [];
    let hoechste: number[] | null = null;
    let off = 0;
    const eintraege = Math.min(vn.info, MAX_VERSIONS_ENTRIES);
    for (let i = 0; i < eintraege; i++) {
      ctx.pruefeAbbruch();
      if (off + 16 > buf.length || gesehen.has(off)) {
        if (gesehen.has(off)) w.add('verneed_zyklus', 'Die Versions-Anforderungen verweisen auf sich selbst (Zyklus); Auswertung beendet.');
        else w.add('verneed_abgeschnitten', 'Die Versions-Anforderungen enden vor der angekuendigten Eintragszahl.');
        break;
      }
      gesehen.add(off);
      const cnt = rd16(buf, off + 2);
      const datei = name(rd32(buf, off + 4));
      const aux = rd32(buf, off + 8);
      const next = rd32(buf, off + 12);
      const versionen: string[] = [];
      let ao = off + aux;
      for (let j = 0; j < Math.min(cnt, MAX_VERSIONS_ENTRIES); j++) {
        if (ao + 16 > buf.length || gesehen.has(ao)) break;
        gesehen.add(ao);
        const v = name(rd32(buf, ao + 8));
        if (v) {
          versionen.push(v);
          const gv = glibcVersion(v);
          if (gv && (!hoechste || vergleiche(gv, hoechste) > 0)) hoechste = gv;
        }
        const an = rd32(buf, ao + 12);
        if (an === 0) break;
        ao += an;
      }
      liste.push({ datei, versionen });
      if (next === 0) break;
      off += next;
    }
    spezifisch.symbolversionen = liste;
    if (hoechste) metadata.hoechste_glibc_version = (hoechste as number[]).join('.');
  });

  // --- Symtab (gestrippt?) ---
  const symtab = sekt.find(s => s.typ === SHT_SYMTAB);
  if (hatSektionsHeader && sekt.length > 0) {
    metadata.gestrippt = !symtab;
    if (symtab) {
      const ent = Number.isFinite(symtab.entsize) && symtab.entsize > 0 ? symtab.entsize : is64 ? 24 : 16;
      metadata.symtab_eintraege = Math.floor(symtab.size / ent);
    }
  } else {
    metadata.gestrippt = null;
    metadata.sektions_header_vorhanden = false;
  }

  // --- Notes (Build-ID, ABI-Tag, Go-Build-ID) ---
  await phase('notes', w, async () => {
    const regionen: Array<{ off: number; len: number }> = [];
    for (const s of segmente) if (s.typ === 4) regionen.push({ off: s.offset, len: s.filesz });
    if (regionen.length === 0) for (const s of sekt) if (s.typ === SHT_NOTE) regionen.push({ off: s.offset, len: s.size });
    const notes: Array<Record<string, unknown>> = [];
    for (const rg of regionen) {
      const buf = await leseBereich(rg.off, rg.len, MAX_KLEIN);
      if (!buf) {
        w.add('note_ausserhalb', 'Ein Note-Bereich liegt ausserhalb der Datei.');
        continue;
      }
      let pos = 0;
      while (pos + 12 <= buf.length && notes.length < MAX_NOTES) {
        ctx.pruefeAbbruch();
        const ns = rd32(buf, pos);
        const ds = rd32(buf, pos + 4);
        const typ = rd32(buf, pos + 8);
        const nameStart = pos + 12;
        const descStart = nameStart + ausgerichtet4(ns);
        const ende = descStart + ausgerichtet4(ds);
        if (ns > buf.length || ds > buf.length || ende > buf.length + 3 || descStart > buf.length) {
          w.add('note_ungueltig', 'Eine Note hat Laengenangaben, die ueber ihren Bereich hinausgehen; Rest des Bereichs uebersprungen.');
          break;
        }
        const nname = bereinige(buf.toString('utf8', nameStart, Math.min(nameStart + ns, buf.length)).replace(/\0+$/, ''));
        const desc = buf.subarray(descStart, Math.min(descStart + ds, buf.length));
        if (nname === 'GNU' && typ === 3) {
          metadata.build_id = hex(desc);
        } else if (nname === 'GNU' && typ === 1 && desc.length >= 16) {
          const os = rd32(desc as Buffer, 0);
          metadata.abi_tag = { os: ['Linux', 'GNU', 'Solaris', 'FreeBSD'][os] ?? `unbekannt (${os})`, mindestversion: `${rd32(desc as Buffer, 4)}.${rd32(desc as Buffer, 8)}.${rd32(desc as Buffer, 12)}` };
        } else if (nname === 'Go' && typ === 4) {
          metadata.go_build_id = bereinige(desc.toString('utf8').replace(/\0+$/, '')).slice(0, 200);
        }
        notes.push({ name: nname, typ, groesse: ds });
        pos = ende;
      }
    }
    if (notes.length > 0) spezifisch.notes = notes;
  });

  // --- .comment (Compiler) ---
  await phase('comment', w, async () => {
    const c = sektNachName('.comment');
    if (!c || c.typ === SHT_NOBITS) return;
    const buf = await leseBereich(c.offset, c.size, 4096);
    if (!buf) {
      w.add('comment_ausserhalb', 'Die Sektion .comment liegt ausserhalb der Datei.');
      return;
    }
    const teile = [...new Set(buf.toString('utf8').split('\0').map(s => bereinige(s.trim())).filter(s => s !== ''))].slice(0, 16);
    if (teile.length > 0) metadata.compiler = teile;
  });

  // --- Kernelmodul (.modinfo) ---
  await phase('modinfo', w, async () => {
    const m = sektNachName('.modinfo');
    const istModul = !!m || !!sektNachName('.gnu.linkonce.this_module');
    if (!istModul) return;
    const info: Record<string, string> = {};
    if (m && m.typ !== SHT_NOBITS) {
      const buf = await leseBereich(m.offset, m.size, 16 * 1024);
      if (buf) {
        for (const eintrag of buf.toString('utf8').split('\0')) {
          const i = eintrag.indexOf('=');
          if (i <= 0 || Object.keys(info).length >= 64) continue;
          const k = bereinige(eintrag.slice(0, i));
          if (!(k in info)) info[k] = bereinige(eintrag.slice(i + 1)).slice(0, 256);
        }
      } else {
        w.add('modinfo_ausserhalb', 'Die Sektion .modinfo liegt ausserhalb der Datei.');
      }
    }
    metadata.kernelmodul = { ist_modul: true, ...info };
  });

  // --- Zusammenfassung ---
  const dynFlags1PIE = (dyn.flags1 & 0x08000000) !== 0;
  let art: string;
  if (eTyp === 1) art = metadata.kernelmodul ? 'kernelmodul' : 'objektdatei';
  else if (eTyp === 2) art = 'ausfuehrbar';
  else if (eTyp === 3) art = interpreter !== null || dynFlags1PIE ? 'pie_ausfuehrbar' : 'shared_object';
  else if (eTyp === 4) art = 'core_dump';
  else art = 'unbekannt';
  metadata.art = art;
  metadata.interpreter = interpreter;
  metadata.soname = soname;
  metadata.rpath = rpath;
  metadata.runpath = runpath;
  metadata.abhaengigkeiten = needed;
  metadata.statisch_gelinkt = (eTyp === 2 || art === 'pie_ausfuehrbar') && interpreter === null && !dyn.gefunden ? true : (eTyp === 2 || art === 'pie_ausfuehrbar') ? false : null;
  const bindNow = dyn.bindNow || (dyn.flags & 0x8) !== 0 || (dyn.flags1 & 0x1) !== 0;
  metadata.haertung = {
    pie: eTyp === 3 ? art === 'pie_ausfuehrbar' : eTyp === 2 ? false : null,
    relro: hatRelro ? (bindNow ? 'voll' : 'teilweise') : 'keine',
    bind_now: bindNow,
    stack_ausfuehrbar: stackSeg ? (stackSeg.flags & 1) !== 0 : null,
    nx: stackSeg ? (stackSeg.flags & 1) === 0 : null,
    stack_schutz: stackSchutz,
    fortify,
  };
  spezifisch.programm_header_anzahl = segmente.length;
  spezifisch.sektions_header_anzahl = sekt.length;
  if (!stackSeg && segmente.length > 0) spezifisch.hinweis_gnu_stack = 'PT_GNU_STACK fehlt (aeltere Toolchain: Stack gilt als ausfuehrbar)';
  return ergebnis();
}

/** ELF-Inspektor: Magic 7F 'E' 'L' 'F', Endungen der Linux-Binaerdateien. */
export const elfInspector: AssetInspector = {
  id: 'exe-elf',
  formats: ['elf'],
  extensions: ['.so', '.o', '.ko', '.elf'],
  magic: [{ offset: 0, bytes: [0x7f, 0x45, 0x4c, 0x46], format: 'elf' }],
  version: INSPEKTOR_VERSION,
  inspect: inspectElf,
};
