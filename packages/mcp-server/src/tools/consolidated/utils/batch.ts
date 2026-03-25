/**
 * Batch-Utility fuer Array-Parameter Support
 * Verwendet Promise.allSettled fuer Partial-Failure-Toleranz
 */

/**
 * Fuehrt eine Funktion fuer einen einzelnen Wert oder ein Array aus.
 * Bei Array-Input: Promise.allSettled fuer partielle Fehlertoleranz.
 * Bei Scalar-Input: Direkt ausfuehren (backward compatible).
 */
export async function batchOrSingle<T, R>(
  val: T | T[],
  fn: (item: T) => Promise<R>
): Promise<R | { results: R[]; count: number; errors: string[] }> {
  if (!Array.isArray(val)) return fn(val);

  const settled = await Promise.allSettled(val.map(fn));
  const results: R[] = [];
  const errors: string[] = [];

  for (const r of settled) {
    if (r.status === 'fulfilled') results.push(r.value);
    else errors.push(String(r.reason));
  }

  return { results, count: results.length, errors };
}

/**
 * Normalisiert einen Wert zu einem Array.
 * Hilfsfunktion fuer Handler die scalar|array Parameter akzeptieren.
 */
export function toArray<T>(val: T | T[]): T[] {
  return Array.isArray(val) ? val : [val];
}
