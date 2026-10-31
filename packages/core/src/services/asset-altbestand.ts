/**
 * P22-T236 (User-Grundsatz 31.10.2026, thoughts 4d6e67d6, 5eae0647): 'Index = Wirklichkeit' fuer Projekt-Assets.
 *
 * meldeAssetQuellenFehlen: Der Daemon meldet lokal entfernte Assets (unlink, Manifest-Abgleich), auch bei Asset-Sync AUS.
 *   Wirkt NUR auf Zeilen ohne Share-Bytes (legacy_local: transport_revision und storage_key NULL; markiereAssetQuelleFehlt);
 *   Share-Assets loescht weiter der Transferweg mit Wiederherstellungsfenster (P13-T5). Route POST .../assets/quelle-fehlt.
 * pruefeAssetAltbestand: Altbestand abgleichen, Vorschau (Standard) oder ausfuehren:
 *   quelle_fehlt   status 'quelle_nicht_gefunden' ohne Share-Bytes und ohne deleted_at (Ordner/Datei gibt es nicht mehr,
 *                  z. B. synapse coedit-test/t51-golden-*), im API-Weg ohne automatische Frist-Bereinigung.
 *   text_doppelt   Asset-Zeile ohne Share-Bytes fuer eine Textdatei, die zugleich im Code-Index steht (assetArt(pfad) null,
 *                  z. B. SVG: 'SVG sind ja auch Code-Dateien', thought 5eae0647) = Doppelfuehrung.
 *   Entfernen = DELETE asset_files (Objekte/Verweise per ON DELETE CASCADE); Bedingungen werden beim Loeschen erneut geprueft.
 * SCHALTER: asset_index_wirklichkeit (asset-transfer-generisch.ts). Vorschau immer; ausfuehren und Meldungen nur mit EIN.
 * DEBUG: Antwort mit schalter (quelle/bis/letzter_fehler), je_art, je_projekt, beispiele, entfernt.
 */
import * as path from 'node:path';
import { getPool } from '../db/client.js';
import { assetArt } from '../watcher/binary.js';
import { markiereAssetQuelleFehlt, normalisiereAssetPfad } from './asset-intel-store.js';
import { leseAssetIndexWirklichkeit, type AssetSchalterStand } from './asset-transfer-generisch.js';

export const ASSET_QUELLE_FEHLT_MAX = 500;
export const ASSET_ALTBESTAND_LIMIT_STANDARD = 1000;
export const ASSET_ALTBESTAND_LIMIT_MAX = 10_000;

export type AssetAltbestandArt = 'quelle_fehlt' | 'text_doppelt';

/** Lokal entfernte Assets ohne Share-Bytes als 'quelle_nicht_gefunden' markieren (nur mit Schalter EIN). */
export async function meldeAssetQuellenFehlen(project: string, pfade: unknown, o: { schalter?: AssetSchalterStand } = {}): Promise<Record<string, unknown>> {
  const schalter = o.schalter ?? await leseAssetIndexWirklichkeit(project);
  if (!schalter.aktiv) return { success: false, error: { code: 'funktion_aus', message: 'Produkt-Schalter asset_index_wirklichkeit ist AUS.' }, schalter };
  if (!Array.isArray(pfade) || pfade.length === 0 || pfade.length > ASSET_QUELLE_FEHLT_MAX || pfade.some(p => typeof p !== 'string')) {
    return { success: false, error: { code: 'eingang_ungueltig', message: 'pfade: 1 bis ' + ASSET_QUELLE_FEHLT_MAX + ' projekt-relative Pfade erwartet.' }, schalter };
  }
  let markiert = 0, ohne_zeile = 0, ungueltig = 0, verweise_fehlt = 0;
  for (const roh of new Set(pfade as string[])) {
    let pfad: string;
    try { pfad = normalisiereAssetPfad(roh); } catch { ungueltig++; continue; }
    const r = await markiereAssetQuelleFehlt(project, pfad);
    if (r.asset_id === null) ohne_zeile++; else markiert++;
    verweise_fehlt += r.verweise_fehlt;
  }
  return { success: true, markiert, ohne_zeile, ungueltig, verweise_fehlt, schalter };
}

/**
 * P22-T236 Lesewege ausserhalb von asset_intel (Medien-Suche in Qdrant): Pfade, deren Projekt-Asset NICHT vorhanden ist
 * (deleted_at gesetzt = Wiederherstellungsfenster, oder status quelle_nicht_gefunden). Pfade ohne Asset-Zeile bleiben
 * unberuehrt (der Medien-Index wird auch ohne Asset-Weg gefuellt). Nur mit Schalter asset_index_wirklichkeit EIN.
 */
export async function ausgeblendeteAssetPfade(project: string, pfade: readonly string[]): Promise<Set<string>> {
  const liste = [...new Set(pfade.filter(p => typeof p === 'string' && p))];
  if (!liste.length || !(await leseAssetIndexWirklichkeit(project)).aktiv) return new Set();
  const r = await getPool().query<{ file_path: string }>(
    "SELECT file_path FROM asset_files WHERE project = $1 AND file_path = ANY($2::text[]) AND (deleted_at IS NOT NULL OR status = 'quelle_nicht_gefunden')",
    [project, liste],
  );
  return new Set(r.rows.map(z => z.file_path));
}

/**
 * P22-T236 / thought 5eae0647 ('SVG sind ja auch Code-Dateien'; Textformate wie .lock/.txt sind Code/Text, Assets sind
 * Binaerdateien): ausdruecklich genannte Textformate; dazu jede Endung, fuer die der Code-Index einen Parser hat.
 */
export const TEXT_ENDUNGEN_USER: readonly string[] = ['.svg', '.txt', '.lock', '.csv'];
let parserEndungen: Set<string> | null = null;

/** Gehoert dieser Pfad in den Code-Index statt in den Asset-Index? Media/Asset-Endungen (gltf, usda ...) nie. */
export async function istTextFormatPfad(dateiPfad: string): Promise<boolean> {
  if (assetArt(dateiPfad) !== null) return false;
  const endung = path.posix.extname(dateiPfad).toLowerCase();
  if (!endung) return false;
  if (TEXT_ENDUNGEN_USER.includes(endung)) return true;
  if (!parserEndungen) {
    try {
      const { getSupportedExtensions } = await import('../parser/index.js');
      parserEndungen = new Set(getSupportedExtensions().map(e => (e.startsWith('.') ? e : '.' + e).toLowerCase()));
    } catch { parserEndungen = new Set(); }
  }
  return parserEndungen.has(endung);
}

interface Kandidat { project: string; file_path: string; art: AssetAltbestandArt }

const OHNE_SHARE = 'a.deleted_at IS NULL AND a.transport_revision IS NULL AND a.storage_key IS NULL';

async function sammle(project: string | undefined, limit: number): Promise<{ kandidaten: Kandidat[]; gekappt: boolean }> {
  const r = await getPool().query<{ project: string; file_path: string; art: AssetAltbestandArt }>(
    `SELECT * FROM (
       SELECT a.project, a.file_path, 'quelle_fehlt' AS art FROM asset_files a
        WHERE ($1::text IS NULL OR a.project = $1) AND ${OHNE_SHARE} AND a.status = 'quelle_nicht_gefunden'
       UNION ALL
       SELECT a.project, a.file_path, 'text_doppelt' AS art FROM asset_files a
        WHERE ($1::text IS NULL OR a.project = $1) AND ${OHNE_SHARE} AND a.status IS DISTINCT FROM 'quelle_nicht_gefunden'
          AND (EXISTS (SELECT 1 FROM code_files c WHERE c.project = a.project AND c.file_path = a.file_path AND c.deleted_at IS NULL)
               OR lower('.' || a.extension) = ANY($3::text[]))
     ) k ORDER BY project, file_path LIMIT $2`,
    [project ?? null, limit + 1, [...TEXT_ENDUNGEN_USER]],
  );
  // text_doppelt nur fuer reine Textdateien: Media/Text mit Asset-Endung (gltf, usda ...) sind gewollt in beiden Indizes.
  // P22-T236: auch Textformate ohne Code-Zeile (z. B. SVG nur als Asset) - sie gehoeren in den Code-Index (thought 5eae0647).
  const alle: typeof r.rows = [];
  for (const z of r.rows) if (z.art === 'quelle_fehlt' || await istTextFormatPfad(z.file_path)) alle.push(z);
  return { kandidaten: alle.slice(0, limit), gekappt: r.rows.length > limit };
}

/** Vorschau (Standard) oder ausfuehren; ausfuehren nur mit project und Schalter asset_index_wirklichkeit EIN. */
export async function pruefeAssetAltbestand(o: { project?: string; ausfuehren?: boolean; limit?: number }): Promise<Record<string, unknown>> {
  const limit = Math.min(ASSET_ALTBESTAND_LIMIT_MAX, Math.max(1, Math.trunc(o.limit ?? ASSET_ALTBESTAND_LIMIT_STANDARD)));
  const schalter = o.project ? await leseAssetIndexWirklichkeit(o.project) : null;
  if (o.ausfuehren && !o.project) return { success: false, error: 'project_fehlt', message: 'ausfuehren:true nur mit project (Vorschau geht ohne).' };
  if (o.ausfuehren && !schalter?.aktiv) {
    return { success: false, error: 'funktion_aus', message: 'Produkt-Schalter asset_index_wirklichkeit ist fuer ' + o.project + ' AUS; Vorschau ohne ausfuehren.', schalter };
  }
  const { kandidaten, gekappt } = await sammle(o.project, limit);
  const je_art: Record<string, number> = { quelle_fehlt: 0, text_doppelt: 0 };
  const je_projekt: Record<string, number> = {};
  for (const k of kandidaten) { je_art[k.art]++; je_projekt[k.project] = (je_projekt[k.project] ?? 0) + 1; }
  const beispiele = kandidaten.slice(0, 20).map(k => ({ project: k.project, file_path: k.file_path, art: k.art }));
  const basis = { modus: o.ausfuehren ? 'ausfuehren' : 'vorschau', project: o.project ?? null, kandidaten: kandidaten.length, gekappt, je_art, je_projekt, beispiele, schalter };
  if (!o.ausfuehren || kandidaten.length === 0) return { success: true, ...basis, entfernt: 0 };
  const r = await getPool().query<{ file_path: string }>(
    `DELETE FROM asset_files a WHERE a.project = $1 AND a.file_path = ANY($2::text[]) AND ${OHNE_SHARE} RETURNING a.file_path`,
    [o.project, kandidaten.map(k => k.file_path)],
  );
  try { (await import('./asset-weiche.js')).vergissAssetStand(o.project); } catch { /* Cache laeuft von selbst ab */ }
  return { success: true, ...basis, entfernt: r.rowCount ?? r.rows.length, hinweis: gekappt ? 'Weitere Kandidaten: erneut ausfuehren (limit je Aufruf).' : undefined };
}
