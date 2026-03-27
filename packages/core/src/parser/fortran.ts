/**
 * MODUL: Fortran Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Fortran-Dateien (.f90, .f95, .f03, .f08, .f)
 *
 * EXTRAHIERT: program, module, submodule, subroutine, function, type,
 *             use, implicit, interface, contains, intent, allocatable,
 *             parameter, comment, todo
 * ANSATZ: Regex-basiert (case-insensitive)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class FortranParser implements LanguageParser {
  language = 'fortran';
  extensions = ['.f90', '.f95', '.f03', '.f08', '.f', '.for'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Program
    // ══════════════════════════════════════════════
    const progRe = /^\s*program\s+(\w+)/gim;
    while ((m = progRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'program',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Module / Submodule
    // ══════════════════════════════════════════════
    const moduleRe = /^\s*(sub)?module\s+(\w+)/gim;
    while ((m = moduleRe.exec(content)) !== null) {
      const isSub = !!m[1];
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: isSub ? 'submodule' : 'module',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Use
    // ══════════════════════════════════════════════
    const useRe = /^\s*use\s+(\w+)(?:\s*,\s*only\s*:\s*([^\n]+))?/gim;
    while ((m = useRe.exec(content)) !== null) {
      const module = m[1];
      const only = m[2];

      symbols.push({
        symbol_type: 'import',
        name: module,
        value: only ? `use ${module}, only: ${only.trim()}` : `use ${module}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });

      references.push({
        symbol_name: module,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Subroutines
    // ══════════════════════════════════════════════
    const subRe = /^\s*(?:(pure|elemental|recursive|impure)\s+)*subroutine\s+(\w+)\s*\(([^)]*)\)/gim;
    while ((m = subRe.exec(content)) !== null) {
      const modifiers = m[1] || '';
      const name = m[2];
      const params = m[3].split(',').map(p => p.trim()).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        value: modifiers ? `${modifiers} subroutine` : 'subroutine',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^\s*(?:((?:pure|elemental|recursive|impure|integer|real|double\s+precision|complex|logical|character)\s+)*)?function\s+(\w+)\s*\(([^)]*)\)(?:\s+result\s*\((\w+)\))?/gim;
    while ((m = funcRe.exec(content)) !== null) {
      const modifiers = m[1] ? m[1].trim() : '';
      const name = m[2];
      const params = m[3].split(',').map(p => p.trim()).filter(Boolean);
      const resultVar = m[4];

      symbols.push({
        symbol_type: 'function',
        name,
        value: modifiers ? `${modifiers} function` : 'function',
        params: params.length > 0 ? params : undefined,
        return_type: resultVar,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Type definitions
    // ══════════════════════════════════════════════
    const typeRe = /^\s*type(?:\s*,\s*(?:public|private|abstract|extends\((\w+)\)))?\s*::\s*(\w+)/gim;
    while ((m = typeRe.exec(content)) !== null) {
      const parent = m[1];
      const name = m[2];

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'type',
        params: parent ? [`extends ${parent}`] : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineAt(content, m.index),
          context: `type, extends(${parent}) :: ${name}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. Interface blocks
    // ══════════════════════════════════════════════
    const ifaceRe = /^\s*interface\s+(\w+)/gim;
    while ((m = ifaceRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: 'interface',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Variable declarations
    // ══════════════════════════════════════════════
    const varRe = /^\s*(integer|real|double\s+precision|complex|logical|character|type\(\w+\))\s*(?:\([^)]*\))?\s*(?:,\s*(?:intent\(\w+\)|parameter|allocatable|dimension\([^)]*\)|save|target|pointer|optional|value)\s*)*(?:,\s*(?:public|private))?\s*::\s*(\w+(?:\s*,\s*\w+)*)(?:\s*=\s*([^\n!]+))?/gim;
    while ((m = varRe.exec(content)) !== null) {
      const varType = m[1];
      const names = m[2].split(',').map(n => n.trim()).filter(Boolean);
      const value = m[3] ? m[3].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      const isParameter = /parameter/i.test(m[0]);

      for (const name of names) {
        symbols.push({
          symbol_type: 'variable',
          name,
          value: value || varType.trim(),
          return_type: varType.trim(),
          line_start: lineStart,
          is_exported: isParameter,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /!\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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

export const fortranParser = new FortranParser();
