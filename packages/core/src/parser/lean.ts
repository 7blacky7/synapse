/**
 * MODUL: Lean Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Lean-Dateien (.lean)
 *
 * EXTRAHIERT: import, open, namespace, def, theorem, lemma, structure,
 *             class, instance, inductive, abbrev, axiom, TODO
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class LeanParser implements LanguageParser {
  language = 'lean';
  extensions = ['.lean'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // 1. Import
    const importRe = /^import\s+([\w.]+)/gm;
    while ((m = importRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: m[1], line_start: lineAt(content, m.index), is_exported: false });
    }

    // 2. Open
    const openRe = /^open\s+([\w.]+)/gm;
    while ((m = openRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: 'open', line_start: lineAt(content, m.index), is_exported: false });
    }

    // 3. Namespace
    const nsRe = /^namespace\s+([\w.]+)/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'namespace', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 4. def / noncomputable def
    const defRe = /^(?:noncomputable\s+)?(?:private\s+)?(?:protected\s+)?(?:partial\s+)?def\s+(\w+)(?:\s*\(([^)]*)\))?/gm;
    while ((m = defRe.exec(content)) !== null) {
      const params = m[2] ? m[2].split(',').map(p => p.trim().split(/\s*:\s*/)[0]).filter(Boolean) : undefined;
      symbols.push({ symbol_type: 'function', name: m[1], params, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 5. Theorem
    const thmRe = /^(?:private\s+)?(?:protected\s+)?theorem\s+(\w+)/gm;
    while ((m = thmRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'theorem', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 6. Lemma
    const lemRe = /^(?:private\s+)?(?:protected\s+)?lemma\s+(\w+)/gm;
    while ((m = lemRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'lemma', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 7. Structure
    const structRe = /^(?:private\s+)?(?:protected\s+)?structure\s+(\w+)(?:\s+(?:extends\s+([\w.]+)))?/gm;
    while ((m = structRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: m[2] ? `extends ${m[2]}` : 'structure', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 8. Class
    const classRe = /^(?:private\s+)?(?:protected\s+)?class\s+(\w+)(?:\s+(?:extends\s+([\w.]+)))?/gm;
    while ((m = classRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: m[2] ? `extends ${m[2]}` : 'class', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 9. Instance
    const instRe = /^(?:noncomputable\s+)?instance\s*(?::\s*([\w.]+))?/gm;
    while ((m = instRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1] || 'instance', value: 'instance', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 10. Inductive
    const indRe = /^inductive\s+(\w+)/gm;
    while ((m = indRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'inductive', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 11. Abbrev
    const abbrRe = /^(?:private\s+)?(?:protected\s+)?abbrev\s+(\w+)/gm;
    while ((m = abbrRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'abbrev', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 12. Axiom
    const axRe = /^axiom\s+(\w+)/gm;
    while ((m = axRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'axiom', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 13. TODO / FIXME
    const todoRe = /--\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'todo', name: null, value: m[0].trim(), line_start: lineAt(content, m.index), is_exported: false });
    }

    symbols.push(...extractStringLiterals(content));


    return { symbols, references };
  }
}

export const leanParser = new LeanParser();
