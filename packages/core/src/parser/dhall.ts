/**
 * MODUL: Dhall Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Dhall-Dateien (.dhall)
 *
 * EXTRAHIERT: let-bindings, Type-Definitionen, imports (env/http/path),
 *             records, unions, assertions, TODO
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class DhallParser implements LanguageParser {
  language = 'dhall';
  extensions = ['.dhall'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // 1. Let-bindings (functions with params)
    const letFnRe = /^let\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*\\?\s*\((\w+)/gm;
    while ((m = letFnRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], params: [m[2]], line_start: lineAt(content, m.index), is_exported: true });
    }

    // 2. Let-bindings (values / type aliases)
    const letRe = /^let\s+(\w+)\s*(?::\s*([^=\n]+))?\s*=/gm;
    while ((m = letRe.exec(content)) !== null) {
      if (symbols.some(s => s.name === m![1] && s.line_start === lineAt(content, m!.index))) continue;
      const typeHint = m[2]?.trim();
      const isType = typeHint === 'Type' || /^(?:Type|Kind|Sort)$/.test(typeHint || '');
      symbols.push({
        symbol_type: isType ? 'class' : 'variable',
        name: m[1],
        value: typeHint ? typeHint.slice(0, 100) : 'let',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // 3. Env imports
    const envRe = /env:(\w+)/g;
    while ((m = envRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: `env:${m[1]}`, value: 'env', line_start: lineAt(content, m.index), is_exported: false });
    }

    // 4. HTTP imports
    const httpRe = /(https?:\/\/[^\s]+\.dhall)/g;
    while ((m = httpRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1].slice(0, 200), value: 'http', line_start: lineAt(content, m.index), is_exported: false });
    }

    // 5. Path imports
    const pathRe = /(?:\.\/|\.\.\/|\/)([\w./-]+\.dhall)/g;
    while ((m = pathRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: 'path', line_start: lineAt(content, m.index), is_exported: false });
    }

    // 6. Assert
    const assertRe = /^let\s+(\w+)\s*=\s*assert\s*:/gm;
    while ((m = assertRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'assert', line_start: lineAt(content, m.index), is_exported: false });
    }

    // 7. TODO / FIXME
    const todoRe = /--\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'todo', name: null, value: m[0].trim(), line_start: lineAt(content, m.index), is_exported: false });
    }

    symbols.push(...extractStringLiterals(content));


    return { symbols, references };
  }
}

export const dhallParser = new DhallParser();
