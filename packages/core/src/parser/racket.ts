/**
 * MODUL: Racket Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Racket-Dateien (.rkt)
 *
 * EXTRAHIERT: #lang, require/provide, define, define-struct/struct,
 *             define-syntax, define/contract, class/interface, module,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath } from './patterns/http.js';
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

class RacketParser implements LanguageParser {
  language = 'racket';
  extensions = ['.rkt', '.rktl', '.scrbl'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // 1. #lang
    const langRe = /^#lang\s+(\S+)/m;
    m = langRe.exec(content);
    if (m) {
      symbols.push({ symbol_type: 'variable', name: '#lang', value: m[1], line_start: lineAt(content, m.index), is_exported: true });
    }

    // 2. Require
    const reqRe = /\(require\s+([^\n)]+)/g;
    while ((m = reqRe.exec(content)) !== null) {
      const mods = m[1].trim().split(/\s+/).filter(s => !s.startsWith('(') && !s.startsWith(')'));
      for (const mod of mods.slice(0, 5)) {
        symbols.push({ symbol_type: 'import', name: mod.replace(/['"]/g, ''), value: mod, line_start: lineAt(content, m.index), is_exported: false });
      }
    }

    // 3. Provide
    const provRe = /\(provide\s+([^\n)]+)/g;
    while ((m = provRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'export', name: 'provide', value: m[1].trim().slice(0, 200), line_start: lineAt(content, m.index), is_exported: true });
    }

    // 4. Define (functions + values)
    const defRe = /^\(define\s+\((\w[!\w?*+-]*)\s*([^)]*)\)/gm;
    while ((m = defRe.exec(content)) !== null) {
      const params = m[2].split(/\s+/).filter(Boolean);
      symbols.push({ symbol_type: 'function', name: m[1], params: params.length > 0 ? params : undefined, line_start: lineAt(content, m.index), is_exported: true });
    }

    const defValRe = /^\(define\s+(\w[!\w?*+-]*)\s+/gm;
    while ((m = defValRe.exec(content)) !== null) {
      if (symbols.some(s => s.name === m![1] && s.symbol_type === 'function')) continue;
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'define', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 5. Struct
    const structRe = /\((?:define-)?struct\s+(\w+)\s*(?:\(([^)]*)\))?/g;
    while ((m = structRe.exec(content)) !== null) {
      const fields = m[2] ? m[2].split(/\s+/).filter(Boolean) : undefined;
      symbols.push({ symbol_type: 'class', name: m[1], value: 'struct', params: fields, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 6. Define-syntax / define-syntax-rule
    const syntaxRe = /\(define-syntax(?:-rule)?\s+(\w[!\w?*+-]*)/g;
    while ((m = syntaxRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'syntax', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 7. Define/contract
    const contractRe = /\(define\/contract\s+\((\w[!\w?*+-]*)/g;
    while ((m = contractRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'contract', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 8. Class
    const classRe = /\(define\s+(\w+%?)\s*\(class\/?\s*(\w+%?)?/g;
    while ((m = classRe.exec(content)) !== null) {
      if (symbols.some(s => s.name === m![1])) continue;
      symbols.push({ symbol_type: 'class', name: m[1], value: 'class', params: m[2] ? [m[2]] : undefined, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 9. Module
    const modRe = /\(module[+*]?\s+(\w+)/g;
    while ((m = modRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'module', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 10. Interface
    const ifaceRe = /\(define\s+(\w+<%>?)\s*\(interface/g;
    while ((m = ifaceRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'interface', name: m[1], value: 'interface', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 11. TODO / FIXME
    const todoRe = /;\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'todo', name: null, value: m[0].trim(), line_start: lineAt(content, m.index), is_exported: false });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // 12. Routes: web-server dispatch-rules
    const dispatchRe = /\[\s*\(\s*["']([^"']+)["']\s*\)\s+(\S+)/g;
    while ((m = dispatchRe.exec(content)) !== null) {
      const component = m[1];
      const handler = m[2].replace(/[)\]]+$/, '');
      if (component.includes('/')) continue;
      const path = '/' + component;
      if (!isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName('ANY', path),
        value: handler,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // 13. Embedded SQL via db package
    const sqlRe = /\(\s*query-(?:rows|exec|list|value|maybe-value|maybe-row|row)\s+\S+\s+["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = sqlRe.exec(content)) !== null) {
      const sql = m[1];
      if (!looksLikeSql(sql)) continue;
      const line = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sql, filePath, line));
    }

    // ══════════════════════════════════════════════
    // Flow extraction: top-level defines + call edges
    // ══════════════════════════════════════════════
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let tempIdCounter = 0;
    const nextId = () => `s${tempIdCounter++}`;
    let orderIndex = 0;

    // Function defines: (define (name args...) body)
    const defFuncRe = /^\(define\s+\((\w[!\w?*+-]*)\s*([^)]*)\)\s*([\s\S]*?)(?=^\(define|\z)/gm;
    const emitted = new Set<string>();
    while ((m = defFuncRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[3] || '';
      if (emitted.has(name)) continue;
      emitted.add(name);
      const lineStart = lineAt(content, m.index);
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: 'module',
        scope_name: null,
        statement_type: 'function',
        node_kind: 'define',
        line_start: lineStart,
        order_index: orderIndex++,
        depth: 0,
        is_top_level: true,
        is_awaited: false,
        callee: name,
        text: `(define (${name} ...) ...)`.slice(0, 240),
      });

      // Extract calls in body: (callee ...)
      const callRe = /\(([a-z][a-z0-9*+!?/<>=-]*)\s/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(body)) !== null) {
        const callee = cm[1];
        if (['if', 'cond', 'let', 'let*', 'letrec', 'begin', 'and', 'or', 'not', 'when', 'unless', 'lambda', 'define', 'case', 'do'].includes(callee)) continue;
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: name,
          callee_name: callee,
          line_number: lineStart,
          call_kind: 'function',
          confidence: 0.8,
        });
      }
    }

    // Value defines: (define name expr)
    const defValFlowRe = /^\(define\s+(\w[!\w?*+-]*)\s+/gm;
    while ((m = defValFlowRe.exec(content)) !== null) {
      const name = m[1];
      if (emitted.has(name)) continue;
      emitted.add(name);
      const lineStart = lineAt(content, m.index);
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: 'module',
        scope_name: null,
        statement_type: 'variable',
        node_kind: 'define-value',
        line_start: lineStart,
        order_index: orderIndex++,
        depth: 0,
        is_top_level: true,
        is_awaited: false,
        assigned_to: name,
        text: m[0].trim().slice(0, 240),
      });
    }

    return { symbols, references, statements, callEdges };
  }
}

export const racketParser = new RacketParser();
