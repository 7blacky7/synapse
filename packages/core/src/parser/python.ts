/**
 * MODUL: Python Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Python-Dateien
 *
 * EXTRAHIERT: function (def/async def), class, variable, import, decorator,
 *             comment, todo, const_object (__all__), string (docstrings)
 * ANSATZ: Regex-basiert — Python hat einrueckungsbasierte Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

/** Zeilennummer fuer eine Position im Text (1-basiert) */
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

/** Prueft ob ein Name "exported" ist (kein fuehrender Underscore) */
function isPublic(name: string): boolean {
  return !name.startsWith('_');
}

// ---------------------------------------------------------------------------
// Flow-Extraction fuer Python
// ---------------------------------------------------------------------------
// Erfasst ablaufrelevante Statements + CallEdges aus Python-Code.
// Ansatz: zeilenbasiert mit Einrueckungstiefe-Tracking.
// Scopes: 'module' (indent=0), 'function'/'method' (def/async def).
// is_top_level = scope_type==='module' && depth===0.
// ---------------------------------------------------------------------------

interface PyScope {
  type: string;      // 'module' | 'function' | 'method'
  name: string | null;
  indent: number;    // Einrueckung des Scope-Headers
  orderCounter: number;
}

function extractPythonFlow(
  content: string,
  lines: string[],
): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = () => `s${tempId++}`;
  const orderCounters = new Map<string, number>();

  function nextOrder(parentId: string | undefined, scope: PyScope): number {
    if (parentId === undefined) return scope.orderCounter++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  // Scope-Stack: module ist der aeussere Scope
  const scopeStack: PyScope[] = [{ type: 'module', name: null, indent: -1, orderCounter: 0 }];
  const currentScope = () => scopeStack[scopeStack.length - 1];

  // Parent-Stack: welches Statement ist der aktuelle "Container" pro depth
  // key = einrueckungstiefe -> temp_id des letzten Container-Statements
  const parentAtDepth = new Map<number, string>();

  // Hilfsfunktionen fuer callEdge-Extraktion aus einem Ausdruck
  const callRe = /\b([\w.]+)\s*\(/g;
  function extractCalls(expr: string, stmtId: string, scopeName: string | null, line: number, isAwaited: boolean): void {
    callRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(expr)) !== null) {
      const raw = cm[1];
      if (!raw || /^(if|for|while|with|except|return|yield|raise|not|and|or|in|is|lambda|print|len|range|type|isinstance|hasattr|getattr|setattr)$/.test(raw)) continue;
      const parts = raw.split('.');
      const callee = parts[parts.length - 1];
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
      const callKind = isAwaited ? 'await' : (receiver ? 'method' : 'function');
      callEdges.push({
        statement_temp_id: stmtId,
        caller_scope: scopeName,
        callee_name: callee,
        callee_receiver: receiver,
        line_number: line,
        call_kind: callKind,
      });
    }
  }

  // Berechne Einrueckungstiefe (Anzahl Leerzeichen)
  const getIndent = (line: string) => line.match(/^(\s*)/)?.[1].length ?? 0;

  // Scope-Austritt wenn Einrueckung zurueckgeht
  function popScopesForIndent(indent: number): void {
    while (scopeStack.length > 1 && scopeStack[scopeStack.length - 1].indent >= indent) {
      scopeStack.pop();
    }
  }

  // Verarbeitung einer einzelnen Zeile
  const defRe = /^(\s*)(async\s+)?def\s+(\w+)\s*\(/;
  const classDefRe = /^(\s*)class\s+(\w+)/;
  const ifRe = /^(\s*)if\s+(.+):/;
  const elifRe = /^(\s*)elif\s+(.+):/;
  const elseRe = /^(\s*)else\s*:/;
  const forRe = /^(\s*)(?:async\s+)?for\s+(\S+)\s+in\s+(.+):/;
  const whileRe = /^(\s*)while\s+(.+):/;
  const tryRe = /^(\s*)try\s*:/;
  const exceptRe = /^(\s*)except(?:\s+(.+))?:/;
  const finallyRe = /^(\s*)finally\s*:/;
  const withRe = /^(\s*)(?:async\s+)?with\s+(.+):/;
  const returnRe = /^(\s*)return(?:\s+(.+))?/;
  const yieldRe = /^(\s*)yield(?:\s+(.+))?/;
  const raiseRe = /^(\s*)raise(?:\s+(.+))?/;
  const awaitRe = /^(\s*)([\w.]+\s*=\s*)?await\s+(.+)/;
  const assignRe = /^(\s*)([\w.[\]"']+)\s*(?:[+\-*/|&^%]?=(?!=))\s*(.+)/;
  const callStmtRe = /^(\s*)([\w.]+)\s*\(/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;
    const trimmed = raw.trimEnd();
    if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;

    const indent = getIndent(raw);

    // Scope-Austritt
    popScopesForIndent(indent);
    const scope = currentScope();

    // Berechne depth = Anzahl aktiver scopes - 1 (module=0, jeder neue scope +1)
    // Aber depth im Statement-Sinne: wie tief innerhalb des aktuellen Scopes
    // Wir bestimmen depth als Einrueckungsdifferenz zum Scope-Kopf / 4 (oder 1 Stufe)
    const scopeIndent = scope.indent < 0 ? 0 : scope.indent + 4; // Erwartete Einrueckung im Scope
    const depth = Math.max(0, Math.floor((indent - scopeIndent) / 4));

    // Parent-Statement fuer aktuelle Tiefe
    // Wir verwenden indent-basiertes Parent-Tracking
    // Ein Statement bei indent X hat als Parent das letzte Container-Statement bei indent < X
    let parentId: string | undefined = undefined;
    if (indent > 0) {
      // Suche den naechsten Parent mit kleinerem indent
      for (let pi = indent - 1; pi >= 0; pi--) {
        if (parentAtDepth.has(pi)) {
          parentId = parentAtDepth.get(pi);
          break;
        }
      }
    }

    const isTop = scope.type === 'module' && depth === 0;

    // def/async def -> neuer Scope
    let dm: RegExpExecArray | null;
    if ((dm = defRe.exec(trimmed)) !== null) {
      const funcName = dm[3];
      const parentClass = scope.type === 'class' ? scope.name : null;
      const scopeType = parentClass ? 'method' : 'function';
      const fullName = parentClass ? `${parentClass}.${funcName}` : funcName;
      // Push als neuen Scope - aber wir registrieren ihn nicht als Statement (Deklaration, kein Ablauf)
      scopeStack.push({ type: scopeType, name: fullName, indent, orderCounter: 0 });
      // Loesche parent-Tracking fuer tiefere Ebenen
      for (const k of Array.from(parentAtDepth.keys())) {
        if (k >= indent) parentAtDepth.delete(k);
      }
      continue;
    }

    // class -> neuer Scope
    if ((dm = classDefRe.exec(trimmed)) !== null) {
      scopeStack.push({ type: 'class', name: dm[2], indent, orderCounter: 0 });
      for (const k of Array.from(parentAtDepth.keys())) {
        if (k >= indent) parentAtDepth.delete(k);
      }
      continue;
    }

    // if
    if ((dm = ifRe.exec(trimmed)) !== null) {
      const cond = dm[2].slice(0, 200);
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'if', node_kind: 'if',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: cond,
      });
      parentAtDepth.set(indent, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      continue;
    }

    // elif
    if ((dm = elifRe.exec(trimmed)) !== null) {
      const cond = dm[2].slice(0, 200);
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'if', node_kind: 'elif',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: cond,
      });
      parentAtDepth.set(indent, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      continue;
    }

    // else
    if (elseRe.test(trimmed)) {
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'if', node_kind: 'else',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: 'else:', is_top_level: isTop, is_awaited: false,
      });
      parentAtDepth.set(indent, id);
      continue;
    }

    // for
    if ((dm = forRe.exec(trimmed)) !== null) {
      const cond = `${dm[2]} in ${dm[3]}`.slice(0, 200);
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
      parentAtDepth.set(indent, id);
      extractCalls(dm[3], id, scope.name, lineNum, false);
      continue;
    }

    // while
    if ((dm = whileRe.exec(trimmed)) !== null) {
      const cond = dm[2].slice(0, 200);
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'while', node_kind: 'while',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: cond,
      });
      parentAtDepth.set(indent, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      continue;
    }

    // try
    if (tryRe.test(trimmed)) {
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'try', node_kind: 'try',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: 'try:', is_top_level: isTop, is_awaited: false,
      });
      parentAtDepth.set(indent, id);
      continue;
    }

    // except
    if ((dm = exceptRe.exec(trimmed)) !== null) {
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'try', node_kind: 'except',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: dm[2]?.slice(0, 200),
      });
      parentAtDepth.set(indent, id);
      continue;
    }

    // finally
    if (finallyRe.test(trimmed)) {
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'try', node_kind: 'finally',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: 'finally:', is_top_level: isTop, is_awaited: false,
      });
      parentAtDepth.set(indent, id);
      continue;
    }

    // with
    if ((dm = withRe.exec(trimmed)) !== null) {
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'try', node_kind: 'with',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: dm[2].slice(0, 200),
      });
      parentAtDepth.set(indent, id);
      extractCalls(dm[2], id, scope.name, lineNum, false);
      continue;
    }

    // return
    if ((dm = returnRe.exec(trimmed)) !== null) {
      const expr = dm[2] ?? '';
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
      continue;
    }

    // yield
    if ((dm = yieldRe.exec(trimmed)) !== null) {
      const expr = dm[2] ?? '';
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'return', node_kind: 'yield',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
      });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      continue;
    }

    // raise
    if ((dm = raiseRe.exec(trimmed)) !== null) {
      const expr = dm[2] ?? '';
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'throw', node_kind: 'raise',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
      });
      if (expr) extractCalls(expr, id, scope.name, lineNum, false);
      continue;
    }

    // await expr (mit optionaler Zuweisung)
    if ((dm = awaitRe.exec(trimmed)) !== null) {
      const assignTo = dm[2]?.trim().replace(/\s*=\s*$/, '');
      const expr = dm[3];
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'await', node_kind: 'await',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: true,
        assigned_to: assignTo?.slice(0, 120),
      });
      extractCalls(expr, id, scope.name, lineNum, true);
      continue;
    }

    // assignment: x = expr
    if ((dm = assignRe.exec(trimmed)) !== null) {
      const lhs = dm[2].slice(0, 120);
      const rhs = dm[3];
      // Pruefe auf new-Aufruf (Python: keine new-Syntax, aber ClassName() zaehlt als call)
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'assignment', node_kind: 'assignment',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        assigned_to: lhs,
      });
      extractCalls(rhs, id, scope.name, lineNum, false);
      continue;
    }

    // plain call statement
    if ((dm = callStmtRe.exec(trimmed)) !== null) {
      const callExpr = dm[2];
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
        line_number: lineNum,
        call_kind: receiver ? 'method' : 'function',
      });
      // Auch Argumente auf calls scannen
      extractCalls(trimmed.slice(dm[0].length), id, scope.name, lineNum, false);
      continue;
    }
  }

  return { statements, callEdges };
}

class PythonParser implements LanguageParser {
  language = 'python';
  extensions = ['.py', '.pyw'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Imports (import X / from X import Y)
    // ══════════════════════════════════════════════
    const importRe = /^(from\s+([\w.]+)\s+import\s+(.+)|import\s+(.+))/gm;
    while ((m = importRe.exec(content)) !== null) {
      const line = lineAt(content, m.index);
      if (m[2]) {
        // from X import Y, Z
        const module = m[2];
        const names = m[3].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        symbols.push({
          symbol_type: 'import',
          name: module,
          value: `from ${module} import ${names.join(', ')}`,
          params: names,
          line_start: line,
          is_exported: false,
        });
        references.push({
          symbol_name: module,
          line_number: line,
          context: m[0].trim().slice(0, 80),
        });
      } else if (m[4]) {
        // import X, Y
        const modules = m[4].split(',').map(s => s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
        for (const mod of modules) {
          symbols.push({
            symbol_type: 'import',
            name: mod,
            value: m[0].trim(),
            line_start: line,
            is_exported: false,
          });
          references.push({
            symbol_name: mod,
            line_number: line,
            context: m[0].trim().slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 2. Klassen (class Name(Base):)
    // ══════════════════════════════════════════════
    const classRe = /^(class)\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/gm;
    while ((m = classRe.exec(content)) !== null) {
      const className = m[2];
      const bases = m[3] ? m[3].split(',').map(s => s.trim()).filter(Boolean) : [];
      const lineStart = lineAt(content, m.index);

      // Endzeile: naechste Zeile mit gleicher oder weniger Einrueckung (oder EOF)
      const lineEnd = this.findBlockEnd(lines, lineStart - 1);

      symbols.push({
        symbol_type: 'class',
        name: className,
        value: bases.length > 0 ? `(${bases.join(', ')})` : undefined,
        params: bases,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPublic(className),
      });

      // Referenzen auf Basisklassen
      for (const base of bases) {
        const baseName = base.split('[')[0].split('(')[0].trim();
        if (baseName && baseName !== 'object') {
          references.push({
            symbol_name: baseName,
            line_number: lineStart,
            context: `class ${className}(${bases.join(', ')})`,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. Funktionen (def / async def)
    // ══════════════════════════════════════════════
    const funcRe = /^( *)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^\n:]+))?\s*:/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const isAsync = !!m[2];
      const funcName = m[3];
      const paramsRaw = m[4];
      const returnType = m[5] ? m[5].trim() : undefined;
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findBlockEnd(lines, lineStart - 1);

      // Parameter parsen (self/cls entfernen)
      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].split('=')[0].trim())
        .filter(p => p && p !== 'self' && p !== 'cls');

      // Ist es eine Methode (eingerueckt) oder top-level?
      const isMethod = indent > 0;
      const parentClass = isMethod ? this.findParentClass(lines, lineStart - 1) : undefined;

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        value: isAsync ? 'async' : undefined,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPublic(funcName),
        parent_id: parentClass,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Top-Level Variablen / Konstanten
    // ══════════════════════════════════════════════
    const varRe = /^([A-Z_][A-Z0-9_]*)\s*(?::\s*[^\n=]+)?\s*=\s*(.+)/gm;
    while ((m = varRe.exec(content)) !== null) {
      const varName = m[1];
      const value = m[2].trim().slice(0, 200);
      const line = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: varName,
        value,
        line_start: line,
        is_exported: isPublic(varName),
      });
    }

    // Lowercase top-level assignments (nur am Zeilenanfang, nicht in Funktionen)
    const assignRe = /^([a-z_]\w*)\s*(?::\s*[^\n=]+)?\s*=\s*(.+)/gm;
    while ((m = assignRe.exec(content)) !== null) {
      // Nur echte Top-Level Variablen (keine Einrueckung)
      const lineIdx = lineAt(content, m.index) - 1;
      if (lineIdx < lines.length && lines[lineIdx].match(/^\S/)) {
        const varName = m[1];
        // Skip bekannte Keywords/Patterns
        if (['if', 'else', 'elif', 'for', 'while', 'with', 'try', 'except', 'finally', 'return', 'yield'].includes(varName)) continue;
        const value = m[2].trim().slice(0, 200);

        symbols.push({
          symbol_type: 'variable',
          name: varName,
          value,
          line_start: lineIdx + 1,
          is_exported: isPublic(varName),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. __all__ (explizite Exports)
    // ══════════════════════════════════════════════
    const allRe = /__all__\s*=\s*\[([^\]]*)\]/gs;
    while ((m = allRe.exec(content)) !== null) {
      const exports = m[1]
        .split(',')
        .map(s => s.trim().replace(/['"]/g, ''))
        .filter(Boolean);
      symbols.push({
        symbol_type: 'const_object',
        name: '__all__',
        value: exports.join(', '),
        params: exports,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Decorators (@decorator)
    // ══════════════════════════════════════════════
    const decoratorRe = /^( *)@(\w[\w.]*(?:\([^)]*\))?)/gm;
    while ((m = decoratorRe.exec(content)) !== null) {
      const decName = m[2].split('(')[0];
      const line = lineAt(content, m.index);
      references.push({
        symbol_name: decName,
        line_number: line,
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 7. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 8. Block-Kommentare (zusammenhaengende #-Zeilen)
    // ══════════════════════════════════════════════
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#') && !line.match(/^#\s*(TODO|FIXME|HACK)/i)) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(line.replace(/^#\s?/, ''));
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
    // 9. Docstrings (Triple-Quote Strings nach def/class)
    // ══════════════════════════════════════════════
    const docstringRe = /(?:def|class)\s+\w+[^:]*:\s*\n\s*("""[\s\S]*?"""|'''[\s\S]*?''')/g;
    while ((m = docstringRe.exec(content)) !== null) {
      const docText = m[1].replace(/^"""|"""$|^'''|'''$/g, '').trim();
      if (docText.length > 3) {
        symbols.push({
          symbol_type: 'string',
          name: null,
          value: docText.slice(0, 500),
          line_start: lineAt(content, m.index + m[0].indexOf(m[1])),
          line_end: lineAt(content, m.index + m[0].length),
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 10. String-Literale als benannte Symbole (via Helper)
    // ══════════════════════════════════════════════
    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 11. Routes — Flask: @app.route('/path', methods=['GET', 'POST'])
    // ══════════════════════════════════════════════
    const flaskRouteRe = /@\w+\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?/g;
    while ((m = flaskRouteRe.exec(content)) !== null) {
      const routePath = m[1];
      if (!isLikelyHttpPath(routePath)) continue;
      const methodsRaw = m[2];
      const methods = methodsRaw
        ? methodsRaw.split(',').map(s => s.trim().replace(/['"]/g, '').toUpperCase()).filter(Boolean)
        : ['GET'];
      const line = lineAt(content, m.index);
      for (const method of methods) {
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName(method, routePath),
          value: routePath,
          params: [method],
          line_start: line,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 12. Routes — FastAPI: @app.get('/path'), @router.post('/path')
    // ══════════════════════════════════════════════
    const fastapiRouteRe = /@\w+\.(get|post|put|patch|delete|head|options)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = fastapiRouteRe.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const routePath = m[2];
      if (!isLikelyHttpPath(routePath)) continue;
      const line = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, routePath),
        value: routePath,
        params: [method],
        line_start: line,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 13. Routes — Django: path('users/', views.user_list), re_path(...), url(...)
    // ══════════════════════════════════════════════
    const djangoRouteRe = /\b(?:path|re_path|url)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = djangoRouteRe.exec(content)) !== null) {
      const rawPath = m[1];
      // Django patterns sind oft ohne fuehrenden Slash — normalisieren
      const routePath = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
      const line = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName('GET', routePath),
        value: routePath,
        params: ['GET'],
        line_start: line,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 14. Embedded SQL — cursor.execute(...), cursor.executemany(...)
    // ══════════════════════════════════════════════
    const sqlExecRe = /\b(?:execute|executemany)\s*\(\s*['"]((?:[^'"\\]|\\.){10,})['"]/g;
    while ((m = sqlExecRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (looksLikeSql(sqlText)) {
        const baseLine = lineAt(content, m.index);
        symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
      }
    }

    const { statements, callEdges } = extractPythonFlow(content, lines);
    return { symbols, references, statements, callEdges };
  }

  /** Findet das Ende eines eingerueckten Blocks (naechste Zeile mit <= Einrueckung) */
  private findBlockEnd(lines: string[], startIdx: number): number {
    const startIndent = lines[startIdx].search(/\S/);
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue; // Leerzeilen ueberspringen
      const indent = line.search(/\S/);
      if (indent <= startIndent) return i; // Block endet eine Zeile vorher
    }
    return lines.length; // Bis zum Dateiende
  }

  /** Findet die uebergeordnete Klasse fuer eine Methode */
  private findParentClass(lines: string[], methodIdx: number): string | undefined {
    const methodIndent = lines[methodIdx].search(/\S/);
    for (let i = methodIdx - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.search(/\S/);
      if (indent < methodIndent) {
        const classMatch = line.match(/^(\s*)class\s+(\w+)/);
        if (classMatch) return classMatch[2];
        break;
      }
    }
    return undefined;
  }
}

export const pythonParser = new PythonParser();
