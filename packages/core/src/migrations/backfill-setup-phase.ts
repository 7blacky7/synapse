/**
 * Migration: Bestehende setupPhase-Werte aus .synapse/status.json-Dateien
 * EINMALIG nach PostgreSQL (project_setup_status) uebernehmen (SETUP-1).
 *
 * Kein ALTER-TABLE-Datenumzug moeglich — die Werte stehen nur in Dateien, nicht
 * in PG. Vorbild: migrate-to-relative-paths.ts.
 *
 * Liest NUR Pfade, die tatsaechlich in `projects` stehen (ein realer, nicht-
 * virtueller Hostname-Eintrag je Projekt) — kein Scannen von ~/dev/* oder
 * anderen Verzeichnissen. Ein Projekt OHNE PG-Eintrag oder OHNE status.json
 * bekommt KEINEN erfundenen Wert; es bleibt ohne Zeile bis zum ersten echten
 * complete_setup/init ueber den neuen Service (Default dann 'none').
 * Ein bereits gesetzter PG-Wert gilt als aktuell und wird NICHT ueberschrieben.
 */

import { getPool } from '../db/client.js';
import { getProjectStatus } from '../services/project-status.js';

export async function backfillSetupPhaseFromStatusFiles(): Promise<{
  checked: number;
  migrated: Array<{ project: string; setupPhase: string }>;
  skippedNoFile: string[];
  skippedAlreadyInPg: string[];
}> {
  const pool = getPool();
  const migrated: Array<{ project: string; setupPhase: string }> = [];
  const skippedNoFile: string[] = [];
  const skippedAlreadyInPg: string[] = [];

  // Ein realer (nicht-virtueller) Pfad je Projekt reicht.
  const projects = await pool.query<{ name: string; path: string }>(
    `SELECT DISTINCT ON (name) name, path FROM projects
     WHERE hostname != 'rest-api'
     ORDER BY name, last_access DESC`
  );

  for (const proj of projects.rows) {
    const existing = await pool.query(
      `SELECT 1 FROM project_setup_status WHERE project = $1`,
      [proj.name]
    );
    if (existing.rows.length > 0) {
      skippedAlreadyInPg.push(proj.name);
      continue;
    }

    const fileStatus = getProjectStatus(proj.path);
    if (!fileStatus?.setupPhase) {
      skippedNoFile.push(proj.name);
      continue;
    }

    await pool.query(
      `INSERT INTO project_setup_status (project, setup_phase, updated_by, updated_at)
       VALUES ($1, $2, 'migration:backfill-setup-phase', NOW())
       ON CONFLICT (project) DO NOTHING`,
      [proj.name, fileStatus.setupPhase]
    );
    migrated.push({ project: proj.name, setupPhase: fileStatus.setupPhase });
  }

  return { checked: projects.rows.length, migrated, skippedNoFile, skippedAlreadyInPg };
}
