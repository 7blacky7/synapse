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

const STATUS_DIR = '.synapse';
const STATUS_FILE = 'status.json';

export interface ProjectStatus {
  id: string;           // UUID v4
  project: string;      // Projektname
  path: string;         // Absoluter Pfad
  initialized: string;  // ISO Timestamp
  lastAccess: string;   // ISO Timestamp
  status: 'active' | 'stopped';
  knownAgents: string[];  // Liste bekannter Agent-IDs fuer Onboarding
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
    knownAgents: status.knownAgents ?? existing?.knownAgents ?? [],
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
 * Prueft ob ein Agent dem Projekt bereits bekannt ist
 */
export function isAgentKnown(projectPath: string, agentId: string): boolean {
  const status = getProjectStatus(projectPath);
  if (!status) {
    return false;
  }
  return status.knownAgents?.includes(agentId) ?? false;
}

/**
 * Registriert einen Agent als bekannt
 * Gibt true zurueck wenn Agent NEU war, false wenn bereits bekannt
 */
export function registerAgent(projectPath: string, agentId: string): boolean {
  const status = getProjectStatus(projectPath);
  if (!status) {
    return false;
  }

  // Bereits bekannt?
  if (status.knownAgents?.includes(agentId)) {
    return false;
  }

  // Agent hinzufuegen
  const knownAgents = [...(status.knownAgents || []), agentId];
  setProjectStatus(projectPath, { knownAgents });
  return true;
}
