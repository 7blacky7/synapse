/**
 * MODUL: D Parser
 * ZWECK: Extrahiert Struktur-Informationen aus D-Dateien (.d)
 *
 * EXTRAHIERT: module, import, class, struct, interface, enum, union,
 *             function, template, mixin, alias, unittest, version,
 *             @attribute, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class DlangParser implements LanguageParser {
  language = 'dlang';
  extensions = ['.d'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+([\w.]+)\s*;/m;
    m = moduleRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'module',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Import
    // ══════════════════════════════════════════════
    const importRe = /^\s*(?:public\s+|static\s+)?import\s+([\w.]+)(?:\s*:\s*([\w,\s]+))?/gm;
    while ((m = importRe.exec(content)) !== null) {
      const pkg = m[1];
      const selective = m[2];
      const name = pkg.split('.').pop() || pkg;

      if (selective) {
        const items = selective.split(',').map(s => s.trim()).filter(Boolean);
        for (const item of items) {
          symbols.push({
            symbol_type: 'import',
            name: item,
            value: `${pkg} : ${item}`,
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }
      } else {
        symbols.push({
          symbol_type: 'import',
          name,
          value: pkg,
          line_start: lineAt(content, m.index),
          is_exported: m[0].includes('public'),
        });
      }

      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Classes / Interfaces
    // ══════════════════════════════════════════════
    const classRe = /^(\s*)((?:(?:public|private|protected|package|static|abstract|final|synchronized)\s+)*)(class|interface)\s+(\w+)(?:\s*:\s*([^\n{]+))?\s*\{/gm;
    while ((m = classRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const parents = m[5] ? m[5].split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: kind === 'interface' ? 'interface' : 'class',
        name,
        value: kind,
        params: parents,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !/\bprivate\b/.test(modifiers),
      });

      if (parents) {
        for (const p of parents) {
          references.push({
            symbol_name: p.split('!')[0],
            line_number: lineStart,
            context: `${kind} ${name} : ${parents.join(', ')}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Structs / Unions
    // ══════════════════════════════════════════════
    const structRe = /^(\s*)((?:(?:public|private|protected|package|static)\s+)*)(struct|union)\s+(\w+)\s*\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[4],
        value: m[3],
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !/\bprivate\b/.test(m[2]),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Enums
    // ══════════════════════════════════════════════
    const enumRe = /^(\s*)enum\s+(\w+)(?:\s*:\s*(\w+))?\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[2],
        value: m[3] ? `enum : ${m[3]}` : 'enum',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^(\s*)((?:(?:public|private|protected|package|static|pure|nothrow|@\w+|override|final|extern\([^)]*\))\s+)*)(\w[\w.!]*)\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:const|immutable|inout|shared|pure|nothrow|@\w+))*/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const returnType = m[3];
      const name = m[4];
      const paramsRaw = m[5];
      const lineStart = lineAt(content, m.index);

      if (['if', 'for', 'while', 'switch', 'foreach', 'version', 'static', 'debug',
           'class', 'struct', 'interface', 'enum', 'union', 'import', 'module'].includes(returnType)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
      });
    }

    // ══════════════════════════════════════════════
    // 7. Templates
    // ══════════════════════════════════════════════
    const templateRe = /^(\s*)template\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
    while ((m = templateRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[2],
        value: 'template',
        params: m[3].split(',').map(p => p.trim()).filter(Boolean),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Alias
    // ══════════════════════════════════════════════
    const aliasRe = /^\s*alias\s+(\w+)\s*=\s*(.+)\s*;/gm;
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
    // 9. Unittest
    // ══════════════════════════════════════════════
    const unittestRe = /^\s*unittest\s*\{/gm;
    while ((m = unittestRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: 'unittest',
        value: 'unittest',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Version blocks
    // ══════════════════════════════════════════════
    const versionRe = /^\s*version\s*\((\w+)\)\s*\{/gm;
    while ((m = versionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `version(${m[1]})`,
        value: 'version',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /\/\/\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 12. Ddoc comments (/** ... */ or ///)
    // ══════════════════════════════════════════════
    const ddocRe = /\/\*\*([\s\S]*?)\*\//g;
    while ((m = ddocRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    return { symbols, references };
  }

  private findClosingBrace(content: string, openPos: number): number {
    let depth = 1;
    for (let i = openPos + 1; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') depth--;
      if (depth === 0) return lineAt(content, i);
    }
    return lineAt(content, content.length);
  }
}

export const dlangParser = new DlangParser();
