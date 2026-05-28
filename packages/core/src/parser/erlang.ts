/**
 * MODUL: Erlang Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Erlang-Dateien (.erl, .hrl)
 *
 * EXTRAHIERT: -module, -export, -import, -include, -define, -record,
 *             -type/-opaque/-spec, -behaviour/-callback, function clauses,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { formatRouteName, isLikelyHttpPath } from './patterns/http.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ErlangParser implements LanguageParser {
  language = 'erlang';
  extensions = ['.erl', '.hrl'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^-module\((\w+)\)\./m;
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
    // 2. Export
    // ══════════════════════════════════════════════
    const exportRe = /^-export\(\[([^\]]*)\]\)\./gm;
    while ((m = exportRe.exec(content)) !== null) {
      const exports = m[1].split(',').map(e => e.trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'export',
        name: 'export',
        value: exports.join(', ').slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Export type
    const exportTypeRe = /^-export_type\(\[([^\]]*)\]\)\./gm;
    while ((m = exportTypeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: 'export_type',
        value: m[1].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Import
    // ══════════════════════════════════════════════
    const importRe = /^-import\((\w+),\s*\[([^\]]*)\]\)\./gm;
    while ((m = importRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: m[2].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `-import(${m[1]}, [...])`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Include
    // ══════════════════════════════════════════════
    const includeRe = /^-include(?:_lib)?\("([^"]+)"\)\./gm;
    while ((m = includeRe.exec(content)) !== null) {
      const file = m[1];
      const name = file.split('/').pop()?.replace('.hrl', '') || file;
      symbols.push({
        symbol_type: 'import',
        name,
        value: file,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Define (macros)
    // ══════════════════════════════════════════════
    const defineRe = /^-define\((\w+)(?:\(([^)]*)\))?\s*,\s*([^)]+)\)\./gm;
    while ((m = defineRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2] ? m[2].split(',').map(p => p.trim()).filter(Boolean) : undefined;
      const value = m[3].trim().slice(0, 200);

      symbols.push({
        symbol_type: params ? 'function' : 'variable',
        name,
        value: params ? 'define' : value,
        params,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Record
    // ══════════════════════════════════════════════
    const recordRe = /^-record\((\w+),\s*\{([^}]*)\}\)\./gm;
    while ((m = recordRe.exec(content)) !== null) {
      const name = m[1];
      const fieldsRaw = m[2];
      const lineStart = lineAt(content, m.index);

      const fields = fieldsRaw
        .split(',')
        .map(f => f.trim().split(/\s*[=:]/)[0].trim())
        .filter(Boolean);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'record',
        params: fields.length > 0 ? fields : undefined,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Type / Opaque
    // ══════════════════════════════════════════════
    const typeRe = /^-(type|opaque)\s+(\w+)\(([^)]*)\)\s*::\s*(.+)\./gm;
    while ((m = typeRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const params = m[3] ? m[3].split(',').map(p => p.trim()).filter(Boolean) : undefined;
      const typeDef = m[4].trim().slice(0, 200);

      symbols.push({
        symbol_type: 'interface',
        name,
        value: `${kind} :: ${typeDef}`,
        params,
        line_start: lineAt(content, m.index),
        is_exported: kind !== 'opaque',
      });
    }

    // ══════════════════════════════════════════════
    // 8. Spec
    // ══════════════════════════════════════════════
    const specRe = /^-spec\s+(\w+)\(([^)]*)\)\s*->\s*(.+)\./gm;
    while ((m = specRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `-spec ${m[1]}(${m[2]}) -> ${m[3]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. Behaviour / Callback
    // ══════════════════════════════════════════════
    const behaviourRe = /^-behaviou?r\((\w+)\)\./gm;
    while ((m = behaviourRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `-behaviour(${m[1]})`.slice(0, 80),
      });
    }

    const callbackRe = /^-callback\s+(\w+)\(([^)]*)\)\s*->\s*(.+)\./gm;
    while ((m = callbackRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'callback',
        return_type: m[3].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Function definitions
    // ══════════════════════════════════════════════
    const funcRe = /^(\w+)\(([^)]*)\)\s*(?:when\s+[^-]+)?\s*->/gm;
    const seenFunctions = new Set<string>();
    while ((m = funcRe.exec(content)) !== null) {
      const name = m[1];
      const argsRaw = m[2];
      const lineStart = lineAt(content, m.index);

      // Skip if already seen (multiple clauses)
      if (seenFunctions.has(name)) continue;
      seenFunctions.add(name);

      // Skip common patterns that aren't function definitions
      if (name.startsWith('-') || name === 'case' || name === 'if'
          || name === 'receive' || name === 'try' || name === 'fun') continue;

      const params = argsRaw
        .split(',')
        .map(p => p.trim().split('=')[0].trim())
        .filter(p => p && !p.startsWith('{') && !p.startsWith('[') && !p.startsWith('#'));

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /%+\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 12. EDoc comments (%% @doc ...)
    // ══════════════════════════════════════════════
    const docRe = /((?:%%[^\n]*\n)+)/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/%%\s?/g, '').trim();
      if (text.length < 5) continue;
      if (/^(TODO|FIXME|HACK)/i.test(text)) continue;
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
    // 13. cowboy_router routes
    // ══════════════════════════════════════════════
    const cowboyRouteRe = /\{\s*["']([^"']+)["']\s*,\s*\w+_handler\s*,/g;
    while ((m = cowboyRouteRe.exec(content)) !== null) {
      const path = m[1];
      if (!isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName('ANY', path),
        value: path,
        params: ['ANY'],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // Flow extraction: exported function clauses + call edges
    // ══════════════════════════════════════════════
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let tempIdCounter = 0;
    const nextId = () => `s${tempIdCounter++}`;
    let orderIndex = 0;

    // Determine exported functions from -export([...]).
    const exportedFns = new Set<string>();
    const expRe = /^-export\(\[([^\]]*)\]\)\./gm;
    while ((m = expRe.exec(content)) !== null) {
      for (const entry of m[1].split(',')) {
        const fn = entry.trim().split('/')[0];
        if (fn) exportedFns.add(fn);
      }
    }

    // Function clauses: name(args) [when ...] ->
    const funcFlowRe = /^(\w+)\(([^)]*)\)\s*(?:when\s+[^-]+)?\s*->\s*([^\n.]*(?:\n(?!\w+\().*)*)/gm;
    const seenFns = new Set<string>();
    while ((m = funcFlowRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[3] || '';
      if (['case', 'if', 'receive', 'try', 'fun'].includes(name)) continue;
      if (name.startsWith('-')) continue;
      if (seenFns.has(name)) continue;
      seenFns.add(name);
      const lineStart = lineAt(content, m.index);
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: 'module',
        scope_name: null,
        statement_type: 'function',
        node_kind: 'FunctionClause',
        line_start: lineStart,
        order_index: orderIndex++,
        depth: 0,
        is_top_level: true,
        is_awaited: false,
        callee: name,
        text: `${name}(...) ->`.slice(0, 240),
      });

      // Extract calls: mod:func( or func(
      const remoteCallRe = /\b(\w+):(\w+)\s*\(/g;
      let rm: RegExpExecArray | null;
      while ((rm = remoteCallRe.exec(body)) !== null) {
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: name,
          callee_name: rm[2],
          callee_receiver: rm[1],
          line_number: lineStart,
          call_kind: 'method',
          confidence: 0.9,
        });
      }
      const localCallRe = /\b([a-z_]\w*)\s*\(/g;
      let lm: RegExpExecArray | null;
      while ((lm = localCallRe.exec(body)) !== null) {
        const callee = lm[1];
        if (['case', 'if', 'receive', 'try', 'fun', 'when', 'begin', 'end'].includes(callee)) continue;
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: name,
          callee_name: callee,
          line_number: lineStart,
          call_kind: 'function',
          confidence: 0.7,
        });
      }
    }

    return { symbols, references, statements, callEdges };
  }
}

export const erlangParser = new ErlangParser();
