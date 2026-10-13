/**
 * MODUL: Asset-Projektoptionen (P13-T22/A4)
 * ZWECK: Nullable Projekt-Overrides aus A2 laden/schreiben und policy_revision atomar pflegen.
 * NULL bleibt Vererbung der validierten Betreiber-Konfiguration.
 */
import { getPool } from '../db/client.js';
import {
  getAssetKonfiguration,
  loeseAssetProjektoptionen,
  type AssetProjektOptionen,
  type WirksameAssetProjektoptionen,
} from '../config/asset-konfig.js';

export type PersistierteAssetProjektoptionen = Pick<
  AssetProjektOptionen,
  'richtung' | 'restoreWindowMs' | 'maxDateiBytes' | 'maxProjektBytes' | 'maxProjektDateien' | 'erlaubteTypen'
>;

export interface AssetProjektOptionenEintrag {
  project: string;
  optionen: PersistierteAssetProjektoptionen;
  wirksam: WirksameAssetProjektoptionen;
  policyRevision: number;
  updatedAt: Date;
}

interface AssetProjektOptionenZeile {
  project: string;
  richtung: string | null;
  loeschfenster_ms: string | number | null;
  max_datei_bytes: string | number | null;
  max_projekt_bytes: string | number | null;
  max_projekt_dateien: string | number | null;
  erlaubte_typen: string[] | null;
  policy_revision: string | number;
  updated_at: Date | string;
}

const SPALTEN = [
  'project',
  'richtung',
  'loeschfenster_ms',
  'max_datei_bytes',
  'max_projekt_bytes',
  'max_projekt_dateien',
  'erlaubte_typen',
  'policy_revision',
  'updated_at',
].join(', ');

function projektName(project: string): string {
  if (typeof project !== 'string' || project.trim() === '') {
    throw new Error('Asset-Projektoptionen: project muss ein nichtleerer Name sein');
  }
  if (project !== project.trim()) {
    throw new Error('Asset-Projektoptionen: project darf keine umgebenden Leerzeichen enthalten');
  }
  return project;
}

function dbZahl(wert: string | number | null, name: string): number | undefined {
  if (wert === null) return undefined;
  const zahl = typeof wert === 'number' ? wert : Number(wert);
  if (!Number.isSafeInteger(zahl) || zahl < 0) {
    throw new Error(`Asset-Projektoptionen: ungültiger DB-Wert für ${name}`);
  }
  return zahl;
}

function optionenAusZeile(zeile: AssetProjektOptionenZeile): PersistierteAssetProjektoptionen {
  const optionen: PersistierteAssetProjektoptionen = {};
  if (zeile.richtung !== null) {
    if (!['both', 'pc_to_share', 'share_to_pc'].includes(zeile.richtung)) {
      throw new Error('Asset-Projektoptionen: ungültiger DB-Wert für richtung');
    }
    optionen.richtung = zeile.richtung as PersistierteAssetProjektoptionen['richtung'];
  }
  const restoreWindowMs = dbZahl(zeile.loeschfenster_ms, 'loeschfenster_ms');
  const maxDateiBytes = dbZahl(zeile.max_datei_bytes, 'max_datei_bytes');
  const maxProjektBytes = dbZahl(zeile.max_projekt_bytes, 'max_projekt_bytes');
  const maxProjektDateien = dbZahl(zeile.max_projekt_dateien, 'max_projekt_dateien');
  if (restoreWindowMs !== undefined) optionen.restoreWindowMs = restoreWindowMs;
  if (maxDateiBytes !== undefined) optionen.maxDateiBytes = maxDateiBytes;
  if (maxProjektBytes !== undefined) optionen.maxProjektBytes = maxProjektBytes;
  if (maxProjektDateien !== undefined) optionen.maxProjektDateien = maxProjektDateien;
  if (zeile.erlaubte_typen !== null) {
    if (!Array.isArray(zeile.erlaubte_typen) || zeile.erlaubte_typen.some(t => typeof t !== 'string')) {
      throw new Error('Asset-Projektoptionen: ungültiger DB-Wert für erlaubte_typen');
    }
    optionen.erlaubteTypen = zeile.erlaubte_typen;
  }
  return optionen;
}

function ausZeile(zeile: AssetProjektOptionenZeile): AssetProjektOptionenEintrag {
  const optionen = optionenAusZeile(zeile);
  const policyRevision = dbZahl(zeile.policy_revision, 'policy_revision');
  if (policyRevision === undefined) throw new Error('Asset-Projektoptionen: policy_revision fehlt');
  const updatedAt = zeile.updated_at instanceof Date ? zeile.updated_at : new Date(zeile.updated_at);
  if (Number.isNaN(updatedAt.getTime())) throw new Error('Asset-Projektoptionen: updated_at ist ungültig');
  return {
    project: zeile.project,
    optionen,
    wirksam: loeseAssetProjektoptionen(getAssetKonfiguration(), optionen),
    policyRevision,
    updatedAt,
  };
}

export async function ladeAssetProjektoptionen(project: string): Promise<AssetProjektOptionenEintrag | null> {
  const name = projektName(project);
  const result = await getPool().query<AssetProjektOptionenZeile>(
    'SELECT ' + SPALTEN + ' FROM asset_projekt_optionen WHERE project = $1',
    [name],
  );
  return result.rows[0] ? ausZeile(result.rows[0]) : null;
}

/**
 * Ersetzt die vollständige Menge gespeicherter Overrides. Nicht gesetzte Felder bleiben NULL
 * und erben dadurch den Betreiberwert. Ein idempotenter Schreibaufruf erhöht die Revision nicht.
 */
export async function setzeAssetProjektoptionen(
  project: string,
  optionen: PersistierteAssetProjektoptionen,
): Promise<AssetProjektOptionenEintrag> {
  const name = projektName(project);
  const konfig = getAssetKonfiguration();
  const wirksam = loeseAssetProjektoptionen(konfig, optionen);
  if (wirksam.maxProjektBytes < wirksam.maxDateiBytes) {
    throw new Error('Asset-Projektoptionen maxProjektBytes muss mindestens maxDateiBytes entsprechen');
  }

  const gespeichert: PersistierteAssetProjektoptionen = {};
  if (optionen.richtung !== undefined) gespeichert.richtung = optionen.richtung;
  if (optionen.restoreWindowMs !== undefined) gespeichert.restoreWindowMs = optionen.restoreWindowMs;
  if (optionen.maxDateiBytes !== undefined) gespeichert.maxDateiBytes = optionen.maxDateiBytes;
  if (optionen.maxProjektBytes !== undefined) gespeichert.maxProjektBytes = optionen.maxProjektBytes;
  if (optionen.maxProjektDateien !== undefined) gespeichert.maxProjektDateien = optionen.maxProjektDateien;
  if (optionen.erlaubteTypen !== undefined) gespeichert.erlaubteTypen = wirksam.erlaubteTypen;

  const result = await getPool().query<AssetProjektOptionenZeile>(
    [
      'INSERT INTO asset_projekt_optionen',
      '(project, richtung, loeschfenster_ms, max_datei_bytes, max_projekt_bytes, max_projekt_dateien, erlaubte_typen, policy_revision, updated_at)',
      'VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NOW())',
      'ON CONFLICT (project) DO UPDATE SET',
      'richtung = EXCLUDED.richtung,',
      'loeschfenster_ms = EXCLUDED.loeschfenster_ms,',
      'max_datei_bytes = EXCLUDED.max_datei_bytes,',
      'max_projekt_bytes = EXCLUDED.max_projekt_bytes,',
      'max_projekt_dateien = EXCLUDED.max_projekt_dateien,',
      'erlaubte_typen = EXCLUDED.erlaubte_typen,',
      'policy_revision = asset_projekt_optionen.policy_revision + 1,',
      'updated_at = NOW()',
      'WHERE (asset_projekt_optionen.richtung, asset_projekt_optionen.loeschfenster_ms, asset_projekt_optionen.max_datei_bytes, asset_projekt_optionen.max_projekt_bytes, asset_projekt_optionen.max_projekt_dateien, asset_projekt_optionen.erlaubte_typen)',
      'IS DISTINCT FROM',
      '(EXCLUDED.richtung, EXCLUDED.loeschfenster_ms, EXCLUDED.max_datei_bytes, EXCLUDED.max_projekt_bytes, EXCLUDED.max_projekt_dateien, EXCLUDED.erlaubte_typen)',
      'RETURNING ' + SPALTEN,
    ].join(' '),
    [
      name,
      gespeichert.richtung ?? null,
      gespeichert.restoreWindowMs ?? null,
      gespeichert.maxDateiBytes ?? null,
      gespeichert.maxProjektBytes ?? null,
      gespeichert.maxProjektDateien ?? null,
      gespeichert.erlaubteTypen ?? null,
    ],
  );
  if (result.rows[0]) return ausZeile(result.rows[0]);

  const current = await getPool().query<AssetProjektOptionenZeile>(
    'SELECT ' + SPALTEN + ' FROM asset_projekt_optionen WHERE project = $1',
    [name],
  );
  if (!current.rows[0]) {
    throw new Error('Asset-Projektoptionen: Zeile nach idempotentem Upsert nicht gefunden');
  }
  return ausZeile(current.rows[0]);
}
