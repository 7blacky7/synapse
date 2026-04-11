/**
 * MODUL: F# Parser
 * ZWECK: Extrahiert Struktur-Informationen aus F#-Dateien (.fs, .fsi, .fsx)
 *
 * EXTRAHIERT: namespace, module, open, let/let rec, type (record/DU/class/interface),
 *             member, abstract member, val, exception, attribute, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class FSharpParser implements LanguageParser {
  language = 'fsharp';
  extensions = ['.fs', '.fsi', '.fsx'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Namespace
    // ══════════════════════════════════════════════
    const nsRe = /^namespace\s+([\w.]+)/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+((?:internal|private|public)\s+)?([\w.]+)(?:\s*=)?/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      const access = m[1] ? m[1].trim() : 'public';
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: 'module',
        line_start: lineAt(content, m.index),
        is_exported: access !== 'private',
      });
    }

    // ══════════════════════════════════════════════
    // 3. Open (imports)
    // ══════════════════════════════════════════════
    const openRe = /^open\s+([\w.]+)/gm;
    while ((m = openRe.exec(content)) !== null) {
      const module = m[1];
      symbols.push({
        symbol_type: 'import',
        name: module.split('.').pop() || module,
        value: module,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: module.split('.').pop() || module,
        line_number: lineAt(content, m.index),
        context: `open ${module}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Type definitions
    // ══════════════════════════════════════════════
    const typeRe = /^(\s*)((?:(?:internal|private|public)\s+)?)type\s+(?:\[<[^\]]+>\]\s*)?(\w+)(?:<([^>]+)>)?\s*(?:\(([^)]*)\))?\s*=\s*/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const access = m[2] ? m[2].trim() : '';
      const name = m[3];
      const typeParams = m[4];
      const lineStart = lineAt(content, m.index);

      // Look at what follows to determine the kind
      const afterEquals = content.substring(m.index + m[0].length).trimStart();

      if (afterEquals.startsWith('{')) {
        // Record type
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'record',
          params: typeParams ? [`<${typeParams}>`] : undefined,
          line_start: lineStart,
          is_exported: access !== 'private',
        });

        // Parse record fields
        const braceMatch = afterEquals.match(/\{([^}]+)\}/);
        if (braceMatch) {
          const fieldRe = /(\w+)\s*:\s*([^\n;]+)/g;
          let fm: RegExpExecArray | null;
          while ((fm = fieldRe.exec(braceMatch[1])) !== null) {
            symbols.push({
              symbol_type: 'variable',
              name: fm[1],
              value: fm[2].trim(),
              return_type: fm[2].trim(),
              line_start: lineStart,
              is_exported: true,
              parent_id: name,
            });
          }
        }
      } else if (afterEquals.startsWith('|') || /^\w+\s*(of\b|\|)/.test(afterEquals)) {
        // Discriminated Union
        const cases: string[] = [];
        const duRe = /\|\s*(\w+)/g;
        let dm: RegExpExecArray | null;
        const duBlock = content.substring(m.index + m[0].length, m.index + m[0].length + 500);
        while ((dm = duRe.exec(duBlock)) !== null) {
          cases.push(dm[1]);
        }
        // Also match first case without |
        const firstCase = afterEquals.match(/^(\w+)(?:\s+of\b)?/);
        if (firstCase && firstCase[1] !== 'private' && firstCase[1] !== 'internal') {
          cases.unshift(firstCase[1]);
        }

        symbols.push({
          symbol_type: 'enum',
          name,
          value: 'union',
          params: cases.length > 0 ? cases : undefined,
          line_start: lineStart,
          is_exported: access !== 'private',
        });
      } else if (afterEquals.startsWith('class') || afterEquals.startsWith('inherit')) {
        // Class
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'class',
          line_start: lineStart,
          is_exported: access !== 'private',
        });
      } else if (afterEquals.startsWith('interface')) {
        // Interface
        symbols.push({
          symbol_type: 'interface',
          name,
          value: 'interface',
          line_start: lineStart,
          is_exported: access !== 'private',
        });
      } else {
        // Type alias or other
        symbols.push({
          symbol_type: 'interface',
          name,
          value: `type = ${afterEquals.split('\n')[0].trim().slice(0, 200)}`,
          line_start: lineStart,
          is_exported: access !== 'private',
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Let bindings (top-level or module-level)
    // ══════════════════════════════════════════════
    const letRe = /^(\s*)((?:(?:internal|private|public)\s+)?)let\s+(rec\s+)?(?:inline\s+)?(\w+)(?:\s+([^=\n]+))?\s*=/gm;
    const seenLets = new Set<string>();
    while ((m = letRe.exec(content)) !== null) {
      const indent = m[1].length;
      const access = m[2] ? m[2].trim() : '';
      const isRec = !!m[3];
      const name = m[4];
      const argsRaw = m[5] || '';
      const lineStart = lineAt(content, m.index);

      // Skip deeply indented (local) bindings — F# modules indent by 4
      if (indent > 8) continue;
      if (seenLets.has(name)) continue;
      seenLets.add(name);
      if (name === '_') continue;

      const args = argsRaw.trim().split(/\s+/).filter(a =>
        a && !a.startsWith('(') && a !== ':' && !a.includes('=')
      );

      const isFunction = args.length > 0;

      symbols.push({
        symbol_type: isFunction ? 'function' : 'variable',
        name,
        value: isRec ? 'let rec' : undefined,
        params: isFunction ? args : undefined,
        line_start: lineStart,
        is_exported: access !== 'private',
      });
    }

    // ══════════════════════════════════════════════
    // 6. Member definitions
    // ══════════════════════════════════════════════
    const memberRe = /^\s+(static\s+)?member\s+(?:(?:private|internal|public)\s+)?(?:this|self|x|_)\.(\w+)(?:\s*\(([^)]*)\))?/gm;
    while ((m = memberRe.exec(content)) !== null) {
      const isStatic = !!m[1];
      const name = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        ? paramsRaw.split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean)
        : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        value: isStatic ? 'static member' : 'member',
        params,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // Abstract members
    const abstractRe = /^\s+abstract\s+member\s+(\w+)\s*:\s*(.+)/gm;
    while ((m = abstractRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'abstract member',
        return_type: m[2].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Exception
    // ══════════════════════════════════════════════
    const exnRe = /^exception\s+(\w+)(?:\s+of\s+(.+))?/gm;
    while ((m = exnRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'exception',
        params: m[2] ? [m[2].trim()] : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Attributes
    // ══════════════════════════════════════════════
    const attrRe = /^\[<(\w+)(?:\([^)]*\))?>\]/gm;
    while ((m = attrRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
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
    // 10. XML doc comments (/// ...)
    // ══════════════════════════════════════════════
    const docRe = /((?:\/\/\/[^\n]*\n)+)/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/\/\/\/\s?/g, '').replace(/<[^>]+>/g, '').trim();
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
}

export const fsharpParser = new FSharpParser();
