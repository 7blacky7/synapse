/**
 * MODUL: V Parser
 * ZWECK: Extrahiert Struktur-Informationen aus V-Dateien (.v, .vv)
 *
 * EXTRAHIERT: module, import, fn (pub), struct, enum, union, interface,
 *             const, type alias, [attribute], test, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

// ---------------------------------------------------------------------------
// Flow extraction (V lang)
// ---------------------------------------------------------------------------

function lineAtV(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function extractFlowV(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextId = (): string => `s${tempIdCounter++}`;

  function stripComments(src: string): string {
    return src.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  }

  function extractCalls(expr: string, stmtId: string, scopeName: string | null, lineNo: number): void {
    const methodRe = /(\w+)\.(\w+)\s*\(/g;
    let mc: RegExpExecArray | null;
    while ((mc = methodRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineNo, call_kind: 'method' });
    }
    const funcRe = /(?<![.\w])([a-zA-Z_]\w*)\s*\(/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1];
      if (['if','for','while','match','return','or','go','spawn','defer','sizeof','typeof'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: name, line_number: lineNo, call_kind: 'function' });
    }
  }

  interface FnBody { name: string; bodyOffset: number; bodyContent: string; }
  function findFnBodies(src: string): FnBody[] {
    const bodies: FnBody[] = [];
    const stripped = stripComments(src);
    // fn name(...) ... { or fn (r ReceiverType) name(...) ... {
    const fnRe = /^(?:pub\s+)?fn\s+(?:\(\w+\s+(?:&?(?:mut\s+)?)?\w+\)\s+)?(\w+)\s*(?:\[[^\]]*\])?\s*\([^)]*\)[^{]*\{/gm;
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

  function processBody(body: string, bodyOffset: number, scopeName: string): void {
    let order = 0;
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) { i++; continue; }
      const charOffset = lines.slice(0, i).reduce((a, l) => a + l.length + 1, 0);
      const fileLine = lineAtV(content, bodyOffset + charOffset);

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: 'function', scope_name: scopeName, statement_type: type, node_kind: kind, line_start: fileLine, order_index: order++, depth: 0, is_top_level: false, is_awaited: false, text: trimmed.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      if (/^\s*if\s+/.test(line)) {
        const cm = line.match(/if\s+(.+)/); const cond = cm ? cm[1].replace(/\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*for\s+/.test(line) || /^\s*for\s*\{/.test(line)) {
        const cm = line.match(/for\s+(.*)/); const cond = cm ? cm[1].replace(/\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('for', 'ForStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*match\s+/.test(line)) {
        const cm = line.match(/match\s+(.+)/); const cond = cm ? cm[1].replace(/\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('switch', 'MatchExpression', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*return\b/.test(line)) {
        const expr = trimmed.replace(/^return\s*/, '');
        const st = emit('return', 'ReturnStatement');
        if (expr) extractCalls(expr, st.temp_id, scopeName, fileLine);
      } else if (/^\s*defer\b/.test(line)) {
        const expr = trimmed.replace(/^defer\s*/, '');
        const st = emit('call', 'DeferStatement', { callee: 'defer' });
        extractCalls(expr, st.temp_id, scopeName, fileLine);
      } else if (/^\s*(?:mut\s+)?\w+\s*(?::=|=)\s*.+/.test(line) && !/^\s*(?:if|for|match|return|fn|pub|struct|enum)/.test(line)) {
        const am = trimmed.match(/^(?:mut\s+)?(\w+)\s*(?::=|=)\s*(.+)/);
        if (am) {
          const st = emit('assignment', 'AssignmentStatement', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, scopeName, fileLine);
        }
      } else if (/\w+\s*\(/.test(trimmed) && !/^\s*(?:if|for|match|return|fn|pub|struct|enum|defer)/.test(line)) {
        const cm2 = trimmed.match(/(?:(\w+)\.)?(\w+)\s*\(/);
        if (cm2) {
          const st = emit('call', 'CallExpression', { callee: cm2[2], receiver: cm2[1] || undefined });
          extractCalls(trimmed, st.temp_id, scopeName, fileLine);
        }
      }
      i++;
    }
  }

  const bodies = findFnBodies(content);
  for (const fb of bodies) {
    processBody(fb.bodyContent, fb.bodyOffset, fb.name);
  }

  return { statements, callEdges };
}

class VlangParser implements LanguageParser {
  language = 'vlang';
  extensions = ['.v', '.vv'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  version = 1;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+(\w+)/m;
    m = moduleRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'module',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Import
    // ══════════════════════════════════════════════
    const importRe = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
    while ((m = importRe.exec(content)) !== null) {
      const pkg = m[1];
      const alias = m[2];
      const name = alias || pkg.split('.').pop() || pkg;
      symbols.push({
        symbol_type: 'import',
        name,
        value: alias ? `${pkg} as ${alias}` : pkg,
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
    // 3. Struct
    // ══════════════════════════════════════════════
    const structRe = /^(pub\s+)?struct\s+(\w+)\s*\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      const isPub = !!m[1];
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Enum
    // ══════════════════════════════════════════════
    const enumRe = /^(pub\s+)?enum\s+(\w+)\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const isPub = !!m[1];
      const name = m[2];
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
    }

    // ══════════════════════════════════════════════
    // 5. Union
    // ══════════════════════════════════════════════
    const unionRe = /^(pub\s+)?union\s+(\w+)\s*\{/gm;
    while ((m = unionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: 'union',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !!m[1],
      });
    }

    // ══════════════════════════════════════════════
    // 6. Interface
    // ══════════════════════════════════════════════
    const ifaceRe = /^(pub\s+)?interface\s+(\w+)\s*\{/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[2],
        value: 'interface',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !!m[1],
      });
    }

    // ══════════════════════════════════════════════
    // 7. Functions (fn)
    // ══════════════════════════════════════════════
    const fnRe = /^(pub\s+)?fn\s+(?:\((\w+)\s+(?:&?(?:mut\s+)?)?(\w+)\)\s+)?(\w+)(?:\[([^\]]*)\])?\s*\(([^)]*)\)\s*(?:(\!\s*)?(\w[\w.]*)?)?/gm;
    while ((m = fnRe.exec(content)) !== null) {
      const isPub = !!m[1];
      const receiverName = m[2];
      const receiverType = m[3];
      const name = m[4];
      const typeParams = m[5];
      const paramsRaw = m[6];
      const returnType = m[8];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/)[0])
        .filter(p => p && p !== 'mut');

      const fullName = receiverType ? `${receiverType}.${name}` : name;

      symbols.push({
        symbol_type: 'function',
        name: fullName,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: isPub,
        parent_id: receiverType || undefined,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Constants
    // ══════════════════════════════════════════════
    const constBlockRe = /^(pub\s+)?const\s*\(/gm;
    while ((m = constBlockRe.exec(content)) !== null) {
      const isPub = !!m[1];
      const lineStart = lineAt(content, m.index);
      const block = content.substring(m.index + m[0].length);
      const endIdx = block.indexOf(')');
      const constBlock = endIdx > 0 ? block.substring(0, endIdx) : block;

      const valRe = /^\s*(\w+)\s*=\s*(.+)/gm;
      let vm: RegExpExecArray | null;
      while ((vm = valRe.exec(constBlock)) !== null) {
        symbols.push({
          symbol_type: 'variable',
          name: vm[1],
          value: vm[2].trim().slice(0, 200),
          line_start: lineAt(content, m.index + m[0].length + vm.index),
          is_exported: isPub,
        });
      }
    }

    // Single const
    const constSingleRe = /^(pub\s+)?const\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = constSingleRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: !!m[1],
      });
    }

    // ══════════════════════════════════════════════
    // 9. Type aliases
    // ══════════════════════════════════════════════
    const typeRe = /^(pub\s+)?type\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = typeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[2],
        value: `type = ${m[3].trim().slice(0, 200)}`,
        line_start: lineAt(content, m.index),
        is_exported: !!m[1],
      });
    }

    // ══════════════════════════════════════════════
    // 10. Test functions
    // ══════════════════════════════════════════════
    const testRe = /^fn\s+test_(\w+)\s*\(/gm;
    while ((m = testRe.exec(content)) !== null) {
      // Already captured by fn regex, skip
    }

    // ══════════════════════════════════════════════
    // 11. Attributes ([attribute])
    // ══════════════════════════════════════════════
    const attrRe = /^\[(\w+(?::\s*'[^']*')?)\]/gm;
    while ((m = attrRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1].split(':')[0],
        line_number: lineAt(content, m.index),
        context: `[${m[1]}]`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 12. TODO / FIXME / HACK
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

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 13. Embedded SQL (db.exec / sqlite / ORM)
    // ══════════════════════════════════════════════
    const sqlCallRe = /\b\w+\.(?:exec|exec_param|exec_one|q|query)\s*\(\s*['"]((?:[^"'\\]|\\.){10,})['"]/g;
    while ((m = sqlCallRe.exec(content)) !== null) {
      const sql = m[1];
      if (!looksLikeSql(sql)) continue;
      const line = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sql, filePath, line));
    }

    const sqlRawRe = /\br['"]((?:[^"'\\]|\\.){10,})['"]/g;
    while ((m = sqlRawRe.exec(content)) !== null) {
      const sql = m[1];
      if (!looksLikeSql(sql)) continue;
      const line = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sql, filePath, line));
    }

    const { statements, callEdges } = extractFlowV(content);
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
}

export const vlangParser = new VlangParser();
