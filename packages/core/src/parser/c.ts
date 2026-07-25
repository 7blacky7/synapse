/**
 * MODUL: C Parser
 * ZWECK: Extrahiert Struktur-Informationen aus C-Dateien (.c, .h)
 *
 * EXTRAHIERT: function, struct, enum, union, typedef, #include, #define,
 *             global variable, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

// ---------------------------------------------------------------------------
// Flow extraction (regex-based, C)
// ---------------------------------------------------------------------------

function extractFlowC(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextId = (): string => `s${tempIdCounter++}`;

  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, scopeCounter: { v: number }): number {
    if (parentId === undefined) return scopeCounter.v++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  // Strip line comments and block comments to avoid false matches inside strings/comments.
  // We keep line structure intact (replace with spaces).
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  }

  // Find all top-level function bodies: FuncName(...) { ... }
  // Returns array of {name, bodyStart, bodyEnd (line), content of body}
  interface FuncBody { name: string; bodyStart: number; bodyEnd: number; bodyContent: string; bodyOffset: number; }

  function findFunctionBodies(src: string): FuncBody[] {
    const bodies: FuncBody[] = [];
    // Match function definition opening brace (simplified: name(...) {)
    const funcRe = /^(?:(?:static|inline|extern|__attribute__\([^)]*\)\s*)*\s*)(?:(?:const\s+)?(?:unsigned\s+|signed\s+|long\s+|short\s+)?(?:struct\s+)?\w[\w*\s]*?)\s+(\*?\w+)\s*\([^)]*\)\s*\{/gm;
    let m: RegExpExecArray | null;
    const stripped = stripComments(src);
    while ((m = funcRe.exec(stripped)) !== null) {
      const rawName = m[1].replace(/^\*/, '');
      if (['if', 'for', 'while', 'switch', 'return', 'else', 'do'].includes(rawName)) continue;
      const openBrace = m.index + m[0].length - 1;
      // Find matching close brace
      let depth = 1;
      let i = openBrace + 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      const bodyEnd = i;
      bodies.push({
        name: rawName,
        bodyStart: openBrace + 1,
        bodyEnd: lineAt(src, bodyEnd),
        bodyContent: src.slice(openBrace + 1, bodyEnd - 1),
        bodyOffset: openBrace + 1,
      });
    }
    return bodies;
  }

  // Extract calls from an expression string (simple regex)
  function extractCallsFromExpr(expr: string, stmtId: string, scopeName: string | null, lineBase: number): void {
    // method calls: receiver.func(  or  receiver->func(
    const methodRe = /(\w+)\s*(?:->|\.)\s*(\w+)\s*\(/g;
    let mc: RegExpExecArray | null;
    while ((mc = methodRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineBase, call_kind: 'method' });
    }
    // plain function calls (not preceded by -> or .)
    const funcRe2 = /(?<![.\->])\b([a-zA-Z_]\w*)\s*\(/g;
    while ((mc = funcRe2.exec(expr)) !== null) {
      const name = mc[1];
      if (['if', 'for', 'while', 'switch', 'do', 'return', 'sizeof', 'typeof', 'alignof', 'offsetof'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: name, line_number: lineBase, call_kind: 'function' });
    }
  }

  // Findet zur oeffnenden Klammer bei openIdx die passende schliessende Klammer.
  // Zaehlt Verschachtelung und ueberspringt String-/Char-Literale samt Escapes.
  // -1 wenn die Klammer im uebergebenen Text nicht geschlossen wird.
  function matchParen(s: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Bedingung eines Kontrollfluss-Kopfes: alles zwischen der ersten '(' nach dem
  // Keyword und der zugehoerigen ')'. Ersetzt das gierige /kw\s*\((.+)/, das den
  // Rumpf mitgefressen und nur eine ')' am Zeilenende abgeschnitten hat.
  function extractCondition(line: string, keyword: string): string | undefined {
    const kw = new RegExp(`\\b${keyword}\\s*\\(`).exec(line);
    if (!kw) return undefined;
    const openIdx = kw.index + kw[0].length - 1;
    const close = matchParen(line, openIdx);
    const raw = close < 0 ? line.slice(openIdx + 1) : line.slice(openIdx + 1, close);
    const cond = raw.trim();
    return cond ? cond.slice(0, 200) : undefined;
  }

  // Zerlegt eine Zeile in ihre einzelnen Statements. Geschnitten wird nur an
  // Semikolons auf Tiefe 0 und ausserhalb von Literalen — die Semikolons in
  // 'for (i = 0; i < n; i++)' liegen in Tiefe 1 und bleiben unangetastet.
  function splitTopLevelStatements(s: string): string[] {
    const segmente: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ';' && depth <= 0) {
        const seg = s.slice(start, i + 1).trim();
        if (seg) segmente.push(seg);
        start = i + 1;
      }
    }
    const rest = s.slice(start).trim();
    if (rest) segmente.push(rest);
    return segmente;
  }

  function processBody(
    body: string,
    bodyOffset: number,
    scopeName: string | null,
    scopeType: string,
    depth: number,
    parentId: string | undefined,
    scopeCounter: { v: number },
  ): void {
    const isTop = scopeType === 'module' && depth === 0;

    // We scan line by line for control-flow keywords and call statements
    // using a simplified regex approach (no full AST).
    const lines = body.split('\n');
    // Startzeile des Bodys einmal berechnen statt pro Zeile neu (war O(n^2)).
    const bodyStartLine = lineAt(content, bodyOffset);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) { i++; continue; }

      const fileLine = bodyStartLine + i;

      // if (...) {
      if (/^\s*if\s*\(/.test(line)) {
        const cond = extractCondition(line, 'if');
        const stId = nextId();
        statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'if', node_kind: 'IfStatement', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, condition_text: cond, text: trimmed.slice(0, 240) });
        if (cond) extractCallsFromExpr(cond, stId, scopeName, fileLine);
        i++; continue;
      }
      // for (...) {
      if (/^\s*for\s*\(/.test(line)) {
        const cond = extractCondition(line, 'for');
        const stId = nextId();
        statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'for', node_kind: 'ForStatement', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, condition_text: cond, text: trimmed.slice(0, 240) });
        if (cond) extractCallsFromExpr(cond, stId, scopeName, fileLine);
        i++; continue;
      }
      // while (...) {
      if (/^\s*while\s*\(/.test(line)) {
        const cond = extractCondition(line, 'while');
        const stId = nextId();
        statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'while', node_kind: 'WhileStatement', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, condition_text: cond, text: trimmed.slice(0, 240) });
        if (cond) extractCallsFromExpr(cond, stId, scopeName, fileLine);
        i++; continue;
      }
      // do {
      if (/^\s*do\s*\{/.test(line)) {
        const stId = nextId();
        statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'do', node_kind: 'DoStatement', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, text: trimmed.slice(0, 240) });
        i++; continue;
      }
      // switch (...) {
      if (/^\s*switch\s*\(/.test(line)) {
        const cond = extractCondition(line, 'switch');
        const stId = nextId();
        statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'switch', node_kind: 'SwitchStatement', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, condition_text: cond, text: trimmed.slice(0, 240) });
        if (cond) extractCallsFromExpr(cond, stId, scopeName, fileLine);
        i++; continue;
      }
      // return ...;
      if (/^\s*return\b/.test(line)) {
        const stId = nextId();
        const retExpr = trimmed.replace(/^return\s*/, '').replace(/;$/, '');
        statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'return', node_kind: 'ReturnStatement', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, text: trimmed.slice(0, 240) });
        if (retExpr) extractCallsFromExpr(retExpr, stId, scopeName, fileLine);
        i++; continue;
      }
      // goto label;
      if (/^\s*goto\s+\w+/.test(line)) {
        const stId = nextId();
        statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'goto', node_kind: 'GotoStatement', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, text: trimmed.slice(0, 240) });
        i++; continue;
      }
      // Eine Zeile kann mehrere Statements tragen:
      //   moo_retain(maske); dset(schicht, "pack_maske", maske);
      // Frueher wurde nur das erste erfasst, der Rest fiel weg. Jedes Segment
      // wird einzeln klassifiziert; alle behalten die Zeilennummer der Zeile.
      for (const segment of splitTopLevelStatements(trimmed)) {
        // assignment: x = expr; or x += expr; etc.
        if (/^\w[\w.*\[\]>-]*\s*(?:[+*/%&|^-]?=)\s*.+;/.test(segment) && !/^(?:if|for|while|switch|return|goto)\b/.test(segment)) {
          const assignMatch = segment.match(/^(\w[\w.*\[\]>-]*)\s*(?:[+*/%&|^-]?=)\s*(.+);/);
          if (assignMatch) {
            const stId = nextId();
            statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'assignment', node_kind: 'AssignmentExpression', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, assigned_to: assignMatch[1].slice(0, 120), text: segment.slice(0, 240) });
            extractCallsFromExpr(assignMatch[2], stId, scopeName, fileLine);
            continue;
          }
        }
        // variable declaration with init: type name = expr;
        if (/^(?:(?:const|static|volatile|unsigned|signed|long|short|struct|enum)\s+)?\w+\s+\*?\w+\s*=\s*.+;/.test(segment) && !/^(?:if|for|while|switch|return|goto|typedef)\b/.test(segment)) {
          const varMatch = segment.match(/\w+\s+\*?(\w+)\s*=\s*(.+);/);
          if (varMatch) {
            const stId = nextId();
            statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'variable', node_kind: 'VariableDeclaration', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, assigned_to: varMatch[1].slice(0, 120), text: segment.slice(0, 240) });
            extractCallsFromExpr(varMatch[2], stId, scopeName, fileLine);
            continue;
          }
        }
        // Postfix-/Praefix-Inkrement als eigenes Statement: d->tombs++;  ++i;
        // Die Assignment-Regex verlangt ein '=' und hat diese Zeilen nie erfasst.
        if (/^(?:\+\+|--)?\s*\w[\w.*\[\]>-]*\s*(?:\+\+|--)?\s*;$/.test(segment) && /\+\+|--/.test(segment)) {
          const target = segment.replace(/\+\+|--/g, '').replace(/;$/, '').trim();
          if (target) {
            const stId = nextId();
            statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'assignment', node_kind: 'UpdateExpression', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, assigned_to: target.slice(0, 120), text: segment.slice(0, 240) });
            continue;
          }
        }
        // function call statement: name(...);  or  obj->method(...);
        // Klammerende per Scanner statt \([^)]*\): ein verschachtelter Aufruf als
        // Argument (moo_dict_remove(d, moo_string_new("x"));) liess die Zeile sonst
        // durch alle Zweige fallen — kein Statement UND keine Call-Kante.
        if (!/^(?:if|for|while|switch|return|goto|typedef|struct|enum|union|else|do|case|default)\b/.test(segment)) {
          const callHead = segment.match(/^(?:(\w[\w.*\[\]>-]*?)\s*(?:->|\.)\s*)?([A-Za-z_]\w*)\s*\(/);
          if (callHead) {
            const openIdx = callHead[0].length - 1;
            const closeIdx = matchParen(segment, openIdx);
            if (closeIdx >= 0 && segment.slice(closeIdx + 1).trim() === ';') {
              const stId = nextId();
              statements.push({ temp_id: stId, parent_temp_id: parentId, scope_type: scopeType, scope_name: scopeName, statement_type: 'call', node_kind: 'CallExpression', line_start: fileLine, order_index: nextOrder(parentId, scopeCounter), depth, is_top_level: isTop, is_awaited: false, callee: callHead[2], receiver: callHead[1] || undefined, text: segment.slice(0, 240) });
              extractCallsFromExpr(segment, stId, scopeName, fileLine);
              continue;
            }
          }
        }
      }

      i++;
    }
  }

  // Process function bodies as 'function' scopes
  const bodies = findFunctionBodies(content);
  for (const fb of bodies) {
    const scopeCounter = { v: 0 };
    processBody(fb.bodyContent, fb.bodyOffset, fb.name, 'function', 0, undefined, scopeCounter);
  }

  // Also process top-level statements (outside functions) with scope_type='module'
  // We mark regions outside function bodies as top-level
  // For simplicity, scan for top-level variable declarations and calls not inside any function body
  const bodyRanges = bodies.map(b => [b.bodyOffset, b.bodyOffset + b.bodyContent.length] as [number, number]);
  function isInsideBody(pos: number): boolean {
    return bodyRanges.some(([s, e]) => pos >= s && pos <= e);
  }

  const topScopeCounter = { v: 0 };
  const stripped = stripComments(content);
  // Top-level variable declarations with init
  const topVarRe = /^(?:(?:static|extern|const|volatile|unsigned|signed|long|short|struct|enum)\s+)+\w[\w*\s]*?\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
  let mv: RegExpExecArray | null;
  while ((mv = topVarRe.exec(stripped)) !== null) {
    if (isInsideBody(mv.index)) continue;
    const fileLine = lineAt(content, mv.index);
    const stId = nextId();
    statements.push({ temp_id: stId, parent_temp_id: undefined, scope_type: 'module', scope_name: null, statement_type: 'variable', node_kind: 'VariableDeclaration', line_start: fileLine, order_index: nextOrder(undefined, topScopeCounter), depth: 0, is_top_level: true, is_awaited: false, assigned_to: mv[1], text: mv[0].trim().slice(0, 240) });
    if (mv[2]) extractCallsFromExpr(mv[2], stId, null, fileLine);
  }

  return { statements, callEdges };
}

class CParser implements LanguageParser {
  language = 'c';
  extensions = ['.c', '.h'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;
    const isHeader = filePath.endsWith('.h');

    // ══════════════════════════════════════════════
    // 1. #include
    // ══════════════════════════════════════════════
    const includeRe = /^#include\s+[<"]([^>"]+)[>"]/gm;
    while ((m = includeRe.exec(content)) !== null) {
      const header = m[1];
      const name = header.replace(/\.h$/, '').split('/').pop() || header;
      symbols.push({
        symbol_type: 'import',
        name,
        value: header,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. #define (Makros und Konstanten)
    // ══════════════════════════════════════════════
    // Objekt-artige Makros: #define NAME value
    const defineConstRe = /^#define\s+(\w+)\s+(.+)/gm;
    while ((m = defineConstRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim().replace(/\\\n/g, ' ').slice(0, 200);
      // Skip include guards
      if (name.endsWith('_H') || name.endsWith('_H_') || name.startsWith('_')) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    // Funktions-artige Makros: #define NAME(params) body
    const defineFuncRe = /^#define\s+(\w+)\(([^)]*)\)\s*(.*)/gm;
    while ((m = defineFuncRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].split(',').map(p => p.trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name,
        value: 'macro',
        params,
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Structs
    // ══════════════════════════════════════════════
    // typedef struct { ... } Name;
    const typedefStructRe = /typedef\s+struct\s*(?:\w+)?\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g;
    while ((m = typedefStructRe.exec(content)) !== null) {
      const body = m[1];
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);
      const fields = this.extractFields(body);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isHeader,
      });
    }

    // struct Name { ... };
    const structRe = /^struct\s+(\w+)\s*\{([\s\S]*?)\}\s*;/gm;
    while ((m = structRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);
      const fields = this.extractFields(body);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Enums
    // ══════════════════════════════════════════════
    const typedefEnumRe = /typedef\s+enum\s*(?:\w+)?\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g;
    while ((m = typedefEnumRe.exec(content)) !== null) {
      const body = m[1];
      const name = m[2];
      const variants = body.split(',').map(v => v.trim().split(/[\s=]/)[0]).filter(v => v && !v.startsWith('/'));

      symbols.push({
        symbol_type: 'enum',
        name,
        params: variants,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: isHeader,
      });
    }

    const enumRe = /^enum\s+(\w+)\s*\{([\s\S]*?)\}\s*;/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const variants = body.split(',').map(v => v.trim().split(/[\s=]/)[0]).filter(v => v && !v.startsWith('/'));

      symbols.push({
        symbol_type: 'enum',
        name,
        params: variants,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Unions
    // ══════════════════════════════════════════════
    const typedefUnionRe = /typedef\s+union\s*(?:\w+)?\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g;
    while ((m = typedefUnionRe.exec(content)) !== null) {
      const name = m[2];
      const fields = this.extractFields(m[1]);
      symbols.push({
        symbol_type: 'class',
        name,
        value: 'union',
        params: fields,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 6. typedef (einfach)
    // ══════════════════════════════════════════════
    const typedefSimpleRe = /^typedef\s+(.+?)\s+(\w+)\s*;/gm;
    while ((m = typedefSimpleRe.exec(content)) !== null) {
      const target = m[1].trim();
      const name = m[2];
      // Skip struct/enum/union (already handled)
      if (target.includes('{')) continue;
      symbols.push({
        symbol_type: 'variable',
        name,
        value: target.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Funktionen
    // ══════════════════════════════════════════════
    const funcRe = /^((?:static|inline|extern|__attribute__\([^)]*\)\s*)*\s*)((?:const\s+)?(?:unsigned\s+|signed\s+|long\s+|short\s+)?(?:struct\s+)?\w[\w*\s]*?)\s+(\*?\w+)\s*\(([^)]*)\)\s*\{/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const qualifiers = m[1].trim();
      const returnType = m[2].trim();
      const funcName = m[3].replace(/^\*/, '');
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      // Skip if returnType is a keyword
      if (['if', 'for', 'while', 'switch', 'return', 'else', 'do'].includes(returnType)) continue;

      const params = paramsRaw === 'void' ? [] : paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(/\s+/);
          return parts[parts.length - 1]?.replace(/[*&]/g, '') || '';
        })
        .filter(p => p && p !== '...');

      const isStatic = qualifiers.includes('static');

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !isStatic,
      });
    }

    // Funktions-Prototypen (in .h)
    if (isHeader) {
      const protoRe = /^((?:extern\s+)?)((?:const\s+)?(?:unsigned\s+|signed\s+|long\s+|short\s+)?(?:struct\s+)?\w[\w*\s]*?)\s+(\*?\w+)\s*\(([^)]*)\)\s*;/gm;
      while ((m = protoRe.exec(content)) !== null) {
        const returnType = m[2].trim();
        const funcName = m[3].replace(/^\*/, '');
        const paramsRaw = m[4];

        if (['if', 'for', 'while', 'switch', 'return', 'typedef'].includes(returnType)) continue;

        const params = paramsRaw === 'void' ? [] : paramsRaw
          .split(',')
          .map(p => p.trim().split(/\s+/).pop()?.replace(/[*&]/g, '') || '')
          .filter(p => p && p !== '...');

        symbols.push({
          symbol_type: 'function',
          name: funcName,
          params,
          return_type: returnType,
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 8. Globale Variablen
    // ══════════════════════════════════════════════
    const globalVarRe = /^((?:static|extern|const|volatile)\s+)+(\w[\w*\s]*?)\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
    while ((m = globalVarRe.exec(content)) !== null) {
      const qualifiers = m[1];
      const varType = m[2].trim();
      const varName = m[3];
      const value = m[4] ? m[4].trim().slice(0, 200) : undefined;

      if (['struct', 'enum', 'union', 'typedef'].includes(varType)) continue;

      symbols.push({
        symbol_type: 'variable',
        name: varName,
        value: value || varType,
        return_type: varType,
        line_start: lineAt(content, m.index),
        is_exported: !qualifiers.includes('static'),
      });
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /\/\/\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 10. Block-Kommentare
    // ══════════════════════════════════════════════
    const blockCommentRe = /\/\*([\s\S]*?)\*\//g;
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
    // 11. String-Literale als benannte Symbole (via Helper — C: nur ", 'a' ist char)
    // ══════════════════════════════════════════════
    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 12. Embedded SQL: libpq (PQexec) + sqlite3 (sqlite3_exec / sqlite3_prepare[_v2/_v3])
    // ══════════════════════════════════════════════
    // PQexec(conn, "SQL"), sqlite3_exec(db, "SQL", ...), sqlite3_prepare_v2(db, "SQL", ...)
    const sqlCallRe = /\b(?:PQexec|sqlite3_exec|sqlite3_prepare(?:_v2|_v3)?)\s*\(\s*[^,]+,\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = sqlCallRe.exec(content)) !== null) {
      const raw = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
      if (!looksLikeSql(raw)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(raw, filePath, baseLine));
    }

    // PQprepare(conn, name, "SQL", ...) — SQL ist 3. Argument
    const pqPrepareRe = /\bPQprepare\s*\(\s*\w+\s*,\s*"[^"]*"\s*,\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = pqPrepareRe.exec(content)) !== null) {
      const raw = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
      if (!looksLikeSql(raw)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(raw, filePath, baseLine));
    }

    const { statements, callEdges } = extractFlowC(content);
    return { symbols, references, statements, callEdges };
  }

  private extractFields(body: string): string[] {
    const fields: string[] = [];
    const fieldRe = /^\s+(?:const\s+)?(?:unsigned\s+|signed\s+)?(?:struct\s+)?\w[\w*\s]*?\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body)) !== null) {
      fields.push(fm[1]);
    }
    return fields;
  }

  private findClosingBrace(content: string, openPos: number): number {
    let depth = 1;
    for (let i = openPos + 1; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') depth--;
      if (depth === 0) return lineAt(content, i);
    }
    return lineAt(content, content.length);
  }
}

export const cParser = new CParser();
