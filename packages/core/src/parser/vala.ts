/**
 * MODUL: Vala Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Vala-Dateien (.vala, .vapi)
 *
 * EXTRAHIERT: using, namespace, class, interface, struct, enum, delegate,
 *             signal, property, method, const, TODO
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ValaParser implements LanguageParser {
  language = 'vala';
  extensions = ['.vala', '.vapi'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // 1. Using
    const usingRe = /^using\s+([\w.]+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: m[1], line_start: lineAt(content, m.index), is_exported: false });
    }

    // 2. Namespace
    const nsRe = /^(?:public\s+)?namespace\s+([\w.]+)/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'namespace', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 3. Class
    const classRe = /^(?:(?:public|private|internal|abstract|sealed)\s+)*class\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\s{]+))?/gm;
    while ((m = classRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: m[2] ? `extends ${m[2]}` : 'class', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 4. Interface
    const ifaceRe = /^(?:(?:public|private|internal)\s+)*interface\s+(\w+)(?:<[^>]+>)?/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'interface', name: m[1], value: 'interface', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 5. Struct
    const structRe = /^(?:(?:public|private|internal)\s+)*struct\s+(\w+)/gm;
    while ((m = structRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'struct', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 6. Enum
    const enumRe = /^(?:(?:public|private|internal)\s+)*enum\s+(\w+)/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'enum', name: m[1], value: 'enum', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 7. Delegate
    const delegateRe = /^(?:(?:public|private|internal)\s+)*delegate\s+\S+\s+(\w+)\s*\(/gm;
    while ((m = delegateRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'delegate', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 8. Signal
    const signalRe = /^[ \t]*(?:public\s+)?signal\s+\S+\s+(\w+)\s*\(/gm;
    while ((m = signalRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'signal', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 9. Property
    const propRe = /^[ \t]*(?:(?:public|private|internal|protected)\s+)*(?:(?:virtual|override|abstract|static)\s+)*\S+\s+(\w+)\s*\{[^}]*(?:get|set)/gm;
    while ((m = propRe.exec(content)) !== null) {
      if (['if', 'else', 'for', 'while', 'switch', 'return', 'new', 'class', 'namespace'].includes(m[1])) continue;
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'property', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 10. Methods
    const methodRe = /^[ \t]*(?:(?:public|private|internal|protected)\s+)*(?:(?:virtual|override|abstract|static|async)\s+)*(\S+)\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      if (['if', 'else', 'for', 'while', 'switch', 'return', 'new', 'class', 'namespace', 'using', 'enum', 'struct', 'interface', 'delegate', 'signal'].includes(m[2])) continue;
      if (symbols.some(s => s.name === m![2] && s.line_start === lineAt(content, m!.index))) continue;
      const params = m[3].split(',').map(p => p.trim().split(/\s+/).pop()!).filter(Boolean);
      symbols.push({ symbol_type: 'function', name: m[2], params: params.length > 0 ? params : undefined, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 11. Constants
    const constRe = /^[ \t]*(?:(?:public|private|internal)\s+)*const\s+\S+\s+(\w+)\s*=/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'const', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 12. TODO / FIXME
    const todoRe = /\/\/\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'todo', name: null, value: m[0].trim(), line_start: lineAt(content, m.index), is_exported: false });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // 13. Embedded SQL (Sqlite Vala)
    const sqlExecRe = /\b\w+\.(?:exec|prepare_v2|prepare)\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = sqlExecRe.exec(content)) !== null) {
      const sql = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
      symbols.push(...parseEmbeddedSql(sql, filePath, lineAt(content, m.index)));
    }
    const sqlTripleRe = /"""([\s\S]{10,}?)"""/g;
    while ((m = sqlTripleRe.exec(content)) !== null) {
      if (!looksLikeSql(m[1])) continue;
      symbols.push(...parseEmbeddedSql(m[1], filePath, lineAt(content, m.index)));
    }

    const { statements, callEdges } = extractValaFlow(content);
    return { symbols, references, statements, callEdges };
  }
}

// ---------------------------------------------------------------------------
// Execution-Flow Extraktion fuer Vala
// ---------------------------------------------------------------------------
function extractValaFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = (): string => `s${tempId++}`;
  const orderCounters = new Map<string, number>();

  function nextOrder(parentId: string | undefined, sc: { n: number }): number {
    if (parentId === undefined) return sc.n++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  function charToLine(pos: number): number {
    return content.substring(0, pos).split('\n').length;
  }

  function findClose(src: string, openIdx: number): number {
    let depth = 1;
    for (let i = openIdx + 1; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return src.length - 1;
  }

  function emitStmt(
    lineStart: number, scopeType: string, scopeName: string | null,
    stmtType: string, depth: number, parentId: string | undefined,
    sc: { n: number }, extra: Partial<ParsedStatement> = {},
  ): ParsedStatement {
    const id = nextId();
    const st: ParsedStatement = {
      temp_id: id, parent_temp_id: parentId,
      scope_type: scopeType, scope_name: scopeName,
      statement_type: stmtType,
      line_start: lineStart, order_index: nextOrder(parentId, sc),
      depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
      ...extra,
    };
    statements.push(st);
    return st;
  }

  function parseBody(body: string, baseOff: number, scopeType: string, scopeName: string | null, depth: number, parentId: string | undefined, sc: { n: number }): void {
    let pos = 0;
    while (pos < body.length) {
      // skip strings/comments
      if ((body[pos] === '"' || body[pos] === "'") && body[pos-1] !== '\\') {
        const q = body[pos]; pos++;
        while (pos < body.length && body[pos] !== q) { if (body[pos] === '\\') pos++; pos++; }
        pos++; continue;
      }
      if (body[pos] === '/' && body[pos+1] === '/') { while (pos < body.length && body[pos] !== '\n') pos++; continue; }
      if (body[pos] === '/' && body[pos+1] === '*') { pos += 2; while (pos < body.length - 1 && !(body[pos] === '*' && body[pos+1] === '/')) pos++; pos += 2; continue; }

      const slice = body.slice(pos);
      const line = charToLine(baseOff + pos);

      // if
      const ifM = /^if\s*\(/.exec(slice);
      if (ifM) {
        let ce = pos + ifM[0].length - 1; let pd = 1;
        while (ce < body.length && pd > 0) { ce++; if (body[ce]==='(') pd++; else if (body[ce]===')') pd--; }
        const cond = body.substring(pos + 3, ce).trim().slice(0, 200);
        let bs = ce + 1; while (bs < body.length && /\s/.test(body[bs])) bs++;
        if (body[bs] === '{') {
          const bc = findClose(body, bs);
          const st = emitStmt(line, scopeType, scopeName, 'if', depth, parentId, sc, { condition_text: cond });
          parseBody(body.substring(bs+1, bc), baseOff + bs + 1, scopeType, scopeName, depth+1, st.temp_id, { n: 0 });
          pos = bc + 1;
          const elseM = /^\s*else\s*\{/.exec(body.slice(pos));
          if (elseM) { const es = pos + elseM[0].lastIndexOf('{'); const ec = findClose(body, es); parseBody(body.substring(es+1, ec), baseOff+es+1, scopeType, scopeName, depth+1, st.temp_id, { n: orderCounters.get(`p:${st.temp_id}`) ?? 0 }); pos = ec+1; }
        } else { emitStmt(line, scopeType, scopeName, 'if', depth, parentId, sc, { condition_text: cond }); pos = ce+1; }
        continue;
      }

      // for/foreach
      const forM = /^(?:for(?:each)?)\s*\(/.exec(slice);
      if (forM) {
        let ce = pos + forM[0].length - 1; let pd = 1;
        while (ce < body.length && pd > 0) { ce++; if (body[ce]==='(') pd++; else if (body[ce]===')') pd--; }
        const cond = body.substring(pos + forM[0].length, ce).trim().slice(0, 200);
        let bs = ce + 1; while (bs < body.length && /\s/.test(body[bs])) bs++;
        if (body[bs] === '{') {
          const bc = findClose(body, bs);
          const st = emitStmt(line, scopeType, scopeName, 'for', depth, parentId, sc, { condition_text: cond });
          parseBody(body.substring(bs+1, bc), baseOff+bs+1, scopeType, scopeName, depth+1, st.temp_id, { n: 0 });
          pos = bc + 1;
        } else { emitStmt(line, scopeType, scopeName, 'for', depth, parentId, sc, { condition_text: cond }); pos = ce+1; }
        continue;
      }

      // while
      const whileM = /^while\s*\(/.exec(slice);
      if (whileM) {
        let ce = pos + whileM[0].length - 1; let pd = 1;
        while (ce < body.length && pd > 0) { ce++; if (body[ce]==='(') pd++; else if (body[ce]===')') pd--; }
        const cond = body.substring(pos + 6, ce).trim().slice(0, 200);
        let bs = ce + 1; while (bs < body.length && /\s/.test(body[bs])) bs++;
        if (body[bs] === '{') {
          const bc = findClose(body, bs);
          const st = emitStmt(line, scopeType, scopeName, 'while', depth, parentId, sc, { condition_text: cond });
          parseBody(body.substring(bs+1, bc), baseOff+bs+1, scopeType, scopeName, depth+1, st.temp_id, { n: 0 });
          pos = bc + 1;
        } else { emitStmt(line, scopeType, scopeName, 'while', depth, parentId, sc, { condition_text: cond }); pos = ce+1; }
        continue;
      }

      // try
      const tryM = /^try\s*\{/.exec(slice);
      if (tryM) {
        const bs = pos + tryM[0].length - 1;
        const bc = findClose(body, bs);
        const st = emitStmt(line, scopeType, scopeName, 'try', depth, parentId, sc);
        parseBody(body.substring(bs+1, bc), baseOff+bs+1, scopeType, scopeName, depth+1, st.temp_id, { n: 0 });
        pos = bc + 1;
        const catchM = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(body.slice(pos));
        if (catchM) { const cs = pos + catchM[0].lastIndexOf('{'); const cc = findClose(body, cs); parseBody(body.substring(cs+1, cc), baseOff+cs+1, scopeType, scopeName, depth+1, st.temp_id, { n: orderCounters.get(`p:${st.temp_id}`) ?? 0 }); pos = cc+1; }
        continue;
      }

      // return
      if (/^return\b/.test(slice)) {
        emitStmt(line, scopeType, scopeName, 'return', depth, parentId, sc);
        const semi = body.indexOf(';', pos); pos = semi >= 0 ? semi+1 : pos+6;
        continue;
      }

      // throw/yield
      if (/^(?:throw|yield)\b/.test(slice)) {
        const kw = slice.startsWith('throw') ? 'throw' : 'return';
        emitStmt(line, scopeType, scopeName, kw, depth, parentId, sc);
        const semi = body.indexOf(';', pos); pos = semi >= 0 ? semi+1 : pos+5;
        continue;
      }

      // generic call: ident( or obj.method(
      const callM = /^([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\(/.exec(slice);
      if (callM && !['if','for','foreach','while','try','return','throw','yield','var','new','else','catch','finally','switch','case','break','continue'].includes(callM[1].split('.')[0])) {
        let ae = pos + callM[0].length - 1; let pd = 1;
        while (ae < body.length && pd > 0) { ae++; if (body[ae]==='(') pd++; else if (body[ae]===')') pd--; }
        const semi = body.indexOf(';', ae);
        if (semi >= 0 && semi - ae <= 4) {
          const parts = callM[1].split('.');
          const callee = parts[parts.length-1];
          const receiver = parts.length > 1 ? parts.slice(0,-1).join('.') : undefined;
          const st = emitStmt(line, scopeType, scopeName, 'call', depth, parentId, sc, { callee, receiver });
          callEdges.push({ statement_temp_id: st.temp_id, caller_scope: scopeName, callee_name: callee, callee_receiver: receiver, line_number: line, call_kind: receiver ? 'method' : 'function' });
          pos = semi + 1; continue;
        }
      }

      // assignment: var x = ... ; or x = ...;
      const varM = /^(?:var\s+)?([a-zA-Z_]\w*)\s*(?:[+\-*\/]?=)\s*/.exec(slice);
      if (varM && !['if','for','foreach','while','try','return','throw','yield','var','new'].includes(varM[1])) {
        const semi = body.indexOf(';', pos);
        if (semi >= 0) {
          const rhs = body.substring(pos + varM[0].length, semi).trim();
          const isNew = rhs.startsWith('new ');
          emitStmt(line, scopeType, scopeName, isNew ? 'new' : 'assignment', depth, parentId, sc, { assigned_to: varM[1] });
          pos = semi + 1; continue;
        }
      }

      if (body[pos] === '{') { pos = findClose(body, pos) + 1; continue; }
      if (body[pos] === ';') { pos++; continue; }
      pos++;
    }
  }

  // Find all method bodies
  const methodRe = /\b(\w+)\s*\(([^)]*)\)\s*(?:throws\s+\w+\s*)?\{/g;
  const skipKeywords = new Set(['if','for','foreach','while','try','catch','finally','else','switch','lock','do','using','namespace','class','struct','enum','interface','delegate']);
  let mm: RegExpExecArray | null;
  while ((mm = methodRe.exec(content)) !== null) {
    const name = mm[1];
    if (skipKeywords.has(name)) continue;
    // verify it's a method def: preceded by return type
    const before = content.substring(Math.max(0, mm.index - 100), mm.index).trim();
    if (!/\b\w+\s*$/.test(before)) continue;
    const openBrace = content.indexOf('{', mm.index + mm[0].length - 1);
    if (openBrace < 0) continue;
    const closeBrace = findClose(content, openBrace);
    const body = content.substring(openBrace + 1, closeBrace);
    parseBody(body, openBrace + 1, 'function', name, 0, undefined, { n: 0 });
  }

  return { statements, callEdges };
}

export const valaParser = new ValaParser();
