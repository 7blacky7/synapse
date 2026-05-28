/**
 * MODUL: Shell Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Shell-Skripten
 *
 * EXTRAHIERT: function, variable (assignment/export), source/., alias,
 *             shebang, comment, todo
 * ANSATZ: Regex-basiert — Shell hat einfache Deklarations-Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ShellParser implements LanguageParser {
  language = 'shell';
  extensions = ['.sh', '.bash', '.zsh', '.fish'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;
    const isFish = filePath.endsWith('.fish');

    // ══════════════════════════════════════════════
    // 1. Shebang
    // ══════════════════════════════════════════════
    const shebangRe = /^#!\s*(.+)/;
    m = shebangRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: m[1].trim(),
        line_start: 1,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Functions
    // ══════════════════════════════════════════════
    if (isFish) {
      // fish: function name
      const fishFuncRe = /^function\s+(\w+)(?:\s+--description\s+'([^']*)')?/gm;
      while ((m = fishFuncRe.exec(content)) !== null) {
        const name = m[1];
        const desc = m[2] || undefined;
        const lineStart = lineAt(content, m.index);
        const lineEnd = this.findFishEnd(lines, lineStart - 1);

        symbols.push({
          symbol_type: 'function',
          name,
          value: desc,
          line_start: lineStart,
          line_end: lineEnd,
          is_exported: true,
        });
      }
    } else {
      // bash/zsh: function name() { or name() {
      const funcRe = /^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm;
      while ((m = funcRe.exec(content)) !== null) {
        const name = m[1];
        const lineStart = lineAt(content, m.index);
        const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

        symbols.push({
          symbol_type: 'function',
          name,
          line_start: lineStart,
          line_end: lineEnd,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Variable Assignments
    // ══════════════════════════════════════════════
    if (isFish) {
      // fish: set -g / set -gx / set -l
      const fishSetRe = /^set\s+(?:-([gxlu]+)\s+)*(\w+)\s+(.*)/gm;
      while ((m = fishSetRe.exec(content)) !== null) {
        const flags = m[1] || '';
        const name = m[2];
        const value = m[3].trim().slice(0, 200);
        const isExported = flags.includes('x') || flags.includes('g');

        symbols.push({
          symbol_type: 'variable',
          name,
          value,
          line_start: lineAt(content, m.index),
          is_exported: isExported,
        });
      }
    } else {
      // bash/zsh: export VAR=value
      const exportRe = /^export\s+(\w+)(?:=(.*))?/gm;
      while ((m = exportRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'export',
          name: m[1],
          value: m[2] ? m[2].trim().slice(0, 200) : undefined,
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }

      // VAR=value (top-level, ohne export)
      const assignRe = /^(\w+)=(.+)/gm;
      while ((m = assignRe.exec(content)) !== null) {
        const name = m[1];
        // Skip wenn in Funktion (eingerückt)
        const lineIdx = lineAt(content, m.index) - 1;
        if (lineIdx < lines.length && lines[lineIdx].match(/^\S/)) {
          symbols.push({
            symbol_type: 'variable',
            name,
            value: m[2].trim().slice(0, 200),
            line_start: lineIdx + 1,
            is_exported: false,
          });
        }
      }

      // readonly / declare / local / typeset
      const declareRe = /^(readonly|declare|typeset)\s+(?:-\w+\s+)*(\w+)(?:=(.*))?/gm;
      while ((m = declareRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'variable',
          name: m[2],
          value: m[3] ? m[3].trim().slice(0, 200) : m[1],
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Source / Include
    // ══════════════════════════════════════════════
    const sourceRe = /^(?:source|\.)(?:\s+)["']?([^\s"']+)["']?/gm;
    while ((m = sourceRe.exec(content)) !== null) {
      const file = m[1];
      const name = file.split('/').pop() || file;
      symbols.push({
        symbol_type: 'import',
        name,
        value: file,
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
    // 5. Aliases
    // ══════════════════════════════════════════════
    const aliasRe = /^alias\s+(\w+)=['"]?([^'";\n]+)/gm;
    while ((m = aliasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: `alias: ${m[2].trim()}`.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      // Skip shebang
      if (m.index === 0 && m[0].startsWith('#!')) continue;
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Block-Kommentare (zusammenhaengende #-Zeilen)
    // ══════════════════════════════════════════════
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#') && !line.startsWith('#!') && !line.match(/^#\s*(TODO|FIXME|HACK)/i)) {
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

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 8. Embedded SQL (sqlite3/psql/mysql CLI + Heredocs)
    // ══════════════════════════════════════════════
    // sqlite3 db.sqlite "SELECT ..."
    const sqlite3Re = /\bsqlite3\s+\S+\s+["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = sqlite3Re.exec(content)) !== null) {
      const sql = m[1];
      if (!looksLikeSql(sql)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sql, filePath, baseLine));
    }

    // psql ... -c "SELECT ..."
    const psqlRe = /\bpsql\s+(?:[^|]*?)-c\s+["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = psqlRe.exec(content)) !== null) {
      const sql = m[1];
      if (!looksLikeSql(sql)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sql, filePath, baseLine));
    }

    // mysql ... -e "SELECT ..."
    const mysqlRe = /\bmysql\s+(?:[^|]*?)-e\s+["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = mysqlRe.exec(content)) !== null) {
      const sql = m[1];
      if (!looksLikeSql(sql)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sql, filePath, baseLine));
    }

    // Heredocs: <<EOF ... EOF, <<-SQL ... SQL, <<'EOF' ... EOF
    const heredocRe = /<<(?:-)?\s*['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/gm;
    while ((m = heredocRe.exec(content)) !== null) {
      const body = m[2];
      if (!looksLikeSql(body)) continue;
      // baseLine = Zeile nach der <<TAG-Zeile (Body startet dort)
      const heredocLine = lineAt(content, m.index);
      const baseLine = heredocLine + 1;
      symbols.push(...parseEmbeddedSql(body, filePath, baseLine));
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
    interface ShScope { type: string; name: string | null; }
    const ss: ShScope[] = [{ type: 'module', name: null }];
    const cs = (): ShScope => ss[ss.length - 1];

    function es(st: string, line: number, pid: string | undefined, depth: number, extra: Partial<ParsedStatement> = {}): ParsedStatement {
      const sc = cs(); const id = nid();
      const s: ParsedStatement = { temp_id: id, parent_temp_id: pid, scope_type: sc.type, scope_name: sc.name, statement_type: st, line_start: line, order_index: nord(pid), depth, is_top_level: sc.type === 'module' && depth === 0, is_awaited: false, ...extra };
      statements.push(s); return s;
    }
    function ec(sid: string, callee: string, recv: string | undefined, line: number, kind: string): void {
      callEdges.push({ statement_temp_id: sid, caller_scope: cs().name, callee_name: callee, callee_receiver: recv, line_number: line, call_kind: kind });
    }

    const shLines = content.split('\n');
    interface ShFrame { pid: string | undefined; depth: number; indentLevel: number; }
    const fs: ShFrame[] = [{ pid: undefined, depth: 0, indentLevel: -1 }];
    const tf = (): ShFrame => fs[fs.length - 1];
    interface FnEnt { name: string; indent: number; }
    const fnStack: FnEnt[] = [];

    for (let i = 0; i < shLines.length; i++) {
      const raw = shLines[i];
      const tr = raw.replace(/#.*$/, '').trim();
      const ln = i + 1;
      if (!tr) continue;
      const indent = raw.search(/\S/);

      // closing keywords pop frames
      if (/^fi\b|^done\b|^esac\b/.test(tr)) { if (fs.length > 1) fs.pop(); continue; }
      if (tr === '}' && fnStack.length > 0 && indent <= fnStack[fnStack.length - 1].indent) {
        fnStack.pop(); ss.pop(); if (fs.length > 1) fs.pop(); continue;
      }
      while (fs.length > 1 && indent < fs[fs.length - 1].indentLevel) fs.pop();

      const f = tf();
      const d = f.depth;

      // function declaration
      const fnM = /^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{?/.exec(tr);
      if (fnM && /^(?:function\s+\w+|\w+\s*\(\))/.test(tr)) {
        const name = fnM[1];
        const st = es('call', ln, f.pid, d, { callee: name, text: tr.slice(0, 120) });
        fnStack.push({ name, indent });
        ss.push({ type: 'function', name });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // if / elif
      const ifM = /^(?:if|elif)\s+(.+?)(?:\s*;\s*then)?$/.exec(tr);
      if (ifM) {
        const st = es('if', ln, f.pid, d, { condition_text: ifM[1].slice(0, 200), text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }
      if (/^else\b/.test(tr)) continue;

      // while / until
      const whM = /^(?:while|until)\s+(.+?)(?:\s*;\s*do)?$/.exec(tr);
      if (whM) {
        const st = es('while', ln, f.pid, d, { condition_text: whM[1].slice(0, 200), text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // for
      const forM = /^for\s+(\w+)\s+in\s+(.+?)(?:\s*;\s*do)?$/.exec(tr);
      if (forM) {
        const st = es('for', ln, f.pid, d, { condition_text: `${forM[1]} in ${forM[2]}`.slice(0, 200), text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // case
      if (/^case\s/.test(tr)) {
        const st = es('switch', ln, f.pid, d, { text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // return / exit
      if (/^return\b/.test(tr)) { es('return', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }
      if (/^exit\b/.test(tr)) { es('return', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }

      // source / .
      if (/^(?:source|\.\s+)\s*/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: 'source', text: tr.slice(0, 120) });
        ec(st.temp_id, 'source', undefined, ln, 'function');
        continue;
      }

      // assignment: VAR=value
      const assignM = /^(\w+)=(.*)/.exec(tr);
      if (assignM && !/^(?:if|while|until|for|case|function)\b/.test(tr)) {
        const rhs = assignM[2];
        // command substitution $(...) or backtick
        const cmdSubM = /\$\((\w+)/.exec(rhs) || /`(\w+)/.exec(rhs);
        const st = es('assignment', ln, f.pid, d, { assigned_to: assignM[1], text: tr.slice(0, 120) });
        if (cmdSubM) ec(st.temp_id, cmdSubM[1], undefined, ln, 'function');
        continue;
      }

      // pipe command: first command in a pipeline is a statement
      // each command in the line is a call
      const cmdParts = tr.split(/\s*[|&;]\s*/);
      for (const part of cmdParts) {
        const cmdM = /^([\w./][\w./\-]*)/.exec(part.trim());
        if (cmdM && !/^(?:if|elif|else|fi|then|while|until|do|done|for|in|case|esac|function|return|exit|source|export|local|readonly|declare)\b/.test(part.trim())) {
          const st = es('call', ln, f.pid, d, { callee: cmdM[1], text: part.trim().slice(0, 120) });
          ec(st.temp_id, cmdM[1], undefined, ln, 'function');
          break; // only first command as primary statement
        }
      }
    }

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

  /** fish: function ... end */
  private findFishEnd(lines: string[], startIdx: number): number {
    let depth = 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^(function|if|for|while|switch|begin)\b/.test(line)) depth++;
      if (/^end\b/.test(line)) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return lines.length;
  }
}

export const shellParser = new ShellParser();
