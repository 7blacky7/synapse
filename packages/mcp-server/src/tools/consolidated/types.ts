/**
 * Gemeinsame Types fuer konsolidierte MCP-Tools
 *
 * Jedes konsolidierte Tool hat:
 * - definition: MCP Tool-Schema (name, description, inputSchema)
 * - handler: Async-Funktion die args entgegennimmt und ein Result-Objekt zurueckgibt
 */

import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ConsolidatedTool {
  /** MCP Tool-Definition (name, description, inputSchema) */
  definition: Tool;
  /** Handler der die action dispatcht und das Ergebnis zurueckgibt */
  handler: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** Helper: Extrahiert einen String-Parameter oder gibt undefined zurueck */
export function str(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  return typeof val === 'string' ? val : undefined;
}

/** Helper: Extrahiert einen String-Parameter oder wirft einen Fehler */
export function reqStr(args: Record<string, unknown>, key: string): string {
  const val = str(args, key);
  if (!val) throw new Error(`Parameter "${key}" ist erforderlich`);
  return val;
}

/**
 * Helper: Extrahiert einen Number-Parameter. Akzeptiert auch Number-as-String
 * ("42" → 42), weil manche Schema-Validierer / Connectors so serialisieren.
 */
export function num(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * Helper: Extrahiert einen Boolean-Parameter. Akzeptiert auch "true"/"false"-
 * Strings (Connector-Quirk).
 */
export function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = args[key];
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') {
    if (val === 'true') return true;
    if (val === 'false') return false;
  }
  return undefined;
}

/**
 * Helper: Defensives String-Array. Akzeptiert:
 *  - natives Array (string[]) — non-strings werden gefiltert
 *  - JSON-String "[\"a\",\"b\"]" (Connector-Quirk)
 *  - einzelner String "a" → ["a"] (Convenience)
 * Returnt undefined wenn nichts da oder leer/unparseabar.
 */
export function strArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === 'string');
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return undefined;
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const out = parsed.filter((x): x is string => typeof x === 'string');
          return out.length > 0 ? out : undefined;
        }
      } catch { /* fall through to single-string */ }
    }
    return [trimmed];
  }
  return undefined;
}

/** Wie strArray, aber returnt [] statt undefined wenn nichts da ist. */
export function strArrayOrEmpty(args: Record<string, unknown>, key: string): string[] {
  return strArray(args, key) ?? [];
}

/**
 * Helper: Defensives Number-Array. Akzeptiert Array, JSON-String, Single-Number/-String.
 * Strings werden via Number() konvertiert (NaN-filter).
 */
export function numArray(args: Record<string, unknown>, key: string): number[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const toNum = (x: unknown): number | null => {
    if (typeof x === 'number' && Number.isFinite(x)) return x;
    if (typeof x === 'string' && x.trim() !== '') {
      const n = Number(x);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  if (Array.isArray(v)) {
    const out = v.map(toNum).filter((x): x is number => x !== null);
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return undefined;
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const out = parsed.map(toNum).filter((x): x is number => x !== null);
          return out.length > 0 ? out : undefined;
        }
      } catch { /* fall through */ }
    }
    const single = toNum(trimmed);
    return single !== null ? [single] : undefined;
  }
  const single = toNum(v);
  return single !== null ? [single] : undefined;
}

/**
 * Helper: Defensives Object-Array. Akzeptiert Array, JSON-String, Single-Object.
 * Filtert non-objects raus.
 */
export function objArray<T extends Record<string, unknown>>(
  args: Record<string, unknown>,
  key: string,
): T[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (Array.isArray(v)) {
    const out = v.filter((x): x is T => typeof x === 'object' && x !== null && !Array.isArray(x));
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return undefined;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const out = parsed.filter((x): x is T => typeof x === 'object' && x !== null && !Array.isArray(x));
        return out.length > 0 ? out : undefined;
      }
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return [parsed as T];
      }
    } catch { /* fall through */ }
  }
  if (typeof v === 'object' && !Array.isArray(v)) {
    return [v as T];
  }
  return undefined;
}
