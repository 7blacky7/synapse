/**
 * MODUL: LLVM IR Parser
 * ZWECK: Extrahiert Struktur aus LLVM IR Textform (.ll)
 *
 * EXTRAHIERT: define (Funktionen), declare, global/constant, String-Literale, Kommentare
 * ANSATZ: Regex-basiert
 */

import type { ParseResult, LanguageParser, ParsedSymbol } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

class LlvmIrParser implements LanguageParser {
  language = 'llvmir';
  extensions = ['.ll'];

  parse(content: string, _filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: never[] = [];
    let m: RegExpExecArray | null;

    // 1. Funktionen: define [linkage] <type> @name(args) { ... }
    const defRe = /^define\s+(?:[^@\n]*\s)?@([\w.$-]+)\s*\(([^)]*)\)/gm;
    while ((m = defRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: m[2].slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // 2. Deklarationen: declare <type> @name(args)
    const declRe = /^declare\s+(?:[^@\n]*\s)?@([\w.$-]+)\s*\(/gm;
    while ((m = declRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // 3. Globale Variablen/Konstanten: @name = [linkage] [constant|global] type value
    const globalRe = /^@([\w.$-]+)\s*=\s*(?:[^=\n]*?\s)?(constant|global)\s+/gm;
    while ((m = globalRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // 4. Typen: %Name = type { ... }
    const typeRe = /^%([\w.$-]+)\s*=\s*type\s+/gm;
    while ((m = typeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // 5. Zeilen-Kommentare ; ...
    const commentRe = /^\s*;(.+)$/gm;
    while ((m = commentRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // 6. String-Literale (LLVM nutzt "...", Single-Quotes nicht als String)
    symbols.push(...extractStringLiterals(content));

    return { symbols, references };
  }
}

export const llvmIrParser = new LlvmIrParser();
