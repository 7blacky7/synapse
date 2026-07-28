/**
 * MODUL: Lua Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Lua-Dateien
 *
 * EXTRAHIERT: function (global/local/method), local variable, table,
 *             require, module, comment, todo
 * ANSATZ: Regex-basiert — Lua hat minimale, klare Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';

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

class LuaParser implements LanguageParser {
  language = 'lua';
  extensions = ['.lua'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. require
    // ══════════════════════════════════════════════
    const requireRe = /(?:local\s+(\w+)\s*=\s*)?require\s*\(?['"]([^'"]+)['"]\)?/g;
    while ((m = requireRe.exec(content)) !== null) {
      const alias = m[1] || m[2].split(/[./]/).pop() || m[2];
      symbols.push({
        symbol_type: 'import',
        name: alias,
        value: m[2],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: alias,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Functions
    // ══════════════════════════════════════════════
    // Global: function name(...)
    const globalFuncRe = /^function\s+([\w.]+)\s*\(([^)]*)\)/gm;
    while ((m = globalFuncRe.exec(content)) !== null) {
      const fullName = m[1];
      const paramsRaw = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1);

      const parts = fullName.split('.');
      const name = parts[parts.length - 1];
      const parent = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;

      const params = paramsRaw.split(',').map(p => p.trim()).filter(p => p && p !== '...');

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
        parent_id: parent,
      });
    }

    // Method: function name:method(...)
    const methodRe = /^function\s+(\w+):(\w+)\s*\(([^)]*)\)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const parent = m[1];
      const name = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1);

      const params = paramsRaw.split(',').map(p => p.trim()).filter(p => p && p !== '...');

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
        parent_id: parent,
      });

      references.push({
        symbol_name: parent,
        line_number: lineStart,
        context: `function ${parent}:${name}(...)`,
      });
    }

    // Local: local function name(...)
    const localFuncRe = /^local\s+function\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((m = localFuncRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1);

      const params = paramsRaw.split(',').map(p => p.trim()).filter(p => p && p !== '...');

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: false,
      });
    }

    // Anonymous function assignment: name = function(...)
    const anonFuncRe = /^(local\s+)?(\w+(?:\.\w+)*)\s*=\s*function\s*\(([^)]*)\)/gm;
    while ((m = anonFuncRe.exec(content)) !== null) {
      const isLocal = !!m[1];
      const fullName = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1);

      const parts = fullName.split('.');
      const name = parts[parts.length - 1];
      const parent = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;

      const params = paramsRaw.split(',').map(p => p.trim()).filter(p => p && p !== '...');

      // Skip if already found as global function
      if (symbols.some(s => s.name === name && s.line_start === lineStart)) continue;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !isLocal,
        parent_id: parent,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Local Variables / Tables
    // ══════════════════════════════════════════════
    const localVarRe = /^local\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = localVarRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim();

      // Skip function assignments (already handled)
      if (value.startsWith('function')) continue;
      if (value === 'require') continue;

      const isTable = value.startsWith('{');

      symbols.push({
        symbol_type: 'variable',
        name,
        value: isTable ? 'table' : value.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // Global assignments (top-level): NAME = value
    const globalVarRe = /^(\w+)\s*=\s*(.+)/gm;
    while ((m = globalVarRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim();

      if (value.startsWith('function') || name === 'local' || name === 'return') continue;
      if (symbols.some(s => s.name === name && s.line_start === lineAt(content, m!.index))) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value.startsWith('{') ? 'table' : value.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Module pattern: M = {} ... return M
    // ══════════════════════════════════════════════
    const moduleRe = /^local\s+(\w+)\s*=\s*\{\s*\}/m;
    const returnRe = /^return\s+(\w+)\s*$/m;
    const modMatch = moduleRe.exec(content);
    const retMatch = returnRe.exec(content);
    if (modMatch && retMatch && modMatch[1] === retMatch[1]) {
      symbols.push({
        symbol_type: 'export',
        name: modMatch[1],
        value: 'module',
        line_start: lineAt(content, modMatch.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /--\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 6. Block-Kommentare (--[[ ... ]])
    // ══════════════════════════════════════════════
    const blockCommentRe = /--\[\[([\s\S]*?)\]\]/g;
    while ((m = blockCommentRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // Zusammenhaengende -- Kommentare
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('--') && !line.startsWith('--[[') && !line.match(/^--\s*(TODO|FIXME|HACK)/i)) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(line.replace(/^--\s?/, ''));
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

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 7. Lapis/OpenResty Routes: app:get("/x", handler)
    // ══════════════════════════════════════════════
    const lapisSimpleRe = /\b\w+:(get|post|put|patch|delete|head|options|match)\s*\(\s*["']([^"']+)["']/g;
    const lapisNamedRe = /\b\w+:(get|post|put|patch|delete|head|options|match)\s*\(\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g;
    const seenRoutes = new Set<string>();
    while ((m = lapisSimpleRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      if (!HTTP_VERBS.has(verb) && verb !== 'match') continue;
      let path = m[2];
      if (!isLikelyHttpPath(path)) {
        // Try named route variant: 1. arg = name, 2. arg = path
        lapisNamedRe.lastIndex = m.index;
        const named = lapisNamedRe.exec(content);
        if (named && named.index === m.index && isLikelyHttpPath(named[2])) {
          path = named[2];
        } else {
          continue;
        }
      }
      const method = verb === 'match' ? 'ANY' : verb.toUpperCase();
      const lineStart = lineAt(content, m.index);
      const key = `${method} ${path}@${lineStart}`;
      if (seenRoutes.has(key)) continue;
      seenRoutes.add(key);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method],
        line_start: lineStart,
        is_exported: true,
      });
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

    interface LS { type: string; name: string | null; }
    const ss: LS[] = [{ type: 'module', name: null }];
    const cs = (): LS => ss[ss.length - 1];

    function es(st: string, line: number, pid: string | undefined, depth: number, extra: Partial<ParsedStatement> = {}): ParsedStatement {
      const sc = cs();
      const id = nid();
      const s: ParsedStatement = { temp_id: id, parent_temp_id: pid, scope_type: sc.type, scope_name: sc.name, statement_type: st, line_start: line, order_index: nord(pid), depth, is_top_level: sc.type === 'module' && depth === 0, is_awaited: false, ...extra };
      statements.push(s); return s;
    }
    function ec(sid: string, callee: string, recv: string | undefined, line: number, kind: string): void {
      callEdges.push({ statement_temp_id: sid, caller_scope: cs().name, callee_name: callee, callee_receiver: recv, line_number: line, call_kind: kind });
    }

    const luaLines = content.split('\n');
    interface LF { pid: string | undefined; depth: number; indentLevel: number; }
    const fs: LF[] = [{ pid: undefined, depth: 0, indentLevel: -1 }];
    const tf = (): LF => fs[fs.length - 1];

    interface FnEntry { name: string; indent: number; }
    const fnStack: FnEntry[] = [];

    for (let i = 0; i < luaLines.length; i++) {
      const raw = luaLines[i];
      const tr = raw.trim();
      const ln = i + 1;
      if (!tr || tr.startsWith('--')) continue;
      const indent = raw.search(/\S/);

      // pop block frames on 'end' or 'until'
      if (/^end\b|^until\b/.test(tr)) {
        if (fnStack.length > 0 && indent <= fnStack[fnStack.length - 1].indent) {
          fnStack.pop(); ss.pop();
        }
        if (fs.length > 1) fs.pop();
        continue;
      }
      while (fs.length > 1 && indent < fs[fs.length - 1].indentLevel) fs.pop();

      const f = tf();
      const d = f.depth;

      // function declaration: function name() or local function name()
      const fnM = /^(?:local\s+)?function\s+([\w.:]+)\s*\(/.exec(tr);
      if (fnM) {
        const name = fnM[1];
        const st = es('call', ln, f.pid, d, { callee: name, text: tr.slice(0, 120) });
        fnStack.push({ name, indent });
        ss.push({ type: 'function', name });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }
      // local name = function(...)
      const fnAssignM = /^(?:local\s+)?(\w+)\s*=\s*function\s*\(/.exec(tr);
      if (fnAssignM) {
        const name = fnAssignM[1];
        const st = es('variable', ln, f.pid, d, { assigned_to: name, text: tr.slice(0, 120) });
        fnStack.push({ name, indent });
        ss.push({ type: 'function', name });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // if / elseif
      const ifM = /^(?:if|elseif)\s+(.+)\s+then\b/.exec(tr);
      if (ifM) {
        const st = es('if', ln, f.pid, d, { condition_text: ifM[1].slice(0, 200), text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }
      if (/^else\b/.test(tr)) continue;

      // while
      const whM = /^while\s+(.+)\s+do\b/.exec(tr);
      if (whM) {
        const st = es('while', ln, f.pid, d, { condition_text: whM[1].slice(0, 200), text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // for
      const forM = /^for\s+(.+)\s+do\b/.exec(tr);
      if (forM) {
        const st = es('for', ln, f.pid, d, { condition_text: forM[1].slice(0, 200), text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // repeat
      if (/^repeat\b/.test(tr)) {
        const st = es('do', ln, f.pid, d, { text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // return
      if (/^return\b/.test(tr)) { es('return', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }
      // error (throw-like)
      if (/^error\s*\(/.test(tr)) { const st = es('throw', ln, f.pid, d, { text: tr.slice(0, 120) }); ec(st.temp_id, 'error', undefined, ln, 'function'); continue; }

      // require
      if (/require\s*[\("']/.test(tr)) {
        const rM = /require\s*[\("']([^"')]+)[\)"']/.exec(tr);
        const assignM2 = /^(?:local\s+)?(\w+)\s*=/.exec(tr);
        const st = es(assignM2 ? 'variable' : 'call', ln, f.pid, d, { callee: 'require', assigned_to: assignM2?.[1], text: tr.slice(0, 120) });
        ec(st.temp_id, 'require', undefined, ln, 'function');
        continue;
      }

      // local var = expr or var = expr
      const assignM = /^(?:local\s+)?(\w+)\s*=\s*(.+)/.exec(tr);
      if (assignM && !/^(?:if|while|for|repeat|function|return|else|end)\b/.test(tr)) {
        const rhs = assignM[2];
        const callM = /(\w+)\s*\(/.exec(rhs);
        const st = es('variable', ln, f.pid, d, { assigned_to: assignM[1], text: tr.slice(0, 120) });
        if (callM) ec(st.temp_id, callM[1], undefined, ln, 'function');
        continue;
      }

      // method call: obj:method() or obj.method() or func()
      const mCallM = /^([\w.]+)[.:](\w+)\s*\(/.exec(tr);
      if (mCallM) {
        const st = es('call', ln, f.pid, d, { callee: mCallM[2], receiver: mCallM[1], text: tr.slice(0, 120) });
        ec(st.temp_id, mCallM[2], mCallM[1], ln, 'method');
        continue;
      }
      const plainCallM = /^(\w+)\s*\(/.exec(tr);
      if (plainCallM && !/^(?:if|while|for|function|return|local|end)\b/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: plainCallM[1], text: tr.slice(0, 120) });
        ec(st.temp_id, plainCallM[1], undefined, ln, 'function');
        continue;
      }
    }

    return { symbols, references, statements, callEdges };
  }

  /** Findet das passende 'end' */
  private findEnd(lines: string[], startIdx: number): number {
    let depth = 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/\b(function|if|for|while|repeat)\b/.test(line) && !/^--/.test(line)) {
        // Count openers (but not in strings/comments)
        const cleaned = line.replace(/--.*$/, '').replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
        if (/\b(function|if|for|while)\b/.test(cleaned)) depth++;
      }
      if (/\bend\b/.test(line) && !/^--/.test(line)) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return lines.length;
  }
}

export const luaParser = new LuaParser();
