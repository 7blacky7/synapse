/**
 * MODUL: Crystal Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Crystal-Dateien (.cr)
 *
 * EXTRAHIERT: require, module, class, struct, enum, lib, fun, def,
 *             macro, alias, annotation, abstract class/struct,
 *             include/extend, property (getter/setter), comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class CrystalParser implements LanguageParser {
  language = 'crystal';
  extensions = ['.cr'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Require
    // ══════════════════════════════════════════════
    const requireRe = /^require\s+"([^"]+)"/gm;
    while ((m = requireRe.exec(content)) !== null) {
      const path = m[1];
      const name = path.split('/').pop()?.replace(/\*$/, '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: path,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^(\s*)module\s+([\w:]+)/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: 'module',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Class / Struct (with abstract)
    // ══════════════════════════════════════════════
    const classRe = /^(\s*)(abstract\s+)?(class|struct)\s+([\w:]+)(?:\s*<\s*([\w:]+))?/gm;
    while ((m = classRe.exec(content)) !== null) {
      const isAbstract = !!m[2];
      const kind = m[3];
      const name = m[4];
      const parent = m[5];
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'class',
        name,
        value: isAbstract ? `abstract ${kind}` : kind,
        params: parent ? [parent] : undefined,
        line_start: lineStart,
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name} < ${parent}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Enum
    // ══════════════════════════════════════════════
    const enumRe = /^(\s*)enum\s+([\w:]+)(?:\s*:\s*(\w+))?/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[2],
        value: m[3] ? `enum : ${m[3]}` : 'enum',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Lib (C bindings)
    // ══════════════════════════════════════════════
    const libRe = /^(\s*)lib\s+(\w+)/gm;
    while ((m = libRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: 'lib',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Fun (C function bindings inside lib)
    const funRe = /^\s+fun\s+(\w+)(?:\s*=\s*"(\w+)")?\s*\(([^)]*)\)(?:\s*:\s*(\w[\w*]*))?/gm;
    while ((m = funRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[2] || m[1],
        value: 'fun',
        return_type: m[4],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Methods (def)
    // ══════════════════════════════════════════════
    const defRe = /^(\s*)((?:(?:private|protected|abstract)\s+)*)def\s+(self\.)?(\w+[?!]?)(?:\(([^)]*)\))?(?:\s*:\s*(\w[\w|&?]*))?/gm;
    const seenDefs = new Set<string>();
    while ((m = defRe.exec(content)) !== null) {
      const modifiers = m[2];
      const isSelf = !!m[3];
      const name = m[4];
      const paramsRaw = m[5] || '';
      const returnType = m[6];
      const lineStart = lineAt(content, m.index);

      const key = `${isSelf ? 'self.' : ''}${name}`;
      if (seenDefs.has(key)) continue;
      seenDefs.add(key);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].split('=')[0].replace(/^\*+/, '').trim())
        .filter(p => p && !p.startsWith('&'));

      symbols.push({
        symbol_type: 'function',
        name: isSelf ? `self.${name}` : name,
        value: modifiers.includes('abstract') ? 'abstract def' : undefined,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !modifiers.includes('private'),
      });
    }

    // ══════════════════════════════════════════════
    // 7. Macros
    // ══════════════════════════════════════════════
    const macroRe = /^(\s*)macro\s+(\w+)(?:\(([^)]*)\))?/gm;
    while ((m = macroRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[2],
        value: 'macro',
        params: m[3] ? m[3].split(',').map(p => p.trim()).filter(Boolean) : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Alias
    // ══════════════════════════════════════════════
    const aliasRe = /^\s*alias\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = aliasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: `alias = ${m[2].trim().slice(0, 200)}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Include / Extend
    // ══════════════════════════════════════════════
    const inclRe = /^\s*(include|extend)\s+([\w:]+)/gm;
    while ((m = inclRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[2],
        line_number: lineAt(content, m.index),
        context: `${m[1]} ${m[2]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 10. Properties (getter/setter/property)
    // ══════════════════════════════════════════════
    const propRe = /^\s*(getter|setter|property)\s+([\w?!]+)(?:\s*:\s*(\w[\w|?]*))?/gm;
    while ((m = propRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[1],
        return_type: m[3],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Annotation
    // ══════════════════════════════════════════════
    const annotRe = /^(\s*)annotation\s+(\w+)/gm;
    while ((m = annotRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[2],
        value: 'annotation',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 12. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content));


    return { symbols, references };
  }
}

export const crystalParser = new CrystalParser();
