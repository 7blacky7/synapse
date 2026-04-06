/**
 * MODUL: PostgreSQL Client
 * ZWECK: Singleton-Pool zur PostgreSQL-Datenbank — Verbindung, Test, Teardown.
 *
 * INPUT:
 *   - DATABASE_URL (via config) - PostgreSQL Connection String
 *
 * OUTPUT:
 *   - Pool: Aktiver pg-Connection-Pool (Singleton)
 *   - boolean: Verbindungstest-Ergebnis
 *
 * NEBENEFFEKTE:
 *   - Haelt einen globalen Pool am Leben fuer die gesamte Prozess-Lebensdauer
 *   - closePool() gibt alle Verbindungen frei
 */

import { Pool } from 'pg';
import { getConfig } from '../config.js';

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (!_pool) {
    const config = getConfig();
    _pool = new Pool({ connectionString: config.database.url, max: 20 });
  }
  return _pool;
}

export async function testDatabaseConnection(): Promise<boolean> {
  try {
    const pool = getPool();
    const result = await pool.query('SELECT 1');
    console.error('[Synapse] PostgreSQL verbunden');
    return true;
  } catch (error) {
    console.error('[Synapse] PostgreSQL nicht erreichbar:', error);
    return false;
  }
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
