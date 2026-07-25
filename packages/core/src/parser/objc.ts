/**
 * MODUL: Objective-C Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Objective-C-Dateien (.m, .mm)
 *
 * EXTRAHIERT: #import/#include, @interface, @implementation, @protocol,
 *             @property, method declarations (-/+), @synthesize, @dynamic,
 *             typedef, enum (NS_ENUM/NS_OPTIONS), struct, #define,
 *             @class forward declarations, comment, todo
 * ANSATZ: Regex-basiert
 *
 * HINWEIS: .h Header-Dateien werden vom C-Parser behandelt,
 *          .m/.mm Dateien von diesem Parser.
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

// ---------------------------------------------------------------------------
// Flow extraction (Objective-C)
// ---------------------------------------------------------------------------

function lineAtObjc(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function extractFlowObjc(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
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
    return src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  }

  function extractCalls(expr: string, stmtId: string, scopeName: string | null, lineNo: number): void {
    // ObjC message sends: [receiver method:args]
    const msgRe = /\[\s*(\w+)\s+(\w+)/g;
    let mc: RegExpExecArray | null;
    while ((mc = msgRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineNo, call_kind: 'method' });
    }
    // C-style calls
    const funcRe = /(?<![.\->])\b([a-zA-Z_]\w*)\s*\(/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1];
      if (['if','for','while','switch','do','return','sizeof','typeof'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: name, line_number: lineNo, call_kind: 'function' });
    }
  }

  // Find ObjC method bodies: - (type)name { ... } or + (type)name { ... }
  interface MethodBody { name: string; bodyOffset: number; bodyContent: string; }
  function findMethodBodies(src: string): MethodBody[] {
    const bodies: MethodBody[] = [];
    const stripped = stripComments(src);
    const methRe = /^[+-]\s*\([^)]+\)\s*(\w+)[^{]*\{/gm;
    let m: RegExpExecArray | null;
    while ((m = methRe.exec(stripped)) !== null) {
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

  function processBody(body: string, bodyOffset: number, scopeName: string): void {
    const sc = { v: 0 };
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || /^\/[/*]/.test(trimmed) || /^\*/.test(trimmed)) { i++; continue; }
      const charOffset = lines.slice(0, i).reduce((a, l) => a + l.length + 1, 0);
      const fileLine = lineAtObjc(content, bodyOffset + charOffset);

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: 'method', scope_name: scopeName, statement_type: type, node_kind: kind, line_start: fileLine, order_index: sc.v++, depth: 0, is_top_level: false, is_awaited: false, text: trimmed.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      if (/^\s*if\s*\(/.test(line)) {
        const cm = line.match(/if\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*for\s*\(/.test(line)) {
        const cm = line.match(/for\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('for', 'ForStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*while\s*\(/.test(line)) {
        const cm = line.match(/while\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('while', 'WhileStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*switch\s*\(/.test(line)) {
        const cm = line.match(/switch\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('switch', 'SwitchStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*return\b/.test(line)) {
        const expr = trimmed.replace(/^return\s*/, '').replace(/;$/, '');
        const st = emit('return', 'ReturnStatement');
        if (expr) extractCalls(expr, st.temp_id, scopeName, fileLine);
      } else if (/^\[/.test(trimmed) || /\[\s*\w+\s+\w+/.test(trimmed)) {
        // ObjC message send statement
        const msgM = trimmed.match(/\[\s*(\w+)\s+(\w+)/);
        const st = emit('call', 'ObjCMessageExpression', { callee: msgM ? msgM[2] : undefined, receiver: msgM ? msgM[1] : undefined });
        extractCalls(trimmed, st.temp_id, scopeName, fileLine);
      } else if (/^\s*\w[\w.*\[\]>-]*\s*(?:[+*/%&|^-]?=)\s*.+;/.test(line)) {
        const am = trimmed.match(/^(\w[\w.*\[\]>-]*)\s*(?:[+*/%&|^-]?=)\s*(.+);/);
        if (am) {
          const st = emit('assignment', 'AssignmentExpression', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, scopeName, fileLine);
        }
      }
      i++;
    }
  }

  const bodies = findMethodBodies(content);
  for (const mb of bodies) {
    processBody(mb.bodyContent, mb.bodyOffset, mb.name);
  }

  return { statements, callEdges };
}

class ObjcParser implements LanguageParser {
  language = 'objc';
  extensions = ['.m', '.mm'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  version = 1;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. #import / #include
    // ══════════════════════════════════════════════
    const importRe = /^#(import|include)\s+[<"]([^>"]+)[>"]/gm;
    while ((m = importRe.exec(content)) !== null) {
      const path = m[2];
      const name = path.split('/').pop()?.replace(/\.h$/, '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: path,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: `#${m[1]} ${path}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. @class (forward declarations)
    // ══════════════════════════════════════════════
    const classForwardRe = /^@class\s+([\w,\s]+)\s*;/gm;
    while ((m = classForwardRe.exec(content)) !== null) {
      const classes = m[1].split(',').map(c => c.trim()).filter(Boolean);
      for (const cls of classes) {
        references.push({
          symbol_name: cls,
          line_number: lineAt(content, m.index),
          context: `@class ${cls}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. @interface
    // ══════════════════════════════════════════════
    const ifaceRe = /^@interface\s+(\w+)\s*(?::\s*(\w+))?\s*(?:<([^>]+)>)?/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      const name = m[1];
      const superClass = m[2];
      const protocols = m[3] ? m[3].split(',').map(p => p.trim()).filter(Boolean) : [];
      const lineStart = lineAt(content, m.index);

      const params: string[] = [];
      if (superClass) params.push(superClass);
      if (protocols.length > 0) params.push(...protocols.map(p => `<${p}>`));

      symbols.push({
        symbol_type: 'class',
        name,
        value: '@interface',
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: true,
      });

      if (superClass) {
        references.push({
          symbol_name: superClass,
          line_number: lineStart,
          context: `@interface ${name} : ${superClass}`.slice(0, 80),
        });
      }
      for (const proto of protocols) {
        references.push({
          symbol_name: proto,
          line_number: lineStart,
          context: `@interface ${name} <${protocols.join(', ')}>`.slice(0, 80),
        });
      }
    }

    // Category
    const catRe = /^@interface\s+(\w+)\s*\(\s*(\w*)\s*\)/gm;
    while ((m = catRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2] ? `${m[1]}(${m[2]})` : `${m[1]}()`,
        value: m[2] ? 'category' : 'extension',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. @implementation
    // ══════════════════════════════════════════════
    const implRe = /^@implementation\s+(\w+)/gm;
    while ((m = implRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: '@implementation',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. @protocol
    // ══════════════════════════════════════════════
    const protoRe = /^@protocol\s+(\w+)\s*(?:<([^>]+)>)?/gm;
    while ((m = protoRe.exec(content)) !== null) {
      if (m[0].trim().endsWith(';')) continue; // Forward declaration
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: '@protocol',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. @property
    // ══════════════════════════════════════════════
    const propRe = /^@property\s*\(([^)]*)\)\s*(\w[\w\s*<>]*?)\s*\*?\s*(\w+)\s*;/gm;
    while ((m = propRe.exec(content)) !== null) {
      const attrs = m[1];
      const propType = m[2].trim();
      const name = m[3];

      symbols.push({
        symbol_type: 'variable',
        name,
        value: propType,
        return_type: propType,
        line_start: lineAt(content, m.index),
        is_exported: !/\breadonly\b/.test(attrs) || true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Method declarations (-/+)
    // ══════════════════════════════════════════════
    const methodRe = /^([+-])\s*\(([^)]+)\)\s*(\w+)(?::(\s*\([^)]+\)\s*\w+\s*(?:\w+:\s*\([^)]+\)\s*\w+\s*)*))?/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const isClassMethod = m[1] === '+';
      const returnType = m[2].trim();
      const name = m[3];
      const paramsRaw = m[4] || '';
      const lineStart = lineAt(content, m.index);

      // Build selector name from params
      const paramParts = paramsRaw.match(/\w+:/g);
      const selector = paramParts ? `${name}:${paramParts.join('')}` : name;

      symbols.push({
        symbol_type: 'function',
        name: selector.replace(/:$/, ''),
        value: isClassMethod ? 'class method' : 'instance method',
        return_type: returnType,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. NS_ENUM / NS_OPTIONS
    // ══════════════════════════════════════════════
    const nsEnumRe = /typedef\s+NS_(?:ENUM|OPTIONS)\s*\(\s*\w+\s*,\s*(\w+)\s*\)\s*\{/gm;
    while ((m = nsEnumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[1],
        value: 'NS_ENUM',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. #define macros
    // ══════════════════════════════════════════════
    const defineRe = /^#define\s+(\w+)(?:\(([^)]*)\))?\s+(.+)/gm;
    while ((m = defineRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2] ? m[2].split(',').map(p => p.trim()).filter(Boolean) : undefined;
      const value = m[3].trim().replace(/\\$/, '').slice(0, 200);

      symbols.push({
        symbol_type: params ? 'function' : 'variable',
        name,
        value: params ? 'macro' : value,
        params,
        line_start: lineAt(content, m.index),
        is_exported: true,
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
    // 11. Doc comments (/** ... */)
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
    // 12. Embedded SQL (FMDB + sqlite3 C API)
    // ══════════════════════════════════════════════
    const sqlPatterns: RegExp[] = [
      /\[\s*\w+\s+(?:executeQuery|executeUpdate|executeStatements):\s*@"((?:[^"\\]|\\.){10,})"/g,
      /\bsqlite3_exec\s*\(\s*\w+\s*,\s*"((?:[^"\\]|\\.){10,})"/g,
      /\bsqlite3_prepare(?:_v2|_v3)?\s*\(\s*\w+\s*,\s*"((?:[^"\\]|\\.){10,})"/g,
    ];
    for (const re of sqlPatterns) {
      while ((m = re.exec(content)) !== null) {
        const raw = m[1];
        if (!looksLikeSql(raw)) continue;
        const lineStart = lineAt(content, m.index);
        symbols.push(...parseEmbeddedSql(raw, filePath, lineStart));
      }
    }

    const { statements, callEdges } = extractFlowObjc(content);
    return { symbols, references, statements, callEdges };
  }
}

export const objcParser = new ObjcParser();
