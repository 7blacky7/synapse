/**
 * MODUL: SQL-Embedded-Detection-Helpers.
 * ZWECK: Geteilt von Sprach-Parsern die embedded SQL erkennen wollen
 *        (z.B. db.exec(`CREATE...`), cursor.execute('SELECT...')).
 *
 * Workflow: Sprach-Parser findet einen String/Template der mit DDL/DML-Keyword
 * beginnt → ruft parseEmbeddedSql() mit dem Inhalt + Line-Offset → bekommt
 * ParsedSymbols zurueck (table/column/index/view/etc) mit korrekt
 * versetzten line_start/line_end-Feldern.
 */

import { sqlParser } from '../sql.js';
import type { ParsedSymbol } from '../types.js';

/**
 * SQL-DDL/DML-Keywords die ein SQL-Statement starten. Wird verwendet um zu
 * entscheiden ob ein String-Inhalt SQL ist (vs. zufaelliger Text).
 */
export const SQL_KEYWORD_RE =
  /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|SELECT|WITH|TRUNCATE|REPLACE)\s+/i;

/**
 * Method-Namen die typischerweise SQL als erstes Argument bekommen.
 * Geteilt zwischen Sprachen — viele DB-Libraries nutzen aehnliche Namen.
 */
export const SQL_DB_METHODS: ReadonlySet<string> = new Set([
  // Generisch (better-sqlite3, pg, mysql2, sqlite3 node, etc.)
  'exec', 'prepare', 'query', 'run', 'all', 'get', 'execute',
  // Python-Cursor (DB-API)
  // 'execute', 'executemany' — execute ist schon drin, executemany separat:
  'executemany',
  // Rust sqlx (query!, query_as!) sind Macros, nicht Method-Calls — separat
  // Java JdbcTemplate
  'queryForList', 'queryForObject', 'update',
]);

/**
 * Tag-Namen fuer Tagged Templates die SQL signalisieren.
 * Beispiele: sql`SELECT...`, gql`...` (graphql-tag, anderer Use-Case).
 */
export const SQL_TAGS: ReadonlySet<string> = new Set(['sql', 'SQL', 'pgsql']);

/**
 * Sub-parsed einen SQL-String-Inhalt mit dem SQL-Parser und passt die
 * line_start/line_end Felder an, sodass sie sich auf die ENCLOSING-Datei
 * (TS, Python, Go, etc.) beziehen — nicht auf die SQL-Region selbst.
 *
 * @param sqlContent  Der SQL-Source-Code (Inhalt zwischen Backticks/Quotes)
 * @param filePath    Datei-Pfad fuer Debug-Output
 * @param baseLine    Die Zeile in der enclosing-Datei wo das SQL beginnt
 *                    (1-basiert). Beispiel: wenn `sql\`CREATE...\`` in TS auf
 *                    Zeile 42 beginnt, ist baseLine = 42, dann landet die
 *                    erste SQL-Zeile in line_start = 42.
 */
export function parseEmbeddedSql(
  sqlContent: string,
  filePath: string,
  baseLine: number,
): ParsedSymbol[] {
  try {
    const result = sqlParser.parse(sqlContent, filePath);
    return result.symbols.map(s => ({
      ...s,
      line_start: s.line_start + baseLine - 1,
      line_end: s.line_end !== undefined ? s.line_end + baseLine - 1 : undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Pruefen ob ein String-Inhalt wahrscheinlich SQL ist. Schneller Filter
 * vor parseEmbeddedSql() um false-positives zu vermeiden.
 */
export function looksLikeSql(content: string | null | undefined): content is string {
  return typeof content === 'string' && SQL_KEYWORD_RE.test(content);
}
