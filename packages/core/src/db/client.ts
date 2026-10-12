/**
 * MODUL: PostgreSQL Client
 * ZWECK: Pools zur PostgreSQL-Datenbank — Verbindung, Test, Teardown.
 *
 * ZWEI POOLS (P5-T15, 11.10.2026 — User-Vorgabe: KI-Anfragen werden NIE blockiert):
 *   - Haupt-Pool (max 20): Tool-Anfragen der KIs und alles Interaktive.
 *   - Hintergrund-Pool (klein): Embedding-Nachtraege, Backlog, Parser-Worker, Parsen nach
 *     Schreibvorgaengen, Context7-Automatik. Hintergrundarbeit kann die Verbindungen der
 *     Tool-Anfragen damit nicht mehr belegen.
 *   imHintergrund(fn) markiert einen Ablauf per AsyncLocalStorage als Hintergrund: JEDES
 *   getPool() darin — auch tief in anderen Modulen und in daraus gestarteten Timern — liefert
 *   den Hintergrund-Pool. Ausserhalb liefert getPool() wie bisher den Haupt-Pool.
 *   BEFUND, der dazu fuehrte (t37): memory read 51 s / update 113 s, waehrend ~1700
 *   Context7-Chunks je einen nebenlaeufigen Embedding-Nachtrag mit eigener Pool-Verbindung
 *   anstiessen — die Tool-Anfragen standen im FIFO des einen Pools dahinter.
 *   VERKLEMMUNG: Hintergrund-Ablaeufe halten hoechstens EINE Verbindung zugleich (parseAndEmbed,
 *   Embedding-Claims, Nachtraege, geprueft 11.10.2026). Wer kuenftig im Hintergrund einen Client
 *   haelt und darin getPool().query ruft, braucht zwei — dann den Pool-Default mitdenken.
 *
 * INPUT:
 *   - DATABASE_URL (via config) - PostgreSQL Connection String
 *   - SYNAPSE_DB_HINTERGRUND_MAX (Default 8): Verbindungen des Hintergrund-Pools
 *     (5 Parse-Worker + 2 Embedding-Claims + 1)
 *   - SYNAPSE_DB_HINTERGRUND_WARTE_MS (Default 60000): so lange wartet Hintergrundcode
 *     hoechstens auf eine Verbindung, dann Fehler statt Haenger (Notbremse; die Arbeit bleibt im
 *     Rueckstand und wird beim naechsten Tick erneut versucht)
 *
 * OUTPUT:
 *   - Pool: getPool() (je nach Kontext Haupt- oder Hintergrund-Pool), getHintergrundPool()
 *   - boolean: Verbindungstest-Ergebnis, istImHintergrund()
 *
 * NEBENEFFEKTE:
 *   - Haelt bis zu zwei globale Pools am Leben fuer die gesamte Prozess-Lebensdauer
 *   - closePool() gibt alle Verbindungen beider Pools frei
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool } from 'pg';
import { getConfig } from '../config.js';

let _pool: Pool | null = null;
let _hintergrundPool: Pool | null = null;

/** Markierung "dieser Ablauf ist Hintergrundarbeit" — vererbt sich auf alle Folge-Promises/Timer. */
const hintergrundKontext = new AsyncLocalStorage<true>();

function envGanzzahl(name: string, ersatz: number): number {
  const wert = Number(process.env[name]);
  return Number.isInteger(wert) && wert > 0 ? wert : ersatz;
}

function hauptPool(): Pool {
  if (!_pool) {
    const config = getConfig();
    _pool = new Pool({ connectionString: config.database.url, max: 20 });
  }
  return _pool;
}

/** Pool fuer Hintergrundarbeit. Direkt nutzen, wo ein Ablauf immer Hintergrund ist. */
export function getHintergrundPool(): Pool {
  if (!_hintergrundPool) {
    const config = getConfig();
    _hintergrundPool = new Pool({
      connectionString: config.database.url,
      max: envGanzzahl('SYNAPSE_DB_HINTERGRUND_MAX', 8),
      connectionTimeoutMillis: envGanzzahl('SYNAPSE_DB_HINTERGRUND_WARTE_MS', 60_000),
    });
    // Ein Fehler eines ruhenden Hintergrund-Clients (Verbindung weg) darf den Prozess nicht beenden.
    _hintergrundPool.on('error', (err) => {
      console.error('[Synapse] Hintergrund-Pool: Fehler eines ruhenden Clients:', err.message);
    });
  }
  return _hintergrundPool;
}

/** P6-T27: separater, nur im expliziten Lese-Overlay aktiver Anfragekontext. */
const lesePoolKontext = new AsyncLocalStorage<Pool>();
export function mitLesePool<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  return lesePoolKontext.run(pool, fn);
}

export function getPool(): Pool {
  return lesePoolKontext.getStore() ?? (hintergrundKontext.getStore() ? getHintergrundPool() : hauptPool());
}

/**
 * Fuehrt fn als Hintergrundarbeit aus: jedes getPool() darin liefert den Hintergrund-Pool.
 * Fuer Ticks, Loops und nebenlaeufig angestossene Nachtraege — nie fuer Tool-Anfragen.
 */
export function imHintergrund<T>(fn: () => Promise<T>): Promise<T> {
  return hintergrundKontext.run(true, fn);
}

/** true innerhalb von imHintergrund(...). */
export function istImHintergrund(): boolean {
  return hintergrundKontext.getStore() === true;
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
  if (_hintergrundPool) {
    await _hintergrundPool.end();
    _hintergrundPool = null;
  }
}
