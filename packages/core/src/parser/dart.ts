/**
 * MODUL: Dart Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Dart-Dateien
 *
 * EXTRAHIERT: class, mixin, extension, enum, function, method,
 *             field, import/export, typedef, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';

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

// ---------------------------------------------------------------------------
// Flow-Extraction fuer Dart
// ---------------------------------------------------------------------------

interface DartScope {
  type: string;
  name: string | null;
  braceDepth: number;
  orderCounter: number;
}

function extractDartFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = () => `s${tempId++}`;
  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, scope: DartScope): number {
    if (parentId === undefined) return scope.orderCounter++;
    const key = `p:${parentId}`; const cur = orderCounters.get(key) ?? 0; orderCounters.set(key, cur + 1); return cur;
  }
  const lines = content.split('\n');
  const scopeStack: DartScope[] = [{ type: 'module', name: null, braceDepth: 0, orderCounter: 0 }];
  const currentScope = () => scopeStack[scopeStack.length - 1];
  let globalBraceDepth = 0;
  const parentAtBrace = new Map<number, string>();

  const callRe = /\b([\w.]+)\s*\(/g;
  function extractCalls(expr: string, stmtId: string, scopeName: string | null, line: number, isAwaited: boolean): void {
    callRe.lastIndex = 0; let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(expr)) !== null) {
      const raw = cm[1]; if (!raw || /^(if|for|while|switch|try|catch|return|throw|new|await|async|void|int|double|bool|String|List|Map|Set|Future|Stream)$/.test(raw)) continue;
      const parts = raw.split('.'); const callee = parts[parts.length - 1]; const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: callee, callee_receiver: receiver, line_number: line, call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function') });
    }
  }

  const classRe = /^\s*(?:abstract\s+)?(?:class|mixin|enum|extension)\s+(\w+)/;
  const funcRe = /^\s*(?:(?:static|async|Future|void|int|double|bool|String|List|Map|Set|[\w<>?[\]]+)\s+)+(\w+)\s*\([^)]*\)\s*(?:async\s*)?\{/;
  const topFuncRe = /^(?:(?:async\s+)?(?:Future|void|int|double|bool|String|[\w<>?[\]]+)\s+)(\w+)\s*\(/;
  const ifRe = /^\s*(?:} else )?if\s*\((.+?)\)\s*(?:\{|$)/;
  const elseRe = /^\s*\}\s*else\s*(?:\{|$)/;
  const forRe = /^\s*(?:for|await\s+for)\s*\((.+?)\)\s*(?:\{|$)/;
  const whileRe = /^\s*while\s*\((.+?)\)\s*(?:\{|$)/;
  const doRe = /^\s*do\s*\{/;
  const switchRe = /^\s*switch\s*\((.+?)\)\s*\{/;
  const tryRe = /^\s*try\s*\{/;
  const catchRe = /^\s*\}\s*(?:on\s+\w+\s+)?catch\s*\((.+?)\)\s*\{/;
  const onRe = /^\s*\}\s*on\s+(\w+)\s*(?:catch\s*\([^)]*\))?\s*\{/;
  const finallyRe = /^\s*\}\s*finally\s*\{/;
  const returnRe = /^\s*return\s+(.*);/;
  const throwRe = /^\s*throw\s+(.*);/;
  const awaitExpr = /\bawait\b/;
  const varRe = /^\s*(?:final|const|var|late\s+(?:final\s+)?)?(?:[\w<>?[\]]+\s+)(\w+)\s*=\s*(.+);/;
  const callStmtRe = /^\s*([\w.]+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; const lineNum = i + 1; const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      for (const ch of trimmed) { if (ch === '{') globalBraceDepth++; else if (ch === '}') { globalBraceDepth--; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); } }
      continue;
    }
    let openCount = 0, closeCount = 0;
    for (const ch of trimmed) { if (ch === '{') openCount++; else if (ch === '}') closeCount++; }
    const scope = currentScope();
    const depth = Math.max(0, globalBraceDepth - scope.braceDepth);
    let parentId: string | undefined = undefined;
    if (globalBraceDepth > scope.braceDepth) { for (let bd = globalBraceDepth; bd >= scope.braceDepth; bd--) { if (parentAtBrace.has(bd)) { parentId = parentAtBrace.get(bd); break; } } }
    const isTop = scope.type === 'module' && depth === 0;
    let dm: RegExpExecArray | null;

    // class/mixin/enum/extension -> scope
    if ((dm = classRe.exec(trimmed)) !== null && openCount > 0) {
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'class', name: dm[1], braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD; continue;
    }
    // method/function
    if ((dm = funcRe.exec(trimmed)) !== null && openCount > 0 && scope.type !== 'module') {
      const funcName = dm[1];
      const cls = scopeStack.find(s => s.type === 'class')?.name ?? null;
      const fullName = cls ? `${cls}.${funcName}` : funcName;
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'method', name: fullName, braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD;
      for (const k of Array.from(parentAtBrace.keys())) { if (k >= globalBraceDepth) parentAtBrace.delete(k); }
      continue;
    }
    // top-level function
    if ((dm = topFuncRe.exec(trimmed)) !== null && openCount > 0 && globalBraceDepth === 0) {
      const funcName = dm[1];
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'function', name: funcName, braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD;
      for (const k of Array.from(parentAtBrace.keys())) { if (k >= globalBraceDepth) parentAtBrace.delete(k); }
      continue;
    }
    // if / else if
    if ((dm = ifRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'if', node_kind: trimmed.includes('else if') ? 'else_if' : 'if', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if (elseRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'if', node_kind: 'else', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'else {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // for
    if ((dm = forRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'for', node_kind: 'for', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: awaitExpr.test(trimmed), condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // while
    if ((dm = whileRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'while', node_kind: 'while', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if (doRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'do', node_kind: 'do', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'do {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // switch
    if ((dm = switchRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'switch', node_kind: 'switch', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // try/catch/on/finally
    if (tryRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'try', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'try {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = catchRe.exec(trimmed)) !== null) {
      const cond = dm[1]?.slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'catch', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = onRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'on', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if (finallyRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'finally', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'finally {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // return/throw
    if ((dm = returnRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? ''; const isAwaited = awaitExpr.test(expr); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'return', node_kind: 'return', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited });
      if (expr) extractCalls(expr, id, scope.name, lineNum, isAwaited);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = throwRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? ''; const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'throw', node_kind: 'throw', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // variable
    if ((dm = varRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const lhs = dm[1].slice(0, 120); const rhs = dm[2]; const isAwaited = awaitExpr.test(rhs); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: isAwaited ? 'await' : 'variable', node_kind: 'var', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited, assigned_to: lhs });
      extractCalls(rhs, id, scope.name, lineNum, isAwaited);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // plain call
    if ((dm = callStmtRe.exec(trimmed)) !== null && scope.type !== 'module' && !trimmed.match(/^\s*(?:class|mixin|enum|extension|import|export|part|abstract|final|const|var|late|@)\b/)) {
      const callExpr = dm[1]; const parts = callExpr.split('.'); const callee = parts[parts.length - 1]; const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      const isAwaited = awaitExpr.test(trimmed); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: isAwaited ? 'await' : 'call', node_kind: 'call', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited, callee, receiver });
      callEdges.push({ statement_temp_id: id, caller_scope: scope.name, callee_name: callee, callee_receiver: receiver, line_number: lineNum, call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function') });
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    globalBraceDepth += openCount - closeCount;
    while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
  }
  return { statements, callEdges };
}

class DartParser implements LanguageParser {
  language = 'dart';
  extensions = ['.dart'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Eltern-Typ ueber vorberechnete Grenzen statt Rueckwaertssuche je Treffer.
  version = 3;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Imports / Exports
    // ══════════════════════════════════════════════
    const importRe = /^(import|export)\s+'([^']+)'(?:\s+as\s+(\w+))?(?:\s+(?:show|hide)\s+[\w,\s]+)?;/gm;
    while ((m = importRe.exec(content)) !== null) {
      const kind = m[1];
      const uri = m[2];
      const alias = m[3];
      const name = alias || uri.split('/').pop()?.replace('.dart', '') || uri;
      symbols.push({
        symbol_type: 'import',
        name,
        value: uri,
        line_start: lineAt(content, m.index),
        is_exported: kind === 'export',
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // part / part of
    const partRe = /^part\s+(?:of\s+)?'([^']+)';/gm;
    while ((m = partRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1].split('/').pop()?.replace('.dart', '') || m[1],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Classes, Mixins, Extensions, Enums
    // ══════════════════════════════════════════════
    const typeRe = /^(abstract\s+)?(class|mixin|enum)\s+(\w+)(?:<[^>]+>)?(?:\s+(?:extends|with|implements|on)\s+([^\n{]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const isAbstract = !!m[1];
      const kind = m[2];
      const name = m[3];
      const clause = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'mixin' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (clause) {
        parents.push(...clause.split(/,|\s+with\s+|\s+implements\s+/).map(s =>
          s.trim().split('<')[0].trim()
        ).filter(s => s && !['extends', 'with', 'implements', 'on'].includes(s)));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: isAbstract ? `abstract ${kind}` : kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !name.startsWith('_'),
      });

      for (const p of parents) {
        references.push({ symbol_name: p, line_number: lineStart, context: `${kind} ${name}` });
      }
    }

    // extension
    const extRe = /^extension\s+(\w+)?\s+on\s+(\w+)(?:<[^>]+>)?\s*\{/gm;
    while ((m = extRe.exec(content)) !== null) {
      const name = m[1] || m[2];
      references.push({
        symbol_name: m[2],
        line_number: lineAt(content, m.index),
        context: `extension ${m[1] || ''} on ${m[2]}`.trim(),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Functions / Methods
    // ══════════════════════════════════════════════
    const funcRe = /^(\s*)((?:(?:static|external|abstract)\s+)?)((?:Future|Stream|FutureOr|void|dynamic|int|double|String|bool|List|Map|Set|\w+)(?:<[^>]*>)?(?:\??)?)\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:async\s*\*?|sync\s*\*)?\s*(?:\{|=>|;)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const returnType = m[3];
      const name = m[4];
      const paramsRaw = m[5];
      const lineStart = lineAt(content, m.index);

      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'class', 'enum'].includes(name)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => {
          const clean = p.trim().replace(/^\{|\}$/g, '').replace(/^required\s+/, '').trim();
          const parts = clean.split(/\s+/);
          return parts[parts.length - 1]?.replace(/[?]$/, '') || '';
        })
        .filter(p => p && !p.startsWith('//'));

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !name.startsWith('_'),
        parent_id: parentType,
      });
    }

    // Constructors
    const ctorRe = /^(\s*)(?:const\s+)?(\w+)(?:\.(\w+))?\s*\(([^)]*)\)\s*(?::\s*[^\n{]+)?\s*(?:\{|;)/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      const name = m[2];
      const named = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      const parentType = this.findParentType(content, m.index);
      if (parentType !== name) continue;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().replace(/^\{|\}$/g, '').replace(/^(required\s+)?this\./, '').split(/\s+/).pop()?.replace(/[?,]$/, '') || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name: named ? `${name}.${named}` : name,
        value: 'constructor',
        params,
        line_start: lineStart,
        is_exported: !name.startsWith('_'),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Fields / Properties
    // ══════════════════════════════════════════════
    const fieldRe = /^(\s+)((?:(?:static|late|final|const|external)\s+)*)(\w[\w<>,?]*)\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
    while ((m = fieldRe.exec(content)) !== null) {
      const modifiers = m[2];
      const fieldType = m[3];
      const name = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      if (['return', 'throw', 'print', 'assert'].includes(fieldType)) continue;
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || fieldType,
        return_type: fieldType,
        line_start: lineStart,
        is_exported: !name.startsWith('_'),
        parent_id: parentType,
      });
    }

    // Top-level const/final
    const topVarRe = /^((?:const|final)\s+)(?:(\w[\w<>,?]*)\s+)?(\w+)\s*=\s*([^;]+);/gm;
    while ((m = topVarRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[3],
        value: m[4].trim().slice(0, 200),
        return_type: m[2] || undefined,
        line_start: lineAt(content, m.index),
        is_exported: !m[3].startsWith('_'),
      });
    }

    // typedef
    const typedefRe = /^typedef\s+(\w+)\s*(?:<[^>]+>)?\s*=\s*(.+);/gm;
    while ((m = typedefRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: !m[1].startsWith('_'),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Annotations (@override, @injectable, etc.)
    // ══════════════════════════════════════════════
    const annotRe = /^\s*@(\w+)(?:\([^)]*\))?/gm;
    while ((m = annotRe.exec(content)) !== null) {
      const name = m[1];
      if (['override', 'protected', 'required', 'immutable', 'mustCallSuper'].includes(name)) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 6. TODO / FIXME / HACK
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
    // 7. Doc-Comments (/// und /** */)
    // ══════════════════════════════════════════════
    const lines = content.split('\n');
    let docBlock: string[] = [];
    let docStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('///')) {
        if (docBlock.length === 0) docStart = i + 1;
        docBlock.push(line.replace(/^\/\/\/\s?/, ''));
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

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 8. Routes — shelf_router / dart_frog / generic
    //    router.get('/x', handler), Router()..get('/x', ...) (Cascade)
    // ══════════════════════════════════════════════
    const dartRouteRe = /(?:\.\.|\.)\s*(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = dartRouteRe.exec(content)) !== null) {
      const verbLower = m[1].toLowerCase();
      if (!HTTP_VERBS.has(verbLower)) continue;
      const path = m[2];
      if (!isLikelyHttpPath(path)) continue;
      const verb = verbLower.toUpperCase();
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, path),
        value: path,
        params: [verb],
        line_start: lineStart,
        is_exported: false,
      });
    }

    const { statements, callEdges } = extractDartFlow(content);
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
  // Vorher kopierte findParentType je Treffer den gesamten Datei-Praefix und liess
  // eine $-verankerte Regex darueber laufen — O(Treffer x Dateigroesse).
  private grenzenText: string | null = null;
  private typDeklarationen: Array<{ klammer: number; name: string }> = [];
  private schliessendeKlammern: number[] = [];

  private bereiteTypGrenzenVor(content: string): void {
    if (content === this.grenzenText) return;
    this.grenzenText = content;
    this.typDeklarationen = [];
    this.schliessendeKlammern = [];
    const deklRe = /(?:class|mixin|enum|extension)\s+(\w+)[^{]*\{/g;
    let d: RegExpExecArray | null;
    while ((d = deklRe.exec(content)) !== null) {
      this.typDeklarationen.push({ klammer: d.index + d[0].length - 1, name: d[1] });
    }
    for (let i = 0; i < content.length; i++) {
      if (content.charCodeAt(i) === 125) this.schliessendeKlammern.push(i);
    }
  }

  /**
   * In welcher Typ-Deklaration liegt pos?
   *
   * Bildet die alte Regex exakt nach, einschliesslich ihrer Eigenheit: String.match
   * ohne g-Flag liefert den am weitesten LINKS beginnenden Treffer. Bei verschachtelten
   * Deklarationen ist das die AEUSSERE, nicht die naechstgelegene. Der Teilausdruck
   * \{[^}]*$ verlangt, dass zwischen der oeffnenden Klammer und pos keine schliessende
   * liegt — gesucht ist also die erste Deklaration hinter der letzten schliessenden
   * Klammer vor pos. Beides per Binaersuche statt per Praefix-Kopie.
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

export const dartParser = new DartParser();
