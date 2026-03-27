/**
 * MODUL: Racket Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Racket-Dateien (.rkt)
 *
 * EXTRAHIERT: #lang, require/provide, define, define-struct/struct,
 *             define-syntax, define/contract, class/interface, module,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class RacketParser implements LanguageParser {
  language = 'racket';
  extensions = ['.rkt', '.rktl', '.scrbl'];

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

    return { symbols, references };
  }
}

export const racketParser = new RacketParser();
