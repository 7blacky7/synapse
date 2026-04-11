/**
 * MODUL: V Parser
 * ZWECK: Extrahiert Struktur-Informationen aus V-Dateien (.v, .vv)
 *
 * EXTRAHIERT: module, import, fn (pub), struct, enum, union, interface,
 *             const, type alias, [attribute], test, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class VlangParser implements LanguageParser {
  language = 'vlang';
  extensions = ['.v', '.vv'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+(\w+)/m;
    m = moduleRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'module',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Import
    // ══════════════════════════════════════════════
    const importRe = /^import\s+([\w.]+)(?:\s+as\s+(\w+))?/gm;
    while ((m = importRe.exec(content)) !== null) {
      const pkg = m[1];
      const alias = m[2];
      const name = alias || pkg.split('.').pop() || pkg;
      symbols.push({
        symbol_type: 'import',
        name,
        value: alias ? `${pkg} as ${alias}` : pkg,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Struct
    // ══════════════════════════════════════════════
    const structRe = /^(pub\s+)?struct\s+(\w+)\s*\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      const isPub = !!m[1];
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Enum
    // ══════════════════════════════════════════════
    const enumRe = /^(pub\s+)?enum\s+(\w+)\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const isPub = !!m[1];
      const name = m[2];
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
    }

    // ══════════════════════════════════════════════
    // 5. Union
    // ══════════════════════════════════════════════
    const unionRe = /^(pub\s+)?union\s+(\w+)\s*\{/gm;
    while ((m = unionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: 'union',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !!m[1],
      });
    }

    // ══════════════════════════════════════════════
    // 6. Interface
    // ══════════════════════════════════════════════
    const ifaceRe = /^(pub\s+)?interface\s+(\w+)\s*\{/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[2],
        value: 'interface',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !!m[1],
      });
    }

    // ══════════════════════════════════════════════
    // 7. Functions (fn)
    // ══════════════════════════════════════════════
    const fnRe = /^(pub\s+)?fn\s+(?:\((\w+)\s+(?:&?(?:mut\s+)?)?(\w+)\)\s+)?(\w+)(?:\[([^\]]*)\])?\s*\(([^)]*)\)\s*(?:(\!\s*)?(\w[\w.]*)?)?/gm;
    while ((m = fnRe.exec(content)) !== null) {
      const isPub = !!m[1];
      const receiverName = m[2];
      const receiverType = m[3];
      const name = m[4];
      const typeParams = m[5];
      const paramsRaw = m[6];
      const returnType = m[8];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/)[0])
        .filter(p => p && p !== 'mut');

      const fullName = receiverType ? `${receiverType}.${name}` : name;

      symbols.push({
        symbol_type: 'function',
        name: fullName,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: isPub,
        parent_id: receiverType || undefined,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Constants
    // ══════════════════════════════════════════════
    const constBlockRe = /^(pub\s+)?const\s*\(/gm;
    while ((m = constBlockRe.exec(content)) !== null) {
      const isPub = !!m[1];
      const lineStart = lineAt(content, m.index);
      const block = content.substring(m.index + m[0].length);
      const endIdx = block.indexOf(')');
      const constBlock = endIdx > 0 ? block.substring(0, endIdx) : block;

      const valRe = /^\s*(\w+)\s*=\s*(.+)/gm;
      let vm: RegExpExecArray | null;
      while ((vm = valRe.exec(constBlock)) !== null) {
        symbols.push({
          symbol_type: 'variable',
          name: vm[1],
          value: vm[2].trim().slice(0, 200),
          line_start: lineAt(content, m.index + m[0].length + vm.index),
          is_exported: isPub,
        });
      }
    }

    // Single const
    const constSingleRe = /^(pub\s+)?const\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = constSingleRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: !!m[1],
      });
    }

    // ══════════════════════════════════════════════
    // 9. Type aliases
    // ══════════════════════════════════════════════
    const typeRe = /^(pub\s+)?type\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = typeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[2],
        value: `type = ${m[3].trim().slice(0, 200)}`,
        line_start: lineAt(content, m.index),
        is_exported: !!m[1],
      });
    }

    // ══════════════════════════════════════════════
    // 10. Test functions
    // ══════════════════════════════════════════════
    const testRe = /^fn\s+test_(\w+)\s*\(/gm;
    while ((m = testRe.exec(content)) !== null) {
      // Already captured by fn regex, skip
    }

    // ══════════════════════════════════════════════
    // 11. Attributes ([attribute])
    // ══════════════════════════════════════════════
    const attrRe = /^\[(\w+(?::\s*'[^']*')?)\]/gm;
    while ((m = attrRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1].split(':')[0],
        line_number: lineAt(content, m.index),
        context: `[${m[1]}]`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 12. TODO / FIXME / HACK
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

    symbols.push(...extractStringLiterals(content));


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

export const vlangParser = new VlangParser();
