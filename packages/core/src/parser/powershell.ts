/**
 * MODUL: PowerShell Parser
 * ZWECK: Extrahiert Struktur-Informationen aus PowerShell-Dateien (.ps1, .psm1, .psd1)
 *
 * EXTRAHIERT: function/filter, class, enum, param block, using,
 *             Import-Module/. source, Set-Variable, [CmdletBinding],
 *             #Requires, comment-based help, todo
 * ANSATZ: Regex-basiert (case-insensitive)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { HTTP_VERBS, isLikelyHttpPath, formatRouteName } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class PowerShellParser implements LanguageParser {
  language = 'powershell';
  extensions = ['.ps1', '.psm1', '.psd1'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Using statements
    // ══════════════════════════════════════════════
    const usingRe = /^using\s+(namespace|module|assembly)\s+([\w.]+)/gim;
    while ((m = usingRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[2].split('.').pop() || m[2],
        value: `using ${m[1]} ${m[2]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[2].split('.').pop() || m[2],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. #Requires
    // ══════════════════════════════════════════════
    const requiresRe = /^#Requires\s+(.+)/gim;
    while ((m = requiresRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: '#Requires',
        value: m[1].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Import-Module / . source
    // ══════════════════════════════════════════════
    const importModRe = /^\s*Import-Module\s+(?:-Name\s+)?['"]?([\w.-]+)['"]?/gim;
    while ((m = importModRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: `Import-Module ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `Import-Module ${m[1]}`.slice(0, 80),
      });
    }

    // Dot-sourcing
    const dotSourceRe = /^\s*\.\s+["']?([^\s"']+)["']?/gm;
    while ((m = dotSourceRe.exec(content)) !== null) {
      const file = m[1];
      if (!file.endsWith('.ps1') && !file.includes('$')) continue;
      const name = file.split(/[/\\]/).pop()?.replace('.ps1', '') || file;
      symbols.push({
        symbol_type: 'import',
        name,
        value: `. ${file}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Functions / Filters
    // ══════════════════════════════════════════════
    const funcRe = /^\s*(function|filter)\s+([\w-]+)\s*(?:\(([^)]*)\))?\s*\{/gim;
    while ((m = funcRe.exec(content)) !== null) {
      const kind = m[1].toLowerCase();
      const name = m[2];
      const paramsRaw = m[3] || '';
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().replace(/^\[.*?\]\s*/, '').replace(/^\$/, '').split('=')[0].trim())
        .filter(Boolean);

      // Check for param() block inside function
      const funcBody = content.substring(m.index + m[0].length, m.index + m[0].length + 1000);
      const paramBlockMatch = funcBody.match(/param\s*\(([\s\S]*?)\)/i);
      if (paramBlockMatch && params.length === 0) {
        const blockParams = paramBlockMatch[1]
          .split(',')
          .map(p => p.trim().replace(/^\[.*?\]\s*/g, '').replace(/^\$/, '').split('=')[0].trim())
          .filter(p => p && !p.startsWith('[') && !p.startsWith('#'));
        params.push(...blockParams);
      }

      symbols.push({
        symbol_type: 'function',
        name,
        value: kind,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Classes (PowerShell 5+)
    // ══════════════════════════════════════════════
    const classRe = /^\s*class\s+(\w+)(?:\s*:\s*(\w+))?\s*\{/gim;
    while ((m = classRe.exec(content)) !== null) {
      const name = m[1];
      const parent = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'class',
        params: parent ? [parent] : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `class ${name} : ${parent}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Enum (PowerShell 5+)
    // ══════════════════════════════════════════════
    const enumRe = /^\s*enum\s+(\w+)\s*\{/gim;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[1],
        value: 'enum',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Script-level Param block
    // ══════════════════════════════════════════════
    const scriptParamRe = /^(?:\[CmdletBinding\([^\]]*\)\]\s*)?param\s*\(([\s\S]*?)\)/gim;
    m = scriptParamRe.exec(content);
    if (m) {
      const params = m[1]
        .split(',')
        .map(p => p.trim().replace(/^\[.*?\]\s*/g, '').replace(/^\$/, '').split('=')[0].trim())
        .filter(p => p && !p.startsWith('[') && !p.startsWith('#'));

      if (params.length > 0) {
        for (const param of params) {
          if (!param) continue;
          symbols.push({
            symbol_type: 'variable',
            name: param,
            value: 'param',
            line_start: lineAt(content, m.index),
            is_exported: true,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 8. Module-level variables
    // ══════════════════════════════════════════════
    const varRe = /^\s*(?:New-Variable|Set-Variable)\s+(?:-Name\s+)?['"]?(\w+)['"]?\s+(?:-Value\s+)?([^\n]+)/gim;
    while ((m = varRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Script-scope variables
    const scriptVarRe = /^\$(?:script:|global:)(\w+)\s*=\s*(.+)/gm;
    while ((m = scriptVarRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Export-ModuleMember
    // ══════════════════════════════════════════════
    const exportRe = /^\s*Export-ModuleMember\s+(?:-Function\s+)?(.+)/gim;
    while ((m = exportRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: 'Export-ModuleMember',
        value: m[1].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      // Skip #Requires
      if (m[0].trim().startsWith('#Requires')) continue;
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Comment-based help
    // ══════════════════════════════════════════════
    const helpRe = /<#([\s\S]*?)#>/g;
    while ((m = helpRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\.SYNOPSIS\s*/im, '').trim();
      if (text.length < 5) continue;
      const synopsis = text.split('\n')[0].trim();
      if (synopsis.length >= 3) {
        symbols.push({
          symbol_type: 'comment',
          name: null,
          value: synopsis.slice(0, 500),
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 12. Pode Routes (Add-PodeRoute -Method X -Path Y)
    // ══════════════════════════════════════════════
    const podeMethodFirstRe = /Add-PodeRoute\s+(?:[^|]*?)-Method\s+(Get|Post|Put|Patch|Delete|Head|Options)\s+(?:[^|]*?)-Path\s+['"]([^'"]+)['"]/gi;
    while ((m = podeMethodFirstRe.exec(content)) !== null) {
      const method = m[1].toLowerCase();
      const path = m[2];
      if (!HTTP_VERBS.has(method) || !isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method.toUpperCase()],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }
    const podePathFirstRe = /Add-PodeRoute\s+(?:[^|]*?)-Path\s+['"]([^'"]+)['"]\s+(?:[^|]*?)-Method\s+(Get|Post|Put|Patch|Delete|Head|Options)/gi;
    while ((m = podePathFirstRe.exec(content)) !== null) {
      const method = m[2].toLowerCase();
      const path = m[1];
      if (!HTTP_VERBS.has(method) || !isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method.toUpperCase()],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 13. Embedded SQL (Invoke-Sqlcmd / Invoke-DbaQuery / SqlCommand / here-strings)
    // ══════════════════════════════════════════════
    const invokeSqlcmdRe = /Invoke-Sqlcmd\s+(?:[^|]*?)-Query\s+["']((?:[^"'\\]|\\.){10,})["']/gi;
    while ((m = invokeSqlcmdRe.exec(content)) !== null) {
      if (!looksLikeSql(m[1])) continue;
      symbols.push(...parseEmbeddedSql(m[1], filePath, lineAt(content, m.index)));
    }
    const invokeDbaRe = /Invoke-DbaQuery\s+(?:[^|]*?)-Query\s+["']((?:[^"'\\]|\\.){10,})["']/gi;
    while ((m = invokeDbaRe.exec(content)) !== null) {
      if (!looksLikeSql(m[1])) continue;
      symbols.push(...parseEmbeddedSql(m[1], filePath, lineAt(content, m.index)));
    }
    const sqlCommandRe = /\bnew-object\s+System\.Data\.SqlClient\.SqlCommand\s*\(\s*["']((?:[^"'\\]|\\.){10,})["']/gi;
    while ((m = sqlCommandRe.exec(content)) !== null) {
      if (!looksLikeSql(m[1])) continue;
      symbols.push(...parseEmbeddedSql(m[1], filePath, lineAt(content, m.index)));
    }
    const hereStringRe = /@"([\s\S]{10,}?)"@/g;
    while ((m = hereStringRe.exec(content)) !== null) {
      if (!looksLikeSql(m[1])) continue;
      symbols.push(...parseEmbeddedSql(m[1], filePath, lineAt(content, m.index)));
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
    interface PsScope { type: string; name: string | null; }
    const ss: PsScope[] = [{ type: 'module', name: null }];
    const cs = (): PsScope => ss[ss.length - 1];

    function es(st: string, line: number, pid: string | undefined, depth: number, extra: Partial<ParsedStatement> = {}): ParsedStatement {
      const sc = cs(); const id = nid();
      const s: ParsedStatement = { temp_id: id, parent_temp_id: pid, scope_type: sc.type, scope_name: sc.name, statement_type: st, line_start: line, order_index: nord(pid), depth, is_top_level: sc.type === 'module' && depth === 0, is_awaited: false, ...extra };
      statements.push(s); return s;
    }
    function ec(sid: string, callee: string, recv: string | undefined, line: number, kind: string): void {
      callEdges.push({ statement_temp_id: sid, caller_scope: cs().name, callee_name: callee, callee_receiver: recv, line_number: line, call_kind: kind });
    }

    const psLines = content.split('\n');
    interface PsFrame { pid: string | undefined; depth: number; braceDepthAtOpen: number; }
    const fs: PsFrame[] = [{ pid: undefined, depth: 0, braceDepthAtOpen: 0 }];
    const tf = (): PsFrame => fs[fs.length - 1];
    interface FnEntry { name: string; braceDepth: number; }
    const fnStack: FnEntry[] = [];
    let braceDepth = 0;

    for (let i = 0; i < psLines.length; i++) {
      const raw = psLines[i];
      // strip line comments
      const tr = raw.replace(/#.*$/, '').trim();
      const ln = i + 1;
      if (!tr) continue;

      const openB = (tr.match(/\{/g) || []).length;
      const closeB = (tr.match(/\}/g) || []).length;
      const f = tf();
      const d = f.depth;

      // function declaration
      const fnM = /^function\s+([\w-]+)\s*\{?/i.exec(tr);
      if (fnM) {
        const name = fnM[1];
        const st = es('call', ln, f.pid, d, { callee: name, text: tr.slice(0, 120) });
        if (openB > 0) {
          ss.push({ type: 'function', name });
          fnStack.push({ name, braceDepth: braceDepth + openB - closeB });
          fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB });
        }
        braceDepth += openB - closeB;
        continue;
      }

      // if / elseif
      const ifM = /^(?:if|elseif)\s*\((.{0,200})\)/i.exec(tr);
      if (ifM) {
        const st = es('if', ln, f.pid, d, { condition_text: ifM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB }); }
        braceDepth += openB - closeB;
        continue;
      }
      if (/^else\s*\{/i.test(tr)) { braceDepth += openB - closeB; continue; }

      // while
      const whM = /^while\s*\((.{0,200})\)/i.exec(tr);
      if (whM) {
        const st = es('while', ln, f.pid, d, { condition_text: whM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB }); }
        braceDepth += openB - closeB;
        continue;
      }

      // for / foreach
      const forM = /^(?:for|foreach)\s*\((.{0,200})\)/i.exec(tr);
      if (forM) {
        const st = es('for', ln, f.pid, d, { condition_text: forM[1].slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB }); }
        braceDepth += openB - closeB;
        continue;
      }

      // switch
      const swM = /^switch\s*(?:\((.{0,200})\))?/i.exec(tr);
      if (swM && /^switch\b/i.test(tr)) {
        const st = es('switch', ln, f.pid, d, { condition_text: swM[1]?.slice(0, 200), text: tr.slice(0, 120) });
        if (openB > closeB) { fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB }); }
        braceDepth += openB - closeB;
        continue;
      }

      // try / catch
      if (/^try\s*\{/i.test(tr)) {
        const st = es('try', ln, f.pid, d, { text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, braceDepthAtOpen: braceDepth + openB - closeB });
        braceDepth += openB - closeB;
        continue;
      }
      if (/^catch\s*\{/i.test(tr) || /^finally\s*\{/i.test(tr)) { braceDepth += openB - closeB; continue; }

      // throw
      if (/^throw\b/i.test(tr)) { es('throw', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }
      // return
      if (/^return\b/i.test(tr)) { es('return', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }

      // . source
      if (/^\.\s+/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: 'source', text: tr.slice(0, 120) });
        ec(st.temp_id, 'source', undefined, ln, 'function');
        continue;
      }

      // Import-Module
      if (/^Import-Module\b/i.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: 'Import-Module', text: tr.slice(0, 120) });
        ec(st.temp_id, 'Import-Module', undefined, ln, 'function');
        continue;
      }

      // $var = expr assignment
      const assignM = /^\$(\w+)\s*(?:[+\-*\/]?=)(?!=)\s*(.+)/.exec(tr);
      if (assignM) {
        const callM = /([\w-]+)\s*\(/.exec(assignM[2]);
        const st = es('assignment', ln, f.pid, d, { assigned_to: `$${assignM[1]}`, text: tr.slice(0, 120) });
        if (callM) ec(st.temp_id, callM[1], undefined, ln, 'function');
        braceDepth += openB - closeB;
        while (fs.length > 1 && braceDepth < fs[fs.length - 1].braceDepthAtOpen) { fs.pop(); if (ss.length > 1) ss.pop(); }
        while (fnStack.length > 0 && braceDepth < fnStack[fnStack.length - 1].braceDepth) { fnStack.pop(); if (ss.length > 1) ss.pop(); }
        continue;
      }

      // Cmdlet call: Verb-Noun or plain function
      const cmdM = /^([\w][\w-]*)\s/.exec(tr);
      if (cmdM && !/^(?:if|else|elseif|while|for|foreach|switch|try|catch|finally|throw|return|function|param)\b/i.test(tr)) {
        // check for object method: $obj.Method()
        const methodM = /^\$(\w+)\.(\w+)\s*\(/.exec(tr);
        if (methodM) {
          const st = es('call', ln, f.pid, d, { callee: methodM[2], receiver: `$${methodM[1]}`, text: tr.slice(0, 120) });
          ec(st.temp_id, methodM[2], `$${methodM[1]}`, ln, 'method');
        } else {
          const st = es('call', ln, f.pid, d, { callee: cmdM[1], text: tr.slice(0, 120) });
          ec(st.temp_id, cmdM[1], undefined, ln, 'function');
        }
      }

      braceDepth += openB - closeB;
      while (fs.length > 1 && braceDepth < fs[fs.length - 1].braceDepthAtOpen) { fs.pop(); }
      while (fnStack.length > 0 && braceDepth < fnStack[fnStack.length - 1].braceDepth) { fnStack.pop(); if (ss.length > 1) ss.pop(); }
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
}

export const powershellParser = new PowerShellParser();
