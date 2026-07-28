/**
 * MODUL: COBOL Parser
 * ZWECK: Extrahiert Struktur-Informationen aus COBOL-Dateien (.cob, .cbl, .cpy)
 *
 * EXTRAHIERT: IDENTIFICATION/PROGRAM-ID, ENVIRONMENT/DATA/PROCEDURE divisions,
 *             SECTION, PARAGRAPH, COPY/REPLACE, FD/SD file descriptions,
 *             01-level data items (records), PERFORM, CALL, comment, todo
 * ANSATZ: Regex-basiert (case-insensitive, column-aware)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

// Zeilenindex je Datei zwischenspeichern — siehe zeileFuerPosition in types.ts.
// Vorher wurde pro Treffer ein Praefix der Datei kopiert und zerlegt: das ist
// O(Treffer x Dateigroesse) und laesst grosse Dateien praktisch nie fertig werden.
let zeilenCacheText: string | null = null;
let zeilenCacheIndex: number[] = [];
function lineAt(text: string, pos: number): number {
  if (text !== zeilenCacheText) {
    zeilenCacheText = text;
    zeilenCacheIndex = erstelleZeilenIndex(text);
  }
  return zeileFuerPosition(zeilenCacheIndex, pos);
}

class CobolParser implements LanguageParser {
  language = 'cobol';
  extensions = ['.cob', '.cbl', '.cpy'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. PROGRAM-ID
    // ══════════════════════════════════════════════
    const progRe = /PROGRAM-ID\.\s+(\S+)/im;
    m = progRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'class',
        name: m[1].replace(/\.$/, ''),
        value: 'PROGRAM-ID',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Divisions
    // ══════════════════════════════════════════════
    const divRe = /^\s{6}\s*(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION/gim;
    while ((m = divRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: `${m[1].toUpperCase()} DIVISION`,
        value: 'division',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Sections
    // ══════════════════════════════════════════════
    const secRe = /^\s{6}\s*([\w-]+)\s+SECTION\s*\./gim;
    while ((m = secRe.exec(content)) !== null) {
      const name = m[1].toUpperCase();
      // Skip standard division sections
      if (['IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE'].includes(name)) continue;
      symbols.push({
        symbol_type: 'class',
        name,
        value: 'SECTION',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Paragraphs (in PROCEDURE DIVISION)
    // ══════════════════════════════════════════════
    const paraRe = /^\s{6}\s*([\w-]+)\s*\.\s*$/gim;
    while ((m = paraRe.exec(content)) !== null) {
      const name = m[1].toUpperCase();
      // Skip keywords
      if (['IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE',
           'WORKING-STORAGE', 'LOCAL-STORAGE', 'LINKAGE', 'FILE',
           'CONFIGURATION', 'INPUT-OUTPUT', 'FD', 'SD', 'COPY',
           'PROGRAM-ID', 'AUTHOR', 'DATE-WRITTEN', 'REMARKS',
           'SOURCE-COMPUTER', 'OBJECT-COMPUTER', 'SPECIAL-NAMES'].includes(name)) continue;
      if (name.endsWith('DIVISION') || name.endsWith('SECTION')) continue;

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'paragraph',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. COPY statements
    // ══════════════════════════════════════════════
    const copyRe = /COPY\s+([\w-]+)/gim;
    while ((m = copyRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: 'COPY',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `COPY ${m[1]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 6. File Descriptions (FD/SD)
    // ══════════════════════════════════════════════
    const fdRe = /^\s{6}\s*(FD|SD)\s+([\w-]+)/gim;
    while ((m = fdRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: m[1].toUpperCase(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Data items (01/77 level)
    // ══════════════════════════════════════════════
    const dataRe = /^\s{6}\s*(01|77)\s+([\w-]+)/gim;
    while ((m = dataRe.exec(content)) !== null) {
      const level = m[1];
      const name = m[2];
      if (name === 'FILLER') continue;

      // Check if it has PIC clause (elementary) or not (group)
      const afterName = content.substring(m.index, m.index + 200);
      const picMatch = afterName.match(/PIC(?:TURE)?\s+IS\s+(\S+)|PIC(?:TURE)?\s+(\S+)/i);
      const value = picMatch ? (picMatch[1] || picMatch[2]) : 'group';

      symbols.push({
        symbol_type: 'variable',
        name,
        value: `${level} ${value}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. PERFORM references
    // ══════════════════════════════════════════════
    const performRe = /PERFORM\s+([\w-]+)/gim;
    while ((m = performRe.exec(content)) !== null) {
      const target = m[1].toUpperCase();
      if (['VARYING', 'UNTIL', 'TIMES', 'WITH', 'TEST'].includes(target)) continue;
      references.push({
        symbol_name: target,
        line_number: lineAt(content, m.index),
        context: `PERFORM ${target}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. CALL references
    // ══════════════════════════════════════════════
    const callRe = /CALL\s+["']([^"']+)["']/gim;
    while ((m = callRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `CALL "${m[1]}"`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK (in comments: * in col 7)
    // ══════════════════════════════════════════════
    const todoRe = /^\s{6}\*\s*(TODO|FIXME|HACK):?\s*(.*)/gim;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 11. Embedded SQL (EXEC SQL ... END-EXEC)
    // ══════════════════════════════════════════════
    const execSqlRe = /EXEC\s+SQL\s+([\s\S]*?)\s+END-EXEC/gi;
    while ((m = execSqlRe.exec(content)) !== null) {
      const sqlBlock = m[1];
      if (!looksLikeSql(sqlBlock)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlBlock, filePath, baseLine));
    }

    const { statements, callEdges } = extractCobolFlow(content);
    return { symbols, references, statements, callEdges };
  }
}

// ---------------------------------------------------------------------------
// Execution-Flow Extraktion fuer COBOL (PROCEDURE DIVISION)
// Paragraphen als Scopes, PERFORM/CALL/IF/EVALUATE/GO TO als Statements
// ---------------------------------------------------------------------------
function extractCobolFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = (): string => `s${tempId++}`;
  const orderCounters = new Map<string, number>();

  function nextOrder(parentId: string | undefined, sc: { n: number }): number {
    if (parentId === undefined) return sc.n++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  // Eigener Index: diese innere Funktion heisst wie die auf Modulebene und wuerde
  // sich beim Umleiten selbst aufrufen. Der Index wird hier einmal gebaut.
  const zeilenIndexLokal = erstelleZeilenIndex(content);
  function lineAt(pos: number): number {
    return zeileFuerPosition(zeilenIndexLokal, pos);
  }

  // Find PROCEDURE DIVISION start
  const procDivM = /PROCEDURE\s+DIVISION/i.exec(content);
  if (!procDivM) return { statements, callEdges };

  const procStart = procDivM.index + procDivM[0].length;
  const procContent = content.substring(procStart);
  const procLines = procContent.split('\n');
  const baseLineOffset = lineAt(procStart);

  // Parse paragraphs: lines matching /^\s{6}\s*([\w-]+)\s*\.\s*$/
  // Each paragraph is a scope. Statements within it are PERFORM, CALL, IF, EVALUATE, GO TO.
  // We process line-by-line.

  let currentParagraph: string | null = null;
  let scopeCounter = { n: 0 };
  // paragraph-level if-stack for nesting
  let ifStack: Array<{ stmtId: string; depth: number }> = [];
  let lineDepth = 0;

  const SKIP_KEYWORDS = new Set([
    'IDENTIFICATION','ENVIRONMENT','DATA','PROCEDURE',
    'WORKING-STORAGE','LOCAL-STORAGE','LINKAGE','FILE',
    'CONFIGURATION','INPUT-OUTPUT','FD','SD','COPY',
    'PROGRAM-ID','AUTHOR','DATE-WRITTEN','REMARKS',
    'SOURCE-COMPUTER','OBJECT-COMPUTER','SPECIAL-NAMES',
  ]);

  for (let i = 0; i < procLines.length; i++) {
    const raw = procLines[i];
    const lineNum = baseLineOffset + i;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('*')) continue;
    // Strip column 7 indicator (COBOL fixed format: col 7 = '*' = comment)
    const col7 = raw.length > 6 ? raw[6] : ' ';
    if (col7 === '*' || col7 === '/') continue;

    // Paragraph declaration: 8+ leading spaces + NAME.
    const paraM = /^\s{6}\s*([\w-]+)\s*\.\s*$/.exec(raw);
    if (paraM) {
      const name = paraM[1].toUpperCase();
      if (!SKIP_KEYWORDS.has(name) && !name.endsWith('DIVISION') && !name.endsWith('SECTION')) {
        currentParagraph = name;
        scopeCounter = { n: 0 };
        ifStack = [];
        lineDepth = 0;
        continue;
      }
    }

    if (!currentParagraph) continue;

    const upper = trimmed.toUpperCase();
    const parentId = ifStack.length > 0 ? ifStack[ifStack.length - 1].stmtId : undefined;
    const depth = ifStack.length;

    // IF condition
    if (/^IF\b/.test(upper)) {
      const condText = trimmed.replace(/^IF\s+/i, '').replace(/\s+THEN\s*$/i, '').slice(0, 200);
      const st: ParsedStatement = {
        temp_id: nextId(), parent_temp_id: parentId,
        scope_type: 'function', scope_name: currentParagraph,
        statement_type: 'if', line_start: lineNum,
        order_index: nextOrder(parentId, scopeCounter),
        depth, is_top_level: depth === 0, is_awaited: false,
        condition_text: condText,
      };
      statements.push(st);
      ifStack.push({ stmtId: st.temp_id, depth });
      continue;
    }

    // END-IF
    if (/^END-IF\b/.test(upper)) {
      if (ifStack.length > 0) ifStack.pop();
      continue;
    }

    // ELSE
    if (/^ELSE\b/.test(upper)) continue;

    // EVALUATE
    if (/^EVALUATE\b/.test(upper)) {
      const condText = trimmed.replace(/^EVALUATE\s+/i, '').slice(0, 200);
      const st: ParsedStatement = {
        temp_id: nextId(), parent_temp_id: parentId,
        scope_type: 'function', scope_name: currentParagraph,
        statement_type: 'switch', line_start: lineNum,
        order_index: nextOrder(parentId, scopeCounter),
        depth, is_top_level: depth === 0, is_awaited: false,
        condition_text: condText,
      };
      statements.push(st);
      ifStack.push({ stmtId: st.temp_id, depth });
      continue;
    }
    if (/^END-EVALUATE\b/.test(upper)) { if (ifStack.length > 0) ifStack.pop(); continue; }

    // PERFORM
    const perfM = /^PERFORM\s+([\w-]+)/i.exec(trimmed);
    if (perfM) {
      const target = perfM[1].toUpperCase();
      if (!['VARYING','UNTIL','TIMES','WITH','TEST'].includes(target)) {
        const isLoop = /\bVARYING\b|\bUNTIL\b|\bTIMES\b/i.test(trimmed);
        const st: ParsedStatement = {
          temp_id: nextId(), parent_temp_id: parentId,
          scope_type: 'function', scope_name: currentParagraph,
          statement_type: isLoop ? 'for' : 'call', line_start: lineNum,
          order_index: nextOrder(parentId, scopeCounter),
          depth, is_top_level: depth === 0, is_awaited: false,
          callee: target,
        };
        statements.push(st);
        callEdges.push({ statement_temp_id: st.temp_id, caller_scope: currentParagraph, callee_name: target, line_number: lineNum, call_kind: 'function' });
        continue;
      }
    }

    // CALL
    const callM = /^CALL\s+["']([^"']+)["']/i.exec(trimmed);
    if (callM) {
      const callee = callM[1];
      const st: ParsedStatement = {
        temp_id: nextId(), parent_temp_id: parentId,
        scope_type: 'function', scope_name: currentParagraph,
        statement_type: 'call', line_start: lineNum,
        order_index: nextOrder(parentId, scopeCounter),
        depth, is_top_level: depth === 0, is_awaited: false,
        callee,
      };
      statements.push(st);
      callEdges.push({ statement_temp_id: st.temp_id, caller_scope: currentParagraph, callee_name: callee, line_number: lineNum, call_kind: 'function' });
      continue;
    }

    // GO TO
    const gotoM = /^GO\s+TO\s+([\w-]+)/i.exec(trimmed);
    if (gotoM) {
      const target = gotoM[1].toUpperCase();
      const st: ParsedStatement = {
        temp_id: nextId(), parent_temp_id: parentId,
        scope_type: 'function', scope_name: currentParagraph,
        statement_type: 'call', line_start: lineNum,
        order_index: nextOrder(parentId, scopeCounter),
        depth, is_top_level: depth === 0, is_awaited: false,
        callee: target,
      };
      statements.push(st);
      callEdges.push({ statement_temp_id: st.temp_id, caller_scope: currentParagraph, callee_name: target, line_number: lineNum, call_kind: 'function' });
      continue;
    }

    // MOVE / COMPUTE / ADD / SUBTRACT / etc. — generic assignment
    if (/^(?:MOVE|COMPUTE|ADD|SUBTRACT|MULTIPLY|DIVIDE|SET|INITIALIZE|INSPECT)\b/i.test(upper)) {
      statements.push({
        temp_id: nextId(), parent_temp_id: parentId,
        scope_type: 'function', scope_name: currentParagraph,
        statement_type: 'assignment', line_start: lineNum,
        order_index: nextOrder(parentId, scopeCounter),
        depth, is_top_level: depth === 0, is_awaited: false,
        text: trimmed.slice(0, 200),
      });
      continue;
    }

    // DISPLAY / WRITE / READ / OPEN / CLOSE / STOP / etc.
    if (/^(?:DISPLAY|WRITE|READ|OPEN|CLOSE|STOP|ACCEPT|REWRITE|DELETE|START|RETURN)\b/i.test(upper)) {
      const callName = upper.split(/\s+/)[0];
      const st: ParsedStatement = {
        temp_id: nextId(), parent_temp_id: parentId,
        scope_type: 'function', scope_name: currentParagraph,
        statement_type: 'call', line_start: lineNum,
        order_index: nextOrder(parentId, scopeCounter),
        depth, is_top_level: depth === 0, is_awaited: false,
        callee: callName,
      };
      statements.push(st);
      callEdges.push({ statement_temp_id: st.temp_id, caller_scope: currentParagraph, callee_name: callName, line_number: lineNum, call_kind: 'function' });
    }
  }

  return { statements, callEdges };
}

export const cobolParser = new CobolParser();
