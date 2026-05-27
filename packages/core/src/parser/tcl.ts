/**
 * MODUL: Tcl Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Tcl-Dateien (.tcl, .tk)
 *
 * EXTRAHIERT: package require/provide, proc, namespace, variable, set,
 *             oo::class/oo::define, source, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class TclParser implements LanguageParser {
  language = 'tcl';
  extensions = ['.tcl', '.tk', '.itcl'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package require / provide
    // ══════════════════════════════════════════════
    const pkgReqRe = /^\s*package\s+require\s+(?:-exact\s+)?([\w:]+)(?:\s+([\d.]+))?/gm;
    while ((m = pkgReqRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: m[2] ? `package require ${m[1]} ${m[2]}` : `package require ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    const pkgProvRe = /^\s*package\s+provide\s+([\w:]+)(?:\s+([\d.]+))?/gm;
    while ((m = pkgProvRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: m[1],
        value: m[2] ? `${m[1]} ${m[2]}` : m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Source (imports)
    // ══════════════════════════════════════════════
    const sourceRe = /^\s*source\s+["']?([^\s"']+)["']?/gm;
    while ((m = sourceRe.exec(content)) !== null) {
      const file = m[1];
      if (file.startsWith('$') || file.startsWith('[')) continue;
      const name = file.split('/').pop()?.replace(/\.tcl$/, '') || file;
      symbols.push({
        symbol_type: 'import',
        name,
        value: `source ${file}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Namespace
    // ══════════════════════════════════════════════
    const nsRe = /^\s*namespace\s+eval\s+([\w:]+)\s*\{/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'namespace',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Namespace export
    const nsExportRe = /^\s*namespace\s+export\s+([\w\s*]+)/gm;
    while ((m = nsExportRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: 'namespace export',
        value: m[1].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Procedures (proc)
    // ══════════════════════════════════════════════
    const procRe = /^\s*proc\s+([\w:]+)\s*\{([^}]*)\}\s*\{/gm;
    while ((m = procRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].split(/\s+/).filter(p => p && p !== 'args');

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: !name.startsWith('_'),
      });
    }

    // Proc with list args
    const procListRe = /^\s*proc\s+([\w:]+)\s+([\w]+)\s*\{/gm;
    while ((m = procListRe.exec(content)) !== null) {
      const name = m[1];
      if (symbols.some(s => s.name === name && s.symbol_type === 'function')) continue;
      symbols.push({
        symbol_type: 'function',
        name,
        params: [m[2]],
        line_start: lineAt(content, m.index),
        is_exported: !name.startsWith('_'),
      });
    }

    // ══════════════════════════════════════════════
    // 5. OO (TclOO / oo::class)
    // ══════════════════════════════════════════════
    const ooClassRe = /^\s*oo::class\s+create\s+([\w:]+)/gm;
    while ((m = ooClassRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'oo::class',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // oo::define methods
    const ooMethodRe = /^\s*(?:method|constructor|destructor)\s+(\w+)?\s*\{([^}]*)\}/gm;
    while ((m = ooMethodRe.exec(content)) !== null) {
      const name = m[1] || m[0].trim().split(/\s+/)[0];
      symbols.push({
        symbol_type: 'function',
        name,
        value: 'method',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Itcl classes
    const itclRe = /^\s*(?:itcl::)?class\s+([\w:]+)\s*\{/gm;
    while ((m = itclRe.exec(content)) !== null) {
      if (symbols.some(s => s.name === m![1])) continue;
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'itcl::class',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Variables
    // ══════════════════════════════════════════════
    const varRe = /^\s*(?:variable|set)\s+([\w:]+)\s+(.+)/gm;
    while ((m = varRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim().slice(0, 200);
      // Skip temp vars inside procs
      if (name.length <= 1) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        line_start: lineAt(content, m.index),
        is_exported: name.includes('::'),
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

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 8. Embedded SQL (sqlite3 / pgtcl)
    // ══════════════════════════════════════════════
    // <handle> eval/onecolumn/onerow/exec "SQL" or {SQL}
    const sqliteRe = /\b\w+\s+(?:eval|onecolumn|onerow|exec)\s+["{]((?:[^"}\\]|\\.){10,})["}]/g;
    while ((m = sqliteRe.exec(content)) !== null) {
      const sql = m[1];
      if (!looksLikeSql(sql)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sql, filePath, baseLine));
    }

    // pg_exec / pg_select / pg_execute conn "SQL"
    const pgRe = /\bpg_(?:exec|select|execute)\s+\w+\s+["{]((?:[^"}\\]|\\.){10,})["}]/g;
    while ((m = pgRe.exec(content)) !== null) {
      const sql = m[1];
      if (!looksLikeSql(sql)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sql, filePath, baseLine));
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

    interface TS { type: string; name: string | null; }
    const ss: TS[] = [{ type: 'module', name: null }];
    const cs = (): TS => ss[ss.length - 1];

    function es(st: string, line: number, pid: string | undefined, depth: number, extra: Partial<ParsedStatement> = {}): ParsedStatement {
      const sc = cs();
      const id = nid();
      const s: ParsedStatement = { temp_id: id, parent_temp_id: pid, scope_type: sc.type, scope_name: sc.name, statement_type: st, line_start: line, order_index: nord(pid), depth, is_top_level: sc.type === 'module' && depth === 0, is_awaited: false, ...extra };
      statements.push(s); return s;
    }
    function ec(sid: string, callee: string, recv: string | undefined, line: number, kind: string): void {
      callEdges.push({ statement_temp_id: sid, caller_scope: cs().name, callee_name: callee, callee_receiver: recv, line_number: line, call_kind: kind });
    }

    // Tcl: line-based, commands are first word on line
    // Depth tracking via brace-counting (Tcl bodies are in {})
    const tclLines = content.split('\n');
    interface TF { pid: string | undefined; depth: number; }
    const fs: TF[] = [{ pid: undefined, depth: 0 }];
    const tf = (): TF => fs[fs.length - 1];
    let braceNest = 0;

    for (let i = 0; i < tclLines.length; i++) {
      const raw = tclLines[i];
      const tr = raw.trim();
      const ln = i + 1;
      if (!tr || tr.startsWith('#')) continue;

      const openB = (tr.match(/\{/g) || []).length;
      const closeB = (tr.match(/\}/g) || []).length;
      const f = tf();
      const d = f.depth;

      // proc declaration
      const procM = /^proc\s+([\w:]+)\s/.exec(tr);
      if (procM) {
        const name = procM[1];
        const st = es('call', ln, f.pid, d, { callee: name, text: tr.slice(0, 120) });
        if (openB > closeB) {
          ss.push({ type: 'function', name });
          fs.push({ pid: st.temp_id, depth: d + 1 });
          braceNest += openB - closeB;
        }
        continue;
      }

      // if / elseif
      const ifM = /^(?:if|elseif)\s+[{"\[](.{0,200})[}"\]]/.exec(tr);
      if (ifM) {
        const st = es('if', ln, f.pid, d, { condition_text: ifM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1 }); braceNest += openB - closeB; }
        continue;
      }
      if (/^else\b/.test(tr)) continue;

      // while
      const whM = /^while\s+[{"\[](.{0,200})[}"\]]/.exec(tr);
      if (whM) {
        const st = es('while', ln, f.pid, d, { condition_text: whM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1 }); braceNest += openB - closeB; }
        continue;
      }

      // for / foreach
      if (/^for(?:each)?\s/.test(tr)) {
        const st = es('for', ln, f.pid, d, { text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1 }); braceNest += openB - closeB; }
        continue;
      }

      // switch
      if (/^switch\s/.test(tr)) {
        const st = es('switch', ln, f.pid, d, { text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1 }); braceNest += openB - closeB; }
        continue;
      }

      // try / catch
      if (/^try\s/.test(tr)) {
        const st = es('try', ln, f.pid, d, { text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1 }); braceNest += openB - closeB; }
        continue;
      }
      if (/^catch\s/.test(tr)) continue;

      // return
      if (/^return\b/.test(tr)) { es('return', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }
      // error (throw-like)
      if (/^error\s/.test(tr)) { const st = es('throw', ln, f.pid, d, { text: tr.slice(0, 120) }); ec(st.temp_id, 'error', undefined, ln, 'function'); continue; }

      // source
      if (/^source\s/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: 'source', text: tr.slice(0, 120) });
        ec(st.temp_id, 'source', undefined, ln, 'function');
        continue;
      }

      // package require / provide
      if (/^package\s/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: 'package', text: tr.slice(0, 120) });
        ec(st.temp_id, 'package', undefined, ln, 'function');
        continue;
      }

      // set var = assignment
      const setM = /^set\s+(\w+)\s+(.+)/.exec(tr);
      if (setM) {
        const callM = /\[(\w+)\s/.exec(setM[2]);
        const st = es('assignment', ln, f.pid, d, { assigned_to: setM[1], text: tr.slice(0, 120) });
        if (callM) ec(st.temp_id, callM[1], undefined, ln, 'function');
        braceNest += openB - closeB;
        while (fs.length > 1 && braceNest < 0) { fs.pop(); if (ss.length > 1) ss.pop(); braceNest++; }
        continue;
      }

      // namespace eval / oo::class create
      if (/^namespace\s+eval\s|^oo::class\s+create\s/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: tr.startsWith('namespace') ? 'namespace' : 'oo::class', text: tr.slice(0, 120) });
        ec(st.temp_id, st.callee!, undefined, ln, 'function');
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1 }); braceNest += openB - closeB; }
        continue;
      }

      // generic command call (first word on line)
      const cmdM = /^([\w:]+)\s/.exec(tr);
      if (cmdM && !/^(?:if|else|elseif|while|for|foreach|switch|try|catch|return|error|proc|set|source|package|namespace)\b/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: cmdM[1], text: tr.slice(0, 120) });
        ec(st.temp_id, cmdM[1], undefined, ln, 'function');
      }

      braceNest += openB - closeB;
      while (fs.length > 1 && braceNest < 0) { fs.pop(); if (ss.length > 1) ss.pop(); braceNest++; }
    }

    return { symbols, references, statements, callEdges };
  }
}

export const tclParser = new TclParser();
