/**
 * MODUL: Zig Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Zig-Dateien (.zig)
 *
 * EXTRAHIERT: fn (pub/export), const/var, struct, enum, union, error,
 *             test blocks, @import, comptime, usingnamespace,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ZigParser implements LanguageParser {
  language = 'zig';
  extensions = ['.zig'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Imports (@import)
    // ══════════════════════════════════════════════
    const importRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*@import\s*\(\s*"([^"]+)"\s*\)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const module = m[4];
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'import',
        name,
        value: module,
        line_start: lineStart,
        is_exported: isPub,
      });

      references.push({
        symbol_name: module.replace('.zig', ''),
        line_number: lineStart,
        context: `@import("${module}")`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Structs
    // ══════════════════════════════════════════════
    const structRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*(packed\s+|extern\s+)?struct\s*(?:\([^)]*\)\s*)?\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const modifier = m[4] ? m[4].trim() : '';
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: modifier ? `${modifier} struct` : 'struct',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });

      // Parse struct fields
      this.parseStructFields(content, m.index + m[0].length, lineEnd, name, symbols);
    }

    // ══════════════════════════════════════════════
    // 3. Enums
    // ══════════════════════════════════════════════
    const enumRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*(extern\s+)?enum(?:\s*\([^)]*\))?\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'enum',
        name,
        value: 'enum',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });

      // Parse enum values
      const block = content.substring(m.index + m[0].length);
      const valRe = /^\s*(\w+)(?:\s*=\s*[^,\n]+)?\s*,/gm;
      let vm: RegExpExecArray | null;
      while ((vm = valRe.exec(block)) !== null) {
        const valLine = lineAt(content, m.index + m[0].length + vm.index);
        if (valLine > lineEnd) break;
        if (vm[1] === 'pub' || vm[1] === 'fn' || vm[1] === 'const') continue;

        symbols.push({
          symbol_type: 'variable',
          name: vm[1],
          value: 'enum_value',
          line_start: valLine,
          is_exported: isPub,
          parent_id: name,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Unions
    // ══════════════════════════════════════════════
    const unionRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*(packed\s+|extern\s+)?union(?:\s*\([^)]*\))?\s*\{/gm;
    while ((m = unionRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'union',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Error sets
    // ══════════════════════════════════════════════
    const errorRe = /^(\s*)(pub\s+)?(?:const|var)\s+(\w+)\s*=\s*error\s*\{/gm;
    while ((m = errorRe.exec(content)) !== null) {
      const isPub = !!m[2];
      const name = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'enum',
        name,
        value: 'error',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Functions (fn)
    // ══════════════════════════════════════════════
    const fnRe = /^(\s*)(pub\s+)?(export\s+)?(inline\s+)?fn\s+(\w+)\s*\(([^)]*)\)\s*(?:(\w[\w!.*\s]*))?(?:\s*\{)?/gm;
    while ((m = fnRe.exec(content)) !== null) {
      const indent = m[1].length;
      const isPub = !!m[2];
      const isExport = !!m[3];
      const isInline = !!m[4];
      const name = m[5];
      const paramsRaw = m[6];
      const returnType = m[7] ? m[7].trim() : undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(':');
          return parts[0].replace(/comptime\s+/, '').trim();
        })
        .filter(p => p && p !== 'self' && p !== '_');

      const parentStruct = indent > 0 ? this.findParentStruct(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        value: isExport ? 'export' : isInline ? 'inline' : undefined,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: isPub || isExport,
        parent_id: parentStruct,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Constants and variables (not imports/structs/enums)
    // ══════════════════════════════════════════════
    // Collect names already captured by type definitions
    const typeNames = new Set(
      symbols.filter(s => ['class', 'enum', 'import'].includes(s.symbol_type) && s.name)
        .map(s => s.name!)
    );

    const constRe = /^(\s*)(pub\s+)?(const|var)\s+(\w+)\s*(?::\s*(\S+))?\s*=\s*(.+)/gm;
    while ((m = constRe.exec(content)) !== null) {
      const indent = m[1].length;
      const isPub = !!m[2];
      const kind = m[3];
      const name = m[4];
      const varType = m[5] || undefined;
      const value = m[6].trim().replace(/;$/, '').slice(0, 200);
      const lineStart = lineAt(content, m.index);

      // Skip type definitions already captured (struct, enum, union, error, import)
      if (typeNames.has(name)) continue;
      if (/^(?:@import|(?:packed\s+|extern\s+)?(?:struct|enum|union)|error)\s*[({]/.test(value)) continue;

      // Skip deeply nested locals
      if (indent > 4) continue;

      const parentStruct = indent > 0 ? this.findParentStruct(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        return_type: varType,
        line_start: lineStart,
        is_exported: isPub,
        parent_id: parentStruct,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Test blocks
    // ══════════════════════════════════════════════
    const testRe = /^test\s+"([^"]+)"\s*\{/gm;
    while ((m = testRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: `test "${m[1]}"`,
        value: 'test',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 9. usingnamespace
    // ══════════════════════════════════════════════
    const usingRe = /^(\s*)(pub\s+)?usingnamespace\s+(\S+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[3].split('.').pop() || m[3],
        value: `usingnamespace ${m[3]}`,
        line_start: lineAt(content, m.index),
        is_exported: !!m[2],
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
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
    // 11. Doc comments (/// ...)
    // ══════════════════════════════════════════════
    const docRe = /((?:\/\/\/[^\n]*\n)+)/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/\/\/\/\s?/g, '').trim();
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

  private parseStructFields(
    content: string, blockStart: number, blockLineEnd: number,
    parentName: string, symbols: ParsedSymbol[]
  ): void {
    const block = content.substring(blockStart);
    const fieldRe = /^\s+(\w+)\s*:\s*(\S[^,\n]*)/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(block)) !== null) {
      const fieldLine = lineAt(content, blockStart + fm.index);
      if (fieldLine > blockLineEnd) break;

      const name = fm[1];
      if (['pub', 'fn', 'const', 'var', 'comptime'].includes(name)) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: fm[2].trim().replace(/,$/, ''),
        line_start: fieldLine,
        is_exported: true,
        parent_id: parentName,
      });
    }
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

  private findParentStruct(content: string, pos: number): string | undefined {
    const before = content.substring(0, pos);
    const match = before.match(/(?:const|var)\s+(\w+)\s*=\s*(?:packed\s+|extern\s+)?struct[^{]*\{[^}]*$/);
    return match ? match[1] : undefined;
  }
}

export const zigParser = new ZigParser();
