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
import { Pool, Client } from 'pg';
import { getConfig } from '../config.js';

let dbProzess = process.env.SYNAPSE_DB_PROZESS ?? 'api';
export function setzeDbProzess(art: 'wrapper' | 'daemon'): void {
  if (_pool || _hintergrundPool) throw new Error('DB-Prozessprofil muss vor der ersten Verbindung gesetzt werden');
  dbProzess = art;
}
const kleinerProzess = () => dbProzess === 'wrapper' || dbProzess === 'daemon';

// ── P9-T27 (letzter Schritt): Prozess ohne DB-Zugang ─────────────────────────────────────────────
// Der lokale Daemon arbeitet im API-Weg OHNE DATABASE_URL (Memory regel-pc-nur-ueber-api-kein-lokaler-
// db-zugang). sperreDbZugriff() sorgt dafuer, dass dieser Prozess danach KEINE PG-Verbindung mehr
// aufbaut — auch nicht ueber einen vergessenen Restweg oder ein DATABASE_URL aus einer .env im
// Arbeitsordner (dotenv). getPool()/getHintergrundPool() liefern dann einen Ersatz, dessen query/
// connect mit klarer Meldung ablehnen (asynchron, wie ein Verbindungsfehler: kein Absturz), und jede
// neue Aufrufstelle wird EINMAL mit Stack im Log gemeldet — so faellt ein Rest sofort auf.
let dbSperre: string | null = null;
let gesperrterPoolInstanz: Pool | null = null;
const gemeldeteSperrStellen = new Set<string>();

/** Sperrt jeden weiteren PG-Zugang dieses Prozesses (Daemon im API-Weg). Nicht umkehrbar. */
export function sperreDbZugriff(grund: string): void {
  dbSperre = grund || 'DB-Zugang in diesem Prozess gesperrt';
}

/** Grund der DB-Sperre oder null (kein gesperrter Prozess). */
export function dbZugriffGesperrt(): string | null {
  return dbSperre;
}

function sperrFehler(): Error {
  const err = new Error(`PG-Zugriff gesperrt: ${dbSperre}. Dieser Weg muss ueber die Synapse-API laufen.`);
  const stelle = (err.stack ?? '').split('\n').slice(2, 5).join(' | ');
  if (!gemeldeteSperrStellen.has(stelle) && gemeldeteSperrStellen.size < 200) {
    gemeldeteSperrStellen.add(stelle);
    console.error(`[Synapse] DB-Sperre: abgewiesener PG-Zugriff bei ${stelle || '(unbekannt)'}`);
  }
  return err;
}

function gesperrterPool(): Pool {
  if (!gesperrterPoolInstanz) {
    const p: Record<string, unknown> = {
      query: async () => { throw sperrFehler(); },
      connect: async () => { throw sperrFehler(); },
      on: () => p,
      once: () => p,
      removeListener: () => p,
      end: async () => undefined,
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      options: { gesperrt: true },
    };
    gesperrterPoolInstanz = p as unknown as Pool;
  }
  return gesperrterPoolInstanz;
}

/** LISTEN braucht eine dauerhafte Verbindung, aber keinen Platz im Query-Pool. */
export async function verbindeListenClient(): Promise<Client> {
  if (dbSperre) throw sperrFehler();
  const client = new Client({ connectionString: getConfig().database.url, application_name: 'synapse-' + dbProzess + '-listen' });
  try { await client.connect(); return client; }
  catch (err) { await client.end().catch(() => {}); throw err; }
}

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
    _pool = new Pool({
      connectionString: config.database.url,
      max: envGanzzahl('SYNAPSE_DB_HAUPT_MAX', kleinerProzess() ? 3 : 20),
      idleTimeoutMillis: envGanzzahl('SYNAPSE_DB_IDLE_MS', 10_000),
      connectionTimeoutMillis: kleinerProzess() ? 10_000 : 0,
      application_name: 'synapse-' + dbProzess,
    });
    _pool.on('error', err => console.error('[Synapse] Ruhende DB-Verbindung:', err.message));
  }
  return _pool;
}

/** Pool fuer Hintergrundarbeit. Direkt nutzen, wo ein Ablauf immer Hintergrund ist. */
export function getHintergrundPool(): Pool {
  if (dbSperre) return gesperrterPool();
  if (!_hintergrundPool) {
    const config = getConfig();
    _hintergrundPool = new Pool({
      connectionString: config.database.url,
      max: kleinerProzess() ? 2 : envGanzzahl('SYNAPSE_DB_HINTERGRUND_MAX', 8),
      idleTimeoutMillis: envGanzzahl('SYNAPSE_DB_IDLE_MS', 10_000),
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
  if (dbSperre) return gesperrterPool();
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
