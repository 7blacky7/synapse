/**
 * MODUL: project-status
 * ZWECK: Persistenter Projekt-Status in .synapse/status.json
 *
 * INPUT:
 *   - projectPath: string - Absoluter Pfad zum Projekt
 *   - status: Partial<ProjectStatus> - Status-Daten zum Aktualisieren
 *
 * OUTPUT:
 *   - ProjectStatus | null - Geladener Status oder null wenn nicht vorhanden
 *   - void - Bei Schreiboperationen
 *   - boolean - Bei Statusprüfung
 *
 * NEBENEFFEKTE:
 *   - Dateisystem: Liest/schreibt .synapse/status.json
 *   - Erstellt .synapse Ordner automatisch falls noetig
 *
 * ABHÄNGIGKEITEN:
 *   - fs (extern) - Dateisystem-Operationen
 *   - path (extern) - Pfad-Manipulation
 *   - uuid (extern) - ID-Generierung
 *
 * HINWEISE:
 *   - Status-Datei liegt immer in {projectPath}/.synapse/status.json
 *   - Bei korrupter JSON wird null zurueckgegeben
 */

import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../db/client.js';

const STATUS_DIR = '.synapse';
const STATUS_FILE = 'status.json';

export interface ProjectStatus {
  id: string;           // UUID v4
  project: string;      // Projektname
  path: string;         // Absoluter Pfad
  initialized: string;  // ISO Timestamp
  lastAccess: string;   // ISO Timestamp
  status: 'active' | 'stopped';
  setupPhase?: 'none' | 'initial-pending' | 'initial-done' | 'post-indexing-pending' | 'complete';
}

/**
 * Gibt den Pfad zur status.json zurueck
 */
function getStatusPath(projectPath: string): string {
  return path.join(projectPath, STATUS_DIR, STATUS_FILE);
}

/**
 * Liest den Projekt-Status aus .synapse/status.json
 * Gibt null zurueck wenn Datei nicht existiert oder korrupt ist
 */
export function getProjectStatus(projectPath: string): ProjectStatus | null {
  const statusPath = getStatusPath(projectPath);

  try {
    if (!fs.existsSync(statusPath)) {
      return null;
    }
    const content = fs.readFileSync(statusPath, 'utf-8');
    return JSON.parse(content) as ProjectStatus;
  } catch {
    // Datei korrupt oder nicht lesbar
    return null;
  }
}

/**
 * Setzt/aktualisiert den Projekt-Status
 * Erstellt .synapse Ordner und generiert ID falls noetig
 */
export function setProjectStatus(
  projectPath: string,
  status: Partial<ProjectStatus>
): void {
  const synapseDir = path.join(projectPath, STATUS_DIR);
  const statusPath = getStatusPath(projectPath);

  // .synapse Ordner erstellen falls noetig
  if (!fs.existsSync(synapseDir)) {
    fs.mkdirSync(synapseDir, { recursive: true });
  }

  // Bestehenden Status laden oder neu erstellen
  const existing = getProjectStatus(projectPath);
  const now = new Date().toISOString();
  const projectName = path.basename(projectPath);

  const merged: ProjectStatus = {
    id: existing?.id || status.id || uuidv4(),
    project: status.project ?? existing?.project ?? projectName,
    path: status.path ?? existing?.path ?? projectPath,
    initialized: existing?.initialized ?? status.initialized ?? now,
    lastAccess: status.lastAccess ?? now,
    status: status.status ?? existing?.status ?? 'active',
    setupPhase: status.setupPhase ?? existing?.setupPhase ?? 'none',
  };

  fs.writeFileSync(statusPath, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Prueft ob Projekt initialisiert ist (status.json existiert UND status === 'active')
 */
export function isProjectInitialized(projectPath: string): boolean {
  const status = getProjectStatus(projectPath);
  return status !== null && status.status === 'active';
}

/**
 * Aktualisiert nur den lastAccess Timestamp
 */
export function updateLastAccess(projectPath: string): void {
  const existing = getProjectStatus(projectPath);
  if (!existing) {
    return;
  }
  setProjectStatus(projectPath, { lastAccess: new Date().toISOString() });
}

/**
 * Loescht die status.json Datei
 */
export function clearProjectStatus(projectPath: string): void {
  const statusPath = getStatusPath(projectPath);

  try {
    if (fs.existsSync(statusPath)) {
      fs.unlinkSync(statusPath);
    }
  } catch {
    // Fehler beim Loeschen ignorieren
  }
}

/**
 * Prueft ob ein Agent in dieser Server-Instanz bereits ongeboardet wurde.
 * Nutzt server_instance_id in PG agent_sessions:
 *   - Gleiche Instance-ID → Agent kennt die Regeln → false (nicht neu)
 *   - Andere/keine Instance-ID → neue Session → true (Onboarding noetig)
 *   - Kein Record → Agent komplett unbekannt → true + auto-INSERT
 *
 * @returns true wenn Agent NEU ist (Onboarding zeigen), false wenn bereits bekannt
 */
export async function registerAgent(
  project: string,
  agentId: string,
  serverInstanceId: string
): Promise<boolean> {
  try {
    const pool = getPool();

    // Pruefen ob Agent mit dieser server_instance_id schon bekannt ist
    const result = await pool.query(
      `SELECT server_instance_id FROM agent_sessions WHERE id = $1 AND project = $2 LIMIT 1`,
      [agentId, project]
    );

    if (result.rows.length === 0) {
      // Agent komplett unbekannt → auto-INSERT + Onboarding
      await pool.query(
        `INSERT INTO agent_sessions (id, project, status, server_instance_id, registered_at)
         VALUES ($1, $2, 'active', $3, NOW())
         ON CONFLICT (id) DO UPDATE SET server_instance_id = $3`,
        [agentId, project, serverInstanceId]
      );
      return true;
    }

    const currentInstanceId = result.rows[0].server_instance_id;
    if (currentInstanceId === serverInstanceId) {
      // Gleiche Server-Instanz → schon ongeboardet
      return false;
    }

    // Andere/keine Instance-ID → neue Session → Onboarding + UPDATE
    await pool.query(
      `UPDATE agent_sessions SET server_instance_id = $3 WHERE id = $1 AND project = $2`,
      [agentId, project, serverInstanceId]
    );
    return true;
  } catch {
    // Bei PG-Fehler sicherheitshalber Onboarding zeigen
    return true;
  }
}

/**
 * Prueft ob ein Agent dem Projekt bekannt ist (hat jemals einen Record in PG)
 */
export async function isAgentKnown(project: string, agentId: string): Promise<boolean> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT 1 FROM agent_sessions WHERE id = $1 AND project = $2 LIMIT 1`,
      [agentId, project]
    );
    return result.rows.length > 0;
  } catch {
    return false;
  }
}
