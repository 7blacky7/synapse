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

/** Helper: Extrahiert einen Number-Parameter */
export function num(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  return typeof val === 'number' ? val : undefined;
}

/** Helper: Extrahiert einen Boolean-Parameter */
export function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = args[key];
  return typeof val === 'boolean' ? val : undefined;
}
