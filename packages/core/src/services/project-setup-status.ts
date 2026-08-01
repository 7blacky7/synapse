/**
 * MODUL: project-setup-status Service
 * ZWECK: Source-of-Truth fuer den Einrichtungsfortschritt (setupPhase) eines
 *        Projekts in PostgreSQL (project_setup_status).
 *
 * Ersetzt .synapse/status.json als primaere Datenquelle fuer setupPhase — analog
 * zu wrapper-status.ts (ersetzt .synapse/agents/status.json fuer Spezialisten) und
 * loadGitignore in watcher/ignore.ts (Datenbank zuerst, Datei nur als Notnagel).
 * Beide Eingangs-Pfade (stdio-MCP + REST) nutzen diese Funktionen — das ist der
 * eigentliche Fix: die REST-API konnte .synapse/status.json bisher nicht erreichen
 * (Container laeuft auf einem anderen Rechner), weshalb complete_setup dort
 * wirkungslos war.
 *
 * LESEN: PG zuerst. Kein PG-Eintrag? -> NOTNAGEL status.json am projectPath, falls
 * bekannt. Sonst 'none' (kein Wert wird erfunden).
 * SCHREIBEN: PG ist die Quelle. status.json wird zusaetzlich geschrieben (best
 * effort), wenn projectPath uebergeben wird — ein Fehler dort (Verzeichnis fehlt,
 * keine Schreibrechte) darf den Vorgang NICHT kippen.
 */

import { getPool } from '../db/client.js';
import { getProjectStatus, setProjectStatus } from './project-status.js';
import type { ProjectStatus } from './project-status.js';

export type SetupPhase = NonNullable<ProjectStatus['setupPhase']>;

/**
 * Liest die Setup-Phase eines Projekts. PG zuerst; ohne PG-Eintrag Fallback auf
 * status.json (nur wenn projectPath bekannt); ohne beides 'none'.
 */
export async function getSetupPhase(
  project: string,
  projectPath?: string
): Promise<SetupPhase> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{ setup_phase: string }>(
      `SELECT setup_phase FROM project_setup_status WHERE project = $1`,
      [project]
    );
    if (rows.length > 0) {
      return rows[0].setup_phase as SetupPhase;
    }
  } catch (error) {
    console.error(
      `[Synapse] Setup-Phase fuer "${project}" nicht aus PG lesbar, Fallback auf status.json:`,
      (error as Error).message
    );
  }

  // NOTNAGEL: status.json vom Dateisystem, nur solange kein PG-Eintrag existiert
  // (nicht migriert, oder Datenbank beim Lesen nicht erreichbar).
  if (projectPath) {
    const fileStatus = getProjectStatus(projectPath);
    if (fileStatus?.setupPhase) {
      return fileStatus.setupPhase;
    }
  }

  return 'none';
}

/**
 * Setzt die Setup-Phase eines Projekts. PG ist die Quelle; status.json wird
 * zusaetzlich (best effort) aktualisiert, wenn projectPath uebergeben wird.
 * Ein Fehler beim Schreiben von status.json darf den Vorgang NICHT kippen — das
 * war der eigentliche Fehler: complete_setup ueber die REST-API scheiterte
 * bisher komplett, weil status.json fuer den Container unerreichbar ist.
 */
export async function setSetupPhase(
  project: string,
  phase: SetupPhase,
  opts?: { projectPath?: string; updatedBy?: string }
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO project_setup_status (project, setup_phase, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (project) DO UPDATE SET
       setup_phase = EXCLUDED.setup_phase,
       updated_by  = EXCLUDED.updated_by,
       updated_at  = NOW()`,
    [project, phase, opts?.updatedBy ?? null]
  );

  // Zusaetzliches Schreibziel, best effort: status.json bleibt Cache/Fallback.
  if (opts?.projectPath) {
    try {
      setProjectStatus(opts.projectPath, { setupPhase: phase });
    } catch (error) {
      console.error(
        `[Synapse] status.json fuer "${project}" nicht aktualisierbar (PG-Schreiben war bereits erfolgreich):`,
        (error as Error).message
      );
    }
  }
}

/**
 * Ermittelt den Projekt-Status. PG zuerst (Zeile in projects plus Setup-Phase),
 * .synapse/status.json nur als NOTNAGEL — dasselbe Muster wie getSetupPhase.
 *
 * WARUM ES DIESE FUNKTION GIBT: drei Stellen im lokalen MCP-Server
 * (checkAgentOnboarding, tryReactivateProject, getProjectStatusWithStats) haben
 * allein an der EXISTENZ von status.json entschieden, ob ein Projekt eingerichtet
 * ist. Fehlte die Datei, lieferte das Onboarding stillschweigend KEINE
 * Projekt-Regeln, obwohl PostgreSQL das Projekt kannte — und das faellt niemandem
 * auf, weil "keine Regeln geliefert" genauso aussieht wie "es gibt keine".
 * SETUP-1 hat die setupPhase nach PG geholt, die Existenzpruefung blieb an der
 * Datei haengen. Genau diese Haelfte zieht die Funktion nach.
 *
 * Rueckgabe null heisst: weder PG noch Datei kennen das Projekt.
 */
export async function ermittleProjektStatus(
  projectPath: string,
  project?: string
): Promise<ProjectStatus | null> {
  try {
    const pool = getPool();
    const { rows } = await pool.query<{
      name: string;
      path: string;
      enabled: boolean;
      created_at: Date | null;
      last_access: Date | null;
    }>(
      `SELECT name, path, enabled, created_at, last_access
         FROM projects
        WHERE path = $1 OR ($2::text IS NOT NULL AND name = $2)
        ORDER BY (path = $1) DESC, enabled DESC
        LIMIT 1`,
      [projectPath, project ?? null]
    );

    if (rows.length > 0) {
      const zeile = rows[0];
      // Die Datei liefert nur noch, was PG nicht fuehrt (id) bzw. was dort
      // genauer steht (der lokale Pfad statt einer /virtual-Zeile).
      const datei = getProjectStatus(projectPath);
      return {
        id: datei?.id ?? `pg:${zeile.name}`,
        project: zeile.name,
        path: datei?.path ?? zeile.path,
        initialized: (zeile.created_at ?? new Date()).toISOString(),
        lastAccess: (zeile.last_access ?? new Date()).toISOString(),
        status: zeile.enabled ? 'active' : 'stopped',
        setupPhase: await getSetupPhase(zeile.name, projectPath),
      };
    }
  } catch (error) {
    console.error(
      `[Synapse] Projekt-Status fuer "${project ?? projectPath}" nicht aus PG lesbar, Fallback auf status.json:`,
      (error as Error).message
    );
  }

  // NOTNAGEL: status.json, solange PG das Projekt nicht kennt.
  return getProjectStatus(projectPath);
}

