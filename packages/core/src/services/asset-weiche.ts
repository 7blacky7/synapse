/**
 * MODUL: Asset-Weiche (Etappe C, P4-T67/T70)
 * ZWECK: Verbindet code_intel und asset_intel in beide Richtungen (Entwurf thought 999610b9, Abschnitt 5).
 *   - loeseDateiWelt: welcher Index kennt einen Pfad? Reihenfolge exakt-Code > exakt-Asset > LIKE-Code > LIKE-Asset.
 *   - ergaenzeCodeIntelAntwort: haengt an eine FERTIGE code_intel-Antwort Zusatzfelder an (file, search,
 *     leere Ergebnisse auf Asset-Pfaden). Beide Strecken (stdio und REST) rufen genau diese Funktion.
 *   - holeBaumAssets/assetMarker/assetSammelZeile: Asset-Zeilen fuer getProjectTree.
 *   - findeCodeDatei/zaehleCodeDateien: Umkehrung asset_intel -> code_intel (asset-intel-tool.ts).
 *
 * HAERTESTE BEDINGUNG: Projekte OHNE asset_files-Zeilen bekommen jede code_intel-Antwort byte-gleich.
 *   Vorab-Test projektHatAssets(): eine EXISTS-Abfrage ueber den Index (project, file_path), kurz gecacht
 *   (SYNAPSE_ASSET_WEICHE_CACHE_MS, Standard 10 s, 0 = ohne Cache). Erst danach folgt jede weitere Abfrage.
 *   Die Weiche liefert nur ZUSATZFELDER; einzige Ausnahme ist code_intel(file) auf einen Asset-Pfad, der im
 *   Code-Index nicht exakt existiert (dort gab es vorher 'Datei nicht gefunden' bzw. einen LIKE-Fremdtreffer).
 *
 * FEHLER: Keine Funktion hier wirft in den Aufrufer. Faellt eine Weichen-Abfrage aus (auch 42P01, Tabellen
 *   fehlen), bleibt die Bestandsantwort unveraendert.
 */

import { getPool } from '../db/client.js';
import { escapeLike, inspiziereAusDb, kappeAntwort, zerlegeSuchanfrage } from './asset-intel-abfragen.js';
import { normalisiereAssetPfad } from './asset-intel-store.js';
import {holeAssetKonflikt} from './asset-konflikte.js';

/** Hoechstzahl Asset-Zeilen je Verzeichnis im code_intel-Baum; der Rest wird zur Sammelzeile. */
export const BAUM_ASSETS_JE_VERZEICHNIS = 50;
/** Hoechstzahl Asset-Treffer, die code_intel(search) anhaengt. */
export const WEICHE_SUCHTREFFER_MAX = 5;
/**
 * Zeitgrenze der Asset-Suche in code_intel(search), DB-seitig als statement_timeout: die Datenbank bricht
 * selbst ab, die Verbindung ist sofort frei, die Antwort kommt ohne asset_treffer.
 */
export const WEICHE_SUCH_ZEITGRENZE_MS = 2000;

function cacheMs(): number {
  const roh = process.env.SYNAPSE_ASSET_WEICHE_CACHE_MS;
  const n = roh === undefined || roh === '' ? NaN : Number(roh);
  return Number.isFinite(n) && n >= 0 ? n : 10000;
}

const assetStand = new Map<string, { hat: boolean; bis: number; revision:string }>();

/**
 * Hat das Projekt ueberhaupt asset_files-Zeilen? Billig (EXISTS ueber den UNIQUE-Index) und kurz gecacht.
 * Fehler (Tabelle fehlt, DB weg) zaehlen als "nein" — die Weiche ist dann aus, code_intel unberuehrt.
 */
export async function projektHatAssets(project: string): Promise<boolean> {
  const jetzt = Date.now();
  const c = assetStand.get(project);
  let revision='legacy';
  try {
    const r=await getPool().query('SELECT stand::text AS stand FROM asset_aenderungsstaende WHERE project=$1',[project]);
    revision=r.rows[0]?.stand??'0';
  } catch(e) { if((e as {code?:string}).code!=='42P01')return false; }
  if (c && c.bis > jetzt && c.revision===revision) return c.hat;
  let hat = false;
  try {
    const r = await getPool().query('SELECT EXISTS (SELECT 1 FROM asset_files WHERE project = $1) AS hat', [project]);
    hat = r.rows[0]?.hat === true;
  } catch {
    hat = false;
  }
  const ms = cacheMs();
  if (ms > 0) assetStand.set(project, { hat, bis: jetzt + ms, revision });
  return hat;
}

/** Vergisst den gecachten Asset-Stand (ein Projekt oder alle). Fuer Tests und nach Schreibvorgaengen. */
export function vergissAssetStand(project?: string): void {
  if (project === undefined) assetStand.clear();
  else assetStand.delete(project);
}

// ---------------------------------------------------------------------------
// Pfade aufloesen
// ---------------------------------------------------------------------------

/** Kurzform einer asset_files-Zeile, wie sie die Weiche ausgibt. */
export interface AssetKurz {
  file_path: string;
  file_name: string;
  format: string | null;
  asset_type: string;
  status: string;
  file_size: number;
  n_objects: number;
  n_references: number;
}

export interface DateiWelt {
  /** 'code' = code_files kennt den Pfad, 'asset' = nur asset_files, null = keiner (oder mehrdeutig). */
  welt: 'code' | 'asset' | null;
  treffer?: 'exakt' | 'like';
  code?: { file_path: string; file_type: string | null };
  asset?: AssetKurz;
  /** Mehrere Assets passen auf das Pfadende. */
  kandidaten?: string[];
}

const ASSET_SPALTEN = 'file_path, file_name, format, asset_type, status, file_size, n_objects, n_references';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function alsKurz(r: Record<string, any>): AssetKurz {
  return {
    file_path: r.file_path,
    file_name: r.file_name,
    format: r.format ?? null,
    asset_type: r.asset_type,
    status: r.status,
    file_size: Number(r.file_size),
    n_objects: Number(r.n_objects),
    n_references: Number(r.n_references),
  };
}

/** Asset-Pfad vereinheitlichen; ungueltige Pfade ('..', absolut) -> null statt Fehler. */
function alsAssetPfad(pfad: string | undefined): string | null {
  if (!pfad || !pfad.trim()) return null;
  try {
    return normalisiereAssetPfad(pfad.trim());
  } catch {
    return null;
  }
}

async function holeAssetExakt(project: string, pfad: string | null): Promise<AssetKurz | null> {
  if (!pfad) return null;
  const r = await getPool().query('SELECT ' + ASSET_SPALTEN + ' FROM asset_files WHERE project = $1 AND file_path = $2', [project, pfad]);
  return r.rows[0] ? alsKurz(r.rows[0]) : null;
}

/**
 * Welcher Index kennt den Pfad? Reihenfolge (Entwurf 5.1): exakt-Code > exakt-Asset > LIKE-Code > LIKE-Asset,
 * damit ein LIKE-Treffer im Code ein exakt passendes Asset nicht verdeckt. LIKE-Code wie getFileContent
 * ('%pfad%'), LIKE-Asset wie asset_intel ('%/pfad', eindeutig). Wirft nicht.
 */
export async function loeseDateiWelt(project: string, pfad: string): Promise<DateiWelt> {
  const roh = (pfad ?? '').trim();
  if (!roh) return { welt: null };
  try {
    const pool = getPool();
    const ce = await pool.query('SELECT file_path, file_type FROM code_files WHERE project = $1 AND file_path = $2 LIMIT 1', [project, roh]);
    if (ce.rows[0]) return { welt: 'code', treffer: 'exakt', code: { file_path: ce.rows[0].file_path, file_type: ce.rows[0].file_type ?? null } };
    if (!(await projektHatAssets(project))) {
      const cl = await pool.query('SELECT file_path, file_type FROM code_files WHERE project = $1 AND file_path LIKE $2 ORDER BY file_path LIMIT 1', [project, '%' + roh + '%']);
      return cl.rows[0] ? { welt: 'code', treffer: 'like', code: { file_path: cl.rows[0].file_path, file_type: cl.rows[0].file_type ?? null } } : { welt: null };
    }
    const ap = alsAssetPfad(roh);
    const ae = await holeAssetExakt(project, ap);
    if (ae) return { welt: 'asset', treffer: 'exakt', asset: ae };
    const cl = await pool.query('SELECT file_path, file_type FROM code_files WHERE project = $1 AND file_path LIKE $2 ORDER BY file_path LIMIT 1', [project, '%' + roh + '%']);
    if (cl.rows[0]) return { welt: 'code', treffer: 'like', code: { file_path: cl.rows[0].file_path, file_type: cl.rows[0].file_type ?? null } };
    if (ap) {
      const al = await pool.query(
        'SELECT ' + ASSET_SPALTEN + ' FROM asset_files WHERE project = $1 AND file_path LIKE $2 ORDER BY file_path LIMIT 11',
        [project, '%/' + escapeLike(ap)]
      );
      if (al.rows.length === 1) return { welt: 'asset', treffer: 'like', asset: alsKurz(al.rows[0]) };
      if (al.rows.length > 1) return { welt: null, kandidaten: al.rows.slice(0, 10).map(r => r.file_path as string) };
    }
    return { welt: null };
  } catch {
    return { welt: null };
  }
}

// ---------------------------------------------------------------------------
// Texte
// ---------------------------------------------------------------------------

/** Groesse wie im Asset-Baum: '1,2 MB'. */
export function assetGroesse(b: number): string {
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

/** Ganze Zahl mit Tausenderpunkt ('3.912'), ohne Abhaengigkeit von der ICU-Ausstattung. */
function tausender(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Marker einer Asset-Zeile im code_intel-Baum: '[asset glb 1,2 MB · 14 Obj · ok]'. */
export function assetMarker(a: Pick<AssetKurz, 'format' | 'asset_type' | 'file_size' | 'n_objects' | 'status'>): string {
  const teile = [assetGroesse(Number(a.file_size))];
  if (Number(a.n_objects) > 0) teile.push(a.n_objects + ' Obj');
  teile.push(a.status);
  return '[asset ' + (a.format ?? a.asset_type) + ' ' + teile.join(' · ') + ']';
}

/** Sammelzeile fuer Assets jenseits der Obergrenze eines Verzeichnisses. */
export function assetSammelZeile(dir: string, rest: number, formate: Array<{ format: string; n: number }> = []): string {
  const pfad = dir.replace(/\/+$/, '');
  const fmt = formate.length > 0 ? ' (' + formate.map(f => f.format + ' ' + tausender(f.n)).join(', ') + ')' : '';
  const ziel = pfad ? 'asset_intel(action:"tree", path:"' + pfad + '")' : 'asset_intel(action:"tree")';
  return '… ' + tausender(rest) + ' weitere Assets' + fmt + ' -> ' + ziel;
}

function weicheText(a: Pick<AssetKurz, 'format' | 'asset_type'>): string {
  return 'Asset (' + (a.format ?? a.asset_type) + ') -> asset_intel';
}

function assetHinweis(pfad: string): string {
  return 'Mehr: asset_intel(action:"inspect"|"references"|"used_by", file_path:"' + pfad + '")';
}

// ---------------------------------------------------------------------------
// Baum (getProjectTree)
// ---------------------------------------------------------------------------

/** Asset-Zeile fuer den code_intel-Baum (nur Pfade, die NICHT in code_files stehen). */
export interface BaumAsset extends AssetKurz {
  _asset: true;
  /** Verzeichnis mit '/' am Ende ('' = Projektwurzel). */
  dir: string;
  /** Zahl aller Assets dieses Verzeichnisses (vor der Obergrenze). */
  n_dir: number;
}

export interface BaumAssets {
  zeilen: BaumAsset[];
  /** Verzeichnis -> Formate der Assets jenseits der Obergrenze. */
  rest: Map<string, Array<{ format: string; n: number }>>;
  /** Alle passenden Assets (vor der Obergrenze). */
  total: number;
}

const LEERER_BAUM = (): BaumAssets => ({ zeilen: [], rest: new Map(), total: 0 });

/**
 * Asset-Zeilen fuer getProjectTree: Pfadfilter wie dort (Teilpfad '%dirPath%'), je Verzeichnis die ersten
 * BAUM_ASSETS_JE_VERZEICHNIS nach Pfad, dazu je Verzeichnis die Formate des Rests. Ohne Assets im Projekt
 * (Vorab-Test) keine weitere Abfrage. Wirft nicht.
 */
export async function holeBaumAssets(project: string, dirPath?: string): Promise<BaumAssets> {
  if (!(await projektHatAssets(project))) return LEERER_BAUM();
  try {
    const params: unknown[] = [project, BAUM_ASSETS_JE_VERZEICHNIS];
    let wo = 'a.project = $1';
    if (dirPath) {
      params.push('%' + dirPath + '%');
      wo += ' AND a.file_path LIKE $3';
    }
    const basis =
      'WITH b AS (SELECT ' + ASSET_SPALTEN.split(', ').map(s => 'a.' + s).join(', ') +
      ', left(a.file_path, length(a.file_path) - length(a.file_name)) AS dir FROM asset_files a WHERE ' + wo +
      ' AND NOT EXISTS (SELECT 1 FROM code_files cf WHERE cf.project = a.project AND cf.file_path = a.file_path)),' +
      ' n AS (SELECT b.*, row_number() OVER (PARTITION BY dir ORDER BY file_path) AS rn,' +
      ' count(*) OVER (PARTITION BY dir) AS n_dir, count(*) OVER () AS total FROM b) ';
    const pool = getPool();
    const r = await pool.query(basis + 'SELECT * FROM n WHERE rn <= $2 ORDER BY file_path', params);
    const aus = LEERER_BAUM();
    aus.total = r.rows.length > 0 ? Number(r.rows[0].total) : 0;
    aus.zeilen = r.rows.map(z => ({ ...alsKurz(z), _asset: true as const, dir: z.dir as string, n_dir: Number(z.n_dir) }));
    if (aus.zeilen.some(z => z.n_dir > BAUM_ASSETS_JE_VERZEICHNIS)) {
      const rr = await pool.query(
        basis + 'SELECT dir, COALESCE(format, asset_type) AS format, count(*)::int AS n FROM n WHERE rn > $2 GROUP BY 1, 2 ORDER BY 1, 3 DESC, 2',
        params
      );
      for (const z of rr.rows) {
        const liste = aus.rest.get(z.dir) ?? [];
        liste.push({ format: z.format, n: Number(z.n) });
        aus.rest.set(z.dir, liste);
      }
    }
    return aus;
  } catch {
    return LEERER_BAUM();
  }
}

// ---------------------------------------------------------------------------
// code_intel-Antworten ergaenzen
// ---------------------------------------------------------------------------

type Antwort = Record<string, unknown>;

function textArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/** Leeres Ergebnis einer Datei-Abfrage? (Feldnamen je action wie in beiden Handlern.) */
function istLeer(action: string, a: Antwort): boolean {
  switch (action) {
    case 'functions':
    case 'variables':
    case 'symbols':
    case 'statements':
    case 'calls':
      return a.count === 0;
    case 'flow':
      return Array.isArray(a.statements) && a.statements.length === 0;
    case 'health':
      return a.success === false;
    default:
      return false;
  }
}

async function assetAntwort(project: string, asset: AssetKurz, projektFeld: unknown): Promise<Antwort> {
  const zusammenfassung = await inspiziereAusDb(project, asset.file_path, { objects_limit: 20, references_limit: 20 });
  return kappeAntwort({
    success: true,
    beantwortet_von: 'asset_intel',
    weiche: weicheText(asset),
    grund: 'Binaerdatei ohne Textinhalt im Code-Index; Struktur kommt aus dem Asset-Index',
    file_path: asset.file_path,
    zusammenfassung,
    hinweis: assetHinweis(asset.file_path),
    project: projektFeld,
  });
}

/** Marker im SQL-Text: macht die Weichen-Suche in pg_stat_activity erkennbar (Test, Diagnose). */
export const WEICHE_SUCH_MARKER = '/* asset-weiche-suche */';

/** Platzhalter $n (ohne Dollarzeichen im Quelltext gebaut). */
const platz = (n: number): string => '\x24' + n;

/**
 * Asset-Suche fuer code_intel(search): Begriffe wie asset_intel search (Pfad, Objektname, Verweisziel; alle
 * Begriffe muessen treffen), aber OHNE Filter-/format:-Kurzform und mit DB-seitigem statement_timeout
 * WEICHE_SUCH_ZEITGRENZE_MS fuer genau diese Abfragen: SET auf dem eigenen Client, danach RESET, keine
 * Transaktion. Bricht die Datenbank ab (57014), ist die Verbindung sofort frei. Abfragebau wie sucheAssets
 * (asset-intel-abfragen.ts; Messung B1/B2 mit 750.000 Verweisen), dort laeuft das Zeitlimit mit 10 s.
 * null = keine Begriffe, Zeitlimit oder Fehler.
 */
async function sucheAssetTreffer(project: string, query: string): Promise<{ treffer: Array<Record<string, unknown>>; total: number; gekappt: boolean } | null> {
  const begriffe = zerlegeSuchanfrage(query).begriffe.slice(0, 5).map(b => b.slice(0, 100));
  if (begriffe.length === 0) return null;
  const muster = begriffe.map(b => '%' + escapeLike(b) + '%');
  const teile: string[] = [];
  muster.forEach((_, i) => {
    const pm = platz(i + 2);
    const bit = 1 << i;
    teile.push(
      'SELECT a2.id AS asset_id, ' + bit + ' AS bit FROM asset_files a2 WHERE a2.project = ' + platz(1) + ' AND a2.file_path ILIKE ' + pm,
      'SELECT o.asset_id, ' + bit + ' FROM asset_objects o WHERE o.project = ' + platz(1) + ' AND o.name ILIKE ' + pm,
      'SELECT r.asset_id, ' + bit + ' FROM asset_references r WHERE r.project = ' + platz(1) + ' AND r.target ILIKE ' + pm
    );
  });
  const sql =
    WEICHE_SUCH_MARKER + ' WITH f AS (' + teile.join(' UNION ALL ') + '),' +
    ' g AS (SELECT asset_id, count(*)::int AS n_fund FROM f GROUP BY asset_id' +
    (begriffe.length > 1 ? ' HAVING bit_or(bit) = ' + ((1 << begriffe.length) - 1) : '') + ')' +
    ' SELECT a.*, g.n_fund, count(*) OVER () AS total FROM g CROSS JOIN LATERAL (SELECT a.id, a.file_path, a.format, a.status' +
    ' FROM asset_files a WHERE a.id = g.asset_id AND a.project = ' + platz(1) + ' OFFSET 0) a' +
    ' ORDER BY g.n_fund DESC, a.file_path LIMIT ' + WEICHE_SUCHTREFFER_MAX;
  const fundSql =
    WEICHE_SUCH_MARKER + ' SELECT asset_id, wert FROM (' +
    " SELECT a.id AS asset_id, 'pfad|' || a.file_path AS wert FROM asset_files a" +
    ' WHERE a.id = ANY(' + platz(1) + '::bigint[]) AND a.file_path ILIKE ANY(' + platz(2) + '::text[])' +
    " UNION ALL SELECT o.asset_id, 'objekt|' || o.kind || ': ' || o.name FROM asset_objects o" +
    ' WHERE o.asset_id = ANY(' + platz(1) + '::bigint[]) AND o.name ILIKE ANY(' + platz(2) + '::text[])' +
    " UNION ALL SELECT r.asset_id, 'verweis|' || r.target FROM asset_references r" +
    ' WHERE r.asset_id = ANY(' + platz(1) + '::bigint[]) AND r.target ILIKE ANY(' + platz(2) + '::text[])) x';
  const client = await getPool().connect();
  const start = Date.now();
  let kaputt = false;
  try {
    await client.query('SET statement_timeout = ' + WEICHE_SUCH_ZEITGRENZE_MS);
    const zeilen = (await client.query(sql, [project, ...muster])).rows;
    if (zeilen.length === 0) return { treffer: [], total: 0, gekappt: false };
    // Restzeit fuer die Fundstellen: beide Abfragen zusammen bleiben unter der Zeitgrenze.
    await client.query('SET statement_timeout = ' + Math.max(1, WEICHE_SUCH_ZEITGRENZE_MS - (Date.now() - start)));
    const fz = (await client.query(fundSql, [zeilen.map(z => z.id), muster])).rows;
    const fund = new Map<string, Set<string>>();
    for (const r of fz) {
      const k = String(r.asset_id);
      if (!fund.has(k)) fund.set(k, new Set());
      (fund.get(k) as Set<string>).add(r.wert as string);
    }
    const total = Number(zeilen[0].total);
    return {
      treffer: zeilen.map(z => ({
        file_path: z.file_path,
        format: z.format,
        status: z.status,
        fundstellen: [...(fund.get(String(z.id)) ?? [])].sort().slice(0, 5),
      })),
      total,
      gekappt: zeilen.length < total,
    };
  } catch {
    return null;
  } finally {
    try {
      await client.query('RESET statement_timeout');
    } catch {
      kaputt = true;
    }
    client.release(kaputt ? true : undefined);
  }
}

async function weicheDatei(project: string, args: Record<string, unknown>, a: Antwort): Promise<Antwort> {
  const pfad = textArg(args, 'file_path') ?? textArg(args, 'path');
  if (!pfad || !(await projektHatAssets(project))) return a;
  if (a.success === true && typeof a.file_path === 'string') {
    if (a.file_path !== pfad) {
      // Code kam nur ueber LIKE: ein exakt passendes Asset hat Vorrang (Entwurf 5.1).
      const exakt = await holeAssetExakt(project, alsAssetPfad(pfad));
      if (exakt && exakt.file_path !== a.file_path) return assetAntwort(project, exakt, a.project);
    }
    const eigen = await holeAssetExakt(project, alsAssetPfad(a.file_path));
    if (!eigen) return a;
    return {
      ...a,
      asset: {
        format: eigen.format,
        asset_type: eigen.asset_type,
        status: eigen.status,
        n_objects: eigen.n_objects,
        n_references: eigen.n_references,
        hinweis: 'auch als Asset inspiziert -> asset_intel(action:"inspect", file_path:"' + eigen.file_path + '")',
      },
    };
  }
  if (a.success === false) {
    const w = await loeseDateiWelt(project, pfad);
    if (w.welt === 'asset' && w.asset) return assetAntwort(project, w.asset, a.project);
    if (w.kandidaten) {
      return { ...a, asset_kandidaten: w.kandidaten, hinweis: 'Pfad passt auf mehrere Assets: vollstaendigen Pfad angeben oder asset_intel(action:"inspect", file_path)' };
    }
  }
  return a;
}

async function weicheLeer(project: string, action: string, args: Record<string, unknown>, a: Antwort): Promise<Antwort> {
  const pfad = textArg(args, 'file_path') ?? (action === 'flow' ? textArg(args, 'path') : undefined);
  if (!pfad || !istLeer(action, a) || !(await projektHatAssets(project))) return a;
  const asset = await holeAssetExakt(project, alsAssetPfad(pfad));
  if (!asset) return a;
  return {
    ...a,
    weiche: {
      beantwortet_von: 'asset_intel',
      text: weicheText(asset),
      grund: 'Asset ohne Code-Symbole/Ablauf: leeres Ergebnis ist hier erwartet',
      file_path: asset.file_path,
      format: asset.format,
      status: asset.status,
      n_objects: asset.n_objects,
      hinweis: assetHinweis(asset.file_path),
    },
  };
}

async function weicheSuche(project: string, args: Record<string, unknown>, a: Antwort): Promise<Antwort> {
  const query = textArg(args, 'query');
  if (!query || textArg(args, 'file_path') || textArg(args, 'file_type') || a.success !== true) return a;
  if (!(await projektHatAssets(project))) return a;
  const t = await sucheAssetTreffer(project, query);
  if (!t || !(t.total > 0)) return a;
  return {
    ...a,
    asset_treffer: {
      treffer: t.treffer,
      total: t.total,
      gekappt: t.gekappt,
      hinweis: 'Assets sind nicht Teil von results. Mehr: asset_intel(action:"search", query:' + JSON.stringify(query) + ')',
    },
  };
}

/**
 * Haengt an eine fertige code_intel-Antwort die Weichen-Felder an (Entwurf 5.2-5.4). Beide Strecken rufen
 * diese Funktion mit ihrer Bestandsantwort. Ohne Assets im Projekt kommt die Antwort unveraendert (dasselbe
 * Objekt) zurueck. Wirft nie.
 */
export async function ergaenzeCodeIntelAntwort(action: string | undefined, args: Record<string, unknown>, antwort: unknown): Promise<Antwort> {
  const a = antwort as Antwort;
  if (!antwort || typeof antwort !== 'object' || Array.isArray(antwort)) return a;
  const project = textArg(args, 'project');
  if (!project || !action) return a;
  try {
    switch (action) {
      case 'file':
        {const datei=await weicheDatei(project,args,a);
         const pfad=textArg(args,'file_path')??textArg(args,'path');
         const konflikt=pfad?await holeAssetKonflikt(project,pfad):null;
         return konflikt?{...datei,konflikt}:datei;}
      case 'search':
        return await weicheSuche(project, args, a);
      case 'functions':
      case 'variables':
      case 'symbols':
      case 'statements':
      case 'calls':
      case 'flow':
      case 'health':
        return await weicheLeer(project, action, args, a);
      default:
        return a;
    }
  } catch {
    return a;
  }
}

// ---------------------------------------------------------------------------
// Umkehrung asset_intel -> code_intel (Entwurf 5.6)
// ---------------------------------------------------------------------------

/** Code-Datei zu einem Pfad: exakt, sonst '%/pfad' (eindeutig). null wenn keine oder mehrdeutig. Wirft nicht. */
export async function findeCodeDatei(project: string, pfad: unknown): Promise<{ file_path: string; file_type: string | null } | null> {
  if (typeof pfad !== 'string' || !pfad.trim()) return null;
  const p = pfad.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  try {
    const pool = getPool();
    const e = await pool.query('SELECT file_path, file_type FROM code_files WHERE project = $1 AND file_path = $2 LIMIT 1', [project, p]);
    if (e.rows[0]) return { file_path: e.rows[0].file_path, file_type: e.rows[0].file_type ?? null };
    const l = await pool.query('SELECT file_path, file_type FROM code_files WHERE project = $1 AND file_path LIKE $2 ORDER BY file_path LIMIT 2', [project, '%/' + escapeLike(p)]);
    return l.rows.length === 1 ? { file_path: l.rows[0].file_path, file_type: l.rows[0].file_type ?? null } : null;
  } catch {
    return null;
  }
}

/**
 * Zahl passender Code-Dateien fuer asset_intel tree/search/health (nur Zahl, kein Umschalten).
 * tree: unter path; search: Pfad enthaelt alle Begriffe der query; health: file_path exakt bzw. alle.
 * 0 bei Fehler.
 */
export async function zaehleCodeDateien(project: string, action: string, args: Record<string, unknown>): Promise<number> {
  try {
    const params: unknown[] = [project];
    const wo = ['project = $1', 'NOT ignored'];
    if (action === 'tree') {
      const roh = typeof args.path === 'string' ? args.path.trim().replace(/[\\/]+$/, '').replace(/^\.\/?/, '') : '';
      if (roh) {
        params.push(escapeLike(roh) + '/%');
        wo.push('file_path LIKE $' + params.length);
      }
    } else if (action === 'search') {
      const begriffe = typeof args.query === 'string' ? zerlegeSuchanfrage(args.query).begriffe.slice(0, 5) : [];
      if (begriffe.length === 0) return 0;
      for (const b of begriffe) {
        params.push('%' + escapeLike(b) + '%');
        wo.push('file_path ILIKE $' + params.length);
      }
    } else if (action === 'health') {
      if (typeof args.file_path === 'string' && args.file_path.trim()) {
        params.push(args.file_path.trim());
        wo.push('file_path = $' + params.length);
      }
    } else {
      return 0;
    }
    const r = await getPool().query('SELECT count(*)::int AS n FROM code_files WHERE ' + wo.join(' AND '), params);
    return Number(r.rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}
