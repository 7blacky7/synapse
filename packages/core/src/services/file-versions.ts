/**
 * MODUL: File-Versionierung
 *
 * ZWECK: Liefert Versionshistorie aus `file_versions` und stellt einzelne
 *        Versionen oder ganze Multi-File-Batches wieder her. Restore ist
 *        nicht-destruktiv — es schreibt die alte Version als neuen Stand,
 *        wodurch gleichzeitig eine neue Version (`edit_action: "restore"`)
 *        entsteht. So bleibt die Historie linear nachvollziehbar.
 *
 * BEFUELLUNG: Die Tabelle wird transparent von `updateFileInPg` befuellt
 *        (siehe code-write.ts). Snapshots laufen in derselben TX wie der
 *        Write — Race-Condition-frei.
 */

import { getPool } from '../db/client.js';
import { updateFileInPg } from './code-write.js';

export interface FileVersionMeta {
  id: string;          // BIGSERIAL als String (JS Number-Limit)
  project: string;
  file_path: string;
  content_hash: string;
  edit_action: string | null;
  agent_id: string | null;
  batch_id: string | null;
  size_bytes: number;
  created_at: string;
}

export interface FileVersionFull extends FileVersionMeta {
  content: string;
}

/**
 * Listet die Versionshistorie einer Datei (neueste zuerst).
 * Standard: 50 Eintraege ohne `content` (Metadata only) — fuer Listings im UI.
 */
export async function listFileVersions(
  project: string,
  filePath: string,
  limit = 50
): Promise<FileVersionMeta[]> {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    project: string;
    file_path: string;
    content_hash: string;
    edit_action: string | null;
    agent_id: string | null;
    batch_id: string | null;
    size_bytes: number;
    created_at: string;
  }>(
    `SELECT id::text AS id, project, file_path, content_hash, edit_action, agent_id,
            batch_id::text AS batch_id, size_bytes, created_at::text AS created_at
     FROM file_versions
     WHERE project = $1 AND file_path = $2
     ORDER BY created_at DESC, id DESC
     LIMIT $3`,
    [project, filePath, safeLimit]
  );
  return result.rows;
}

/** Liefert eine konkrete Version inklusive `content`. */
export async function getFileVersion(
  versionId: string | number
): Promise<FileVersionFull | null> {
  const pool = getPool();
  const result = await pool.query<FileVersionFull>(
    `SELECT id::text AS id, project, file_path, content, content_hash,
            edit_action, agent_id, batch_id::text AS batch_id,
            size_bytes, created_at::text AS created_at
     FROM file_versions
     WHERE id = $1`,
    [versionId]
  );
  return result.rows[0] ?? null;
}

/**
 * Stellt eine alte Version als aktuellen Stand wieder her.
 * Nicht-destruktiv: der vorherige Stand wird automatisch durch
 * `updateFileInPg` als neue Version mit `edit_action: "restore"`
 * gesnapshottet.
 */
export async function restoreFileVersion(
  versionId: string | number,
  agentId?: string
): Promise<{ project: string; file_path: string; restored_from: string }> {
  const version = await getFileVersion(versionId);
  if (!version) {
    throw new Error(`Version ${versionId} nicht gefunden.`);
  }
  await updateFileInPg(
    version.project,
    version.file_path,
    version.content,
    agentId,
    `restore:${version.id}`
  );
  return {
    project: version.project,
    file_path: version.file_path,
    restored_from: version.id,
  };
}

/**
 * Liefert alle Versionen, die zu einer Multi-File-Batch gehoeren
 * (relevant ab Schritt 2 — Multi-File-Plan/Commit).
 */
export async function listBatchVersions(
  batchId: string | number
): Promise<FileVersionMeta[]> {
  const pool = getPool();
  const result = await pool.query<FileVersionMeta>(
    `SELECT id::text AS id, project, file_path, content_hash, edit_action, agent_id,
            batch_id::text AS batch_id, size_bytes, created_at::text AS created_at
     FROM file_versions
     WHERE batch_id = $1
     ORDER BY created_at ASC, id ASC`,
    [batchId]
  );
  return result.rows;
}

/**
 * Rollt eine ganze Multi-File-Batch zurueck — fuer jede betroffene Datei wird
 * der zuletzt vor der Batch geschriebene Stand wiederhergestellt. Gibt eine
 * Zusammenfassung pro Datei zurueck.
 */
export async function restoreBatch(
  batchId: string | number,
  agentId?: string
): Promise<Array<{ project: string; file_path: string; restored_from: string }>> {
  const versions = await listBatchVersions(batchId);
  if (versions.length === 0) {
    throw new Error(`Keine Versionen fuer Batch ${batchId} gefunden.`);
  }
  const out: Array<{ project: string; file_path: string; restored_from: string }> = [];
  for (const v of versions) {
    const r = await restoreFileVersion(v.id, agentId);
    out.push(r);
  }
  return out;
}
