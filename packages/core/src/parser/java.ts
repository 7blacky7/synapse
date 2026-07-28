/**
 * MODUL: Java Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Java-Dateien
 *
 * EXTRAHIERT: class, interface, enum, record, method, field, import,
 *             package, annotation, comment, todo
 * ANSATZ: Regex-basiert — Java hat konsistente Deklarations-Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { SPRING_DECORATORS, formatRouteName } from './patterns/http.js';
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

function endLineAt(text: string, pos: number, matchLength: number): number {
  return lineAt(text, pos + matchLength);
}

/** Java: public/protected = exported, private/package-private = nicht */
function isExportedMod(modifiers: string): boolean {
  return /\b(public|protected)\b/.test(modifiers);
}

// ---------------------------------------------------------------------------
// Flow-Extraction fuer Java
// ---------------------------------------------------------------------------

interface BraceScope {
  type: string;   // 'module' | 'function' | 'method' | 'class'
  name: string | null;
  braceDepth: number;
  orderCounter: number;
}

function extractJavaFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = () => `s${tempId++}`;
  const orderCounters = new Map<string, number>();

  function nextOrder(parentId: string | undefined, scope: BraceScope): number {
    if (parentId === undefined) return scope.orderCounter++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  const lines = content.split('\n');
  const scopeStack: BraceScope[] = [{ type: 'module', name: null, braceDepth: 0, orderCounter: 0 }];
  const currentScope = () => scopeStack[scopeStack.length - 1];
  let globalBraceDepth = 0;
  const parentAtBrace = new Map<number, string>();

  const callRe = /\b([\w.]+)\s*\(/g;
  function extractCalls(expr: string, stmtId: string, scopeName: string | null, line: number, isAwaited: boolean): void {
    callRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(expr)) !== null) {
      const raw = cm[1];
      if (!raw || /^(if|for|while|switch|catch|return|throw|new|synchronized|instanceof|void|int|long|boolean|String|var)$/.test(raw)) continue;
      const parts = raw.split('.');
      const callee = parts[parts.length - 1];
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      callEdges.push({
        statement_temp_id: stmtId, caller_scope: scopeName,
        callee_name: callee, callee_receiver: receiver,
        line_number: line,
        call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function'),
      });
    }
  }

  // Regex for Java method declaration
  const methodRe = /^\s*(?:(?:public|protected|private|static|final|abstract|synchronized|native|default|override)\s+)*(?:(?:[\w<>\[\],\s]+)\s+)([\w]+)\s*\([^)]*\)\s*(?:throws\s+[\w,\s]+)?\s*\{/;
  const classRe = /^\s*(?:(?:public|protected|private|static|final|abstract)\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)/;
  const ifRe = /^\s*(?:} else )?if\s*\((.+?)\)\s*(?:\{|$)/;
  const elseRe = /^\s*\}\s*else\s*(?:\{|$)/;
  const forRe = /^\s*for\s*\((.+?)\)\s*(?:\{|$)/;
  const whileRe = /^\s*while\s*\((.+?)\)\s*(?:\{|$)/;
  const doRe = /^\s*do\s*\{/;
  const switchRe = /^\s*switch\s*\((.+?)\)\s*\{/;
  const tryRe = /^\s*try\s*(?:(?:\([^)]*\))\s*)?\{/;
  const catchRe = /^\s*\}\s*catch\s*\((.+?)\)\s*\{/;
  const finallyRe = /^\s*\}\s*finally\s*\{/;
  const returnRe = /^\s*return\s+(.*);/;
  const throwRe = /^\s*throw\s+(.*);/;
  const varRe = /^\s*(?:(?:final|var)\s+)?(?:[\w<>\[\],?]+\s+)+([\w]+)\s*=\s*(.+);/;
  const callStmtRe = /^\s*([\w.]+)\s*\(/;
  const newStmtRe = /^\s*new\s+(\w+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      for (const ch of trimmed) {
        if (ch === '{') globalBraceDepth++;
        else if (ch === '}') { globalBraceDepth--; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); }
      }
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

    // class/interface/enum -> new scope
    if ((dm = classRe.exec(trimmed)) !== null && openCount > 0) {
      const newDepth = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'class', name: dm[1], braceDepth: newDepth, orderCounter: 0 });
      globalBraceDepth = newDepth;
      continue;
    }

    // method declaration
    if ((dm = methodRe.exec(trimmed)) !== null && openCount > 0 && scope.type !== 'module') {
      const methodName = dm[1];
      const className = scopeStack.find(s => s.type === 'class')?.name ?? null;
      const fullName = className ? `${className}.${methodName}` : methodName;
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'method', name: fullName, braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD;
      for (const k of Array.from(parentAtBrace.keys())) { if (k >= globalBraceDepth) parentAtBrace.delete(k); }
      continue;
    }

    // if / else if
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
    // else
    if (elseRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'if', node_kind: 'else', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'else {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
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
    // do
    if (doRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'do', node_kind: 'do', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'do {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // switch
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
    // try
    if (tryRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'try', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // catch
    if ((dm = catchRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'catch', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // finally
    if (finallyRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'finally', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'finally {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // return
    if ((dm = returnRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? '';
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'return', node_kind: 'return', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // throw
    if ((dm = throwRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? '';
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'throw', node_kind: 'throw', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // new statement
    if ((dm = newStmtRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const callee = dm[1];
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'new', node_kind: 'new', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, callee });
      callEdges.push({ statement_temp_id: id, caller_scope: scope.name, callee_name: callee, line_number: lineNum, call_kind: 'new' });
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // variable assignment
    if ((dm = varRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const lhs = dm[1].slice(0, 120);
      const rhs = dm[2];
      const hasNew = /\bnew\s+\w/.test(rhs);
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: hasNew ? 'new' : 'variable', node_kind: 'variable', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, assigned_to: lhs });
      extractCalls(rhs, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }
    // plain call
    if ((dm = callStmtRe.exec(trimmed)) !== null && scope.type !== 'module' && !trimmed.match(/^\s*(?:public|private|protected|static|final|class|interface|enum)\b/)) {
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

class JavaParser implements LanguageParser {
  language = 'java';
  extensions = ['.java'];
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
    // 1. Package-Deklaration
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+([\w.]+)\s*;/m;
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
    const importRe = /^import\s+(?:static\s+)?([\w.*]+)\s*;/gm;
    while ((m = importRe.exec(content)) !== null) {
      const pkg = m[1];
      const name = pkg.split('.').pop() || pkg;
      symbols.push({
        symbol_type: 'import',
        name,
        value: pkg,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name === '*' ? pkg.split('.').slice(-2, -1)[0] || pkg : name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Klassen, Interfaces, Enums, Records
    // ══════════════════════════════════════════════
    const classRe = /^([ \t]*)((?:(?:public|protected|private|static|abstract|final|sealed|non-sealed)\s+)*)(class|interface|enum|record|@interface)\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+([\w.<>,\s]+))?(?:\s+implements\s+([\w.<>,\s]+))?\s*(?:\([^)]*\)\s*)?\{/gm;
    while ((m = classRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const extendsClause = m[5];
      const implementsClause = m[6];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' || kind === '@interface' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (extendsClause) {
        parents.push(...extendsClause.split(',').map(s => s.trim().split('<')[0]));
      }
      if (implementsClause) {
        parents.push(...implementsClause.split(',').map(s => s.trim().split('<')[0]));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExportedMod(modifiers),
      });

      for (const parent of parents) {
        if (parent) {
          references.push({
            symbol_name: parent,
            line_number: lineStart,
            context: `${kind} ${name} ${extendsClause ? 'extends ' + extendsClause.trim() : ''} ${implementsClause ? 'implements ' + implementsClause.trim() : ''}`.trim().slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methoden
    // ══════════════════════════════════════════════
    const methodRe = /^([ \t]+)((?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*)(?:(<[^>]+>)\s+)?(\w[\w.<>,\[\]]*)\s+(\w+)\s*\(([^)]*)\)(?:\s+throws\s+([\w.<>,\s]+))?\s*\{/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const modifiers = m[2];
      const returnType = m[4];
      const methodName = m[5];
      const paramsRaw = m[6];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      // Skip: class/interface/enum (already matched above)
      if (['class', 'interface', 'enum', 'record', 'new', 'if', 'for', 'while', 'switch', 'try', 'catch'].includes(methodName)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(/\s+/);
          return parts[parts.length - 1]; // letztes Wort = Parametername
        })
        .filter(p => p && p.length > 0);

      const parentClass = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: methodName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExportedMod(modifiers),
        parent_id: parentClass,
      });
    }

    // Konstruktoren
    const ctorRe = /^([ \t]+)((?:(?:public|protected|private)\s+)?)(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.<>,\s]+\s*)?\{/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      const modifiers = m[2];
      const name = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      // Nur wenn Name == umgebende Klasse (Konstruktor-Heuristik)
      const parentClass = this.findParentType(content, m.index);
      if (parentClass !== name) continue;

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
        parent_id: parentClass,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Felder (Variablen in Klassen)
    // ══════════════════════════════════════════════
    const fieldRe = /^([ \t]+)((?:(?:public|protected|private|static|final|volatile|transient)\s+)+)(\w[\w.<>,\[\]]*)\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
    while ((m = fieldRe.exec(content)) !== null) {
      const modifiers = m[2];
      const fieldType = m[3];
      const fieldName = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      const parentClass = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: fieldName,
        value: value || fieldType,
        return_type: fieldType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentClass,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Annotations (@Override, @Inject, etc.)
    // ══════════════════════════════════════════════
    const annotRe = /^[ \t]*@(\w+)(?:\([^)]*\))?/gm;
    while ((m = annotRe.exec(content)) !== null) {
      const name = m[1];
      if (['Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface'].includes(name)) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
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
    // 8. Block-Kommentare (/** ... */ und /* ... */)
    // ══════════════════════════════════════════════
    const blockCommentRe = /\/\*\*([\s\S]*?)\*\//g;
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

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 9. Spring-Routes: @GetMapping/@PostMapping/etc.
    // ══════════════════════════════════════════════
    const springRe = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\(\s*(?:value\s*=\s*)?"([^"]+)"/g;
    while ((m = springRe.exec(content)) !== null) {
      const decoName = m[1];
      const path = m[2];
      const method = SPRING_DECORATORS[decoName];
      if (!method) continue;
      const verb = method.toUpperCase();
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, path),
        value: path,
        params: [verb],
        line_start: lineStart,
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: false,
      });
    }

    // @RequestMapping(value = "/path", method = RequestMethod.GET)
    const reqMapRe = /@RequestMapping\s*\([^)]*value\s*=\s*"([^"]+)"[^)]*method\s*=\s*RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/g;
    while ((m = reqMapRe.exec(content)) !== null) {
      const path = m[1];
      const verb = m[2].toUpperCase();
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, path),
        value: path,
        params: [verb],
        line_start: lineStart,
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Embedded SQL: jdbcTemplate.* / prepareStatement
    // ══════════════════════════════════════════════
    const jdbcRe = /\bjdbcTemplate\.(?:query|queryForList|queryForObject|queryForMap|update|execute)\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = jdbcRe.exec(content)) !== null) {
      const sqlText = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
      if (!looksLikeSql(sqlText)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
    }

    const prepStmtRe = /\bprepareStatement\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = prepStmtRe.exec(content)) !== null) {
      const sqlText = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
      if (!looksLikeSql(sqlText)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
    }

    const { statements, callEdges } = extractJavaFlow(content);
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

  // Typ-Bereiche EINMAL vorwaerts sammeln statt pro Treffer rueckwaerts zu suchen.
  private grenzenText: string | null = null;
  private typBereiche: Array<{ name: string; start: number; end: number; eltern: number }> = [];

  private bereiteTypGrenzenVor(content: string): void {
    if (content === this.grenzenText) return;
    this.grenzenText = content;
    const nameAnKlammer = new Map<number, string>();
    const deklRe = /(?:class|interface|enum|record)\s+(\w+)[^{]*\{/g;
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
   * es die AEUSSERE, und — weit haeufiger — sobald vor pos ueberhaupt eine
   * schliessende Klammer stand und danach keine neue Deklaration folgte, lieferte
   * es gar nichts. Schon die zweite Methode einer gewoehnlichen Klasse verlor so
   * ihren Eltern-Typ.
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

export const javaParser = new JavaParser();
