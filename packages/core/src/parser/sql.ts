/**
 * MODUL: SQL Parser
 * ZWECK: Extrahiert Struktur-Informationen aus SQL-Dateien (DDL, DML, Funktionen)
 *
 * EXTRAHIERT: table, column, index, view, function, trigger, constraint, comment, todo
 * ANSATZ: Regex-basiert — SQL hat strukturierte Syntax ohne tiefe Verschachtelung
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

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

    return { symbols, references };
  }
}

export const sqlParser = new SqlParser();
