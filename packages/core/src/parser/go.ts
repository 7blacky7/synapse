/**
 * MODUL: Go Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Go-Dateien
 *
 * EXTRAHIERT: function, method (receiver), struct, interface, type alias,
 *             const, var, import, comment, todo
 * ANSATZ: Regex-basiert — Go hat klare, einfache Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { formatRouteName, isLikelyHttpPath } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

/** Zeilennummer fuer eine Position im Text (1-basiert) */
function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

/** Endzeile eines Matches */
function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

/** Go-Exports: Grossbuchstabe am Anfang */
function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

// ---------------------------------------------------------------------------
// Flow-Extraction fuer Go
// ---------------------------------------------------------------------------

interface GoScope {
  type: string;   // 'module' | 'function' | 'method'
  name: string | null;
  braceDepth: number;  // brace-Tiefe bei Scope-Eintritt
  orderCounter: number;
}

function extractGoFlow(
  content: string,
): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = () => `s${tempId++}`;
  const orderCounters = new Map<string, number>();

  function nextOrder(parentId: string | undefined, scope: GoScope): number {
    if (parentId === undefined) return scope.orderCounter++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  const lines = content.split('\n');
  const scopeStack: GoScope[] = [{ type: 'module', name: null, braceDepth: 0, orderCounter: 0 }];
  const currentScope = () => scopeStack[scopeStack.length - 1];

  // Verfolge brace-Tiefe global
  let globalBraceDepth = 0;

  // Parent-Tracking: brace-Tiefe -> letztes Container-Statement
  const parentAtBrace = new Map<number, string>();

  const callRe = /\b([\w.]+)\s*\(/g;
  function extractCalls(expr: string, stmtId: string, scopeName: string | null, line: number, isAwaited: boolean): void {
    callRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(expr)) !== null) {
      const raw = cm[1];
      if (!raw || /^(if|for|switch|select|go|defer|return|range|make|new|len|cap|append|copy|delete|close|panic|recover|print|println|fmt)$/.test(raw)) continue;
      const parts = raw.split('.');
      const callee = parts[parts.length - 1];
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      callEdges.push({
        statement_temp_id: stmtId,
        caller_scope: scopeName,
        callee_name: callee,
        callee_receiver: receiver,
        line_number: line,
        call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function'),
      });
    }
  }

  // Regex patterns
  const funcRe = /^func\s+(?:\((\w+\s+\*?\w+)\)\s+)?(\w+)\s*\(/;
  const ifRe = /\bif\s+(.+?)\s*\{/;
  const forRe = /\bfor\s*(.*?)\s*\{/;
  const switchRe = /\bswitch\s*(.*?)\s*\{/;
  const selectRe = /\bselect\s*\{/;
  const deferRe = /^\s*defer\s+(.+)/;
  const goStmtRe = /^\s*go\s+(.+)/;
  const returnRe = /^\s*return\s*(.*)/;
  const assignRe = /^\s*([\w.[\]]+(?:\s*,\s*[\w.[\]]+)*)\s*(?::=|=)\s*(.+)/;
  const callStmtRe = /^\s*([\w.]+)\s*\(/;
  const newMakeRe = /\b(new|make)\s*\(/g;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//')) {
      // Count braces even in comments? No. But count in code lines.
      // Still need to count braces in non-comment lines
      continue;
    }

    // Count braces in this line (simplified - ignores strings/comments within line)
    let openCount = 0, closeCount = 0;
    for (const ch of trimmed) {
      if (ch === '{') openCount++;
      else if (ch === '}') closeCount++;
    }

    const prevBraceDepth = globalBraceDepth;
    // Braces open AFTER counting: a line "func foo() {" opens a brace
    // We process the line THEN update brace depth
    // Actually: compute depth at statement time = prevBraceDepth for the line content

    const scope = currentScope();

    // Pop scopes if we close braces back to their entry depth
    // (close braces reduce depth, check AFTER processing)

    // depth within current scope = globalBraceDepth - scope.braceDepth
    const depth = Math.max(0, globalBraceDepth - scope.braceDepth);

    // Parent lookup
    let parentId: string | undefined = undefined;
    if (globalBraceDepth > scope.braceDepth) {
      for (let bd = globalBraceDepth - 1; bd >= scope.braceDepth; bd--) {
        if (parentAtBrace.has(bd)) {
          parentId = parentAtBrace.get(bd);
          break;
        }
      }
    }

    const isTop = scope.type === 'module' && depth === 0;

    let dm: RegExpExecArray | null;

    // func declaration -> new scope
    if ((dm = funcRe.exec(trimmed)) !== null && globalBraceDepth === 0) {
      const receiver = dm[1];
      const funcName = dm[2];
      const scopeType = receiver ? 'method' : 'function';
      const fullName = receiver ? `${receiver.split(' ').pop()}.${funcName}` : funcName;
      // Update brace depth for this line
      globalBraceDepth += openCount - closeCount;
      scopeStack.push({ type: scopeType, name: fullName, braceDepth: globalBraceDepth - openCount + closeCount + 1, orderCounter: 0 });
      // Clear parent tracking for nested braces
      for (const k of Array.from(parentAtBrace.keys())) {
        if (k >= globalBraceDepth) parentAtBrace.delete(k);
      }
      continue;
    }

    // defer
    if ((dm = deferRe.exec(trimmed)) !== null) {
      const expr = dm[1];
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'try', node_kind: 'defer',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
      });
      extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    // go goroutine
    if ((dm = goStmtRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const expr = dm[1];
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'call', node_kind: 'go',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
      });
      extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    // if
    if (trimmed.match(/^\s*(?:} )?else if\b/) || (ifRe.test(trimmed) && !funcRe.test(trimmed))) {
      const condM = ifRe.exec(trimmed);
      const cond = condM?.[1]?.slice(0, 200) ?? '';
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'if', node_kind: trimmed.includes('else if') ? 'else_if' : 'if',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: cond,
      });
      parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      if (cond) extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    // for
    if (trimmed.match(/^\s*for\b/) && trimmed.includes('{')) {
      const condM = forRe.exec(trimmed);
      const cond = condM?.[1]?.slice(0, 200) ?? '';
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'for', node_kind: 'for',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: cond,
      });
      parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      if (cond) extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    // switch
    if (trimmed.match(/^\s*switch\b/) && trimmed.includes('{')) {
      const condM = switchRe.exec(trimmed);
      const cond = condM?.[1]?.slice(0, 200) ?? '';
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'switch', node_kind: 'switch',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: cond,
      });
      parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      if (cond) extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    // select
    if (selectRe.test(trimmed)) {
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'switch', node_kind: 'select',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
      });
      parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    // return
    if ((dm = returnRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? '';
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'return', node_kind: 'return',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
      });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    // assignment := or = (including new/make)
    if ((dm = assignRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const lhs = dm[1].slice(0, 120);
      const rhs = dm[2];
      const hasNew = /\bnew\s*\(/.test(rhs) || /\bmake\s*\(/.test(rhs);
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: hasNew ? 'new' : 'assignment', node_kind: hasNew ? 'new' : 'assignment',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        assigned_to: lhs,
      });
      extractCalls(rhs, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    // plain call statement
    if ((dm = callStmtRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const callExpr = dm[1];
      const parts = callExpr.split('.');
      const callee = parts[parts.length - 1];
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'call', node_kind: 'call',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        callee, receiver,
      });
      callEdges.push({
        statement_temp_id: id, caller_scope: scope.name,
        callee_name: callee, callee_receiver: receiver,
        line_number: lineNum, call_kind: receiver ? 'method' : 'function',
      });
      globalBraceDepth += openCount - closeCount;
      continue;
    }

    globalBraceDepth += openCount - closeCount;

    // Pop function scopes when brace depth falls back
    while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) {
      scopeStack.pop();
    }
  }

  return { statements, callEdges };
}

class GoParser implements LanguageParser {
  language = 'go';
  extensions = ['.go'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package-Deklaration
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+(\w+)/m;
    m = pkgRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'package',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Imports
    // ══════════════════════════════════════════════
    // Single import
    const singleImportRe = /^import\s+"([^"]+)"/gm;
    while ((m = singleImportRe.exec(content)) !== null) {
      const pkg = m[1];
      const name = pkg.split('/').pop() || pkg;
      symbols.push({
        symbol_type: 'import',
        name,
        value: pkg,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // Grouped imports
    const groupImportRe = /^import\s*\(([\s\S]*?)\)/gm;
    while ((m = groupImportRe.exec(content)) !== null) {
      const block = m[1];
      const importLineRe = /(?:(\w+)\s+)?"([^"]+)"/g;
      let im: RegExpExecArray | null;
      while ((im = importLineRe.exec(block)) !== null) {
        const alias = im[1] || null;
        const pkg = im[2];
        const name = alias || pkg.split('/').pop() || pkg;
        const line = lineAt(content, m.index + (im.index || 0));
        symbols.push({
          symbol_type: 'import',
          name,
          value: pkg,
          line_start: line,
          is_exported: false,
        });
        references.push({
          symbol_name: name,
          line_number: line,
          context: `import "${pkg}"`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Funktionen (func name(...) ...)
    // ══════════════════════════════════════════════
    const funcRe = /^func\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]*)\)|(\S[^\n{]*)))?\s*\{/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const funcName = m[1];
      const paramsRaw = m[2];
      const returnMulti = m[3];
      const returnSingle = m[4];
      const returnType = returnMulti
        ? `(${returnMulti.trim()})`
        : returnSingle ? returnSingle.trim() : undefined;

      const params = this.parseGoParams(paramsRaw);
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExported(funcName),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Methoden (func (receiver) name(...) ...)
    // ══════════════════════════════════════════════
    const methodRe = /^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]*)\)|(\S[^\n{]*)))?\s*\{/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const receiverName = m[1];
      const receiverType = m[2];
      const methodName = m[3];
      const paramsRaw = m[4];
      const returnMulti = m[5];
      const returnSingle = m[6];
      const returnType = returnMulti
        ? `(${returnMulti.trim()})`
        : returnSingle ? returnSingle.trim() : undefined;

      const params = this.parseGoParams(paramsRaw);
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'function',
        name: methodName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExported(methodName),
        parent_id: receiverType,
      });

      references.push({
        symbol_name: receiverType,
        line_number: lineStart,
        context: `func (${receiverName} ${receiverType}) ${methodName}(...)`,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Type-Deklarationen (struct, interface, type alias)
    // ══════════════════════════════════════════════
    // type X struct { ... }
    const structRe = /^type\s+(\w+)\s+struct\s*\{([\s\S]*?)\n\}/gm;
    while ((m = structRe.exec(content)) !== null) {
      const typeName = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      // Felder extrahieren
      const fields: string[] = [];
      const fieldRe = /^\s+(\w+)\s+(\S+)/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(body)) !== null) {
        fields.push(fm[1]);
        // Embedded structs / Referenzen
        const fieldType = fm[2].replace(/^\*/, '');
        if (/^[A-Z]/.test(fieldType) && !['string', 'int', 'bool', 'float64', 'float32', 'byte', 'rune', 'error'].includes(fieldType.toLowerCase())) {
          references.push({
            symbol_name: fieldType,
            line_number: lineAt(content, m.index + (fm.index || 0)),
            context: `${typeName}.${fm[1]} ${fm[2]}`.slice(0, 80),
          });
        }
      }

      symbols.push({
        symbol_type: 'class',
        name: typeName,
        value: 'struct',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExported(typeName),
      });
    }

    // type X interface { ... }
    const ifaceRe = /^type\s+(\w+)\s+interface\s*\{([\s\S]*?)\n\}/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      const typeName = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      // Methoden-Signaturen
      const methods: string[] = [];
      const methodSigRe = /^\s+(\w+)\s*\(/gm;
      let mm: RegExpExecArray | null;
      while ((mm = methodSigRe.exec(body)) !== null) {
        methods.push(mm[1]);
      }

      symbols.push({
        symbol_type: 'interface',
        name: typeName,
        params: methods,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExported(typeName),
      });
    }

    // type X = Y (alias) / type X Y (definition)
    const typeAliasRe = /^type\s+(\w+)\s+=?\s*([^\n{]+)/gm;
    while ((m = typeAliasRe.exec(content)) !== null) {
      // Skip struct/interface (already handled)
      if (m[2].trim().startsWith('struct') || m[2].trim().startsWith('interface')) continue;
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isExported(m[1]),
      });
    }

    // ══════════════════════════════════════════════
    // 6. Const / Var Deklarationen
    // ══════════════════════════════════════════════
    // const X = ... / var X = ...
    const constVarRe = /^(const|var)\s+(\w+)(?:\s+(\S+))?\s*=\s*(.+)/gm;
    while ((m = constVarRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[4].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isExported(m[2]),
      });
    }

    // Grouped const/var blocks
    const groupConstRe = /^(const|var)\s*\(([\s\S]*?)\)/gm;
    while ((m = groupConstRe.exec(content)) !== null) {
      const kind = m[1];
      const block = m[2];
      const entryRe = /^\s+(\w+)(?:\s+\S+)?\s*=\s*(.*)/gm;
      let em: RegExpExecArray | null;
      while ((em = entryRe.exec(block)) !== null) {
        symbols.push({
          symbol_type: 'variable',
          name: em[1],
          value: em[2].trim().slice(0, 200),
          line_start: lineAt(content, m.index + (em.index || 0)),
          is_exported: isExported(em[1]),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. TODO / FIXME / HACK
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
    // 8. Block-Kommentare (/* ... */)
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

    // Zusammenhaengende //-Kommentarbloeecke
    const lines = content.split('\n');
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//') && !line.match(/^\/\/\s*(TODO|FIXME|HACK)/i)) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(line.replace(/^\/\/\s?/, ''));
      } else {
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
        commentBlock = [];
      }
    }
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
    // 9. Routes — net/http HandleFunc (Default GET)
    // ══════════════════════════════════════════════
    const handleFuncRe = /\b(?:http|mux|router|r|m)\.HandleFunc\s*\(\s*"([^"]+)"/g;
    while ((m = handleFuncRe.exec(content)) !== null) {
      const path = m[1];
      if (!isLikelyHttpPath(path)) continue;
      // Check fuer .Methods("...") auf gleicher oder Folgezeile (gorilla/mux)
      const tail = content.slice(m.index + m[0].length, m.index + m[0].length + 300);
      const methodsMatch = /\.Methods\s*\(\s*"([^"]+)"(?:\s*,\s*"([^"]+)")*\s*\)/.exec(tail);
      if (methodsMatch) {
        const methodsListRe = /"([A-Z]+)"/g;
        let mm: RegExpExecArray | null;
        const methods: string[] = [];
        while ((mm = methodsListRe.exec(methodsMatch[0])) !== null) {
          methods.push(mm[1]);
        }
        for (const method of methods) {
          symbols.push({
            symbol_type: 'route',
            name: formatRouteName(method, path),
            value: path,
            params: [method],
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }
      } else {
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName('GET', path),
          value: path,
          params: ['GET'],
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 10. Routes — gin/echo/fiber/chi (r.GET, e.POST, app.PUT, ...)
    // ══════════════════════════════════════════════
    const verbRouteRe = /\b\w+\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*"([^"]+)"/g;
    while ((m = verbRouteRe.exec(content)) !== null) {
      const method = m[1];
      const path = m[2];
      if (!isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Embedded SQL (db.Query, db.Exec, tx.Exec, stmt.Query, ...)
    // ══════════════════════════════════════════════
    const sqlCallRe = /\b\w+\.(?:Query|Exec|QueryRow|QueryContext|ExecContext)\s*\(\s*(?:ctx\s*,\s*)?[`"]((?:[^`"\\]|\\.){10,})[`"]/g;
    while ((m = sqlCallRe.exec(content)) !== null) {
      const sqlContent = m[1];
      if (!looksLikeSql(sqlContent)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlContent, filePath, baseLine));
    }

    symbols.push(...extractStringLiterals(content));


    const { statements, callEdges } = extractGoFlow(content);
    return { symbols, references, statements, callEdges };
  }

  /** Parst Go-Parameter-Listen ("name type, name type") */
  private parseGoParams(raw: string): string[] {
    if (!raw.trim()) return [];
    return raw
      .split(',')
      .map(p => p.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  /** Findet die schliessende Klammer ab einer Position */
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

export const goParser = new GoParser();
