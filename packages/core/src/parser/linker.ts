/**
 * MODUL: GNU Linker Script Parser
 * ZWECK: Extrahiert Struktur aus Linker-Scripts (.ld, .lds, .x)
 *
 * EXTRAHIERT: SECTIONS, MEMORY regions, ENTRY, OUTPUT_*, Kommentare, Strings
 * ANSATZ: Regex-basiert
 */

import type { ParseResult, LanguageParser, ParsedSymbol } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

class LinkerScriptParser implements LanguageParser {
  language = 'linker';
  extensions = ['.ld', '.lds', '.x'];

  parse(content: string, _filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: never[] = [];
    let m: RegExpExecArray | null;

    // 1. MEMORY-Regionen: name (rwx) : ORIGIN = ..., LENGTH = ...
    const memRe = /^\s*([a-zA-Z_][\w]*)\s*(?:\([^)]*\))?\s*:\s*ORIGIN\s*=\s*([^,\n]+),\s*LENGTH\s*=\s*([^\n]+)/gm;
    while ((m = memRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: `ORIGIN=${m[2].trim()}, LENGTH=${m[3].trim()}`.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // 2. Sections: .name : { ... }
    const sectionRe = /^\s*(\.[a-zA-Z_][\w.]*)\s*:/gm;
    const seenSection = new Set<string>();
    while ((m = sectionRe.exec(content)) !== null) {
      if (seenSection.has(m[1])) continue;
      seenSection.add(m[1]);
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: 'section',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // 3. ENTRY, OUTPUT, OUTPUT_FORMAT, OUTPUT_ARCH, SEARCH_DIR als Funktions-Symbole
    const directiveRe = /^\s*(ENTRY|OUTPUT|OUTPUT_FORMAT|OUTPUT_ARCH|SEARCH_DIR|INPUT|GROUP|STARTUP|PROVIDE|ASSERT)\s*\(([^)]*)\)/gm;
    while ((m = directiveRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // 4. Kommentare /* ... */
    const commentRe = /\/\*([\s\S]*?)\*\//g;
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

    // 5. String-Literale
    symbols.push(...extractStringLiterals(content));

    return { symbols, references };
  }
}

export const linkerScriptParser = new LinkerScriptParser();
