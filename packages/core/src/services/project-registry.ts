/**
 * Project Registry — Single Source of Truth fuer Projekt-Root-Pfade.
 * Speichert (name, hostname) -> path in PostgreSQL.
 * Hostname ermoeglicht Multi-Machine-Zugriff auf dieselbe DB.
 */

import * as os from 'os';
import { getPool } from '../db/client.js';

const HOSTNAME = os.hostname();

/**
 * Registriert ein Projekt fuer den aktuellen Host.
 * UPSERT: aktualisiert path + last_access wenn bereits vorhanden.
 */
export async function registerProject(
  name: string,
  projectPath: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (name, hostname, path, created_at, last_access)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (name, hostname) DO UPDATE SET
       path = EXCLUDED.path,
       last_access = NOW()`,
    [name, HOSTNAME, projectPath]
  );
}

/**
 * Gibt den absoluten Projekt-Root-Pfad fuer den aktuellen Host zurueck.
 * Fallback: Pfad von einem anderen Host (fuer Szenarien wo Hostname wechselt).
 */
export async function getProjectRoot(name: string): Promise<string | null> {
  const pool = getPool();

  // Erst: Pfad fuer aktuellen Host
  const local = await pool.query<{ path: string }>(
    `SELECT path FROM projects WHERE name = $1 AND hostname = $2`,
    [name, HOSTNAME]
  );
  if (local.rows.length > 0) return local.rows[0].path;

  // Fallback: beliebiger Host (nuetzlich bei erstem Init auf neuem Rechner)
  const any = await pool.query<{ path: string }>(
    `SELECT path FROM projects WHERE name = $1 ORDER BY last_access DESC LIMIT 1`,
    [name]
  );
  return any.rows.length > 0 ? any.rows[0].path : null;
}

/**
 * Konvertiert einen absoluten Pfad zu einem relativen (zum Projekt-Root).
 * Gibt den Pfad unveraendert zurueck wenn er bereits relativ ist.
 */
export function toRelativePath(projectRoot: string, absolutePath: string): string {
  const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  if (!absolutePath.startsWith(root)) return absolutePath;
  return absolutePath.substring(root.length);
}

/**
 * Konvertiert einen relativen Pfad zu einem absoluten.
 * Gibt den Pfad unveraendert zurueck wenn er bereits absolut ist.
 */
export function toAbsolutePath(projectRoot: string, relativePath: string): string {
  if (relativePath.startsWith('/')) return relativePath;
  const root = projectRoot.endsWith('/') ? projectRoot : projectRoot + '/';
  return root + relativePath;
}

export interface ProjectRegistryRow {
  hostname: string;
  path: string;
  enabled: boolean;
  last_access: Date;
}

/**
 * Liefert alle Registry-Zeilen eines Projekts ueber ALLE Hostnames (inkl. dem
 * virtuellen 'rest-api'-Eintrag). Fuer project(action:"status") — damit die
 * REST-API ehrlich sagen kann, ob ein Projekt ueberhaupt in PG registriert ist,
 * statt das stillschweigend vorauszusetzen.
 */
export async function getProjectRegistryRows(name: string): Promise<ProjectRegistryRow[]> {
  const pool = getPool();
  const r = await pool.query<ProjectRegistryRow>(
    `SELECT hostname, path, enabled, last_access FROM projects WHERE name = $1 ORDER BY last_access DESC`,
    [name]
  );
  return r.rows;
}

/**
 * Registriert ein virtuelles Projekt fuer REST-API Clients (Web-KIs).
 * Hostname: 'rest-api', Pfad: '/virtual/rest-api'
 * Web-KIs muessen keinen lokalen Pfad angeben — getProjectRoot findet immer einen Eintrag.
 */
export async function registerVirtualProject(name: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (name, hostname, path, created_at, last_access, enabled)
     VALUES ($1, 'rest-api', '/virtual/rest-api', NOW(), NOW(),
             COALESCE((SELECT bool_or(p2.enabled) FROM projects p2 WHERE p2.name = $1), true))
     ON CONFLICT (name, hostname) DO UPDATE SET last_access = NOW()`,
    [name]
  );
}

/**
 * Liest den wirksamen Projektstatus frisch aus PostgreSQL. bool_or entspricht
 * dem Registry-Guard in projekteMitBacklog: eine aktive Host-Zeile aktiviert
 * das Projekt; project(disable) setzt ohnehin alle Zeilen gemeinsam auf false.
 */
export async function isProjectEnabled(name: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query<{ enabled: boolean }>(
    `SELECT COALESCE(bool_or(enabled), false) AS enabled FROM projects WHERE name = $1`,
    [name]
  );
  return result.rows[0]?.enabled === true;
}

/**
 * Setzt das enabled-Flag fuer ALLE Registry-Eintraege eines Projekts
 * (ueber alle Hostnames inkl. dem virtuellen rest-api-Eintrag).
 * Der Parser-Worker (rest-api) verarbeitet nur Projekte mit enabled=true —
 * so wirkt der Tray/Daemon-Deaktiviert-Schalter auch server-seitig.
 */
export async function setProjectEnabled(name: string, enabled: boolean): Promise<number> {
  const pool = getPool();
  await pool.query(
    `UPDATE projects SET enabled = $2 WHERE name = $1`,
    [name, enabled]
  );
  if (enabled) return 0;

  // ⚠️ BEIM DEAKTIVIEREN DIE OFFENEN CLAIMS FREIGEBEN, NICHT EINFRIEREN.
  // Ein Claim reserviert einen Chunk fuer genau einen Knoten. Wird das Projekt
  // deaktiviert, hoert die Arbeit daran auf — aber die Reservierung blieb bisher
  // stehen, und der Claim-SELECT ueberspringt deaktivierte Projekte. Der Chunk
  // war damit fuer niemanden mehr erreichbar und sah im Betrieb aus wie ein
  // haengender Knoten (gemessen am 01.08.2026: 152 Claims von unraid-local,
  // 0 davon abgelaufen, ueber Stunden unveraendert).
  // Die Freigabe kostet nichts: sie betrifft ausschliesslich die Claim-Spalten,
  // keine Vektoren und keine Inhalte. Ein Knoten, der gerade an einem dieser
  // Chunks rechnet, wird beim Abschluss abgewiesen (claim_token passt nicht mehr)
  // und holt sich den naechsten — genau das gewuenschte Verhalten, denn seine
  // Arbeit gilt einem Projekt, das der Nutzer eben angehalten hat.
  const freigabe = await pool.query(
    `UPDATE code_chunks
        SET claimed_by = NULL, claim_token = NULL, lease_until = NULL
      WHERE project = $1 AND embedded_at IS NULL AND claimed_by IS NOT NULL`,
    [name]
  );
  return freigabe.rowCount ?? 0;
}
