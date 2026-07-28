/**
 * MODUL: C# Parser
 * ZWECK: Extrahiert Struktur-Informationen aus C#-Dateien
 *
 * EXTRAHIERT: class, struct, interface, enum, record, method, property,
 *             field, using, namespace, delegate, event, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { ASPNET_ATTRIBUTES, formatRouteName } from './patterns/http.js';
import { looksLikeSql, parseEmbeddedSql } from './patterns/sql.js';

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

function endLineAt(text: string, pos: number, matchLength: number): number {
  return lineAt(text, pos + matchLength);
}

function isExportedMod(modifiers: string): boolean {
  return /\b(public|protected|internal)\b/.test(modifiers);
}

// ---------------------------------------------------------------------------
// Flow-Extraction fuer C#
// ---------------------------------------------------------------------------

interface CsScope {
  type: string;
  name: string | null;
  braceDepth: number;
  orderCounter: number;
}

function extractCSharpFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = () => `s${tempId++}`;
  const orderCounters = new Map<string, number>();

  function nextOrder(parentId: string | undefined, scope: CsScope): number {
    if (parentId === undefined) return scope.orderCounter++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  const lines = content.split('\n');
  const scopeStack: CsScope[] = [{ type: 'module', name: null, braceDepth: 0, orderCounter: 0 }];
  const currentScope = () => scopeStack[scopeStack.length - 1];
  let globalBraceDepth = 0;
  const parentAtBrace = new Map<number, string>();

  const callRe = /\b([\w.]+)\s*\(/g;
  function extractCalls(expr: string, stmtId: string, scopeName: string | null, line: number, isAwaited: boolean): void {
    callRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(expr)) !== null) {
      const raw = cm[1];
      if (!raw || /^(if|for|foreach|while|switch|catch|return|throw|new|await|var|int|long|bool|string|object|void)$/.test(raw)) continue;
      const parts = raw.split('.');
      const callee = parts[parts.length - 1];
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: callee, callee_receiver: receiver, line_number: line, call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function') });
    }
  }

  const classRe = /^\s*(?:(?:public|protected|private|internal|static|abstract|sealed|partial|readonly)\s+)*(?:class|interface|enum|struct|record)\s+(\w+)/;
  const methodRe = /^\s*(?:(?:public|protected|private|internal|static|abstract|virtual|override|async|sealed|new)\s+)*(?:[\w<>\[\],?]+\s+)([\w]+)\s*\([^)]*\)\s*(?:where\s+.+?)?\s*\{/;
  const ifRe = /^\s*(?:} else )?if\s*\((.+?)\)\s*(?:\{|$)/;
  const elseRe = /^\s*\}\s*else\s*(?:\{|$)/;
  const forRe = /^\s*for\s*\((.+?)\)\s*(?:\{|$)/;
  const foreachRe = /^\s*foreach\s*\((.+?)\)\s*(?:\{|$)/;
  const whileRe = /^\s*while\s*\((.+?)\)\s*(?:\{|$)/;
  const doRe = /^\s*do\s*\{/;
  const switchRe = /^\s*switch\s*\((.+?)\)\s*\{/;
  const tryRe = /^\s*try\s*\{/;
  const catchRe = /^\s*\}\s*catch\s*(?:\((.+?)\))?\s*\{/;
  const finallyRe = /^\s*\}\s*finally\s*\{/;
  const returnRe = /^\s*return\s+(.*);/;
  const throwRe = /^\s*throw\s+(.*);/;
  const awaitRe = /^\s*(?:var\s+(\w+)\s*=\s*)?await\s+(.+)/;
  const varRe = /^\s*(?:var|[\w<>\[\]?]+)\s+(\w+)\s*=\s*(.+);/;
  const callStmtRe = /^\s*([\w.]+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      for (const ch of trimmed) { if (ch === '{') globalBraceDepth++; else if (ch === '}') { globalBraceDepth--; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); } }
      continue;
    }
    let openCount = 0, closeCount = 0;
    for (const ch of trimmed) { if (ch === '{') openCount++; else if (ch === '}') closeCount++; }

    const scope = currentScope();
    const depth = Math.max(0, globalBraceDepth - scope.braceDepth);
    let parentId: string | undefined = undefined;
    if (globalBraceDepth > scope.braceDepth) {
      for (let bd = globalBraceDepth; bd >= scope.braceDepth; bd--) {
        if (parentAtBrace.has(bd)) { parentId = parentAtBrace.get(bd); break; }
      }
    }
    const isTop = scope.type === 'module' && depth === 0;
    let dm: RegExpExecArray | null;

    // namespace/class -> scope push
    if ((dm = classRe.exec(trimmed)) !== null && openCount > 0) {
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'class', name: dm[1], braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD; continue;
    }
    // method
    if ((dm = methodRe.exec(trimmed)) !== null && openCount > 0 && scope.type !== 'module') {
      const mName = dm[1];
      const cls = scopeStack.find(s => s.type === 'class')?.name ?? null;
      const fullName = cls ? `${cls}.${mName}` : mName;
      const isAsync = /\basync\b/.test(trimmed);
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: isAsync ? 'method' : 'method', name: fullName, braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD;
      for (const k of Array.from(parentAtBrace.keys())) { if (k >= globalBraceDepth) parentAtBrace.delete(k); }
      continue;
    }
    // await
    if ((dm = awaitRe.exec(trimmed)) !== null) {
      const assignTo = dm[1];
      const expr = dm[2];
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'await', node_kind: 'await', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: true, assigned_to: assignTo?.slice(0, 120) });
      extractCalls(expr, id, scope.name, lineNum, true);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // if
    if ((dm = ifRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'if', node_kind: trimmed.includes('else if') ? 'else_if' : 'if', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    if (elseRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'if', node_kind: 'else', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'else {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // foreach
    if ((dm = foreachRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'for', node_kind: 'foreach', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // for
    if ((dm = forRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'for', node_kind: 'for', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // while
    if ((dm = whileRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'while', node_kind: 'while', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    if (doRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'do', node_kind: 'do', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'do {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    if ((dm = switchRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'switch', node_kind: 'switch', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    if (tryRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'try', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'try {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    if ((dm = catchRe.exec(trimmed)) !== null) {
      const cond = dm[1]?.slice(0, 200);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'catch', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    if (finallyRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'finally', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'finally {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    if ((dm = returnRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? '';
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'return', node_kind: 'return', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    if ((dm = throwRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? '';
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'throw', node_kind: 'throw', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // var assignment
    if ((dm = varRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const lhs = dm[1].slice(0, 120);
      const rhs = dm[2];
      const hasNew = /\bnew\s+\w/.test(rhs);
      const isAwaited = /\bawait\b/.test(rhs);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: isAwaited ? 'await' : (hasNew ? 'new' : 'variable'), node_kind: 'variable', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited, assigned_to: lhs });
      extractCalls(rhs, id, scope.name, lineNum, isAwaited);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // plain call
    if ((dm = callStmtRe.exec(trimmed)) !== null && scope.type !== 'module' && !trimmed.match(/^\s*(?:public|private|protected|internal|static|abstract|sealed|override|virtual|async|class|interface|enum|struct)\b/)) {
      const callExpr = dm[1];
      const parts = callExpr.split('.');
      const callee = parts[parts.length - 1];
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'call', node_kind: 'call', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, callee, receiver });
      callEdges.push({ statement_temp_id: id, caller_scope: scope.name, callee_name: callee, callee_receiver: receiver, line_number: lineNum, call_kind: receiver ? 'method' : 'function' });
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    globalBraceDepth += openCount - closeCount;
    while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
  }
  return { statements, callEdges };
}

class CSharpParser implements LanguageParser {
  language = 'csharp';
  extensions = ['.cs'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Eltern-Typ ueber vorberechnete Grenzen statt Rueckwaertssuche je Treffer.
  version = 3;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. using-Deklarationen
    // ══════════════════════════════════════════════
    const usingRe = /^using\s+(?:static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      const alias = m[1] || null;
      const ns = m[2];
      const name = alias || ns.split('.').pop() || ns;
      symbols.push({
        symbol_type: 'import',
        name,
        value: ns,
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
    // 2. Namespaces
    // ══════════════════════════════════════════════
    // File-scoped namespace
    const fileScopedNsRe = /^namespace\s+([\w.]+)\s*;/m;
    m = fileScopedNsRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }
    // Block namespace
    const blockNsRe = /^namespace\s+([\w.]+)\s*\{/gm;
    while ((m = blockNsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Typen: class, struct, interface, enum, record
    // ══════════════════════════════════════════════
    const typeRe = /^([ \t]*)((?:(?:public|protected|private|internal|static|abstract|sealed|partial|readonly|ref)\s+)*)(class|struct|interface|enum|record)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\n{]+))?\s*(?:where\s+[^\n{]+\s*)?\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const baseClause = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const bases: string[] = [];
      if (baseClause) {
        bases.push(...baseClause.split(',').map(s => s.trim().split('<')[0].trim()).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: bases.length > 0 ? bases : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExportedMod(modifiers),
      });

      for (const base of bases) {
        if (base) {
          references.push({
            symbol_name: base,
            line_number: lineStart,
            context: `${kind} ${name} : ${baseClause?.trim()}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methoden
    // ══════════════════════════════════════════════
    const methodRe = /^([ \t]+)((?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|async|new|extern|partial|unsafe)\s+)*)(?:(\w[\w.<>,\[\]?]*)\s+)(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:where\s+[^\n{]+\s*)?(?:\{|=>)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const modifiers = m[2];
      const returnType = m[3];
      const methodName = m[4];
      const paramsRaw = m[5];
      const lineStart = lineAt(content, m.index);

      // Skip bekannte nicht-Methoden
      if (['if', 'for', 'foreach', 'while', 'switch', 'catch', 'lock', 'using', 'return', 'new', 'throw', 'class', 'struct', 'namespace'].includes(methodName)) continue;
      if (['get', 'set', 'init', 'add', 'remove'].includes(methodName)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(/\s+/);
          return parts[parts.length - 1];
        })
        .filter(p => p && p.length > 0);

      const parentType = this.findParentType(content, m.index);
      const isAsync = modifiers.includes('async');

      symbols.push({
        symbol_type: 'function',
        name: methodName,
        value: isAsync ? 'async' : undefined,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: m[0].includes('{') ? this.findClosingBrace(content, m.index + m[0].length - 1) : lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // Konstruktoren
    const ctorRe = /^([ \t]+)((?:(?:public|protected|private|internal|static)\s+)*)(\w+)\s*\(([^)]*)\)\s*(?::\s*(?:base|this)\s*\([^)]*\)\s*)?\{/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      const modifiers = m[2];
      const name = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      const parentType = this.findParentType(content, m.index);
      if (parentType !== name) continue;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'constructor',
        params,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Properties
    // ══════════════════════════════════════════════
    const propRe = /^([ \t]+)((?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|required)\s+)*)(\w[\w.<>,\[\]?]*)\s+(\w+)\s*\{(?:\s*(?:get|set|init)\s*[;{])/gm;
    while ((m = propRe.exec(content)) !== null) {
      const modifiers = m[2];
      const propType = m[3];
      const propName = m[4];
      const lineStart = lineAt(content, m.index);
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: propName,
        value: propType,
        return_type: propType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Felder
    // ══════════════════════════════════════════════
    const fieldRe = /^([ \t]+)((?:(?:public|protected|private|internal|static|readonly|volatile|const|new)\s+)+)(\w[\w.<>,\[\]?]*)\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
    while ((m = fieldRe.exec(content)) !== null) {
      const modifiers = m[2];
      const fieldType = m[3];
      const fieldName = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: fieldName,
        value: value || fieldType,
        return_type: fieldType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Delegates und Events
    // ══════════════════════════════════════════════
    const delegateRe = /^([ \t]*)((?:(?:public|protected|private|internal)\s+)*)delegate\s+(\w[\w.<>,\[\]?]*)\s+(\w+)\s*\(([^)]*)\)\s*;/gm;
    while ((m = delegateRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[4],
        value: 'delegate',
        return_type: m[3],
        line_start: lineAt(content, m.index),
        is_exported: isExportedMod(m[2]),
      });
    }

    const eventRe = /^([ \t]+)((?:(?:public|protected|private|internal|static)\s+)*)event\s+(\w[\w.<>,]*)\s+(\w+)\s*;/gm;
    while ((m = eventRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[4],
        value: `event ${m[3]}`,
        line_start: lineAt(content, m.index),
        is_exported: isExportedMod(m[2]),
        parent_id: this.findParentType(content, m.index),
      });
    }

    // ══════════════════════════════════════════════
    // 8. Attributes ([Attribute])
    // ══════════════════════════════════════════════
    const attrRe = /^\s*\[(\w+)(?:\([^)]*\))?\]/gm;
    while ((m = attrRe.exec(content)) !== null) {
      const name = m[1];
      if (['assembly', 'module'].includes(name.toLowerCase())) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
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
    // 10. XML-Doc-Comments (/// <summary>)
    // ══════════════════════════════════════════════
    const lines = content.split('\n');
    let docBlock: string[] = [];
    let docStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('///')) {
        if (docBlock.length === 0) docStart = i + 1;
        docBlock.push(line.replace(/^\/\/\/\s?/, '').replace(/<[^>]+>/g, '').trim());
      } else {
        if (docBlock.length >= 1) {
          const text = docBlock.join(' ').trim();
          if (text.length > 3) {
            symbols.push({
              symbol_type: 'comment',
              name: null,
              value: text.slice(0, 500),
              line_start: docStart,
              line_end: docStart + docBlock.length - 1,
              is_exported: false,
            });
          }
        }
        docBlock = [];
      }
    }
    if (docBlock.length >= 1) {
      const text = docBlock.join(' ').trim();
      if (text.length > 3) {
        symbols.push({
          symbol_type: 'comment',
          name: null,
          value: text.slice(0, 500),
          line_start: docStart,
          line_end: docStart + docBlock.length - 1,
          is_exported: false,
        });
      }
    }

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 11. Routes — ASP.NET Core Attributes [HttpGet("/api/x")] etc.
    // ══════════════════════════════════════════════
    const aspnetAttrRouteRe = /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)\s*\(\s*"([^"]+)"/g;
    while ((m = aspnetAttrRouteRe.exec(content)) !== null) {
      const method = ASPNET_ATTRIBUTES[m[1]];
      const path = m[2];
      if (!method) continue;
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method.toUpperCase()],
        line_start: lineStart,
        is_exported: true,
      });
    }

    // [Route("/api/x")] — kein Method-Hinweis, default GET
    const aspnetRouteAttrRe = /\[Route\s*\(\s*"([^"]+)"/g;
    while ((m = aspnetRouteAttrRe.exec(content)) !== null) {
      const path = m[1];
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName('get', path),
        value: path,
        params: ['GET'],
        line_start: lineStart,
        is_exported: true,
      });
    }

    // Minimal API: app.MapGet("/api/x", ...)
    const minimalApiRe = /\bapp\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"/g;
    while ((m = minimalApiRe.exec(content)) !== null) {
      const method = m[1].toLowerCase();
      const path = m[2];
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method.toUpperCase()],
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 12. Embedded SQL — new SqlCommand("...") und Dapper connection.Execute("...")
    // ══════════════════════════════════════════════
    const sqlCommandRe = /\bnew\s+SqlCommand\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = sqlCommandRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (!looksLikeSql(sqlText)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
    }

    const dapperRe = /\bconnection\.(?:Execute|Query|QueryFirst|QuerySingle)\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = dapperRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (!looksLikeSql(sqlText)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
    }

    const { statements, callEdges } = extractCSharpFlow(content);
    return { symbols, references, statements, callEdges };
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

  // Typ-Grenzen EINMAL vorwaerts sammeln statt pro Treffer rueckwaerts zu suchen.
  private grenzenText: string | null = null;
  private typDeklarationen: Array<{ klammer: number; name: string }> = [];
  private schliessendeKlammern: number[] = [];

  private bereiteTypGrenzenVor(content: string): void {
    if (content === this.grenzenText) return;
    this.grenzenText = content;
    this.typDeklarationen = [];
    this.schliessendeKlammern = [];
    const deklRe = /(?:class|struct|interface|enum|record)\s+(\w+)[^{]*\{/g;
    let d: RegExpExecArray | null;
    while ((d = deklRe.exec(content)) !== null) {
      this.typDeklarationen.push({ klammer: d.index + d[0].length - 1, name: d[1] });
    }
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 125) this.schliessendeKlammern.push(i);
    }
  }

  /**
   * In welcher Typ-Deklaration liegt pos? Bildet die alte Regex exakt nach,
   * einschliesslich ihrer Eigenheit: String.match ohne g liefert den am weitesten
   * LINKS beginnenden Treffer, bei Verschachtelung also die AEUSSERE Deklaration.
   */
  private findParentType(content: string, pos: number): string | undefined {
    this.bereiteTypGrenzenVor(content);
    let lo = 0;
    let hi = this.schliessendeKlammern.length;
    while (lo < hi) {
      const mitte = (lo + hi) >> 1;
      if (this.schliessendeKlammern[mitte] < pos) lo = mitte + 1;
      else hi = mitte;
    }
    const letzteZu = lo > 0 ? this.schliessendeKlammern[lo - 1] : -1;
    let a = 0;
    let b = this.typDeklarationen.length;
    while (a < b) {
      const mitte = (a + b) >> 1;
      if (this.typDeklarationen[mitte].klammer <= letzteZu) a = mitte + 1;
      else b = mitte;
    }
    const kandidat = this.typDeklarationen[a];
    return kandidat && kandidat.klammer < pos ? kandidat.name : undefined;
  }
}

export const csharpParser = new CSharpParser();
