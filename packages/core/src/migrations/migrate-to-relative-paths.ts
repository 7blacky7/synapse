/**
 * Migration: Absolute Pfade → Relative Pfade in code_files + code_symbols + code_references + code_chunks
 *
 * Voraussetzung: projects-Tabelle existiert und hat Eintraege.
 * Logik: Fuer jedes Projekt den Root aus projects.path holen,
 *        dann file_path in allen Tabellen kuerzen.
 */

import { getPool } from '../db/client.js';
import { getQdrantClient } from '../qdrant/client.js';
import { COLLECTIONS } from '../types/index.js';
import { collectionExists } from '../qdrant/collections.js';

export async function migrateToRelativePaths(): Promise<{
  projects: number;
  filesUpdated: number;
  symbolsUpdated: number;
  refsUpdated: number;
  chunksUpdated: number;
  skipped: number;
  qdrantPointsRewritten: number;
  qdrantPointsDropped: number;
}> {
  const pool = getPool();
  let filesUpdated = 0, symbolsUpdated = 0, refsUpdated = 0, chunksUpdated = 0, skipped = 0;

  // Alle registrierten Projekte holen
  const projects = await pool.query<{ name: string; path: string }>(
    `SELECT DISTINCT ON (name) name, path FROM projects ORDER BY name, last_access DESC`
  );

  for (const proj of projects.rows) {
    const root = proj.path.endsWith('/') ? proj.path : proj.path + '/';

    // Nur Dateien die noch absolute Pfade haben (starten mit /)
    const absFiles = await pool.query<{ file_path: string }>(
      `SELECT file_path FROM code_files WHERE project = $1 AND file_path LIKE '/%'`,
      [proj.name]
    );

    if (absFiles.rows.length === 0) {
      skipped++;
      continue;
    }

    // FK Constraints temporaer deferred setzen (Schema hat DEFERRABLE INITIALLY DEFERRED)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');

      for (const row of absFiles.rows) {
        const oldPath: string = row.file_path;
        if (!oldPath.startsWith(root)) {
          console.error(`[Migration] Pfad passt nicht zum Root: ${oldPath} (Root: ${root})`);
          skipped++;
          continue;
        }
        const newPath = oldPath.substring(root.length);

        // Pruefen ob relative Version schon existiert (Duplikat-Vermeidung)
        const existing = await client.query(
          `SELECT 1 FROM code_files WHERE project = $1 AND file_path = $2`,
          [proj.name, newPath]
        );
        if (existing.rows.length > 0) {
          // Duplikat: absolute Version loeschen (relative ist neuer/korrekt)
          await client.query(
            `DELETE FROM code_chunks WHERE project = $1 AND file_path = $2`, [proj.name, oldPath]
          );
          await client.query(
            `DELETE FROM code_references WHERE project = $1 AND file_path = $2`, [proj.name, oldPath]
          );
          await client.query(
            `DELETE FROM code_symbols WHERE project = $1 AND file_path = $2`, [proj.name, oldPath]
          );
          await client.query(
            `DELETE FROM code_files WHERE project = $1 AND file_path = $2`, [proj.name, oldPath]
          );
          skipped++;
          continue;
        }

        // Reihenfolge: erst abhaengige Tabellen, dann code_files
        const r1 = await client.query(
          `UPDATE code_symbols SET file_path = $3 WHERE project = $1 AND file_path = $2`,
          [proj.name, oldPath, newPath]
        );
        symbolsUpdated += r1.rowCount ?? 0;

        const r2 = await client.query(
          `UPDATE code_references SET file_path = $3 WHERE project = $1 AND file_path = $2`,
          [proj.name, oldPath, newPath]
        );
        refsUpdated += r2.rowCount ?? 0;

        const r3 = await client.query(
          `UPDATE code_chunks SET file_path = $3 WHERE project = $1 AND file_path = $2`,
          [proj.name, oldPath, newPath]
        );
        chunksUpdated += r3.rowCount ?? 0;

        const r4 = await client.query(
          `UPDATE code_files SET file_path = $3 WHERE project = $1 AND file_path = $2`,
          [proj.name, oldPath, newPath]
        );
        filesUpdated += r4.rowCount ?? 0;
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // === Qdrant-Path-Normalisierung ===
  // Nach der PG-Migration auch Qdrant-Points normalisieren:
  // - Wenn file_path absolut UND relativ-Pendant existiert: drop absolut.
  // - Wenn nur absolut: re-write to relative (setPayload).
  let qdrantPointsRewritten = 0;
  let qdrantPointsDropped = 0;
  for (const proj of projects.rows) {
    const root = proj.path.endsWith('/') ? proj.path : proj.path + '/';
    const collections = [
      COLLECTIONS.projectCode(proj.name),
      COLLECTIONS.projectDocs(proj.name),
    ];
    for (const collection of collections) {
      try {
        if (!(await collectionExists(collection))) continue;
        const result = await normalizeQdrantPathsForCollection(collection, proj.path, root);
        qdrantPointsRewritten += result.rewritten;
        qdrantPointsDropped += result.dropped;
      } catch (err) {
        console.error(`[Migration] Qdrant-Normalisierung fuer ${collection} fehlgeschlagen:`, err);
      }
    }
  }

  return {
    projects: projects.rows.length,
    filesUpdated,
    symbolsUpdated,
    refsUpdated,
    chunksUpdated,
    skipped,
    qdrantPointsRewritten,
    qdrantPointsDropped,
  };
}

/**
 * Scrollt eine Qdrant-Collection und normalisiert absolute file_path-Eintraege.
 * - Wenn ein relatives Pendant existiert: absoluter Punkt wird gedroppt.
 * - Sonst: file_path wird auf den relativen Pfad umgeschrieben (setPayload).
 */
async function normalizeQdrantPathsForCollection(
  collection: string,
  projectRoot: string,
  rootSlash: string
): Promise<{ rewritten: number; dropped: number }> {
  const client = getQdrantClient();
  let rewritten = 0;
  let dropped = 0;

  type Pt = { id: string | number; payload: { file_path?: string } | null };
  const allPoints: Pt[] = [];
  let offset: string | number | undefined = undefined;
  const PAGE = 1000;
  for (;;) {
    const page: { points: Pt[]; next_page_offset?: string | number | null } =
      (await client.scroll(collection, {
        limit: PAGE,
        with_payload: true,
        offset,
      })) as any;
    allPoints.push(...page.points);
    if (!page.next_page_offset) break;
    offset = page.next_page_offset;
  }

  const relativePaths = new Set<string>();
  for (const p of allPoints) {
    const fp = p.payload?.file_path;
    if (typeof fp === 'string' && !fp.startsWith('/')) relativePaths.add(fp);
  }

  const idsToDrop: Array<string | number> = [];
  const rewriteByNewPath = new Map<string, Array<string | number>>();
  for (const p of allPoints) {
    const fp = p.payload?.file_path;
    if (typeof fp !== 'string' || !fp.startsWith('/')) continue;

    let relPath: string | null = null;
    if (fp === projectRoot) relPath = '';
    else if (fp.startsWith(rootSlash)) relPath = fp.substring(rootSlash.length);

    if (relPath === null) continue; // gehoert nicht zu diesem Projekt-Root

    if (relativePaths.has(relPath)) {
      idsToDrop.push(p.id);
    } else {
      const list = rewriteByNewPath.get(relPath) ?? [];
      list.push(p.id);
      rewriteByNewPath.set(relPath, list);
      relativePaths.add(relPath);
    }
  }

  if (idsToDrop.length > 0) {
    await client.delete(collection, { wait: true, points: idsToDrop });
    dropped += idsToDrop.length;
  }

  for (const [newPath, ids] of rewriteByNewPath.entries()) {
    const fileName = newPath.split('/').pop() || newPath;
    await client.setPayload(collection, {
      wait: true,
      points: ids,
      payload: {
        file_path: newPath,
        file_name: fileName,
        updated_at: new Date().toISOString(),
      },
    });
    rewritten += ids.length;
  }

  return { rewritten, dropped };
}
