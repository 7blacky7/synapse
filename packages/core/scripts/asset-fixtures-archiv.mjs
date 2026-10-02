/**
 * Fixture-Generator fuer die Archiv-/SQLite-Inspektoren (P4-T66 Teil a).
 * Erzeugt Dateien DETERMINISTISCH in einem Verzeichnis unter os.tmpdir() — es werden KEINE Binaerdateien eingecheckt.
 *
 * ZWEI QUELLEN:
 *  (1) ECHTE Dateien von Fremdwerkzeugen (python3-zipfile, 7z, tar, gzip, bzip2, xz, zstd, sqlite3), soweit vorhanden
 *      (mit `which`-aehnlicher Pruefung; nichts wird installiert). Fehlt ein Werkzeug, fehlen die Dateien und
 *      `werkzeuge[name]` ist false — Tests ueberspringen dann.
 *  (2) HAND-Fixtures nach Spezifikation: ZIP64, Selbstextraktor-Praefix, Traversal-Namen, Bomben (kleine Dateien mit
 *      riesigen Deklarationen), TAR mit Langnamen/Symlinks/base-256, 7z-Header, SQLite mit Overflow/Zyklus.
 *
 * AUFRUF: node packages/core/scripts/asset-fixtures-archiv.mjs   (gibt das Verzeichnis aus)
 * ALS MODUL: const { dir, pfade, erwartet, werkzeuge, aufraeumen } = await erzeugeArchivFixtures();
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip, deflateRawSync } from 'node:zlib';

// ------------------------------------------------------------------ Helfer

let crcTab = null;
export function crc32(buf) {
  if (!crcTab) {
    crcTab = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTab[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTab[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Deterministische Fuellbytes (kein Math.random). */
export function fuell(n, start = 1) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = (start + i * 7) & 0xff;
  return b;
}

const u16 = n => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = n => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u64 = n => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

function hat(werkzeug) {
  try {
    execFileSync(werkzeug, ['--version'], { stdio: 'ignore' });
    return true;
  } catch (e) {
    // Manche Werkzeuge kennen --version nicht, laufen aber (Exit != 0): ENOENT ist das einzige echte "fehlt".
    return e?.code !== 'ENOENT';
  }
}

function lauf(cmd, args, opt = {}) {
  try {
    return execFileSync(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opt });
  } catch (e) {
    // 7z meldet mit Exit 1 nur eine Warnung (z. B. nicht lesbares Symlink-Ziel); die Datei ist dann trotzdem fertig.
    if (cmd === '7z' && e?.status === 1 && e.stdout) return e.stdout;
    throw e;
  }
}

// ------------------------------------------------------------------ ZIP (Hand)

const DOS_DATUM = ((2020 - 1980) << 9) | (1 << 5) | 2;
const DOS_ZEIT = (3 << 11) | (4 << 5) | 3;

/**
 * Baut ein ZIP von Hand. eintraege: { name | nameBytes, daten, methode(0|8), flags, usize, csize, crc, offsetOverride,
 * zip64Extra, extra(Buffer), kommentar, extAttr, osUnix, keinLokal }. opt: { praefix, kommentar(Buffer), zip64,
 * eintraegeDeklariert, cdOffsetOverride, cdSizeOverride, disk, cdDisk, eintraegeDisk }.
 */
export function baueZip(eintraege, opt = {}) {
  const teile = [];
  let pos = 0;
  const push = b => {
    teile.push(b);
    pos += b.length;
  };
  const basis = opt.praefix ? opt.praefix.length : 0;
  if (opt.praefix) push(opt.praefix);
  const cd = [];
  for (const e of eintraege) {
    const daten = e.daten ?? Buffer.alloc(0);
    const methode = e.methode ?? 0;
    const roh = methode === 8 ? deflateRawSync(daten) : daten;
    const name = e.nameBytes ?? Buffer.from(e.name, 'utf8');
    const crc = e.crc ?? crc32(daten);
    const csize = e.csize ?? roh.length;
    const usize = e.usize ?? daten.length;
    const flags = (e.flags ?? 0) | (e.nameBytes ? 0 : 0x800);
    const lokalOffset = pos - basis;
    if (!e.keinLokal) {
      const l = Buffer.concat([
        u32(0x04034b50), u16(20), u16(flags), u16(methode), u16(DOS_ZEIT), u16(DOS_DATUM), u32(crc),
        u32(Number(csize) > 0xffffffff ? 0xffffffff : Number(csize)),
        u32(Number(usize) > 0xffffffff ? 0xffffffff : Number(usize)),
        u16(name.length), u16(0),
      ]);
      push(l);
      push(name);
      push(roh);
    }
    cd.push({ e, name, flags, methode, crc, csize, usize, off: e.offsetOverride ?? lokalOffset });
  }
  const cdStart = pos - basis;
  for (const c of cd) {
    const { e } = c;
    let extra = e.extra ?? Buffer.alloc(0);
    let cs = Number(c.csize);
    let us = Number(c.usize);
    let off = c.off;
    if (e.zip64Extra) {
      extra = Buffer.concat([u16(0x0001), u16(24), u64(c.usize), u64(c.csize), u64(c.off), extra]);
      cs = us = off = 0xffffffff;
    }
    const kommentar = Buffer.from(e.kommentar ?? '', 'utf8');
    push(
      Buffer.concat([
        u32(0x02014b50), u16(((e.osUnix ? 3 : 0) << 8) | 45), u16(45), u16(c.flags), u16(c.methode), u16(DOS_ZEIT), u16(DOS_DATUM),
        u32(c.crc), u32(cs > 0xffffffff ? 0xffffffff : cs), u32(us > 0xffffffff ? 0xffffffff : us),
        u16(c.name.length), u16(extra.length), u16(kommentar.length), u16(0), u16(0), u32(e.extAttr ?? 0),
        u32(off > 0xffffffff ? 0xffffffff : off),
        c.name, extra, kommentar,
      ])
    );
  }
  const cdGroesse = pos - basis - cdStart;
  const anzahl = opt.eintraegeDeklariert ?? eintraege.length;
  if (opt.zip64) {
    const eocd64Pos = pos - basis;
    push(
      Buffer.concat([
        u32(0x06064b50), u64(44), u16(45), u16(45), u32(opt.disk ?? 0), u32(opt.cdDisk ?? 0),
        u64(opt.eintraegeDisk ?? anzahl), u64(anzahl), u64(opt.cdSizeOverride ?? cdGroesse), u64(opt.cdOffsetOverride ?? cdStart),
      ])
    );
    push(Buffer.concat([u32(0x07064b50), u32(0), u64(eocd64Pos), u32(1)]));
    push(
      Buffer.concat([
        u32(0x06054b50), u16(0xffff), u16(0xffff), u16(0xffff), u16(0xffff), u32(0xffffffff), u32(0xffffffff),
        u16((opt.kommentar ?? Buffer.alloc(0)).length), opt.kommentar ?? Buffer.alloc(0),
      ])
    );
  } else {
    const kom = opt.kommentar ?? Buffer.alloc(0);
    push(
      Buffer.concat([
        u32(0x06054b50), u16(opt.disk ?? 0), u16(opt.cdDisk ?? 0), u16(Math.min(opt.eintraegeDisk ?? anzahl, 0xffff)),
        u16(Math.min(anzahl, 0xffff)), u32(opt.cdSizeOverride ?? cdGroesse), u32(opt.cdOffsetOverride ?? cdStart), u16(kom.length), kom,
      ])
    );
  }
  return Buffer.concat(teile);
}

// ------------------------------------------------------------------ TAR (Hand)

function oktal(buf, off, len, wert) {
  const s = wert.toString(8).padStart(len - 1, '0');
  buf.write(s.slice(-(len - 1)), off, 'latin1');
  buf[off + len - 1] = 0;
}

/** Ein 512-Byte-Kopfblock. */
export function tarKopf(o) {
  const b = Buffer.alloc(512);
  b.write(o.name ?? '', 0, 100, 'utf8');
  oktal(b, 100, 8, o.mode ?? 0o644);
  oktal(b, 108, 8, o.uid ?? 0);
  oktal(b, 116, 8, o.gid ?? 0);
  if (o.sizeBase256 !== undefined) {
    b[124] = 0x80;
    let v = BigInt(o.sizeBase256);
    for (let i = 135; i > 124; i--) {
      b[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    b[124] = 0x80 | b[124];
  } else oktal(b, 124, 12, o.size ?? 0);
  oktal(b, 136, 12, o.mtime ?? 0);
  b[156] = (o.typ ?? '0').charCodeAt(0);
  b.write(o.link ?? '', 157, 100, 'utf8');
  b.write(o.magic ?? 'ustar\0', 257, 6, 'latin1');
  b.write(o.version ?? '00', 263, 2, 'latin1');
  b.write(o.uname ?? '', 265, 32, 'latin1');
  b.write(o.gname ?? '', 297, 32, 'latin1');
  if (o.prefix) b.write(o.prefix, 345, 155, 'utf8');
  b.fill(0x20, 148, 156);
  let summe = 0;
  for (let i = 0; i < 512; i++) summe += b[i];
  b.write(summe.toString(8).padStart(6, '0'), 148, 'latin1');
  b[154] = 0;
  b[155] = 0x20;
  if (o.pruefsummeFalsch) b[148] = b[148] === 0x37 ? 0x36 : 0x37;
  return b;
}

const pad512 = d => Buffer.concat([d, Buffer.alloc((512 - (d.length % 512)) % 512)]);
export const tarEnde = () => Buffer.alloc(1024);
export function tarDatei(name, daten, extra = {}) {
  return Buffer.concat([tarKopf({ name, size: daten.length, ...extra }), pad512(daten)]);
}
export function paxSatz(k, v) {
  const rest = ` ${k}=${v}\n`;
  let len = Buffer.byteLength(rest) + 1;
  while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
  return Buffer.from(String(len) + rest);
}

// ------------------------------------------------------------------ 7z (Hand)

export function sevenNum(n) {
  n = Number(n);
  for (let k = 0; k <= 8; k++) {
    if (n < 2 ** (7 * (k + 1)) || k === 8) {
      const erst = ((0xff00 >> k) & 0xff) | Math.floor(n / 2 ** (8 * k));
      const bytes = [erst & 0xff];
      let rest = n;
      for (let i = 0; i < k; i++) {
        bytes.push(rest % 256);
        rest = Math.floor(rest / 256);
      }
      return Buffer.from(bytes);
    }
  }
}

/** Baut ein 7z mit unkomprimiertem Header (Kopie-Coder, ein Folder). */
export function baue7z(dateien, opt = {}) {
  const daten = Buffer.concat(dateien.map(f => f.daten ?? Buffer.alloc(0)));
  const n = dateien.length;
  const namen = Buffer.concat(dateien.flatMap(f => [Buffer.from(f.name, 'utf16le'), Buffer.alloc(2)]));
  const sizes = Buffer.concat(dateien.slice(0, -1).map(f => sevenNum((f.daten ?? Buffer.alloc(0)).length)));
  const crcs = Buffer.concat(dateien.map(f => u32(crc32(f.daten ?? Buffer.alloc(0)))));
  const unpack = opt.entpacktDeklariert ?? daten.length;
  const header = Buffer.concat([
    Buffer.from([0x01, 0x04]),
    Buffer.from([0x06]), sevenNum(0), sevenNum(1), Buffer.from([0x09]), sevenNum(daten.length), Buffer.from([0x00]),
    Buffer.from([0x07, 0x0b]), sevenNum(1), Buffer.from([0x00]),
    sevenNum(1), Buffer.from([0x01, 0x00]),
    Buffer.from([0x0c]), sevenNum(unpack), Buffer.from([0x00]),
    Buffer.from([0x08, 0x0d]), sevenNum(n), Buffer.from([0x09]), sizes, Buffer.from([0x0a, 0x01]), crcs, Buffer.from([0x00]),
    Buffer.from([0x00]),
    Buffer.from([0x05]), sevenNum(opt.dateienDeklariert ?? n),
    Buffer.from([0x11]), sevenNum(namen.length + 1), Buffer.from([0x00]), namen,
    Buffer.from([0x00]),
    Buffer.from([0x00]),
  ]);
  return baue7zRoh(daten, header, opt);
}

/** Setzt Signature Header + gepackte Daten + Header zusammen. */
export function baue7zRoh(gepackt, header, opt = {}) {
  const nextOffset = opt.nextOffset ?? gepackt.length;
  const nextGroesse = opt.nextGroesse ?? header.length;
  const nextCrc = opt.headerCrcFalsch ? (crc32(header) ^ 1) >>> 0 : crc32(header);
  const start = Buffer.concat([u64(nextOffset), u64(nextGroesse), u32(nextCrc)]);
  const startCrc = opt.startCrcFalsch ? (crc32(start) ^ 1) >>> 0 : crc32(start);
  const sig = Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, opt.major ?? 0, 4]), u32(startCrc), start]);
  return Buffer.concat([sig, gepackt, header]);
}

// ------------------------------------------------------------------ Hauptfunktion

const PYTHON_ZIPS = String.raw`
import zipfile, json, sys, os, io, warnings
warnings.simplefilter('ignore')
d = sys.argv[1]
man = {}
DT = (2020, 1, 2, 3, 4, 6)
def zi(name, ct=zipfile.ZIP_DEFLATED, attr=None):
    i = zipfile.ZipInfo(name, DT)
    i.compress_type = ct
    if attr is not None:
        i.external_attr = attr
        i.create_system = 3
    return i
def fertig(fn):
    with zipfile.ZipFile(os.path.join(d, fn)) as z:
        man[fn] = [dict(name=i.filename, comp=i.compress_size, size=i.file_size, crc=i.CRC, method=i.compress_type, flags=i.flag_bits) for i in z.infolist()]
def mk(fn, eintraege, comment=None, **kw):
    with zipfile.ZipFile(os.path.join(d, fn), 'w', **kw) as z:
        for name, data, *rest in eintraege:
            ct = rest[0] if rest else zipfile.ZIP_DEFLATED
            attr = rest[1] if len(rest) > 1 else None
            z.writestr(zi(name, ct, attr), data)
        if comment:
            z.comment = comment
    fertig(fn)

mk('echt.zip', [
    ('readme.txt', b'Hallo Welt\n' * 50),
    ('daten/', b''),
    ('daten/a.bin', bytes(range(256)) * 4, zipfile.ZIP_STORED),
    ('daten/\u00fcn\u00ef.txt', 'Umlaute'.encode()),
    ('leer.txt', b''),
], comment=b'Testkommentar')

with zipfile.ZipFile(os.path.join(d, 'zip64-echt.zip'), 'w', allowZip64=True) as z:
    with z.open(zi('gross.txt'), 'w', force_zip64=True) as f:
        f.write(b'x' * 1000)
    with z.open(zi('b.txt', zipfile.ZIP_STORED), 'w', force_zip64=True) as f:
        f.write(b'y' * 10)
fertig('zip64-echt.zip')

mk('hint-jar.zip', [('META-INF/MANIFEST.MF', b'Manifest-Version: 1.0\n'), ('a/B.class', b'\xca\xfe\xba\xbe' * 8)])
mk('hint-war.zip', [('META-INF/MANIFEST.MF', b'Manifest-Version: 1.0\n'), ('WEB-INF/web.xml', b'<web-app/>')])
mk('hint-apk.zip', [('AndroidManifest.xml', b'x'), ('classes.dex', b'dex\n035\x00'), ('resources.arsc', b'r')])
mk('hint-docx.zip', [('[Content_Types].xml', b'<Types/>'), ('word/document.xml', b'<w:document/>'), ('_rels/.rels', b'<r/>')])
mk('hint-xlsx.zip', [('[Content_Types].xml', b'<Types/>'), ('xl/workbook.xml', b'<workbook/>')])
mk('hint-odt.zip', [('mimetype', b'application/vnd.oasis.opendocument.text', zipfile.ZIP_STORED), ('META-INF/manifest.xml', b'<m/>'), ('content.xml', b'<c/>')])
mk('hint-epub.zip', [('mimetype', b'application/epub+zip', zipfile.ZIP_STORED), ('META-INF/container.xml', b'<c/>')])
mk('hint-keins.zip', [('x.txt', b'x')])

inner = io.BytesIO()
with zipfile.ZipFile(inner, 'w') as iz:
    iz.writestr(zi('innen.txt'), b'innen')
mk('verschachtelt.zip', [
    ('beilage/inner.zip', inner.getvalue(), zipfile.ZIP_STORED),
    ('pakete/x.tar.gz', b'\x1f\x8b\x08\x00' + b'0' * 40),
    ('ohne_endung', inner.getvalue(), zipfile.ZIP_STORED),
    ('daten.bin', bytes(range(100))),
])

mk('symlinks.zip', [
    ('ziel/ok.txt', b'ok'),
    ('lnk_innen', b'ziel/ok.txt', zipfile.ZIP_STORED, 0o120777 << 16),
    ('lnk_aussen', b'../../etc/passwd', zipfile.ZIP_STORED, 0o120777 << 16),
    ('lnk_abs', b'/etc/shadow', zipfile.ZIP_STORED, 0o120777 << 16),
])
mk('doppelt.zip', [('a.txt', b'eins'), ('b.txt', b'zwei'), ('A.TXT', b'drei')])
mk('leer.zip', [])
mk('viele.zip', [('f%03d.txt' % i, b'x' * i) for i in range(40)])

# Mehr als 65535 Eintraege erzwingt den ZIP64-Endsatz (EOCD64 + Locator) in echten Werkzeugen.
with zipfile.ZipFile(os.path.join(d, 'viele64.zip'), 'w') as z:
    for i in range(70000):
        z.writestr(zi('e%05d' % i, zipfile.ZIP_STORED), b'')
man['viele64.zip'] = []

json.dump(man, sys.stdout)
`;

/**
 * @param {string} [ziel] Zielverzeichnis; fehlt es, wird ein neues unter os.tmpdir() angelegt.
 * @param {{gross?: boolean}} [opt] gross: false laesst die Datei-Bomben-Fixtures (gzip, ~1 s) weg.
 */
export async function erzeugeArchivFixtures(ziel, opt = {}) {
  const dir = ziel ?? (await mkdtemp(join(tmpdir(), 'synapse-archiv-fixtures-')));
  await mkdir(dir, { recursive: true });
  const w = {
    python3: hat('python3'),
    '7z': hat('7z'),
    tar: hat('tar'),
    gzip: hat('gzip'),
    bzip2: hat('bzip2'),
    xz: hat('xz'),
    zstd: hat('zstd'),
    sqlite3: hat('sqlite3'),
    unzip: hat('unzip'),
  };
  const pfade = {};
  const erwartet = {};
  const schreibe = async (schluessel, name, inhalt) => {
    const p = join(dir, name);
    await writeFile(p, inhalt);
    pfade[schluessel] = p;
    return p;
  };

  // ---------------------------------------------------------------- Quellbaum (fuer tar/7z/zip-Werkzeuge)
  const q = join(dir, 'quelle');
  await mkdir(join(q, 'sub'), { recursive: true });
  await writeFile(join(q, 'a.txt'), 'hallo\n');
  await writeFile(join(q, 'sub', 'b.bin'), fuell(3000, 9));
  await symlink('../../etc/passwd', join(q, 'sub', 'innen'));
  await symlink('../../../x', join(q, 'sub', 'raus'));
  await symlink('/etc/shadow', join(q, 'abs'));
  await chmod(join(q, 'a.txt'), 0o644);

  // ---------------------------------------------------------------- ZIP echt (python3, 7z)
  if (w.python3) {
    const manifest = JSON.parse(lauf('python3', ['-c', PYTHON_ZIPS, dir]).toString());
    erwartet.zipManifest = manifest;
    for (const fn of Object.keys(manifest)) pfade['zip:' + fn] = join(dir, fn);
  }
  if (w['7z']) {
    lauf('7z', ['a', '-tzip', '-bd', join(dir, 'sevenz.zip'), 'quelle'], { cwd: dir });
    pfade['zip:sevenz.zip'] = join(dir, 'sevenz.zip');
    lauf('7z', ['a', '-tzip', '-bd', '-pgeheim', '-mem=ZipCrypto', join(dir, 'zipcrypto.zip'), 'quelle/a.txt'], { cwd: dir });
    pfade['zip:zipcrypto.zip'] = join(dir, 'zipcrypto.zip');
    lauf('7z', ['a', '-tzip', '-bd', '-pgeheim', '-mem=AES256', join(dir, 'aes.zip'), 'quelle/a.txt'], { cwd: dir });
    pfade['zip:aes.zip'] = join(dir, 'aes.zip');
  }

  // ---------------------------------------------------------------- ZIP Hand
  const klein = [
    { name: 'ordner/', daten: Buffer.alloc(0) },
    { name: 'ordner/a.txt', daten: Buffer.from('alpha\n'.repeat(20)), methode: 8 },
    { name: 'b.bin', daten: fuell(300, 3) },
  ];
  await schreibe('zipHandKlein', 'hand-klein.zip', baueZip(klein));
  await schreibe(
    'zipTraversal',
    'traversal.zip',
    baueZip([
      { name: 'ok/fine.txt', daten: Buffer.from('ok') },
      { name: '../../evil.txt', daten: Buffer.from('x') },
      { name: '/etc/passwd', daten: Buffer.from('x') },
      { name: 'C:\\Windows\\system32\\x.dll', daten: Buffer.from('x') },
      { name: '..\\..\\boot.ini', daten: Buffer.from('x') },
      { name: 'a/../../b.txt', daten: Buffer.from('x') },
      { nameBytes: Buffer.from('harmlos.txt\0../../evil.sh', 'latin1'), daten: Buffer.from('x') },
      { name: '\\\\server\\share\\x', daten: Buffer.from('x') },
      { name: 'punkte../name.txt', daten: Buffer.from('x') },
      { name: 'a/./b/../c.txt', daten: Buffer.from('x') },
    ])
  );
  // Unicode-Pfad-Extra (0x7075) mit Traversal, Standardname harmlos.
  const uniName = Buffer.from('../../unicode-evil.txt');
  await schreibe(
    'zipUnicodePfad',
    'unicode-pfad.zip',
    baueZip([{ name: 'harmlos.txt', daten: Buffer.from('x'), extra: Buffer.concat([u16(0x7075), u16(5 + uniName.length), Buffer.from([1]), u32(crc32(Buffer.from('harmlos.txt'))), uniName]) }])
  );

  // Bomben: kleine Dateien, riesige Deklarationen.
  await schreibe(
    'zipBombeDeklariert',
    'bombe-deklariert.zip',
    baueZip([{ name: 'riesig.bin', daten: Buffer.alloc(1000), methode: 8, usize: 2 ** 40, zip64Extra: true }], { zip64: true })
  );
  await schreibe(
    'zipBombeUeberlappend',
    'bombe-ueberlappend.zip',
    baueZip(
      [
        { name: 'basis.bin', daten: Buffer.alloc(2000), methode: 8 },
        ...Array.from({ length: 300 }, (_, i) => ({ name: `k${String(i).padStart(3, '0')}.bin`, daten: Buffer.alloc(2000), methode: 8, offsetOverride: 0, keinLokal: true })),
      ]
    )
  );
  await schreibe(
    'zipBombeEintragszahl',
    'bombe-eintragszahl.zip',
    baueZip([{ name: 'a.txt', daten: Buffer.from('a') }], { zip64: true, eintraegeDeklariert: 5_000_000 })
  );
  await schreibe(
    'zipBombeFaktor',
    'bombe-faktor.zip',
    baueZip(
      [
        { name: 'nullen1.bin', daten: Buffer.alloc(4000), methode: 8, usize: 600 * 1024 * 1024 },
        { name: 'nullen2.bin', daten: Buffer.alloc(4000), methode: 8, usize: 600 * 1024 * 1024 },
      ]
    )
  );
  await schreibe(
    'zipEintragGroesserAlsDatei',
    'eintrag-ausserhalb.zip',
    baueZip([
      { name: 'ok.txt', daten: Buffer.from('ok') },
      { name: 'luege.bin', daten: Buffer.from('xx'), csize: 5_000_000, usize: 5_000_000 },
      { name: 'offset.bin', daten: Buffer.from('xx'), offsetOverride: 123456789 },
    ])
  );
  await schreibe('zipCdAusserhalb', 'cd-ausserhalb.zip', baueZip(klein, { cdSizeOverride: 999999, cdOffsetOverride: 888888 }));

  // ZIP64 von Hand: alles gesaettigt, Offset im ZIP64-Extra.
  await schreibe(
    'zipZip64Hand',
    'zip64-hand.zip',
    baueZip(
      [
        { name: 'z1.txt', daten: Buffer.from('eins'), zip64Extra: true },
        { name: 'z2.txt', daten: Buffer.from('zwei zwei'), methode: 8, zip64Extra: true },
      ],
      { zip64: true }
    )
  );

  // Selbstextraktor-Praefix.
  const stub = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), fuell(4092, 5)]);
  erwartet.sfxPraefix = stub.length;
  await schreibe('zipSfx', 'sfx.zip', baueZip(klein, { praefix: stub }));
  await schreibe('zipSfx64', 'sfx64.zip', baueZip([{ name: 'z1.txt', daten: Buffer.from('eins'), zip64Extra: true }], { praefix: stub, zip64: true }));

  // Mehrteilig, leer, abgeschnitten, Kommentar mit Schein-EOCD.
  await schreibe('zipMehrteilig', 'mehrteilig.zip', baueZip(klein, { disk: 1, cdDisk: 1, eintraegeDisk: 3 }));
  const scheinEocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(9), u16(9), u32(77), u32(88), u16(0)]);
  await schreibe('zipKommentarSchein', 'kommentar-schein.zip', baueZip(klein, { kommentar: Buffer.concat([Buffer.from('vorne '), scheinEocd, Buffer.from(' hinten')]) }));
  const ganzesZip = baueZip(klein);
  await schreibe('zipOhneCd', 'ohne-cd.zip', ganzesZip.subarray(0, 180));
  await schreibe('zipEocdKaputt', 'eocd-abgeschnitten.zip', ganzesZip.subarray(0, ganzesZip.length - 10));
  await schreibe('zipTextAlsZip', 'text.zip', Buffer.from('das ist gar kein zip, nur Text\n'.repeat(20)));
  await schreibe('zipNurSignatur', 'nur-signatur.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
  // 100000 Eintraege (leere Dateien): Leistung + Objektgrenze.
  const viele = Array.from({ length: 100_000 }, (_, i) => ({ name: `d/f${String(i).padStart(6, '0')}.t`, daten: Buffer.alloc(0) }));
  await schreibe('zipVieleEintraege', 'viele-eintraege.zip', baueZip(viele));

  // ---------------------------------------------------------------- TAR
  const quelleTar = (name, flags) => {
    const p = join(dir, name);
    lauf('tar', [...flags, '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', p, 'quelle'], { cwd: dir });
    pfade[name] = p;
    return p;
  };
  if (w.tar) {
    quelleTar('gnu.tar', ['--format=gnu']);
    quelleTar('posix.tar', ['--format=posix']);
    quelleTar('ustar.tar', ['--format=ustar']);
    erwartet.tarListe = lauf('tar', ['-tvf', join(dir, 'gnu.tar')]).toString().trim().split('\n');
    if (w.gzip) {
      lauf('tar', ['--format=gnu', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-czf', join(dir, 'echt.tgz'), 'quelle'], { cwd: dir });
      pfade['echt.tgz'] = join(dir, 'echt.tgz');
      await writeFile(join(dir, 'text.gz'), lauf('gzip', ['-n', '-c', join(dir, 'quelle', 'a.txt')]));
      pfade['text.gz'] = join(dir, 'text.gz');
      await writeFile(join(dir, 'kein-tar.tgz'), lauf('gzip', ['-n', '-c', join(dir, 'quelle', 'a.txt')]));
      pfade['kein-tar.tgz'] = join(dir, 'kein-tar.tgz');
    }
    if (w.bzip2) {
      lauf('tar', ['--format=gnu', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cjf', join(dir, 'echt.tar.bz2'), 'quelle'], { cwd: dir });
      pfade['echt.tar.bz2'] = join(dir, 'echt.tar.bz2');
    }
    if (w.xz) {
      lauf('tar', ['--format=gnu', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cJf', join(dir, 'echt.tar.xz'), 'quelle'], { cwd: dir });
      pfade['echt.tar.xz'] = join(dir, 'echt.tar.xz');
    }
    if (w.zstd) {
      lauf('tar', ['--format=gnu', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--zstd', '-cf', join(dir, 'echt.tar.zst'), 'quelle'], { cwd: dir });
      pfade['echt.tar.zst'] = join(dir, 'echt.tar.zst');
    }
  }
  // Hand-TARs.
  const langerName = 'sehr/lang/' + 'verzeichnis_mit_langem_namen/'.repeat(10) + 'datei.txt';
  erwartet.langerName = langerName;
  await schreibe(
    'tarGnuLangname',
    'gnu-langname.tar',
    Buffer.concat([
      tarKopf({ name: '././@LongLink', typ: 'L', size: langerName.length + 1, magic: 'ustar ', version: ' \0' }),
      pad512(Buffer.concat([Buffer.from(langerName), Buffer.from([0])])),
      tarDatei('gekuerzt_vom_langnamen', Buffer.from('inhalt'), { magic: 'ustar ', version: ' \0' }),
      tarEnde(),
    ])
  );
  const praefix = 'p'.repeat(100) + '/' + 'q'.repeat(40);
  erwartet.praefixName = praefix + '/blatt.txt';
  await schreibe('tarPraefix', 'ustar-praefix.tar', Buffer.concat([tarDatei('blatt.txt', Buffer.from('x'), { prefix: praefix }), tarEnde()]));
  const paxPfad = 'pax/' + 'v'.repeat(300) + '/datei.bin';
  erwartet.paxPfad = paxPfad;
  await schreibe(
    'tarPax',
    'pax-pfad.tar',
    Buffer.concat([
      tarKopf({ name: 'PaxHeader/x', typ: 'x', size: Buffer.concat([paxSatz('path', paxPfad), paxSatz('mtime', '1600000000.5')]).length }),
      pad512(Buffer.concat([paxSatz('path', paxPfad), paxSatz('mtime', '1600000000.5')])),
      tarDatei('kurz', Buffer.from('daten-daten')),
      tarEnde(),
    ])
  );
  await schreibe(
    'tarTraversal',
    'traversal.tar',
    Buffer.concat([
      tarDatei('ok/fine.txt', Buffer.from('ok')),
      tarDatei('../../evil.txt', Buffer.from('x')),
      tarDatei('/etc/cron.d/evil', Buffer.from('x')),
      tarKopf({ name: 'lnk_aussen', typ: '2', link: '/etc/passwd' }),
      tarKopf({ name: 'lnk_hoch', typ: '2', link: '../../../../x' }),
      tarKopf({ name: 'dir/lnk_innen', typ: '2', link: '../ok/fine.txt' }),
      tarKopf({ name: 'hart', typ: '1', link: '/etc/shadow' }),
      tarKopf({ name: 'hart_innen', typ: '1', link: 'ok/fine.txt' }),
      tarKopf({ name: 'dev/null', typ: '3' }),
      tarEnde(),
    ])
  );
  await schreibe('tarBase256', 'base256.tar', Buffer.concat([tarDatei('b.bin', Buffer.from('abc'), { sizeBase256: 3 }), tarEnde()]));
  const dreiDateien = Buffer.concat([tarDatei('eins', Buffer.from('1'.repeat(700))), tarDatei('zwei', Buffer.from('zwei')), tarDatei('drei', Buffer.from('drei'))]);
  await schreibe('tarPruefsumme', 'pruefsumme.tar', Buffer.concat([tarDatei('eins', Buffer.from('1')), tarDatei('zwei', Buffer.from('2'), { pruefsummeFalsch: true }), tarEnde()]));
  await schreibe('tarAbgeschnitten', 'abgeschnitten.tar', Buffer.concat([dreiDateien, tarEnde()]).subarray(0, 512 + 512 + 100));
  await schreibe('tarGroesseLuege', 'groesse-luege.tar', Buffer.concat([tarKopf({ name: 'luege.bin', sizeBase256: 2n ** 44n }), fuell(512), tarEnde()]));
  await schreibe('tarOhneEnde', 'ohne-ende.tar', dreiDateien);
  await schreibe('tarLeer', 'leer.tar', tarEnde());
  await schreibe('tarVieleDateien', 'viele.tar', Buffer.concat([...Array.from({ length: 60 }, (_, i) => tarDatei(`d${String(i).padStart(3, '0')}.txt`, Buffer.from('x'))), tarEnde()]));
  await schreibe('tarKeinTar', 'kein-tar.tar', Buffer.from('Das ist kein TAR.\n'.repeat(60)));
  await schreibe('tarKurz', 'kurz.tar', fuell(100, 3));
  // gzip-Bomben (streamend erzeugt, Datei bleibt ~300 KB).
  if (opt.gross !== false) {
    const schreibeGz = async (name, kopf, nullMiB) => {
      const p = join(dir, name);
      const gz = createGzip(); // Standardstufe 6: Nullen komprimieren ~1000:1 (Stufe 1 nur ~100:1)
      const out = createWriteStream(p);
      gz.pipe(out);
      if (kopf) gz.write(kopf);
      const chunk = Buffer.alloc(1 << 20);
      for (let i = 0; i < nullMiB; i++) if (!gz.write(chunk)) await once(gz, 'drain');
      gz.end();
      await once(out, 'finish');
      pfade[name] = p;
    };
    await schreibeGz('bombe-nullen.gz', null, 300);
    await schreibeGz('bombe.tar.gz', tarKopf({ name: 'riesig.bin', size: 300 * 1024 * 1024 }), 300);
  }
  if (pfade['echt.tgz']) {
    const g = await readFile(pfade['echt.tgz']);
    await schreibe('tgzAbgeschnitten', 'abgeschnitten.tgz', g.subarray(0, Math.floor(g.length / 2)));
  }

  // ---------------------------------------------------------------- 7z
  if (w['7z']) {
    for (const f of ['plain.7z', 'kodiert.7z', 'hdr-aes.7z', 'daten-aes.7z']) await rm(join(dir, f), { force: true });
    lauf('7z', ['a', '-bd', '-mhc=off', join(dir, 'plain.7z'), 'quelle'], { cwd: dir });
    lauf('7z', ['a', '-bd', join(dir, 'kodiert.7z'), 'quelle'], { cwd: dir });
    lauf('7z', ['a', '-bd', '-pgeheim', '-mhe=on', join(dir, 'hdr-aes.7z'), 'quelle'], { cwd: dir });
    lauf('7z', ['a', '-bd', '-pgeheim', '-mhe=off', '-mhc=off', join(dir, 'daten-aes.7z'), 'quelle'], { cwd: dir });
    for (const f of ['plain.7z', 'kodiert.7z', 'hdr-aes.7z', 'daten-aes.7z']) pfade[f] = join(dir, f);
    erwartet.siebenListe = lauf('7z', ['l', '-slt', join(dir, 'plain.7z')]).toString();
  }
  const dat = [
    { name: 'ok/a.txt', daten: Buffer.from('alpha') },
    { name: 'ok/b.txt', daten: Buffer.from('bravo bravo') },
    { name: 'c.bin', daten: fuell(100, 3) },
  ];
  await schreibe('sz7Hand', 'hand.7z', baue7z(dat));
  await schreibe('sz7Traversal', 'traversal.7z', baue7z([{ name: '../../evil.txt', daten: Buffer.from('x') }, { name: '/etc/passwd', daten: Buffer.from('y') }, { name: 'C:\\x.dll', daten: Buffer.from('z') }, { name: 'gut.txt', daten: Buffer.from('g') }]));
  await schreibe('sz7Bombe', 'bombe.7z', baue7z([{ name: 'riesig.bin', daten: Buffer.alloc(100) }], { entpacktDeklariert: 2 ** 50 }));
  await schreibe('sz7ZuViele', 'zu-viele.7z', baue7z(dat, { dateienDeklariert: 50_000_000 }));
  await schreibe('sz7StartCrc', 'start-crc.7z', baue7z(dat, { startCrcFalsch: true }));
  await schreibe('sz7HeaderCrc', 'header-crc.7z', baue7z(dat, { headerCrcFalsch: true }));
  await schreibe('sz7HeaderAusserhalb', 'header-ausserhalb.7z', baue7z(dat, { nextOffset: 2 ** 40 }));
  await schreibe('sz7Abgeschnitten', 'abgeschnitten.7z', baue7z(dat).subarray(0, 60));
  await schreibe('sz7Leer', 'leer.7z', baue7zRoh(Buffer.alloc(0), Buffer.alloc(0), { nextOffset: 0, nextGroesse: 0 }));
  await schreibe('sz7Major', 'major.7z', baue7z(dat, { major: 7 }));
  await schreibe('sz7Nur6', 'nur-sig.7z', Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4]));

  // ---------------------------------------------------------------- SQLite (echt, sqlite3-CLI)
  if (w.sqlite3) {
    const sql = (name, text) => {
      const p = join(dir, name);
      lauf('sqlite3', [p], { input: text });
      pfade[name] = p;
      return p;
    };
    sql(
      'schema.db',
      `PRAGMA application_id=1196444487; PRAGMA user_version=42;
CREATE TABLE kunde (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email VARCHAR(120) UNIQUE, angelegt DATETIME DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "bestellung" ("id" INTEGER PRIMARY KEY, kunde_id INTEGER NOT NULL REFERENCES kunde(id) ON DELETE CASCADE, betrag DECIMAL(10, 2) CHECK (betrag >= 0), notiz TEXT /* kommentar, mit Komma */);
CREATE TABLE posten (bestellung_id INT, pos INT, artikel TEXT NOT NULL, menge INT DEFAULT 1, PRIMARY KEY (bestellung_id, pos), FOREIGN KEY (bestellung_id) REFERENCES bestellung(id));
CREATE TABLE [mit leerzeichen] (a INT, \`b c\` TEXT);
CREATE TABLE ohne_rowid (k TEXT PRIMARY KEY, v BLOB) WITHOUT ROWID;
CREATE TABLE verweis (x INTEGER REFERENCES nichtda(y));
CREATE UNIQUE INDEX idx_kunde_email2 ON kunde(email, name);
CREATE INDEX idx_posten_artikel ON posten(artikel) WHERE menge > 1;
CREATE VIEW v_summe AS SELECT kunde_id, SUM(betrag) s FROM bestellung GROUP BY kunde_id;
CREATE TRIGGER trg_kunde AFTER INSERT ON kunde BEGIN INSERT INTO bestellung(kunde_id,betrag) VALUES (new.id, 0); END;
INSERT INTO kunde(name,email) VALUES('a','a@x'),('b','b@x'),('c','c@x');`
    );
    const viele = Array.from({ length: 300 }, (_, i) => `CREATE TABLE t${String(i).padStart(3, '0')} (id INTEGER PRIMARY KEY, name TEXT, wert REAL);`).join('\n');
    sql(
      'viele-tabellen.db',
      `PRAGMA page_size=512;
${viele}
CREATE TABLE langtext (a INT DEFAULT '${'x'.repeat(3000)}', b TEXT);
CREATE TABLE sehrlang (a INT DEFAULT '${'y'.repeat(20000)}', b TEXT);
CREATE VIEW ende AS SELECT 1;`
    );
    sql(
      'gross.db',
      `PRAGMA page_size=1024;
CREATE TABLE klein(i INTEGER);
INSERT INTO klein VALUES (1),(2),(3),(4),(5);
CREATE TABLE gross(i INTEGER PRIMARY KEY, t TEXT);
WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<5000) INSERT INTO gross SELECT i, 'zeile ' || i FROM c;`
    );
    sql('wal.db', `PRAGMA journal_mode=WAL; CREATE TABLE w(a INT); INSERT INTO w VALUES (1),(2); PRAGMA wal_checkpoint(TRUNCATE);`);
    await rm(join(dir, 'wal.db-wal'), { force: true });
    await rm(join(dir, 'wal.db-shm'), { force: true });
    sql('utf16.db', `PRAGMA encoding='UTF-16le'; CREATE TABLE "t\u00fc\u00e4" (spalte_\u00f6 TEXT); CREATE INDEX i_\u00fc ON "t\u00fc\u00e4"(spalte_\u00f6);`);
    sql('page64k.db', `PRAGMA page_size=65536; CREATE TABLE gross_seite(a INT, b TEXT); INSERT INTO gross_seite VALUES (1,'x'),(2,'y');`);
    const sdb = await readFile(pfade['schema.db']);
    await schreibe('dbAbgeschnitten', 'abgeschnitten.db', (await readFile(pfade['gross.db'])).subarray(0, 10_000));
    await schreibe('dbNurHeader', 'nur-header.db', sdb.subarray(0, 100));
    const seiteUngueltig = Buffer.from(sdb);
    seiteUngueltig.writeUInt16BE(3000, 16);
    await schreibe('dbSeitengroesseUngueltig', 'seitengroesse.db', seiteUngueltig);
    const vt = Buffer.from(await readFile(pfade['viele-tabellen.db']));
    erwartet.viele_page1_typ = vt[100];
    // Die Wurzel (Seite 1) hat hier 0 Zellen und nur den ganz rechten Zeiger auf ihr Kind. Zyklus: dessen
    // ganz rechter Zeiger zeigt auf die Seite selbst (Innenseite => Typ 0x05).
    const kind = vt.readUInt32BE(100 + 8);
    erwartet.viele_kind_typ = vt[(kind - 1) * 512];
    vt.writeUInt32BE(kind, (kind - 1) * 512 + 8);
    await schreibe('dbZyklus', 'zyklus.db', vt);
    const kaputteZelle = Buffer.from(sdb);
    kaputteZelle.writeUInt16BE(65000, 100 + 8 + 2 * 0); // 1. Zellzeiger zeigt weit hinter die Seite
    await schreibe('dbKaputteZelle', 'kaputte-zelle.db', kaputteZelle);
  }
  // Ohne Werkzeug: Muell mit SQLite-Endung (verschluesselt aussehend) und Seitentyp-Fehler.
  const rausch = fuell(8192, 77);
  await schreibe('dbRauschen', 'rauschen.sqlite', rausch);
  await schreibe('dbKlein', 'klein.db', fuell(40, 1));

  return { dir, pfade, erwartet, werkzeuge: w, aufraeumen: () => rm(dir, { recursive: true, force: true }) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { dir, pfade, werkzeuge } = await erzeugeArchivFixtures();
  console.log(dir);
  console.log('werkzeuge:', JSON.stringify(werkzeuge));
  for (const [k, p] of Object.entries(pfade)) console.log(`  ${k}: ${p}`);
}
