/**
 * MODUL: Asset-Intel Speicher (Schreibweg)
 * ZWECK: Legt das Ergebnis eines Inspektionslaufs (AssetResult) in den Tabellen asset_files,
 *        asset_objects und asset_references ab und haelt den Bestand bei Loeschen/Umbenennen
 *        aktuell. Dazu die reine Aufloesung eines Verweisziels (target -> ziel_pfad/aufloesung).
 *
 * WER SCHREIBT: nur der Prozess, der die Datei auf der Platte sieht (lokaler Watcher/Daemon).
 * Die REST-API/der Container liest nur (Entwurf thought 999610b9, Abschnitt 1.2).
 *
 * INPUT:
 *   - project: string - Projektname
 *   - relPfad: string - projekt-relativer Pfad mit '/' (wie code_files.file_path)
 *   - ergebnis: AssetResult - Ausgabe von inspectAsset()
 *
 * OUTPUT:
 *   - SpeicherErgebnis: asset_id, gespeicherte Objekte/Verweise, Kappung, Dauer
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: schreibt/loescht asset_files, asset_objects, asset_references
 *
 * SPERREN (regel-schema-60s-und-keine-sperre-mit-client-warten): JEDE Schreiboperation ist
 * EINE SQL-Anweisung (datenmodifizierende CTEs, Autocommit). Es gibt keine offene Transaktion
 * zwischen zwei Client-Rundreisen; statement_timeout und lock_timeout sind je Anweisung gesetzt.
 *
 * KEIN ROHINHALT: In PG landen nur abgeleitete Daten. Die Originaldatei bleibt Quelle der
 * Wahrheit; alles hier ist jederzeit durch erneutes Inspizieren reproduzierbar.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import {ASSET_LOKAL_ERLAUBT_SQL} from './asset-inspektions-projekte.js';
import type { AssetReference, AssetResult } from '../asset-intel/types.js';
import { DEFAULT_ASSET_MAX_OBJECTS_PER_FILE, DEFAULT_ASSET_RESTORE_WINDOW_MS, getAssetKonfiguration, loeseAssetProjektoptionen } from '../config/asset-konfig.js';

/** Ergebnis der Pruefung eines Verweisziels (CHECK asset_references_aufloesung_check). */
export type AssetAufloesung = 'datei' | 'fehlt' | 'intern' | 'extern' | 'eingebettet' | 'ausserhalb' | 'unbekannt';

/** Standard-Kappe fuer gespeicherte Objekte je Datei (Koordinator-Entscheidung F5). */
export const ASSET_MAX_OBJEKTE_STANDARD = DEFAULT_ASSET_MAX_OBJECTS_PER_FILE;

/** Frist fuer Eintraege mit 'quelle_nicht_gefunden', danach endgueltig entfernbar (F2). */
export const ASSET_LOESCHFRIST_TAGE = DEFAULT_ASSET_RESTORE_WINDOW_MS / (24 * 60 * 60 * 1000);

/** Zeitgrenzen je Schreibanweisung (Millisekunden). */
const STATEMENT_TIMEOUT_MS = 15000;
const LOCK_TIMEOUT_MS = 5000;

/**
 * Verweisarten, die etwas INNERHALB der Datei bezeichnen (Tabelle.Spalte, Eintrag im Paket/Archiv)
 * und nie auf eine Projektdatei zeigen. Quelle: sqlite.ts 'foreign_key', usdz.ts 'paket_inhalt',
 * zip.ts/sevenzip.ts 'archiv_inhalt'.
 */
const INTERNE_ARTEN = new Set(['foreign_key', 'paket_inhalt', 'archiv_inhalt']);

/** Unreal-Paketverweise ('/Game/...', '/Script/...'), Quelle: unreal/package.ts. */
const UNREAL_ARTEN = new Set(['import', 'klassenpaket']);

/** Gemeinsam genutzte Bibliotheken von PE/ELF (kernel32.dll, libc.so.6), Quelle: exe/pe.ts, exe/elf.ts. */
const BIBLIOTHEK_ARTEN = new Set(['library']);

// ---------------------------------------------------------------------------
// Aufloesung target -> ziel_pfad / aufloesung (rein, ohne Datenbank)
// ---------------------------------------------------------------------------

/** Kontext fuer loesePfadAuf. */
export interface AufloesungsKontext {
  /** Projekt-relativer Pfad des verweisenden Assets ('/' als Trenner). */
  assetPfad: string;
  /** Share-Inspektoren entscheiden Existenz ausschließlich am logischen Katalog. */
  katalogAutoritativ?: boolean;
  /** Absoluter Projektpfad; nur noetig fuer absolute Ziele innerhalb des Projekts. */
  projektRoot?: string | null;
  /**
   * Existenzpruefung fuer einen projekt-relativen Pfad. Fehlt sie, wird nur das Urteil des
   * Inspektors (resolved) verwendet; ohne beides lautet das Ergebnis 'unbekannt'.
   */
  existiert?: (relPfad: string) => boolean;
}

/** Ergebnis der Aufloesung eines Verweises. */
export interface VerweisAufloesung {
  /** Projekt-relativer Zielpfad oder null (extern, eingebettet, intern, ausserhalb, nicht deutbar). */
  ziel_pfad: string | null;
  aufloesung: AssetAufloesung;
}

/** Normalisiert einen relativen Pfad mit '/' und loest '.'/'..' auf; null wenn er die Wurzel verlaesst. */
function normalisiereRelativ(teile: string[]): string | null {
  const aus: string[] = [];
  for (const t of teile) {
    if (t === '' || t === '.') continue;
    if (t === '..') {
      if (aus.length === 0) return null;
      aus.pop();
      continue;
    }
    aus.push(t);
  }
  return aus.length === 0 ? null : aus.join('/');
}

/** Projekt-relativen Pfad vereinheitlichen: Backslash -> '/', fuehrendes './' weg. */
export function normalisiereAssetPfad(relPfad: string): string {
  const p = relPfad.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  if (p === '' || p.startsWith('/') || /^[a-zA-Z]:\//.test(p)) {
    throw new Error(`asset-intel: Pfad muss projekt-relativ sein: "${relPfad}"`);
  }
  const n = normalisiereRelativ(p.split('/'));
  if (n === null) throw new Error(`asset-intel: Pfad verlaesst das Projekt: "${relPfad}"`);
  return n;
}

/** Ordner des Assets als Segmentliste (leer = Projektwurzel). */
function ordnerVon(assetPfad: string): string[] {
  const teile = assetPfad.replace(/\\/g, '/').split('/');
  teile.pop();
  return teile.filter(t => t !== '' && t !== '.');
}

/** Prozent-Kodierung aufloesen, aber nur wenn sie wirklich vorkommt und gueltig ist. */
function dekodiere(ziel: string): string {
  if (!/%[0-9a-fA-F]{2}/.test(ziel)) return ziel;
  try {
    return decodeURIComponent(ziel);
  } catch {
    return ziel;
  }
}

/** Ergebnis aus Inspektor-Urteil und Existenzpruefung bilden. */
function dateiOderFehlt(zielPfad: string, resolved: boolean | undefined, kx: AufloesungsKontext): VerweisAufloesung {
  if (kx.katalogAutoritativ && kx.existiert) return { ziel_pfad: zielPfad, aufloesung: kx.existiert(zielPfad) ? 'datei' : 'fehlt' };
  if (resolved === true) return { ziel_pfad: zielPfad, aufloesung: 'datei' };
  if (resolved === false) return { ziel_pfad: zielPfad, aufloesung: 'fehlt' };
  if (kx.existiert) return { ziel_pfad: zielPfad, aufloesung: kx.existiert(zielPfad) ? 'datei' : 'fehlt' };
  return { ziel_pfad: zielPfad, aufloesung: 'unbekannt' };
}

/**
 * Unreal: '/Game/X/Y' -> '<...>/Content/X/Y.uasset' (oder .umap, wenn nur diese existiert),
 * gerechnet ab dem naechsten 'Content'-Ordner ueber dem Asset (wie unreal/package.ts).
 */
function loeseUnreal(ziel: string, ref: Pick<AssetReference, 'resolved'>, kx: AufloesungsKontext): VerweisAufloesung {
  if (/^\/(Script|Engine)\//.test(ziel)) return { ziel_pfad: null, aufloesung: 'extern' };
  if (!ziel.startsWith('/Game/')) return { ziel_pfad: null, aufloesung: 'unbekannt' };
  const ordner = ordnerVon(kx.assetPfad);
  const i = ordner.lastIndexOf('Content');
  if (i < 0) return { ziel_pfad: null, aufloesung: 'unbekannt' };
  const rest = ziel.slice('/Game/'.length).split('.')[0];
  const basis = normalisiereRelativ([...ordner.slice(0, i + 1), ...rest.split('/')]);
  if (basis === null || !basis.startsWith(ordner.slice(0, i + 1).join('/'))) return { ziel_pfad: null, aufloesung: 'ausserhalb' };
  let zielPfad = basis + '.uasset';
  if (kx.existiert && !kx.existiert(zielPfad) && kx.existiert(basis + '.umap')) zielPfad = basis + '.umap';
  return dateiOderFehlt(zielPfad, ref.resolved, kx);
}

/**
 * Loest ein Verweisziel auf. Reihenfolge (Entwurf 2.3):
 *  1. interne Arten (foreign_key, paket_inhalt, archiv_inhalt) -> 'intern'
 *  2. 'data:' -> 'eingebettet'
 *  3. Schema mit '://' (auch file://) bzw. protokoll-relatives '//host' -> 'extern'
 *     (Ausnahme: Blender schreibt '//datei' fuer "relativ zur .blend" -> Pfad)
 *  4. Unreal-Paketpfade -> Content/...uasset bzw. 'extern'/'unbekannt'
 *  5. Bibliotheken (PE/ELF): nur 'datei', wenn sie neben dem Asset liegt, sonst 'extern'
 *  6. sonst Pfad relativ zum Ordner des Assets; verlaesst er das Projekt -> 'ausserhalb'
 *  7. Existenz: Inspektor-Urteil (resolved) vor eigener Pruefung, sonst 'unbekannt'
 */
export function loesePfadAuf(
  ref: Pick<AssetReference, 'target' | 'kind' | 'resolved'>,
  kx: AufloesungsKontext
): VerweisAufloesung {
  const roh = (ref.target ?? '').trim();
  if (INTERNE_ARTEN.has(ref.kind)) return { ziel_pfad: null, aufloesung: 'intern' };
  if (roh === '') return { ziel_pfad: null, aufloesung: 'unbekannt' };
  if (/^data:/i.test(roh)) return { ziel_pfad: null, aufloesung: 'eingebettet' };

  const istBlend = /\.blend\d*$/i.test(kx.assetPfad);
  let ziel = roh;
  if (istBlend && ziel.startsWith('//')) {
    ziel = ziel.slice(2);
  } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ziel) || ziel.startsWith('//')) {
    return { ziel_pfad: null, aufloesung: 'extern' };
  }

  if (UNREAL_ARTEN.has(ref.kind) && ziel.startsWith('/')) return loeseUnreal(ziel, ref, kx);

  ziel = dekodiere(ziel).replace(/\\/g, '/').split(/[?#]/)[0];
  if (ziel === '') return { ziel_pfad: null, aufloesung: 'unbekannt' };

  const absolut = ziel.startsWith('/') || /^[a-zA-Z]:\//.test(ziel);
  if (BIBLIOTHEK_ARTEN.has(ref.kind)) {
    if (absolut || ziel.includes('/')) return { ziel_pfad: null, aufloesung: 'extern' };
    const daneben = normalisiereRelativ([...ordnerVon(kx.assetPfad), ziel]);
    if (daneben !== null && kx.existiert?.(daneben)) return { ziel_pfad: daneben, aufloesung: 'datei' };
    return { ziel_pfad: null, aufloesung: kx.existiert ? 'extern' : 'unbekannt' };
  }

  let zielPfad: string | null;
  if (absolut) {
    const root = kx.projektRoot ? kx.projektRoot.replace(/\\/g, '/').replace(/\/+$/, '') : null;
    if (!root || !(ziel === root || ziel.startsWith(root + '/'))) return { ziel_pfad: null, aufloesung: 'ausserhalb' };
    zielPfad = normalisiereRelativ(ziel.slice(root.length + 1).split('/'));
  } else {
    zielPfad = normalisiereRelativ([...ordnerVon(kx.assetPfad), ...ziel.split('/')]);
  }
  if (zielPfad === null) return { ziel_pfad: null, aufloesung: 'ausserhalb' };
  return dateiOderFehlt(zielPfad, ref.resolved, kx);
}

/** Existenzpruefung gegen die Platte (nur im Prozess, der die Dateien sieht). */
export function dateisystemPruefer(projektRoot: string): (relPfad: string) => boolean {
  return (relPfad: string) => {
    try {
      return fs.statSync(path.join(projektRoot, ...relPfad.split('/'))).isFile();
    } catch {
      return false;
    }
  };
}

// ---------------------------------------------------------------------------
// Bereinigung fuer PostgreSQL (TEXT/JSONB vertragen weder NUL noch einzelne Surrogate)
// ---------------------------------------------------------------------------

const EINZELNES_SURROGAT = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text fuer PG tauglich machen: NUL und einzelne Surrogate -> U+FFFD. */
export function pgText(s: string): string {
  return s.replace(/\u0000/g, '�').replace(EINZELNES_SURROGAT, '�');
}

/** Wert fuer JSONB tauglich machen (Schluessel und Texte bereinigt, BigInt als Text, Tiefe begrenzt). */
function pgJson(wert: unknown, tiefe = 0): unknown {
  if (typeof wert === 'string') return pgText(wert);
  if (typeof wert === 'bigint') return wert.toString();
  if (wert === null || typeof wert !== 'object') return wert;
  if (tiefe > 40) return '[zu tief verschachtelt]';
  if (Array.isArray(wert)) return wert.map(w => pgJson(w, tiefe + 1));
  if (wert instanceof Date) return wert.toISOString();
  if (Buffer.isBuffer(wert) || ArrayBuffer.isView(wert)) return `[${(wert as ArrayBufferView).byteLength} Bytes]`;
  const aus: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(wert as Record<string, unknown>)) aus[pgText(k)] = pgJson(v, tiefe + 1);
  return aus;
}

// ---------------------------------------------------------------------------
// Ausfuehrung: EINE Anweisung je Aufruf, mit Zeitgrenzen
// ---------------------------------------------------------------------------

export interface AssetInspektionsFence { id:string; token:string; }
export class AssetLokalerWriterFehler extends Error {
  readonly code='asset_inspektion_serverseitig';
  constructor(){super('Share-Assets werden ausschließlich durch API-Aufträge inspiziert.');}
}
/** Kurze Writer-Transaktion; niemals Dateisystem-I/O innerhalb der Sperre. */
async function eineAnweisung<T extends Record<string, unknown>>(sql: string, params: unknown[], fence?:AssetInspektionsFence): Promise<T[]> {
  const client: PoolClient = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}; SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-inspektion:'+String(params[0])]);
    if(fence){
      const job=await client.query(`SELECT j.id FROM asset_inspektions_auftraege j WHERE j.id=$1::uuid AND j.lease_token=$2::uuid
        AND j.project=$3 AND j.status='running' AND j.lease_bis>clock_timestamp()
        AND EXISTS(SELECT 1 FROM asset_files a WHERE a.id=j.asset_id AND a.project=$3 AND a.file_path=$4
          AND a.transport_revision=j.transport_revision AND a.transport_sha256=j.sha256)
        FOR UPDATE OF j`,[fence.id,fence.token,params[0],params[1]]);
      if(!job.rowCount)throw new AssetInspektionsRevisionFehler();
    }else{
      const erlaubt=await client.query(`SELECT (${ASSET_LOKAL_ERLAUBT_SQL}) AS erlaubt`,[params[0]]);
      if(erlaubt.rows[0]?.erlaubt!==true)throw new AssetLokalerWriterFehler();
    }
    const r = await client.query(sql, params);
    if(fence){
      if(!r.rows[0]?.asset_id)throw new AssetInspektionsRevisionFehler();
      await client.query("UPDATE asset_inspektions_auftraege SET status='done',lease_token=NULL,lease_bis=NULL,updated_at=clock_timestamp() WHERE id=$1::uuid AND lease_token=$2::uuid",[fence.id,fence.token]);
    }
    await client.query('COMMIT');
    return r.rows as T[];
  } catch(e){await client.query('ROLLBACK');throw e;} finally { client.release(); }
}

function maxObjekteAusEnv(): number {
  return getAssetKonfiguration().speicher.maxObjekteJeDatei;
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

/** Optionen fuer speichereAssetErgebnis. */
export interface SpeicherOptionen {
  /** Absoluter Projektpfad; ermoeglicht Existenzpruefung und mtime. */
  projektRoot?: string | null;
  /** Aenderungszeit der Datei; undefined = aus projektRoot lesen, null = unbekannt. */
  mtime?: Date | null;
  /** Rechnername des inspizierenden Prozesses (Standard os.hostname()). */
  host?: string;
  /** Hoechstzahl gespeicherter Objekte (Standard SYNAPSE_ASSET_MAX_OBJEKTE bzw. 2000). */
  maxObjekte?: number;
  /** Eigene Existenzpruefung (Tests); Standard: Dateisystem unter projektRoot, sonst keine. */
  existiert?: (relPfad: string) => boolean;
  /** Fehlende Zeile mit gleichem sha256 als Umbenennung uebernehmen (Standard true). */
  erkenneUmbenennung?: boolean;
  /** Publiziert nur zur passenden Transportrevision; String erhält BIGINT-Präzision. */
  erwarteteTransportRevision?: string | number;
  /** API-Auftrag mit noch gültigem PG-Lease; ohne Fence kein Share-Schreibweg. */
  inspektionsAuftrag?: AssetInspektionsFence;
  katalogAutoritativ?: boolean;
}

export class AssetInspektionsRevisionFehler extends Error {
  readonly code = 'inspection_revision_veraltet';
  constructor() { super('Inspektion gehört nicht zur aktuellen erreichbaren Bytesrevision.'); this.name = 'AssetInspektionsRevisionFehler'; }
}

/** Ergebnis von speichereAssetErgebnis. */
export interface SpeicherErgebnis {
  asset_id: number | null;
  /** Gespeicherte Objekte (nach Kappung). */
  objekte: number;
  /** Gespeicherte Verweise. */
  verweise: number;
  /** true, wenn mehr Objekte geliefert als gespeichert wurden. */
  gekappt: boolean;
  /** Eingehende Verweise anderer Assets, die von 'fehlt' auf 'datei' gesetzt wurden. */
  eingehend_nachgezogen: number;
  /** Alter Pfad, falls die Zeile per sha256 als Umbenennung uebernommen wurde. */
  umbenannt_von: string | null;
  /** Gesamtdauer in Millisekunden (alle Anweisungen dieses Aufrufs). */
  dauer_ms: number;
}

const SQL_SPEICHERN = `
WITH up AS (
  INSERT INTO asset_files (
    project, file_path, file_name, extension, asset_type, format, status, inspector,
    parser_version, file_size, sha256, mtime, metadata, format_specific, warnings,
    n_objects, n_references, objekte_gekappt, extracted_at, quelle_fehlt_seit, inspiziert_von, updated_at
  ) SELECT
    $1, $2, $3, $4, $5, $6, $7, $8,
    $9, $10, $11, $12, $13::jsonb, $14::jsonb, $15::jsonb,
    $16, $17, $18, $19, NULL, $20, NOW()
  WHERE ($23::bigint IS NULL OR EXISTS (
    SELECT 1 FROM asset_files a WHERE a.project=$1 AND a.file_path=$2 AND a.transport_revision=$23::bigint AND a.prepared_upload_id IS NULL
  ))
  ON CONFLICT (project, file_path) DO UPDATE SET
    file_name = EXCLUDED.file_name, extension = EXCLUDED.extension, asset_type = EXCLUDED.asset_type,
    format = EXCLUDED.format, status = EXCLUDED.status, inspector = EXCLUDED.inspector,
    parser_version = EXCLUDED.parser_version, file_size = EXCLUDED.file_size, sha256 = EXCLUDED.sha256,
    mtime = EXCLUDED.mtime, metadata = EXCLUDED.metadata, format_specific = EXCLUDED.format_specific,
    warnings = EXCLUDED.warnings, n_objects = EXCLUDED.n_objects, n_references = EXCLUDED.n_references,
    objekte_gekappt = EXCLUDED.objekte_gekappt, extracted_at = EXCLUDED.extracted_at,
    quelle_fehlt_seit = NULL, inspiziert_von = EXCLUDED.inspiziert_von, updated_at = NOW(),
    inspection_revision = COALESCE(asset_files.transport_revision, asset_files.inspection_revision)
  WHERE ($23::bigint IS NULL OR asset_files.transport_revision=$23::bigint)
    AND asset_files.prepared_upload_id IS NULL
    AND ((asset_files.transport_revision IS NULL AND asset_files.storage_key IS NULL) OR (
      asset_files.transport_revision IS NOT NULL AND asset_files.storage_key IS NOT NULL AND asset_files.storage_status='ready' AND asset_files.deleted_at IS NULL
      AND asset_files.transport_sha256=EXCLUDED.sha256 AND asset_files.file_size=EXCLUDED.file_size
    ))
  RETURNING id
),
alt_obj AS (DELETE FROM asset_objects WHERE asset_id IN (SELECT id FROM up)),
alt_ref AS (DELETE FROM asset_references WHERE asset_id IN (SELECT id FROM up)),
neu_obj AS (
  INSERT INTO asset_objects (asset_id, project, ordnung, kind, name, data, byte_offset, byte_length, line_start, line_end)
  SELECT up.id, $1, o.ordnung, o.kind, o.name, COALESCE(o.data, '{}'::jsonb), o.byte_offset, o.byte_length, o.line_start, o.line_end
    FROM up, jsonb_to_recordset($21::jsonb) AS o(
      ordnung INTEGER, kind TEXT, name TEXT, data JSONB,
      byte_offset BIGINT, byte_length BIGINT, line_start INTEGER, line_end INTEGER)
  RETURNING 1
),
neu_ref AS (
  INSERT INTO asset_references (asset_id, project, ordnung, kind, target, ziel_pfad, aufloesung, inspektor_resolved)
  SELECT up.id, $1, r.ordnung, r.kind, r.target, r.ziel_pfad, r.aufloesung, r.inspektor_resolved
    FROM up, jsonb_to_recordset($22::jsonb) AS r(
      ordnung INTEGER, kind TEXT, target TEXT, ziel_pfad TEXT, aufloesung TEXT, inspektor_resolved BOOLEAN)
  RETURNING 1
),
eingehend AS (
  UPDATE asset_references SET aufloesung = 'datei'
   WHERE project = $1 AND ziel_pfad = $2 AND aufloesung = 'fehlt'
     AND asset_id NOT IN (SELECT id FROM up) AND EXISTS (SELECT 1 FROM up)
  RETURNING 1
)
SELECT (SELECT id FROM up) AS asset_id,
       (SELECT count(*) FROM neu_obj)::int AS objekte,
       (SELECT count(*) FROM neu_ref)::int AS verweise,
       (SELECT count(*) FROM eingehend)::int AS eingehend
`;

const SQL_UMBENENNUNG_PER_HASH = `
WITH kandidat AS (
  SELECT id, file_path AS alt
    FROM asset_files
   WHERE project = $1 AND sha256 = $3 AND status = 'quelle_nicht_gefunden'
     AND transport_revision IS NULL AND storage_key IS NULL
     AND NOT EXISTS (SELECT 1 FROM asset_files WHERE project = $1 AND file_path = $2)
   ORDER BY quelle_fehlt_seit DESC NULLS LAST, id DESC
   LIMIT 1
)
UPDATE asset_files a
   SET file_path = $2, file_name = $4, extension = $5, updated_at = NOW()
  FROM kandidat
 WHERE a.id = kandidat.id
RETURNING a.id, kandidat.alt
`;

function dateiName(relPfad: string): string {
  return relPfad.slice(relPfad.lastIndexOf('/') + 1);
}

function endung(relPfad: string): string | null {
  const name = dateiName(relPfad);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : null;
}

/**
 * Speichert ein Inspektionsergebnis (ersetzt Objekte und Verweise der Datei vollstaendig).
 * Ergebnis mit status 'quelle_nicht_gefunden' wird wie ein UNLINK behandelt (markiereAssetQuelleFehlt):
 * vorhandene Objekte/Verweise bleiben lesbar.
 */
export async function speichereAssetErgebnis(
  project: string,
  relPfad: string,
  ergebnis: AssetResult,
  opts: SpeicherOptionen = {}
): Promise<SpeicherErgebnis> {
  const start = Date.now();
  const pfad = normalisiereAssetPfad(relPfad);
  const revision = opts.erwarteteTransportRevision;
  if(opts.inspektionsAuftrag && revision===undefined)throw new AssetInspektionsRevisionFehler();
  if (revision !== undefined && !((typeof revision === 'string' && /^(0|[1-9][0-9]*)$/.test(revision)) || (typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0))) {
    throw new TypeError('Erwartete Transportrevision muss eine nichtnegative Ganzzahl sein.');
  }

  if (ergebnis.status === 'quelle_nicht_gefunden') {
    if (revision !== undefined) throw new AssetInspektionsRevisionFehler();
    const m = await markiereAssetQuelleFehlt(project, pfad);
    return { asset_id: m.asset_id, objekte: 0, verweise: 0, gekappt: false, eingehend_nachgezogen: 0, umbenannt_von: null, dauer_ms: Date.now() - start };
  }

  const root = opts.projektRoot ?? null;
  const existiert = opts.existiert ?? (root ? dateisystemPruefer(root) : undefined);
  let mtime: Date | null = opts.mtime ?? null;
  if (opts.mtime === undefined && root) {
    try {
      mtime = fs.statSync(path.join(root, ...pfad.split('/'))).mtime;
    } catch {
      mtime = null;
    }
  }

  let umbenanntVon: string | null = null;
  if (opts.erkenneUmbenennung !== false && ergebnis.sha256) {
    try {
      const u = await eineAnweisung<{ id: string; alt: string }>(SQL_UMBENENNUNG_PER_HASH, [
        project, pfad, ergebnis.sha256, pgText(dateiName(pfad)), endung(pfad),
      ]);
      umbenanntVon = u[0]?.alt ?? null;
    } catch (e) {
      // 23505: ein paralleler Lauf hat den Zielpfad gerade angelegt -> normal weiterspeichern
      if ((e as { code?: string }).code !== '23505') throw e;
    }
  }

  const max = opts.maxObjekte === undefined
    ? maxObjekteAusEnv()
    : loeseAssetProjektoptionen(getAssetKonfiguration(), { maxObjekteJeDatei: opts.maxObjekte }).maxObjekteJeDatei;
  const objekte = ergebnis.objects.slice(0, max).map((o, i) => {
    const sr = o.source_range;
    const byteBereich = sr && 'offset' in sr ? sr : null;
    const zeilen = sr && 'line_start' in sr ? sr : null;
    return {
      ordnung: i,
      kind: pgText(String(o.kind ?? 'unbekannt')),
      name: o.name === null || o.name === undefined ? null : pgText(String(o.name)),
      data: pgJson(o.data ?? {}),
      byte_offset: byteBereich ? byteBereich.offset : null,
      byte_length: byteBereich ? byteBereich.length : null,
      line_start: zeilen ? zeilen.line_start : null,
      line_end: zeilen ? zeilen.line_end : null,
    };
  });
  const gekappt = ergebnis.objects.length > objekte.length;

  const kx: AufloesungsKontext = { assetPfad: pfad, projektRoot: root, existiert, katalogAutoritativ:opts.katalogAutoritativ };
  const verweise = ergebnis.references.map((r, i) => {
    const a = loesePfadAuf(r, kx);
    return {
      ordnung: i,
      kind: pgText(String(r.kind ?? 'unbekannt')),
      target: pgText(String(r.target ?? '')),
      ziel_pfad: a.ziel_pfad === null ? null : pgText(a.ziel_pfad),
      aufloesung: a.aufloesung,
      inspektor_resolved: typeof r.resolved === 'boolean' ? r.resolved : null,
    };
  });

  const zeilen = await eineAnweisung<{ asset_id: string; objekte: number; verweise: number; eingehend: number }>(SQL_SPEICHERN, [
    project,
    pfad,
    pgText(dateiName(pfad)),
    endung(pfad),
    pgText(ergebnis.asset_type || 'unbekannt'),
    ergebnis.format === null ? null : pgText(ergebnis.format),
    ergebnis.status,
    ergebnis.inspector === null ? null : pgText(ergebnis.inspector),
    Number.isInteger(ergebnis.parser_version) ? ergebnis.parser_version : 0,
    Number.isFinite(ergebnis.size) ? Math.max(0, Math.trunc(ergebnis.size)) : 0,
    ergebnis.sha256,
    mtime,
    JSON.stringify(pgJson(ergebnis.metadata ?? {})),
    JSON.stringify(pgJson(ergebnis.format_specific ?? {})),
    JSON.stringify(pgJson(ergebnis.warnings ?? [])),
    ergebnis.objects.length,
    verweise.length,
    gekappt,
    ergebnis.extracted_at || new Date().toISOString(),
    pgText(opts.host ?? os.hostname()),
    JSON.stringify(objekte),
    JSON.stringify(verweise),
    revision ?? null,
  ], opts.inspektionsAuftrag);
  const z = zeilen[0];
  if (!z?.asset_id) throw new AssetInspektionsRevisionFehler();
  return {
    asset_id: z?.asset_id === undefined || z?.asset_id === null ? null : Number(z.asset_id),
    objekte: z?.objekte ?? 0,
    verweise: z?.verweise ?? 0,
    gekappt,
    eingehend_nachgezogen: z?.eingehend ?? 0,
    umbenannt_von: umbenanntVon,
    dauer_ms: Date.now() - start,
  };
}

/** Ergebnis von markiereAssetQuelleFehlt. */
export interface QuelleFehltErgebnis {
  /** id der markierten Zeile, null wenn es keine gab. */
  asset_id: number | null;
  /** Eingehende Verweise, die von 'datei' auf 'fehlt' gesetzt wurden. */
  verweise_fehlt: number;
}

/**
 * UNLINK: Zeile bleibt (T60-Festlegung), status 'quelle_nicht_gefunden', quelle_fehlt_seit gesetzt
 * (bleibt beim ersten Zeitpunkt). Eingehende Verweise auf diesen Pfad werden 'fehlt' — auch wenn
 * es zu dem Pfad selbst keine Asset-Zeile gibt (z. B. eine .mtl, auf die eine .obj zeigt).
 */
export async function markiereAssetQuelleFehlt(project: string, relPfad: string): Promise<QuelleFehltErgebnis> {
  const pfad = normalisiereAssetPfad(relPfad);
  const z = await eineAnweisung<{ asset_id: string | null; verweise: number }>(
    `WITH m AS (
       UPDATE asset_files
          SET status = 'quelle_nicht_gefunden', quelle_fehlt_seit = COALESCE(quelle_fehlt_seit, NOW()), updated_at = NOW()
        WHERE project = $1 AND file_path = $2 AND transport_revision IS NULL AND storage_key IS NULL
       RETURNING id
     ),
     r AS (
       UPDATE asset_references SET aufloesung = 'fehlt'
        WHERE project = $1 AND ziel_pfad = $2 AND aufloesung = 'datei'
          AND NOT EXISTS (SELECT 1 FROM asset_files a WHERE a.project=$1 AND a.file_path=$2
            AND (a.transport_revision IS NOT NULL OR a.storage_key IS NOT NULL))
       RETURNING 1
     )
     SELECT (SELECT id FROM m) AS asset_id, (SELECT count(*) FROM r)::int AS verweise`,
    [project, pfad]
  );
  const id = z[0]?.asset_id;
  return { asset_id: id === null || id === undefined ? null : Number(id), verweise_fehlt: z[0]?.verweise ?? 0 };
}

/**
 * Setzt den Pfad einer Asset-Zeile um (id bleibt). Eingehende Verweise auf den NEUEN Pfad werden
 * 'datei'; Verweise auf den ALTEN Pfad bleiben, wie sie sind — die verweisende Datei zeigt
 * tatsaechlich ins Leere. false, wenn es die alte Zeile nicht gibt oder der neue Pfad belegt ist.
 */
export async function benenneAssetUm(project: string, alterPfad: string, neuerPfad: string): Promise<boolean> {
  const alt = normalisiereAssetPfad(alterPfad);
  const neu = normalisiereAssetPfad(neuerPfad);
  if (alt === neu) return false;
  const z = await eineAnweisung<{ umbenannt: number }>(
    `WITH u AS (
       UPDATE asset_files SET file_path = $3, file_name = $4, extension = $5, updated_at = NOW()
        WHERE project = $1 AND file_path = $2
          AND NOT EXISTS (SELECT 1 FROM asset_files WHERE project = $1 AND file_path = $3)
       RETURNING id
     ),
     r AS (
       UPDATE asset_references SET aufloesung = 'datei'
        WHERE project = $1 AND ziel_pfad = $3 AND aufloesung = 'fehlt'
          AND EXISTS (SELECT 1 FROM u)
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM u)::int AS umbenannt, (SELECT count(*) FROM r)::int AS verweise`,
    [project, alt, neu, pgText(dateiName(neu)), endung(neu)]
  );
  return (z[0]?.umbenannt ?? 0) > 0;
}

/**
 * Zieht eingehende Verweise auf zielPfad nach (ADD -> 'datei', UNLINK -> 'fehlt').
 * Beruehrt nur Verweise, die bereits 'datei' oder 'fehlt' sind. Liefert die Zahl geaenderter Zeilen.
 */
export async function aktualisiereVerweisZiel(project: string, zielPfad: string, existiert: boolean): Promise<number> {
  const pfad = normalisiereAssetPfad(zielPfad);
  const neu: AssetAufloesung = existiert ? 'datei' : 'fehlt';
  const z = await eineAnweisung<{ n: number }>(
    `WITH r AS (
       UPDATE asset_references SET aufloesung = $3
        WHERE project = $1 AND ziel_pfad = $2 AND aufloesung IN ('datei', 'fehlt') AND aufloesung <> $3
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM r`,
    [project, pfad, neu]
  );
  return z[0]?.n ?? 0;
}

/** Optionen fuer entferneAssetsEndgueltig (genau eine Art waehlen). */
export interface EntfernenOptionen {
  /** Genau diese Pfade entfernen (beliebiger Status). */
  pfade?: string[];
  /** Eintraege mit 'quelle_nicht_gefunden', die laenger als N Tage fehlen (Standard 30). */
  aelterAlsTage?: number;
  /** Alle Asset-Daten des Projekts (Projekt-Entfernung). */
  ganzesProjekt?: boolean;
}

/**
 * Entfernt Asset-Zeilen endgueltig; Objekte und Verweise gehen per ON DELETE CASCADE mit.
 * Ohne Optionen: nur 'quelle_nicht_gefunden' aelter als das zentral konfigurierte Wiederherstellungsfenster.
 */
export async function entferneAssetsEndgueltig(project: string, opts: EntfernenOptionen = {}): Promise<number> {
  let sql: string;
  let params: unknown[];
  if (opts.ganzesProjekt) {
    sql = `WITH d AS (DELETE FROM asset_files WHERE project = $1 RETURNING 1) SELECT count(*)::int AS n FROM d`;
    params = [project];
  } else if (opts.pfade) {
    if (opts.pfade.length === 0) return 0;
    sql = `WITH d AS (DELETE FROM asset_files WHERE project = $1 AND file_path = ANY($2::text[]) RETURNING 1) SELECT count(*)::int AS n FROM d`;
    params = [project, opts.pfade.map(normalisiereAssetPfad)];
  } else {
    const tage = opts.aelterAlsTage ?? getAssetKonfiguration().sync.restoreWindowMs / (24 * 60 * 60 * 1000);
    if (!Number.isFinite(tage) || tage < 0) throw new Error(`asset-intel: aelterAlsTage ungueltig: ${tage}`);
    sql = `WITH d AS (
             DELETE FROM asset_files
              WHERE project = $1 AND status = 'quelle_nicht_gefunden'
                AND quelle_fehlt_seit < NOW() - make_interval(secs => $2::double precision)
             RETURNING 1)
           SELECT count(*)::int AS n FROM d`;
    params = [project, tage * 86400];
  }
  const z = await eineAnweisung<{ n: number }>(sql, params);
  return z[0]?.n ?? 0;
}

/** Sucht eine fehlende Zeile mit gleichem sha256 (Umbenennungs-Kandidat); null wenn keine. */
export async function findeVerschobenesAsset(project: string, sha256: string): Promise<string | null> {
  const z = await eineAnweisung<{ file_path: string }>(
    `SELECT file_path FROM asset_files
      WHERE project = $1 AND sha256 = $2 AND status = 'quelle_nicht_gefunden'
      ORDER BY quelle_fehlt_seit DESC NULLS LAST, id DESC LIMIT 1`,
    [project, sha256]
  );
  return z[0]?.file_path ?? null;
}
