/**
 * Fixture-Generator fuer die PE/ELF-Inspektor-Tests (P4-T66 Teil b).
 * Erzeugt Dateien DETERMINISTISCH in einem Verzeichnis unter os.tmpdir() — es werden KEINE
 * Binaerdateien eingecheckt. Programme werden NIE ausgefuehrt: gcc/mingw uebersetzen nur,
 * erzeugte Binaries werden nur als Bytes gelesen.
 *
 * ZWEI QUELLEN:
 *  - ECHT: von gcc / x86_64-w64-mingw32-gcc / i686-w64-mingw32-gcc / strip erzeugte Dateien
 *    (nur wenn das Werkzeug vorhanden ist; sonst fehlt der Schluessel in `echt`).
 *  - HANDGEBAUT: baueMinimalPe() / baueMinimalElf() setzen Dateien nach Spezifikation zusammen
 *    (32/64 Bit, little/big endian). Sie liefern zusaetzlich `layout` mit Dateioffsets, damit
 *    Tests gezielt Bytes verbiegen koennen (boesartige Dateien).
 *
 * AUFRUF: node packages/core/scripts/asset-fixtures-exe.mjs   (gibt das Verzeichnis aus)
 * ALS MODUL: const { dir, pfade, echt, aufraeumen } = await erzeugeExeFixtures();
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Kleine Helfer
// ---------------------------------------------------------------------------------------------

/** Deterministische Pseudo-Zufallsbytes (LCG), z. B. fuer "gepackte" Sektionen. */
export function zufallBytes(n, seed = 12345) {
  const b = Buffer.alloc(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
}

const u16le = n => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32le = n => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64le = n => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const zstr = s => Buffer.concat([Buffer.from(s, 'latin1'), Buffer.from([0])]);
const pad = (buf, n, fill = 0) => {
  const rest = (n - (buf.length % n)) % n;
  return rest === 0 ? buf : Buffer.concat([buf, Buffer.alloc(rest, fill)]);
};

/** Setzt ein u32 (LE) in eine Kopie des Buffers. */
export function patchU32(buf, offset, wert) {
  const k = Buffer.from(buf);
  k.writeUInt32LE(wert >>> 0, offset);
  return k;
}
/** Setzt ein u16 (LE) in eine Kopie des Buffers. */
export function patchU16(buf, offset, wert) {
  const k = Buffer.from(buf);
  k.writeUInt16LE(wert & 0xffff, offset);
  return k;
}
/** Setzt ein Byte in eine Kopie des Buffers. */
export function patchU8(buf, offset, wert) {
  const k = Buffer.from(buf);
  k[offset] = wert & 0xff;
  return k;
}

/** Wachsender Bereich mit bekannter Basis-RVA (fuer PE-Sektionen). */
class Bereich {
  constructor(rva) {
    this.rva = rva;
    this.teile = [];
    this.len = 0;
  }
  /** Haengt Bytes an, liefert die RVA des ersten Bytes. */
  add(buf) {
    const r = this.rva + this.len;
    this.teile.push(buf);
    this.len += buf.length;
    return r;
  }
  ausrichten(n) {
    const rest = (n - (this.len % n)) % n;
    if (rest) this.add(Buffer.alloc(rest));
  }
  buffer() {
    return Buffer.concat(this.teile);
  }
}

// ---------------------------------------------------------------------------------------------
// PE-Baukasten
// ---------------------------------------------------------------------------------------------

/** VS_VERSIONINFO-Knoten: key (UTF-16), value, Typ, Kinder. Ohne Schluss-Padding. */
function versionKnoten(key, wert, text, kinder = []) {
  const k = Buffer.concat([Buffer.from(key, 'utf16le'), Buffer.alloc(2)]);
  let koerper = Buffer.concat([pad(Buffer.concat([Buffer.alloc(6), k]), 4), wert]);
  if (kinder.length > 0) {
    koerper = pad(koerper, 4);
    kinder.forEach((c, i) => {
      koerper = Buffer.concat([koerper, i < kinder.length - 1 ? pad(c, 4) : c]);
    });
  }
  koerper.writeUInt16LE(koerper.length, 0);
  koerper.writeUInt16LE(text ? wert.length / 2 : wert.length, 2);
  koerper.writeUInt16LE(text ? 1 : 0, 4);
  return koerper;
}

/** Baut eine VERSION-Ressource. fest = [a,b,c,d] Dateiversion, strings = { Name: Wert }. */
export function versionsRessource(fest, strings) {
  const fixed = Buffer.alloc(52);
  fixed.writeUInt32LE(0xfeef04bd, 0);
  fixed.writeUInt32LE(0x10000, 4);
  fixed.writeUInt32LE(((fest[0] << 16) | fest[1]) >>> 0, 8);
  fixed.writeUInt32LE(((fest[2] << 16) | fest[3]) >>> 0, 12);
  fixed.writeUInt32LE(((fest[0] << 16) | fest[1]) >>> 0, 16);
  fixed.writeUInt32LE(((fest[2] << 16) | fest[3]) >>> 0, 20);
  const eintraege = Object.entries(strings).map(([k, v]) =>
    versionKnoten(k, Buffer.concat([Buffer.from(v, 'utf16le'), Buffer.alloc(2)]), true)
  );
  const tabelle = versionKnoten('040904b0', Buffer.alloc(0), true, eintraege);
  const sfi = versionKnoten('StringFileInfo', Buffer.alloc(0), true, [tabelle]);
  return versionKnoten('VS_VERSION_INFO', fixed, false, [sfi]);
}

/**
 * Baut ein Minimal-PE nach Spezifikation.
 * opts: plus (PE32+), dll, machine, subsystem, dllChars, zeitstempel, imports [{dll, funcs:[name|ordinal]}],
 *  delay [{dll, funcs}], exports {dllName, names:[..], base, nurOrdinal}, version {fest, strings}, manifest,
 *  ressourcenZyklus, debugPdb, security, clr, zufallText, importZyklus.
 * Rueckgabe: { buf, layout }.
 */
export function baueMinimalPe(opts = {}) {
  const plus = !!opts.plus;
  const dll = opts.dll !== false;
  const machine = opts.machine ?? (plus ? 0x8664 : 0x14c);
  const rdataRva = 0x2000;
  const rsrcRva = 0x3000;
  const rdata = new Bereich(rdataRva);
  const RAW_TEXT = 0x200;
  const RAW_RDATA = 0x400;

  const schwelle = plus ? 8 : 4;
  const thunk = v => (plus ? u64le(v) : u32le(v));
  const ordinalBit = plus ? 0x8000000000000000n : 0x80000000n;
  const thunkListe = funcs => {
    const eintraege = [];
    for (const f of funcs) {
      if (typeof f === 'number') {
        eintraege.push(plus ? u64le(ordinalBit | BigInt(f)) : u32le(Number(ordinalBit | BigInt(f))));
      } else {
        const r = rdata.add(Buffer.concat([u16le(0), zstr(f)]));
        rdata.ausrichten(2);
        eintraege.push(thunk(r));
      }
    }
    eintraege.push(thunk(0));
    return Buffer.concat(eintraege);
  };

  // --- Importe ---
  const importEintraege = [];
  for (const im of opts.imports ?? []) {
    const nameRva = rdata.add(zstr(im.dll));
    rdata.ausrichten(2);
    const iltRva = rdata.add(thunkListe(im.funcs));
    rdata.ausrichten(4);
    importEintraege.push({ nameRva, iltRva });
  }
  // --- Delay-Importe ---
  const delayEintraege = [];
  for (const im of opts.delay ?? []) {
    const nameRva = rdata.add(zstr(im.dll));
    rdata.ausrichten(2);
    const intRva = rdata.add(thunkListe(im.funcs));
    rdata.ausrichten(4);
    delayEintraege.push({ nameRva, intRva });
  }
  // --- Exporte ---
  let exportRva = 0;
  let exportSize = 0;
  if (opts.exports) {
    const ex = opts.exports;
    const names = ex.names ?? [];
    const nurOrd = ex.nurOrdinal ?? 0;
    const base = ex.base ?? 1;
    const dllNameRva = rdata.add(zstr(ex.dllName));
    const nameRvas = names.map(n => {
      const r = rdata.add(zstr(n));
      return r;
    });
    rdata.ausrichten(4);
    const nFunk = names.length + nurOrd;
    // Funktions-RVAs zeigen in .text
    const funkRva = rdata.add(Buffer.concat(Array.from({ length: nFunk }, (_, i) => u32le(0x1000 + i * 4))));
    // Namenstabelle muss sortiert sein; Reihenfolge der Eingabe wird nicht veraendert (Test-Fixture).
    const namenRva = rdata.add(Buffer.concat(nameRvas.map(r => u32le(r))));
    const ordRva = rdata.add(Buffer.concat(names.map((_, i) => u16le(i))));
    rdata.ausrichten(4);
    const exStart = rdata.len;
    exportRva = rdata.add(
      Buffer.concat([
        u32le(0),
        u32le(opts.zeitstempel ?? 0x5f000000),
        u16le(0),
        u16le(0),
        u32le(dllNameRva),
        u32le(base),
        u32le(nFunk),
        u32le(names.length),
        u32le(funkRva),
        u32le(namenRva),
        u32le(ordRva),
      ])
    );
    void exStart;
    exportSize = 40;
  }
  // --- Debug (CodeView) ---
  let debugRva = 0;
  let debugSize = 0;
  if (opts.debugPdb) {
    const guid = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const cv = Buffer.concat([Buffer.from('RSDS'), guid, u32le(7), zstr(opts.debugPdb)]);
    rdata.ausrichten(4);
    const cvRva = rdata.add(cv);
    rdata.ausrichten(4);
    const cvFileOff = RAW_RDATA + (cvRva - rdataRva);
    debugRva = rdata.add(
      Buffer.concat([u32le(0), u32le(0x5f000000), u16le(0), u16le(0), u32le(2), u32le(cv.length), u32le(cvRva), u32le(cvFileOff)])
    );
    debugSize = 28;
  }
  // --- CLR ---
  let clrRva = 0;
  if (opts.clr) {
    const verText = pad(zstr('v4.0.30319'), 4);
    const md = Buffer.concat([u32le(0x424a5342), u16le(1), u16le(1), u32le(0), u32le(verText.length), verText, u16le(0), u16le(0)]);
    rdata.ausrichten(4);
    const mdRva = rdata.add(md);
    rdata.ausrichten(4);
    clrRva = rdata.add(
      Buffer.concat([u32le(72), u16le(2), u16le(5), u32le(mdRva), u32le(md.length), u32le(1), u32le(0), Buffer.alloc(72 - 24)])
    );
  }
  // --- Import-/Delay-Deskriptoren zuletzt (Zyklus: Deskriptor wiederholt, ohne Terminator) ---
  rdata.ausrichten(4);
  let importRva = 0;
  let importSize = 0;
  if (importEintraege.length > 0 || opts.importZyklus) {
    const ds = importEintraege.map(e => Buffer.concat([u32le(e.iltRva), u32le(0), u32le(0), u32le(e.nameRva), u32le(e.iltRva)]));
    let tabelle;
    if (opts.importZyklus && ds.length > 0) tabelle = Buffer.concat([ds[0], ds[0], ds[0]]);
    else tabelle = Buffer.concat([...ds, Buffer.alloc(20)]);
    importRva = rdata.add(tabelle);
    importSize = tabelle.length;
  }
  let delayRva = 0;
  if (delayEintraege.length > 0) {
    rdata.ausrichten(4);
    const ds = delayEintraege.map(e => Buffer.concat([u32le(1), u32le(e.nameRva), u32le(0), u32le(0), u32le(e.intRva), u32le(0), u32le(0), u32le(0)]));
    delayRva = rdata.add(Buffer.concat([...ds, Buffer.alloc(32)]));
  }
  const rdataBuf = rdata.buffer();
  const rdataRaw = pad(rdataBuf, 0x200);

  // --- Ressourcen ---
  const rsrc = [];
  const typen = []; // [{id, eintraege:[{id, blob}]}]
  if (opts.version) typen.push({ id: 16, eintraege: [{ id: 1, blob: versionsRessource(opts.version.fest, opts.version.strings) }] });
  if (opts.manifest) typen.push({ id: 24, eintraege: [{ id: 1, blob: Buffer.from('<assembly manifestVersion="1.0"/>') }] });
  if (opts.icons) typen.unshift({ id: 3, eintraege: Array.from({ length: opts.icons }, (_, i) => ({ id: i + 1, blob: Buffer.alloc(16, i + 1) })) });
  let rsrcBuf = Buffer.alloc(0);
  if (typen.length > 0) {
    // Layout: Wurzel | Typ-Verzeichnisse | Sprach-Verzeichnisse | Daten-Eintraege | Blobs
    let pos = 16 + typen.length * 8;
    const typPos = typen.map(t => {
      const p = pos;
      pos += 16 + t.eintraege.length * 8;
      return p;
    });
    const sprachPos = [];
    for (const t of typen) for (const _e of t.eintraege) { sprachPos.push(pos); pos += 16 + 8; }
    const datenPos = [];
    for (const t of typen) for (const _e of t.eintraege) { datenPos.push(pos); pos += 16; }
    const blobPos = [];
    const blobs = [];
    for (const t of typen) for (const e of t.eintraege) { blobPos.push(pos); blobs.push(e.blob); pos += pad(e.blob, 4).length; }
    const dir = (anzahlId, eintr) => Buffer.concat([u32le(0), u32le(0), u16le(0), u16le(0), u16le(0), u16le(anzahlId), ...eintr]);
    const teile = [];
    teile.push(dir(typen.length, typen.map((t, i) => Buffer.concat([u32le(t.id), u32le(0x80000000 | typPos[i])]))));
    let k = 0;
    for (let i = 0; i < typen.length; i++) {
      const t = typen[i];
      teile.push(dir(t.eintraege.length, t.eintraege.map((e, j) => Buffer.concat([u32le(e.id), u32le(0x80000000 | sprachPos[k + j])]))));
      k += t.eintraege.length;
    }
    k = 0;
    for (const t of typen) for (const _e of t.eintraege) { teile.push(dir(1, [Buffer.concat([u32le(0x409), u32le(datenPos[k])])])); k++; }
    k = 0;
    for (const t of typen) for (const e of t.eintraege) { teile.push(Buffer.concat([u32le(rsrcRva + blobPos[k]), u32le(e.blob.length), u32le(0), u32le(0)])); k++; }
    for (const b of blobs) teile.push(pad(b, 4));
    rsrcBuf = Buffer.concat(teile);
    if (opts.ressourcenZyklus) {
      // Erster Typ-Eintrag zeigt zurueck auf die Wurzel (Offset 0, Unterverzeichnis-Bit).
      rsrcBuf.writeUInt32LE(0x80000000, 16 + 4);
    }
  }
  const rsrcRaw = rsrcBuf.length > 0 ? pad(rsrcBuf, 0x200) : Buffer.alloc(0);

  // --- Sektionen ---
  const textRaw = opts.zufallText ? zufallBytes(0x200, 7) : Buffer.alloc(0x200, 0xcc);
  const sektionen = [{ name: '.text', va: 0x1000, vsize: 0x100, raw: textRaw, flags: 0x60000020 }];
  if (rdataRaw.length > 0) sektionen.push({ name: '.rdata', va: rdataRva, vsize: rdataBuf.length, raw: rdataRaw, flags: 0x40000040 });
  if (rsrcRaw.length > 0) sektionen.push({ name: '.rsrc', va: rsrcRva, vsize: rsrcBuf.length, raw: rsrcRaw, flags: 0x40000040 });

  // --- Header ---
  const optSize = plus ? 240 : 224;
  const lfanew = 0x80;
  const dos = Buffer.alloc(lfanew);
  dos.write('MZ', 0, 'latin1');
  dos.writeUInt32LE(lfanew, 0x3c);
  const nSekt = sektionen.length;
  const sizeOfHeaders = 0x200;
  let imageEnde = 0x1000;
  for (const s of sektionen) imageEnde = Math.max(imageEnde, s.va + Math.max(s.vsize, 0x1000));
  const verz = Array.from({ length: 16 }, () => [0, 0]);
  verz[0] = [exportRva, exportSize];
  verz[1] = [importRva, importSize];
  if (rsrcRaw.length > 0) verz[2] = [rsrcRva, rsrcBuf.length];
  verz[6] = [debugRva, debugSize];
  verz[13] = [delayRva, delayRva ? 64 : 0];
  verz[14] = [clrRva, clrRva ? 72 : 0];

  const coff = Buffer.concat([
    Buffer.from('PE\0\0', 'latin1'),
    u16le(machine),
    u16le(nSekt),
    u32le(opts.zeitstempel ?? 0x5f000000),
    u32le(0),
    u32le(0),
    u16le(optSize),
    u16le((dll ? 0x2000 : 0) | 0x2 | 0x20 | (plus ? 0 : 0x100)),
  ]);
  const opt = Buffer.alloc(optSize);
  let o = 0;
  opt.writeUInt16LE(plus ? 0x20b : 0x10b, o); o += 2;
  opt[o++] = 14; opt[o++] = 29; // Linker 14.29
  opt.writeUInt32LE(0x200, o); o += 4; // SizeOfCode
  o += 8; // Init/Uninit
  opt.writeUInt32LE(0x1000, o); o += 4; // EntryPoint
  opt.writeUInt32LE(0x1000, o); o += 4; // BaseOfCode
  if (!plus) { opt.writeUInt32LE(0x2000, o); o += 4; } // BaseOfData
  if (plus) { opt.writeBigUInt64LE(0x180000000n, o); o += 8; } else { opt.writeUInt32LE(0x10000000, o); o += 4; }
  opt.writeUInt32LE(0x1000, o); o += 4; // SectionAlignment
  opt.writeUInt32LE(0x200, o); o += 4; // FileAlignment
  o += 8; // OS + Image Version
  opt.writeUInt16LE(6, o); opt.writeUInt16LE(0, o + 2); o += 4; // Subsystem Version
  o += 4; // Win32Version
  opt.writeUInt32LE(imageEnde, o); o += 4;
  opt.writeUInt32LE(sizeOfHeaders, o); o += 4;
  opt.writeUInt32LE(opts.checksum ?? 0, o); o += 4;
  opt.writeUInt16LE(opts.subsystem ?? 3, o); o += 2;
  opt.writeUInt16LE(opts.dllChars ?? 0x8160, o); o += 2; // HIGH_ENTROPY|DYNAMIC_BASE|NX|TS_AWARE ... 0x8160
  o += plus ? 32 : 16; // Stack/Heap
  o += 4; // LoaderFlags
  opt.writeUInt32LE(16, o); o += 4;
  const dirStart = o;
  for (let i = 0; i < 16; i++) {
    opt.writeUInt32LE(verz[i][0], o); o += 4;
    opt.writeUInt32LE(verz[i][1], o); o += 4;
  }

  const sektTab = [];
  let rawPtr = sizeOfHeaders;
  const sektLayout = [];
  for (const s of sektionen) {
    const kopf = Buffer.alloc(40);
    kopf.write(s.name, 0, 'latin1');
    kopf.writeUInt32LE(s.vsize, 8);
    kopf.writeUInt32LE(s.va, 12);
    kopf.writeUInt32LE(s.raw.length, 16);
    kopf.writeUInt32LE(rawPtr, 20);
    kopf.writeUInt32LE(s.flags, 36);
    sektTab.push(kopf);
    sektLayout.push({ name: s.name, rawPtr, rawSize: s.raw.length, va: s.va });
    rawPtr += s.raw.length;
  }
  const kopfTeil = pad(Buffer.concat([dos, coff, opt, ...sektTab]), sizeOfHeaders);
  let buf = Buffer.concat([kopfTeil, ...sektionen.map(s => s.raw)]);
  const layout = {
    lfanew,
    coffOffset: lfanew,
    optOffset: lfanew + 24,
    dirOffset: lfanew + 24 + dirStart,
    sektionTabelle: lfanew + 24 + optSize,
    sektionen: sektLayout,
    importRva,
    exportRva,
    rdataRaw: RAW_RDATA,
    textRaw: RAW_TEXT,
  };
  if (opts.security) {
    const cert = Buffer.concat([u32le(64), u16le(0x200), u16le(2), Buffer.alloc(56, 0x5a)]);
    const off = buf.length;
    buf = Buffer.concat([buf, cert]);
    buf.writeUInt32LE(off, layout.dirOffset + 4 * 8);
    buf.writeUInt32LE(cert.length, layout.dirOffset + 4 * 8 + 4);
    layout.securityOffset = off;
  }
  void schwelle;
  return { buf, layout };
}

// ---------------------------------------------------------------------------------------------
// ELF-Baukasten
// ---------------------------------------------------------------------------------------------

/** Endian-bewusster Schreiber. */
function schreiber(le, is64) {
  const u16 = n => { const b = Buffer.alloc(2); le ? b.writeUInt16LE(n) : b.writeUInt16BE(n); return b; };
  const u32 = n => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n >>> 0) : b.writeUInt32BE(n >>> 0); return b; };
  const u64 = n => { const b = Buffer.alloc(8); le ? b.writeBigUInt64LE(BigInt(n)) : b.writeBigUInt64BE(BigInt(n)); return b; };
  const wort = n => (is64 ? u64(n) : u32(n));
  return { u16, u32, u64, wort };
}

/** String-Tabelle mit Offsets. */
class Strtab {
  constructor() {
    this.teile = [Buffer.from([0])];
    this.len = 1;
    this.map = new Map();
  }
  add(s) {
    if (this.map.has(s)) return this.map.get(s);
    const off = this.len;
    const b = zstr(s);
    this.teile.push(b);
    this.len += b.length;
    this.map.set(s, off);
    return off;
  }
  buffer() {
    return Buffer.concat(this.teile);
  }
}

/**
 * Baut ein Minimal-ELF nach Spezifikation.
 * opts: klasse (32|64), le, typ (1 REL|2 EXEC|3 DYN|4 CORE), maschine, osabi, needed [..], soname, rpath, runpath,
 *  interp, undef [..], exports [..], buildId (hex), comment, sektionen (default true), symtab, bindNow, relro,
 *  stackExec, verneed [{datei, versionen}], modinfo {schluessel:wert}, keinStack, flags1.
 * Rueckgabe: { buf, layout }.
 */
export function baueMinimalElf(opts = {}) {
  const is64 = (opts.klasse ?? 64) === 64;
  const le = opts.le !== false;
  const w = schreiber(le, is64);
  const typ = opts.typ ?? 3;
  const maschine = opts.maschine ?? (is64 ? 62 : 3);
  const mitSektionen = opts.sektionen !== false;
  const ehLen = is64 ? 64 : 52;
  const phLen = is64 ? 56 : 32;
  const shLen = is64 ? 64 : 40;
  const symLen = is64 ? 24 : 16;
  const dynLen = is64 ? 16 : 8;
  const BASIS = 0x10000; // vaddr = BASIS + Dateioffset (LOAD ab Offset 0)
  const istRel = typ === 1;

  const dynstr = new Strtab();
  const needed = opts.needed ?? [];
  const neededOff = needed.map(n => dynstr.add(n));
  const sonameOff = opts.soname ? dynstr.add(opts.soname) : 0;
  const rpathOff = opts.rpath ? dynstr.add(opts.rpath) : 0;
  const runpathOff = opts.runpath ? dynstr.add(opts.runpath) : 0;
  const undef = opts.undef ?? [];
  const exps = opts.exports ?? [];
  const undefOff = undef.map(n => dynstr.add(n));
  const expOff = exps.map(n => dynstr.add(n));
  const verneed = opts.verneed ?? [];
  const vnStr = verneed.map(v => ({ datei: dynstr.add(v.datei), versionen: v.versionen.map(x => dynstr.add(x)) }));

  // Symbole: Null, importierte (UND), exportierte (definiert in Sektion 1).
  const symBuf = [];
  const sym = (name, info, shndx, value, size) =>
    is64
      ? Buffer.concat([w.u32(name), Buffer.from([info, 0]), w.u16(shndx), w.u64(value), w.u64(size)])
      : Buffer.concat([w.u32(name), w.u32(value), w.u32(size), Buffer.from([info, 0]), w.u16(shndx)]);
  symBuf.push(Buffer.alloc(symLen));
  for (const o of undefOff) symBuf.push(sym(o, 0x12, 0, 0, 0));
  exps.forEach((_n, i) => symBuf.push(sym(expOff[i], 0x12, 1, BASIS + 0x100 + i * 16, 16)));
  // Ein lokales Symbol, damit "lokal_anzahl" nicht 0 ist.
  symBuf.push(sym(0, 0x01, 1, 0, 0));
  const nSyms = symBuf.length;
  const dynsym = Buffer.concat(symBuf);

  // Notizen
  let noteBuf = Buffer.alloc(0);
  if (opts.buildId) {
    const desc = Buffer.from(opts.buildId, 'hex');
    noteBuf = Buffer.concat([w.u32(4), w.u32(desc.length), w.u32(3), zstr('GNU').subarray(0, 4), pad(desc, 4)]);
  }

  // Verneed-Abschnitt
  let verneedBuf = Buffer.alloc(0);
  if (verneed.length > 0) {
    const teile = [];
    let off = 0;
    verneed.forEach((v, i) => {
      const aux = vnStr[i].versionen.map(
        (nameOff, j) => Buffer.concat([w.u32(0x0d696910 + j), w.u16(0), w.u16(2 + j), w.u32(nameOff), w.u32(j === vnStr[i].versionen.length - 1 ? 0 : 16)])
      );
      const last = i === verneed.length - 1;
      const gesamt = 16 + aux.length * 16;
      teile.push(Buffer.concat([w.u16(1), w.u16(aux.length), w.u32(vnStr[i].datei), w.u32(16), w.u32(last ? 0 : gesamt), ...aux]));
      off += gesamt;
    });
    verneedBuf = Buffer.concat(teile);
  }

  // Abschnittsnamen
  const shstr = new Strtab();
  const interpBuf = opts.interp ? zstr(opts.interp) : Buffer.alloc(0);
  const commentBuf = opts.comment ? zstr(opts.comment) : Buffer.alloc(0);
  let modinfoBuf = Buffer.alloc(0);
  if (opts.modinfo) modinfoBuf = Buffer.concat(Object.entries(opts.modinfo).map(([k, v]) => zstr(`${k}=${v}`)));

  // Dateilayout berechnen
  const hatPhdr = !istRel;
  const phZahl = hatPhdr ? 2 + (opts.interp ? 1 : 0) + (opts.buildId ? 1 : 0) + (opts.keinStack ? 0 : 1) + (opts.relro ? 1 : 0) : 0;
  let pos = ehLen + phZahl * phLen;
  const lay = {};
  const platz = (name, buf, ausr = 8) => {
    pos = Math.ceil(pos / ausr) * ausr;
    lay[name] = { off: pos, size: buf.length };
    pos += buf.length;
  };
  platz('interp', interpBuf, 1);
  platz('note', noteBuf, 4);
  const dynstrBuf = dynstr.buffer();
  platz('dynstr', dynstrBuf, 1);
  platz('dynsym', dynsym, 8);
  platz('verneed', verneedBuf, 4);
  // Hash-Tabelle (DT_HASH): nbucket=1, nchain=nSyms, bucket[0]=0, chain[]=0
  const hashBuf = Buffer.concat([w.u32(1), w.u32(nSyms), w.u32(0), ...Array.from({ length: nSyms }, () => w.u32(0))]);
  platz('hash', hashBuf, 4);
  // Dynamic
  const dyn = (tag, val) => Buffer.concat([w.wort(tag), w.wort(val)]);
  const dynEintraege = [];
  neededOff.forEach(o => dynEintraege.push(dyn(1, o)));
  if (opts.soname) dynEintraege.push(dyn(14, sonameOff));
  if (opts.rpath) dynEintraege.push(dyn(15, rpathOff));
  if (opts.runpath) dynEintraege.push(dyn(29, runpathOff));
  // Platzhalter fuer Adressen werden unten gesetzt (Layout ist dann bekannt)
  const dynFix = [
    () => dyn(4, BASIS + lay.hash.off),
    () => dyn(5, BASIS + lay.dynstr.off),
    () => dyn(6, BASIS + lay.dynsym.off),
    () => dyn(10, lay.dynstr.size),
    () => dyn(11, symLen),
  ];
  if (opts.bindNow) dynFix.push(() => dyn(30, 8));
  if (opts.flags1) dynFix.push(() => dyn(0x6ffffffb, opts.flags1));
  const dynGroesse = (dynEintraege.length + dynFix.length + 1) * dynLen;
  if (!istRel) platz('dynamic', Buffer.alloc(dynGroesse), 8);
  platz('comment', commentBuf, 1);
  platz('modinfo', modinfoBuf, 1);

  // Sektionstabelle
  const namenReihe = ['', '.interp', '.note.gnu.build-id', '.dynsym', '.dynstr', '.dynamic', '.gnu.hash', '.gnu.version_r', '.comment', '.modinfo', '.symtab', '.strtab', '.shstrtab'];
  void namenReihe;
  const sekt = []; // {name, typ, flags, off, size, link, info, entsize}
  sekt.push({ name: '', typ: 0, flags: 0, off: 0, size: 0, link: 0, info: 0, entsize: 0 });
  const addSek = s => { sekt.push(s); return sekt.length - 1; };
  if (!istRel) {
    // Sektion 1 muss existieren, weil exportierte Symbole shndx=1 tragen: sie ist .dynsym-fremd — wir legen .text-Ersatz an.
  }
  addSek({ name: '.text', typ: 1, flags: 6, off: 0, size: ehLen, link: 0, info: 0, entsize: 0 }); // idx 1
  if (opts.interp) addSek({ name: '.interp', typ: 1, flags: 2, off: lay.interp.off, size: lay.interp.size, link: 0, info: 0, entsize: 0 });
  if (opts.buildId) addSek({ name: '.note.gnu.build-id', typ: 7, flags: 2, off: lay.note.off, size: lay.note.size, link: 0, info: 0, entsize: 0 });
  const idxDynstr = sekt.length + 1; // .dynsym kommt zuerst, dann .dynstr
  if (!istRel) {
    addSek({ name: '.dynsym', typ: 11, flags: 2, off: lay.dynsym.off, size: lay.dynsym.size, link: idxDynstr, info: 1, entsize: symLen });
    addSek({ name: '.dynstr', typ: 3, flags: 2, off: lay.dynstr.off, size: lay.dynstr.size, link: 0, info: 0, entsize: 0 });
    if (verneed.length > 0) addSek({ name: '.gnu.version_r', typ: 0x6ffffffe, flags: 2, off: lay.verneed.off, size: lay.verneed.size, link: idxDynstr, info: verneed.length, entsize: 0 });
    addSek({ name: '.dynamic', typ: 6, flags: 3, off: lay.dynamic.off, size: lay.dynamic.size, link: idxDynstr, info: 0, entsize: dynLen });
  }
  if (opts.comment) addSek({ name: '.comment', typ: 1, flags: 0x30, off: lay.comment.off, size: lay.comment.size, link: 0, info: 0, entsize: 1 });
  if (opts.modinfo) {
    addSek({ name: '.modinfo', typ: 1, flags: 2, off: lay.modinfo.off, size: lay.modinfo.size, link: 0, info: 0, entsize: 0 });
    addSek({ name: '.gnu.linkonce.this_module', typ: 1, flags: 3, off: 0, size: 0, link: 0, info: 0, entsize: 0 });
  }
  if (opts.symtab) {
    // .symtab = Kopie der Symbolbytes (nur zum Erkennen "nicht gestrippt")
    platz('symtab', dynsym, 8);
    addSek({ name: '.symtab', typ: 2, flags: 0, off: lay.symtab.off, size: lay.symtab.size, link: 0, info: 1, entsize: symLen });
  }
  const sekNamen = sekt.map(s => shstr.add(s.name));
  const shstrNameOff = shstr.add('.shstrtab');
  const shstrBuf = shstr.buffer();
  platz('shstrtab', shstrBuf, 1);
  const shstrIdx = sekt.length;
  sekt.push({ name: '.shstrtab', typ: 3, flags: 0, off: lay.shstrtab.off, size: lay.shstrtab.size, link: 0, info: 0, entsize: 0 });
  sekNamen.push(shstrNameOff);
  pos = Math.ceil(pos / 8) * 8;
  const shoff = mitSektionen ? pos : 0;
  const gesamt = mitSektionen ? pos + sekt.length * shLen : pos;

  // Programm-Header
  const ph = (t, flags, off, filesz, memsz, align) =>
    is64
      ? Buffer.concat([w.u32(t), w.u32(flags), w.u64(off), w.u64(BASIS + off), w.u64(BASIS + off), w.u64(filesz), w.u64(memsz), w.u64(align)])
      : Buffer.concat([w.u32(t), w.u32(off), w.u32(BASIS + off), w.u32(BASIS + off), w.u32(filesz), w.u32(memsz), w.u32(flags), w.u32(align)]);
  const phs = [];
  if (hatPhdr) {
    if (opts.interp) phs.push(ph(3, 4, lay.interp.off, lay.interp.size, lay.interp.size, 1));
    phs.push(ph(1, 7, 0, gesamt, gesamt, 0x1000));
    phs.push(ph(2, 6, lay.dynamic.off, lay.dynamic.size, lay.dynamic.size, 8));
    if (opts.buildId) phs.push(ph(4, 4, lay.note.off, lay.note.size, lay.note.size, 4));
    if (!opts.keinStack) phs.push(ph(0x6474e551, opts.stackExec ? 7 : 6, 0, 0, 0, 16));
    if (opts.relro) phs.push(ph(0x6474e552, 4, lay.dynamic.off, lay.dynamic.size, lay.dynamic.size, 1));
  }

  // ELF-Header
  const ident = Buffer.alloc(16);
  ident.write('\x7fELF', 0, 'latin1');
  ident[4] = is64 ? 2 : 1;
  ident[5] = le ? 1 : 2;
  ident[6] = 1;
  ident[7] = opts.osabi ?? 0;
  const kopf = Buffer.concat([
    ident,
    w.u16(typ),
    w.u16(maschine),
    w.u32(1),
    w.wort(typ === 2 ? BASIS + 0x80 : 0),
    w.wort(hatPhdr ? ehLen : 0),
    w.wort(shoff),
    w.u32(0),
    w.u16(ehLen),
    w.u16(hatPhdr ? phLen : 0),
    w.u16(phs.length),
    w.u16(mitSektionen ? shLen : 0),
    w.u16(mitSektionen ? sekt.length : 0),
    w.u16(mitSektionen ? shstrIdx : 0),
  ]);

  // Zusammensetzen
  const buf = Buffer.alloc(gesamt);
  kopf.copy(buf, 0);
  phs.forEach((p, i) => p.copy(buf, ehLen + i * phLen));
  interpBuf.copy(buf, lay.interp.off);
  noteBuf.copy(buf, lay.note.off);
  dynstrBuf.copy(buf, lay.dynstr.off);
  dynsym.copy(buf, lay.dynsym.off);
  verneedBuf.copy(buf, lay.verneed.off);
  hashBuf.copy(buf, lay.hash.off);
  if (!istRel) {
    const alleDyn = [...dynEintraege, ...dynFix.map(f => f()), dyn(0, 0)];
    alleDyn.forEach((d, i) => d.copy(buf, lay.dynamic.off + i * dynLen));
  }
  commentBuf.copy(buf, lay.comment.off);
  modinfoBuf.copy(buf, lay.modinfo.off);
  if (opts.symtab) dynsym.copy(buf, lay.symtab.off);
  shstrBuf.copy(buf, lay.shstrtab.off);
  if (mitSektionen) {
    sekt.forEach((s, i) => {
      const h = is64
        ? Buffer.concat([w.u32(sekNamen[i]), w.u32(s.typ), w.u64(s.flags), w.u64(s.off ? BASIS + s.off : 0), w.u64(s.off), w.u64(s.size), w.u32(s.link), w.u32(s.info), w.u64(8), w.u64(s.entsize)])
        : Buffer.concat([w.u32(sekNamen[i]), w.u32(s.typ), w.u32(s.flags), w.u32(s.off ? BASIS + s.off : 0), w.u32(s.off), w.u32(s.size), w.u32(s.link), w.u32(s.info), w.u32(4), w.u32(s.entsize)]);
      h.copy(buf, shoff + i * shLen);
    });
  }
  return {
    buf,
    layout: {
      ehLen,
      phoff: hatPhdr ? ehLen : 0,
      phLen,
      phZahl: phs.length,
      shoff,
      shLen,
      shZahl: mitSektionen ? sekt.length : 0,
      shstrOff: lay.shstrtab.off,
      shstrSize: lay.shstrtab.size,
      dynstrOff: lay.dynstr.off,
      dynstrSize: lay.dynstr.size,
      dynsymOff: lay.dynsym.off,
      dynamicOff: lay.dynamic?.off ?? 0,
      dynamicSize: lay.dynamic?.size ?? 0,
      interpOff: lay.interp.off,
      noteOff: lay.note.off,
      verneedOff: lay.verneed.off,
      gesamt,
      basis: BASIS,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Fixture-Satz
// ---------------------------------------------------------------------------------------------

function hat(werkzeug) {
  try {
    execFileSync('which', [werkzeug], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function versuche(cmd, args, opts = {}) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 60_000, ...opts });
    return true;
  } catch {
    return false;
  }
}

const C_HELLO = `#include <stdio.h>
#include <math.h>
#include <string.h>
int main(int argc, char **argv) {
  char buf[64];
  strncpy(buf, argc > 1 ? argv[1] : "welt", sizeof(buf) - 1);
  buf[63] = 0;
  printf("hallo %s %f\\n", buf, sqrt((double)argc));
  return 0;
}
`;
const C_LIB = `#include <stdio.h>
int foo_add(int a, int b) { return a + b; }
int foo_mul(int a, int b) { puts("mul"); return a * b; }
`;
const C_WIN_EXE = `#include <windows.h>
int main(void) { MessageBoxA(0, "hallo", "titel", 0); ExitProcess(0); return 0; }
`;
const C_WIN_DLL = `#include <windows.h>
__declspec(dllexport) int foo_add(int a, int b) { return a + b; }
__declspec(dllexport) int foo_mul(int a, int b) { return a * b; }
BOOL WINAPI DllMain(HINSTANCE h, DWORD r, LPVOID p) { return TRUE; }
`;

/**
 * Erzeugt alle Fixtures. Echte Dateien nur, wenn das Werkzeug da ist (Schluessel in `echt`
 * fehlt sonst). `pfade` enthaelt die handgebauten Dateien.
 */
export async function erzeugeExeFixtures(ziel) {
  const dir = ziel ?? (await mkdtemp(join(tmpdir(), 'synapse-asset-exe-')));
  await mkdir(dir, { recursive: true });
  const pfade = {};
  const echt = {};
  const schreibe = async (schluessel, name, inhalt) => {
    const p = join(dir, name);
    await writeFile(p, inhalt);
    pfade[schluessel] = p;
  };

  // --- Handgebaute PE ---
  const peBasis = baueMinimalPe({
    dll: true,
    imports: [
      { dll: 'KERNEL32.dll', funcs: ['ExitProcess', 'GetLastError', 7] },
      { dll: 'USER32.dll', funcs: ['MessageBoxA'] },
    ],
    delay: [{ dll: 'ADVAPI32.dll', funcs: ['RegCloseKey'] }],
    exports: { dllName: 'foo.dll', names: ['foo_add', 'foo_mul'], base: 1, nurOrdinal: 1 },
    icons: 2,
    version: { fest: [1, 2, 3, 4], strings: { FileVersion: '1.2.3.4', ProductName: 'Fixture', CompanyName: 'Synapse Test' } },
    manifest: true,
    debugPdb: 'C:\\build\\foo.pdb',
    security: true,
    clr: true,
  });
  await schreibe('pe32dll', 'pe32-voll.dll', peBasis.buf);
  pfade.pe32dllLayout = peBasis.layout;
  const pe64 = baueMinimalPe({
    plus: true,
    dll: false,
    imports: [{ dll: 'KERNEL32.dll', funcs: ['ExitProcess'] }],
    zufallText: true,
  });
  await schreibe('pe64exe', 'pe64-gepackt.exe', pe64.buf);
  await schreibe('pe64exeAlsTxt', 'pe64-als-txt.txt', pe64.buf);
  await schreibe('pe64exeAlsPng', 'pe64-als-png.png', pe64.buf);

  // Boesartig (aus der Basis abgeleitet)
  const L = peBasis.layout;
  await schreibe('peAbgeschnittenNachLfanew', 'pe-abgeschnitten-lfanew.exe', peBasis.buf.subarray(0, L.lfanew + 2));
  await schreibe('peAbgeschnittenImKopf', 'pe-abgeschnitten-kopf.exe', peBasis.buf.subarray(0, L.optOffset + 40));
  await schreibe('peLfanewAusserhalb', 'pe-lfanew-ausserhalb.exe', patchU32(peBasis.buf, 0x3c, 0x7fffff00));
  await schreibe('peSektionenAusserhalb', 'pe-sektion-ausserhalb.exe', patchU32(peBasis.buf, L.sektionTabelle + 40 + 20, 0x10000000));
  await schreibe('peSektionenAbsurd', 'pe-sektionen-absurd.exe', patchU16(peBasis.buf, L.coffOffset + 6, 60000));
  await schreibe('peSektionenAbgeschnitten', 'pe-sektionen-abgeschnitten.exe', peBasis.buf.subarray(0, L.sektionTabelle + 60));
  const zyk = baueMinimalPe({ dll: false, imports: [{ dll: 'KERNEL32.dll', funcs: ['ExitProcess'] }], importZyklus: true });
  await schreibe('peImportZyklus', 'pe-import-zyklus.exe', zyk.buf);
  const rz = baueMinimalPe({ dll: false, imports: [{ dll: 'KERNEL32.dll', funcs: ['ExitProcess'] }], icons: 1, ressourcenZyklus: true });
  await schreibe('peRessourcenZyklus', 'pe-ressourcen-zyklus.exe', rz.buf);
  // Importname ohne Nullterminator: letztes Byte der Rohdaten der Sektion .rdata durch den Namen fuellen.
  const nt = baueMinimalPe({ dll: false, imports: [{ dll: 'KERNEL32.dll', funcs: ['ExitProcess'] }] });
  {
    // DLL-Name steht am Anfang von .rdata (RVA 0x2000): Name-Zeiger auf das letzte Byte der Rohdaten setzen, das ungleich 0 ist.
    const rd = nt.layout.sektionen.find(s => s.name === '.rdata');
    const b = Buffer.from(nt.buf);
    b.fill(0x41, rd.rawPtr + rd.rawSize - 4, rd.rawPtr + rd.rawSize); // 'AAAA' bis zum Sektionsende
    // Deskriptor-Name-RVA auf diese Stelle zeigen lassen
    const impOff = rd.rawPtr + (nt.layout.importRva - rd.va);
    b.writeUInt32LE(rd.va + rd.rawSize - 4, impOff + 12);
    await schreibe('peNameOhneTerminator', 'pe-name-ohne-terminator.exe', b);
  }
  const wechsel = baueMinimalPe({ dll: true, exports: { dllName: 'x.dll', names: ['a', 'b', 'c'] } });
  await schreibe('peNurExporte', 'pe-nur-exporte.dll', wechsel.buf);
  await schreibe('peLeerMz', 'pe-nur-mz.exe', Buffer.from('MZ'));
  await schreibe('peKeinMz', 'pe-kein-mz.exe', zufallBytes(300, 3));

  // --- Handgebaute ELF ---
  const elfVoll = baueMinimalElf({
    klasse: 64,
    typ: 3,
    needed: ['libc.so.6', 'libm.so.6'],
    soname: 'libfix.so.1',
    runpath: '/opt/fix/lib',
    interp: '/lib64/ld-linux-x86-64.so.2',
    undef: ['printf', '__stack_chk_fail', '__printf_chk'],
    exports: ['fix_add', 'fix_mul'],
    buildId: '00112233445566778899aabbccddeeff00112233',
    comment: 'GCC: (Fixture) 13.2.0',
    symtab: true,
    bindNow: true,
    relro: true,
    flags1: 0x08000001,
    verneed: [{ datei: 'libc.so.6', versionen: ['GLIBC_2.2.5', 'GLIBC_2.34'] }],
  });
  await schreibe('elf64voll', 'elf64-voll.so', elfVoll.buf);
  pfade.elf64vollLayout = elfVoll.layout;
  const elf32 = baueMinimalElf({ klasse: 32, typ: 2, needed: ['libc.so.6'], interp: '/lib/ld-linux.so.2', undef: ['puts'], exports: [], comment: 'GCC: (Fixture32)' });
  await schreibe('elf32le', 'elf32-le', elf32.buf);
  const elfBe32 = baueMinimalElf({ klasse: 32, le: false, typ: 2, maschine: 20, needed: ['libc.so.6'], interp: '/lib/ld.so.1', undef: ['puts'], exports: ['be_fn'], soname: 'libbe.so' });
  await schreibe('elf32be', 'elf32-be', elfBe32.buf);
  const elfBe64 = baueMinimalElf({ klasse: 64, le: false, typ: 3, maschine: 22, needed: ['libc.so.6'], undef: ['puts'], exports: ['be64_fn'], soname: 'libbe64.so' });
  await schreibe('elf64be', 'elf64-be.so', elfBe64.buf);
  const elfOhneSek = baueMinimalElf({ klasse: 64, typ: 3, needed: ['libc.so.6'], soname: 'libns.so', interp: '/lib64/ld-linux-x86-64.so.2', undef: ['abort'], exports: ['ns_fn'], sektionen: false });
  await schreibe('elfOhneSektionen', 'elf64-ohne-sektionen.so', elfOhneSek.buf);
  const kmod = baueMinimalElf({ klasse: 64, typ: 1, modinfo: { license: 'GPL', description: 'Fixture-Modul', vermagic: '6.1.0 SMP', name: 'fixmod' }, comment: 'GCC: (Fixture) 13.2.0' });
  await schreibe('elfKernelmodul', 'fixmod.ko', kmod.buf);

  const EL = elfVoll.layout;
  const eb = elfVoll.buf;
  await schreibe('elfAbgeschnittenKopf', 'elf-abgeschnitten-kopf.so', eb.subarray(0, 30));
  await schreibe('elfAbgeschnittenNachPhdr', 'elf-abgeschnitten-phdr.so', eb.subarray(0, EL.phoff + EL.phLen + 8));
  await schreibe('elfShnumAbsurd', 'elf-shnum-absurd.so', patchU16(eb, 60, 65000));
  await schreibe('elfPhnumAbsurd', 'elf-phnum-absurd.so', patchU16(eb, 56, 65000));
  await schreibe('elfShoffAusserhalb', 'elf-shoff-ausserhalb.so', (() => { const b = Buffer.from(eb); b.writeBigUInt64LE(0xfffffffffffffff0n, 40); return b; })());
  await schreibe('elfSektionAusserhalb', 'elf-sektion-ausserhalb.so', (() => { const b = Buffer.from(eb); b.writeBigUInt64LE(0x7ffffff00000n, EL.shoff + 3 * EL.shLen + 32); return b; })());
  // Dynstr ohne Nullterminator am Ende (letzter Name = Ende der Tabelle).
  // Letzter Eintrag der Dynstr ist hier der SONAME; sein Terminator wird zu 'X'.
  const dsn = baueMinimalElf({ klasse: 64, typ: 3, needed: ['libc.so.6'], soname: 'libx.so', interp: '/lib64/ld-linux-x86-64.so.2' });
  await schreibe('elfDynstrOhneTerminator', 'elf-dynstr-ohne-terminator.so', patchU8(dsn.buf, dsn.layout.dynstrOff + dsn.layout.dynstrSize - 1, 0x58));
  await schreibe('elfShstrOhneTerminator', 'elf-shstr-ohne-terminator.so', patchU8(eb, EL.shstrOff + EL.shstrSize - 1, 0x58));
  // Dynamic ohne DT_NULL: Terminator-Eintrag zu DT_NEEDED umschreiben und bis zum Ende fuellen
  await schreibe('elfDynamicOhneEnde', 'elf-dynamic-ohne-ende.so', (() => {
    const b = Buffer.from(eb);
    for (let o = EL.dynamicOff; o < EL.dynamicOff + EL.dynamicSize; o += 16) {
      if (b.readBigUInt64LE(o) === 0n) { b.writeBigUInt64LE(1n, o); b.writeBigUInt64LE(1n, o + 8); }
    }
    return b;
  })());
  await schreibe('elfMuell', 'elf-nur-magic.so', Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  await schreibe('elfKlasseUngueltig', 'elf-klasse-ungueltig.so', patchU8(eb, 4, 9));
  await schreibe('elfAlsTxt', 'elf-als-txt.txt', eb);
  await schreibe('elfAlsExe', 'elf-als-exe.exe', eb);

  // --- Echte Dateien (nur mit Werkzeug) ---
  if (hat('gcc')) {
    await writeFile(join(dir, 'hello.c'), C_HELLO);
    await writeFile(join(dir, 'foo.c'), C_LIB);
    const hello = join(dir, 'hello');
    if (versuche('gcc', ['-O1', '-pie', '-fPIE', '-fstack-protector-strong', '-D_FORTIFY_SOURCE=2', '-Wl,-z,relro,-z,now', '-Wl,--no-as-needed', '-o', hello, join(dir, 'hello.c'), '-lm'])) echt.hello = hello;
    const nopie = join(dir, 'hello-nopie');
    if (versuche('gcc', ['-O0', '-no-pie', '-fno-stack-protector', '-Wl,-z,norelro', '-o', nopie, join(dir, 'hello.c'), '-lm'])) echt.nopie = nopie;
    const so = join(dir, 'libfoo.so.1');
    if (versuche('gcc', ['-shared', '-fPIC', '-O1', '-Wl,-soname,libfoo.so.1', '-Wl,-rpath,/opt/foo/lib', '-Wl,--disable-new-dtags', '-o', so, join(dir, 'foo.c')])) echt.libfoo = so;
    const so2 = join(dir, 'libfoo-runpath.so');
    if (versuche('gcc', ['-shared', '-fPIC', '-O1', '-Wl,-soname,libfoo2.so', '-Wl,-rpath,/opt/foo2', '-Wl,--enable-new-dtags', '-o', so2, join(dir, 'foo.c')])) echt.libfooRunpath = so2;
    const obj = join(dir, 'foo.o');
    if (versuche('gcc', ['-c', '-fPIC', '-O1', '-o', obj, join(dir, 'foo.c')])) echt.objekt = obj;
    const stat = join(dir, 'hello-static');
    if (versuche('gcc', ['-static', '-O1', '-o', stat, join(dir, 'hello.c'), '-lm'])) echt.statisch = stat;
    if (echt.hello && hat('strip')) {
      const g = join(dir, 'hello-stripped');
      await copyFile(echt.hello, g);
      if (versuche('strip', ['-s', g])) echt.gestrippt = g;
    }
    if (hat('gcc') && versuche('gcc', ['-m32', '-O1', '-o', join(dir, 'hello32'), join(dir, 'hello.c'), '-lm'])) echt.elf32 = join(dir, 'hello32');
  }
  if (hat('x86_64-w64-mingw32-gcc')) {
    await writeFile(join(dir, 'win.c'), C_WIN_EXE);
    await writeFile(join(dir, 'windll.c'), C_WIN_DLL);
    const e = join(dir, 'win64.exe');
    if (versuche('x86_64-w64-mingw32-gcc', ['-O1', '-o', e, join(dir, 'win.c'), '-luser32'])) echt.win64exe = e;
    const d = join(dir, 'win64.dll');
    if (versuche('x86_64-w64-mingw32-gcc', ['-shared', '-O1', '-o', d, join(dir, 'windll.c')])) echt.win64dll = d;
  }
  if (hat('i686-w64-mingw32-gcc')) {
    await writeFile(join(dir, 'win.c'), C_WIN_EXE);
    const e = join(dir, 'win32.exe');
    if (versuche('i686-w64-mingw32-gcc', ['-O1', '-o', e, join(dir, 'win.c'), '-luser32'])) echt.win32exe = e;
  }
  return { dir, pfade, echt, aufraeumen: () => rm(dir, { recursive: true, force: true }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, pfade, echt } = await erzeugeExeFixtures();
  console.log(dir);
  for (const [k, p] of Object.entries(pfade)) if (typeof p === 'string') console.log(`  ${k}: ${p}`);
  for (const [k, p] of Object.entries(echt)) console.log(`  echt.${k}: ${p}`);
}
