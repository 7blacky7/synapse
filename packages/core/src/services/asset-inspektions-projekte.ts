/** A12: Persistente Writer-Zuordnung; A8 setzt asset_sync vor dem ersten Transfer. */
import { getPool } from '../db/client.js';

export const ASSET_LOKAL_ERLAUBT_SQL = `NOT EXISTS (SELECT 1 FROM asset_inspektions_projekte p WHERE p.project=$1 AND p.modus='asset_sync')
 AND NOT EXISTS (SELECT 1 FROM asset_files a WHERE a.project=$1 AND (a.transport_revision IS NOT NULL OR a.storage_key IS NOT NULL))`;

export async function assetProjektNutztShare(project: string): Promise<boolean> {
  try {
    const r = await getPool().query(`SELECT NOT (${ASSET_LOKAL_ERLAUBT_SQL}) AS share`, [project]);
    return r.rows[0]?.share === true;
  } catch (e) {
    if ((e as {code?:string}).code === '42P01') {
      // Alte Clients vor A12: bereits transportgebundene Zeilen sind trotzdem Share-Eigentum.
      const r = await getPool().query('SELECT EXISTS (SELECT 1 FROM asset_files WHERE project=$1 AND (transport_revision IS NOT NULL OR storage_key IS NOT NULL)) AS share', [project]);
      return r.rows[0]?.share === true;
    }
    throw e;
  }
}

/** Rückkehr zu Legacy erst nach expliziter Entfernung sämtlicher Transportbindungen. */
export async function setzeAssetInspektionsModus(project: string, modus: 'legacy_local' | 'asset_sync'): Promise<void> {
  if (!project.trim() || !['legacy_local','asset_sync'].includes(modus)) throw new TypeError('Ungültiger Asset-Inspektionsmodus');
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['asset-inspektion:'+project]);
    const vorhanden = await c.query('SELECT 1 FROM projects WHERE name=$1', [project]);
    if (!vorhanden.rowCount) throw new Error('Projekt nicht registriert');
    if (modus === 'legacy_local') {
      const r = await c.query('SELECT 1 FROM asset_files WHERE project=$1 AND (transport_revision IS NOT NULL OR storage_key IS NOT NULL) LIMIT 1', [project]);
      if (r.rowCount) throw new Error('Transportgebundene Assets verhindern lokalen Zweitschreiber');
    }
    await c.query(`INSERT INTO asset_inspektions_projekte(project,modus) VALUES($1,$2)
      ON CONFLICT(project) DO UPDATE SET modus=EXCLUDED.modus,updated_at=clock_timestamp()`, [project,modus]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
