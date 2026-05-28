/**
 * MODUL: Ruby Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Ruby-Dateien
 *
 * EXTRAHIERT: class, module, def, attr_*, require, include/extend,
 *             constant, comment, todo
 * ANSATZ: Regex-basiert — Ruby hat klare Keyword-basierte Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class RubyParser implements LanguageParser {
  language = 'ruby';
  extensions = ['.rb', '.rake', '.gemspec'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. require / require_relative
    // ══════════════════════════════════════════════
    const requireRe = /^(require(?:_relative)?)\s+['"]([^'"]+)['"]/gm;
    while ((m = requireRe.exec(content)) !== null) {
      const name = m[2].split('/').pop() || m[2];
      symbols.push({
        symbol_type: 'import',
        name,
        value: m[2],
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
    // 2. Modules
    // ══════════════════════════════════════════════
    const moduleRe = /^(\s*)module\s+(\w+(?:::\w+)*)/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1, m[1].length);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'module',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Classes
    // ══════════════════════════════════════════════
    const classRe = /^(\s*)class\s+(\w+(?:::\w+)*)(?:\s*<\s*(\w+(?:::\w+)*))?/gm;
    while ((m = classRe.exec(content)) !== null) {
      const name = m[2];
      const parent = m[3] || null;
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1, m[1].length);

      symbols.push({
        symbol_type: 'class',
        name,
        value: parent ? `< ${parent}` : undefined,
        params: parent ? [parent] : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `class ${name} < ${parent}`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methods (def)
    // ══════════════════════════════════════════════
    const defRe = /^(\s*)def\s+(self\.)?(\w+[?!=]?)(?:\(([^)]*)\))?/gm;
    while ((m = defRe.exec(content)) !== null) {
      const indent = m[1].length;
      const isSelf = !!m[2];
      const name = m[3];
      const paramsRaw = m[4] || '';
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1, indent);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/[=:]/)[0].replace(/[*&]/, '').trim())
        .filter(Boolean);

      const parentClass = this.findParentClass(lines, lineStart - 1, indent);

      symbols.push({
        symbol_type: 'function',
        name: isSelf ? `self.${name}` : name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !name.startsWith('_'),
        parent_id: parentClass,
      });
    }

    // ══════════════════════════════════════════════
    // 5. attr_accessor / attr_reader / attr_writer
    // ══════════════════════════════════════════════
    const attrRe = /^(\s*)(attr_(?:accessor|reader|writer))\s+(.+)/gm;
    while ((m = attrRe.exec(content)) !== null) {
      const kind = m[2];
      const attrs = m[3].split(',').map(s => s.trim().replace(/^:/, '')).filter(Boolean);
      const lineStart = lineAt(content, m.index);
      const parentClass = this.findParentClass(lines, lineStart - 1, m[1].length);

      for (const attr of attrs) {
        symbols.push({
          symbol_type: 'variable',
          name: attr,
          value: kind,
          line_start: lineStart,
          is_exported: true,
          parent_id: parentClass,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Constants (UPPERCASE)
    // ══════════════════════════════════════════════
    const constRe = /^(\s*)([A-Z][A-Z0-9_]+)\s*=\s*(.+)/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. include / extend / prepend
    // ══════════════════════════════════════════════
    const includeRe = /^\s*(include|extend|prepend)\s+(\w+(?:::\w+)*)/gm;
    while ((m = includeRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[2],
        line_number: lineAt(content, m.index),
        context: `${m[1]} ${m[2]}`,
      });
    }

    // ══════════════════════════════════════════════
    // 8. TODO / FIXME / HACK
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
    // 9. Block-Kommentare
    // ══════════════════════════════════════════════
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#') && !line.match(/^#\s*(TODO|FIXME|HACK)/i) && !line.startsWith('#!')) {
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
    // 10. Routes — Sinatra/Rails-style: get '/x' do, post '/x' do
    //     Auch Rails-Router: get '/x' => 'controller#action', match '/x', via: :get
    // ══════════════════════════════════════════════
    const sinatraRouteRe = /^\s*(get|post|put|patch|delete|head|options)\s+['"]([^'"]+)['"]/gm;
    while ((m = sinatraRouteRe.exec(content)) !== null) {
      const verb = m[1].toLowerCase();
      if (!HTTP_VERBS.has(verb)) continue;
      const rawPath = m[2];
      const routePath = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
      if (!isLikelyHttpPath(routePath)) continue;
      const line = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, routePath),
        value: routePath,
        params: [verb.toUpperCase()],
        line_start: line,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Routes — Rails: match '/x', via: [:get, :post]
    // ══════════════════════════════════════════════
    const railsMatchRe = /^\s*match\s+['"]([^'"]+)['"][^\n]*?via:\s*(?:\[([^\]]+)\]|:(\w+))/gm;
    while ((m = railsMatchRe.exec(content)) !== null) {
      const rawPath = m[1];
      const routePath = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
      if (!isLikelyHttpPath(routePath)) continue;
      const verbsRaw = m[2] || m[3] || '';
      const verbs = verbsRaw
        .split(',')
        .map(s => s.trim().replace(/^:/, '').toLowerCase())
        .filter(v => HTTP_VERBS.has(v));
      const line = lineAt(content, m.index);
      for (const verb of verbs.length ? verbs : ['get']) {
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName(verb, routePath),
          value: routePath,
          params: [verb.toUpperCase()],
          line_start: line,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 12. Routes — Rails: resources :name / resource :name
    //     Erzeugt Standard-CRUD-Routen
    // ══════════════════════════════════════════════
    const railsResourcesRe = /^\s*(resources|resource)\s+:(\w+)/gm;
    while ((m = railsResourcesRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const line = lineAt(content, m.index);
      const basePath = '/' + name;
      const crud: Array<[string, string]> = kind === 'resources'
        ? [['GET', basePath], ['POST', basePath], ['GET', `${basePath}/:id`], ['PATCH', `${basePath}/:id`], ['DELETE', `${basePath}/:id`]]
        : [['GET', basePath], ['POST', basePath], ['PATCH', basePath], ['DELETE', basePath]];
      for (const [method, p] of crud) {
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName(method, p),
          value: p,
          params: [method],
          line_start: line,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 13. Embedded SQL — ActiveRecord::Base.connection.execute('SELECT...'),
    //     find_by_sql('SELECT...'), connection.exec_query('...')
    // ══════════════════════════════════════════════
    const sqlExecRe = /\b(?:execute|exec_query|find_by_sql|exec)\s*\(\s*['"]((?:[^'"\\]|\\.){10,})['"]/g;
    while ((m = sqlExecRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (looksLikeSql(sqlText)) {
        const baseLine = lineAt(content, m.index);
        symbols.push(...parseEmbeddedSql(sqlText, filePath, baseLine));
      }
    }

    // ══════════════════════════════════════════════
    // FLOW: Statements + CallEdges
    // ══════════════════════════════════════════════
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let tempId = 0;
    const nextId = (): string => `s${tempId++}`;

    // Per-parent order counters (key: parent_temp_id or 'root' for top-level)
    const orderCounters = new Map<string, number>();
    function nextOrder(parentId: string | undefined): number {
      const key = parentId ?? 'root';
      const cur = orderCounters.get(key) ?? 0;
      orderCounters.set(key, cur + 1);
      return cur;
    }

    // Track current scope for function/method bodies
    interface RubyScope { type: string; name: string | null; }
    const scopeStack: RubyScope[] = [{ type: 'module', name: null }];
    const curScope = (): RubyScope => scopeStack[scopeStack.length - 1];

    function emitStmt(
      stmtType: string, lineStart: number, lineEnd: number | undefined,
      parentId: string | undefined, depth: number,
      extra: Partial<ParsedStatement> = {},
    ): ParsedStatement {
      const sc = curScope();
      const id = nextId();
      const st: ParsedStatement = {
        temp_id: id,
        parent_temp_id: parentId,
        scope_type: sc.type,
        scope_name: sc.name,
        statement_type: stmtType,
        line_start: lineStart,
        line_end: lineEnd,
        order_index: nextOrder(parentId),
        depth,
        is_top_level: sc.type === 'module' && depth === 0,
        is_awaited: false,
        ...extra,
      };
      statements.push(st);
      return st;
    }

    function emitCall(stmtId: string, calleeName: string, receiver: string | undefined, line: number, kind: string): void {
      callEdges.push({
        statement_temp_id: stmtId,
        caller_scope: curScope().name,
        callee_name: calleeName,
        callee_receiver: receiver,
        line_number: line,
        call_kind: kind,
      });
    }

    // Process lines for flow extraction
    // Strategy: scan each line, identify statement types, track depth via indent
    // For Ruby we use line-by-line scanning with indent tracking
    const flowLines = content.split('\n');

    // Stack of { parentId, depth } for block nesting
    interface BlockFrame { parentId: string | undefined; depth: number; indentLevel: number; }
    const blockStack: BlockFrame[] = [{ parentId: undefined, depth: 0, indentLevel: -1 }];
    const curBlock = (): BlockFrame => blockStack[blockStack.length - 1];

    // Track open method/function scopes so we set scopeStack correctly
    // We do a simplified approach: track def/end pairs by indent
    interface ScopeEntry { name: string; type: string; indent: number; }
    const defStack: ScopeEntry[] = [];

    // Method call pattern: receiver.method(args) or method(args) or method arg
    const callRe = /^(\s*)(?:(\w[\w.]*)\.)(\w+[?!]?)\s*(?:\(|$|\s+(?!do\b|{))/;
    const funcCallRe = /^(\s*)(\w[\w:]*[?!]?)\s*(?:\((?:[^)]*)\)|(?!\s*=))/;

    for (let i = 0; i < flowLines.length; i++) {
      const rawLine = flowLines[i];
      const trimmed = rawLine.trim();
      const lineNum = i + 1;
      if (!trimmed || trimmed.startsWith('#')) continue;

      const indent = rawLine.search(/\S/);

      // Pop block/scope stack when indent decreases past a frame
      while (blockStack.length > 1 && indent <= blockStack[blockStack.length - 1].indentLevel) {
        blockStack.pop();
      }

      // Pop def scope when we hit 'end' at matching indent
      if (/^end\b/.test(trimmed) && defStack.length > 0) {
        const top = defStack[defStack.length - 1];
        if (indent <= top.indent) {
          defStack.pop();
          scopeStack.pop();
        }
        continue;
      }

      const parent = curBlock();
      const depth = parent.depth;

      // def method_name
      const defMatch = /^def\s+(self\.)?(\w+[?!=]?)/.exec(trimmed);
      if (defMatch) {
        const name = (defMatch[1] ? 'self.' : '') + defMatch[2];
        const st = emitStmt('call', lineNum, undefined, parent.parentId, depth, { callee: name, text: trimmed.slice(0, 120) });
        defStack.push({ name, type: 'method', indent });
        scopeStack.push({ type: 'method', name });
        blockStack.push({ parentId: st.temp_id, depth: depth + 1, indentLevel: indent });
        continue;
      }

      // class / module
      const classMatch = /^(?:class|module)\s+(\w[\w:]*)/.exec(trimmed);
      if (classMatch) {
        emitStmt('expression', lineNum, undefined, parent.parentId, depth, { text: trimmed.slice(0, 120) });
        defStack.push({ name: classMatch[1], type: 'class', indent });
        scopeStack.push({ type: 'class', name: classMatch[1] });
        blockStack.push({ parentId: undefined, depth: depth + 1, indentLevel: indent });
        continue;
      }

      // if / unless / elsif
      const ifMatch = /^(if|unless|elsif)\s+(.+)/.exec(trimmed);
      if (ifMatch) {
        const st = emitStmt(ifMatch[1] === 'elsif' ? 'if' : ifMatch[1] === 'unless' ? 'if' : 'if',
          lineNum, undefined, parent.parentId, depth,
          { condition_text: ifMatch[2].slice(0, 200), text: trimmed.slice(0, 120) });
        blockStack.push({ parentId: st.temp_id, depth: depth + 1, indentLevel: indent });
        continue;
      }

      // while / until
      const whileMatch = /^(while|until)\s+(.+)/.exec(trimmed);
      if (whileMatch) {
        const st = emitStmt('while', lineNum, undefined, parent.parentId, depth,
          { condition_text: whileMatch[2].slice(0, 200), text: trimmed.slice(0, 120) });
        blockStack.push({ parentId: st.temp_id, depth: depth + 1, indentLevel: indent });
        continue;
      }

      // for x in y
      const forMatch = /^for\s+\w+\s+in\s+(.+)/.exec(trimmed);
      if (forMatch) {
        const st = emitStmt('for', lineNum, undefined, parent.parentId, depth,
          { condition_text: forMatch[1].slice(0, 200), text: trimmed.slice(0, 120) });
        blockStack.push({ parentId: st.temp_id, depth: depth + 1, indentLevel: indent });
        continue;
      }

      // case
      if (/^case\b/.test(trimmed)) {
        const st = emitStmt('switch', lineNum, undefined, parent.parentId, depth, { text: trimmed.slice(0, 120) });
        blockStack.push({ parentId: st.temp_id, depth: depth + 1, indentLevel: indent });
        continue;
      }

      // when (like else-branch in switch)
      if (/^when\b/.test(trimmed)) continue; // handled by parent case block

      // begin / rescue / ensure
      if (/^begin\b/.test(trimmed)) {
        const st = emitStmt('try', lineNum, undefined, parent.parentId, depth, { text: trimmed.slice(0, 120) });
        blockStack.push({ parentId: st.temp_id, depth: depth + 1, indentLevel: indent });
        continue;
      }
      if (/^rescue\b|^ensure\b/.test(trimmed)) continue; // sub-blocks of try

      // return
      if (/^return\b/.test(trimmed)) {
        emitStmt('return', lineNum, undefined, parent.parentId, depth, { text: trimmed.slice(0, 120) });
        continue;
      }

      // raise / throw
      if (/^raise\b|^throw\b/.test(trimmed)) {
        emitStmt('throw', lineNum, undefined, parent.parentId, depth, { text: trimmed.slice(0, 120) });
        continue;
      }

      // require / require_relative
      if (/^require(?:_relative)?\s/.test(trimmed)) {
        const nm = /^require(?:_relative)?\s+['"]([^'"]+)['"]/.exec(trimmed);
        const st = emitStmt('call', lineNum, undefined, parent.parentId, depth,
          { callee: 'require', text: trimmed.slice(0, 120) });
        if (nm) emitCall(st.temp_id, 'require', undefined, lineNum, 'function');
        continue;
      }

      // include / extend / prepend
      if (/^(?:include|extend|prepend)\s+\w/.test(trimmed)) {
        const nm = /^(include|extend|prepend)\s+(\w[\w:]*)/.exec(trimmed);
        if (nm) {
          const st = emitStmt('call', lineNum, undefined, parent.parentId, depth,
            { callee: nm[1], text: trimmed.slice(0, 120) });
          emitCall(st.temp_id, nm[1], undefined, lineNum, 'function');
        }
        continue;
      }

      // Assignment: x = expr or @x = expr
      const assignMatch = /^([@$]?\w+(?:\.\w+)?)\s*(?:\|\|=|&&=|[+\-*\/]?=)(?!=)\s*(.+)/.exec(trimmed);
      if (assignMatch && !/^(if|unless|while|until|for|case|begin|def|class|module|end|return|raise|throw|require|include|extend|prepend)\b/.test(trimmed)) {
        const rhs = assignMatch[2];
        const callMatch2 = /(\w+)\s*\(/.exec(rhs);
        const st = emitStmt('assignment', lineNum, undefined, parent.parentId, depth,
          { assigned_to: assignMatch[1].slice(0, 120), text: trimmed.slice(0, 120) });
        if (callMatch2) emitCall(st.temp_id, callMatch2[1], undefined, lineNum, 'function');
        continue;
      }

      // Method call: receiver.method or standalone method call
      const methodMatch = /^(\w[\w.]*?)\.(\w+[?!]?)\s*(?:\(|$|\s)/.exec(trimmed);
      if (methodMatch) {
        const st = emitStmt('call', lineNum, undefined, parent.parentId, depth,
          { callee: methodMatch[2], receiver: methodMatch[1], text: trimmed.slice(0, 120) });
        emitCall(st.temp_id, methodMatch[2], methodMatch[1], lineNum, 'method');
        continue;
      }

      // Standalone function call
      const plainCallMatch = /^(\w[\w:]*[?!]?)\s*(?:\(|(?![\s]*=))/.exec(trimmed);
      if (plainCallMatch && !/^(else|elsif|end|when|rescue|ensure|then|do)\b/.test(trimmed)) {
        const st = emitStmt('call', lineNum, undefined, parent.parentId, depth,
          { callee: plainCallMatch[1], text: trimmed.slice(0, 120) });
        emitCall(st.temp_id, plainCallMatch[1], undefined, lineNum, 'function');
        continue;
      }
    }

    return { symbols, references, statements, callEdges };
  }

  /** Findet das passende 'end' fuer einen Block */
  private findEnd(lines: string[], startIdx: number, startIndent: number): number {
    let depth = 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      if (/^(class|module|def|do|if|unless|case|while|until|for|begin)\b/.test(line)) depth++;
      if (/^end\b/.test(line)) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return lines.length;
  }

  private findParentClass(lines: string[], lineIdx: number, indent: number): string | undefined {
    for (let i = lineIdx - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const lineIndent = line.search(/\S/);
      if (lineIndent < indent) {
        const classMatch = line.match(/(?:class|module)\s+(\w+(?:::\w+)*)/);
        if (classMatch) return classMatch[1];
        break;
      }
    }
    return undefined;
  }
}

export const rubyParser = new RubyParser();
