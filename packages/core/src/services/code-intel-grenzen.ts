/**
 * P22-T314 (Befund thoughts 4e749391, 20ea0533, Ursache 236ac889; Deploy t243): Grenzen fuer code_intel-Abfragen in PostgreSQL.
 *
 * WARUM: Ghost-Schatten-Abfragen (code-intel-schatten.ts lesePool, _synapse_ghost_* NOT MATERIALIZED + UNION ALL) liefen in der
 * Produktions-PG minutenlang mit Parallel-Workern weiter, nachdem der Client laengst im Timeout war. Parallel-Hash legt
 * DSM-Segmente in /dev/shm (64 MB) an -> "could not resize shared memory segment" fuer alle; die Sperren hielten beim Deploy
 * die Schema-Sperre (55P03 code_references). Vorgabe memory unraid-postgresql-speicher-fakten-und-regel: PG-Speicher wird
 * NICHT erhoeht, Loesung im Code.
 *
 * WAS: begrenzterPool(pool, grenzen, signal) fuehrt JEDE Abfrage in einer eigenen kurzen Transaktion aus mit
 *   SET LOCAL statement_timeout = <code_intel_statement_timeout_ms>  (PG bricht selbst ab, auch ohne Client)
 *   SET LOCAL lock_timeout      = <code_intel_lock_timeout_ms>       (kein langes Warten auf Schema-/Tabellensperren)
 *   SET LOCAL max_parallel_workers_per_gather = 0                     (keine Parallel-Worker, keine DSM-Segmente)
 * und beendet sie per pg_cancel_backend, wenn das Abbruchsignal der Anfrage feuert (HTTP-Client weg, mitAnfrageAbbruch).
 * Eine abgebrochene Verbindung geht nicht zurueck in den Pool (release(true)), damit ein verspaeteter Cancel nie eine
 * fremde Abfrage trifft. connect() und alle anderen Pool-Methoden bleiben unveraendert (eigene Transaktionen der Dienste).
 *
 * EINSTELLWERTE (Regel 7): runtime_ueberwachung-Katalog code_intel_statement_timeout_ms (Standard 25000, unter dem
 * Cloudflare-/Client-Timeout ~30 s) und code_intel_lock_timeout_ms (Standard 2000); setzen per admin runtime_ueberwachung
 * (User/Koordinator). Lesestelle leseCodeIntelGrenzen (30 s Prozess-Cache, Lesefehler -> Code-Standard).
 * FEHLER: pgFehlerAntwort bildet 57014 (zeitlimit | abgebrochen), 55P03 (sperre_belegt), 53100/53200 (speicherlimit) auf
 * verstaendliche, wiederholbare Antworten ab statt "interner Fehler".
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool, PoolClient } from 'pg';

export interface CodeIntelGrenzen {
  statement_timeout_ms: number;
  lock_timeout_ms: number;
  /** P22-T314: hoechstens so lange wartet code_intel auf die kleine Typpruefung im Pruef-Container (ms). */
  typen_ms: number;
  quelle: { statement_timeout_ms: string; lock_timeout_ms: string; typen_ms?: string };
}

/** Code-Standard (gleich dem Katalog in runtime-ueberwachung.ts; dort Grenzen min/max). */
export const CODE_INTEL_GRENZEN_STANDARD = { statement_timeout_ms: 25_000, lock_timeout_ms: 2_000, typen_ms: 5_000 } as const;

const CACHE_MS = 30_000;
let grenzenCache: { bis: number; wert: CodeIntelGrenzen } | null = null;

/** Fuer Tests und nach dem Setzen: naechster Aufruf liest neu. */
export function leereCodeIntelGrenzenCache(): void {
  grenzenCache = null;
}

/** Wirksame Grenzen (PG-Einstellung > Code-Standard). Wirft nie. */
export async function leseCodeIntelGrenzen(): Promise<CodeIntelGrenzen> {
  if (grenzenCache && grenzenCache.bis > Date.now()) return grenzenCache.wert;
  let wert: CodeIntelGrenzen = {
    ...CODE_INTEL_GRENZEN_STANDARD, quelle: { statement_timeout_ms: 'standard', lock_timeout_ms: 'standard', typen_ms: 'standard' },
  };
  try {
    // Dynamisch: runtime-ueberwachung.ts zieht viele Dienste nach; code_intel soll davon nicht abhaengen.
    const ru = await import('./runtime-ueberwachung.js');
    const e = await ru.leseRuntimeUeberwachungEinstellungen();
    const st = Number(e.code_intel_statement_timeout_ms?.wert);
    const lt = Number(e.code_intel_lock_timeout_ms?.wert);
    const ty = Number(e.code_intel_typen_ms?.wert);
    wert = {
      statement_timeout_ms: Number.isFinite(st) && st > 0 ? st : CODE_INTEL_GRENZEN_STANDARD.statement_timeout_ms,
      lock_timeout_ms: Number.isFinite(lt) && lt > 0 ? lt : CODE_INTEL_GRENZEN_STANDARD.lock_timeout_ms,
      typen_ms: Number.isFinite(ty) && ty > 0 ? ty : CODE_INTEL_GRENZEN_STANDARD.typen_ms,
      quelle: { statement_timeout_ms: e.code_intel_statement_timeout_ms?.quelle ?? 'standard', lock_timeout_ms: e.code_intel_lock_timeout_ms?.quelle ?? 'standard',
        typen_ms: e.code_intel_typen_ms?.quelle ?? 'standard' },
    };
  } catch { /* Lesefehler -> Code-Standard */ }
  grenzenCache = { bis: Date.now() + CACHE_MS, wert };
  return wert;
}

// ─── Abbruch der Anfrage (HTTP-Client weg) ───────────────────────────────────────────────────────────────────────────────────

const abbruchKontext = new AsyncLocalStorage<AbortSignal>();

/** Fuehrt fn mit dem Abbruchsignal der Anfrage aus (rest-api mcp.ts: Client schliesst die Verbindung). */
export function mitAnfrageAbbruch<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return signal ? abbruchKontext.run(signal, fn) : fn();
}

/** Wie mitAnfrageAbbruch, aber fuer den Rest des laufenden Ablaufs (Route-Handler: gilt nur fuer diese Anfrage). */
export function setzeAnfrageAbbruch(signal: AbortSignal): void {
  abbruchKontext.enterWith(signal);
}

export function aktuellesAbbruchSignal(): AbortSignal | undefined {
  return abbruchKontext.getStore();
}

class CodeIntelAbbruch extends Error {
  readonly code = 'SYNAPSE_ABGEBROCHEN';
  constructor() { super('Anfrage vom Client abgebrochen'); this.name = 'CodeIntelAbbruch'; }
}

// ─── Begrenzter Pool ────────────────────────────────────────────────────────────────────────────────────────────────────────

const BEGRENZT = Symbol('synapse.codeIntelBegrenzt');
const ganz = (n: number, min: number): number => Math.max(min, Math.round(Number.isFinite(n) ? n : min));

/** Zaehler fuer die Diagnose (Tests, intern). */
export const CODE_INTEL_GRENZEN_ZAEHLER = { abfragen: 0, zeitlimit: 0, abgebrochen: 0, sperre: 0, speicher: 0 };

async function begrenzteAbfrage(pool: Pool, g: CodeIntelGrenzen, signal: AbortSignal | undefined, sql: unknown, werte: unknown): Promise<unknown> {
  if (signal?.aborted) throw new CodeIntelAbbruch();
  const client: PoolClient = await pool.connect();
  let laeuft = false;
  let abgebrochen = false;
  const abbrechen = () => {
    abgebrochen = true;
    const pid = (client as unknown as { processID?: number }).processID;
    // Eigene Verbindung des Pools; nur solange die Abfrage laeuft (danach wird die Verbindung verworfen, s. finally).
    if (laeuft && pid) void pool.query('SELECT pg_cancel_backend($1)', [pid]).catch(() => {});
  };
  try {
    await client.query('BEGIN; SET LOCAL statement_timeout = ' + ganz(g.statement_timeout_ms, 100)
      + '; SET LOCAL lock_timeout = ' + ganz(g.lock_timeout_ms, 50) + '; SET LOCAL max_parallel_workers_per_gather = 0');
    signal?.addEventListener('abort', abbrechen, { once: true });
    // Pruefer-Fix: ein Abbruch waehrend connect/BEGIN kaeme beim once-Listener nie an (Signal schon abgebrochen) -> hier pruefen.
    if (signal?.aborted) { abgebrochen = true; throw new CodeIntelAbbruch(); }
    laeuft = true;
    CODE_INTEL_GRENZEN_ZAEHLER.abfragen++;
    const r = await (client.query as (s: unknown, w?: unknown) => Promise<unknown>).call(client, sql, werte);
    laeuft = false;
    await client.query('COMMIT');
    return r;
  } catch (err) {
    laeuft = false;
    await client.query('ROLLBACK').catch(() => {});
    const code = (err as { code?: unknown }).code;
    if (code === '57014') { if (abgebrochen) CODE_INTEL_GRENZEN_ZAEHLER.abgebrochen++; else CODE_INTEL_GRENZEN_ZAEHLER.zeitlimit++; }
    if (code === '55P03') CODE_INTEL_GRENZEN_ZAEHLER.sperre++;
    if (code === '53100' || code === '53200') CODE_INTEL_GRENZEN_ZAEHLER.speicher++;
    if (abgebrochen && code === '57014') throw new CodeIntelAbbruch();
    throw err;
  } finally {
    signal?.removeEventListener('abort', abbrechen);
    // Nach einem Abbruch nie wiederverwenden: ein spaet ankommender Cancel darf keine fremde Abfrage treffen.
    client.release(abgebrochen ? true : undefined);
  }
}

/**
 * Pool-Huelle fuer code_intel: query() mit Grenzen (siehe Modulkopf), alles andere unveraendert. Mehrfaches Umhuellen
 * liefert die vorhandene Huelle.
 */
export function begrenzterPool(pool: Pool, g: CodeIntelGrenzen, signal?: AbortSignal): Pool {
  if ((pool as unknown as Record<symbol, unknown>)[BEGRENZT]) return pool;
  return new Proxy(pool, {
    get(target, key) {
      if (key === BEGRENZT) return true;
      if (key !== 'query') {
        const wert = Reflect.get(target, key);
        return typeof wert === 'function' ? wert.bind(target) : wert;
      }
      return (sql: unknown, werte?: unknown) => begrenzteAbfrage(target, g, signal, sql, werte);
    },
  });
}

// ─── Verstaendliche Fehler ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * PG-Fehler einer code_intel-Abfrage als Antwort (success false, wiederholbar) oder null (anderer Fehler -> wie bisher).
 */
export function pgFehlerAntwort(err: unknown, g?: CodeIntelGrenzen): Record<string, unknown> | null {
  const code = (err as { code?: unknown } | null)?.code;
  const text = String((err as Error | null)?.message ?? '');
  const grenzen = g ? { statement_timeout_ms: g.statement_timeout_ms, lock_timeout_ms: g.lock_timeout_ms, quelle: g.quelle } : undefined;
  const antwort = (error: string, message: string) => ({
    success: false, error, wiederholbar: true, message,
    ...(typeof code === 'string' ? { sqlstate: code } : {}),
    ...(grenzen ? { grenzen } : {}),
    hinweis: 'P22-T314: code_intel-Abfragen laufen mit Zeit- und Sperrgrenze; Einstellung admin runtime_ueberwachung code_intel_statement_timeout_ms / code_intel_lock_timeout_ms.',
  });
  if (code === 'SYNAPSE_ABGEBROCHEN') return antwort('abgebrochen', 'Anfrage wurde vom Client abgebrochen; die Datenbankabfrage ist beendet.');
  if (code === '57014') {
    return /user request/i.test(text)
      ? antwort('abgebrochen', 'Datenbankabfrage wurde abgebrochen; bitte erneut versuchen.')
      : antwort('zeitlimit', `Abfrage ueberschritt das Zeitlimit${g ? ' von ' + g.statement_timeout_ms + ' ms' : ''} und wurde in der Datenbank beendet; enger fassen (file_path, limit) oder spaeter erneut versuchen.`);
  }
  if (code === '55P03') return antwort('sperre_belegt', `Tabelle gerade gesperrt (z. B. Index-Nachzug oder Deploy)${g ? '; gewartet ' + g.lock_timeout_ms + ' ms' : ''}; gleich erneut versuchen.`);
  if (code === '53100' || code === '53200') return antwort('speicherlimit', 'Die Datenbank hat gerade keinen Arbeitsspeicher fuer diese Abfrage frei; enger fassen oder gleich erneut versuchen.');
  return null;
}
