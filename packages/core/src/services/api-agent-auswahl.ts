/**
 * P22-T202, Entwurf 90467652: explizite CLI/API-Wahl je bestehender Identitaet.
 * PG startrezept.api_lauf_wahl ist die einzige Wahlquelle. Kein Budget-/Freigabe-Schreibweg.
 * Wechsel und CLI-Queue teilen einen Advisory-Lock, auch ueber API-Prozessgrenzen.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { ProfilVerwaltungFehler } from './agent-profil-verwalter.js';

export const API_AUSWAHL_FUNKTION = 'api_agenten_auswahl' as const;
export interface ApiLaufWahl {
  laufart: 'api'; modell: string; anbieter: string; phase: 'wechsel' | 'aktiv' | 'fehler';
  grund: string; wer: string; am: string; fehler?: string;
  idempotenz_schluessel?: string; auftrag_hash?: string; eingang_id?: number;
}
export async function leseApiAuswahlSchalter(project: string | null) {
  const produkt = await leseProfilProduktSchalter(API_AUSWAHL_FUNKTION, project);
  if (process.env.SYNAPSE_INTERN_TOOL === '1') {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date }>(
        "SELECT aktiv,bis FROM intern_schalter WHERE name=$1 AND modus='freigegeben' AND bis > NOW()", [API_AUSWAHL_FUNKTION]);
      if (r.rows[0]) return { ...produkt, aktiv: r.rows[0].aktiv, quelle: 'intern', bis: r.rows[0].bis.toISOString(), letzter_fehler: null };
    } catch { /* Produktstandard; kein unbefristeter Override bei Ausfall. */ }
  }
  return { ...produkt, aktiv: produkt.aktiv && !produkt.letzter_fehler, bis: null };
}
export async function leseApiLaufWahl(identityId: string): Promise<ApiLaufWahl | null> {
  const r = await getPool().query<{ w: ApiLaufWahl | null }>(
    "SELECT startrezept->'api_lauf_wahl' AS w FROM agent_identitaeten WHERE id=$1", [identityId]);
  return r.rows[0]?.w ?? null;
}
export async function mitApiWahlSperre<T>(ids: string[], arbeit: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    for (const id of [...new Set(ids)].sort())
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('api-lauf-wahl:' || $1,0))", [id]);
    const r = await arbeit(db);
    await db.query('COMMIT');
    return r;
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}
export async function schreibeApiLaufWahl(db: PoolClient, id: string, w: ApiLaufWahl | null): Promise<void> {
  await db.query(`UPDATE agent_identitaeten SET startrezept = CASE WHEN $2::jsonb IS NULL
    THEN COALESCE(startrezept,'{}'::jsonb) - 'api_lauf_wahl'
    ELSE jsonb_set(COALESCE(startrezept,'{}'::jsonb),'{api_lauf_wahl}',$2::jsonb) END WHERE id=$1`,
    [id, w ? JSON.stringify(w) : null]);
}
/** Auch Name und spawn_batch absichern. Bereits eingereihte Starts blockieren den Wechsel an dessen Eintritt. */
export async function mitCliStartSperre<T>(project: string, action: string, args: Record<string, unknown>, arbeit: () => Promise<T>): Promise<T> {
  if (action !== 'spawn' && action !== 'spawn_batch') return arbeit();
  const teile = action === 'spawn_batch' && Array.isArray(args.specialists) ? args.specialists as Record<string, unknown>[] : [args];
  const ids = teile.map(t => typeof t.identity_id === 'string' ? t.identity_id : typeof t.name === 'string' && t.name.startsWith('identity:') ? t.name.slice(9) : '').filter(Boolean);
  const namen = teile.map(t => typeof t.name === 'string' ? t.name : '').filter(Boolean);
  const r = await getPool().query<{ id: string }>(
    'SELECT id::text AS id FROM agent_identitaeten WHERE project=$1 AND (id::text=ANY($2::text[]) OR agent_id=ANY($3::text[]))',
    [project, ids, namen]);
  if (!r.rows.length) return arbeit();
  return mitApiWahlSperre(r.rows.map(z => z.id), async db => {
    const aktiv = await db.query<{ id: string }>(`SELECT id FROM agent_identitaeten WHERE id=ANY($1::text[])
      AND startrezept->'api_lauf_wahl'->>'laufart'='api'`, [r.rows.map(z => z.id)]);
    if (aktiv.rows.length) throw new ProfilVerwaltungFehler('api_lauf_gewaehlt', {
      identity_ids: aktiv.rows.map(z => z.id), hinweis: 'API-Lauf erst kontrolliert ueber die Laufwahl beenden.' });
    return arbeit();
  });
}
