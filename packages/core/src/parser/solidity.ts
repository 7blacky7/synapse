/**
 * MODUL: Solidity Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Solidity-Dateien (.sol)
 *
 * EXTRAHIERT: pragma, import, contract, interface, library, abstract contract,
 *             struct, enum, event, error, modifier, function, constructor,
 *             mapping, using, state variables, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class SolidityParser implements LanguageParser {
  language = 'solidity';
  extensions = ['.sol'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Pragma
    // ══════════════════════════════════════════════
    const pragmaRe = /^pragma\s+(\w+)\s+([^;]+);/gm;
    while ((m = pragmaRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `pragma ${m[1]}`,
        value: m[2].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Import
    // ══════════════════════════════════════════════
    const importRe = /^import\s+(?:\{([^}]+)\}\s+from\s+)?["']([^"']+)["']\s*;/gm;
    while ((m = importRe.exec(content)) !== null) {
      const names = m[1] ? m[1].split(',').map(n => n.trim()).filter(Boolean) : [];
      const path = m[2];
      const shortName = path.split('/').pop()?.replace('.sol', '') || path;

      if (names.length > 0) {
        for (const name of names) {
          symbols.push({
            symbol_type: 'import',
            name: name.split(' as ').pop()!.trim(),
            value: `${name} from ${path}`,
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }
      } else {
        symbols.push({
          symbol_type: 'import',
          name: shortName,
          value: path,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Contract / Interface / Library
    // ══════════════════════════════════════════════
    const contractRe = /^(abstract\s+)?(contract|interface|library)\s+(\w+)(?:\s+is\s+([^\n{]+))?\s*\{/gm;
    while ((m = contractRe.exec(content)) !== null) {
      const isAbstract = !!m[1];
      const kind = m[2];
      const name = m[3];
      const inherits = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface' : 'class';
      const parents: string[] = [];
      if (inherits) {
        parents.push(...inherits.split(',').map(s => s.trim().split('(')[0].trim()).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: isAbstract ? `abstract ${kind}` : kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      for (const parent of parents) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name} is ${inherits?.trim()}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Struct
    // ══════════════════════════════════════════════
    const structRe = /^\s*struct\s+(\w+)\s*\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Enum
    // ══════════════════════════════════════════════
    const enumRe = /^\s*enum\s+(\w+)\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[1],
        value: 'enum',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Event
    // ══════════════════════════════════════════════
    const eventRe = /^\s*event\s+(\w+)\s*\(([^)]*)\)\s*;/gm;
    while ((m = eventRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => {
        const parts = p.trim().split(/\s+/);
        return parts[parts.length - 1];
      }).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'event',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Error (custom errors)
    // ══════════════════════════════════════════════
    const errorRe = /^\s*error\s+(\w+)\s*\(([^)]*)\)\s*;/gm;
    while ((m = errorRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'error',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Modifier
    // ══════════════════════════════════════════════
    const modRe = /^\s*modifier\s+(\w+)\s*(?:\(([^)]*)\))?\s*\{/gm;
    while ((m = modRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'modifier',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^\s*function\s+(\w+)\s*\(([^)]*)\)\s*((?:(?:public|external|internal|private|view|pure|payable|virtual|override|returns)\s*(?:\([^)]*\))?\s*)*)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const modifiers = m[3];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      const returnsMatch = modifiers.match(/returns\s*\(([^)]*)\)/);
      const returnType = returnsMatch ? returnsMatch[1].trim() : undefined;

      const visibility = /\b(public|external|internal|private)\b/.exec(modifiers);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: visibility ? !['private', 'internal'].includes(visibility[1]) : true,
      });
    }

    // Constructor
    const ctorRe = /^\s*constructor\s*\(([^)]*)\)/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: 'constructor',
        value: 'constructor',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Receive / Fallback
    const specialRe = /^\s*(receive|fallback)\s*\(\s*\)/gm;
    while ((m = specialRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. State variables
    // ══════════════════════════════════════════════
    const stateVarRe = /^\s*(mapping\s*\([^)]+\)|[\w\[\]]+)\s+(public\s+|private\s+|internal\s+)?(constant\s+|immutable\s+)?(\w+)(?:\s*=\s*([^;]+))?;/gm;
    while ((m = stateVarRe.exec(content)) !== null) {
      const varType = m[1];
      const visibility = m[2] ? m[2].trim() : '';
      const modifier = m[3] ? m[3].trim() : '';
      const name = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip common false positives
      if (['return', 'emit', 'require', 'revert', 'delete', 'event', 'error', 'struct', 'enum'].includes(varType)) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || `${modifier} ${varType}`.trim(),
        return_type: varType,
        line_start: lineStart,
        is_exported: visibility === 'public',
      });
    }

    // ══════════════════════════════════════════════
    // 11. Using
    // ══════════════════════════════════════════════
    const usingRe = /^\s*using\s+([\w.]+)\s+for\s+(\S+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `using ${m[1]} for ${m[2]}`.slice(0, 80),
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

    // ══════════════════════════════════════════════
    // 13. NatSpec comments (/** ... */ or /// ...)
    // ══════════════════════════════════════════════
    const natspecRe = /\/\*\*([\s\S]*?)\*\//g;
    while ((m = natspecRe.exec(content)) !== null) {
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

export const solidityParser = new SolidityParser();
