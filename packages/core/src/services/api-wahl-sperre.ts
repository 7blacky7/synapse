/**
 * P22-T202 P1 (Abnahme d317829a): gemeinsame CLI/API-Grenze je Identitaet als Blattmodul (keine Importzyklen:
 * hauptagent-dienst und runtime-auftraege-ausfuehrung importieren hier, api-agent-auswahl re-exportiert).
 * EINE Sperre je Identitaet: pg_advisory_xact_lock(hashtextextended('api-lauf-wahl:'||id,0)). Sie teilen sich
 *   - die API-Laufwahl (starteApiAuswahl/beendeApiAuswahl, rest-api),
 *   - CLI-Spezialistenstarts (mitCliStartSperre),
 *   - Runtime-Auftraege anlegen (legeRuntimeAuftragAn) und claimen (claimeRuntimeAuftraege).
 * Unter der Sperre gilt: Identitaet als API gewaehlt (startrezept.api_lauf_wahl.laufart='api', jede Phase) oder laufende
 * API-Lease -> kein CLI-Neustart/-Wechsel. Umgekehrt sieht die API-Wahl unter derselben Sperre offene Runtime-Auftraege.
 * P22-T278 P2-2 (Abnahme 1dbf6af2): dieselbe Sperre gilt auch fuer spawneAlsApiLauf (MCP specialist spawn mit API-Modell):
 *   offeneCliStarts (gemeinsam mit der Laufwahl) und aktiveApiLaeufe (CLI-Start neben einem API-Lauf ohne Wahl).
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

/**
 * P22-T278 P2-2: offene CLI-Starts einer Identitaet unter der Sperre (Spawn-Job pending/running bzw. offener Runtime-Auftrag).
 * Gemeinsam fuer die API-Laufwahl (rest-api starteApiAuswahl) und spawneAlsApiLauf. Rueckgabe: Fehlercode oder null.
 */
export async function offeneCliStarts(db: PoolClient, id: string, project: string, name: string): Promise<'cli_start_offen' | 'wechsel_offen' | null> {
  const r = await db.query(`SELECT id FROM specialist_jobs WHERE project=$2 AND status IN ('pending','running')
    AND action IN ('spawn','spawn_batch') AND (target_identity_id=$1 OR args->>'identity_id'=$1 OR args->>'name' IN ($3,'identity:' || $1)
      OR action='spawn_batch' AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(args->'specialists','[]'::jsonb)) s
        WHERE s->>'identity_id'=$1 OR s->>'name' IN ($3,'identity:' || $1))) LIMIT 1`, [id, project, name]);
  if (r.rows.length) return 'cli_start_offen';
  const main = await db.query("SELECT id FROM agent_runtime_auftraege WHERE identity_id=$1 AND status IN ('pending','claimed','accepted') LIMIT 1", [id]);
  return main.rows.length ? 'wechsel_offen' : null;
}

/**
 * P22-T278: laufende bzw. idle CLI-Wrapper einer Identitaet (Identitaets-Zeilen; Legacy-Zeilen nach Name). Gemeinsam fuer
 * spawneAlsApiLauf und steuereApiLauf 'fortsetzen'. Dynamischer Import: das Blattmodul bleibt ohne statische Abhaengigkeit.
 */
export async function laufendeCliWrapper(project: string, id: string, name: string): Promise<number> {
  const { listWrapperStatus } = await import('./wrapper-status.js');
  return (await listWrapperStatus(project)).filter(a => (a.identityId ? a.identityId === id : a.agentName === name)
    && ['running', 'idle'].includes(a.status ?? '')).length;
}

/**
 * P22-T278 P2-2: API-Laeufe, neben denen kein CLI-Start derselben Identitaet erlaubt ist: Nicht-Main-Lauf 'bereit'/'laeuft' (der Takt
 * startet dort von selbst Turns) oder gueltige Lease (Turn laeuft, auch beim Main). Gestoppt/pausiert/fehler und Rueckfall: frei.
 */
export async function aktiveApiLaeufe(db: PoolClient, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const da = await db.query<{ da: boolean }>("SELECT to_regclass('api_agent_laeufe') IS NOT NULL AS da");
  if (!da.rows[0]?.da) return [];
  const r = await db.query<{ id: string }>(
    `SELECT identity_id::text AS id FROM api_agent_laeufe WHERE identity_id::text = ANY($1::text[])
        AND ((rolle <> 'main' AND status IN ('bereit','laeuft')) OR (lease_token IS NOT NULL AND lease_bis > NOW()))`, [ids]);
  return r.rows.map(z => z.id);
}
