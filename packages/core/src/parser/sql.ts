/**
 * MODUL: SQL Parser
 * ZWECK: Extrahiert Struktur-Informationen aus SQL-Dateien (DDL, DML, Funktionen)
 *
 * EXTRAHIERT: table, column, index, view, function, trigger, constraint, comment, todo
 * ANSATZ: Regex-basiert — SQL hat strukturierte Syntax ohne tiefe Verschachtelung
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';

/** Zeilennummer fuer eine Position im Text (1-basiert) */
function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

/** Endzeile eines Matches */
function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

/** Entfernt fuehrende/schliesende Whitespace + ueberfluessige Leerzeichen */
function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Entfernt SQL-Kommentare aus einem String (fuer sauberes Parsen) */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

class SqlParser implements LanguageParser {
  language = 'sql';
  extensions = ['.sql', '.pgsql', '.psql', '.plsql', '.ddl', '.dml'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  version = 1;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const tableNames = new Set<string>();

    // ══════════════════════════════════════════════
    // 1. Block-Kommentare (/* ... */)
    // ══════════════════════════════════════════════
    const blockCommentRe = /\/\*([\s\S]*?)\*\//g;
    let m: RegExpExecArray | null;
    while ((m = blockCommentRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 2. TODO / FIXME / HACK (aus -- Kommentaren)
    // ══════════════════════════════════════════════
    const todoRe = /--\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 3. CREATE TABLE
    // ══════════════════════════════════════════════
    const createTableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)\s*\(([\s\S]*?)\);/gi;
    while ((m = createTableRe.exec(content)) !== null) {
      const schema = m[1] || null;
      const tableName = m[2];
      const body = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      tableNames.add(tableName);

      // Spalten und Inline-Constraints parsen
      const columnNames: string[] = [];
      const columnDetails: string[] = [];
      const bodyClean = stripComments(body);
      const parts = bodyClean.split(',');

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;

        // Inline-Constraints (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK)
        const constraintMatch = trimmed.match(
          /^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT\s+(\w+))\s*(.*)/i
        );
        if (constraintMatch) {
          const constraintType = constraintMatch[1].toUpperCase();
          const constraintName = constraintMatch[2] || null;

          // FK-Referenz extrahieren
          const fkMatch = trimmed.match(/REFERENCES\s+(?:(\w+)\.)?(\w+)\s*\(([^)]+)\)/i);
          if (fkMatch) {
            const refTable = fkMatch[2];
            const refCols = fkMatch[3].split(',').map(c => c.trim());
            symbols.push({
              symbol_type: 'constraint',
              name: constraintName || `fk_${tableName}_${refTable}`,
              value: `FOREIGN KEY → ${refTable}(${refCols.join(', ')})`,
              params: refCols,
              line_start: lineAt(content, m.index + body.indexOf(trimmed)),
              is_exported: false,
              parent_id: tableName,
            });
            // Referenz auf die referenzierte Tabelle
            references.push({
              symbol_name: refTable,
              line_number: lineAt(content, m.index + body.indexOf(trimmed)),
              context: clean(trimmed).slice(0, 80),
            });
          } else {
            // PK, UNIQUE, CHECK
            const colsMatch = trimmed.match(/\(([^)]+)\)/);
            const cols = colsMatch ? colsMatch[1].split(',').map(c => c.trim()) : [];
            symbols.push({
              symbol_type: 'constraint',
              name: constraintName || `${constraintType.replace(/\s+/g, '_').toLowerCase()}_${tableName}`,
              value: constraintType,
              params: cols,
              line_start: lineAt(content, m.index + body.indexOf(trimmed)),
              is_exported: false,
              parent_id: tableName,
            });
          }
          continue;
        }

        // Spalte: name TYPE [constraints...]
        const colMatch = trimmed.match(/^(\w+)\s+(.+)/);
        if (colMatch) {
          const colName = colMatch[1].toUpperCase();
          // Skip SQL-Keywords die keine Spaltennamen sind
          if (['PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT', 'INDEX', 'EXCLUDE'].includes(colName)) continue;

          const colDef = clean(colMatch[2]);
          columnNames.push(colMatch[1]);
          columnDetails.push(`${colMatch[1]} ${colDef}`);

          // Inline FK auf Spaltenebene
          const inlineFk = colDef.match(/REFERENCES\s+(?:(\w+)\.)?(\w+)\s*(?:\(([^)]+)\))?/i);
          if (inlineFk) {
            const refTable = inlineFk[2];
            references.push({
              symbol_name: refTable,
              line_number: lineAt(content, m.index + body.indexOf(trimmed)),
              context: clean(trimmed).slice(0, 80),
            });
          }

          // Column als eigenes Symbol
          symbols.push({
            symbol_type: 'column',
            name: colMatch[1],
            value: colDef.slice(0, 200),
            line_start: lineAt(content, m.index + body.indexOf(trimmed)),
            is_exported: false,
            parent_id: tableName,
          });
        }
      }

      // Tabelle selbst
      symbols.push({
        symbol_type: 'table',
        name: tableName,
        value: schema ? `${schema}.${tableName}` : undefined,
        params: columnNames,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. ALTER TABLE
    // ══════════════════════════════════════════════
    const alterTableRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:(\w+)\.)?(\w+)\s+([\s\S]*?);/gi;
    while ((m = alterTableRe.exec(content)) !== null) {
      const tableName = m[2];
      const action = clean(m[3]);
      const lineStart = lineAt(content, m.index);

      // ADD CONSTRAINT (ZUERST pruefen — sonst greift ADD COLUMN faelschlich)
      const addConstraintMatch = action.match(/ADD\s+CONSTRAINT\s+(\w+)\s+(.*)/i);

      // ADD COLUMN (nur wenn kein Constraint)
      if (!addConstraintMatch) {
        const addColMatch = action.match(/ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+(.+)/i);
        if (addColMatch) {
          symbols.push({
            symbol_type: 'column',
            name: addColMatch[1],
            value: clean(addColMatch[2]).slice(0, 200),
            line_start: lineStart,
            is_exported: false,
            parent_id: tableName,
          });
          references.push({
            symbol_name: tableName,
            line_number: lineStart,
            context: clean(m[0]).slice(0, 80),
          });
        }
      }
      if (addConstraintMatch) {
        const constraintName = addConstraintMatch[1];
        const constraintDef = clean(addConstraintMatch[2]);
        const fkRef = constraintDef.match(/REFERENCES\s+(?:(\w+)\.)?(\w+)/i);
        symbols.push({
          symbol_type: 'constraint',
          name: constraintName,
          value: constraintDef.slice(0, 200),
          line_start: lineStart,
          is_exported: false,
          parent_id: tableName,
        });
        if (fkRef) {
          references.push({
            symbol_name: fkRef[2],
            line_number: lineStart,
            context: clean(m[0]).slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 5. CREATE INDEX
    // ══════════════════════════════════════════════
    const createIndexRe = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+(?:(\w+)\.)?(\w+)\s*(?:USING\s+\w+\s*)?\(([^)]+)\)/gi;
    while ((m = createIndexRe.exec(content)) !== null) {
      const indexName = m[1];
      const tableName = m[3];
      const columns = m[4].split(',').map(c => c.trim().replace(/\s+(ASC|DESC)/gi, ''));
      const isUnique = m[0].toUpperCase().includes('UNIQUE');

      symbols.push({
        symbol_type: 'index',
        name: indexName,
        value: tableName,
        params: columns,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });

      references.push({
        symbol_name: tableName,
        line_number: lineAt(content, m.index),
        context: `${isUnique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${tableName}(${columns.join(', ')})`,
      });
    }

    // ══════════════════════════════════════════════
    // 6. CREATE VIEW
    // ══════════════════════════════════════════════
    const createViewRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(\w+)\.)?(\w+)\s+AS\s+([\s\S]*?);/gi;
    while ((m = createViewRe.exec(content)) !== null) {
      const viewName = m[2];
      const query = clean(m[3]).slice(0, 300);

      // Referenzierte Tabellen aus dem SELECT extrahieren
      const fromRe = /\bFROM\s+(\w+)|\bJOIN\s+(\w+)/gi;
      let fromMatch;
      const referencedTables: string[] = [];
      while ((fromMatch = fromRe.exec(m[3])) !== null) {
        const tbl = fromMatch[1] || fromMatch[2];
        if (tbl && !referencedTables.includes(tbl)) {
          referencedTables.push(tbl);
          references.push({
            symbol_name: tbl,
            line_number: lineAt(content, m.index),
            context: `VIEW ${viewName} referenziert ${tbl}`,
          });
        }
      }

      symbols.push({
        symbol_type: 'view',
        name: viewName,
        value: query,
        params: referencedTables,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. CREATE FUNCTION / PROCEDURE
    // ══════════════════════════════════════════════
    const createFuncRe = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:(\w+)\.)?(\w+)\s*\(([^)]*)\)(?:\s+RETURNS\s+(\S+(?:\s+\S+)?))?/gi;
    while ((m = createFuncRe.exec(content)) !== null) {
      const funcName = m[2];
      const paramsRaw = m[3];
      const returnType = m[4] ? clean(m[4]) : undefined;

      // Parameter parsen
      const params = paramsRaw
        .split(',')
        .map(p => clean(p))
        .filter(p => p.length > 0);

      // Endzeile: suche nach $$ ... $$ oder END; oder LANGUAGE
      const afterFunc = content.substring(m.index);
      const funcEndMatch = afterFunc.match(/\$\$[\s\S]*?\$\$/);
      const funcEnd = funcEndMatch
        ? endLineAt(content, m.index, (funcEndMatch.index || 0) + funcEndMatch[0].length)
        : lineAt(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineAt(content, m.index),
        line_end: funcEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. CREATE TRIGGER
    // ══════════════════════════════════════════════
    const createTriggerRe = /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+(\w+)\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+(\w+(?:\s+OR\s+\w+)*)\s+ON\s+(?:(\w+)\.)?(\w+)(?:\s+FOR\s+EACH\s+(?:ROW|STATEMENT))?(?:\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+(\w+))?/gi;
    while ((m = createTriggerRe.exec(content)) !== null) {
      const triggerName = m[1];
      const timing = m[2];
      const events = m[3];
      const tableName = m[5];
      const execFunc = m[6];

      symbols.push({
        symbol_type: 'trigger',
        name: triggerName,
        value: tableName,
        params: [timing, events, ...(execFunc ? [`EXECUTE ${execFunc}`] : [])],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });

      references.push({
        symbol_name: tableName,
        line_number: lineAt(content, m.index),
        context: `TRIGGER ${triggerName} ${timing} ${events} ON ${tableName}`,
      });
      if (execFunc) {
        references.push({
          symbol_name: execFunc,
          line_number: lineAt(content, m.index),
          context: `TRIGGER ${triggerName} EXECUTE ${execFunc}`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 9. Zeilen-Kommentare (-- ...) als comment
    //    Nur am Zeilenanfang, nicht TODO/FIXME
    // ══════════════════════════════════════════════
    const lineCommentRe = /^--\s+(?!TODO|FIXME|HACK)(.+)/gim;
    // Zusammenhaengende Kommentarbloeecke gruppieren
    const lines = content.split('\n');
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('--') && !line.match(/^--\s*(TODO|FIXME|HACK)/i)) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(line.replace(/^--\s?/, ''));
      } else {
        if (commentBlock.length >= 2) { // Nur Bloecke mit 2+ Zeilen
          symbols.push({
            symbol_type: 'comment',
            name: null,
            value: commentBlock.join(' ').trim().slice(0, 500),
            line_start: commentStart,
            line_end: commentStart + commentBlock.length - 1,
            is_exported: false,
          });
        }
        commentBlock = [];
      }
    }
    // Letzten Block nicht vergessen
    if (commentBlock.length >= 2) {
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: commentBlock.join(' ').trim().slice(0, 500),
        line_start: commentStart,
        line_end: commentStart + commentBlock.length - 1,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Referenzen: Tabellennamen in DML (SELECT, INSERT, UPDATE, DELETE)
    // ══════════════════════════════════════════════
    if (tableNames.size > 0) {
      const dmlRe = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+(?:(\w+)\.)?(\w+)/gi;
      while ((m = dmlRe.exec(content)) !== null) {
        const tbl = m[2];
        if (tableNames.has(tbl)) {
          references.push({
            symbol_name: tbl,
            line_number: lineAt(content, m.index),
            context: content.substring(m.index, m.index + 80).replace(/\n/g, ' ').trim(),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 11. DML/DQL Queries → sql_query Symbol + Tabellen-Referenzen
    //     Funktioniert auch wenn CREATE TABLE NICHT im gleichen File steht
    //     (wichtig fuer embedded SQL aus C/Python/Java/etc. via parseEmbeddedSql).
    //     Schema: name="<VERB> <table>", value=Query (gekuerzt), params=[VERB, ...tables]
    // ══════════════════════════════════════════════
    const dmlVerbRe = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/gi;
    while ((m = dmlVerbRe.exec(content)) !== null) {
      const verbRaw = m[1].toUpperCase();
      const verb = verbRaw.split(/\s+/)[0]; // SELECT/INSERT/UPDATE/DELETE
      const lineStart = lineAt(content, m.index);
      const rawWindow = content.substring(m.index, m.index + 500);
      const window = rawWindow.split(';')[0];
      const tables: string[] = [];
      let firstTable: string | undefined;
      if (verb === 'INSERT') {
        const t = /^INSERT\s+INTO\s+(?:(\w+)\.)?(\w+)/i.exec(window);
        if (t) { firstTable = t[2]; tables.push(t[2]); }
      } else if (verb === 'UPDATE') {
        const t = /^UPDATE\s+(?:(\w+)\.)?(\w+)/i.exec(window);
        if (t) { firstTable = t[2]; tables.push(t[2]); }
      } else if (verb === 'DELETE') {
        const t = /^DELETE\s+FROM\s+(?:(\w+)\.)?(\w+)/i.exec(window);
        if (t) { firstTable = t[2]; tables.push(t[2]); }
      } else if (verb === 'SELECT') {
        const t = /\bFROM\s+(?:(\w+)\.)?(\w+)/i.exec(window);
        if (t) { firstTable = t[2]; tables.push(t[2]); }
      }
      // JOIN-Tabellen zusaetzlich erfassen
      const joinRe = /\bJOIN\s+(?:(\w+)\.)?(\w+)/gi;
      let jm: RegExpExecArray | null;
      while ((jm = joinRe.exec(window)) !== null) {
        if (!tables.includes(jm[2])) tables.push(jm[2]);
      }
      if (!firstTable) continue;
      const preview = window.split(';')[0].replace(/\s+/g, ' ').trim().slice(0, 200);
      symbols.push({
        symbol_type: 'sql_query',
        name: `${verb} ${firstTable}`,
        value: preview,
        params: [verb, ...tables],
        line_start: lineStart,
        is_exported: false,
      });
      for (const tbl of tables) {
        references.push({
          symbol_name: tbl,
          line_number: lineStart,
          context: preview.slice(0, 80),
        });
      }
    }


    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    const { statements, callEdges } = extractSqlFlow(content);
    return { symbols, references, statements, callEdges };
  }
}

// ---------------------------------------------------------------------------
// Execution-Flow Extraktion fuer SQL
// Jede SQL-Anweisung = ein Statement in Datei-Reihenfolge (module scope).
// Aufgerufene Funktionen/Prozeduren werden als callEdges erfasst.
// ---------------------------------------------------------------------------
function extractSqlFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = (): string => `s${tempId++}`;
  let orderCounter = 0;

  function lineAt(pos: number): number {
    return content.substring(0, pos).split('\n').length;
  }

  // Strip comments for scanning but keep positions
  function stripForScan(sql: string): string {
    return sql
      .replace(/--[^\n]*/g, m => ' '.repeat(m.length))
      .replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
  }

  const stripped = stripForScan(content);

  // Find statement boundaries by splitting on ';'
  // We track position in original content
  let pos = 0;
  const stmtBoundaries: Array<{ start: number; end: number }> = [];

  let stmtStart = 0;
  // skip leading whitespace/comments
  while (pos < stripped.length) {
    if (stripped[pos] === ';') {
      stmtBoundaries.push({ start: stmtStart, end: pos });
      stmtStart = pos + 1;
    }
    pos++;
  }
  // last statement without trailing ;
  if (stmtStart < stripped.length && stripped.substring(stmtStart).trim()) {
    stmtBoundaries.push({ start: stmtStart, end: stripped.length });
  }

  for (const { start, end } of stmtBoundaries) {
    const raw = content.substring(start, end).trim();
    if (!raw) continue;

    const upper = raw.replace(/\s+/g, ' ').toUpperCase().slice(0, 100);
    const lineStart = lineAt(start + content.substring(start).search(/\S/));
    const lineEnd = lineAt(end);

    // Determine statement type
    let stmtType = 'expression';
    let stmtName: string | undefined;

    if (/^SELECT\b/.test(upper)) { stmtType = 'call'; stmtName = 'SELECT'; }
    else if (/^INSERT\b/.test(upper)) { stmtType = 'call'; stmtName = 'INSERT'; }
    else if (/^UPDATE\b/.test(upper)) { stmtType = 'call'; stmtName = 'UPDATE'; }
    else if (/^DELETE\b/.test(upper)) { stmtType = 'call'; stmtName = 'DELETE'; }
    else if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/.test(upper)) { stmtType = 'variable'; stmtName = 'CREATE FUNCTION'; }
    else if (/^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|INDEX|TRIGGER|SEQUENCE|TYPE)\b/.test(upper)) { stmtType = 'variable'; stmtName = 'CREATE'; }
    else if (/^ALTER\b/.test(upper)) { stmtType = 'assignment'; stmtName = 'ALTER'; }
    else if (/^DROP\b/.test(upper)) { stmtType = 'call'; stmtName = 'DROP'; }
    else if (/^GRANT\b|\bREVOKE\b/.test(upper)) { stmtType = 'assignment'; stmtName = upper.split(' ')[0]; }
    else if (/^BEGIN\b|^START\s+TRANSACTION\b/.test(upper)) { stmtType = 'call'; stmtName = 'BEGIN'; }
    else if (/^COMMIT\b/.test(upper)) { stmtType = 'return'; stmtName = 'COMMIT'; }
    else if (/^ROLLBACK\b/.test(upper)) { stmtType = 'throw'; stmtName = 'ROLLBACK'; }
    else if (/^CALL\b|^EXECUTE\b|^EXEC\b/.test(upper)) { stmtType = 'call'; stmtName = upper.split(/\s+/)[1]; }
    else if (/^SET\b/.test(upper)) { stmtType = 'assignment'; stmtName = 'SET'; }
    else if (/^IF\b/.test(upper)) { stmtType = 'if'; stmtName = 'IF'; }

    const id = nextId();
    const st: ParsedStatement = {
      temp_id: id,
      scope_type: 'module',
      scope_name: null,
      statement_type: stmtType,
      line_start: lineStart,
      line_end: lineEnd,
      order_index: orderCounter++,
      depth: 0,
      is_top_level: true,
      is_awaited: false,
      text: raw.replace(/\s+/g, ' ').slice(0, 240),
      callee: stmtName,
    };
    statements.push(st);

    // Extract CALL/EXECUTE targets and function calls
    const callExecM = /^(?:CALL|EXECUTE|EXEC)\s+(\w+)/i.exec(raw);
    if (callExecM) {
      callEdges.push({ statement_temp_id: id, caller_scope: null, callee_name: callExecM[1], line_number: lineStart, call_kind: 'function' });
    }

    // Extract function calls in expressions: func_name(
    const funcCallRe = /\b([a-zA-Z_]\w+)\s*\(/g;
    const SQL_BUILTINS = new Set(['SELECT','INSERT','UPDATE','DELETE','FROM','WHERE','JOIN','ON','AND','OR','NOT','IN','AS','IF','CASE','WHEN','THEN','ELSE','END','COALESCE','NULLIF','CAST','CONVERT','COUNT','SUM','AVG','MIN','MAX','NOW','DATE','TIME','YEAR','MONTH','DAY']);
    let fm: RegExpExecArray | null;
    while ((fm = funcCallRe.exec(raw)) !== null) {
      const name = fm[1].toUpperCase();
      if (SQL_BUILTINS.has(name)) continue;
      if (/^[A-Z_][A-Z0-9_]*$/.test(name) && name.length > 2) {
        callEdges.push({ statement_temp_id: id, caller_scope: null, callee_name: fm[1], line_number: lineAt(start + fm.index), call_kind: 'function', confidence: 0.7 });
      }
    }
  }

  return { statements, callEdges };
}

export const sqlParser = new SqlParser();
