/**
 * MODUL: R Parser
 * ZWECK: Extrahiert Struktur-Informationen aus R-Dateien (.r, .R, .Rmd)
 *
 * EXTRAHIERT: function (mit <-/= Assignment), library/require, source,
 *             S4 class (setClass/setGeneric/setMethod), R6 class,
 *             Variablen-Assignments (<-/<<-/=), roxygen2 Kommentare,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { HTTP_VERBS, formatRouteName } from './patterns/http.js';
import { looksLikeSql, parseEmbeddedSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class RParser implements LanguageParser {
  language = 'r';
  extensions = ['.r', '.R', '.Rmd'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Library / Require
    // ══════════════════════════════════════════════
    const libRe = /^(?:\s*)(library|require)\s*\(\s*(?:"|')?(\w+)(?:"|')?\s*\)/gm;
    while ((m = libRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[2],
        value: `${m[1]}(${m[2]})`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[2],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Source
    // ══════════════════════════════════════════════
    const sourceRe = /^\s*source\s*\(\s*["']([^"']+)["']\s*\)/gm;
    while ((m = sourceRe.exec(content)) !== null) {
      const file = m[1];
      const name = file.split('/').pop()?.replace(/\.[rR]$/, '') || file;
      symbols.push({
        symbol_type: 'import',
        name,
        value: `source("${file}")`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Function definitions (name <- function(...))
    // ══════════════════════════════════════════════
    const funcRe = /^(\s*)([\w.]+)\s*(<-|=)\s*function\s*\(([^)]*)\)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const name = m[2];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split('=')[0].trim())
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: indent === 0,
      });
    }

    // ══════════════════════════════════════════════
    // 4. S4 Classes (setClass)
    // ══════════════════════════════════════════════
    const setClassRe = /setClass\s*\(\s*["'](\w+)["']/g;
    while ((m = setClassRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);

      // Extract contains (parent class)
      const after = content.substring(m.index, m.index + 500);
      const containsMatch = after.match(/contains\s*=\s*["'](\w+)["']/);
      const parents = containsMatch ? [containsMatch[1]] : undefined;

      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'S4',
        params: parents,
        line_start: lineStart,
        is_exported: true,
      });

      if (containsMatch) {
        references.push({
          symbol_name: containsMatch[1],
          line_number: lineStart,
          context: `setClass("${m[1]}", contains = "${containsMatch[1]}")`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. S4 Generics (setGeneric)
    // ══════════════════════════════════════════════
    const setGenericRe = /setGeneric\s*\(\s*["'](\w+)["']/g;
    while ((m = setGenericRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'S4 generic',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. S4 Methods (setMethod)
    // ══════════════════════════════════════════════
    const setMethodRe = /setMethod\s*\(\s*["'](\w+)["']\s*,\s*(?:signature\s*=\s*)?["'](\w+)["']/g;
    while ((m = setMethodRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'function',
        name: `${m[1]}.${m[2]}`,
        value: 'S4 method',
        line_start: lineStart,
        is_exported: true,
      });
      references.push({
        symbol_name: m[2],
        line_number: lineStart,
        context: `setMethod("${m[1]}", "${m[2]}")`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 7. R6 Classes
    // ══════════════════════════════════════════════
    const r6Re = /^(\s*)([\w.]+)\s*(<-|=)\s*R6Class\s*\(\s*["'](\w+)["']/gm;
    while ((m = r6Re.exec(content)) !== null) {
      const name = m[4] || m[2];
      const lineStart = lineAt(content, m.index);

      // Try to find inherit
      const after = content.substring(m.index, m.index + 500);
      const inheritMatch = after.match(/inherit\s*=\s*(\w+)/);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'R6',
        params: inheritMatch ? [`inherits ${inheritMatch[1]}`] : undefined,
        line_start: lineStart,
        is_exported: true,
      });

      if (inheritMatch) {
        references.push({
          symbol_name: inheritMatch[1],
          line_number: lineStart,
          context: `R6Class("${name}", inherit = ${inheritMatch[1]})`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 8. Top-level variable assignments (not functions)
    // ══════════════════════════════════════════════
    const assignRe = /^([\w.]+)\s*(<-|<<-|=)\s*(.+)/gm;
    while ((m = assignRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[3].trim().slice(0, 200);
      const lineStart = lineAt(content, m.index);

      // Skip if already captured as function, setClass, R6Class, etc.
      if (/^(function\s*\(|setClass|R6Class|setGeneric|setMethod)/.test(value)) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        line_start: lineStart,
        is_exported: m[2] === '<<-',
      });
    }

    // ══════════════════════════════════════════════
    // 9. Roxygen2 comments (#' @export, #' @param, etc.)
    // ══════════════════════════════════════════════
    const roxyRe = /#'\s*@(export|param|return|examples|description|title|rdname|importFrom)\s*(.*)/gi;
    while ((m = roxyRe.exec(content)) !== null) {
      const tag = m[1].toLowerCase();
      if (tag === 'importfrom') {
        const parts = m[2].trim().split(/\s+/);
        if (parts.length >= 1) {
          references.push({
            symbol_name: parts[0],
            line_number: lineAt(content, m.index),
            context: `@importFrom ${m[2].trim()}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      // Skip roxygen2 lines
      if (m[0].startsWith("#'")) continue;
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Multi-line comments (roxygen2 blocks as doc)
    // ══════════════════════════════════════════════
    const docBlockRe = /((?:#'[^\n]*\n)+)/g;
    while ((m = docBlockRe.exec(content)) !== null) {
      const text = m[1].replace(/#'\s?/g, '').trim();
      if (text.length < 10) continue;
      // Only keep if it contains @title or @description or starts without @
      if (text.startsWith('@') && !text.startsWith('@title') && !text.startsWith('@description')) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 12. Plumber Routes (#* @get /path)
    // ══════════════════════════════════════════════
    const plumberRe = /^#\*\s+@(get|post|put|patch|delete|head|options)\s+(\S+)/gmi;
    while ((m = plumberRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      if (!HTTP_VERBS.has(verb)) continue;
      let path = m[2];
      if (!path.startsWith('/')) path = '/' + path;
      const lineStart = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, path),
        value: path,
        params: [verb.toUpperCase()],
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 13. Embedded SQL via DBI (dbGetQuery, dbExecute, etc.)
    // ══════════════════════════════════════════════
    const dbiRe = /\b(?:DBI::)?(?:dbGetQuery|dbExecute|dbSendQuery|dbSendStatement|sqlInterpolate)\s*\(\s*\w+\s*,\s*['"]((?:[^"'\\]|\\.){10,})['"]/g;
    while ((m = dbiRe.exec(content)) !== null) {
      const sqlContent = m[1];
      if (!looksLikeSql(sqlContent)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlContent, filePath, baseLine));
    }

    // ══════════════════════════════════════════════
    // FLOW: Statements + CallEdges
    // ══════════════════════════════════════════════
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let tid = 0;
    const nid = (): string => `s${tid++}`;
    const oc = new Map<string, number>();
    const nord = (p: string | undefined): number => { const k = p ?? 'root'; const v = oc.get(k) ?? 0; oc.set(k, v + 1); return v; };
    interface RS { type: string; name: string | null; }
    const ss: RS[] = [{ type: 'module', name: null }];
    const cs = (): RS => ss[ss.length - 1];

    function es(st: string, line: number, pid: string | undefined, depth: number, extra: Partial<ParsedStatement> = {}): ParsedStatement {
      const sc = cs(); const id = nid();
      const s: ParsedStatement = { temp_id: id, parent_temp_id: pid, scope_type: sc.type, scope_name: sc.name, statement_type: st, line_start: line, order_index: nord(pid), depth, is_top_level: sc.type === 'module' && depth === 0, is_awaited: false, ...extra };
      statements.push(s); return s;
    }
    function ec(sid: string, callee: string, recv: string | undefined, line: number, kind: string): void {
      callEdges.push({ statement_temp_id: sid, caller_scope: cs().name, callee_name: callee, callee_receiver: recv, line_number: line, call_kind: kind });
    }

    const rLines = content.split('\n');
    interface RF { pid: string | undefined; depth: number; braceDepthAtOpen: number; }
    const fs: RF[] = [{ pid: undefined, depth: 0, braceDepthAtOpen: 0 }];
    const tf = (): RF => fs[fs.length - 1];
    interface FnEnt { name: string; braceDepth: number; }
    const fnStack: FnEnt[] = [];
    let braceDepth = 0;

    for (let i = 0; i < rLines.length; i++) {
      const raw = rLines[i];
      const tr = raw.replace(/#.*$/, '').trim();
      const ln = i + 1;
      if (!tr) continue;

      const openB = (tr.match(/\{/g) || []).length;
      const closeB = (tr.match(/\}/g) || []).length;
      const f = tf();
      const d = f.depth;

      // function assignment: name <- function(...)  or  name = function(...)
      const fnM = /^(\w+)\s*(?:<-|=)\s*function\s*\(/.exec(tr);
      if (fnM) {
        const name = fnM[1];
        const st = es('variable', ln, f.pid, d, { assigned_to: name, text: tr.slice(0, 120) });
        if (openB > closeB) {
          ss.push({ type: 'function', name });
          fnStack.push({ name, braceDepth: braceDepth + openB - closeB });
          fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB });
        }
        braceDepth += openB - closeB;
        continue;
      }

      // if
      const ifM = /^if\s*\((.{0,200})\)/.exec(tr);
      if (ifM) {
        const st = es('if', ln, f.pid, d, { condition_text: ifM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB }); }
        braceDepth += openB - closeB;
        continue;
      }
      if (/^\}\s*else\s*\{/.test(tr) || /^else\s*\{/.test(tr)) { braceDepth += openB - closeB; continue; }

      // while
      const whM = /^while\s*\((.{0,200})\)/.exec(tr);
      if (whM) {
        const st = es('while', ln, f.pid, d, { condition_text: whM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB }); }
        braceDepth += openB - closeB;
        continue;
      }

      // for
      const forM = /^for\s*\((.{0,200})\)/.exec(tr);
      if (forM) {
        const st = es('for', ln, f.pid, d, { condition_text: forM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB }); }
        braceDepth += openB - closeB;
        continue;
      }

      // repeat
      if (/^repeat\s*\{/.test(tr)) {
        const st = es('do', ln, f.pid, d, { text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB });
        braceDepth += openB - closeB;
        continue;
      }

      // tryCatch / try (R error handling)
      if (/^tryCatch\s*\(|^try\s*\(/.test(tr)) {
        const st = es('try', ln, f.pid, d, { text: tr.slice(0, 120) });
        ec(st.temp_id, /^tryCatch/.test(tr) ? 'tryCatch' : 'try', undefined, ln, 'function');
        braceDepth += openB - closeB;
        continue;
      }

      // stop / warning (throw-like)
      if (/^stop\s*\(/.test(tr)) { const st = es('throw', ln, f.pid, d, { text: tr.slice(0, 120) }); ec(st.temp_id, 'stop', undefined, ln, 'function'); continue; }

      // return
      if (/^return\s*\(/.test(tr)) { es('return', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }

      // library / require / source (already as symbols; also emit call)
      if (/^(?:library|require)\s*\(/.test(tr)) {
        const nm = /^(library|require)\s*\(\s*(?:"|')?(\w+)/.exec(tr);
        if (nm) { const st = es('call', ln, f.pid, d, { callee: nm[1], text: tr.slice(0, 120) }); ec(st.temp_id, nm[1], undefined, ln, 'function'); }
        continue;
      }
      if (/^source\s*\(/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: 'source', text: tr.slice(0, 120) });
        ec(st.temp_id, 'source', undefined, ln, 'function');
        continue;
      }

      // assignment: var <- expr  or  var = expr  (not inside if/for/while)
      const assignM = /^(\w+)\s*(?:<<?-|->>?|=)\s*(.+)/.exec(tr);
      if (assignM && !/^(?:if|while|for|repeat|function|return|stop|library|require|source)\b/.test(tr)) {
        const rhs = assignM[2];
        const callM = /(\w+)\s*\(/.exec(rhs);
        const st = es('assignment', ln, f.pid, d, { assigned_to: assignM[1], text: tr.slice(0, 120) });
        if (callM && callM[1] !== 'function') ec(st.temp_id, callM[1], undefined, ln, 'function');
        braceDepth += openB - closeB;
        while (fs.length > 1 && braceDepth < fs[fs.length - 1].braceDepthAtOpen) { fs.pop(); }
        while (fnStack.length > 0 && braceDepth < fnStack[fnStack.length - 1].braceDepth) { fnStack.pop(); if (ss.length > 1) ss.pop(); }
        continue;
      }

      // method call: obj$method() or func()
      const mCallM = /^(\w+)\$(\w+)\s*\(/.exec(tr);
      if (mCallM) {
        const st = es('call', ln, f.pid, d, { callee: mCallM[2], receiver: mCallM[1], text: tr.slice(0, 120) });
        ec(st.temp_id, mCallM[2], mCallM[1], ln, 'method');
      } else {
        const plainCallM = /^(\w+)\s*\(/.exec(tr);
        if (plainCallM && !/^(?:if|while|for|repeat|function|return|stop|library|require|source)\b/.test(tr)) {
          const st = es('call', ln, f.pid, d, { callee: plainCallM[1], text: tr.slice(0, 120) });
          ec(st.temp_id, plainCallM[1], undefined, ln, 'function');
        }
      }

      braceDepth += openB - closeB;
      while (fs.length > 1 && braceDepth < fs[fs.length - 1].braceDepthAtOpen) { fs.pop(); }
      while (fnStack.length > 0 && braceDepth < fnStack[fnStack.length - 1].braceDepth) { fnStack.pop(); if (ss.length > 1) ss.pop(); }
    }

    return { symbols, references, statements, callEdges };
  }
}

export const rParser = new RParser();
