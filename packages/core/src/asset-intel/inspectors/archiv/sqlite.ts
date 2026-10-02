/**
 * MODUL: Archiv-Inspektor SQLite
 * ZWECK: Liest eine SQLite-Datenbankdatei OHNE SQLite-Bibliothek und NUR LESEND direkt aus den Bytes:
 *        100-Byte-Header, dann sqlite_master (Tabellen, Indizes, Views, Trigger mit CREATE-SQL) durch
 *        Lesen des B-Baums ab Seite 1 (Blatt- und Innenseiten, Overflow-Seiten mit Kappe).
 *
 * WARUM KEINE BIBLIOTHEK: eine geoeffnete SQLite-Datenbank kann Journal-/WAL-Dateien erzeugen, Sperren setzen oder
 * die Datei veraendern. Hier wird nie etwas geoeffnet ausser ueber AssetSource.readRange.
 *
 * GRENZEN: Seitenbudget fuer sqlite_master, Overflow-Kappe je Zelle, Zeilenzaehlung nur fuer KLEINE Baeume
 * (sonst wird sie weggelassen, mit Hinweis). Inhalte aus -wal/-journal sind nicht Teil der Datei und werden nicht
 * gelesen (Hinweis 'wal_modus'). Verschluesselte (z. B. SQLCipher) oder kaputte Datenbanken: status 'teilweise'.
 * Spalten/Fremdschluessel werden GROB aus dem CREATE-Text abgeleitet (Tokenizer, keine volle SQL-Grammatik).
 */

import { erzeugeAssetResult } from '../../types.js';
import type { AssetContext, AssetInspector, AssetObject, AssetReference, AssetResult, AssetSource } from '../../types.js';
import { Warnungen, anzeigeName, faengFehler } from './sicherheit.js';

export const SQLITE_VERSION = 1;

const MAGIC = 'SQLite format 3\0';
/** So viele Seiten liest die sqlite_master-Wanderung hoechstens. */
const MASTER_SEITEN_BUDGET = 4000;
/** Hoechstzahl Overflow-Seiten je Zelle. */
const UEBERLAUF_SEITEN_MAX = 32;
/** Nutzlast je Zelle wird auf so viele Bytes gekappt (CREATE-SQL steht am Ende der Zeile). */
const NUTZLAST_MAX = 16 * 1024;
/** So viele Zeichen CREATE-SQL landen im Objekt. */
const SQL_ANZEIGE_MAX = 4000;
/** Zeilenzaehlung: Seitenbudget je Tabelle und insgesamt. */
const ZEILEN_BUDGET_TABELLE = 32;
const ZEILEN_BUDGET_GESAMT = 1024;
const BAUM_TIEFE_MAX = 24;
const TOKEN_MAX = 8000;

const APPLICATION_IDS: Record<number, string> = {
  0x47504b47: 'GeoPackage',
  0x47503130: 'GeoPackage 1.0',
  0x47503131: 'GeoPackage 1.1',
  0x4d504258: 'MBTiles',
  0x0f055112: 'Fossil',
};

class SqlFehler extends Error {}

interface Spalte {
  name: string;
  type: string;
  primary_key: boolean;
  not_null: boolean;
  unique: boolean;
}

interface Fremdschluessel {
  spalte: string;
  ziel_tabelle: string;
  ziel_spalte: string | null;
}

interface TabellenInfo {
  columns: Spalte[];
  primary_key: string[];
  foreign_keys: Fremdschluessel[];
  without_rowid: boolean;
  autoincrement: boolean;
  virtuell: boolean;
  modul: string | null;
  aus_select: boolean;
}

interface MasterZeile {
  typ: string;
  name: string;
  tblName: string;
  rootpage: number;
  sql: string | null;
  sqlGekappt: boolean;
  offset: number;
  laenge: number;
}

// ---------------------------------------------------------------- Byte-Helfer

function u16(b: Buffer, p: number): number {
  if (p < 0 || p + 2 > b.length) throw new SqlFehler(`Lesen ausserhalb der Seite (u16 @${p})`);
  return b.readUInt16BE(p);
}

function u32(b: Buffer, p: number): number {
  if (p < 0 || p + 4 > b.length) throw new SqlFehler(`Lesen ausserhalb der Seite (u32 @${p})`);
  return b.readUInt32BE(p);
}

/** SQLite-Varint (1..9 Bytes, big-endian). */
function varint(b: Buffer, p: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 8; i++) {
    if (p + i >= b.length) throw new SqlFehler('Varint laeuft ueber das Seitenende');
    const x = b[p + i];
    v = v * 128 + (x & 0x7f);
    if ((x & 0x80) === 0) return [v, i + 1];
  }
  if (p + 8 >= b.length) throw new SqlFehler('Varint laeuft ueber das Seitenende');
  return [v * 256 + b[p + 8], 9];
}

function serialGroesse(t: number): number {
  if (t <= 4) return t;
  if (t === 5) return 6;
  if (t === 6 || t === 7) return 8;
  if (t === 8 || t === 9) return 0;
  if (t >= 12) return t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
  throw new SqlFehler(`Reservierter Serial-Type ${t}`);
}

function dekodiereText(roh: Buffer, enc: number): string {
  if (enc === 2) return Buffer.from(roh.subarray(0, roh.length - (roh.length % 2))).toString('utf16le');
  if (enc === 3) {
    const k = Buffer.from(roh.subarray(0, roh.length - (roh.length % 2)));
    k.swap16();
    return k.toString('utf16le');
  }
  return roh.toString('utf8');
}

type Wert = string | number | null;

/** Dekodiert die ersten n Spalten eines Datensatzes. Gekappte Nutzlast: der letzte Text ist ggf. verkuerzt. */
function dekodiereSatz(daten: Buffer, n: number, enc: number): { werte: Wert[]; gekuerzt: boolean } {
  const [hdrLen, hl] = varint(daten, 0);
  if (hdrLen < hl || hdrLen > daten.length) throw new SqlFehler('Satzkopf ragt ueber die Nutzlast');
  const typen: number[] = [];
  let p = hl;
  while (p < hdrLen && typen.length < n) {
    const [t, l] = varint(daten, p);
    typen.push(t);
    p += l;
  }
  const werte: Wert[] = [];
  let q = hdrLen;
  let gekuerzt = false;
  for (const t of typen) {
    const g = serialGroesse(t);
    const verfuegbar = Math.max(0, Math.min(g, daten.length - q));
    if (verfuegbar < g) gekuerzt = true;
    const roh = daten.subarray(q, q + verfuegbar);
    if (t === 0) werte.push(null);
    else if (t === 8) werte.push(0);
    else if (t === 9) werte.push(1);
    else if (t >= 1 && t <= 6) werte.push(verfuegbar < g ? null : t === 6 ? Number(roh.readBigInt64BE(0)) : roh.readIntBE(0, g));
    else if (t === 7) werte.push(verfuegbar < g ? null : roh.readDoubleBE(0));
    else if (t >= 12 && t % 2 === 1) werte.push(dekodiereText(roh, enc));
    else werte.push(null); // BLOB
    q += g;
  }
  return { werte, gekuerzt };
}

// ---------------------------------------------------------------- CREATE-SQL (grob)

interface Tok {
  t: 'id' | 'str' | 'num' | 'p';
  v: string;
  /** In Anfuehrungszeichen/Klammern gestellter Bezeichner: nie ein Schluesselwort. */
  q: boolean;
}

function tokenisiere(sql: string): Tok[] {
  const aus: Tok[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n && aus.length < TOKEN_MAX) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e < 0 ? n : e + 2;
    } else if (c === '"' || c === '`' || c === "'") {
      let j = i + 1;
      let v = '';
      for (;;) {
        if (j >= n) break;
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            v += c;
            j += 2;
            continue;
          }
          break;
        }
        v += sql[j++];
      }
      aus.push({ t: c === "'" ? 'str' : 'id', v, q: true });
      i = j + 1;
    } else if (c === '[') {
      const e = sql.indexOf(']', i + 1);
      const j = e < 0 ? n : e;
      aus.push({ t: 'id', v: sql.slice(i + 1, j), q: true });
      i = j + 1;
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j])) j++;
      aus.push({ t: 'id', v: sql.slice(i, j), q: false });
      i = j;
    } else if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxX._]/.test(sql[j])) j++;
      aus.push({ t: 'num', v: sql.slice(i, j), q: false });
      i = j;
    } else {
      aus.push({ t: 'p', v: c, q: false });
      i++;
    }
  }
  return aus;
}

const istKw = (t: Tok | undefined, kw: string): boolean => !!t && t.t === 'id' && !t.q && t.v.toUpperCase() === kw;

/** Index der zur Klammer bei start passenden schliessenden Klammer (oder tokens.length). */
function klammerEnde(tok: Tok[], start: number): number {
  let tiefe = 0;
  for (let i = start; i < tok.length; i++) {
    if (tok[i].t === 'p' && tok[i].v === '(') tiefe++;
    else if (tok[i].t === 'p' && tok[i].v === ')') {
      tiefe--;
      if (tiefe === 0) return i;
    }
  }
  return tok.length;
}

/** Zerlegt tok[von..bis) an Kommas der obersten Ebene. */
function trenneKomma(tok: Tok[], von: number, bis: number): Tok[][] {
  const teile: Tok[][] = [];
  let akt: Tok[] = [];
  let tiefe = 0;
  for (let i = von; i < bis; i++) {
    const t = tok[i];
    if (t.t === 'p' && t.v === '(') tiefe++;
    else if (t.t === 'p' && t.v === ')') tiefe--;
    if (t.t === 'p' && t.v === ',' && tiefe === 0) {
      teile.push(akt);
      akt = [];
    } else akt.push(t);
  }
  if (akt.length) teile.push(akt);
  return teile;
}

/** Namen aus "( a, b, c )" ab Index start (Klammer auf). */
function nameListe(tok: Tok[], start: number): { namen: string[]; ende: number } {
  const ende = klammerEnde(tok, start);
  const namen: string[] = [];
  for (const teil of trenneKomma(tok, start + 1, ende)) {
    if (teil[0] && teil[0].t === 'id') namen.push(teil[0].v);
    else if (teil.length) namen.push('<ausdruck>');
  }
  return { namen, ende };
}

const SPALTEN_STOPP = new Set([
  'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS', 'CONSTRAINT',
]);

function parseCreateTable(sql: string): TabellenInfo {
  const info: TabellenInfo = { columns: [], primary_key: [], foreign_keys: [], without_rowid: false, autoincrement: false, virtuell: false, modul: null, aus_select: false };
  const tok = tokenisiere(sql);
  if (istKw(tok[1], 'VIRTUAL')) {
    info.virtuell = true;
    const u = tok.findIndex(t => istKw(t, 'USING'));
    if (u >= 0 && tok[u + 1]) info.modul = tok[u + 1].v;
    return info;
  }
  const open = tok.findIndex(t => t.t === 'p' && t.v === '(');
  const asPos = tok.findIndex(t => istKw(t, 'AS'));
  if (asPos >= 0 && (open < 0 || asPos < open)) {
    info.aus_select = true;
    return info;
  }
  if (open < 0) return info;
  const ende = klammerEnde(tok, open);
  for (let i = ende + 1; i + 1 < tok.length; i++) if (istKw(tok[i], 'WITHOUT') && istKw(tok[i + 1], 'ROWID')) info.without_rowid = true;
  const tabellenPk: string[] = [];
  for (let teil of trenneKomma(tok, open + 1, ende)) {
    if (teil.length === 0) continue;
    if (istKw(teil[0], 'CONSTRAINT')) teil = teil.slice(2);
    const k = teil[0];
    if (!k) continue;
    if (istKw(k, 'PRIMARY') && istKw(teil[1], 'KEY')) {
      const p = teil.findIndex(t => t.t === 'p' && t.v === '(');
      if (p >= 0) tabellenPk.push(...nameListe(teil, p).namen);
      continue;
    }
    if (istKw(k, 'UNIQUE') || istKw(k, 'CHECK')) continue;
    if (istKw(k, 'FOREIGN') && istKw(teil[1], 'KEY')) {
      const p = teil.findIndex(t => t.t === 'p' && t.v === '(');
      const r = teil.findIndex(t => istKw(t, 'REFERENCES'));
      if (p >= 0 && r >= 0 && teil[r + 1]) {
        const lokal = nameListe(teil, p).namen;
        const zielT = teil[r + 1].v;
        const zp = teil[r + 2] && teil[r + 2].t === 'p' && teil[r + 2].v === '(' ? nameListe(teil, r + 2).namen : [];
        lokal.forEach((sp, idx) => info.foreign_keys.push({ spalte: sp, ziel_tabelle: zielT, ziel_spalte: zp[idx] ?? null }));
      }
      continue;
    }
    // Spaltendefinition.
    const spalte: Spalte = { name: k.v, type: '', primary_key: false, not_null: false, unique: false };
    let j = 1;
    const typTeile: string[] = [];
    while (j < teil.length) {
      const t = teil[j];
      if (t.t === 'id' && !t.q && SPALTEN_STOPP.has(t.v.toUpperCase())) break;
      if (t.t === 'p' && t.v === '(') {
        const e = klammerEnde(teil, j);
        typTeile.push('(' + teil.slice(j + 1, e).map(x => x.v).join('') + ')');
        j = e + 1;
        continue;
      }
      typTeile.push(t.v);
      j++;
    }
    spalte.type = typTeile.join(' ').replace(/ \(/g, '(');
    for (; j < teil.length; j++) {
      const t = teil[j];
      if (istKw(t, 'PRIMARY') && istKw(teil[j + 1], 'KEY')) {
        spalte.primary_key = true;
        if (teil.slice(j, j + 6).some(x => istKw(x, 'AUTOINCREMENT'))) info.autoincrement = true;
      } else if (istKw(t, 'NOT') && istKw(teil[j + 1], 'NULL')) spalte.not_null = true;
      else if (istKw(t, 'UNIQUE')) spalte.unique = true;
      else if (istKw(t, 'REFERENCES') && teil[j + 1]) {
        const zp = teil[j + 2] && teil[j + 2].t === 'p' && teil[j + 2].v === '(' ? nameListe(teil, j + 2).namen : [];
        info.foreign_keys.push({ spalte: spalte.name, ziel_tabelle: teil[j + 1].v, ziel_spalte: zp[0] ?? null });
      }
    }
    info.columns.push(spalte);
  }
  for (const c of info.columns) {
    if (tabellenPk.some(p => p.toLowerCase() === c.name.toLowerCase())) c.primary_key = true;
  }
  // WITHOUT ROWID: Primaerschluesselspalten sind implizit NOT NULL (so meldet es auch `pragma table_info`).
  if (info.without_rowid) for (const c of info.columns) if (c.primary_key) c.not_null = true;
  info.primary_key = info.columns.filter(c => c.primary_key).map(c => c.name);
  return info;
}

function parseCreateIndex(sql: string): { unique: boolean; spalten: string[]; teilindex: boolean } {
  const tok = tokenisiere(sql);
  const unique = istKw(tok[1], 'UNIQUE');
  const p = tok.findIndex(t => t.t === 'p' && t.v === '(');
  const spalten = p >= 0 ? nameListe(tok, p).namen : [];
  return { unique, spalten, teilindex: tok.some(t => istKw(t, 'WHERE')) };
}

function parseCreateTrigger(sql: string): { zeitpunkt: string | null; ereignis: string | null } {
  const tok = tokenisiere(sql).slice(0, 40);
  let zeitpunkt: string | null = null;
  let ereignis: string | null = null;
  for (let i = 0; i < tok.length; i++) {
    const v = tok[i].t === 'id' && !tok[i].q ? tok[i].v.toUpperCase() : '';
    if (!zeitpunkt && (v === 'BEFORE' || v === 'AFTER')) zeitpunkt = v;
    else if (!zeitpunkt && v === 'INSTEAD') zeitpunkt = 'INSTEAD OF';
    else if (zeitpunkt && !ereignis && (v === 'INSERT' || v === 'UPDATE' || v === 'DELETE')) ereignis = v;
  }
  return { zeitpunkt, ereignis };
}

// ---------------------------------------------------------------- Seiten / B-Baum

interface Datei {
  src: AssetSource;
  ctx: AssetContext;
  seitenGroesse: number;
  nutzbar: number;
  seiten: number;
  enc: number;
}

async function lies(d: Datei, nr: number): Promise<Buffer> {
  if (!Number.isSafeInteger(nr) || nr < 1 || nr > d.seiten) throw new SqlFehler(`Seite ${nr} ausserhalb der Datei (1..${d.seiten})`);
  const b = await d.src.readRange((nr - 1) * d.seitenGroesse, d.seitenGroesse);
  if (b.length < d.seitenGroesse) throw new SqlFehler(`Seite ${nr} abgeschnitten`);
  return b;
}

/** Lokal gespeicherte Nutzlastbytes einer Tabellen-Blatt-Zelle (SQLite-Dateiformat, Abschnitt "Cell Payload Overflow"). */
function lokaleNutzlast(p: number, u: number): number {
  const x = u - 35;
  if (p <= x) return p;
  const m = Math.floor(((u - 12) * 32) / 255) - 23;
  const k = m + ((p - m) % (u - 4));
  return k <= x ? k : m;
}

async function ladeNutzlast(
  d: Datei,
  seite: Buffer,
  start: number,
  gesamt: number,
  w: Warnungen
): Promise<{ daten: Buffer; gekappt: boolean; lokal: number }> {
  const lokal = lokaleNutzlast(gesamt, d.nutzbar);
  if (start + lokal > seite.length) throw new SqlFehler('Zelle ragt ueber das Seitenende');
  const teile: Buffer[] = [seite.subarray(start, start + lokal)];
  let haben = lokal;
  const wollen = Math.min(gesamt, NUTZLAST_MAX);
  if (gesamt > lokal && haben < wollen) {
    let naechste = u32(seite, start + lokal);
    let n = 0;
    while (naechste !== 0 && haben < wollen && n < UEBERLAUF_SEITEN_MAX) {
      d.ctx.pruefeAbbruch();
      if (naechste < 2 || naechste > d.seiten) {
        w.add('sqlite_overflow_defekt', `Overflow-Verweis auf Seite ${naechste} ausserhalb der Datei.`);
        break;
      }
      const o = await lies(d, naechste);
      const nimm = Math.min(d.nutzbar - 4, gesamt - haben, wollen - haben);
      teile.push(o.subarray(4, 4 + nimm));
      haben += nimm;
      naechste = o.readUInt32BE(0);
      n++;
    }
  }
  return { daten: Buffer.concat(teile), gekappt: haben < gesamt, lokal };
}

interface MasterLauf {
  zeilen: MasterZeile[];
  seitenBesucht: number;
  gekappt: boolean;
  defekteZellen: number;
}

async function leseMaster(d: Datei, w: Warnungen, maxObj: number): Promise<MasterLauf> {
  const lauf: MasterLauf = { zeilen: [], seitenBesucht: 0, gekappt: false, defekteZellen: 0 };
  const besucht = new Set<number>();

  const besuche = async (nr: number, tiefe: number): Promise<void> => {
    if (lauf.gekappt) return;
    if (besucht.has(nr)) {
      w.add('sqlite_zyklus', `sqlite_master-Baum besucht Seite ${nr} zweimal (Zyklus oder Beschaedigung); Zweig uebersprungen.`);
      lauf.defekteZellen++;
      return;
    }
    if (tiefe > BAUM_TIEFE_MAX) {
      w.add('sqlite_baum_zu_tief', `sqlite_master-Baum tiefer als ${BAUM_TIEFE_MAX} Ebenen.`);
      lauf.defekteZellen++;
      return;
    }
    if (lauf.seitenBesucht >= MASTER_SEITEN_BUDGET) {
      lauf.gekappt = true;
      w.add('sqlite_seitenbudget', `Seitenbudget (${MASTER_SEITEN_BUDGET}) fuer sqlite_master aufgebraucht.`);
      return;
    }
    besucht.add(nr);
    lauf.seitenBesucht++;
    d.ctx.pruefeAbbruch();
    const seite = await lies(d, nr);
    const hdr = nr === 1 ? 100 : 0;
    const typ = seite[hdr];
    const zellen = u16(seite, hdr + 3);
    if (typ === 0x0d) {
      const zeigerStart = hdr + 8;
      for (let i = 0; i < zellen; i++) {
        if (lauf.zeilen.length >= maxObj) {
          lauf.gekappt = true;
          return;
        }
        try {
          const zp = u16(seite, zeigerStart + i * 2);
          if (zp < zeigerStart + zellen * 2 || zp >= seite.length) throw new SqlFehler(`Zellzeiger ${zp} ungueltig`);
          const [gesamt, l1] = varint(seite, zp);
          const [, l2] = varint(seite, zp + l1);
          const nutz = await ladeNutzlast(d, seite, zp + l1 + l2, gesamt, w);
          const { werte, gekuerzt } = dekodiereSatz(nutz.daten, 5, d.enc);
          const [typS, nameS, tblS, rootS, sqlS] = werte;
          lauf.zeilen.push({
            typ: String(typS ?? ''),
            name: String(nameS ?? ''),
            tblName: String(tblS ?? ''),
            rootpage: typeof rootS === 'number' ? rootS : 0,
            sql: sqlS === null || sqlS === undefined ? null : String(sqlS),
            sqlGekappt: nutz.gekappt || gekuerzt,
            offset: (nr - 1) * d.seitenGroesse + zp,
            laenge: l1 + l2 + nutz.lokal,
          });
        } catch (e) {
          if (!(e instanceof SqlFehler)) throw e;
          lauf.defekteZellen++;
          w.add('sqlite_zelle_defekt', `Seite ${nr}, Zelle ${i}: ${e.message}`);
        }
      }
    } else if (typ === 0x05) {
      const zeigerStart = hdr + 12;
      const kinder: number[] = [];
      for (let i = 0; i < zellen; i++) {
        try {
          const zp = u16(seite, zeigerStart + i * 2);
          kinder.push(u32(seite, zp));
        } catch (e) {
          if (!(e instanceof SqlFehler)) throw e;
          lauf.defekteZellen++;
          w.add('sqlite_zelle_defekt', `Seite ${nr}, Innenzelle ${i}: ${e.message}`);
        }
      }
      kinder.push(u32(seite, hdr + 8)); // ganz rechter Zeiger
      for (const k of kinder) {
        try {
          await besuche(k, tiefe + 1);
        } catch (e) {
          if (!(e instanceof SqlFehler)) throw e;
          lauf.defekteZellen++;
          w.add('sqlite_seite_defekt', e.message);
        }
        if (lauf.gekappt) return;
      }
    } else {
      throw new SqlFehler(`Seite ${nr} hat unerwarteten Typ 0x${typ.toString(16)} (erwartet 0x0d oder 0x05)`);
    }
  };

  await besuche(1, 0);
  return lauf;
}

/** Zaehlt Zeilen eines Tabellenbaums, aber nur wenn er klein ist; sonst null. */
async function zaehleZeilen(d: Datei, root: number, budget: { rest: number }): Promise<number | null> {
  let zeilen = 0;
  let seiten = 0;
  const stapel: number[] = [root];
  const gesehen = new Set<number>();
  while (stapel.length) {
    const nr = stapel.pop()!;
    if (gesehen.has(nr)) return null;
    gesehen.add(nr);
    if (++seiten > ZEILEN_BUDGET_TABELLE || budget.rest <= 0) return null;
    budget.rest--;
    d.ctx.pruefeAbbruch();
    const seite = await lies(d, nr);
    const hdr = nr === 1 ? 100 : 0;
    const typ = seite[hdr];
    const zellen = u16(seite, hdr + 3);
    if (typ === 0x0d) zeilen += zellen;
    else if (typ === 0x05) {
      for (let i = 0; i < zellen; i++) stapel.push(u32(seite, u16(seite, hdr + 12 + i * 2)));
      stapel.push(u32(seite, hdr + 8));
    } else return null; // Index-Baum (WITHOUT ROWID) o. Ae.: nicht gezaehlt
  }
  return zeilen;
}

// ---------------------------------------------------------------- Inspektion

async function inspiziere(src: AssetSource, ctx: AssetContext, res: AssetResult, w: Warnungen): Promise<void> {
  const meta = res.metadata;
  const fs = res.format_specific;
  const maxObj = ctx.limits.maxObjects;
  if (src.size < 100) {
    w.add('sqlite_zu_klein', `Datei (${src.size} Bytes) kleiner als der SQLite-Header (100 Bytes).`);
    res.status = 'teilweise';
    return;
  }
  const h = await src.readRange(0, 100);
  if (h.length < 100 || h.toString('latin1', 0, 16) !== MAGIC) {
    w.add(
      'sqlite_header_ungueltig',
      'Der SQLite-Header fehlt: die Datei ist verschluesselt (z. B. SQLCipher), beschaedigt oder keine SQLite-Datenbank.'
    );
    res.status = 'teilweise';
    return;
  }
  let seitenGroesse = h.readUInt16BE(16);
  if (seitenGroesse === 1) seitenGroesse = 65536;
  const schreib = h[18];
  const lese = h[19];
  const reserviert = h[20];
  const aenderungsZaehler = h.readUInt32BE(24);
  const seitenHeader = h.readUInt32BE(28);
  const enc = h.readUInt32BE(56);
  const gueltigFuer = h.readUInt32BE(92);
  const appId = h.readUInt32BE(68);

  meta.seitengroesse = seitenGroesse;
  meta.schreib_version = schreib;
  meta.lese_version = lese;
  meta.reservierte_bytes_je_seite = reserviert;
  meta.schema_cookie = h.readUInt32BE(40);
  meta.schema_format = h.readUInt32BE(44);
  meta.user_version = h.readUInt32BE(60);
  meta.application_id = appId;
  meta.application_name = APPLICATION_IDS[appId] ?? null;
  meta.freiliste_seiten = h.readUInt32BE(36);
  meta.textcodierung = enc === 1 ? 'utf-8' : enc === 2 ? 'utf-16le' : enc === 3 ? 'utf-16be' : null;
  meta.auto_vacuum = h.readUInt32BE(52) !== 0;
  meta.inkrementelles_vacuum = h.readUInt32BE(64) !== 0;
  meta.sqlite_version_number = h.readUInt32BE(96);
  meta.wal_modus = schreib === 2 || lese === 2;
  if (meta.wal_modus) {
    w.add('wal_modus', 'Die Datenbank steht im WAL-Modus: Aenderungen, die nur in der -wal-Datei liegen, sind nicht Teil dieser Datei und werden nicht gelesen.');
  }

  const gueltigeGroesse = seitenGroesse >= 512 && seitenGroesse <= 65536 && (seitenGroesse & (seitenGroesse - 1)) === 0;
  if (!gueltigeGroesse) {
    w.add('sqlite_seitengroesse_ungueltig', `Seitengroesse ${seitenGroesse} ist keine Zweierpotenz zwischen 512 und 65536.`);
    res.status = 'teilweise';
    return;
  }
  if (enc < 1 || enc > 3) {
    w.add('sqlite_codierung_ungueltig', `Textcodierung ${enc} unbekannt (erwartet 1..3).`);
    res.status = 'teilweise';
    return;
  }
  const dateiSeiten = Math.floor(src.size / seitenGroesse);
  // Die Seitenzahl im Header gilt nur, wenn der Aenderungszaehler zum "Version-valid-for"-Feld passt.
  const headerSeitenGueltig = seitenHeader > 0 && aenderungsZaehler === gueltigFuer;
  meta.seiten_laut_header = headerSeitenGueltig ? seitenHeader : null;
  meta.seiten_laut_dateigroesse = dateiSeiten;
  const seiten = headerSeitenGueltig ? Math.min(seitenHeader, dateiSeiten) : dateiSeiten;
  meta.seiten = seiten;
  if (src.size % seitenGroesse !== 0) {
    w.add('sqlite_groesse_kein_vielfaches', `Dateigroesse ${src.size} ist kein Vielfaches der Seitengroesse ${seitenGroesse} (abgeschnitten?).`);
    res.status = 'teilweise';
  }
  if (headerSeitenGueltig && seitenHeader > dateiSeiten) {
    w.add('sqlite_abgeschnitten', `Der Header nennt ${seitenHeader} Seiten, die Datei enthaelt nur ${dateiSeiten}.`);
    res.status = 'teilweise';
  }
  const nutzbar = seitenGroesse - reserviert;
  if (nutzbar < 480) {
    w.add('sqlite_reserve_ungueltig', `Reservierte Bytes je Seite (${reserviert}) lassen weniger als 480 nutzbare Bytes.`);
    res.status = 'teilweise';
    return;
  }
  if (seiten < 1) {
    w.add('sqlite_keine_seite', 'Die Datei enthaelt keine vollstaendige Seite.');
    res.status = 'teilweise';
    return;
  }

  const d: Datei = { src, ctx, seitenGroesse, nutzbar, seiten, enc };
  let lauf: MasterLauf;
  try {
    lauf = await leseMaster(d, w, maxObj);
  } catch (e) {
    if (!(e instanceof SqlFehler)) throw e;
    w.add('sqlite_master_unlesbar', `sqlite_master nicht lesbar: ${e.message}`);
    res.status = 'teilweise';
    return;
  }
  if (lauf.defekteZellen > 0) res.status = 'teilweise';
  if (lauf.gekappt) res.status = 'teilweise';
  fs.master_seiten_besucht = lauf.seitenBesucht;
  fs.master_defekte_zellen = lauf.defekteZellen;

  // Tabellenverzeichnis fuer Fremdschluessel-Aufloesung.
  const tabellen = new Map<string, TabellenInfo>();
  const infoZu = new Map<MasterZeile, TabellenInfo>();
  for (const z of lauf.zeilen) {
    if (z.typ === 'table' && z.sql) {
      const info = parseCreateTable(z.sql);
      infoZu.set(z, info);
      tabellen.set(z.name.toLowerCase(), info);
    }
  }

  const objekte: AssetObject[] = [];
  const refs: AssetReference[] = [];
  const zaehlerArt: Record<string, number> = { table: 0, index: 0, view: 0, trigger: 0 };
  const budget = { rest: ZEILEN_BUDGET_GESAMT };
  let zeilenOhne = 0;
  for (const z of lauf.zeilen) {
    ctx.pruefeAbbruch();
    if (!(z.typ in zaehlerArt)) continue;
    zaehlerArt[z.typ]++;
    const data: Record<string, unknown> = {
      tabelle: z.tblName,
      rootpage: z.rootpage,
      intern: z.name.startsWith('sqlite_'),
    };
    if (z.sql !== null) {
      data.sql = z.sql.length > SQL_ANZEIGE_MAX ? z.sql.slice(0, SQL_ANZEIGE_MAX) : z.sql;
      data.sql_gekappt = z.sqlGekappt || z.sql.length > SQL_ANZEIGE_MAX;
    } else data.sql = null; // automatisch angelegter Index
    if (z.sqlGekappt) w.einmal('sqlite_sql_gekappt', 'Mindestens ein CREATE-Text ist laenger als die Lesekappe und wurde gekuerzt.');

    if (z.typ === 'table') {
      const info = infoZu.get(z);
      if (info) {
        data.columns = info.columns.map(c => ({ name: c.name, type: c.type, primary_key: c.primary_key, not_null: c.not_null, unique: c.unique }));
        data.primary_key = info.primary_key;
        data.foreign_keys = info.foreign_keys;
        data.without_rowid = info.without_rowid;
        data.autoincrement = info.autoincrement;
        data.virtuell = info.virtuell;
        if (info.modul) data.modul = info.modul;
        if (info.aus_select) data.aus_select = true;
        for (const fk of info.foreign_keys) {
          const ziel = tabellen.get(fk.ziel_tabelle.toLowerCase());
          const spaltenDa = ziel ? (fk.ziel_spalte === null ? true : ziel.columns.some(c => c.name.toLowerCase() === fk.ziel_spalte!.toLowerCase())) : false;
          if (refs.length < maxObj) {
            refs.push({ target: fk.ziel_spalte ? `${fk.ziel_tabelle}.${fk.ziel_spalte}` : fk.ziel_tabelle, kind: 'foreign_key', resolved: !!ziel && spaltenDa });
          }
        }
      }
      // Zeilenzahl nur fuer kleine Baeume.
      if (z.rootpage > 0 && !(info && info.virtuell)) {
        let n: number | null = null;
        try {
          n = z.rootpage <= seiten ? await zaehleZeilen(d, z.rootpage, budget) : null;
        } catch (e) {
          if (!(e instanceof SqlFehler)) throw e;
          n = null;
        }
        if (n !== null) data.zeilen = n;
        else {
          data.zeilen = null;
          data.zeilen_hinweis = 'nicht_gezaehlt_baum_gross_oder_index_baum';
          zeilenOhne++;
        }
      }
    } else if (z.typ === 'index' && z.sql) {
      const ix = parseCreateIndex(z.sql);
      data.unique = ix.unique;
      data.spalten = ix.spalten;
      data.teilindex = ix.teilindex;
    } else if (z.typ === 'index') {
      data.automatisch = true;
    } else if (z.typ === 'trigger' && z.sql) {
      const tr = parseCreateTrigger(z.sql);
      data.zeitpunkt = tr.zeitpunkt;
      data.ereignis = tr.ereignis;
    }
    objekte.push({ name: anzeigeName(z.name), kind: z.typ, data, source_range: { offset: z.offset, length: z.laenge } });
  }
  if (zeilenOhne > 0) w.einmal('zeilenzahl_weggelassen', `Fuer ${zeilenOhne} Tabelle(n) wurde die Zeilenanzahl weggelassen (Baum zu gross fuer eine guenstige Zaehlung).`);
  if (lauf.zeilen.length >= maxObj && lauf.gekappt) w.add('objekte_gekappt', `Mehr als ${maxObj} Schemaobjekte; der Rest wurde nicht gelesen.`);

  meta.tabellen = zaehlerArt.table;
  meta.indizes = zaehlerArt.index;
  meta.views = zaehlerArt.view;
  meta.trigger = zaehlerArt.trigger;
  meta.schema_objekte = lauf.zeilen.length;
  res.objects = objekte;
  res.references = refs;
}

export const sqliteInspector: AssetInspector = {
  id: 'archiv-sqlite',
  formats: ['sqlite'],
  extensions: ['.sqlite', '.sqlite3', '.db', '.db3', '.s3db', '.sl3', '.sqlitedb'],
  magic: [{ offset: 0, bytes: [...MAGIC].map(c => c.charCodeAt(0)), format: 'sqlite' }],
  version: SQLITE_VERSION,
  async inspect(src, ctx) {
    const w = new Warnungen();
    const res = erzeugeAssetResult(src.filePath, src.size, {
      asset_type: 'database',
      format: 'sqlite',
      inspector: 'archiv-sqlite',
      parser_version: SQLITE_VERSION,
    });
    try {
      await inspiziere(src, ctx, res, w);
    } catch (e) {
      faengFehler(e, w);
      res.status = 'teilweise';
    }
    res.warnings = w.fertig();
    return res;
  },
};
