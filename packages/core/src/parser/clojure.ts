/**
 * MODUL: Clojure Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Clojure-Dateien (.clj, .cljs, .cljc, .edn)
 *
 * EXTRAHIERT: ns (namespace), require, import, use, defn/defn-, def, defmacro,
 *             defprotocol, defrecord, deftype, defmulti/defmethod, defonce,
 *             defstruct, declare, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ClojureParser implements LanguageParser {
  language = 'clojure';
  extensions = ['.clj', '.cljs', '.cljc', '.edn'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Namespace (ns)
    // ══════════════════════════════════════════════
    const nsRe = /\(ns\s+([\w.-]+)/m;
    m = nsRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'ns',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Require / Use / Import (inside ns or standalone)
    // ══════════════════════════════════════════════
    const requireRe = /\(:?(?:require|use)\s+([\s\S]*?)(?=\(:|\)$)/gm;
    while ((m = requireRe.exec(content)) !== null) {
      const block = m[1];
      // Extract namespace references [ns.name :as alias]
      const nsRefRe = /\[?([\w.-]+)(?:\s+:as\s+(\w+))?\]?/g;
      let rm: RegExpExecArray | null;
      while ((rm = nsRefRe.exec(block)) !== null) {
        const ns = rm[1];
        if (ns === ':as' || ns === ':refer' || ns === ':only' || ns === ':rename') continue;
        const alias = rm[2] || ns.split('.').pop() || ns;

        symbols.push({
          symbol_type: 'import',
          name: alias,
          value: ns,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
        references.push({
          symbol_name: alias,
          line_number: lineAt(content, m.index),
          context: `require ${ns}${rm[2] ? ' :as ' + rm[2] : ''}`.slice(0, 80),
        });
      }
    }

    // Standalone require
    const reqStandaloneRe = /^\(require\s+'([\w.-]+)\)/gm;
    while ((m = reqStandaloneRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1].split('.').pop() || m[1],
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // Import (Java classes)
    const importRe = /\(:?import\s+([\s\S]*?)(?=\(:|\)$)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const block = m[1];
      const classRe = /\(?([\w.]+)\s+([\w\s]+)\)?/g;
      let im: RegExpExecArray | null;
      while ((im = classRe.exec(block)) !== null) {
        const pkg = im[1];
        const classes = im[2].trim().split(/\s+/).filter(Boolean);
        for (const cls of classes) {
          symbols.push({
            symbol_type: 'import',
            name: cls,
            value: `${pkg}.${cls}`,
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. defn / defn- (functions)
    // ══════════════════════════════════════════════
    const defnRe = /^\(defn-?\s+([\w*+!?<>=-]+)(?:\s+"([^"]*)")?\s*\[([^\]]*)\]/gm;
    while ((m = defnRe.exec(content)) !== null) {
      const name = m[1];
      const doc = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);
      const isPrivate = content.substring(m.index, m.index + 7).includes('defn-');

      const params = paramsRaw
        .split(/\s+/)
        .filter(p => p && p !== '&' && !p.startsWith('{'))
        .map(p => p.replace(/^[&]/, ''));

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: !isPrivate,
      });

      if (doc) {
        symbols.push({
          symbol_type: 'comment',
          name: null,
          value: doc.slice(0, 500),
          line_start: lineStart,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. def / defonce (variables)
    // ══════════════════════════════════════════════
    const defRe = /^\(def(?:once)?\s+([\^:]*\s*)?([\w*+!?<>=-]+)(?:\s+"([^"]*)")?/gm;
    while ((m = defRe.exec(content)) !== null) {
      const name = m[2];
      const doc = m[3];
      const lineStart = lineAt(content, m.index);

      // Skip if already captured as defn
      if (symbols.some(s => s.name === name && s.symbol_type === 'function')) continue;

      const isDefonce = content.substring(m.index, m.index + 10).includes('defonce');

      symbols.push({
        symbol_type: 'variable',
        name,
        value: isDefonce ? 'defonce' : 'def',
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. defmacro
    // ══════════════════════════════════════════════
    const macroRe = /^\(defmacro\s+([\w*+!?<>=-]+)(?:\s+"([^"]*)")?\s*\[([^\]]*)\]/gm;
    while ((m = macroRe.exec(content)) !== null) {
      const params = m[3].split(/\s+/).filter(p => p && p !== '&');
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'defmacro',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. defprotocol
    // ══════════════════════════════════════════════
    const protoRe = /^\(defprotocol\s+([\w*+!?<>=-]+)/gm;
    while ((m = protoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: 'defprotocol',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. defrecord / deftype
    // ══════════════════════════════════════════════
    const recordRe = /^\(def(?:record|type)\s+([\w*+!?<>=-]+)\s*\[([^\]]*)\]/gm;
    while ((m = recordRe.exec(content)) !== null) {
      const name = m[1];
      const fields = m[2].split(/\s+/).filter(Boolean);
      const isRecord = content.substring(m.index, m.index + 12).includes('defrecord');

      symbols.push({
        symbol_type: 'class',
        name,
        value: isRecord ? 'defrecord' : 'deftype',
        params: fields.length > 0 ? fields : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. defmulti / defmethod
    // ══════════════════════════════════════════════
    const multiRe = /^\(defmulti\s+([\w*+!?<>=-]+)/gm;
    while ((m = multiRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'defmulti',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    const methodRe = /^\(defmethod\s+([\w*+!?<>=-]+)\s+:?([\w-]+)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: `${m[1]}:${m[2]}`,
        value: 'defmethod',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `defmethod ${m[1]} :${m[2]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. declare (forward declarations)
    // ══════════════════════════════════════════════
    const declareRe = /^\(declare\s+([\w\s*+!?<>=-]+)\)/gm;
    while ((m = declareRe.exec(content)) !== null) {
      const names = m[1].trim().split(/\s+/).filter(Boolean);
      for (const name of names) {
        symbols.push({
          symbol_type: 'variable',
          name,
          value: 'declare',
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /;\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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


    return { symbols, references };
  }
}

export const clojureParser = new ClojureParser();
