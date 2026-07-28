/**
 * MODUL: Zig Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Zig-Dateien (.zig)
 *
 * EXTRAHIERT: fn (pub/export), const/var, struct, enum, union, error,
 *             test blocks, @import, comptime, usingnamespace,
 *             comment, todo
 * ANSATZ: Regex-basiert
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

// ---------------------------------------------------------------------------
// Flow extraction (Zig)
// ---------------------------------------------------------------------------

function lineAtZig(text: string, pos: number): number {
  return lineAt(text, pos);
}

function extractFlowZig(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextId = (): string => `s${tempIdCounter++}`;
  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, sc: { v: number }): number {
    if (parentId === undefined) return sc.v++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  function stripComments(src: string): string {
    return src.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  }

  function extractCalls(expr: string, stmtId: string, scopeName: string | null, lineNo: number): void {
    // method calls: receiver.method(
    const methodRe = /(\w+)\.(\w+)\s*\(/g;
    let mc: RegExpExecArray | null;
    while ((mc = methodRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineNo, call_kind: 'method' });
    }
    // plain fn calls
    const funcRe = /(?<![.\w])([a-zA-Z_]\w*)\s*\(/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1];
      if (['if','for','while','switch','return','try','catch','defer','errdefer','comptime','@import','@as','@intCast','@floatCast','@ptrCast','@sizeOf','@typeOf'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: name, line_number: lineNo, call_kind: name.startsWith('@') ? 'function' : 'function' });
    }
  }

  // Find fn bodies: fn name(...) ... {
  interface FnBody { name: string; bodyOffset: number; bodyContent: string; }
  function findFnBodies(src: string): FnBody[] {
    const bodies: FnBody[] = [];
    const stripped = stripComments(src);
    const fnRe = /^(?:\s*)(?:pub\s+)?(?:export\s+)?(?:inline\s+)?fn\s+(\w+)\s*\([^)]*\)[^{]*\{/gm;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(stripped)) !== null) {
      const name = m[1];
      const openBrace = m.index + m[0].length - 1;
      let depth = 1; let i = openBrace + 1;
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
      }
      bodies.push({ name, bodyOffset: openBrace + 1, bodyContent: src.slice(openBrace + 1, i - 1) });
    }
    return bodies;
  }

  function processBody(body: string, bodyOffset: number, scopeName: string, scopeType: string, isModule: boolean): void {
    const sc = { v: 0 };
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) { i++; continue; }
      const charOffset = lines.slice(0, i).reduce((a, l) => a + l.length + 1, 0);
      const fileLine = lineAtZig(content, bodyOffset + charOffset);
      const isTop = isModule && true; // for top-level only

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: scopeType, scope_name: isModule ? null : scopeName, statement_type: type, node_kind: kind, line_start: fileLine, order_index: sc.v++, depth: 0, is_top_level: isTop, is_awaited: false, text: trimmed.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      // if / if-else
      if (/^\s*if\s*\(/.test(line)) {
        const cm = line.match(/if\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*.*$/, '').slice(0, 200) : undefined;
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, isModule ? null : scopeName, fileLine);
      // for loop (Zig: for (slice) |item| {)
      } else if (/^\s*for\s*\(/.test(line)) {
        const cm = line.match(/for\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*.*$/, '').slice(0, 200) : undefined;
        const st = emit('for', 'ForStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, isModule ? null : scopeName, fileLine);
      // while loop (Zig: while (cond) { or while (cond) |val| {)
      } else if (/^\s*while\s*\(/.test(line)) {
        const cm = line.match(/while\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*.*$/, '').slice(0, 200) : undefined;
        const st = emit('while', 'WhileStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, isModule ? null : scopeName, fileLine);
      // switch
      } else if (/^\s*switch\s*\(/.test(line)) {
        const cm = line.match(/switch\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('switch', 'SwitchExpression', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, isModule ? null : scopeName, fileLine);
      // defer
      } else if (/^\s*defer\b/.test(line)) {
        const expr = trimmed.replace(/^defer\s*/, '').replace(/;$/, '');
        const st = emit('call', 'DeferStatement', { callee: 'defer' });
        extractCalls(expr, st.temp_id, isModule ? null : scopeName, fileLine);
      // errdefer
      } else if (/^\s*errdefer\b/.test(line)) {
        const expr = trimmed.replace(/^errdefer\s*/, '').replace(/;$/, '');
        const st = emit('call', 'ErrDeferStatement', { callee: 'errdefer' });
        extractCalls(expr, st.temp_id, isModule ? null : scopeName, fileLine);
      // return
      } else if (/^\s*return\b/.test(line)) {
        const expr = trimmed.replace(/^return\s*/, '').replace(/;$/, '');
        const st = emit('return', 'ReturnStatement');
        if (expr) extractCalls(expr, st.temp_id, isModule ? null : scopeName, fileLine);
      // try expr (Zig: try someCall())
      } else if (/^\s*(?:const|var)\s+\w+\s*=\s*try\s+/.test(line) || /^\s*try\s+\w+/.test(line)) {
        const varM = trimmed.match(/(?:(?:const|var)\s+(\w+)\s*=\s*)?try\s+(.+)/);
        const st = emit('call', 'TryExpression', { assigned_to: varM?.[1], callee: 'try', is_awaited: true });
        if (varM?.[2]) extractCalls(varM[2], st.temp_id, isModule ? null : scopeName, fileLine);
      // const/var assignment
      } else if (/^\s*(?:const|var)\s+\w+/.test(line)) {
        const vm = trimmed.match(/(?:const|var)\s+(\w+)(?:\s*:\s*\S+)?\s*=\s*(.+)/);
        if (vm) {
          const st = emit('variable', 'VariableDeclaration', { assigned_to: vm[1].slice(0, 120) });
          extractCalls(vm[2].replace(/;$/, ''), st.temp_id, isModule ? null : scopeName, fileLine);
        }
      // plain assignment
      } else if (/^\s*\w[\w.*\[\]]*\s*(?:[+*/%&|^-]?=)\s*.+;/.test(line)) {
        const am = trimmed.match(/^(\w[\w.*\[\]]*)\s*(?:[+*/%&|^-]?=)\s*(.+);/);
        if (am) {
          const st = emit('assignment', 'AssignmentExpression', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, isModule ? null : scopeName, fileLine);
        }
      // function call statement: expr();
      } else if (/\w+\s*\(/.test(trimmed) && /;$/.test(trimmed) && !/^\s*(?:if|for|while|switch|return|defer|errdefer|const|var|fn|pub|try)/.test(line)) {
        const cm2 = trimmed.match(/(?:(\w+)\.)?(\w+)\s*\(/);
        if (cm2) {
          const st = emit('call', 'CallExpression', { callee: cm2[2], receiver: cm2[1] || undefined });
          extractCalls(trimmed, st.temp_id, isModule ? null : scopeName, fileLine);
        }
      }
      i++;
    }
  }

  const bodies = findFnBodies(content);
  for (const fb of bodies) {
    processBody(fb.bodyContent, fb.bodyOffset, fb.name, 'function', false);
  }

  return { statements, callEdges };
}

class ZigParser implements LanguageParser {
  language = 'zig';
  extensions = ['.zig'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Imports (@import)
    // ══════════════════════════════════════════════
    const importRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*@import\s*\(\s*"([^"]+)"\s*\)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const module = m[4];
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'import',
        name,
        value: module,
        line_start: lineStart,
        is_exported: isPub,
      });

      references.push({
        symbol_name: module.replace('.zig', ''),
        line_number: lineStart,
        context: `@import("${module}")`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Structs
    // ══════════════════════════════════════════════
    const structRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*(packed\s+|extern\s+)?struct\s*(?:\([^)]*\)\s*)?\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const modifier = m[4] ? m[4].trim() : '';
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: modifier ? `${modifier} struct` : 'struct',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });

      // Parse struct fields
      this.parseStructFields(content, m.index + m[0].length, lineEnd, name, symbols);
    }

    // ══════════════════════════════════════════════
    // 3. Enums
    // ══════════════════════════════════════════════
    const enumRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*(extern\s+)?enum(?:\s*\([^)]*\))?\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'enum',
        name,
        value: 'enum',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });

      // Parse enum values
      const block = content.substring(m.index + m[0].length);
      const valRe = /^\s*(\w+)(?:\s*=\s*[^,\n]+)?\s*,/gm;
      let vm: RegExpExecArray | null;
      while ((vm = valRe.exec(block)) !== null) {
        const valLine = lineAt(content, m.index + m[0].length + vm.index);
        if (valLine > lineEnd) break;
        if (vm[1] === 'pub' || vm[1] === 'fn' || vm[1] === 'const') continue;

        symbols.push({
          symbol_type: 'variable',
          name: vm[1],
          value: 'enum_value',
          line_start: valLine,
          is_exported: isPub,
          parent_id: name,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Unions
    // ══════════════════════════════════════════════
    const unionRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*(packed\s+|extern\s+)?union(?:\s*\([^)]*\))?\s*\{/gm;
    while ((m = unionRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'union',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Error sets
    // ══════════════════════════════════════════════
    const errorRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*error\s*\{/gm;
    while ((m = errorRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'enum',
        name,
        value: 'error',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Functions (fn)
    // ══════════════════════════════════════════════
    const fnRe = /^(\s*)(pub\s+)?(export\s+)?(inline\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(?:(\w[\w!.*\s]*))?(?:\s*\{)?/gm;
    while ((m = fnRe.exec(content)) !== null) {
      const indent = m[1].length;
      const isPub = !!m[2];
      const isExport = !!m[3];
      const isInline = !!m[4];
      const name = m[5];
      const paramsRaw = m[6];
      const returnType = m[7] ? m[7].trim() : undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(':');
          return parts[0].replace(/comptime\s+/, '').trim();
        })
        .filter(p => p && p !== 'self' && p !== '_');

      const parentStruct = indent > 0 ? this.findParentStruct(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        value: isExport ? 'export' : isInline ? 'inline' : undefined,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: isPub || isExport,
        parent_id: parentStruct,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Constants and variables (not imports/structs/enums)
    // ══════════════════════════════════════════════
    // Collect names already captured by type definitions
    const typeNames = new Set(
      symbols.filter(s => ['class', 'enum', 'import'].includes(s.symbol_type) && s.name)
        .map(s => s.name!)
    );

    const constRe = /^(\s*)(pub\s+)?(const|var)\s+(\w+)\s*(?::\s*(\S+))?\s*=\s*(.+)/gm;
    while ((m = constRe.exec(content)) !== null) {
      const indent = m[1].length;
      const isPub = !!m[2];
      const kind = m[3];
      const name = m[4];
      const varType = m[5] || undefined;
      const value = m[6].trim().replace(/;$/, '').slice(0, 200);
      const lineStart = lineAt(content, m.index);

      // Skip type definitions already captured (struct, enum, union, error, import)
      if (typeNames.has(name)) continue;
      if (/^(?:@import|(?:packed\s+|extern\s+)?(?:struct|enum|union)|error)\s*[({]/.test(value)) continue;

      // Skip deeply nested locals
      if (indent > 4) continue;

      const parentStruct = indent > 0 ? this.findParentStruct(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        return_type: varType,
        line_start: lineStart,
        is_exported: isPub,
        parent_id: parentStruct,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Test blocks
    // ══════════════════════════════════════════════
    const testRe = /^test\s+"([^"]+)"\s*\{/gm;
    while ((m = testRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: `test "${m[1]}"`,
        value: 'test',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 9. usingnamespace
    // ══════════════════════════════════════════════
    const usingRe = /^(\s*)(pub\s+)?usingnamespace\s+(\S+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[3].split('.').pop() || m[3],
        value: `usingnamespace ${m[3]}`,
        line_start: lineAt(content, m.index),
        is_exported: !!m[2],
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
    // 11. Doc comments (/// ...)
    // ══════════════════════════════════════════════
    const docRe = /((?:\/\/\/[^\n]*\n)+)/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/\/\/\/\s?/g, '').trim();
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
    // 12. Embedded SQL (zqlite, pg.zig: db.exec/query/queryRow/prepare/...)
    // ══════════════════════════════════════════════
    const sqlCallRe = /\b\w+\.(?:exec|execNoArgs|query|queryRow|rowsAffected|prepare)\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = sqlCallRe.exec(content)) !== null) {
      const raw = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
      if (!looksLikeSql(raw)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(raw, filePath, baseLine));
    }

    // ══════════════════════════════════════════════
    // 13. Embedded SQL in Zig multiline strings (\\ ... am Zeilenanfang)
    // ══════════════════════════════════════════════
    const multilineRe = /(?:^[ \t]*\\\\.*\n?)+/gm;
    while ((m = multilineRe.exec(content)) !== null) {
      const block = m[0];
      const inner = block
        .split('\n')
        .map(l => l.replace(/^[ \t]*\\\\ ?/, ''))
        .join('\n')
        .replace(/\n+$/, '');
      if (inner.length < 10) continue;
      if (!looksLikeSql(inner)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(inner, filePath, baseLine));
    }

    const { statements, callEdges } = extractFlowZig(content);
    return { symbols, references, statements, callEdges };
  }

  private parseStructFields(
    content: string, blockStart: number, blockLineEnd: number,
    parentName: string, symbols: ParsedSymbol[]
  ): void {
    const block = content.substring(blockStart);
    const fieldRe = /^\s+(\w+)\s*:\s*(\S[^,\n]*)/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(block)) !== null) {
      const fieldLine = lineAt(content, blockStart + fm.index);
      if (fieldLine > blockLineEnd) break;

      const name = fm[1];
      if (['pub', 'fn', 'const', 'var', 'comptime'].includes(name)) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: fm[2].trim().replace(/,$/, ''),
        line_start: fieldLine,
        is_exported: true,
        parent_id: parentName,
      });
    }
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

  private findParentStruct(content: string, pos: number): string | undefined {
    const before = content.substring(0, pos);
    const match = before.match(/(?:const|var)\s+(\w+)\s*=\s*(?:packed\s+|extern\s+)?struct[^{]*\{[^}]*$/);
    return match ? match[1] : undefined;
  }
}

export const zigParser = new ZigParser();
