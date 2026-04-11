/**
 * MODUL: Ada Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Ada-Dateien (.adb, .ads)
 *
 * EXTRAHIERT: with/use, package, procedure, function, type (record/enum/tagged/
 *             access/derived), subtype, generic, task, protected, entry,
 *             exception, pragma, constant, comment, todo
 * ANSATZ: Regex-basiert (case-insensitive)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class AdaParser implements LanguageParser {
  language = 'ada';
  extensions = ['.adb', '.ads', '.ada'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. With / Use (imports)
    // ══════════════════════════════════════════════
    const withRe = /^\s*with\s+([\w.,\s]+)\s*;/gim;
    while ((m = withRe.exec(content)) !== null) {
      const pkgs = m[1].split(',').map(p => p.trim()).filter(Boolean);
      for (const pkg of pkgs) {
        symbols.push({
          symbol_type: 'import',
          name: pkg.split('.').pop() || pkg,
          value: pkg,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
        references.push({
          symbol_name: pkg.split('.').pop() || pkg,
          line_number: lineAt(content, m.index),
          context: `with ${pkg}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 2. Package
    // ══════════════════════════════════════════════
    const pkgRe = /^\s*package\s+(?:body\s+)?(\w[\w.]*)\s+is/gim;
    while ((m = pkgRe.exec(content)) !== null) {
      const isBody = /body/i.test(m[0]);
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: isBody ? 'package body' : 'package',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Procedure
    // ══════════════════════════════════════════════
    const procRe = /^\s*(?:overriding\s+)?procedure\s+(\w+)\s*(?:\(([^)]*)\))?/gim;
    while ((m = procRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2]
        ? m[2].split(';').map(p => p.trim().split(':')[0].trim().split(',')[0].trim()).filter(Boolean)
        : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'procedure',
        params,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Function
    // ══════════════════════════════════════════════
    const funcRe = /^\s*(?:overriding\s+)?function\s+(\w+)\s*(?:\(([^)]*)\))?\s*return\s+(\w[\w.]*)/gim;
    while ((m = funcRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2]
        ? m[2].split(';').map(p => p.trim().split(':')[0].trim().split(',')[0].trim()).filter(Boolean)
        : undefined;
      const returnType = m[3];

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Type definitions
    // ══════════════════════════════════════════════
    const typeRe = /^\s*type\s+(\w+)(?:\s+is\s+(.+?))?;/gim;
    while ((m = typeRe.exec(content)) !== null) {
      const name = m[1];
      const def = m[2] ? m[2].trim() : undefined;
      const lineStart = lineAt(content, m.index);

      if (!def) {
        // Incomplete/private type
        symbols.push({
          symbol_type: 'interface',
          name,
          value: 'private type',
          line_start: lineStart,
          is_exported: true,
        });
      } else if (/^\(/.test(def)) {
        // Enum
        const values = def.replace(/[()]/g, '').split(',').map(v => v.trim()).filter(Boolean);
        symbols.push({
          symbol_type: 'enum',
          name,
          value: 'enum',
          params: values,
          line_start: lineStart,
          is_exported: true,
        });
      } else if (/record/i.test(def)) {
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'record',
          line_start: lineStart,
          is_exported: true,
        });
      } else if (/tagged/i.test(def)) {
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'tagged type',
          line_start: lineStart,
          is_exported: true,
        });
      } else if (/new\s+(\w+)/i.test(def)) {
        const parentMatch = def.match(/new\s+(\w[\w.]*)/i);
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'derived type',
          params: parentMatch ? [`new ${parentMatch[1]}`] : undefined,
          line_start: lineStart,
          is_exported: true,
        });
        if (parentMatch) {
          references.push({
            symbol_name: parentMatch[1],
            line_number: lineStart,
            context: `type ${name} is new ${parentMatch[1]}`.slice(0, 80),
          });
        }
      } else if (/access/i.test(def)) {
        symbols.push({
          symbol_type: 'interface',
          name,
          value: `access ${def.replace(/access\s*/i, '').trim()}`,
          line_start: lineStart,
          is_exported: true,
        });
      } else {
        symbols.push({
          symbol_type: 'interface',
          name,
          value: `type = ${def.slice(0, 200)}`,
          line_start: lineStart,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Subtype
    // ══════════════════════════════════════════════
    const subtypeRe = /^\s*subtype\s+(\w+)\s+is\s+(.+);/gim;
    while ((m = subtypeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: `subtype ${m[2].trim().slice(0, 200)}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Generic
    // ══════════════════════════════════════════════
    const genericRe = /^\s*generic/gim;
    while ((m = genericRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'generic',
        value: 'generic',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Task / Protected
    // ══════════════════════════════════════════════
    const taskRe = /^\s*(task|protected)\s+(?:type\s+|body\s+)?(\w+)\s+is/gim;
    while ((m = taskRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: m[1].toLowerCase(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Entry
    const entryRe = /^\s*entry\s+(\w+)\s*(?:\(([^)]*)\))?/gim;
    while ((m = entryRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'entry',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Exception
    // ══════════════════════════════════════════════
    const exnRe = /^\s*(\w+)\s*:\s*exception\s*;/gim;
    while ((m = exnRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'exception',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Constants
    // ══════════════════════════════════════════════
    const constRe = /^\s*(\w+)\s*:\s*constant\s+(\w[\w.]*)\s*:=\s*([^;]+);/gim;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[3].trim().slice(0, 200),
        return_type: m[2],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Pragma
    // ══════════════════════════════════════════════
    const pragmaRe = /^\s*pragma\s+(\w+)(?:\s*\(([^)]*)\))?;/gim;
    while ((m = pragmaRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `pragma ${m[1]}`,
        value: m[2] ? m[2].trim() : m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 12. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /--\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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

export const adaParser = new AdaParser();
