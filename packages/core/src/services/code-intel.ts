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
 * Tree-Optionen — jeder Aspekt einzeln steuerbar.
 * KI entscheidet selbst welche Details sie braucht.
 */
export interface TreeOptions {
  /** Verzeichnis-Filter (zeigt nur Dateien unter diesem Pfad) */
  path?: string;
  /** false = nur Dateien direkt im Verzeichnis, true = auch Unterverzeichnisse (Standard: true) */
  recursive?: boolean;
  /** Max. Verzeichnis-Tiefe relativ zum path (0 = nur das Verzeichnis selbst) */
  depth?: number;
  /** Zeilenzahl pro Datei anzeigen (Standard: true) */
  show_lines?: boolean;
  /** Funktions-/Variablen-Counts anzeigen (Standard: true) */
  show_counts?: boolean;
  /** Kommentare unter Dateien anzeigen (Standard: false) */
  show_comments?: boolean;
  /** Funktionsnamen auflisten (Standard: false) */
  show_functions?: boolean;
  /** Import-Statements auflisten (Standard: false) */
  show_imports?: boolean;
  /** Nur Dateien mit bestimmtem Typ (z.B. 'typescript', 'sql') */
  file_type?: string;
}

/**
 * Gibt einen formatierten Projekt-Baum zurueck.
 * Dateien werden nach Verzeichnis gruppiert, Pfade relativ zum Projekt-Root.
 * Jeder Aspekt ist einzeln steuerbar ueber TreeOptions.
 */
export async function getProjectTree(
  project: string,
  options: TreeOptions = {}
): Promise<string> {
  const pool = getPool();
  const {
    path: dirPath,
    recursive = true,
    depth,
    show_lines = true,
    show_counts = true,
    show_comments = false,
    show_functions = false,
    show_imports = false,
    file_type,
  } = options;

  // Projekt-Root-Pfad aus projects-Tabelle holen
  let projectRoot = '';
  try {
    const rootResult = await pool.query<{ path: string }>(
      `SELECT path FROM projects WHERE name = $1 ORDER BY last_access DESC LIMIT 1`,
      [project]
    );
    if (rootResult.rows.length > 0) {
      projectRoot = rootResult.rows[0].path;
      if (!projectRoot.endsWith('/')) projectRoot += '/';
    }
  } catch {
    // Tabelle existiert noch nicht — Fallback: leerer Root (relative Pfade direkt)
  }

  // Basis-Query
  const params: unknown[] = [project];
  let where = 'WHERE cf.project = $1';
  if (dirPath) {
    if (recursive) {
      // Rekursiv: alle Dateien die den Pfad enthalten
      params.push(`%${dirPath}%`);
      where += ` AND cf.file_path LIKE $${params.length}`;
    } else {
      // Nicht-rekursiv: nur Dateien direkt in diesem Verzeichnis
      // Pfad muss den dir enthalten, aber danach darf kein weiterer / kommen (ausser am Ende des file_path)
      params.push(`%${dirPath}%`);
      where += ` AND cf.file_path LIKE $${params.length}`;
      // Nachfilterung in JS (PG LIKE kann nicht "kein / nach dem Match" pruefen)
    }
  }
  if (file_type) {
    params.push(file_type);
    where += ` AND cf.file_type = $${params.length}`;
  }

  // Counts nur laden wenn gewuenscht (spart Subqueries)
  const countCols = show_counts
    ? `, (SELECT COUNT(*) FROM code_symbols cs WHERE cs.project = cf.project AND cs.file_path = cf.file_path AND cs.symbol_type = 'function') AS fn_count,
         (SELECT COUNT(*) FROM code_symbols cs WHERE cs.project = cf.project AND cs.file_path = cf.file_path AND cs.symbol_type = 'variable') AS var_count`
    : '';
  const lineCols = show_lines
    ? `, (length(cf.content) - length(replace(cf.content, E'\\n', '')) + 1) AS line_count`
    : '';

  const filesResult = await pool.query(
    `SELECT cf.file_path, cf.file_name, cf.file_type ${lineCols} ${countCols}
     FROM code_files cf ${where} ORDER BY cf.file_path`,
    params
  );

  if (filesResult.rows.length === 0) {
    return `Kein Code indexiert fuer Projekt "${project}"${dirPath ? ` unter ${dirPath}` : ''}.`;
  }

  // Dateien nach Verzeichnis gruppieren
  // Bei dirPath: Basis-Tiefe berechnen fuer relative depth-Filterung
  const dirMap = new Map<string, Array<typeof filesResult.rows[0]>>();
  let baseDirDepth = 0;
  if (dirPath) {
    baseDirDepth = dirPath.split('/').filter(Boolean).length;
  }

  for (const row of filesResult.rows) {
    const relPath = row.file_path;  // bereits relativ
    row._relPath = relPath;
    const dir = relPath.substring(0, relPath.lastIndexOf('/') + 1) || '/';
    const dirDepth = dir.split('/').filter(Boolean).length;

    // Nicht-rekursiv: nur Dateien deren Verzeichnis-Tiefe == baseDirDepth
    if (!recursive && dirPath && dirDepth > baseDirDepth) continue;

    // Depth-Filter: relativ zum Basis-Verzeichnis
    if (depth !== undefined) {
      const relativeDepth = dirDepth - baseDirDepth;
      if (relativeDepth > depth) continue;
    }

    if (!dirMap.has(dir)) dirMap.set(dir, []);
    dirMap.get(dir)!.push(row);
  }

  const lines: string[] = [];

  for (const [dir, files] of dirMap) {
    // Verzeichnis-Header
    const dirMeta: string[] = [`${files.length} Dateien`];
    if (show_counts) {
      const fnTotal = files.reduce((s, f) => s + parseInt(f.fn_count ?? '0', 10), 0);
      const varTotal = files.reduce((s, f) => s + parseInt(f.var_count ?? '0', 10), 0);
      if (fnTotal > 0) dirMeta.push(`${fnTotal}fn`);
      if (varTotal > 0) dirMeta.push(`${varTotal}var`);
    }
    lines.push(`${dir} (${dirMeta.join(', ')})`);

    // Dateien
    for (const f of files) {
      const fileMeta: string[] = [];
      if (show_lines && f.line_count) fileMeta.push(`${f.line_count}Z`);
      if (show_counts) {
        const fn = parseInt(f.fn_count ?? '0', 10);
        const v = parseInt(f.var_count ?? '0', 10);
        if (fn > 0) fileMeta.push(`${fn}fn`);
        if (v > 0) fileMeta.push(`${v}var`);
      }
      const metaStr = fileMeta.length > 0 ? ` (${fileMeta.join(', ')})` : '';
      lines.push(`  ${f.file_name}${metaStr}`);

      // Kommentare
      if (show_comments) {
        const commentResult = await pool.query(
          `SELECT value FROM code_symbols
           WHERE project = $1 AND file_path = $2 AND symbol_type = 'comment'
           ORDER BY line_start LIMIT 1`,
          [project, f.file_path]
        );
        if (commentResult.rows.length > 0) {
          const comment = (commentResult.rows[0].value ?? '').split('\n')[0].trim().replace(/\s+/g, ' ');
          if (comment) lines.push(`    /** ${comment.substring(0, 100)} */`);
        }
      }

      // Funktionen
      if (show_functions) {
        const funcsResult = await pool.query(
          `SELECT name, is_exported FROM code_symbols
           WHERE project = $1 AND file_path = $2 AND symbol_type = 'function'
           ORDER BY line_start`,
          [project, f.file_path]
        );
        if (funcsResult.rows.length > 0) {
          const names = funcsResult.rows
            .map((fn: { name: string; is_exported: boolean }) => (fn.is_exported ? `+${fn.name}` : fn.name))
            .join(', ');
          lines.push(`    fn: ${names}`);
        }
      }

      // Imports
      if (show_imports) {
        const importsResult = await pool.query(
          `SELECT name, value FROM code_symbols
           WHERE project = $1 AND file_path = $2 AND symbol_type = 'import'
           ORDER BY line_start`,
          [project, f.file_path]
        );
        if (importsResult.rows.length > 0) {
          for (const imp of importsResult.rows) {
            lines.push(`    from "${imp.value}": ${imp.name}`);
          }
        }
      }
    }
  }

  lines.push(`---`);
  lines.push(`${filesResult.rows.length} Dateien | Root: ${projectRoot}`);

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

export interface StringOccurrenceInfo {
  file_path: string;
  line_number: number;
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
  string_occurrences: StringOccurrenceInfo[];
  total_string_occurrences: number;
}

/**
 * Findet die Definition und alle Referenzen eines Symbols per Name.
 */
export async function getReferences(
  project: string,
  name: string
): Promise<ReferencesResult> {
  const pool = getPool();

  // Definition laden — non-string bevorzugen (echte Deklaration vor String-Literal)
  const defResult = await pool.query(
    `SELECT id, file_path, symbol_type, name, line_start, is_exported
     FROM code_symbols
     WHERE project = $1 AND name = $2
     ORDER BY CASE WHEN symbol_type = 'string' THEN 1 ELSE 0 END, line_start
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

  // String-Literale: separate Liste aller Vorkommen (Parser speichert jedes String-Literal
  // als eigenes code_symbol mit symbol_type='string').
  const stringRows = await pool.query(
    `SELECT file_path, line_start
     FROM code_symbols
     WHERE project = $1 AND name = $2 AND symbol_type = 'string'
     ORDER BY file_path, line_start`,
    [project, name]
  );
  const stringOccurrences: StringOccurrenceInfo[] = stringRows.rows.map(row => ({
    file_path: row.file_path,
    line_number: row.line_start,
  }));

  // Eindeutige Dateien zaehlen
  const uniqueFiles = new Set(references.map(r => r.file_path));

  return {
    definition,
    references,
    total_files: uniqueFiles.size,
    total_references: references.length,
    string_occurrences: stringOccurrences,
    total_string_occurrences: stringOccurrences.length,
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

  const cleanQuery = query.trim();
  if (!cleanQuery) return [];

  const params: unknown[] = [project, cleanQuery];
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
       ts_headline('english', content, plainto_tsquery('english', $2),
         'MaxWords=20, MinWords=5, ShortWord=3, HighlightAll=false,
          MaxFragments=2, FragmentDelimiter='' ... ''') AS headline,
       ts_rank(tsv, plainto_tsquery('english', $2)) AS rank
     FROM code_files
     WHERE project = $1
       AND tsv @@ plainto_tsquery('english', $2)
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

/** Max. Zeichen im content-Feld bevor Auto-Reduce greift. */
const FILE_CONTENT_MAX_CHARS = 80_000;

export interface FileContentResult {
  file_path: string;
  file_type: string;
  file_size: number;
  content: string;
  /** Gesamtzahl der Zeilen in der Datei (unabhaengig von from/to). */
  total_lines: number;
  /** Tatsaechlich gelieferte Zeilen-Range (1-basiert, inklusiv). */
  returned_range: { from: number; to: number; eof: boolean };
}

/**
 * Optionen fuer getFileContent und applyContentRange.
 */
export interface FileContentOptions {
  /** 1-basierte Start-Zeile (Standard: 1). */
  from?: number;
  /** 1-basierte End-Zeile inklusiv (Standard: letzte Zeile). */
  to?: number;
  /**
   * Zeilen die laenger als dieser Wert sind werden auf diesen Wert gekuerzt
   * und mit einem Marker versehen. 0 = deaktiviert (Standard).
   */
  truncate_long_lines?: number;
}

/**
 * Wendet Zeilen-Range, truncate_long_lines und Auto-Reduce auf rohen Datei-
 * Inhalt an. Kann unabhaengig von der DB-Abfrage genutzt werden.
 */
export function applyContentRange(
  rawContent: string,
  options: FileContentOptions = {}
): { content: string; total_lines: number; returned_range: { from: number; to: number; eof: boolean } } {
  const lines = rawContent.split('\n');
  const total_lines = lines.length;

  const from = Math.max(1, options.from ?? 1);
  const toRequested = options.to ?? total_lines;
  const truncAt = options.truncate_long_lines ?? 0;

  // truncate_long_lines ZUERST anwenden (damit Auto-Reduce korrekt zaehlt)
  const processedLines = truncAt > 0
    ? lines.map(line =>
        line.length > truncAt
          ? line.slice(0, truncAt) + `…[truncated, full length ${line.length} chars]…`
          : line
      )
    : lines;

  // Zeilen-Range ausschneiden (0-basiert intern)
  const fromIdx = from - 1;
  const toIdx = Math.min(toRequested, total_lines) - 1;
  let selectedLines = processedLines.slice(fromIdx, toIdx + 1);
  let actualTo = Math.min(toRequested, total_lines);

  // Auto-Reduce: Wenn Content > FILE_CONTENT_MAX_CHARS → auf passende Zeilen kuerzen
  let joined = selectedLines.join('\n');
  if (joined.length > FILE_CONTENT_MAX_CHARS) {
    let charCount = 0;
    let fitCount = 0;
    for (let i = 0; i < selectedLines.length; i++) {
      const lineLen = selectedLines[i].length + (i > 0 ? 1 : 0); // +1 fuer \n (ausser erste Zeile)
      if (charCount + lineLen > FILE_CONTENT_MAX_CHARS) break;
      charCount += lineLen;
      fitCount++;
    }
    if (fitCount === 0) fitCount = 1; // mindestens 1 Zeile liefern
    selectedLines = selectedLines.slice(0, fitCount);
    actualTo = from + fitCount - 1;
    joined = selectedLines.join('\n');
  }

  return {
    content: joined,
    total_lines,
    returned_range: {
      from,
      to: actualTo,
      eof: actualTo >= total_lines,
    },
  };
}

/**
 * Laedt den Inhalt einer Datei aus PostgreSQL.
 * filePath wird als LIKE-Pattern verwendet ('%filePath%').
 * Gibt null zurueck wenn nicht gefunden.
 *
 * Unterstuetzt optionale Range- und Truncation-Parameter:
 * - from / to: Zeilen-Range (1-basiert, inklusiv)
 * - truncate_long_lines: Zeilen auf N Zeichen kuerzen
 * - Auto-Reduce bei > 80k Zeichen im content
 */
export async function getFileContent(
  project: string,
  filePath: string,
  options?: FileContentOptions
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

  const ranged = applyContentRange(row.content ?? '', options);

  return {
    file_path: row.file_path,
    file_type: row.file_type,
    file_size: row.file_size ?? 0,
    ...ranged,
  };
}
