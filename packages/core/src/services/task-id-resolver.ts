/** Task-Referenzen projektgebunden aus PostgreSQL aufloesen; ohne Schreib- oder Embedding-Nebenwirkung. */
import { getPool } from '../db/client.js';

export async function resolveProjectTaskId(project: string, ref: string): Promise<string> {
  const normalized = ref.trim();
  if (!normalized) throw new Error('task_id darf nicht leer sein');
  const result = await getPool().query<{ id: string }>(
    `SELECT task->>'id' AS id
       FROM plans p
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.tasks, '[]'::jsonb)) task
      WHERE p.project = $1
        AND (task->>'id' = $2 OR upper(task->>'kurz_id') = upper($2)
          OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(task->'alias_kurz_ids', '[]'::jsonb)) alias(ref)
                      WHERE upper(alias.ref) = upper($2)))
      ORDER BY p.created_at, p.id LIMIT 1`,
    [project, normalized],
  );
  if (result.rows[0]?.id) return result.rows[0].id;
  throw new Error(`Task ${normalized} nicht gefunden in Projekt ${project}`);
}
