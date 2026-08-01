/**
 * MODUL: Rust Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Rust-Dateien
 *
 * EXTRAHIERT: fn, struct, enum, trait, impl, type alias, const/static,
 *             use, mod, macro, comment, todo
 * ANSATZ: Regex-basiert — Rust hat klare Deklarations-Syntax
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

function endLineAt(text: string, pos: number, matchLength: number): number {
  return lineAt(text, pos + matchLength);
}

/** Rust: pub = exported */
function isPub(line: string): boolean {
  return /^\s*pub\b/.test(line);
}

// ---------------------------------------------------------------------------
// Flow-Extraction fuer Rust
// ---------------------------------------------------------------------------

interface RustScope {
  type: string;   // 'module' | 'function' | 'method' | 'impl'
  name: string | null;
  braceDepth: number;
  orderCounter: number;
}

function extractRustFlow(
  content: string,
): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = () => `s${tempId++}`;
  const orderCounters = new Map<string, number>();

  function nextOrder(parentId: string | undefined, scope: RustScope): number {
    if (parentId === undefined) return scope.orderCounter++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  const lines = content.split('\n');
  const scopeStack: RustScope[] = [{ type: 'module', name: null, braceDepth: 0, orderCounter: 0 }];
  const currentScope = () => scopeStack[scopeStack.length - 1];
  let globalBraceDepth = 0;
  const parentAtBrace = new Map<number, string>();

  const callRe = /\b([\w:]+)\s*(?:::<[^>]*>)?\s*\(/g;
  function extractCalls(expr: string, stmtId: string, scopeName: string | null, line: number, isAwaited: boolean): void {
    callRe.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = callRe.exec(expr)) !== null) {
      const raw = cm[1];
      if (!raw || /^(if|while|for|loop|match|return|let|mut|pub|fn|impl|use|mod|struct|enum|trait|type|const|static|macro_rules|assert|assert_eq|assert_ne|println|eprintln|vec|format|panic|todo|unimplemented|unreachable)$/.test(raw)) continue;
      const parts = raw.split('::');
      const callee = parts[parts.length - 1];
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('::') : undefined;
      callEdges.push({
        statement_temp_id: stmtId,
        caller_scope: scopeName,
        callee_name: callee,
        callee_receiver: receiver,
        line_number: line,
        call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function'),
      });
    }
    // Method calls: expr.method(
    const methodRe = /\.([\w]+)\s*(?:::<[^>]*>)?\s*\(/g;
    methodRe.lastIndex = 0;
    while ((cm = methodRe.exec(expr)) !== null) {
      callEdges.push({
        statement_temp_id: stmtId,
        caller_scope: scopeName,
        callee_name: cm[1],
        line_number: line,
        call_kind: isAwaited ? 'await' : 'method',
      });
    }
  }

  const fnRe = /^\s*(?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/;
  const implRe = /^\s*(?:pub\s+)?impl(?:<[^>]*>)?\s+([\w:]+)/;
  const ifRe = /^\s*(?:} else )?if\s+(.+?)\s*\{/;
  const elseRe = /^\s*\}\s*else\s*\{/;
  const forRe = /^\s*for\s+(\S+)\s+in\s+(.+?)\s*\{/;
  const whileRe = /^\s*while\s+(.+?)\s*\{/;
  const loopRe = /^\s*loop\s*\{/;
  const matchRe = /^\s*match\s+(.+?)\s*\{/;
  const returnRe = /^\s*return\s*(.*)/;
  const letRe = /^\s*let\s+(?:mut\s+)?(\w+)(?::\s*[^=]+)?\s*=\s*(.+)/;
  const awaitRe = /\.await\b/;
  const callStmtRe = /^\s*([\w:]+(?:::\w+)*)\s*\(/;
  const questionRe = /\?\s*;?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNum = i + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      // count braces
      for (const ch of trimmed) {
        if (ch === '{') globalBraceDepth++;
        else if (ch === '}') {
          globalBraceDepth--;
          while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) {
            scopeStack.pop();
          }
        }
      }
      continue;
    }

    let openCount = 0, closeCount = 0;
    for (const ch of trimmed) {
      if (ch === '{') openCount++;
      else if (ch === '}') closeCount++;
    }

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

    // fn declaration
    if ((dm = fnRe.exec(trimmed)) !== null && globalBraceDepth <= 1) {
      const funcName = dm[1];
      const parentImpl = scopeStack.find(s => s.type === 'impl')?.name;
      const scopeType = parentImpl ? 'method' : 'function';
      const fullName = parentImpl ? `${parentImpl}.${funcName}` : funcName;
      const newBraceDepth = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: scopeType, name: fullName, braceDepth: newBraceDepth - openCount + closeCount + 1, orderCounter: 0 });
      globalBraceDepth = newBraceDepth;
      for (const k of Array.from(parentAtBrace.keys())) {
        if (k >= globalBraceDepth) parentAtBrace.delete(k);
      }
      continue;
    }

    // impl block
    if ((dm = implRe.exec(trimmed)) !== null && openCount > 0) {
      const implName = dm[1];
      const newBraceDepth = globalBraceDepth + openCount - closeCount;
      scopeStack.push({ type: 'impl', name: implName, braceDepth: newBraceDepth - openCount + closeCount + 1, orderCounter: 0 });
      globalBraceDepth = newBraceDepth;
      continue;
    }

    // if / else if
    if ((dm = ifRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
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
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
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
        text: 'else {', is_top_level: isTop, is_awaited: false,
      });
      parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    // for
    if ((dm = forRe.exec(trimmed)) !== null) {
      const cond = `${dm[1]} in ${dm[2]}`.slice(0, 200);
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
      extractCalls(dm[2], id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    // while
    if ((dm = whileRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
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
      parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    // loop
    if (loopRe.test(trimmed)) {
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'while', node_kind: 'loop',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: 'loop {', is_top_level: isTop, is_awaited: false,
      });
      parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    // match
    if ((dm = matchRe.exec(trimmed)) !== null) {
      const cond = dm[1].slice(0, 200);
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'switch', node_kind: 'match',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: false,
        condition_text: cond,
      });
      parentAtBrace.set(globalBraceDepth + openCount - 1, id);
      extractCalls(cond, id, scope.name, lineNum, false);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    // return
    if ((dm = returnRe.exec(trimmed)) !== null) {
      const expr = dm[1] ?? '';
      const isAwaited = awaitRe.test(expr);
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: 'return', node_kind: 'return',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited,
      });
      if (expr) extractCalls(expr, id, scope.name, lineNum, isAwaited);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    // let binding
    if ((dm = letRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const lhs = dm[1].slice(0, 120);
      const rhs = dm[2];
      const isAwaited = awaitRe.test(rhs);
      const hasNew = /\bnew\b/.test(rhs) || /\bBox::new\b/.test(rhs);
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: isAwaited ? 'await' : (hasNew ? 'new' : 'variable'),
        node_kind: 'let',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited,
        assigned_to: lhs,
      });
      extractCalls(rhs, id, scope.name, lineNum, isAwaited);
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    // plain call or method chain
    if ((dm = callStmtRe.exec(trimmed)) !== null && scope.type !== 'module') {
      const callExpr = dm[1];
      const parts = callExpr.split('::');
      const callee = parts[parts.length - 1];
      const receiver = parts.length > 1 ? parts.slice(0, -1).join('::') : undefined;
      const isAwaited = awaitRe.test(trimmed);
      const id = nextId();
      statements.push({
        temp_id: id, parent_temp_id: parentId,
        scope_type: scope.type, scope_name: scope.name,
        statement_type: isAwaited ? 'await' : 'call', node_kind: 'call',
        line_start: lineNum, line_end: lineNum,
        order_index: nextOrder(parentId, scope), depth,
        text: trimmed.slice(0, 240), is_top_level: isTop, is_awaited: isAwaited,
        callee, receiver,
      });
      callEdges.push({
        statement_temp_id: id, caller_scope: scope.name,
        callee_name: callee, callee_receiver: receiver,
        line_number: lineNum, call_kind: isAwaited ? 'await' : (receiver ? 'method' : 'function'),
      });
      globalBraceDepth += openCount - closeCount;
      while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) scopeStack.pop();
      continue;
    }

    globalBraceDepth += openCount - closeCount;
    while (scopeStack.length > 1 && globalBraceDepth < scopeStack[scopeStack.length - 1].braceDepth) {
      scopeStack.pop();
    }
  }

  return { statements, callEdges };
}

class RustParser implements LanguageParser {
  language = 'rust';
  extensions = ['.rs'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. use-Deklarationen (imports)
    // ══════════════════════════════════════════════
    const useRe = /^(?:pub\s+)?use\s+(.+);/gm;
    while ((m = useRe.exec(content)) !== null) {
      const path = m[1].trim();
      const name = path.split('::').pop()?.replace(/[{}*\s]/g, '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: path,
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
      const crate = path.split('::')[0];
      if (crate && crate !== 'self' && crate !== 'super' && crate !== 'crate') {
        references.push({
          symbol_name: crate,
          line_number: lineAt(content, m.index),
          context: m[0].trim().slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 2. mod-Deklarationen
    // ══════════════════════════════════════════════
    const modRe = /^(?:pub\s+)?mod\s+(\w+)\s*;/gm;
    while ((m = modRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: `mod ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Structs
    // ══════════════════════════════════════════════
    const structRe = /^(?:#\[[\w(,\s="]*\]\s*\n\s*)*(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)(?:<[^>]+>)?\s*\{([\s\S]*?)\n\}/gm;
    while ((m = structRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      const fields: string[] = [];
      const fieldRe = /^\s+(?:pub(?:\([\w:]+\))?\s+)?(\w+)\s*:\s*([^\n,]+)/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(body)) !== null) {
        fields.push(fm[1]);
        // Referenzen auf benutzerdefinierte Typen
        const typeRef = fm[2].trim().replace(/[&*<>\[\]]/g, ' ').split(/\s+/)[0];
        if (typeRef && /^[A-Z]/.test(typeRef) && !['String', 'Vec', 'Option', 'Result', 'Box', 'Arc', 'Rc', 'HashMap', 'HashSet', 'BTreeMap'].includes(typeRef)) {
          references.push({
            symbol_name: typeRef,
            line_number: lineAt(content, m.index + (fm.index || 0)),
            context: `${name}.${fm[1]}: ${fm[2].trim()}`.slice(0, 80),
          });
        }
      }

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub(m[0]),
      });
    }

    // Tuple structs: struct Name(Type);
    const tupleStructRe = /^(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)\s*;/gm;
    while ((m = tupleStructRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: `struct(${m[2].trim()})`,
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Enums
    // ══════════════════════════════════════════════
    const enumRe = /^(?:pub(?:\([\w:]+\))?\s+)?enum\s+(\w+)(?:<[^>]+>)?\s*\{([\s\S]*?)\n\}/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      const variants: string[] = [];
      const variantRe = /^\s+(\w+)/gm;
      let vm: RegExpExecArray | null;
      while ((vm = variantRe.exec(body)) !== null) {
        if (!['pub', 'fn', 'type', 'use', 'const', 'let'].includes(vm[1])) {
          variants.push(vm[1]);
        }
      }

      symbols.push({
        symbol_type: 'enum',
        name,
        params: variants,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub(m[0]),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Traits
    // ══════════════════════════════════════════════
    const traitRe = /^(?:pub(?:\([\w:]+\))?\s+)?trait\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\n{]+))?\s*\{([\s\S]*?)\n\}/gm;
    while ((m = traitRe.exec(content)) !== null) {
      const name = m[1];
      const superTraits = m[2] ? m[2].split('+').map(s => s.trim()).filter(Boolean) : [];
      const body = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      const methods: string[] = [];
      const methodRe = /fn\s+(\w+)/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(body)) !== null) {
        methods.push(mm[1]);
      }

      symbols.push({
        symbol_type: 'interface',
        name,
        value: superTraits.length > 0 ? superTraits.join(' + ') : undefined,
        params: methods,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub(m[0]),
      });

      for (const st of superTraits) {
        const stName = st.split('<')[0].trim();
        if (stName) {
          references.push({ symbol_name: stName, line_number: lineStart, context: `trait ${name}: ${superTraits.join(' + ')}` });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 6. impl Blocks
    // ══════════════════════════════════════════════
    const implRe = /^impl(?:<[^>]+>)?\s+(?:(\w+)(?:<[^>]+>)?\s+for\s+)?(\w+)(?:<[^>]+>)?\s*\{/gm;
    while ((m = implRe.exec(content)) !== null) {
      const traitName = m[1] || null;
      const typeName = m[2];
      const lineStart = lineAt(content, m.index);

      if (traitName) {
        references.push({
          symbol_name: traitName,
          line_number: lineStart,
          context: `impl ${traitName} for ${typeName}`,
        });
      }
      references.push({
        symbol_name: typeName,
        line_number: lineStart,
        context: traitName ? `impl ${traitName} for ${typeName}` : `impl ${typeName}`,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Funktionen (fn) — multi-line Signaturen + Trait-Method-Stubs
    //
    // Strategie: Erst nur den Header matchen (fn NAME), dann von der Position
    // aus die Parameter-Klammern per Balancing zaehlen, anschliessend bis zum
    // naechsten ';' oder '{' lesen. Das erfasst:
    //   - Multi-line Signaturen  fn foo(\n  a: T,\n  b: U\n) -> R { ... }
    //   - Trait-Method-Stubs     fn foo() -> R;
    //   - Komplexe Return-Types  fn foo() -> Result<HashMap<K,V>,E> { ... }
    //   - Lifetime/Generic-Mix   fn foo<'a, T: Trait<Item=U>>(x: &'a T)
    // ══════════════════════════════════════════════
    const fnHeaderRe = /^([ \t]*)((?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]+"\s+)?)?)fn\s+(\w+)/gm;
    while ((m = fnHeaderRe.exec(content)) !== null) {
      const indentStr = m[1];
      const modifiers = m[2] ?? '';
      const funcName = m[3];

      // Nach dem Namen: optionale Generics <...> per balanced matching ueberspringen,
      // dann die Parameter-Liste ( finden. Das ist robust gegen nested Generics wie
      // Fn(i32) -> i32 oder Iterator<Item = Vec<T>>.
      let cursor = m.index + m[0].length;
      while (cursor < content.length && /[ \t\n\r]/.test(content[cursor])) cursor++;
      if (content[cursor] === '<') {
        let genDepth = 1;
        cursor++;
        while (cursor < content.length && genDepth > 0) {
          const ch = content[cursor];
          if (ch === '<') genDepth++;
          else if (ch === '>') genDepth--;
          cursor++;
        }
      }
      while (cursor < content.length && /[ \t\n\r]/.test(content[cursor])) cursor++;
      if (content[cursor] !== '(') continue;
      const openParenPos = cursor;

      // Balanced paren matching fuer Parameter-Liste.
      // WICHTIG: Nur double-quoted Strings als Literal ueberspringen.
      // Rust-Lifetimes wie 'a oder '_ sind KEINE Strings — sie als Char-Literal zu
      // behandeln wuerde den Parser bis zum naechsten ' Zeichen durchfressen lassen.
      let depth = 1;
      let i = openParenPos + 1;
      while (i < content.length && depth > 0) {
        const c = content[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '"') {
          i++;
          while (i < content.length && content[i] !== '"') {
            if (content[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }
      if (depth !== 0) continue;
      const closeParenPos = i - 1;
      const paramsRaw = content.slice(openParenPos + 1, closeParenPos);

      // Return-Type/where-Klausel bis zum naechsten ';' oder '{' (Body).
      // -> ist Arrow-Operator: das > darf bracketDepth NICHT senken.
      let j = closeParenPos + 1;
      let bodyStart = -1;
      let isStub = false;
      let bracketDepth = 0;
      while (j < content.length) {
        const c = content[j];
        if (c === '-' && content[j + 1] === '>') { j += 2; continue; }
        if (c === '"') {
          j++;
          while (j < content.length && content[j] !== '"') {
            if (content[j] === '\\') j++;
            j++;
          }
          j++;
          continue;
        }
        if (c === '<' || c === '(' || c === '[') bracketDepth++;
        else if (c === '>' || c === ')' || c === ']') bracketDepth--;
        else if (bracketDepth === 0) {
          if (c === '{') { bodyStart = j; break; }
          if (c === ';') { isStub = true; break; }
        }
        j++;
      }
      if (!isStub && bodyStart === -1) continue;

      const header = content.slice(m.index, isStub ? j : bodyStart);
      const returnMatch = /->\s*(.+?)(?:\s+where\s+[\s\S]+)?$/.exec(header.slice(header.indexOf(')') + 1));
      const returnType = returnMatch ? returnMatch[1].trim() : undefined;

      const lineStart = lineAt(content, m.index);
      const lineEnd = isStub
        ? lineAt(content, j)
        : this.findClosingBrace(content, bodyStart);

      // Parameter parsen (multi-line tolerant)
      const params = paramsRaw
        .split(',')
        .map(p => p.replace(/\s+/g, ' ').trim().split(':')[0].replace(/^&?\s*mut\s+/, '').replace(/^&/, '').trim())
        .filter(p => p && p !== 'self' && p !== '&self' && p !== '&mut self');

      // Parent finden (impl Block) — immer versuchen, auch bei indent=0 (kann nested sein)
      const parentType = this.findImplType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        value: modifiers.includes('async') ? 'async' : (isStub ? 'stub' : undefined),
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 8. const / static
    // ══════════════════════════════════════════════
    const constRe = /^(?:pub(?:\([\w:]+\))?\s+)?(const|static)\s+(\w+)\s*:\s*([^=]+)=\s*([^;]+);/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[4].trim().slice(0, 200),
        return_type: m[3].trim(),
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
    }

    // type aliases
    const typeAliasRe = /^(?:pub(?:\([\w:]+\))?\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=\s*([^;]+);/gm;
    while ((m = typeAliasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
    }

    // ══════════════════════════════════════════════
    // 9. Macros (macro_rules!)
    // ══════════════════════════════════════════════
    const macroRe = /^(?:#\[macro_export\]\s*\n\s*)?macro_rules!\s+(\w+)/gm;
    while ((m = macroRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: `${m[1]}!`,
        value: 'macro',
        line_start: lineAt(content, m.index),
        is_exported: m[0].includes('macro_export'),
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
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
    // 11. Doc-Comments (/// und //!)
    // ══════════════════════════════════════════════
    const lines = content.split('\n');
    let docBlock: string[] = [];
    let docStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('///') || line.startsWith('//!')) {
        if (docBlock.length === 0) docStart = i + 1;
        docBlock.push(line.replace(/^\/\/[\/!]\s?/, ''));
      } else {
        if (docBlock.length >= 1) {
          symbols.push({
            symbol_type: 'comment',
            name: null,
            value: docBlock.join(' ').trim().slice(0, 500),
            line_start: docStart,
            line_end: docStart + docBlock.length - 1,
            is_exported: false,
          });
        }
        docBlock = [];
      }
    }
    if (docBlock.length >= 1) {
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: docBlock.join(' ').trim().slice(0, 500),
        line_start: docStart,
        line_end: docStart + docBlock.length - 1,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 12. Routes — axum: .route("/path", get(handler))
    // ══════════════════════════════════════════════
    const axumRouteRe = /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete|head|options)\s*\(/g;
    while ((m = axumRouteRe.exec(content)) !== null) {
      const path = m[1];
      const verb = m[2].toUpperCase();
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: `${verb} ${path}`,
        value: path,
        params: [verb],
        line_start: lineStart,
        line_end: lineStart,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 13. Routes — actix-web / rocket: #[get("/path")] Attribut-Macros
    // ══════════════════════════════════════════════
    const attrRouteRe = /#\[(get|post|put|patch|delete|head|options)\s*\(\s*"([^"]+)"\s*\)\]/g;
    while ((m = attrRouteRe.exec(content)) !== null) {
      const verb = m[1].toUpperCase();
      const path = m[2];
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: `${verb} ${path}`,
        value: path,
        params: [verb],
        line_start: lineStart,
        line_end: lineStart,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 14. Embedded-SQL — sqlx::query!, sqlx::query_as!, query!, query_as!
    // ══════════════════════════════════════════════
    const sqlxRe = /\b(?:sqlx::)?query(?:_as)?!\s*\(\s*(?:[A-Z]\w+\s*,\s*)?"((?:[^"\\]|\\.){10,})"/g;
    while ((m = sqlxRe.exec(content)) !== null) {
      const sqlContent = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (looksLikeSql(sqlContent)) {
        const baseLine = lineAt(content, m.index);
        symbols.push(...parseEmbeddedSql(sqlContent, filePath, baseLine));
      }
    }

    // ══════════════════════════════════════════════
    // String-Literale als benannte Symbole (via Helper — Rust: nur ", 'a' ist char)
    // ══════════════════════════════════════════════
    symbols.push(...extractStringLiterals(content));

    const { statements, callEdges } = extractRustFlow(content);
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

  /**
   * Findet den impl-Typ (Struct/Trait/Enum-Name) fuer eine Methode an Position fnPos.
   *
   * Strategie: Alle impl-Bloecke vor fnPos finden, pro Block die schliessende `}` per
   * Balanced-Matching bestimmen und pruefen ob fnPos innerhalb liegt. Der INNERSTE
   * (letzte vor fnPos, aber noch offen) ist der Container.
   */
  private findImplType(content: string, fnPos: number): string | undefined {
    const implHeaderRe = /^impl\b/gm;
    let match: RegExpExecArray | null;
    let result: string | undefined;
    while ((match = implHeaderRe.exec(content)) !== null) {
      if (match.index >= fnPos) break;

      // Impl-Header parsen: impl<Generics>? TraitName<...> for TypeName<...> { ... }
      // Name extrahieren (vor dem {) — letzter "richtiger" Name im Header.
      const openBracePos = content.indexOf('{', match.index);
      if (openBracePos === -1) break;
      const header = content.slice(match.index, openBracePos);

      // "impl Foo" | "impl<T> Foo<T>" | "impl<T> TraitA<T> for Bar<T>"
      let typeName: string | undefined;
      const forMatch = /\bfor\s+(\w+)/.exec(header);
      if (forMatch) {
        typeName = forMatch[1];
      } else {
        // Kein "for" — direkte impl auf einen Typ. Nimm den letzten Identifier vor dem {.
        const direct = /impl(?:<[^>]*>)?\s+(\w+)/.exec(header);
        if (direct) typeName = direct[1];
      }
      if (!typeName) continue;

      // Schliessende Klammer finden per Brace-Balancing
      let depth = 1;
      let i = openBracePos + 1;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '"') {
          i++;
          while (i < content.length && content[i] !== '"') {
            if (content[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }
      const closeBracePos = i - 1;

      // Liegt fnPos innerhalb dieses impl-Blocks?
      if (openBracePos < fnPos && fnPos < closeBracePos) {
        result = typeName; // Innerster gewinnt (wird weiter overridden wenn nested)
      }
    }
    return result;
  }
}

export const rustParser = new RustParser();
