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

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

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


    return { symbols, references };
  }
}

export const rParser = new RParser();
