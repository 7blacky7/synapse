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

/**
 * Registriert ein virtuelles Projekt fuer REST-API Clients (Web-KIs).
 * Hostname: 'rest-api', Pfad: '/virtual/rest-api'
 * Web-KIs muessen keinen lokalen Pfad angeben — getProjectRoot findet immer einen Eintrag.
 */
export async function registerVirtualProject(name: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO projects (name, hostname, path, created_at, last_access)
     VALUES ($1, 'rest-api', '/virtual/rest-api', NOW(), NOW())
     ON CONFLICT (name, hostname) DO UPDATE SET last_access = NOW()`,
    [name]
  );
}
