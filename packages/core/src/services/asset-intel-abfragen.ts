/**
 * MODUL: Asset-Intel Abfragen (Leseweg)
 * ZWECK: Alle Lese-Abfragen des Tools asset_intel ueber asset_files, asset_objects und
 *        asset_references (Baum, Inspektion aus der DB, Objekte, Verweise vorwaerts/rueckwaerts,
 *        fehlende Ziele, Abhaengigkeitsgraph, Wurzeln/Waisen, Suche, Verschiebe-Vorschau, Zustand).
 *
 * GRUNDLAGE: Entwurf thought 999610b9, Abschnitt 3; Schema in db/schema-sql/95_asset_intel.sql.
 * Geschrieben wird hier NICHTS (Schreibweg: services/asset-intel-store.ts).
 *
 * SICHERHEIT:
 *   - Kein SQL aus Nutzereingaben: Werte, Muster und JSON-Schluessel gehen ausschliesslich als
 *     Parameter ($n) an PostgreSQL. In den SQL-Text kommen nur feste Bausteine, Platzhalter-
 *     nummern und Operatoren aus einer festen Tabelle (FILTER_OPS).
 *   - Eigenschaftsfilter werden vorher streng geprueft (FILTER_RE, max. ASSET_MAX_FILTER).
 *   - Zahlvergleiche nur bei jsonb_typeof = 'number' (CASE), ein Cast-Fehler ist ausgeschlossen.
 *
 * SPERREN (regel-schema-60s-und-keine-sperre-mit-client-warten): nur SELECT im Autocommit,
 * keine offene Transaktion; statement_timeout 10 s, lock_timeout 2 s je Verbindung.
 *
 * KAPPUNG: jede Liste traegt total + gekappt; kappeAntwort() haelt eine Antwort hart unter
 * ASSET_ANTWORT_MAX Zeichen (zuerst data-Werte auf 300 Zeichen, dann Listen halbieren).
 */

import * as path from 'path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
/** P18-T86: wirksame Reverse-Lesegrenzen (reverse_einstellungen) je Anfrage; Projekt-Assets behalten ihre Standards. */
export interface ReverseAssetGrenzen {
  lese_timeout_ms: number; lock_timeout_ms: number; idle_tx_timeout_ms: number; pfad_zeichen: number; baum_tiefe: number;
  seiten_limit: number; max_limit: number; objekt_limit: number; objekt_max: number; verweis_limit: number; verweis_max: number;
}
const reverseAssetLeser = new AsyncLocalStorage<{ pool: Pool; grenzen?: ReverseAssetGrenzen }>();
/** RV16: injizierter, request-scoped Reverse-Leser; Projektausgabe unverändert. */
export function mitReverseAssetLeser<T>(pool: Pool, run: () => T, grenzen?: ReverseAssetGrenzen): T { return reverseAssetLeser.run({ pool, grenzen }, run); }
/** Grenzen gelten nur im Reverse-Bereich und nur innerhalb von mitReverseAssetLeser. */
function reverseGrenzen(bereich: AssetBereich): ReverseAssetGrenzen | undefined {
  return bereich === REVERSE_ASSET_BEREICH ? reverseAssetLeser.getStore()?.grenzen : undefined;
}
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { assetBereichSql, pruefeAssetBereich, ASSET_BEREICH, REVERSE_ASSET_BEREICH } from './intel-bereich.js';
import { leseAssetIndexWirklichkeit } from './asset-transfer-generisch.js';
import type { AssetBereich } from './intel-bereich.js';
export { ASSET_BEREICH, REVERSE_ASSET_BEREICH } from './intel-bereich.js';
export type { AssetBereich } from './intel-bereich.js';
import { standardRegistry } from '../asset-intel/index.js';
import { loesePfadAuf, normalisiereAssetPfad } from './asset-intel-store.js';

/** Harte Obergrenze einer Antwort in Zeichen (JSON). */
export const ASSET_ANTWORT_MAX = 60000;
/** Laenge, auf die einzelne data-/metadata-Werte beim Kappen gekuerzt werden. */
export const ASSET_DATA_WERT_MAX = 300;
/** Hoechstzahl Eigenschaftsfilter je Abfrage. */
export const ASSET_MAX_FILTER = 5;
/** Hoechste Tiefe fuer graph. */
export const ASSET_GRAPH_MAX_TIEFE = 10;
/** Zeitgrenze je Lese-Abfrage (Millisekunden). */
export const ASSET_LESE_TIMEOUT_MS = 10000;

const LOCK_TIMEOUT_MS = 2000;
/** Obergrenze der Zeilen, die die rekursive Graph-Abfrage erzeugen darf (DAGs mit geteilten Knoten). */
const GRAPH_ZEILEN_MAX = 20000;
const GEKUERZT = '…[gekuerzt]';

export const ASSET_STATUS = ['ok', 'teilweise', 'nicht_erkannt', 'fehler', 'quelle_nicht_gefunden'] as const;

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

/** Fachlicher Fehler mit stabilem Code und Hinweis fuer den Aufrufer. */
export class AssetIntelFehler extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hinweis?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AssetIntelFehler';
  }
}

// ---------------------------------------------------------------------------
// Ausfuehrung: eine Verbindung je Aufruf, Autocommit, Zeitgrenzen
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Zeile = Record<string, any>;
type Leser = (sql: string, params?: unknown[]) => Promise<Zeile[]>;

/** Zeitgrenze je Lese-Abfrage: SYNAPSE_ASSET_LESE_TIMEOUT_MS (1..60000), sonst ASSET_LESE_TIMEOUT_MS. */
function leseTimeoutMs(): number {
  const n = Number(process.env.SYNAPSE_ASSET_LESE_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 1 && n <= 60000 ? n : ASSET_LESE_TIMEOUT_MS;
}

async function mitLeser<T>(bereich: AssetBereich, project: string, fn: (q: Leser) => Promise<T>): Promise<T> {
  pruefeAssetBereich(bereich);
  // P22-T236: Schalter asset_index_wirklichkeit EIN = nur vorhandene Projekt-Assets sichtbar (intel-bereich.ts). AUS/Lesefehler = Altverhalten.
  const nurVorhandene = bereich === ASSET_BEREICH ? (await leseAssetIndexWirklichkeit(project)).aktiv : false;
  const client: PoolClient = await (bereich === REVERSE_ASSET_BEREICH ? reverseAssetLeser.getStore()?.pool ?? getPool() : getPool()).connect();
  const g = reverseGrenzen(bereich);
  const timeout = g?.lese_timeout_ms ?? leseTimeoutMs();
  try {
    await client.query(
      'SET statement_timeout = ' + timeout + '; SET lock_timeout = ' + (g?.lock_timeout_ms ?? LOCK_TIMEOUT_MS) +
        '; SET idle_in_transaction_session_timeout = ' + (g?.idle_tx_timeout_ms ?? Math.max(timeout, ASSET_LESE_TIMEOUT_MS))
    );
    const q: Leser = async (sql, params = []) => (await client.query(assetBereichSql(sql, bereich, { nurVorhandene }), params)).rows as Zeile[];
    return await fn(q);
  } finally {
    try {
      await client.query('RESET statement_timeout; RESET lock_timeout; RESET idle_in_transaction_session_timeout');
      client.release();
    } catch (e) {
      client.release(e instanceof Error ? e : true);
    }
  }
}

/** Sammelt Parameter und liefert den passenden Platzhalter ($n). */
class Parameter {
  readonly werte: unknown[];
  constructor(start: unknown[] = []) {
    this.werte = [...start];
  }
  add(wert: unknown): string {
    this.werte.push(wert);
    return '$' + this.werte.length;
  }
}

/** Maskiert %, _ und \ fuer LIKE/ILIKE (Escape-Zeichen ist der Standard-Backslash). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, m => '\\' + m);
}

/** Ganzzahl-Parameter mit Standard und Grenzen; Unsinn -> parameter_ungueltig. */
function zahl(wert: unknown, name: string, std: number, min: number, max: number): number {
  if (wert === undefined || wert === null || wert === '') return std;
  const n = typeof wert === 'string' ? Number(wert) : wert;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new AssetIntelFehler('parameter_ungueltig', name + ': Zahl erwartet, bekommen ' + JSON.stringify(wert), name + ' zwischen ' + min + ' und ' + max + ' angeben.');
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function text(wert: unknown, name: string, max = 500): string | undefined {
  if (wert === undefined || wert === null || wert === '') return undefined;
  if (typeof wert !== 'string') throw new AssetIntelFehler('parameter_ungueltig', name + ': Text erwartet.');
  if (wert.length > max) throw new AssetIntelFehler('parameter_ungueltig', name + ': hoechstens ' + max + ' Zeichen.');
  return wert;
}

function pfadParam(wert: unknown, name = 'file_path', bereich: AssetBereich = ASSET_BEREICH): string {
  const roh = text(wert, name, reverseGrenzen(bereich)?.pfad_zeichen ?? 2000);
  if (roh === undefined) throw new AssetIntelFehler('parameter_fehlt', name + ' fehlt.', name + ' projekt-relativ angeben, z. B. "Content/Held.uasset".');
  try {
    return normalisiereAssetPfad(roh);
  } catch (e) {
    throw new AssetIntelFehler('pfad_ungueltig', (e as Error).message, name + ' projekt-relativ angeben (ohne fuehrenden "/", ohne "..").');
  }
}

function statusParam(wert: unknown): string | undefined {
  const s = text(wert, 'status', 40);
  if (s !== undefined && !(ASSET_STATUS as readonly string[]).includes(s)) {
    throw new AssetIntelFehler('parameter_ungueltig', 'status unbekannt: ' + s, 'Erlaubt: ' + ASSET_STATUS.join(', '));
  }
  return s;
}

function zahlOderNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Eigenschaftsfilter: '<ziel>.<schluessel><op><wert>'
// ---------------------------------------------------------------------------

export type AssetFilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | '~';

/** Feste Zuordnung Filter-Operator -> SQL-Operator (nur diese Texte gelangen in den SQL-Text). */
const FILTER_OPS: Record<AssetFilterOp, string> = { '=': '=', '!=': '<>', '>': '>', '>=': '>=', '<': '<', '<=': '<=', '~': 'ILIKE' };

/**
 * Ziel: Buchstabe, dann Buchstaben/Ziffern/_/- (asset_type oder Objekt-kind).
 * Schluessel: 1-4 Segmente, je Buchstabe/_ am Anfang, dann Buchstaben/Ziffern/_/- (verschachtelt mit '.').
 * Wert: Rest, hoechstens 200 Zeichen.
 */
const FILTER_RE = /^\s*([A-Za-z][A-Za-z0-9_-]{0,40})\.([A-Za-z_][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,3})\s*(!=|>=|<=|=|>|<|~)\s*([\s\S]{0,200})$/;
const ZAHL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Ein geprueftes Filterglied. */
export interface AssetFilter {
  roh: string;
  ziel: string;
  schluessel: string[];
  op: AssetFilterOp;
  wert: string;
  /** Wert als Zahl, falls er eine ist (sonst null). */
  zahl: number | null;
}

/** Prueft und zerlegt where[] streng. Fehler -> AssetIntelFehler('filter_ungueltig'). */
export function parseAssetFilter(ausdruecke: unknown): AssetFilter[] {
  if (ausdruecke === undefined || ausdruecke === null) return [];
  const liste = typeof ausdruecke === 'string' ? [ausdruecke] : ausdruecke;
  if (!Array.isArray(liste)) throw new AssetIntelFehler('filter_ungueltig', 'where muss eine Liste von Texten sein.', 'Beispiel: where:["image.width>=4096"]');
  if (liste.length > ASSET_MAX_FILTER) {
    throw new AssetIntelFehler('filter_ungueltig', 'Hoechstens ' + ASSET_MAX_FILTER + ' Filter, bekommen ' + liste.length + '.', 'Filter zusammenfassen oder aufteilen.');
  }
  return liste.map((a, i) => {
    const m = typeof a === 'string' ? FILTER_RE.exec(a) : null;
    if (!m) {
      throw new AssetIntelFehler(
        'filter_ungueltig',
        'where[' + i + '] ' + JSON.stringify(typeof a === 'string' ? a.slice(0, 120) : a) + ': erwartet <ziel>.<schluessel><op><wert>.',
        'ziel = asset_type (image, model3d, …) oder Objekt-kind (mesh, material, …); op = != > >= < <= ~; Beispiel image.width>=4096'
      );
    }
    let wert = m[4].trim();
    if (wert.length >= 2 && ((wert[0] === '"' && wert.endsWith('"')) || (wert[0] === "'" && wert.endsWith("'")))) wert = wert.slice(1, -1);
    const op = m[3] as AssetFilterOp;
    const z = ZAHL_RE.test(wert) ? Number(wert) : null;
    const zahlWert = z !== null && Number.isFinite(z) ? z : null;
    if ((op === '>' || op === '>=' || op === '<' || op === '<=') && zahlWert === null) {
      throw new AssetIntelFehler('filter_ungueltig', 'where[' + i + '] "' + a + '": ' + op + ' braucht eine Zahl.', 'Zahlvergleich nur mit Zahlen, Text mit = oder ~.');
    }
    if (op === '~' && wert === '') {
      throw new AssetIntelFehler('filter_ungueltig', 'where[' + i + '] "' + a + '": ~ braucht einen Suchtext.');
    }
    return { roh: a as string, ziel: m[1], schluessel: m[2].split('.'), op, wert, zahl: zahlWert };
  });
}

/**
 * SQL-Bedingung fuer einen Filter auf eine JSONB-Spalte. spalte ist ein FESTER interner
 * Bezeichner ('a.metadata', 'o.data', ...), nie eine Nutzereingabe.
 */
function filterSql(f: AssetFilter, spalte: string, p: Parameter): string {
  const k = p.add(f.schluessel) + '::text[]';
  const e = '(' + spalte + ' #> ' + k + ')';
  const t = '(' + spalte + ' #>> ' + k + ')';
  const num = "(CASE WHEN jsonb_typeof(" + e + ") = 'number' THEN " + t + '::numeric END)';
  switch (f.op) {
    case '>':
    case '>=':
    case '<':
    case '<=':
      return num + ' ' + FILTER_OPS[f.op] + ' ' + p.add(f.zahl) + '::numeric';
    case '~':
      return t + ' ILIKE ' + p.add('%' + escapeLike(f.wert) + '%');
    case '=':
    case '!=': {
      const gleich = f.zahl !== null
        ? 'COALESCE(' + num + ' = ' + p.add(f.zahl) + '::numeric OR ' + t + ' = ' + p.add(f.wert) + ', false)'
        : 'COALESCE(' + t + ' = ' + p.add(f.wert) + ', false)';
      return f.op === '=' ? gleich : '(' + e + ' IS NOT NULL AND NOT ' + gleich + ')';
    }
  }
}

/** Vorhandene asset_type-Werte eines Projekts (entscheidet, ob ein Filterziel Datei oder Objekt meint). */
async function assetTypen(q: Leser, project: string): Promise<Set<string>> {
  const z = await q('SELECT DISTINCT asset_type FROM asset_files WHERE project = $1', [project]);
  return new Set(z.map(r => r.asset_type as string));
}

/**
 * Filter auf Dateiebene (Alias a). asset_type-Ziel -> Bedingung auf a.metadata. Objekt-Ziel -> eigene
 * MATERIALIZED-CTE mit den passenden asset_ids (einmal ueber idx_asset_objects_kind) plus JOIN.
 * Grund (Messung M1): als EXISTS/Semi-Join schaetzt der Planer den JSONB-Ausdruck falsch (12.985 statt
 * 4 Zeilen) und laeuft per Nested Loop ueber ALLE Dateien (105 ms bei 20.000, linear wachsend).
 * $1 ist im Aufrufer der Projektname; nr macht den CTE-Namen eindeutig (feste Ziffern, kein Nutzertext).
 */
function filterAufDatei(f: AssetFilter, nr: number, typen: Set<string>, p: Parameter): { wo?: string; cte?: string; join?: string } {
  if (typen.has(f.ziel)) return { wo: '(a.asset_type = ' + p.add(f.ziel) + ' AND ' + filterSql(f, 'a.metadata', p) + ')' };
  const n = 'fo' + nr;
  return {
    cte: n + ' AS MATERIALIZED (SELECT DISTINCT o.asset_id FROM asset_objects o WHERE o.project = $1 AND o.kind = ' + p.add(f.ziel) + ' AND ' + filterSql(f, 'o.data', p) + ')',
    join: ' JOIN ' + n + ' ON ' + n + '.asset_id = a.id',
  };
}

/** Haeufigste Schluessel eines Filterziels (Hinweis bei 0 Treffern). */
async function haeufigsteSchluessel(q: Leser, project: string, ziel: string, typen: Set<string>): Promise<string[]> {
  const z = typen.has(ziel)
    ? await q(
        `SELECT k, count(*) AS n FROM (SELECT metadata FROM asset_files WHERE project = $1 AND asset_type = $2 LIMIT 5000) s,
                jsonb_object_keys(CASE WHEN jsonb_typeof(s.metadata) = 'object' THEN s.metadata ELSE '{}'::jsonb END) k
          GROUP BY k ORDER BY n DESC, k LIMIT 30`,
        [project, ziel]
      )
    : await q(
        `SELECT k, count(*) AS n FROM (SELECT data FROM asset_objects WHERE project = $1 AND kind = $2 LIMIT 5000) s,
                jsonb_object_keys(CASE WHEN jsonb_typeof(s.data) = 'object' THEN s.data ELSE '{}'::jsonb END) k
          GROUP BY k ORDER BY n DESC, k LIMIT 30`,
        [project, ziel]
      );
  return z.map(r => r.k as string);
}

async function filterHinweis(q: Leser, project: string, filter: AssetFilter[], typen: Set<string>): Promise<string | undefined> {
  if (filter.length === 0) return undefined;
  const teile: string[] = [];
  for (const ziel of [...new Set(filter.map(f => f.ziel))]) {
    const keys = await haeufigsteSchluessel(q, project, ziel, typen);
    teile.push(keys.length > 0
      ? ziel + ': haeufigste Schluessel ' + keys.join(', ')
      : ziel + ': weder asset_type noch Objekt-kind mit Daten in diesem Projekt');
  }
  return '0 Treffer mit Filter. ' + teile.join(' | ');
}

// ---------------------------------------------------------------------------
// Datei finden
// ---------------------------------------------------------------------------

const DATEI_SPALTEN = `id, file_path, file_name, extension, asset_type, format, status, inspector, parser_version,
  file_size, sha256, mtime, metadata, format_specific, warnings, n_objects, n_references, objekte_gekappt,
  extracted_at, quelle_fehlt_seit, inspiziert_von, updated_at`;

function nichtImIndex(pfad: string): AssetIntelFehler {
  return new AssetIntelFehler(
    'datei_nicht_im_asset_index',
    'Kein Asset-Eintrag fuer ' + pfad + '.',
    'Laeuft der lokale Watcher (nur er inspiziert)? Textdatei/Quellcode? -> code_intel(action:"file", file_path). Pfade: asset_intel(action:"tree") oder action:"search".'
  );
}

/** Exakter Treffer, sonst eindeutiger Endungs-Treffer ('.../<pfad>'); null wenn keiner. */
async function findeAsset(q: Leser, project: string, pfad: string): Promise<Zeile | null> {
  const exakt = await q('SELECT ' + DATEI_SPALTEN + ' FROM asset_files WHERE project = $1 AND file_path = $2', [project, pfad]);
  if (exakt[0]) return exakt[0];
  const aehnlich = await q(
    'SELECT ' + DATEI_SPALTEN + ' FROM asset_files WHERE project = $1 AND file_path LIKE $2 ORDER BY file_path LIMIT 11',
    [project, '%/' + escapeLike(pfad)]
  );
  if (aehnlich.length === 1) return aehnlich[0];
  if (aehnlich.length > 1) {
    throw new AssetIntelFehler(
      'pfad_mehrdeutig',
      pfad + ' passt auf mehrere Assets.',
      'Vollstaendigen projekt-relativen Pfad angeben.',
      { kandidaten: aehnlich.slice(0, 10).map(r => r.file_path) }
    );
  }
  return null;
}

async function mussAsset(q: Leser, project: string, pfad: string): Promise<Zeile> {
  const a = await findeAsset(q, project, pfad);
  if (!a) throw nichtImIndex(pfad);
  return a;
}

function dateiAusgabe(a: Zeile, mitDetails: boolean): Record<string, unknown> {
  const aus: Record<string, unknown> = {
    file_path: a.file_path,
    format: a.format,
    asset_type: a.asset_type,
    status: a.status,
    inspector: a.inspector,
    parser_version: a.parser_version,
    file_size: Number(a.file_size),
    n_objects: a.n_objects,
    n_references: a.n_references,
    objekte_gekappt: a.objekte_gekappt,
    extracted_at: a.extracted_at,
  };
  if (a.quelle_fehlt_seit) aus.quelle_fehlt_seit = a.quelle_fehlt_seit;
  if (mitDetails) {
    aus.sha256 = a.sha256;
    aus.mtime = a.mtime;
    aus.inspiziert_von = a.inspiziert_von;
    aus.metadata = a.metadata;
    aus.format_specific = a.format_specific;
    aus.warnings = a.warnings;
  }
  return aus;
}

function objektAusgabe(o: Zeile): Record<string, unknown> {
  const aus: Record<string, unknown> = { ordnung: o.ordnung, kind: o.kind, name: o.name, data: o.data };
  if (o.byte_offset !== null && o.byte_offset !== undefined) aus.bereich = { offset: Number(o.byte_offset), length: zahlOderNull(o.byte_length) };
  else if (o.line_start !== null && o.line_start !== undefined) aus.bereich = { line_start: o.line_start, line_end: o.line_end };
  if (o.file_path !== undefined) aus.file_path = o.file_path;
  return aus;
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

export interface BaumOptionen {
  path?: unknown;
  depth?: unknown;
  recursive?: unknown;
  format?: unknown;
  asset_type?: unknown;
  status?: unknown;
  limit?: unknown;
}

function groesse(b: number): string {
  if (b < 1024) return b + ' B';
  const einheiten = ['KB', 'MB', 'GB', 'TB'];
  let w = b / 1024;
  let i = 0;
  while (w >= 1024 && i < einheiten.length - 1) {
    w /= 1024;
    i++;
  }
  return w.toFixed(1).replace('.', ',') + ' ' + einheiten[i];
}

/** Asset-Baum als Text (wie code_intel tree) plus Zahlen. */
export async function holeAssetBaum(project: string, o: BaumOptionen = {}, bereich: AssetBereich = ASSET_BEREICH): Promise<{ baum: string; dateien: number; total: number; gekappt: boolean }> {
  const g = reverseGrenzen(bereich);
  const basisRoh = text(o.path, 'path', g?.pfad_zeichen ?? 2000);
  const basis = basisRoh === undefined || basisRoh.replace(/[\\/]+$/, '') === '' || basisRoh === '.' ? '' : pfadParam(basisRoh.replace(/[\\/]+$/, ''), 'path', bereich);
  const rekursiv = o.recursive === undefined || o.recursive === null ? true : o.recursive === true || o.recursive === 'true';
  const tiefe = rekursiv ? (o.depth === undefined || o.depth === null ? null : zahl(o.depth, 'depth', 0, 0, g?.baum_tiefe ?? 100)) : 0;
  const limit = zahl(o.limit, 'limit', g?.seiten_limit ?? 500, 1, g?.max_limit ?? 5000);
  const p = new Parameter([project]);
  const wo = ['project = $1'];
  if (basis) wo.push('file_path LIKE ' + p.add(escapeLike(basis) + '/%'));
  if (tiefe !== null) {
    wo.push("array_length(string_to_array(substr(file_path, " + p.add(basis ? basis.length + 2 : 1) + "::int), '/'), 1) - 1 <= " + p.add(tiefe) + '::int');
  }
  const format = text(o.format, 'format', 64);
  const typ = text(o.asset_type, 'asset_type', 64);
  const status = statusParam(o.status);
  if (format) wo.push('format = ' + p.add(format.toLowerCase()));
  if (typ) wo.push('asset_type = ' + p.add(typ));
  if (status) wo.push('status = ' + p.add(status));
  const sql =
    'SELECT file_path, format, asset_type, status, file_size, n_objects, n_references, count(*) OVER() AS total FROM asset_files WHERE ' +
    wo.join(' AND ') + ' ORDER BY file_path LIMIT ' + p.add(limit);
  const zeilen = await mitLeser(bereich, project, q => q(sql, p.werte));
  const total = zeilen.length > 0 ? Number(zeilen[0].total) : 0;

  const out: string[] = [(basis || '.') + '/'];
  let vorher: string[] = [];
  for (const z of zeilen) {
    const rel = basis ? (z.file_path as string).slice(basis.length + 1) : (z.file_path as string);
    const teile = rel.split('/');
    const name = teile.pop() as string;
    let gleich = 0;
    while (gleich < teile.length && gleich < vorher.length && teile[gleich] === vorher[gleich]) gleich++;
    for (let i = gleich; i < teile.length; i++) out.push('  '.repeat(i + 1) + teile[i] + '/');
    vorher = teile;
    const marker = [z.format ?? z.asset_type, groesse(Number(z.file_size))];
    if (z.n_objects > 0) marker.push(z.n_objects + ' Obj');
    if (z.n_references > 0) marker.push(z.n_references + ' Verw');
    marker.push(z.status);
    out.push('  '.repeat(teile.length + 1) + name + ' [' + marker.join(' · ') + ']');
  }
  out.push('---');
  out.push(total === 0
    ? 'Keine Assets' + (basis ? ' unter ' + basis : '') + '.'
    : zeilen.length + ' von ' + total + ' Asset-Dateien' + (zeilen.length < total ? ' (gekappt, limit erhoehen oder path einengen)' : ''));
  return { baum: out.join('\n'), dateien: zeilen.length, total, gekappt: zeilen.length < total };
}

// ---------------------------------------------------------------------------
// inspect (aus der DB)
// ---------------------------------------------------------------------------

export interface InspektionsOptionen {
  objects_offset?: unknown;
  objects_limit?: unknown;
  object_type?: unknown;
  references_limit?: unknown;
}

export interface AssetInspektion {
  datei: Record<string, unknown>;
  objektarten: Array<{ kind: string; n: number }>;
  objekte: Array<Record<string, unknown>>;
  objekte_total: number;
  objekte_gekappt: boolean;
  verweise: Array<Record<string, unknown>>;
  verweise_total: number;
  verweise_gekappt: boolean;
}

/** Inhalt einer Asset-Zeile samt Objekten/Verweisen seitenweise; null wenn nicht im Index. */
export async function inspiziereAusDb(project: string, filePath: unknown, o: InspektionsOptionen = {}, bereich: AssetBereich = ASSET_BEREICH): Promise<AssetInspektion | null> {
  const g = reverseGrenzen(bereich);
  const pfad = pfadParam(filePath, 'file_path', bereich);
  const offset = zahl(o.objects_offset, 'offset', 0, 0, 1_000_000);
  const limit = zahl(o.objects_limit, 'limit', g?.objekt_limit ?? 50, 0, g?.objekt_max ?? 500);
  const refLimit = zahl(o.references_limit, 'limit', g?.verweis_limit ?? 50, 0, g?.verweis_max ?? 500);
  const art = text(o.object_type, 'object_type', 64);
  return mitLeser(bereich, project, async q => {
    const a = await findeAsset(q, project, pfad);
    if (!a) return null;
    const arten = await q('SELECT kind, count(*)::int AS n FROM asset_objects WHERE asset_id = $1 GROUP BY kind ORDER BY n DESC, kind', [a.id]);
    const objTotal = art === undefined ? arten.reduce((s, r) => s + r.n, 0) : (arten.find(r => r.kind === art)?.n ?? 0);
    const objekte = limit === 0 ? [] : await q(
      `SELECT ordnung, kind, name, data, byte_offset, byte_length, line_start, line_end FROM asset_objects
        WHERE asset_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY ordnung OFFSET $3 LIMIT $4`,
      [a.id, art ?? null, offset, limit]
    );
    const verweise = await q(
      `SELECT ordnung, kind, target, ziel_pfad, aufloesung, inspektor_resolved, count(*) OVER() AS total
         FROM asset_references WHERE asset_id = $1 ORDER BY ordnung LIMIT $2`,
      [a.id, Math.max(refLimit, 1)]
    );
    const refTotal = verweise.length > 0 ? Number(verweise[0].total) : 0;
    return {
      datei: dateiAusgabe(a, true),
      objektarten: arten.map(r => ({ kind: r.kind, n: r.n })),
      objekte: objekte.map(objektAusgabe),
      objekte_total: objTotal,
      objekte_gekappt: offset + objekte.length < objTotal,
      verweise: (refLimit === 0 ? [] : verweise).map(verweisAusgabe),
      verweise_total: refTotal,
      verweise_gekappt: (refLimit === 0 ? 0 : verweise.length) < refTotal,
    };
  });
}

function verweisAusgabe(r: Zeile): Record<string, unknown> {
  const aus: Record<string, unknown> = { kind: r.kind, target: r.target, ziel_pfad: r.ziel_pfad, aufloesung: r.aufloesung };
  if (r.file_path !== undefined) aus.file_path = r.file_path;
  if (r.ordnung !== undefined) aus.ordnung = r.ordnung;
  return aus;
}

// ---------------------------------------------------------------------------
// objects
// ---------------------------------------------------------------------------

export interface ObjektOptionen {
  object_type?: unknown;
  file_path?: unknown;
  name?: unknown;
  where?: unknown;
  limit?: unknown;
  offset?: unknown;
}

/** Objekte EINER Art projektweit (object_type Pflicht), mit Filtern und Paging. */
export async function holeObjekte(project: string, o: ObjektOptionen, bereich: AssetBereich = ASSET_BEREICH): Promise<{ objekte: Array<Record<string, unknown>>; total: number; gekappt: boolean; hinweis?: string }> {
  const art = text(o.object_type, 'object_type', 64);
  const limit = zahl(o.limit, 'limit', 100, 1, 1000);
  const offset = zahl(o.offset, 'offset', 0, 0, 10_000_000);
  const name = text(o.name, 'name', 200);
  const filter = parseAssetFilter(o.where);
  const pfad = o.file_path === undefined || o.file_path === null || o.file_path === '' ? undefined : pfadParam(o.file_path);
  return mitLeser(bereich, project, async q => {
    if (!art) {
      const arten = await q('SELECT kind, count(*)::int AS n FROM asset_objects WHERE project = $1 GROUP BY kind ORDER BY n DESC, kind LIMIT 30', [project]);
      throw new AssetIntelFehler(
        'object_type_fehlt',
        'objects braucht object_type.',
        arten.length > 0 ? 'Vorhandene Arten: ' + arten.map(r => r.kind + ' (' + r.n + ')').join(', ') : 'Keine Objekte im Projekt.'
      );
    }
    const typen = await assetTypen(q, project);
    const p = new Parameter([project, art]);
    const wo = ['o.project = $1', 'o.kind = $2'];
    if (pfad) {
      const a = await mussAsset(q, project, pfad);
      wo.push('o.asset_id = ' + p.add(a.id));
    }
    if (name) wo.push('o.name ILIKE ' + p.add('%' + escapeLike(name) + '%'));
    for (const f of filter) {
      if (f.ziel === art) wo.push(filterSql(f, 'o.data', p));
      else if (typen.has(f.ziel)) wo.push('(a.asset_type = ' + p.add(f.ziel) + ' AND ' + filterSql(f, 'a.metadata', p) + ')');
      else {
        throw new AssetIntelFehler(
          'filter_ungueltig',
          'Filterziel "' + f.ziel + '" passt weder zu object_type "' + art + '" noch zu einem asset_type im Projekt.',
          'Bei objects: ' + art + '.<schluessel> oder <asset_type>.<schluessel>; vorhandene asset_type: ' + [...typen].sort().join(', ')
        );
      }
    }
    const von = ' FROM asset_objects o JOIN asset_files a ON a.id = o.asset_id WHERE ' + wo.join(' AND ');
    const anzahl = await q('SELECT count(*)::int AS n' + von, p.werte);
    const total = anzahl[0].n as number;
    const zeilen = await q(
      'SELECT a.file_path, o.ordnung, o.kind, o.name, o.data, o.byte_offset, o.byte_length, o.line_start, o.line_end' + von +
        ' ORDER BY a.file_path, o.ordnung OFFSET ' + p.add(offset) + ' LIMIT ' + p.add(limit),
      p.werte
    );
    let hinweis: string | undefined;
    if (total === 0) {
      const da = await q('SELECT 1 FROM asset_objects WHERE project = $1 AND kind = $2 LIMIT 1', [project, art]);
      if (da.length === 0) {
        const arten = await q('SELECT kind, count(*)::int AS n FROM asset_objects WHERE project = $1 GROUP BY kind ORDER BY n DESC, kind LIMIT 30', [project]);
        hinweis = 'Keine Objekte der Art "' + art + '". Vorhandene Arten: ' + (arten.map(r => r.kind).join(', ') || 'keine');
      } else {
        hinweis = await filterHinweis(q, project, filter, typen);
      }
    }
    return { objekte: zeilen.map(objektAusgabe), total, gekappt: offset + zeilen.length < total, ...(hinweis ? { hinweis } : {}) };
  });
}

// ---------------------------------------------------------------------------
// references / used_by / missing
// ---------------------------------------------------------------------------

export interface VerweisOptionen {
  kind?: unknown;
  limit?: unknown;
  include_name_matches?: unknown;
}

/** Ausgehende Verweise einer Datei. */
export async function holeVerweise(project: string, filePath: unknown, o: VerweisOptionen = {}, bereich: AssetBereich = ASSET_BEREICH): Promise<{ datei: string; verweise: Array<Record<string, unknown>>; total: number; gekappt: boolean; je_aufloesung: Record<string, number> }> {
  const pfad = pfadParam(filePath);
  const kind = text(o.kind, 'kind', 64);
  const limit = zahl(o.limit, 'limit', 200, 1, 2000);
  return mitLeser(bereich, project, async q => {
    const a = await mussAsset(q, project, pfad);
    const zeilen = await q(
      `SELECT ordnung, kind, target, ziel_pfad, aufloesung, count(*) OVER() AS total FROM asset_references
        WHERE asset_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY ordnung LIMIT $3`,
      [a.id, kind ?? null, limit]
    );
    const je = await q('SELECT aufloesung, count(*)::int AS n FROM asset_references WHERE asset_id = $1 AND ($2::text IS NULL OR kind = $2) GROUP BY aufloesung', [a.id, kind ?? null]);
    const total = zeilen.length > 0 ? Number(zeilen[0].total) : 0;
    return {
      datei: a.file_path,
      verweise: zeilen.map(verweisAusgabe),
      total,
      gekappt: zeilen.length < total,
      je_aufloesung: Object.fromEntries(je.map(r => [r.aufloesung, r.n])),
    };
  });
}

/**
 * Wer verweist auf diese Datei (ueber ziel_pfad, Index idx_asset_refs_ziel)? name_matches = gleicher
 * Dateiname im target, aber anderer/kein aufgeloester Pfad — getrennt gefuehrt, wie getReferences.
 * Die Zieldatei muss selbst KEINE Asset-Zeile haben (z. B. eine .mtl ohne Inspektor).
 */
export async function holeBenutztVon(project: string, filePath: unknown, o: VerweisOptionen = {}, bereich: AssetBereich = ASSET_BEREICH): Promise<{ datei: string; im_asset_index: boolean; verweise: Array<Record<string, unknown>>; total: number; gekappt: boolean; name_matches?: Array<Record<string, unknown>>; name_matches_total?: number }> {
  const pfad = pfadParam(filePath);
  const kind = text(o.kind, 'kind', 64);
  const limit = zahl(o.limit, 'limit', 200, 1, 2000);
  const mitNamen = o.include_name_matches === true || o.include_name_matches === 'true';
  return mitLeser(bereich, project, async q => {
    const a = await findeAsset(q, project, pfad);
    const ziel = a ? (a.file_path as string) : pfad;
    const zeilen = await q(
      `SELECT s.file_path, r.kind, r.target, r.ziel_pfad, r.aufloesung, count(*) OVER() AS total
         FROM asset_references r JOIN asset_files s ON s.id = r.asset_id
        WHERE r.project = $1 AND r.ziel_pfad = $2 AND ($3::text IS NULL OR r.kind = $3)
        ORDER BY s.file_path, r.ordnung LIMIT $4`,
      [project, ziel, kind ?? null, limit]
    );
    const total = zeilen.length > 0 ? Number(zeilen[0].total) : 0;
    if (!a && total === 0) throw nichtImIndex(pfad);
    const aus: Awaited<ReturnType<typeof holeBenutztVon>> = { datei: ziel, im_asset_index: !!a, verweise: zeilen.map(verweisAusgabe), total, gekappt: zeilen.length < total };
    if (mitNamen) {
      const name = path.posix.basename(ziel);
      const nm = await q(
        `SELECT s.file_path, r.kind, r.target, r.ziel_pfad, r.aufloesung, count(*) OVER() AS total
           FROM asset_references r JOIN asset_files s ON s.id = r.asset_id
          WHERE r.project = $1 AND (r.ziel_pfad IS NULL OR r.ziel_pfad <> $2)
            AND (r.target = $3 OR r.target LIKE $4 OR r.target LIKE $5)
          ORDER BY s.file_path, r.ordnung LIMIT $6`,
        [project, ziel, name, '%/' + escapeLike(name), '%\\\\' + escapeLike(name), limit]
      );
      aus.name_matches = nm.map(verweisAusgabe);
      aus.name_matches_total = nm.length > 0 ? Number(nm[0].total) : 0;
    }
    return aus;
  });
}

/** Verweise mit aufloesung 'fehlt' (projektweit oder fuer eine verweisende Datei). */
export async function holeFehlende(project: string, o: { file_path?: unknown; kind?: unknown; limit?: unknown } = {}, bereich: AssetBereich = ASSET_BEREICH): Promise<{ fehlend: Array<Record<string, unknown>>; total: number; gekappt: boolean; ziele_total: number }> {
  const pfad = o.file_path === undefined || o.file_path === null || o.file_path === '' ? undefined : pfadParam(o.file_path);
  const kind = text(o.kind, 'kind', 64);
  const limit = zahl(o.limit, 'limit', 200, 1, 2000);
  return mitLeser(bereich, project, async q => {
    let assetId: unknown = null;
    if (pfad) assetId = (await mussAsset(q, project, pfad)).id;
    const wo = `r.project = $1 AND r.aufloesung = 'fehlt' AND ($2::bigint IS NULL OR r.asset_id = $2) AND ($3::text IS NULL OR r.kind = $3)`;
    const zeilen = await q(
      `SELECT s.file_path, r.kind, r.target, r.ziel_pfad, r.aufloesung, count(*) OVER() AS total
         FROM asset_references r JOIN asset_files s ON s.id = r.asset_id
        WHERE ` + wo + ` ORDER BY s.file_path, r.ordnung LIMIT $4`,
      [project, assetId, kind ?? null, limit]
    );
    const ziele = await q('SELECT count(DISTINCT r.ziel_pfad)::int AS n FROM asset_references r WHERE ' + wo, [project, assetId, kind ?? null]);
    const total = zeilen.length > 0 ? Number(zeilen[0].total) : 0;
    return { fehlend: zeilen.map(verweisAusgabe), total, gekappt: zeilen.length < total, ziele_total: ziele[0].n };
  });
}

// ---------------------------------------------------------------------------
// graph (rekursive CTE mit CYCLE)
// ---------------------------------------------------------------------------

export interface GraphOptionen {
  direction?: unknown;
  depth?: unknown;
  limit?: unknown;
}

export interface AssetGraph {
  start: string;
  richtung: 'down' | 'up';
  tiefe: number;
  knoten: Array<{ pfad: string; tiefe: number; im_index: boolean; format?: string | null; asset_type?: string; status?: string }>;
  kanten: Array<{ von: string; nach: string; kind: string; zyklus?: true }>;
  zyklen: Array<{ kette: string[] }>;
  total: number;
  gekappt: boolean;
}

const SQL_GRAPH_DOWN = `
WITH RECURSIVE g(pfad, von, kind, tiefe, weg) AS (
    SELECT $2::text, NULL::text, NULL::text, 0, ARRAY[$2::text]
  UNION ALL
    SELECT r.ziel_pfad, g.pfad, r.kind, g.tiefe + 1, g.weg || r.ziel_pfad
      FROM g
      JOIN asset_files a ON a.project = $1 AND a.file_path = g.pfad
      JOIN asset_references r ON r.asset_id = a.id AND r.ziel_pfad IS NOT NULL
     WHERE g.tiefe < $3
) CYCLE pfad SET zyklus USING kette
SELECT pfad, von, kind, tiefe, weg, zyklus FROM g LIMIT $4`;

const SQL_GRAPH_UP = `
WITH RECURSIVE g(pfad, von, kind, tiefe, weg) AS (
    SELECT $2::text, NULL::text, NULL::text, 0, ARRAY[$2::text]
  UNION ALL
    SELECT a.file_path, g.pfad, r.kind, g.tiefe + 1, g.weg || a.file_path
      FROM g
      JOIN asset_references r ON r.project = $1 AND r.ziel_pfad = g.pfad
      JOIN asset_files a ON a.id = r.asset_id
     WHERE g.tiefe < $3
) CYCLE pfad SET zyklus USING kette
SELECT pfad, von, kind, tiefe, weg, zyklus FROM g LIMIT $4`;

/**
 * Abhaengigkeitsgraph ab einer Datei. down = worauf sie (transitiv) verweist, up = wer (transitiv)
 * auf sie verweist. Zyklen werden per CYCLE erkannt, als Kante mit zyklus:true und in zyklen[]
 * (vollstaendige Kette) gemeldet und nicht weiter verfolgt. Ziele ohne Asset-Zeile sind Blaetter.
 */
export async function holeGraph(project: string, filePath: unknown, o: GraphOptionen = {}, bereich: AssetBereich = ASSET_BEREICH): Promise<AssetGraph> {
  const pfad = pfadParam(filePath);
  const richtungRoh = text(o.direction, 'direction', 10) ?? 'down';
  if (richtungRoh !== 'down' && richtungRoh !== 'up') {
    throw new AssetIntelFehler('parameter_ungueltig', 'direction unbekannt: ' + richtungRoh, 'direction: "down" (worauf verweist die Datei) oder "up" (wer verweist auf sie).');
  }
  const richtung = richtungRoh as 'down' | 'up';
  const tiefe = zahl(o.depth, 'depth', 3, 1, ASSET_GRAPH_MAX_TIEFE);
  const limit = zahl(o.limit, 'limit', 500, 1, 2000);
  return mitLeser(bereich, project, async q => {
    const a = await findeAsset(q, project, pfad);
    const start = a ? (a.file_path as string) : pfad;
    if (!a && richtung === 'down') throw nichtImIndex(pfad);
    const zeilen = await q(richtung === 'down' ? SQL_GRAPH_DOWN : SQL_GRAPH_UP, [project, start, tiefe, GRAPH_ZEILEN_MAX]);
    if (!a && zeilen.length <= 1) throw nichtImIndex(pfad);

    const knotenTiefe = new Map<string, number>();
    const kanten = new Map<string, { von: string; nach: string; kind: string; zyklus?: true }>();
    const zyklen = new Map<string, string[]>();
    for (const z of zeilen) {
      const p = z.pfad as string;
      if (!knotenTiefe.has(p) || (knotenTiefe.get(p) as number) > z.tiefe) knotenTiefe.set(p, z.tiefe);
      if (z.von === null) continue;
      // Kante immer von der verweisenden zur Zieldatei
      const von = richtung === 'down' ? (z.von as string) : p;
      const nach = richtung === 'down' ? p : (z.von as string);
      const schluessel = von + '\u0000' + nach + '\u0000' + z.kind;
      const vorhanden = kanten.get(schluessel);
      if (!vorhanden) kanten.set(schluessel, { von, nach, kind: z.kind, ...(z.zyklus ? { zyklus: true as const } : {}) });
      else if (z.zyklus) vorhanden.zyklus = true;
      if (z.zyklus) {
        const weg = z.weg as string[];
        const i = weg.indexOf(p);
        const kette = richtung === 'down' ? weg.slice(i) : weg.slice(i).reverse();
        zyklen.set(kette.join('\u0000'), kette);
      }
    }
    const pfade = [...knotenTiefe.keys()];
    const info = await q(
      'SELECT file_path, format, asset_type, status FROM asset_files WHERE project = $1 AND file_path = ANY($2::text[])',
      [project, pfade]
    );
    const infoMap = new Map(info.map(r => [r.file_path as string, r]));
    const alleKanten = [...kanten.values()];
    const knoten: AssetGraph['knoten'] = pfade
      .map((pf): AssetGraph['knoten'][number] => {
        const i = infoMap.get(pf);
        return i
          ? { pfad: pf, tiefe: knotenTiefe.get(pf) as number, im_index: true, format: i.format, asset_type: i.asset_type, status: i.status }
          : { pfad: pf, tiefe: knotenTiefe.get(pf) as number, im_index: false };
      })
      .sort((x, y) => x.tiefe - y.tiefe || x.pfad.localeCompare(y.pfad));
    const gekapptZeilen = zeilen.length >= GRAPH_ZEILEN_MAX;
    return {
      start,
      richtung,
      tiefe,
      knoten: knoten.slice(0, limit + 1),
      kanten: alleKanten.slice(0, limit),
      zyklen: [...zyklen.values()].map(kette => ({ kette })),
      total: alleKanten.length,
      gekappt: gekapptZeilen || alleKanten.length > limit || knoten.length > limit + 1,
    };
  });
}

// ---------------------------------------------------------------------------
// roots / orphans
// ---------------------------------------------------------------------------

/**
 * roots = kein eingehender Verweis, aber >= 1 ausgehender auf eine Projektdatei (ziel_pfad);
 * orphans = weder eingehend noch ausgehend. Dateien mit 'quelle_nicht_gefunden' zaehlen nicht.
 */
export async function holeWurzelnUndWaisen(
  project: string,
  o: { art: 'roots' | 'orphans'; format?: unknown; asset_type?: unknown; limit?: unknown },
  bereich: AssetBereich = ASSET_BEREICH
): Promise<{ dateien: Array<Record<string, unknown>>; total: number; gekappt: boolean; hinweis: string }> {
  const limit = zahl(o.limit, 'limit', 200, 1, 2000);
  const format = text(o.format, 'format', 64);
  const typ = text(o.asset_type, 'asset_type', 64);
  const ausgehend = o.art === 'roots' ? 'EXISTS' : 'NOT EXISTS';
  const zeilen = await mitLeser(bereich, project, q => q(
    `SELECT a.file_path, a.format, a.asset_type, a.status, a.n_references, count(*) OVER() AS total
       FROM asset_files a
      WHERE a.project = $1 AND a.status <> 'quelle_nicht_gefunden'
        AND ($2::text IS NULL OR a.format = $2) AND ($3::text IS NULL OR a.asset_type = $3)
        AND NOT EXISTS (SELECT 1 FROM asset_references r WHERE r.project = $1 AND r.ziel_pfad = a.file_path AND r.asset_id <> a.id)
        AND ` + ausgehend + ` (SELECT 1 FROM asset_references r2 WHERE r2.asset_id = a.id AND r2.ziel_pfad IS NOT NULL)
      ORDER BY a.file_path LIMIT $4`,
    [project, format ? format.toLowerCase() : null, typ ?? null, limit]
  ));
  const total = zeilen.length > 0 ? Number(zeilen[0].total) : 0;
  return {
    dateien: zeilen.map(z => ({ file_path: z.file_path, format: z.format, asset_type: z.asset_type, status: z.status, n_references: z.n_references })),
    total,
    gekappt: zeilen.length < total,
    hinweis: 'Nur Verweise zwischen Assets zaehlen; Verweise aus Quellcode (z. B. "assets/x.png" in .ts) sind nicht beruecksichtigt.',
  };
}

// ---------------------------------------------------------------------------
// search / search_batch
// ---------------------------------------------------------------------------

export interface SuchOptionen {
  query?: unknown;
  where?: unknown;
  format?: unknown;
  asset_type?: unknown;
  limit?: unknown;
}

/** Zerlegt die Kurzform 'format:ktx2 type:image image.width>=4096 rock'. */
export function zerlegeSuchanfrage(query: string): { begriffe: string[]; filter: string[]; format?: string; asset_type?: string } {
  const aus: { begriffe: string[]; filter: string[]; format?: string; asset_type?: string } = { begriffe: [], filter: [] };
  for (const t of query.split(/\s+/).filter(Boolean)) {
    const m = /^(format|type|asset_type):(.+)$/i.exec(t);
    if (m) {
      if (m[1].toLowerCase() === 'format') aus.format = m[2];
      else aus.asset_type = m[2];
    } else if (FILTER_RE.test(t) && /[<>=~]/.test(t)) {
      aus.filter.push(t);
    } else {
      aus.begriffe.push(t);
    }
  }
  return aus;
}

/**
 * Lexikalische Suche (ILIKE/pg_trgm) ueber Pfad, Objektnamen und Verweisziele, je Datei gruppiert
 * mit Fundstellen ('pfad|…', 'objekt|kind: name', 'verweis|target'). Jeder Begriff muss die Datei
 * treffen (an beliebiger Stelle). where/Kurzform-Filter schraenken zusaetzlich ein.
 */
export async function sucheAssets(project: string, o: SuchOptionen, bereich: AssetBereich = ASSET_BEREICH): Promise<{ treffer: Array<Record<string, unknown>>; total: number; gekappt: boolean; hinweis?: string }> {
  const query = text(o.query, 'query', 500) ?? '';
  const limit = zahl(o.limit, 'limit', 20, 1, 200);
  const z = zerlegeSuchanfrage(query);
  const whereListe = o.where === undefined || o.where === null ? [] : typeof o.where === 'string' ? [o.where] : o.where;
  if (!Array.isArray(whereListe)) throw new AssetIntelFehler('filter_ungueltig', 'where muss eine Liste von Texten sein.');
  const filter = parseAssetFilter([...whereListe, ...z.filter]);
  const format = text(o.format, 'format', 64) ?? z.format;
  const typ = text(o.asset_type, 'asset_type', 64) ?? z.asset_type;
  const begriffe = z.begriffe.slice(0, 5).map(b => b.slice(0, 100));
  if (begriffe.length === 0 && filter.length === 0 && !format && !typ) {
    throw new AssetIntelFehler('parameter_fehlt', 'search braucht query (Begriffe und/oder Filter).', 'Beispiel: query:"rock format:ktx2 image.width>=4096"');
  }
  return mitLeser(bereich, project, async q => {
    const typen = filter.length > 0 ? await assetTypen(q, project) : new Set<string>();
    const p = new Parameter([project]);
    const wo = ['a.project = $1'];
    if (format) wo.push('a.format = ' + p.add(format.toLowerCase()));
    if (typ) wo.push('a.asset_type = ' + p.add(typ));
    const ctes: string[] = [];
    let joins = '';
    filter.forEach((f, nr) => {
      const t = filterAufDatei(f, nr, typen, p);
      if (t.wo) wo.push(t.wo);
      if (t.cte) {
        ctes.push(t.cte);
        joins += t.join;
      }
    });
    // HAEUFIGE BEGRIFFE (Messung B2, 750.000 Verweise): Fundstellen-Text fuer ALLE Treffer zu sammeln
    // (array_agg DISTINCT, Sort ~80 MB) und asset_files nach einem HAVING zu joinen, das der Planer auf
    // 1 Zeile schaetzt (Nested Loop mit Seq Scan je Gruppe), lief in 19,4 s. Deshalb:
    //  - f liefert nur (asset_id, Bit des Begriffs), g aggregiert per Hash (bit_or statt count(DISTINCT));
    //  - asset_files je Gruppe per LATERAL ueber den Primaerschluessel (OFFSET 0 verhindert das
    //    Hochziehen der Unterabfrage, damit bleibt es bei einem Index-Zugriff je Datei);
    //  - Fundstellen erst danach und nur fuer die angezeigten limit Dateien.
    const muster = begriffe.map(b => '%' + escapeLike(b) + '%');
    const mitFund = begriffe.length > 0;
    if (mitFund) {
      const teile: string[] = [];
      muster.forEach((m, i) => {
        const pm = p.add(m);
        const bit = 1 << i;
        teile.push(
          'SELECT a2.id AS asset_id, ' + bit + ' AS bit FROM asset_files a2 WHERE a2.project = $1 AND a2.file_path ILIKE ' + pm,
          'SELECT o.asset_id, ' + bit + ' FROM asset_objects o WHERE o.project = $1 AND o.name ILIKE ' + pm,
          'SELECT r.asset_id, ' + bit + ' FROM asset_references r WHERE r.project = $1 AND r.target ILIKE ' + pm
        );
      });
      ctes.push(
        'f AS (' + teile.join(' UNION ALL ') + ')',
        'g AS (SELECT asset_id, count(*)::int AS n_fund FROM f GROUP BY asset_id' +
          (begriffe.length > 1 ? ' HAVING bit_or(bit) = ' + ((1 << begriffe.length) - 1) : '') + ')'
      );
    }
    const spalten = 'a.id, a.file_path, a.format, a.asset_type, a.status, a.file_size, a.n_objects, a.n_references';
    const sql =
      (ctes.length > 0 ? 'WITH ' + ctes.join(', ') + ' ' : '') +
      (mitFund
        ? 'SELECT a.*, g.n_fund, count(*) OVER() AS total FROM g CROSS JOIN LATERAL (SELECT ' + spalten +
          ' FROM asset_files a WHERE a.id = g.asset_id AND ' + wo.join(' AND ') + ' OFFSET 0) a' + joins +
          ' ORDER BY g.n_fund DESC, a.file_path LIMIT ' + p.add(limit)
        : 'SELECT ' + spalten + ', count(*) OVER() AS total FROM asset_files a' + joins +
          ' WHERE ' + wo.join(' AND ') + ' ORDER BY a.file_path LIMIT ' + p.add(limit));
    const zeilen = await q(sql, p.werte);
    const total = zeilen.length > 0 ? Number(zeilen[0].total) : 0;
    const fund = new Map<string, Set<string>>();
    if (mitFund && zeilen.length > 0) {
      const fz = await q(
        `SELECT asset_id, wert FROM (
           SELECT a.id AS asset_id, 'pfad|' || a.file_path AS wert FROM asset_files a
            WHERE a.id = ANY($1::bigint[]) AND a.file_path ILIKE ANY($2::text[])
           UNION ALL
           SELECT o.asset_id, 'objekt|' || o.kind || ': ' || o.name FROM asset_objects o
            WHERE o.asset_id = ANY($1::bigint[]) AND o.name ILIKE ANY($2::text[])
           UNION ALL
           SELECT r.asset_id, 'verweis|' || r.target FROM asset_references r
            WHERE r.asset_id = ANY($1::bigint[]) AND r.target ILIKE ANY($2::text[])) x`,
        [zeilen.map(r => r.id), muster]
      );
      for (const r of fz) {
        const k = String(r.asset_id);
        if (!fund.has(k)) fund.set(k, new Set());
        (fund.get(k) as Set<string>).add(r.wert as string);
      }
    }
    const treffer = zeilen.map(r => {
      const t: Record<string, unknown> = { file_path: r.file_path, format: r.format, asset_type: r.asset_type, status: r.status, file_size: Number(r.file_size), n_objects: r.n_objects };
      if (mitFund) {
        t.fundstellen = [...(fund.get(String(r.id)) ?? [])].sort().slice(0, 5);
        t.n_fund = r.n_fund;
      }
      return t;
    });
    const hinweis = total === 0 ? await filterHinweis(q, project, filter, typen) : undefined;
    return { treffer, total, gekappt: zeilen.length < total, ...(hinweis ? { hinweis } : {}) };
  });
}

/** Mehrere Suchen in einem Aufruf (1..10 queries). */
export async function sucheAssetsBatch(project: string, queries: unknown, limitPerQuery?: unknown, bereich: AssetBereich = ASSET_BEREICH): Promise<{ ergebnisse: Array<Record<string, unknown>>; total: number; gekappt: boolean }> {
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > 10 || queries.some(x => typeof x !== 'string' || x.trim() === '')) {
    throw new AssetIntelFehler('parameter_ungueltig', 'queries: 1 bis 10 nicht leere Texte erwartet.', 'Beispiel: queries:["rock","image.width>=4096"]');
  }
  const limit = zahl(limitPerQuery, 'limit', 5, 1, 50);
  const ergebnisse: Array<Record<string, unknown>> = [];
  for (const query of queries as string[]) {
    try {
      const e = await sucheAssets(project, { query, limit }, bereich);
      ergebnisse.push({ query, ...e });
    } catch (err) {
      // Zeitlimit (57014) gilt je Anfrage: die uebrigen Suchen des Batches laufen weiter
      if ((err as { code?: string }).code === '57014') {
        ergebnisse.push({ query, zeitlimit: true, treffer: [], total: null, gekappt: true, hinweis: 'Begriff zu haeufig: mit format/asset_type/where eingrenzen' });
        continue;
      }
      if (!(err instanceof AssetIntelFehler)) throw err;
      ergebnisse.push({ query, fehler: err.code, message: err.message, ...(err.hinweis ? { hinweis: err.hinweis } : {}) });
    }
  }
  return {
    ergebnisse,
    total: ergebnisse.reduce((s, e) => s + (typeof e.total === 'number' ? e.total : 0), 0),
    gekappt: ergebnisse.some(e => e.gekappt === true),
  };
}

// ---------------------------------------------------------------------------
// move_preview (nur lesend)
// ---------------------------------------------------------------------------

/** Verweisvorschlag von quelle auf ziel (relativ, Blender '//', Unreal '/Game/'). */
function vorschlagTarget(quellPfad: string, alterTarget: string, kind: string, zielPfad: string): string | null {
  if (alterTarget.startsWith('/Game/')) {
    const teile = zielPfad.split('/');
    const i = teile.lastIndexOf('Content');
    if (i < 0) return null;
    const rest = teile.slice(i + 1).join('/').replace(/\.(uasset|umap)$/i, '');
    return '/Game/' + rest;
  }
  if (kind === 'library') return path.posix.basename(zielPfad);
  const rel = path.posix.relative(path.posix.dirname(quellPfad), zielPfad);
  if (/\.blend\d*$/i.test(quellPfad) && alterTarget.startsWith('//')) return '//' + rel;
  return rel;
}

/**
 * Was bricht, wenn file_path nach new_path verschoben wird? Eingehende Verweise (andere zeigen auf
 * die Datei) und ausgehende relative Verweise (die Datei zeigt von einem anderen Ordner aus woanders
 * hin), je mit vorgeschlagenem neuem target. Schreibt nichts.
 */
export async function movePreview(project: string, filePath: unknown, newPath: unknown, bereich: AssetBereich = ASSET_BEREICH): Promise<Record<string, unknown>> {
  const alt = pfadParam(filePath);
  const neu = pfadParam(newPath, 'new_path');
  return mitLeser(bereich, project, async q => {
    const a = await mussAsset(q, project, alt);
    const von = a.file_path as string;
    if (von === neu) throw new AssetIntelFehler('parameter_ungueltig', 'new_path ist gleich file_path.');
    const belegt = await q('SELECT file_path, status FROM asset_files WHERE project = $1 AND file_path = $2', [project, neu]);
    const ein = await q(
      `SELECT s.file_path, r.kind, r.target, r.aufloesung FROM asset_references r JOIN asset_files s ON s.id = r.asset_id
        WHERE r.project = $1 AND r.ziel_pfad = $2 AND r.asset_id <> $3 ORDER BY s.file_path, r.ordnung LIMIT 2001`,
      [project, von, a.id]
    );
    const repariert = await q(
      `SELECT s.file_path, r.kind, r.target FROM asset_references r JOIN asset_files s ON s.id = r.asset_id
        WHERE r.project = $1 AND r.ziel_pfad = $2 AND r.aufloesung = 'fehlt' ORDER BY s.file_path, r.ordnung LIMIT 200`,
      [project, neu]
    );
    const aus = await q(
      `SELECT kind, target, ziel_pfad, aufloesung FROM asset_references
        WHERE asset_id = $1 AND ziel_pfad IS NOT NULL ORDER BY ordnung LIMIT 2001`,
      [a.id]
    );
    const brechenEin = ein.slice(0, 2000).map(r => ({
      file_path: r.file_path,
      kind: r.kind,
      target: r.target,
      vorschlag_target: vorschlagTarget(r.file_path, r.target, r.kind, neu),
    }));
    const brechenAus: Array<Record<string, unknown>> = [];
    for (const r of aus.slice(0, 2000)) {
      const nachher = loesePfadAuf({ target: r.target, kind: r.kind, resolved: true }, { assetPfad: neu, existiert: () => true });
      if (nachher.ziel_pfad === r.ziel_pfad) continue;
      brechenAus.push({
        kind: r.kind,
        target: r.target,
        ziel_pfad: r.ziel_pfad,
        zeigt_dann_auf: nachher.ziel_pfad,
        vorschlag_target: vorschlagTarget(neu, r.target, r.kind, r.ziel_pfad),
      });
    }
    const ergebnis: Record<string, unknown> = {
      file_path: von,
      new_path: neu,
      ziel_belegt: belegt.length > 0 ? { file_path: belegt[0].file_path, status: belegt[0].status } : false,
      brechen_eingehend: brechenEin,
      brechen_ausgehend: brechenAus,
      repariert_eingehend: repariert.map(r => ({ file_path: r.file_path, kind: r.kind, target: r.target })),
      total: brechenEin.length + brechenAus.length,
      gekappt: ein.length > 2000 || aus.length > 2000,
    };
    return ergebnis;
  });
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

/** Zustand des Asset-Index (projektweit) oder einer Datei. */
export async function assetHealth(project: string, filePath?: unknown, bereich: AssetBereich = ASSET_BEREICH): Promise<Record<string, unknown>> {
  const versionen = standardRegistry.list().map(i => ({ id: i.id, version: i.version }));
  const pfad = filePath === undefined || filePath === null || filePath === '' ? undefined : pfadParam(filePath);
  return mitLeser(bereich, project, async q => {
    if (pfad) {
      const a = await mussAsset(q, project, pfad);
      const v = versionen.find(x => x.id === a.inspector);
      return {
        datei: dateiAusgabe(a, true),
        inspektor_bekannt: a.inspector === null ? null : !!v,
        aktuelle_inspektor_version: v?.version ?? null,
        veraltet: v ? a.parser_version < v.version : false,
        total: 1,
        gekappt: false,
      };
    }
    const [s] = await q(
      `SELECT count(*)::int AS dateien, COALESCE(sum(n_objects), 0)::bigint AS objekte_gemeldet,
              count(*) FILTER (WHERE objekte_gekappt)::int AS objekte_gekappt_dateien,
              max(extracted_at) AS letzter_lauf, min(quelle_fehlt_seit) AS aelteste_fehlend_seit
         FROM asset_files WHERE project = $1`,
      [project]
    );
    const gruppe = async (spalte: 'status' | 'asset_type' | 'format' | 'inspiziert_von', wo = 'TRUE'): Promise<Record<string, number>> => {
      const z = await q('SELECT ' + spalte + ' AS k, count(*)::int AS n FROM asset_files WHERE project = $1 AND ' + wo + ' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30', [project]);
      return Object.fromEntries(z.map(r => [r.k ?? '(leer)', r.n]));
    };
    const nichtErkannt = await q(
      `SELECT COALESCE(extension, '(ohne)') AS k, count(*)::int AS n FROM asset_files
        WHERE project = $1 AND status = 'nicht_erkannt' GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30`,
      [project]
    );
    const veraltet = await q(
      `SELECT a.inspector, a.parser_version, v.version AS aktuell, count(*)::int AS n
         FROM asset_files a JOIN unnest($2::text[], $3::int[]) AS v(id, version) ON v.id = a.inspector
        WHERE a.project = $1 AND a.parser_version < v.version
        GROUP BY 1, 2, 3 ORDER BY n DESC`,
      [project, versionen.map(v => v.id), versionen.map(v => v.version)]
    );
    const unbekannt = await q(
      `SELECT inspector, count(*)::int AS n FROM asset_files
        WHERE project = $1 AND inspector IS NOT NULL AND NOT (inspector = ANY($2::text[]))
        GROUP BY 1 ORDER BY 2 DESC LIMIT 30`,
      [project, versionen.map(v => v.id)]
    );
    const verweise = await q('SELECT aufloesung AS k, count(*)::int AS n FROM asset_references WHERE project = $1 GROUP BY 1 ORDER BY 2 DESC', [project]);
    const aus: Record<string, unknown> = {
      dateien: s.dateien,
      objekte_gemeldet: Number(s.objekte_gemeldet),
      objekte_gekappt_dateien: s.objekte_gekappt_dateien,
      letzter_lauf: s.letzter_lauf,
      aelteste_fehlend_seit: s.aelteste_fehlend_seit,
      je_status: await gruppe('status'),
      je_asset_type: await gruppe('asset_type'),
      je_format: await gruppe('format'),
      inspiziert_von: await gruppe('inspiziert_von'),
      nicht_erkannt_je_endung: Object.fromEntries(nichtErkannt.map(r => [r.k, r.n])),
      veraltete_inspektor_version: veraltet.map(r => ({ inspector: r.inspector, parser_version: r.parser_version, aktuell: r.aktuell, dateien: r.n })),
      unbekannte_inspektoren: unbekannt.map(r => ({ inspector: r.inspector, dateien: r.n })),
      verweise_je_aufloesung: Object.fromEntries(verweise.map(r => [r.k, r.n])),
      total: s.dateien,
      gekappt: false,
    };
    // P22-T236 Debug: ausgeblendete (nicht vorhandene) Eintraege zaehlen - sie erscheinen in keiner anderen Abfrage.
    // Quotiertes "asset_files" = Tabelle ohne Sicht (intel-bereich.ts).
    if (bereich === ASSET_BEREICH && (await leseAssetIndexWirklichkeit(project)).aktiv) {
      const [u] = await q(
        `SELECT count(*) FILTER (WHERE deleted_at IS NULL AND status = 'quelle_nicht_gefunden')::int AS quelle_fehlt,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS im_wiederherstellungsfenster
           FROM "asset_files" WHERE project = $1`,
        [project]
      );
      aus.ausgeblendet = {
        quelle_fehlt: u.quelle_fehlt,
        im_wiederherstellungsfenster: u.im_wiederherstellungsfenster,
        hinweis: 'Nicht vorhandene Assets (Schalter asset_index_wirklichkeit): geloeschte nur ueber asset_intel geloescht/wiederherstellen; fehlende Quellen bereinigt intern asset_altbestand_bereinigen.',
      };
    }
    if (s.dateien === 0) aus.hinweis = 'Keine Asset-Eintraege fuer dieses Projekt. Inspiziert wird nur im lokalen Watcher-Prozess (sieht die Dateien); Container/REST lesen nur.';
    return aus;
  });
}

// ---------------------------------------------------------------------------
// Kappung der Antwort
// ---------------------------------------------------------------------------

const KUERZBARE_SCHLUESSEL = new Set(['data', 'metadata', 'format_specific']);

/** Kuerzt in data/metadata/format_specific jeden Wert, dessen JSON laenger als max ist. */
function kuerzeDatenWerte(wert: unknown, max: number, inDaten = false, tiefe = 0, rekursionMax = 50): unknown {
  if (tiefe > rekursionMax) return wert;
  if (inDaten) {
    const json = JSON.stringify(wert) ?? '';
    if (json.length > max) return (typeof wert === 'string' ? wert : json).slice(0, max) + GEKUERZT;
    return wert;
  }
  if (Array.isArray(wert)) return wert.map(w => kuerzeDatenWerte(w, max, false, tiefe + 1, rekursionMax));
  if (wert && typeof wert === 'object' && !(wert instanceof Date)) {
    const aus: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wert as Record<string, unknown>)) {
      if (KUERZBARE_SCHLUESSEL.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
        const d: Record<string, unknown> = {};
        for (const [dk, dv] of Object.entries(v as Record<string, unknown>)) d[dk] = kuerzeDatenWerte(dv, max, true, tiefe + 1, rekursionMax);
        aus[k] = d;
      } else {
        aus[k] = kuerzeDatenWerte(v, max, false, tiefe + 1, rekursionMax);
      }
    }
    return aus;
  }
  return wert;
}

/** Groesste Liste (nach JSON-Laenge) bis Tiefe 3 suchen. */
function groessteListe(obj: unknown, tiefe = 0): { liste: unknown[]; laenge: number } | null {
  if (tiefe > 3 || !obj || typeof obj !== 'object') return null;
  let beste: { liste: unknown[]; laenge: number } | null = null;
  const werte = Array.isArray(obj) ? [] : Object.values(obj as Record<string, unknown>);
  for (const v of werte) {
    if (Array.isArray(v) && v.length > 1) {
      const l = JSON.stringify(v).length;
      if (!beste || l > beste.laenge) beste = { liste: v, laenge: l };
    }
    const tiefer = Array.isArray(v) ? null : groessteListe(v, tiefe + 1);
    if (tiefer && (!beste || tiefer.laenge > beste.laenge)) beste = tiefer;
    if (Array.isArray(v)) {
      for (const e of v.slice(0, 3)) {
        const t = groessteListe(e, tiefe + 1);
        if (t && (!beste || t.laenge > beste.laenge)) beste = t;
      }
    }
  }
  return beste;
}

/**
 * Haelt eine Antwort hart unter max Zeichen (JSON): 1. data-/metadata-Werte auf
 * ASSET_DATA_WERT_MAX kuerzen, 2. die groesste Liste halbieren (wiederholt), 3. langen Baumtext
 * abschneiden. Setzt gekappt:true und antwort_gekuerzt mit Erklaerung. total bleibt unveraendert.
 */
/** P18-T86: Reverse misst in UTF-8-Bytes mit eigenen Einstellwerten; ohne o bleibt das Projektverhalten unveraendert. */
export interface KappOptionen { bytes?: boolean; wertZeichen?: number; rekursionMax?: number; reserve?: number }
export function kappeAntwort<T extends Record<string, unknown>>(antwort: T, max = ASSET_ANTWORT_MAX, o: KappOptionen = {}): T {
  const laenge = (x: unknown) => (o.bytes ? Buffer.byteLength(JSON.stringify(x)) : JSON.stringify(x).length);
  const wertMax = o.wertZeichen ?? ASSET_DATA_WERT_MAX;
  if (laenge(antwort) <= max) return antwort;
  const a = kuerzeDatenWerte(antwort, wertMax, false, 0, o.rekursionMax ?? 50) as Record<string, unknown>;
  const schritte: string[] = ['Werte in data/metadata auf ' + wertMax + ' Zeichen gekuerzt'];
  a.gekappt = true;
  let halbiert = 0;
  while (laenge(a) > max) {
    const g = groessteListe(a);
    if (!g || g.liste.length <= 1) break;
    g.liste.splice(Math.ceil(g.liste.length / 2));
    halbiert++;
  }
  if (halbiert > 0) schritte.push('Listen ' + halbiert + 'x halbiert');
  if (laenge(a) > max && typeof a.baum === 'string') {
    const rest = max - (laenge({ ...a, baum: '' }) + (o.reserve ?? 200));
    a.baum = (a.baum as string).slice(0, Math.max(0, rest)) + '\n' + GEKUERZT;
    schritte.push('Baum abgeschnitten');
  }
  a.antwort_gekuerzt = 'Antwort ueber ' + max + ' Zeichen: ' + schritte.join(', ') + '. Mit limit/offset/object_type einengen.';
  if (laenge(a) > max) {
    // letzte Sicherung: nur Kopf + Zahlen
    const kopf: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a)) if (v === null || typeof v !== 'object') kopf[k] = typeof v === 'string' ? v.slice(0, 2000) : v;
    kopf.antwort_gekuerzt = 'Antwort ueber ' + max + ' Zeichen auch nach dem Kuerzen; nur Kopfdaten. Mit limit/offset einengen.';
    return kopf as T;
  }
  return a as T;
}
