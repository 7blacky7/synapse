/**
 * MODUL: Perl Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Perl-Dateien (.pl, .pm)
 *
 * EXTRAHIERT: package, sub, use/require, my/our/local variables,
 *             BEGIN/END/INIT blocks, Moose/Moo attributes (has),
 *             extends/with (roles), constant, POD comments, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';
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

class PerlParser implements LanguageParser {
  language = 'perl';
  extensions = ['.pl', '.pm', '.t'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package declarations
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+([\w:]+)\s*;/gm;
    while ((m = pkgRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'package',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Use / Require
    // ══════════════════════════════════════════════
    const useRe = /^(use|require)\s+([\w:]+)(?:\s+([^;]+))?;/gm;
    while ((m = useRe.exec(content)) !== null) {
      const kind = m[1];
      const module = m[2];
      const args = m[3] ? m[3].trim() : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip pragmas for symbol creation but still create reference
      const isPragma = ['strict', 'warnings', 'utf8', 'v5', 'feature',
                        'constant', 'lib', 'Carp', 'Data::Dumper'].includes(module);

      if (!isPragma || kind === 'require') {
        symbols.push({
          symbol_type: 'import',
          name: module.split('::').pop() || module,
          value: args ? `${kind} ${module} ${args}` : `${kind} ${module}`,
          line_start: lineStart,
          is_exported: false,
        });
      }

      references.push({
        symbol_name: module.split('::').pop() || module,
        line_number: lineStart,
        context: m[0].trim().slice(0, 80),
      });

      // use constant { NAME => value }
      if (module === 'constant') {
        const constRe = /(\w+)\s*=>/g;
        let cm: RegExpExecArray | null;
        const constStr = args || '';
        while ((cm = constRe.exec(constStr)) !== null) {
          symbols.push({
            symbol_type: 'const_object',
            name: cm[1],
            value: 'constant',
            line_start: lineStart,
            is_exported: true,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. Subroutines (sub)
    // ══════════════════════════════════════════════
    const subRe = /^(\s*)sub\s+(\w+)(?:\s*\(([^)]*)\))?\s*\{/gm;
    while ((m = subRe.exec(content)) !== null) {
      const indent = m[1].length;
      const name = m[2];
      const prototype = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const parentPkg = this.findParentPackage(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name,
        params: prototype !== undefined ? [prototype] : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
        parent_id: parentPkg,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Method modifiers (before/after/around — Moose)
    // ══════════════════════════════════════════════
    const modifierRe = /^(\s*)(before|after|around)\s+['"](\w+)['"]\s*=>/gm;
    while ((m = modifierRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: `${m[2]} ${m[3]}`,
        value: m[2],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
      references.push({
        symbol_name: m[3],
        line_number: lineAt(content, m.index),
        context: `${m[2]} '${m[3]}' => ...`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Moose/Moo attributes (has)
    // ══════════════════════════════════════════════
    const hasRe = /^(\s*)has\s+['"](\w+)['"]\s*=>\s*\(([^)]*)\)/gm;
    while ((m = hasRe.exec(content)) !== null) {
      const name = m[2];
      const attrs = m[3];
      const lineStart = lineAt(content, m.index);

      // Extract isa
      const isaMatch = attrs.match(/isa\s*=>\s*['"](\w+)['"]/);
      const isReq = /is\s*=>\s*['"](?:rw|ro|bare)['"]/.test(attrs);

      symbols.push({
        symbol_type: 'variable',
        name,
        value: isaMatch ? isaMatch[1] : 'attribute',
        return_type: isaMatch ? isaMatch[1] : undefined,
        line_start: lineStart,
        is_exported: isReq,
      });

      if (isaMatch) {
        references.push({
          symbol_name: isaMatch[1],
          line_number: lineStart,
          context: `has '${name}' => (isa => '${isaMatch[1]}')`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Extends / With (inheritance / roles)
    // ══════════════════════════════════════════════
    const extendsRe = /^(\s*)(extends|with)\s+['"]([^'"]+)['"]/gm;
    while ((m = extendsRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      references.push({
        symbol_name: m[3].split('::').pop() || m[3],
        line_number: lineStart,
        context: `${m[2]} '${m[3]}'`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 7. Our / My / Local declarations (top-level only)
    // ══════════════════════════════════════════════
    const varDeclRe = /^(our|my|local)\s+(\$[\w:]+(?:\s*,\s*\$[\w:]+)*)\s*(?:=\s*(.+))?;/gm;
    while ((m = varDeclRe.exec(content)) !== null) {
      const scope = m[1];
      const vars = m[2].split(',').map(v => v.trim());
      const value = m[3] ? m[3].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      for (const v of vars) {
        symbols.push({
          symbol_type: 'variable',
          name: v.replace(/^\$/, ''),
          value: value || scope,
          line_start: lineStart,
          is_exported: scope === 'our',
        });
      }
    }

    // Our arrays and hashes
    const ourArrRe = /^our\s+(@|%)(\w+)/gm;
    while ((m = ourArrRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `${m[1]}${m[2]}`,
        value: m[1] === '@' ? 'array' : 'hash',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. BEGIN / END / INIT blocks
    // ══════════════════════════════════════════════
    const blockRe = /^(BEGIN|END|INIT|CHECK|UNITCHECK)\s*\{/gm;
    while ((m = blockRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'block',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 9. @EXPORT / @EXPORT_OK
    // ══════════════════════════════════════════════
    const exportRe = /our\s+@(EXPORT(?:_OK)?)\s*=\s*qw\(([^)]*)\)/gm;
    while ((m = exportRe.exec(content)) !== null) {
      const exportType = m[1];
      const exports = m[2].trim().split(/\s+/).filter(Boolean);
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'export',
        name: `@${exportType}`,
        value: exports.join(', ').slice(0, 200),
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
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

    // ══════════════════════════════════════════════
    // 11. POD documentation (=head1 ... =cut)
    // ══════════════════════════════════════════════
    const podRe = /^=head[12]\s+(.+)[\s\S]*?(?=^=cut|^=head|$(?![\s\S]))/gm;
    while ((m = podRe.exec(content)) !== null) {
      const title = m[1].trim();
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: title.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 12. Routes — Mojolicious ($r->get/post/...)
    // ══════════════════════════════════════════════
    const mojoRouteRe = /\$\w+\s*->\s*(get|post|put|patch|delete|head|options|any)\s*\(\s*['"]([^'"]+)['"]/g;
    while ((m = mojoRouteRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      const path = m[2];
      if (!isLikelyHttpPath(path)) continue;
      if (verb !== 'any' && !HTTP_VERBS.has(verb)) continue;
      const method = verb === 'any' ? 'ANY' : verb.toUpperCase();
      const lineStart = lineAt(content, m.index);
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
    // 13. Routes — Dancer (get '/x' => sub {...})
    // ══════════════════════════════════════════════
    const dancerRouteRe = /^\s*(get|post|put|patch|delete|head|options)\s+['"]([^'"]+)['"]\s*=>\s*sub\b/gm;
    while ((m = dancerRouteRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      const path = m[2];
      if (!isLikelyHttpPath(path)) continue;
      if (!HTTP_VERBS.has(verb)) continue;
      const method = verb.toUpperCase();
      const lineStart = lineAt(content, m.index);
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
    // 14. Embedded SQL — DBI ($dbh->prepare/do/...)
    // ══════════════════════════════════════════════
    const dbiSqlRe = /\$\w+\s*->\s*(?:prepare|do|selectrow_array|selectrow_arrayref|selectrow_hashref|selectall_arrayref|selectall_hashref|select|execute_array)\s*\(\s*["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = dbiSqlRe.exec(content)) !== null) {
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
    const norder = (p: string | undefined): number => { const k = p ?? 'root'; const v = oc.get(k) ?? 0; oc.set(k, v + 1); return v; };

    interface PS { type: string; name: string | null; }
    const ss: PS[] = [{ type: 'module', name: null }];
    const cs = (): PS => ss[ss.length - 1];

    function es(st: string, line: number, pid: string | undefined, depth: number, extra: Partial<ParsedStatement> = {}): ParsedStatement {
      const sc = cs();
      const id = nid();
      const s: ParsedStatement = { temp_id: id, parent_temp_id: pid, scope_type: sc.type, scope_name: sc.name, statement_type: st, line_start: line, order_index: norder(pid), depth, is_top_level: sc.type === 'module' && depth === 0, is_awaited: false, ...extra };
      statements.push(s); return s;
    }
    function ec(sid: string, callee: string, recv: string | undefined, line: number, kind: string): void {
      callEdges.push({ statement_temp_id: sid, caller_scope: cs().name, callee_name: callee, callee_receiver: recv, line_number: line, call_kind: kind });
    }

    const plines = content.split('\n');
    interface PF { pid: string | undefined; depth: number; indentLevel: number; }
    const fs: PF[] = [{ pid: undefined, depth: 0, indentLevel: -1 }];
    const tf = (): PF => fs[fs.length - 1];

    // Track sub scopes
    interface SubEntry { name: string; indent: number; }
    const subStack: SubEntry[] = [];

    for (let i = 0; i < plines.length; i++) {
      const raw = plines[i];
      const tr = raw.trim();
      const ln = i + 1;
      if (!tr || tr.startsWith('#')) continue;
      const indent = raw.search(/\S/);

      // pop block frames
      while (fs.length > 1 && indent <= fs[fs.length - 1].indentLevel) fs.pop();
      // pop sub scopes when closing brace at matching indent
      if (tr === '}' && subStack.length > 0 && indent <= subStack[subStack.length - 1].indent) {
        subStack.pop(); ss.pop(); continue;
      }

      const f = tf();
      const d = f.depth;

      // sub declaration
      const subM = /^sub\s+(\w+)/.exec(tr);
      if (subM) {
        const st = es('call', ln, f.pid, d, { callee: subM[1], text: tr.slice(0, 120) });
        subStack.push({ name: subM[1], indent });
        ss.push({ type: 'function', name: subM[1] });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // if / elsif / unless
      const ifM = /^(?:if|elsif|unless)\s*\((.{1,200})\)/.exec(tr);
      if (ifM) {
        const st = es('if', ln, f.pid, d, { condition_text: ifM[1].slice(0, 200), text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // while / until
      const whM = /^(?:while|until)\s*\((.{1,200})\)/.exec(tr);
      if (whM) {
        const st = es('while', ln, f.pid, d, { condition_text: whM[1].slice(0, 200), text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // for / foreach
      const forM = /^(?:for|foreach)\s/.exec(tr);
      if (forM) {
        const st = es('for', ln, f.pid, d, { text: tr.slice(0, 120) });
        fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent });
        continue;
      }

      // return
      if (/^return\b/.test(tr)) { es('return', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }
      // die / croak (throw-like)
      if (/^(?:die|croak|confess)\b/.test(tr)) { es('throw', ln, f.pid, d, { text: tr.slice(0, 120) }); continue; }
      // eval (try-like)
      if (/^eval\s*\{/.test(tr)) { const st = es('try', ln, f.pid, d, { text: tr.slice(0, 120) }); fs.push({ pid: st.temp_id, depth: d + 1, indentLevel: indent }); continue; }

      // require / use
      if (/^(?:use|require)\s/.test(tr)) {
        const rm = /^(?:use|require)\s+([\w:]+)/.exec(tr);
        if (rm) { const st = es('call', ln, f.pid, d, { callee: rm[0].startsWith('use') ? 'use' : 'require', text: tr.slice(0, 120) }); ec(st.temp_id, rm[0].startsWith('use') ? 'use' : 'require', undefined, ln, 'function'); }
        continue;
      }

      // my/our/local assignment
      const varM = /^(?:my|our|local)\s+[\$@%](\w+)\s*=\s*(.+)/.exec(tr);
      if (varM) {
        const callM = /(\w+)\s*\(/.exec(varM[2]);
        const st = es('variable', ln, f.pid, d, { assigned_to: varM[1], text: tr.slice(0, 120) });
        if (callM) ec(st.temp_id, callM[1], undefined, ln, 'function');
        continue;
      }

      // assignment $var = expr
      const assignM = /^[\$@%](\w+(?:\[.*?\]|\{.*?\})?)\s*(?:[.+\-*]?=)(?!=)\s*(.+)/.exec(tr);
      if (assignM) {
        const callM = /(\w+)\s*\(/.exec(assignM[2]);
        const st = es('assignment', ln, f.pid, d, { assigned_to: assignM[1], text: tr.slice(0, 120) });
        if (callM) ec(st.temp_id, callM[1], undefined, ln, 'function');
        continue;
      }

      // method call: $obj->method() or Module::func()
      const mCallM = /^(?:\$(\w+)->|(\w+)::)?(\w+)\s*\(/.exec(tr);
      if (mCallM && !/^(?:if|elsif|unless|while|until|for|foreach|sub|my|our|local|return|die|eval)\b/.test(tr)) {
        const recv = mCallM[1] || mCallM[2];
        const callee = mCallM[3];
        const st = es('call', ln, f.pid, d, { callee, receiver: recv, text: tr.slice(0, 120) });
        ec(st.temp_id, callee, recv, ln, recv ? 'method' : 'function');
        continue;
      }

      // print / say
      if (/^(?:print|say|warn)\b/.test(tr)) {
        const st = es('call', ln, f.pid, d, { callee: /^print/.test(tr) ? 'print' : /^say/.test(tr) ? 'say' : 'warn', text: tr.slice(0, 120) });
        ec(st.temp_id, st.callee!, undefined, ln, 'function');
        continue;
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

  private findParentPackage(content: string, pos: number): string | undefined {
    const before = content.substring(0, pos);
    const pkgMatch = before.match(/package\s+([\w:]+)\s*;[^;]*$/);
    return pkgMatch ? pkgMatch[1] : undefined;
  }
}

export const perlParser = new PerlParser();
