/**
 * MODUL: Code-Intelligence Service
 * ZWECK: Strukturierte Code-Abfragen via PostgreSQL — kein Qdrant
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - filePath: string - Optionaler Datei-Pfad-Filter
 *   - name: string - Optionaler Symbol-Name-Filter
 *   - query: string - Suchbegriff fuer Volltext-Suche
 *
 * OUTPUT:
 *   - string: Formatierter Projekt-Baum (getProjectTree)
 *   - Array<object>: Symbol-Listen (getFunctions, getVariables, getSymbols)
 *   - object: Referenz-Info (getReferences)
 *   - Array<object>: Volltext-Suchergebnisse (fullTextSearchCode)
 *   - object | null: Dateiinhalt (getFileContent)
 *
 * ABHÄNGIGKEITEN:
 *   - ../db/client.js (intern) - PostgreSQL-Verbindung
 *
 * HINWEISE:
 *   - Alle Abfragen sind PG-only (kein Qdrant)
 *   - Projekt-Isolation: Alle Queries filtern nach project
 *   - fullTextSearchCode ist bewusst abweichend benannt von searchCode (code.ts)
 */

import { getPool } from '../db/client.js';

// ─── getProjectTree ───────────────────────────────────────────────────────────

/**
 * Gibt einen formatierten Projekt-Baum zurueck.
 * detail='minimal': nur Dateinamen + Zeilenzahl
 * detail='normal': + erster Block-Kommentar aus code_symbols
 * detail='full': + Funktionen und Imports
 */
export async function getProjectTree(
  project: string,
  dirPath?: string,
  detail: 'minimal' | 'normal' | 'full' = 'normal'
): Promise<string> {
  const pool = getPool();

  // Basis-Query: Dateien mit Symbol-Count und Zeilenzahl
  const params: unknown[] = [project];
  let where = 'WHERE cf.project = $1';
  if (dirPath) {
    params.push(`${dirPath}%`);
    where += ` AND cf.file_path LIKE $${params.length}`;
  }

  const filesResult = await pool.query(
    `SELECT
       cf.file_path,
       cf.file_name,
       cf.file_type,
       cf.file_size,
       (length(cf.content) - length(replace(cf.content, E'\\n', '')) + 1) AS line_count,
       COUNT(cs.id) AS symbol_count
     FROM code_files cf
     LEFT JOIN code_symbols cs ON cs.project = cf.project AND cs.file_path = cf.file_path
     ${where}
     GROUP BY cf.file_path, cf.file_name, cf.file_type, cf.file_size, cf.content
     ORDER BY cf.file_path`,
    params
  );

  if (filesResult.rows.length === 0) {
    return `Kein Code indexiert fuer Projekt "${project}"${dirPath ? ` unter ${dirPath}` : ''}.`;
  }

  const lines: string[] = [`# Projekt-Baum: ${project}`, ''];

  for (const row of filesResult.rows) {
    const lineCount = row.line_count ?? 0;
    const symbolCount = parseInt(row.symbol_count, 10) ?? 0;

    // Minimal: nur Pfad + Metadaten
    lines.push(`## ${row.file_path}`);
    lines.push(`   Typ: ${row.file_type} | Zeilen: ${lineCount} | Symbole: ${symbolCount}`);

    if (detail === 'normal' || detail === 'full') {
      // Ersten Block-Kommentar laden (JSDoc / block comment)
      const commentResult = await pool.query(
        `SELECT value FROM code_symbols
         WHERE project = $1 AND file_path = $2 AND symbol_type = 'comment'
         ORDER BY line_start
         LIMIT 2`,
        [project, row.file_path]
      );
      if (commentResult.rows.length > 0) {
        const comment = commentResult.rows[0].value ?? '';
        const preview = comment.split('\n').slice(0, 3).join(' ').trim().replace(/\s+/g, ' ');
        if (preview) lines.push(`   Kommentar: ${preview.substring(0, 120)}`);
      }
    }

    if (detail === 'full') {
      // Funktionen auflisten
      const funcsResult = await pool.query(
        `SELECT name, is_exported FROM code_symbols
         WHERE project = $1 AND file_path = $2 AND symbol_type = 'function'
         ORDER BY line_start`,
        [project, row.file_path]
      );
      if (funcsResult.rows.length > 0) {
        const names = funcsResult.rows
          .map((f: { name: string; is_exported: boolean }) => (f.is_exported ? `export ${f.name}` : f.name))
          .join(', ');
        lines.push(`   Funktionen: ${names}`);
      }

      // Imports auflisten
      const importsResult = await pool.query(
        `SELECT name FROM code_symbols
         WHERE project = $1 AND file_path = $2 AND symbol_type = 'import'
         ORDER BY line_start
         LIMIT 10`,
        [project, row.file_path]
      );
      if (importsResult.rows.length > 0) {
        const importNames = importsResult.rows.map((i: { name: string }) => i.name).join(', ');
        lines.push(`   Imports: ${importNames}`);
      }
    }

    lines.push('');
  }

  lines.push(`---`);
  lines.push(`Gesamt: ${filesResult.rows.length} Dateien`);

  return lines.join('\n');
}

// ─── getFunctions ─────────────────────────────────────────────────────────────

export interface FunctionInfo {
  id: string;
  file_path: string;
  name: string;
  line_start: number;
  line_end: number | null;
  params: string | null;
  return_type: string | null;
  is_exported: boolean;
  parent_name: string | null;
  usage_count: number;
}

/**
 * Gibt alle Funktionen eines Projekts zurueck.
 * Beinhaltet usage_count (aus code_references) und parent_name (aus self-join).
 */
export async function getFunctions(
  project: string,
  filePath?: string,
  name?: string,
  exportedOnly?: boolean
): Promise<FunctionInfo[]> {
  const pool = getPool();

  const params: unknown[] = [project];
  const conditions: string[] = ['cs.project = $1', "cs.symbol_type = 'function'"];

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`cs.file_path LIKE $${params.length}`);
  }
  if (name) {
    params.push(`%${name}%`);
    conditions.push(`cs.name ILIKE $${params.length}`);
  }
  if (exportedOnly) {
    conditions.push('cs.is_exported = true');
  }

  const where = conditions.join(' AND ');

  const result = await pool.query(
    `SELECT
       cs.id,
       cs.file_path,
       cs.name,
       cs.line_start,
       cs.line_end,
       cs.params,
       cs.return_type,
       cs.is_exported,
       parent.name AS parent_name,
       COUNT(cr.id) AS usage_count
     FROM code_symbols cs
     LEFT JOIN code_symbols parent ON parent.id = cs.parent_symbol
     LEFT JOIN code_references cr ON cr.symbol_id = cs.id
     WHERE ${where}
     GROUP BY cs.id, cs.file_path, cs.name, cs.line_start, cs.line_end,
              cs.params, cs.return_type, cs.is_exported, parent.name
     ORDER BY cs.file_path, cs.line_start`,
    params
  );

  return result.rows.map(row => ({
    id: row.id,
    file_path: row.file_path,
    name: row.name,
    line_start: row.line_start,
    line_end: row.line_end,
    params: row.params,
    return_type: row.return_type,
    is_exported: row.is_exported,
    parent_name: row.parent_name ?? null,
    usage_count: parseInt(row.usage_count, 10),
  }));
}

// ─── getVariables ─────────────────────────────────────────────────────────────

export interface VariableInfo {
  id: string;
  file_path: string;
  name: string;
  line_start: number;
  line_end: number | null;
  is_exported: boolean;
  value?: string | null;
}

/**
 * Gibt alle Variablen eines Projekts zurueck.
 * value wird nur zurueckgegeben wenn withValues=true.
 */
export async function getVariables(
  project: string,
  filePath?: string,
  name?: string,
  withValues?: boolean
): Promise<VariableInfo[]> {
  const pool = getPool();

  const params: unknown[] = [project];
  const conditions: string[] = ['cs.project = $1', "cs.symbol_type = 'variable'"];

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`cs.file_path LIKE $${params.length}`);
  }
  if (name) {
    params.push(`%${name}%`);
    conditions.push(`cs.name ILIKE $${params.length}`);
  }

  const where = conditions.join(' AND ');
  const valueCol = withValues ? ', cs.value' : '';

  const result = await pool.query(
    `SELECT
       cs.id,
       cs.file_path,
       cs.name,
       cs.line_start,
       cs.line_end,
       cs.is_exported
       ${valueCol}
     FROM code_symbols cs
     WHERE ${where}
     ORDER BY cs.file_path, cs.line_start`,
    params
  );

  return result.rows.map(row => {
    const info: VariableInfo = {
      id: row.id,
      file_path: row.file_path,
      name: row.name,
      line_start: row.line_start,
      line_end: row.line_end,
      is_exported: row.is_exported,
    };
    if (withValues) info.value = row.value ?? null;
    return info;
  });
}

// ─── getSymbols ───────────────────────────────────────────────────────────────

export interface SymbolInfo {
  id: string;
  file_path: string;
  symbol_type: string;
  name: string | null;
  line_start: number;
  line_end: number | null;
  is_exported: boolean;
  value: string | null;
}

/**
 * Generische Symbol-Abfrage fuer beliebige symbol_type Werte.
 */
export async function getSymbols(
  project: string,
  symbolType: string,
  filePath?: string,
  name?: string
): Promise<SymbolInfo[]> {
  const pool = getPool();

  const params: unknown[] = [project, symbolType];
  const conditions: string[] = ['cs.project = $1', 'cs.symbol_type = $2'];

  if (filePath) {
    params.push(`%${filePath}%`);
    conditions.push(`cs.file_path LIKE $${params.length}`);
  }
  if (name) {
    params.push(`%${name}%`);
    conditions.push(`cs.name ILIKE $${params.length}`);
  }

  const where = conditions.join(' AND ');

  const result = await pool.query(
    `SELECT
       cs.id,
       cs.file_path,
       cs.symbol_type,
       cs.name,
       cs.line_start,
       cs.line_end,
       cs.is_exported,
       cs.value
     FROM code_symbols cs
     WHERE ${where}
     ORDER BY cs.file_path, cs.line_start`,
    params
  );

  return result.rows.map(row => ({
    id: row.id,
    file_path: row.file_path,
    symbol_type: row.symbol_type,
    name: row.name ?? null,
    line_start: row.line_start,
    line_end: row.line_end,
    is_exported: row.is_exported,
    value: row.value ?? null,
  }));
}

// ─── getReferences ────────────────────────────────────────────────────────────

export interface ReferenceInfo {
  symbol_id: string;
  file_path: string;
  line_number: number;
  context: string | null;
}

export interface ReferencesResult {
  definition: {
    id: string;
    file_path: string;
    symbol_type: string;
    name: string;
    line_start: number;
    is_exported: boolean;
  } | null;
  references: ReferenceInfo[];
  total_files: number;
  total_references: number;
}

/**
 * Findet die Definition und alle Referenzen eines Symbols per Name.
 */
export async function getReferences(
  project: string,
  name: string
): Promise<ReferencesResult> {
  const pool = getPool();

  // Definition laden
  const defResult = await pool.query(
    `SELECT id, file_path, symbol_type, name, line_start, is_exported
     FROM code_symbols
     WHERE project = $1 AND name = $2
     ORDER BY line_start
     LIMIT 1`,
    [project, name]
  );

  const definition = defResult.rows[0]
    ? {
        id: defResult.rows[0].id,
        file_path: defResult.rows[0].file_path,
        symbol_type: defResult.rows[0].symbol_type,
        name: defResult.rows[0].name,
        line_start: defResult.rows[0].line_start,
        is_exported: defResult.rows[0].is_exported,
      }
    : null;

  // Alle Referenzen laden (ueber code_references JOIN code_symbols)
  const refsResult = await pool.query(
    `SELECT cr.symbol_id, cr.file_path, cr.line_number, cr.context
     FROM code_references cr
     JOIN code_symbols cs ON cs.id = cr.symbol_id
     WHERE cr.project = $1 AND cs.name = $2
     ORDER BY cr.file_path, cr.line_number`,
    [project, name]
  );

  const references: ReferenceInfo[] = refsResult.rows.map(row => ({
    symbol_id: row.symbol_id,
    file_path: row.file_path,
    line_number: row.line_number,
    context: row.context ?? null,
  }));

  // Eindeutige Dateien zaehlen
  const uniqueFiles = new Set(references.map(r => r.file_path));

  return {
    definition,
    references,
    total_files: uniqueFiles.size,
    total_references: references.length,
  };
}

// ─── fullTextSearchCode ───────────────────────────────────────────────────────

export interface FullTextSearchResult {
  file_path: string;
  file_type: string;
  headline: string;
  rank: number;
}

/**
 * Volltext-Suche in code_files via PostgreSQL tsvector.
 * Trennt Query-Woerter mit ' & ' fuer AND-Suche.
 * Gibt file_path, ts_headline und ts_rank zurueck.
 *
 * HINWEIS: Bewusst nicht "searchCode" (belegt durch code.ts — semantische Qdrant-Suche)
 */
export async function fullTextSearchCode(
  project: string,
  query: string,
  fileType?: string,
  limit: number = 20
): Promise<FullTextSearchResult[]> {
  const pool = getPool();

  // Query-Woerter mit & verbinden fuer AND-Semantik
  const tsQuery = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' & ');

  if (!tsQuery) return [];

  const params: unknown[] = [project, tsQuery];
  let typeFilter = '';
  if (fileType) {
    params.push(fileType);
    typeFilter = `AND file_type = $${params.length}`;
  }
  params.push(limit);

  const result = await pool.query(
    `SELECT
       file_path,
       file_type,
       ts_headline('english', content, to_tsquery('english', $2),
         'MaxWords=20, MinWords=5, ShortWord=3, HighlightAll=false,
          MaxFragments=2, FragmentDelimiter='' ... ''') AS headline,
       ts_rank(tsv, to_tsquery('english', $2)) AS rank
     FROM code_files
     WHERE project = $1
       AND tsv @@ to_tsquery('english', $2)
       ${typeFilter}
     ORDER BY rank DESC
     LIMIT $${params.length}`,
    params
  );

  return result.rows.map(row => ({
    file_path: row.file_path,
    file_type: row.file_type,
    headline: row.headline ?? '',
    rank: parseFloat(row.rank),
  }));
}

// ─── getFileContent ───────────────────────────────────────────────────────────

export interface FileContentResult {
  file_path: string;
  file_type: string;
  file_size: number;
  content: string;
}

/**
 * Laedt den Inhalt einer Datei aus PostgreSQL.
 * filePath wird als LIKE-Pattern verwendet ('%filePath%').
 * Gibt null zurueck wenn nicht gefunden.
 */
export async function getFileContent(
  project: string,
  filePath: string
): Promise<FileContentResult | null> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT file_path, file_type, file_size, content
     FROM code_files
     WHERE project = $1 AND file_path LIKE $2
     ORDER BY file_path
     LIMIT 1`,
    [project, `%${filePath}%`]
  );

  if (!result.rows[0]) return null;
  const row = result.rows[0];

  return {
    file_path: row.file_path,
    file_type: row.file_type,
    file_size: row.file_size ?? 0,
    content: row.content ?? '',
  };
}
