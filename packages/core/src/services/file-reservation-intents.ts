/** P6-T48: Arbeitsabsichten ohne anwendbaren offenen Plan, ausschließlich SELECT. */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';

export interface PlanloseReservierung {
  file_path: string;
  reserviert_von: string;
  /** Alte Reservierungen ohne Task-Metadaten bleiben ausdrücklich unbekannt. */
  task_id: string | null;
  seit: string;
  expires_at: string;
}
export async function lesePlanloseReservierungen(
  project: string,
  filePaths?: readonly string[],
  client: { query: PoolClient['query'] } = getPool(),
): Promise<PlanloseReservierung[]> {
  const rows = (await client.query<{
    file_path: string; reserviert_von: string; task_id: string | null;
    seit: Date | string; expires_at: Date | string;
  }>(
    `SELECT r.file_path, r.agent_id AS reserviert_von,
            (SELECT o->>'task_id' FROM file_batch_plans t, jsonb_array_elements(t.ops) o
              WHERE t.id = r.plan_id AND t.project = r.project AND o->>'file_path' = r.file_path
                AND o->>'task_id' IS NOT NULL LIMIT 1) AS task_id,
            r.reserved_at AS seit, r.expires_at
       FROM file_reservations r
      WHERE r.project = $1 AND r.released_at IS NULL AND r.expires_at > NOW()
        AND ($2::text[] IS NULL OR r.file_path = ANY($2::text[]))
        AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.id = r.agent_id AND s.status <> 'active')
        AND NOT EXISTS (
          SELECT 1 FROM file_batch_plans p
           WHERE p.project = r.project AND p.owner_agent_id = r.agent_id AND p.status = 'open'
             AND p.open_for_coedit = true AND jsonb_array_length(p.ops) > 0
             AND NOT (p.previews @> '[{"ok": false}]'::jsonb)
             AND (p.expected_hashes ? r.file_path OR EXISTS (
               SELECT 1 FROM jsonb_array_elements(p.ops) o
                WHERE o->>'file_path' = r.file_path OR o->>'new_path' = r.file_path)))
      ORDER BY r.file_path, r.reserved_at, r.id`,
    [project, filePaths ? [...filePaths] : null],
  )).rows;
  const iso = (v: Date | string) => v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  return rows.map(r => ({ ...r, seit: iso(r.seit), expires_at: iso(r.expires_at) }));
}
