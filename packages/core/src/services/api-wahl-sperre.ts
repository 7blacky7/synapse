/**
 * P22-T202 P1 (Abnahme d317829a): gemeinsame CLI/API-Grenze je Identitaet als Blattmodul (keine Importzyklen:
 * hauptagent-dienst und runtime-auftraege-ausfuehrung importieren hier, api-agent-auswahl re-exportiert).
 * EINE Sperre je Identitaet: pg_advisory_xact_lock(hashtextextended('api-lauf-wahl:'||id,0)). Sie teilen sich
 *   - die API-Laufwahl (starteApiAuswahl/beendeApiAuswahl, rest-api),
 *   - CLI-Spezialistenstarts (mitCliStartSperre),
 *   - Runtime-Auftraege anlegen (legeRuntimeAuftragAn) und claimen (claimeRuntimeAuftraege).
 * Unter der Sperre gilt: Identitaet als API gewaehlt (startrezept.api_lauf_wahl.laufart='api', jede Phase) oder laufende
 * API-Lease -> kein CLI-Neustart/-Wechsel. Umgekehrt sieht die API-Wahl unter derselben Sperre offene Runtime-Auftraege.
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';

const SCHLUESSEL = "hashtextextended('api-lauf-wahl:' || $1, 0)";

export async function mitApiWahlSperre<T>(ids: string[], arbeit: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await getPool().connect();
  try {
    await db.query('BEGIN');
    for (const id of [...new Set(ids)].sort())
      await db.query(`SELECT pg_advisory_xact_lock(${SCHLUESSEL})`, [id]);
    const r = await arbeit(db);
    await db.query('COMMIT');
    return r;
  } catch (e) { await db.query('ROLLBACK'); throw e; }
  finally { db.release(); }
}

/** Nicht blockierend (Claim des Runtime-Daemons): false = ein Wechsel/Anlegen haelt die Identitaet gerade; naechster Abruf. */
export async function versucheApiWahlSperre(db: PoolClient, id: string): Promise<boolean> {
  const r = await db.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock(${SCHLUESSEL}) AS ok`, [id]);
  return r.rows[0]?.ok === true;
}

export type ApiBelegung = 'api_lauf_gewaehlt' | 'api_lease_aktiv';

/** Unter der Sperre lesen: welche der Identitaeten sind API-belegt (gewaehlte Laufart api oder laufende API-Lease)? */
export async function apiBelegteIdentitaeten(db: PoolClient, ids: string[]): Promise<Map<string, ApiBelegung>> {
  const belegt = new Map<string, ApiBelegung>();
  if (!ids.length) return belegt;
  const w = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM agent_identitaeten WHERE id::text = ANY($1::text[]) AND startrezept->'api_lauf_wahl'->>'laufart' = 'api'`, [ids]);
  for (const z of w.rows) belegt.set(z.id, 'api_lauf_gewaehlt');
  // api_agent_laeufe legt die API (T183) an; in Teil-Schemata (Tests, alte Stände) fehlt sie -> nur die Wahl zaehlt.
  const da = await db.query<{ da: boolean }>("SELECT to_regclass('api_agent_laeufe') IS NOT NULL AS da");
  if (da.rows[0]?.da) {
    const l = await db.query<{ id: string }>(
      `SELECT identity_id::text AS id FROM api_agent_laeufe
        WHERE identity_id::text = ANY($1::text[]) AND lease_token IS NOT NULL AND lease_bis > NOW()`, [ids]);
    for (const z of l.rows) if (!belegt.has(z.id)) belegt.set(z.id, 'api_lease_aktiv');
  }
  return belegt;
}

/** Runtime-Auftragsarten, die trotz API-Belegung erlaubt bleiben: stop beendet nur einen (verwaisten) CLI-Wrapper, startet nichts. */
export const OHNE_API_SPERRE_ARTEN: readonly string[] = ['stop'];
