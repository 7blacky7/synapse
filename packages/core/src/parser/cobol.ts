/**
 * MODUL: COBOL Parser
 * ZWECK: Extrahiert Struktur-Informationen aus COBOL-Dateien (.cob, .cbl, .cpy)
 *
 * EXTRAHIERT: IDENTIFICATION/PROGRAM-ID, ENVIRONMENT/DATA/PROCEDURE divisions,
 *             SECTION, PARAGRAPH, COPY/REPLACE, FD/SD file descriptions,
 *             01-level data items (records), PERFORM, CALL, comment, todo
 * ANSATZ: Regex-basiert (case-insensitive, column-aware)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class CobolParser implements LanguageParser {
  language = 'cobol';
  extensions = ['.cob', '.cbl', '.cpy'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. PROGRAM-ID
    // ══════════════════════════════════════════════
    const progRe = /PROGRAM-ID\.\s+(\S+)/im;
    m = progRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'class',
        name: m[1].replace(/\.$/, ''),
        value: 'PROGRAM-ID',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Divisions
    // ══════════════════════════════════════════════
    const divRe = /^\s{6}\s*(IDENTIFICATION|ENVIRONMENT|DATA|PROCEDURE)\s+DIVISION/gim;
    while ((m = divRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: `${m[1].toUpperCase()} DIVISION`,
        value: 'division',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Sections
    // ══════════════════════════════════════════════
    const secRe = /^\s{6}\s*([\w-]+)\s+SECTION\s*\./gim;
    while ((m = secRe.exec(content)) !== null) {
      const name = m[1].toUpperCase();
      // Skip standard division sections
      if (['IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE'].includes(name)) continue;
      symbols.push({
        symbol_type: 'class',
        name,
        value: 'SECTION',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Paragraphs (in PROCEDURE DIVISION)
    // ══════════════════════════════════════════════
    const paraRe = /^\s{6}\s*([\w-]+)\s*\.\s*$/gim;
    while ((m = paraRe.exec(content)) !== null) {
      const name = m[1].toUpperCase();
      // Skip keywords
      if (['IDENTIFICATION', 'ENVIRONMENT', 'DATA', 'PROCEDURE',
           'WORKING-STORAGE', 'LOCAL-STORAGE', 'LINKAGE', 'FILE',
           'CONFIGURATION', 'INPUT-OUTPUT', 'FD', 'SD', 'COPY',
           'PROGRAM-ID', 'AUTHOR', 'DATE-WRITTEN', 'REMARKS',
           'SOURCE-COMPUTER', 'OBJECT-COMPUTER', 'SPECIAL-NAMES'].includes(name)) continue;
      if (name.endsWith('DIVISION') || name.endsWith('SECTION')) continue;

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'paragraph',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. COPY statements
    // ══════════════════════════════════════════════
    const copyRe = /COPY\s+([\w-]+)/gim;
    while ((m = copyRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: 'COPY',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `COPY ${m[1]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 6. File Descriptions (FD/SD)
    // ══════════════════════════════════════════════
    const fdRe = /^\s{6}\s*(FD|SD)\s+([\w-]+)/gim;
    while ((m = fdRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: m[1].toUpperCase(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Data items (01/77 level)
    // ══════════════════════════════════════════════
    const dataRe = /^\s{6}\s*(01|77)\s+([\w-]+)/gim;
    while ((m = dataRe.exec(content)) !== null) {
      const level = m[1];
      const name = m[2];
      if (name === 'FILLER') continue;

      // Check if it has PIC clause (elementary) or not (group)
      const afterName = content.substring(m.index, m.index + 200);
      const picMatch = afterName.match(/PIC(?:TURE)?\s+IS\s+(\S+)|PIC(?:TURE)?\s+(\S+)/i);
      const value = picMatch ? (picMatch[1] || picMatch[2]) : 'group';

      symbols.push({
        symbol_type: 'variable',
        name,
        value: `${level} ${value}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. PERFORM references
    // ══════════════════════════════════════════════
    const performRe = /PERFORM\s+([\w-]+)/gim;
    while ((m = performRe.exec(content)) !== null) {
      const target = m[1].toUpperCase();
      if (['VARYING', 'UNTIL', 'TIMES', 'WITH', 'TEST'].includes(target)) continue;
      references.push({
        symbol_name: target,
        line_number: lineAt(content, m.index),
        context: `PERFORM ${target}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. CALL references
    // ══════════════════════════════════════════════
    const callRe = /CALL\s+["']([^"']+)["']/gim;
    while ((m = callRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `CALL "${m[1]}"`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK (in comments: * in col 7)
    // ══════════════════════════════════════════════
    const todoRe = /^\s{6}\*\s*(TODO|FIXME|HACK):?\s*(.*)/gim;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    return { symbols, references };
  }
}

export const cobolParser = new CobolParser();
