/**
 * MODUL: D Parser
 * ZWECK: Extrahiert Struktur-Informationen aus D-Dateien (.d)
 *
 * EXTRAHIERT: module, import, class, struct, interface, enum, union,
 *             function, template, mixin, alias, unittest, version,
 *             @attribute, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { HTTP_VERBS, isLikelyHttpPath, formatRouteName } from './patterns/http.js';
import { looksLikeSql, parseEmbeddedSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

// ---------------------------------------------------------------------------
// Flow extraction (D)
// ---------------------------------------------------------------------------

function lineAtD(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function extractFlowD(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
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
    const methodRe = /(\w+)\.(\w+)\s*[(!]/g;
    let mc: RegExpExecArray | null;
    while ((mc = methodRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineNo, call_kind: 'method' });
    }
    const funcRe = /(?<![.\w])([a-zA-Z_]\w*)\s*[(!]/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1];
      if (['if','else','for','foreach','while','do','switch','case','return','throw','try','catch','finally','new','delete','scope','with','version','debug','static','import','module'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: name, line_number: lineNo, call_kind: 'function' });
    }
    const newRe = /\bnew\s+(\w+)/g;
    while ((mc = newRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[1], line_number: lineNo, call_kind: 'new' });
    }
  }

  interface FnBody { name: string; bodyOffset: number; bodyContent: string; }
  function findFnBodies(src: string): FnBody[] {
    const bodies: FnBody[] = [];
    const stripped = stripComments(src);
    const fnRe = /^(?:\s*)(?:(?:public|private|protected|package|static|pure|nothrow|@\w+|override|final|extern\([^)]*\))\s+)*(\w[\w.!]*)\s+(\w+)\s*\([^)]*\)[^{;]*\{/gm;
    let m: RegExpExecArray | null;
    while ((m = fnRe.exec(stripped)) !== null) {
      const returnType = m[1];
      const name = m[2];
      if (['if','for','foreach','while','switch','catch','do','else','return','try','version','static','debug','class','struct','interface','enum','union','import','module','with','scope'].includes(returnType)) continue;
      if (['if','for','foreach','while','switch','catch','do','else','return','try','version','static','debug'].includes(name)) continue;
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
      const fileLine = lineAtD(content, bodyOffset + charOffset);

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: 'function', scope_name: scopeName, statement_type: type, node_kind: kind, line_start: fileLine, order_index: sc.v++, depth: 0, is_top_level: false, is_awaited: false, text: trimmed.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      if (/^\s*if\s*\(/.test(line)) {
        const cm = line.match(/if\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*(?:for|foreach)\s*\(/.test(line)) {
        const cm = line.match(/(?:for|foreach)\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('for', 'ForStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*while\s*\(/.test(line)) {
        const cm = line.match(/while\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('while', 'WhileStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*do\s*\{/.test(line)) {
        emit('do', 'DoStatement');
      } else if (/^\s*switch\s*\(/.test(line)) {
        const cm = line.match(/switch\s*\((.+)/); const cond = cm ? cm[1].replace(/\)\s*\{?\s*$/, '').slice(0, 200) : undefined;
        const st = emit('switch', 'SwitchStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
      } else if (/^\s*try\s*\{/.test(line)) {
        emit('try', 'TryStatement');
      } else if (/^\s*throw\b/.test(line)) {
        const expr = trimmed.replace(/^throw\s*new\s+/, '').replace(/^throw\s*/, '').replace(/;$/, '');
        const st = emit('throw', 'ThrowStatement');
        extractCalls(expr, st.temp_id, scopeName, fileLine);
      } else if (/^\s*return\b/.test(line)) {
        const expr = trimmed.replace(/^return\s*/, '').replace(/;$/, '');
        const st = emit('return', 'ReturnStatement');
        if (expr) extractCalls(expr, st.temp_id, scopeName, fileLine);
      } else if (/^\s*\w[\w.*\[\]]*\s*(?:[+*/%&|^-]?=)\s*.+;/.test(line) && !/^\s*(?:if|for|foreach|while|switch|return|throw|try)/.test(line)) {
        const am = trimmed.match(/^(\w[\w.*\[\]]*)\s*(?:[+*/%&|^-]?=)\s*(.+);/);
        if (am) {
          const st = emit('assignment', 'AssignmentExpression', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, scopeName, fileLine);
        }
      } else if (/^\s*auto\s+\w+/.test(line) || /^\s*\w[\w.<>*\[\]]*\s+\w+\s*=/.test(line)) {
        const vm = trimmed.match(/(?:auto\s+)?(\w+)\s*=\s*(.+?);/);
        if (vm && !['if','for','while','switch','return'].includes(vm[1])) {
          const st = emit('variable', 'VariableDeclaration', { assigned_to: vm[1].slice(0, 120) });
          extractCalls(vm[2], st.temp_id, scopeName, fileLine);
        }
      } else if (/\w+\s*[(!]/.test(trimmed) && /[;{]$/.test(trimmed) && !/^\s*(?:if|for|foreach|while|switch|return|throw|try|catch|class|struct|interface)/.test(line)) {
        const cm2 = trimmed.match(/(?:(\w+)\.)?(\w+)\s*[(!]/);
        if (cm2) {
          const st = emit('call', 'CallExpression', { callee: cm2[2], receiver: cm2[1] || undefined });
          extractCalls(trimmed, st.temp_id, scopeName, fileLine);
        }
      }
      i++;
    }
  }

  const bodies = findFnBodies(content);
  for (const fb of bodies) processBody(fb.bodyContent, fb.bodyOffset, fb.name);

  return { statements, callEdges };
}

class DlangParser implements LanguageParser {
  language = 'dlang';
  extensions = ['.d'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+([\w.]+)\s*;/m;
    m = moduleRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'module',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Import
    // ══════════════════════════════════════════════
    const importRe = /^\s*(?:public\s+|static\s+)?import\s+([\w.]+)(?:\s*:\s*([\w,\s]+))?/gm;
    while ((m = importRe.exec(content)) !== null) {
      const pkg = m[1];
      const selective = m[2];
      const name = pkg.split('.').pop() || pkg;

      if (selective) {
        const items = selective.split(',').map(s => s.trim()).filter(Boolean);
        for (const item of items) {
          symbols.push({
            symbol_type: 'import',
            name: item,
            value: `${pkg} : ${item}`,
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }
      } else {
        symbols.push({
          symbol_type: 'import',
          name,
          value: pkg,
          line_start: lineAt(content, m.index),
          is_exported: m[0].includes('public'),
        });
      }

      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Classes / Interfaces
    // ══════════════════════════════════════════════
    const classRe = /^(\s*)((?:(?:public|private|protected|package|static|abstract|final|synchronized)\s+)*)(class|interface)\s+(\w+)(?:\s*:\s*([^\n{]+))?\s*\{/gm;
    while ((m = classRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const parents = m[5] ? m[5].split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: kind === 'interface' ? 'interface' : 'class',
        name,
        value: kind,
        params: parents,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !/\bprivate\b/.test(modifiers),
      });

      if (parents) {
        for (const p of parents) {
          references.push({
            symbol_name: p.split('!')[0],
            line_number: lineStart,
            context: `${kind} ${name} : ${parents.join(', ')}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Structs / Unions
    // ══════════════════════════════════════════════
    const structRe = /^(\s*)((?:(?:public|private|protected|package|static)\s+)*)(struct|union)\s+(\w+)\s*\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[4],
        value: m[3],
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !/\bprivate\b/.test(m[2]),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Enums
    // ══════════════════════════════════════════════
    const enumRe = /^(\s*)enum\s+(\w+)(?:\s*:\s*(\w+))?\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[2],
        value: m[3] ? `enum : ${m[3]}` : 'enum',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^(\s*)((?:(?:public|private|protected|package|static|pure|nothrow|@\w+|override|final|extern\([^)]*\))\s+)*)(\w[\w.!]*)\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:const|immutable|inout|shared|pure|nothrow|@\w+))*/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const returnType = m[3];
      const name = m[4];
      const paramsRaw = m[5];
      const lineStart = lineAt(content, m.index);

      if (['if', 'for', 'while', 'switch', 'foreach', 'version', 'static', 'debug',
           'class', 'struct', 'interface', 'enum', 'union', 'import', 'module'].includes(returnType)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
      });
    }

    // ══════════════════════════════════════════════
    // 7. Templates
    // ══════════════════════════════════════════════
    const templateRe = /^(\s*)template\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
    while ((m = templateRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[2],
        value: 'template',
        params: m[3].split(',').map(p => p.trim()).filter(Boolean),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Alias
    // ══════════════════════════════════════════════
    const aliasRe = /^\s*alias\s+(\w+)\s*=\s*(.+)\s*;/gm;
    while ((m = aliasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: `alias = ${m[2].trim().slice(0, 200)}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Unittest
    // ══════════════════════════════════════════════
    const unittestRe = /^\s*unittest\s*\{/gm;
    while ((m = unittestRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: 'unittest',
        value: 'unittest',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Version blocks
    // ══════════════════════════════════════════════
    const versionRe = /^\s*version\s*\((\w+)\)\s*\{/gm;
    while ((m = versionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `version(${m[1]})`,
        value: 'version',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
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
    // 12. Ddoc comments (/** ... */ or ///)
    // ══════════════════════════════════════════════
    const ddocRe = /\/\*\*([\s\S]*?)\*\//g;
    while ((m = ddocRe.exec(content)) !== null) {
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

    // ══════════════════════════════════════════════
    // 13. Routes (vibe.d): router.get("/x", &handler), router.match(...)
    // ══════════════════════════════════════════════
    const routeRe = /\b\w+\.(get|post|put|patch|delete|head|options|any|match)\s*\(\s*"([^"]+)"/g;
    while ((m = routeRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      const path = m[2];
      const method = verb === 'match' || verb === 'any' ? 'ANY' : verb.toUpperCase();
      if (!HTTP_VERBS.has(method.toLowerCase()) && method !== 'ANY') continue;
      if (!isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 14. Embedded SQL (ddbc)
    // ══════════════════════════════════════════════
    const sqlCallRe = /\b\w+\.(?:executeQuery|executeUpdate|prepareStatement|execute)\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = sqlCallRe.exec(content)) !== null) {
      const sqlContent = m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      if (!looksLikeSql(sqlContent)) continue;
      symbols.push(...parseEmbeddedSql(sqlContent, filePath, lineAt(content, m.index)));
    }

    // Raw / wysiwyg / token / hex strings: r"..." | `...` | q{...} | x"..."
    const sqlRawRe = /\b\w+\.(?:executeQuery|executeUpdate|prepareStatement|execute)\s*\(\s*(?:r"([^"]{10,})"|`([^`]{10,})`|q\{([^}]{10,})\}|x"([^"]{10,})")/g;
    while ((m = sqlRawRe.exec(content)) !== null) {
      const sqlContent = m[1] || m[2] || m[3] || m[4] || '';
      if (!looksLikeSql(sqlContent)) continue;
      symbols.push(...parseEmbeddedSql(sqlContent, filePath, lineAt(content, m.index)));
    }

    symbols.push(...extractStringLiterals(content));

    const { statements, callEdges } = extractFlowD(content);
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

export const dlangParser = new DlangParser();
