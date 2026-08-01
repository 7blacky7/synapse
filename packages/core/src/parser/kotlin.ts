/**
 * MODUL: Kotlin Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Kotlin-Dateien
 *
 * EXTRAHIERT: class, object, data class, sealed class, interface, enum,
 *             fun, val/var, import, package, annotation, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath, SPRING_DECORATORS, HTTP_VERBS } from './patterns/http.js';
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

// ---------------------------------------------------------------------------
// Flow-Extraction fuer Kotlin
// ---------------------------------------------------------------------------

interface KtScope {
  type: string;
  name: string | null;
  braceDepth: number;
  orderCounter: number;
}

function extractKotlinFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = () => `s${tempId++}`;
  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, scope: KtScope): number {
    if (parentId === undefined) return scope.orderCounter++;
    const key = `p:${parentId}`; const cur = orderCounters.get(key) ?? 0; orderCounters.set(key, cur + 1); return cur;
  }
  const lines = content.split('\n');
  const scopeStack: KtScope[] = [{ type: 'module', name: null, braceDepth: 0, orderCounter: 0 }];
  const currentScope = () => scopeStack[scopeStack.length - 1];
  let globalBraceDepth = 0;
  const parentAtBrace = new Map<number, string>();

  const callRe = /\b([\w.]+)\s*\(/g;
  function extractCalls(expr: string, stmtId: string, scopeName: string | null, line: number, isAwaited: boolean): void {
    callRe.lastIndex = 0; let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(expr)) !== null) {
      const raw = cm[1]; if (!raw || /^(if|for|while|when|try|catch|return|throw|fun|val|var|suspend|override|object|class|interface)$/.test(raw)) continue;
      const parts = raw.split('.'); const callee = parts[parts.length - 1]; const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: callee, callee_receiver: receiver, line_number: line, call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function') });
    }
  }

  const classRe = /^\s*(?:(?:public|protected|private|internal|open|abstract|sealed|data|inner|companion|value|inline|annotation|expect|actual)\s+)*(?:class|object|interface|enum\s+class)\s+(\w+)/;
  const funRe = /^\s*(?:(?:public|protected|private|internal|open|abstract|override|suspend|inline|tailrec|operator|infix|external|actual|expect)\s+)*fun\s+(?:<[^>]+>\s+)?(?:(\w+)\.)?([\w`]+)\s*\(/;
  const ifRe = /^\s*(?:} else )?if\s*\((.+?)\)\s*(?:\{|$)/;
  const elseRe = /^\s*\}\s*else\s*(?:\{|$)/;
  const forRe = /^\s*for\s*\((.+?)\)\s*(?:\{|$)/;
  const whileRe = /^\s*while\s*\((.+?)\)\s*(?:\{|$)/;
  const doRe = /^\s*do\s*\{/;
  const whenRe = /^\s*when\s*(?:\((.+?)\))?\s*\{/;
  const tryRe = /^\s*try\s*\{/;
  const catchRe = /^\s*\}\s*catch\s*\((.+?)\)\s*\{/;
  const finallyRe = /^\s*\}\s*finally\s*\{/;
  const returnRe = /^\s*return(?:@\w+)?\s+(.*)/;
  const throwRe = /^\s*throw\s+(.*)/;
  const valRe = /^\s*(?:val|var)\s+(\w+)(?::\s*[^\n=]+)?\s*=\s*(.+)/;
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

    if ((dm = classRe.exec(trimmed)) !== null && openCount > 0) {
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'class', name: dm[1], braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD; continue;
    }
    if ((dm = funRe.exec(trimmed)) !== null && openCount > 0) {
      const rec = dm[1]; const funcName = dm[2];
      const cls = rec ?? scopeStack.find(s => s.type === 'class')?.name ?? null;
      const fullName = cls ? `${cls}.${funcName}` : funcName;
      const newBD = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'method', name: fullName, braceDepth: newBD, orderCounter: 0 });
      globalBraceDepth = newBD;
      for (const k of Array.from(parentAtBrace.keys())) { if (k >= globalBraceDepth) parentAtBrace.delete(k); }
      continue;
    }
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
    if ((dm = forRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'for', node_kind: 'for', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
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
    if ((dm = whenRe.exec(trimmed)) !== null) {
      const cond = dm[1]?.slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'switch', node_kind: 'when', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      if (cond) extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if (tryRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'try', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'try {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = catchRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200); const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'catch', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, condition_text: cond });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if (finallyRe.test(trimmed)) {
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'try', node_kind: 'finally', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: 'finally {', is_top_level: isTop, is_awaited: false });
      if (openCount > 0) parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = returnRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? ''; const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'return', node_kind: 'return', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = throwRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? ''; const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'throw', node_kind: 'throw', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = valRe.exec(trimmed)) !== null) {
      const lhs = dm[1].slice(0, 120); const rhs = dm[2]; const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'variable', node_kind: 'val', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, assigned_to: lhs });
      extractCalls(rhs, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    if ((dm = callStmtRe.exec(trimmed)) !== null && scope.type !== 'module' && !trimmed.match(/^\s*(?:fun|val|var|class|object|interface|enum|import|package|@)\b/)) {
      const callExpr = dm[1]; const parts = callExpr.split('.'); const callee = parts[parts.length - 1]; const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      const id = nextId();
      statements.push({ temp_id: id, parent_temp_id: parentId, scope_type: scope.type, scope_name: scope.name, statement_type: 'call', node_kind: 'call', line_start: lineNum, line_end: lineNum, order_index: nextOrder(parentId, scope), depth, text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false, callee, receiver });
      callEdges.push({ statement_temp_id: id, caller_scope: scope.name, callee_name: callee, callee_receiver: receiver, line_number: lineNum, call_kind: receiver ? 'method' : 'function' });
      globalBraceDepth += openCount - closeCount; while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop(); continue;
    }
    globalBraceDepth += openCount - closeCount;
    while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
  }
  return { statements, callEdges };
}

class KotlinParser implements LanguageParser {
  language = 'kotlin';
  extensions = ['.kt', '.kts'];
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
    // 1. Package
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+([\w.]+)/m;
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
    const importRe = /^import\s+([\w.*]+)/gm;
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
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Classes, Objects, Interfaces, Enums
    // ══════════════════════════════════════════════
    const typeRe = /^(\s*)((?:(?:public|protected|private|internal|open|abstract|sealed|data|inner|value|inline|annotation|expect|actual)\s+)*)(class|object|interface|enum\s+class)\s+(\w+)(?:<[^>]+>)?(?:\s*(?:\([^)]*\)\s*)?)?(?:\s*:\s*([^\n{]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3].trim();
      const name = m[4];
      const baseClause = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface'
        : kind === 'enum class' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (baseClause) {
        parents.push(...baseClause.split(',').map(s =>
          s.trim().split('(')[0].split('<')[0].trim()
        ).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !/\bprivate\b/.test(modifiers),
      });

      for (const parent of parents) {
        if (parent) {
          references.push({
            symbol_name: parent,
            line_number: lineStart,
            context: `${kind} ${name} : ${baseClause?.trim()}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Functions (fun)
    // ══════════════════════════════════════════════
    const funRe = /^(\s*)((?:(?:public|protected|private|internal|open|override|abstract|suspend|inline|infix|operator|tailrec|expect|actual)\s+)*)fun\s+(?:<[^>]+>\s+)?(?:(\w+)\.)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*(\S[^\n{]*))?/gm;
    while ((m = funRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const extensionType = m[3] || undefined;
      const name = m[4];
      const paramsRaw = m[5];
      const returnType = m[6] ? m[6].trim().replace(/\s*\{$/, '') : undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].trim())
        .filter(Boolean);

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;
      const isSuspend = modifiers.includes('suspend');

      symbols.push({
        symbol_type: 'function',
        name: extensionType ? `${extensionType}.${name}` : name,
        value: isSuspend ? 'suspend' : undefined,
        params,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
        parent_id: parentType,
      });

      if (extensionType) {
        references.push({
          symbol_name: extensionType,
          line_number: lineStart,
          context: `fun ${extensionType}.${name}(...)`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Properties (val/var)
    // ══════════════════════════════════════════════
    const propRe = /^(\s*)((?:(?:public|protected|private|internal|open|override|abstract|const|lateinit|lazy)\s+)*)(val|var)\s+(\w+)(?:\s*:\s*(\S+))?\s*(?:=\s*([^\n]+))?/gm;
    while ((m = propRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const propType = m[5] || undefined;
      const value = m[6] ? m[6].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip lokale Variablen (zu tief eingerückt oder in Funktionen)
      if (indent > 4 && !modifiers.includes('const')) continue;

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || propType || kind,
        return_type: propType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Companion Objects (const val)
    // ══════════════════════════════════════════════
    const constValRe = /^\s+const\s+val\s+(\w+)(?:\s*:\s*\S+)?\s*=\s*(.+)/gm;
    while ((m = constValRe.exec(content)) !== null) {
      // Already caught by property regex, skip duplicates
    }

    // ══════════════════════════════════════════════
    // 7. Annotations
    // ══════════════════════════════════════════════
    const annotRe = /^\s*@(\w+)(?:\([^)]*\))?/gm;
    while ((m = annotRe.exec(content)) !== null) {
      const name = m[1];
      if (['JvmStatic', 'JvmField', 'JvmOverloads', 'Suppress'].includes(name)) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 8. TODO / FIXME / HACK
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
    // 9. KDoc-Kommentare (/** ... */)
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
    // 10. Routes — Spring: @GetMapping("/x"), @PostMapping(value = "/x"), ...
    // ══════════════════════════════════════════════
    const springRe = /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/g;
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
        is_exported: false,
      });
    }

    // @RequestMapping(value = "/path", method = [RequestMethod.GET])
    const reqMapRe = /@RequestMapping\s*\([^)]*value\s*=\s*["']([^"']+)["'][^)]*method\s*=\s*(?:\[\s*)?RequestMethod\.(GET|POST|PUT|PATCH|DELETE)/g;
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
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Routes — Ktor: get("/x") { ... }, post("/x") { ... }, route("/x") { ... }
    // Heuristik: Verb am Zeilenanfang (mit Whitespace) gefolgt von String-Argument + "{".
    // ══════════════════════════════════════════════
    const ktorRouteRe = /^\s*(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["']\s*\)\s*\{/gm;
    while ((m = ktorRouteRe.exec(content)) !== null) {
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

    // Ktor: call.respond innerhalb route("/path") { ... } — wir matchen route("/path") auch:
    const ktorRouteBlockRe = /^\s*route\s*\(\s*["']([^"']+)["']\s*\)\s*\{/gm;
    while ((m = ktorRouteBlockRe.exec(content)) !== null) {
      const path = m[1];
      if (!isLikelyHttpPath(path)) continue;
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName('ANY', path),
        value: path,
        params: ['ANY'],
        line_start: lineStart,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 12. Embedded SQL — Exposed/JDBC: exec("SELECT..."), prepareStatement("..."),
    //     transaction { exec(...) }, also Triple-Quoted Strings.
    // ══════════════════════════════════════════════
    const kotlinSqlRe = /\b(?:exec|prepareStatement|createStatement|executeQuery|executeUpdate)\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = kotlinSqlRe.exec(content)) !== null) {
      const sqlText = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
      if (!looksLikeSql(sqlText)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
    }

    // Triple-Quoted Strings ("""...""") als SQL-Kandidaten (Exposed raw SQL ist haeufig multiline)
    const kotlinTripleSqlRe = /"""([\s\S]{10,}?)"""/g;
    while ((m = kotlinTripleSqlRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (!looksLikeSql(sqlText)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
    }

    const { statements, callEdges } = extractKotlinFlow(content);
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
    const deklRe = /(?:class|object|interface|enum\s+class)\s+(\w+)[^{]*\{/g;
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
   * es die AEUSSERE — in Kotlin trifft das jedes companion object am Klassenanfang
   * — und, weit haeufiger, sobald vor pos ueberhaupt eine schliessende Klammer
   * stand und danach keine neue Deklaration folgte, lieferte es gar nichts.
   *
   * ABWEICHUNG VON cpp.ts, bewusst und nicht zu "vereinheitlichen": cpp liefert den
   * vollen Pfad ("Aussen::Innen"), die uebrigen acht Parser nur den innersten Namen.
   * Grund: java.ts und dart.ts erkennen Konstruktoren daran, dass der Eltern-Typ
   * GLEICH dem Symbolnamen ist. Ein Pfad waere nie gleich dem Namen — saemtliche
   * Konstruktoren fielen aus dem Index. Wer das angleichen will, muss zuerst diesen
   * Vergleich umbauen.
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

export const kotlinParser = new KotlinParser();
