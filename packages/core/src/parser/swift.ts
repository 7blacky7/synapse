/**
 * MODUL: Swift Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Swift-Dateien
 *
 * EXTRAHIERT: class, struct, enum, protocol, extension, func, let/var,
 *             import, typealias, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, HTTP_VERBS } from './patterns/http.js';

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

function isExportedMod(modifiers: string): boolean {
  return /\b(public|open)\b/.test(modifiers) || !/\b(private|fileprivate|internal)\b/.test(modifiers);
}

// ---------------------------------------------------------------------------
// Flow-Extraction fuer Swift
// ---------------------------------------------------------------------------

interface SwScope {
  type: string;
  name: string | null;
  braceDepth: number;
  orderCounter: number;
}

function extractSwiftFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = () => `s${tempId++}`;
  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, scope: SwScope): number {
    if (parentId === undefined) return scope.orderCounter++;
    const key = `p:${parentId}`; const cur = orderCounters.get(key) ?? 0; orderCounters.set(key, cur + 1); return cur;
  }
  const lines = content.split('\n');
  const scopeStack: SwScope[] = [{ type: 'module', name: null, braceDepth: 0, orderCounter: 0 }];
  const currentScope = () => scopeStack[scopeStack.length - 1];
  let globalBraceDepth = 0;
  const parentAtBrace = new Map<number, string>();

  const callRe = /\b([\w.]+)\s*\(/g;
  function extractCalls(expr: string, stmtId: string, scopeName: string | null, line: number, isAwaited: boolean): void {
    callRe.lastIndex = 0; let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(expr)) !== null) {
      const raw = cm[1]; if (!raw || /^(if|for|while|switch|guard|defer|return|throw|func|let|var|class|struct|enum|protocol|extension|actor|await|async)$/.test(raw)) continue;
      const parts = raw.split('.'); const callee = parts[parts.length - 1]; const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: callee, callee_receiver: receiver, line_number: line, call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function') });
    }
  }

  const typeRe = /^\s*(?:(?:public|open|internal|private|fileprivate|final)\s+)*(?:class|struct|enum|protocol|actor|extension)\s+(\w+)/;
  const funcRe = /^\s*(?:(?:public|open|internal|private|fileprivate|final|override|static|class|mutating|nonmutating|lazy|weak|unowned|required|convenience|dynamic)\s+)*(?:async\s+)?func\s+(\w+)\s*(?:<[^>]+>)?\s*\(/;
  const initRe = /^\s*(?:(?:public|open|internal|private|fileprivate|required|convenience|override)\s+)*init\s*(?:\?|\!)?\s*\(/;
  const ifRe = /^\s*(?:} else )?if\s+(.+?)\s*\{/;
  const guardRe = /^\s*guard\s+(.+?)\s+else\s*\{/;
  const elseRe = /^\s*\}\s*else\s*\{/;
  const forRe = /^\s*for\s+(\S+)\s+in\s+(.+?)\s*\{/;
  const whileRe = /^\s*while\s+(.+?)\s*\{/;
  const repeatRe = /^\s*repeat\s*\{/;
  const switchRe = /^\s*switch\s+(.+?)\s*\{/;
  const doRe = /^\s*do\s*\{/;
  const catchRe = /^\s*\}\s*catch\s*(.+?)?\s*\{/;
  const deferRe = /^\s*defer\s*\{/;
  const returnRe = /^\s*return\s+(.*)/;
  const throwRe = /^\s*throw\s+(.*)/;
  const letRe = /^\s*(?:let|var)\s+(\w+)(?::\s*[^\n=]+)?\s*=\s*(.+)/;
  const awaitRe = /\bawait\b/;
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

    // type declaration -> scope
    if ((dm = typeRe.exec(trimmed)) !== null && openCount > 0) {
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'class', name: dm[1], braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD; continue;
    }
    // func
    if ((dm = funcRe.exec(trimmed)) !== null && openCount > 0) {
      const funcName = dm[1];
      const cls = scopeStack.find(s => s.type === 'class')?.name ?? null;
      const fullName = cls ? `${cls}.${funcName}` : funcName;
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'method', name: fullName, braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD;
      for (const k of Array.from(parentAtBrace.keys())) { if (k >= globalBraceDepth) parentAtBrace.delete(k); }
      continue;
    }
    // init
    if (initRe.test(trimmed) && openCount > 0) {
      const cls = scopeStack.find(s => s.type === 'class')?.name ?? null;
      const fullName = cls ? `${cls}.init` : 'init';
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'method', name: fullName, braceDepth: newBD, orderCounter: 0 });
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
    // guard
    if ((dm = guardRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'if', node_kind: 'guard', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
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
    // for-in
    if ((dm = forRe.exec(trimmed)) !== null) {
      const cond = `${dm[1]} in ${dm[2]}`.slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'for', node_kind: 'for', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(dm[2], id, scope.name, lineNum, false);
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
    if (repeatRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'do', node_kind: 'repeat', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'repeat {', is_top_level: isTop, is_awaited: false });
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
    // do/catch
    if (doRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'do', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'do {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = catchRe.exec(trimmed)) !== null) {
      const cond = dm[1]?.trim().slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'catch', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // defer
    if (deferRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'defer', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'defer {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // return/throw
    if ((dm = returnRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? ''; const isAwaited = awaitRe.test(expr); const id = nextId();
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
    // let/var
    if ((dm = letRe.exec(trimmed)) !== null) {
      const lhs = dm[1].slice(0, 120); const rhs = dm[2]; const isAwaited = awaitRe.test(rhs); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: isAwaited ? 'await' : 'variable', node_kind: 'let', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited, assigned_to: lhs });
      extractCalls(rhs, id, scope.name, lineNum, isAwaited);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    // plain call
    if ((dm = callStmtRe.exec(trimmed)) !== null && scope.type !== 'module' && !trimmed.match(/^\s*(?:func|let|var|class|struct|enum|protocol|extension|actor|import|@|public|private|internal|fileprivate|open)\b/)) {
      const callExpr = dm[1]; const parts = callExpr.split('.'); const callee = parts[parts.length - 1]; const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      const isAwaited = awaitRe.test(trimmed); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: isAwaited ? 'await' : 'call', node_kind: 'call', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited, callee, receiver });
      callEdges.push({ statement_temp_id: id, caller_scope: scope.name, callee_name: callee, callee_receiver: receiver, line_number: lineNum, call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function') });
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    globalBraceDepth += openCount - closeCount;
    while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
  }
  return { statements, callEdges };
}

class SwiftParser implements LanguageParser {
  language = 'swift';
  extensions = ['.swift'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Eltern-Typ ueber vorberechnete Grenzen statt Rueckwaertssuche je Treffer.
  // 4: Eltern-Typ ist jetzt die INNERSTE umschliessende Deklaration. Version 3
  //    bildete die alte match()-Semantik nach und verlor den Eltern-Typ, sobald
  //    vor der Fundstelle eine schliessende Klammer stand (siehe findParentType).
  version = 4;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Imports
    // ══════════════════════════════════════════════
    const importRe = /^import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?(\w[\w.]*)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const name = m[1].split('.').pop() || m[1];
      symbols.push({
        symbol_type: 'import',
        name,
        value: m[1],
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
    // 2. Classes, Structs, Enums, Protocols
    // ══════════════════════════════════════════════
    const typeRe = /^(\s*)((?:(?:public|open|internal|private|fileprivate|final)\s+)*)(class|struct|enum|protocol|actor)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\n{]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const conformance = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'protocol' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const protocols: string[] = [];
      if (conformance) {
        protocols.push(...conformance.split(',').map(s => s.trim().split('<')[0].trim()).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: protocols.length > 0 ? protocols : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExportedMod(modifiers),
      });

      for (const proto of protocols) {
        references.push({
          symbol_name: proto,
          line_number: lineStart,
          context: `${kind} ${name} : ${conformance?.trim()}`.slice(0, 80),
        });
      }
    }

    // Extensions
    const extRe = /^(\s*)((?:(?:public|private|fileprivate|internal)\s+)*)extension\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\n{]+))?\s*\{/gm;
    while ((m = extRe.exec(content)) !== null) {
      const name = m[3];
      const conformance = m[4];
      const lineStart = lineAt(content, m.index);

      references.push({
        symbol_name: name,
        line_number: lineStart,
        context: `extension ${name}${conformance ? ' : ' + conformance.trim() : ''}`.slice(0, 80),
      });

      if (conformance) {
        for (const proto of conformance.split(',').map(s => s.trim()).filter(Boolean)) {
          references.push({
            symbol_name: proto,
            line_number: lineStart,
            context: `extension ${name} : ${proto}`,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. Functions (func)
    // ══════════════════════════════════════════════
    const funcRe = /^(\s*)((?:(?:public|open|internal|private|fileprivate|static|class|override|mutating|@\w+\s+)*\s*)?)func\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*(?:throws|rethrows))?\s*(?:->\s*(\S[^\n{]*))?/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const name = m[3];
      const paramsRaw = m[4];
      const returnType = m[5] ? m[5].trim().replace(/\s*\{$/, '') : undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(':')[0].trim().split(/\s+/);
          return parts[parts.length - 1]; // external/internal name
        })
        .filter(p => p && p !== '_');

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // init()
    const initRe = /^(\s*)((?:(?:public|internal|private|fileprivate|required|convenience|override)\s+)*)init\??\s*\(([^)]*)\)/gm;
    while ((m = initRe.exec(content)) !== null) {
      const modifiers = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: 'init',
        value: 'constructor',
        params,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Properties (let/var)
    // ══════════════════════════════════════════════
    const propRe = /^(\s*)((?:(?:public|open|internal|private|fileprivate|static|class|lazy|weak|unowned|@\w+\s+)*\s*))(let|var)\s+(\w+)(?:\s*:\s*(\S[^\n=]*))?(?:\s*=\s*([^\n{]+))?/gm;
    while ((m = propRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const propType = m[5] ? m[5].trim() : undefined;
      const value = m[6] ? m[6].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip lokale Variablen
      if (indent > 8) continue;

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || propType || kind,
        return_type: propType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // typealias
    const typealiasRe = /^(\s*)(?:(?:public|internal|private|fileprivate)\s+)?typealias\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = typealiasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. TODO / FIXME / HACK
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
    // 6. Doc-Comments (/// und /** */)
    // ══════════════════════════════════════════════
    const docRe = /\/\*\*([\s\S]*?)\*\//g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 7. Routes — Vapor: app.get("path") { ... }, routes.post("a", "b", use: handler)
    // Multi-Path-Components werden als getrennte String-Argumente uebergeben und
    // mit "/" verbunden. Closure und/oder use:-Argument werden ignoriert.
    // ══════════════════════════════════════════════
    const vaporRouteRe = /\b(?:app|routes|router|group)\.(get|post|put|patch|delete|head|options)\s*\(\s*((?:"[^"]*"\s*,?\s*)+)/g;
    while ((m = vaporRouteRe.exec(content)) !== null) {
      const verbLower = m[1].toLowerCase();
      if (!HTTP_VERBS.has(verbLower)) continue;
      const argsRaw = m[2];
      const literalRe = /"([^"]*)"/g;
      const parts: string[] = [];
      let lm: RegExpExecArray | null;
      while ((lm = literalRe.exec(argsRaw)) !== null) {
        parts.push(lm[1]);
      }
      const cleanParts = parts.filter(p => p.length > 0);
      if (cleanParts.length === 0) continue;
      const path = '/' + cleanParts.join('/');
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

    const { statements, callEdges } = extractSwiftFlow(content);
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
  private typBereiche: Array<{ name: string; start: number; end: number; eltern: number }> = [];

  private bereiteTypGrenzenVor(content: string): void {
    if (content === this.grenzenText) return;
    this.grenzenText = content;
    const nameAnKlammer = new Map<number, string>();
    const deklRe = /(?:class|struct|enum|protocol|actor|extension)\s+(\w+)[^{]*\{/g;
    let d: RegExpExecArray | null;
    while ((d = deklRe.exec(content)) !== null) {
      nameAnKlammer.set(d.index + d[0].length - 1, d[1]);
    }
    // Ein einziger Durchlauf mit Klammer-Stapel paart jede oeffnende Klammer mit
    // ihrer schliessenden. Das ergibt echte Bereiche und bleibt linear in der
    // Dateigroesse — die Vorberechnung aus Version 3 wird dadurch nicht teurer.
    const bereiche: Array<{ name: string; start: number; end: number; eltern: number }> = [];
    const offen: number[] = [];
    for (let i = 0; i < content.length; i++) {
      const zeichen = content.charCodeAt(i);
      if (zeichen === 123) offen.push(i);
      else if (zeichen === 125) {
        const auf = offen.pop();
        if (auf === undefined) continue;
        const name = nameAnKlammer.get(auf);
        if (name !== undefined) bereiche.push({ name, start: auf, end: i, eltern: -1 });
      }
    }
    bereiche.sort((x, y) => x.start - y.start);
    // Elternkette: Typ-Bereiche sind ineinander geschachtelt und ueberlappen nie,
    // deshalb genuegt ein Stapel ueber die nach start sortierte Liste.
    const stapel: number[] = [];
    for (let i = 0; i < bereiche.length; i++) {
      while (stapel.length > 0 && bereiche[stapel[stapel.length - 1]].end < bereiche[i].start) stapel.pop();
      bereiche[i].eltern = stapel.length > 0 ? stapel[stapel.length - 1] : -1;
      stapel.push(i);
    }
    this.typBereiche = bereiche;
  }

  /**
   * In welcher Typ-Deklaration liegt pos? Geliefert wird die INNERSTE
   * umschliessende: der Scope eines Symbols ist die naechstgelegene Deklaration,
   * die es enthaelt — nur sie ergibt einen richtigen qualifizierten Namen.
   *
   * Bis Version 3 wurde hier die Eigenheit von String.match ohne g nachgebildet
   * ("erste Deklaration hinter der letzten schliessenden Klammer vor pos"). Das
   * war in zwei Faellen falsch: bei direkt verschachtelten Deklarationen lieferte
   * es die AEUSSERE — in Swift trifft das jede Deklaration am Anfang einer
   * extension oder eines struct — und, weit haeufiger, sobald vor pos ueberhaupt
   * eine schliessende Klammer stand und danach keine neue Deklaration folgte,
   * lieferte es gar nichts.
   */
  private findParentType(content: string, pos: number): string | undefined {
    this.bereiteTypGrenzenVor(content);
    const bereiche = this.typBereiche;
    let lo = 0;
    let hi = bereiche.length;
    while (lo < hi) {
      const mitte = (lo + hi) >> 1;
      if (bereiche[mitte].start < pos) lo = mitte + 1;
      else hi = mitte;
    }
    // Letzter Bereich, der vor pos beginnt. Endet er schon vor pos, ist er ein
    // abgeschlossener Nachbar — dann ueber die Elternkette nach aussen weiter.
    let i = lo - 1;
    while (i >= 0 && bereiche[i].end <= pos) i = bereiche[i].eltern;
    return i >= 0 ? bereiche[i].name : undefined;
  }
}

export const swiftParser = new SwiftParser();
