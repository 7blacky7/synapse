/**
 * MODUL: Transiente PostgreSQL-Fehler
 * ZWECK: Erkennt Fehler, die bei einem zweiten Versuch mit hoher Wahrscheinlichkeit
 *        verschwinden, und wiederholt eine ganze Transaktion mit Backoff + Jitter.
 *
 * TRANSIENT sind genau drei SQLSTATEs:
 *   40P01 deadlock_detected      — PG hat diese Transaktion als Opfer eines Zyklus gewaehlt
 *   40001 serialization_failure  — Konflikt unter REPEATABLE READ / SERIALIZABLE
 *   55P03 lock_not_available     — lock_timeout bzw. NOWAIT
 * In allen drei Faellen ist die Transaktion vollstaendig zurueckgerollt; ein Neuversuch
 * mit DEMSELBEN Inhalt ist korrekt. Alles andere (FK-Verletzung, Encoding, Syntax) ist
 * es nicht und wird unveraendert weitergeworfen.
 *
 * ANLASS (28.09.2026, softcleanToeva): drei Agenten committeten parallel Plaene, der
 * Symbol-Insert fuer dispatch.service.ts starb mit "deadlock detected" und wurde nie
 * wiederholt — der Symbolbestand blieb auf dem Stand von 08:00, waehrend die Volltext-
 * suche schon den neuen Inhalt kannte.
 */

import type { Pool, PoolClient } from 'pg';

export const TRANSIENTE_PG_CODES: ReadonlySet<string> = new Set(['40P01', '40001', '55P03']);

/** true, wenn der Fehler einen der transienten SQLSTATEs traegt. */
export function istTransienterPgFehler(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && TRANSIENTE_PG_CODES.has(code);
}

/**
 * Wartezeit vor Versuch versuch+1: exponentiell (basis, 2*basis, 4*basis ...) bis maxMs,
 * davon eine zufaellige Haelfte ("equal jitter"). Der Jitter ist der eigentliche Punkt:
 * zwei Laeufe, die sich gerade gegenseitig blockiert haben, duerfen nicht im selben
 * Takt wieder anlaufen, sonst treffen sie sich erneut.
 */
export function wartezeitMs(versuch: number, basisMs = 100, maxMs = 2000): number {
  const decke = Math.min(maxMs, basisMs * 2 ** Math.max(0, versuch - 1));
  return Math.round(decke / 2 + Math.random() * (decke / 2));
}

export interface RetryOptionen {
  /** Gesamtzahl der Versuche inklusive des ersten (Default 3). */
  versuche?: number;
  basisMs?: number;
  maxMs?: number;
}

/**
 * Fuehrt body in einer eigenen Transaktion aus (BEGIN ... COMMIT auf EINER Verbindung)
 * und wiederholt die GANZE Transaktion bei einem transienten Fehler. Auch ein Fehler
 * beim COMMIT zaehlt (verzoegerte Constraints koennen dort erst zuschlagen).
 * Nach dem letzten Versuch wird der Fehler weitergeworfen.
 */
export async function inTransaktionMitRetry<T>(
  pool: Pool,
  label: string,
  body: (client: PoolClient) => Promise<T>,
  opts: RetryOptionen = {}
): Promise<T> {
  const versuche = Math.max(1, opts.versuche ?? 3);
  for (let versuch = 1; ; versuch++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ergebnis = await body(client);
      await client.query('COMMIT');
      return ergebnis;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (!istTransienterPgFehler(err) || versuch >= versuche) throw err;
      const ms = wartezeitMs(versuch, opts.basisMs, opts.maxMs);
      console.error(
        `[Synapse] ${label}: transienter PG-Fehler ${(err as { code?: string }).code} ` +
          `(Versuch ${versuch}/${versuche}) — Neuversuch in ${ms} ms`
      );
      await new Promise(resolve => setTimeout(resolve, ms));
    } finally {
      client.release();
    }
  }
}
