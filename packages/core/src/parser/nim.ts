/**
 * MODUL: Nim Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Nim-Dateien (.nim, .nims)
 *
 * EXTRAHIERT: import/from, include, proc/func/method/iterator/converter,
 *             type (object/enum/tuple/ref/distinct), template, macro,
 *             const/let/var, pragma, export marker (*), comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class NimParser implements LanguageParser {
  language = 'nim';
  extensions = ['.nim', '.nims'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Import
    // ══════════════════════════════════════════════
    const importRe = /^import\s+([\w\/,\s]+)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const modules = m[1].split(',').map(s => s.trim()).filter(Boolean);
      for (const mod of modules) {
        const name = mod.split('/').pop() || mod;
        symbols.push({
          symbol_type: 'import',
          name,
          value: mod,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
        references.push({
          symbol_name: name,
          line_number: lineAt(content, m.index),
          context: `import ${mod}`.slice(0, 80),
        });
      }
    }

    // From import
    const fromRe = /^from\s+([\w\/]+)\s+import\s+([\w,\s]+)/gm;
    while ((m = fromRe.exec(content)) !== null) {
      const module = m[1];
      const items = m[2].split(',').map(s => s.trim()).filter(Boolean);
      for (const item of items) {
        symbols.push({
          symbol_type: 'import',
          name: item,
          value: `from ${module} import ${item}`,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
      references.push({
        symbol_name: module.split('/').pop() || module,
        line_number: lineAt(content, m.index),
        context: `from ${module} import ${items.join(', ')}`.slice(0, 80),
      });
    }

    // Include
    const includeRe = /^include\s+([\w\/,\s]+)/gm;
    while ((m = includeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1].trim().split('/').pop() || m[1].trim(),
        value: `include ${m[1].trim()}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Type definitions
    // ══════════════════════════════════════════════
    const typeBlockRe = /^type\b/gm;
    while ((m = typeBlockRe.exec(content)) !== null) {
      const afterType = content.substring(m.index + m[0].length);
      const typeDefRe = /^\s{2}(\w+)\*?\s*(?:\[([^\]]*)\])?\s*=\s*(ref\s+)?(?:object(?:\s+of\s+(\w+))?|enum|tuple|distinct\s+\w+|concept)/gm;
      let tm: RegExpExecArray | null;

      while ((tm = typeDefRe.exec(afterType)) !== null) {
        const name = tm[1];
        const typeParams = tm[2];
        const isRef = !!tm[3];
        const parentType = tm[4];
        const kind = tm[0].includes('enum') ? 'enum'
          : tm[0].includes('object') ? 'class'
          : tm[0].includes('concept') ? 'interface'
          : 'interface';
        const lineStart = lineAt(content, m.index + m[0].length + tm.index);
        const isExported = tm[0].includes('*');

        symbols.push({
          symbol_type: kind === 'enum' ? 'enum' : kind === 'interface' ? 'interface' : 'class',
          name,
          value: isRef ? 'ref object' : kind === 'enum' ? 'enum' : 'object',
          params: parentType ? [`of ${parentType}`] : typeParams ? [`[${typeParams}]`] : undefined,
          line_start: lineStart,
          is_exported: isExported,
        });

        if (parentType) {
          references.push({
            symbol_name: parentType,
            line_number: lineStart,
            context: `${name} = object of ${parentType}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. Procedures / Functions / Methods / Iterators
    // ══════════════════════════════════════════════
    const procRe = /^(proc|func|method|iterator|converter)\s+(\w+)\*?\s*(?:\[([^\]]*)\])?\s*\(([^)]*)\)(?:\s*:\s*(\w[\w\[\],\s]*))?/gm;
    while ((m = procRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const typeParams = m[3];
      const paramsRaw = m[4];
      const returnType = m[5] ? m[5].trim() : undefined;
      const lineStart = lineAt(content, m.index);
      const isExported = m[0].includes('*');

      const params = paramsRaw
        .split(/[,;]/)
        .map(p => p.trim().split(':')[0].trim())
        .filter(p => p && p !== 'self');

      symbols.push({
        symbol_type: 'function',
        name,
        value: kind,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: isExported,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Templates
    // ══════════════════════════════════════════════
    const templateRe = /^template\s+(\w+)\*?\s*(?:\(([^)]*)\))?/gm;
    while ((m = templateRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2] || '';
      const params = paramsRaw.split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'template',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: m[0].includes('*'),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Macros
    // ══════════════════════════════════════════════
    const macroRe = /^macro\s+(\w+)\*?\s*\(([^)]*)\)/gm;
    while ((m = macroRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'macro',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: m[0].includes('*'),
      });
    }

    // ══════════════════════════════════════════════
    // 6. Constants / Let / Var (top-level)
    // ══════════════════════════════════════════════
    const constBlockRe = /^(const|let|var)\b/gm;
    while ((m = constBlockRe.exec(content)) !== null) {
      const kind = m[1];
      const afterBlock = content.substring(m.index + m[0].length);

      // Single-line: const NAME* = value
      const singleRe = /^\s+(\w+)\*?(?:\s*:\s*(\w[\w\[\]]*))?\s*=\s*(.+)/gm;
      let vm: RegExpExecArray | null;
      while ((vm = singleRe.exec(afterBlock)) !== null) {
        const name = vm[1];
        const varType = vm[2];
        const value = vm[3].trim().slice(0, 200);
        const isExported = vm[0].includes('*');
        const lineStart = lineAt(content, m.index + m[0].length + vm.index);

        // Stop when we hit unindented content
        if (!afterBlock.substring(vm.index).match(/^\s{2}/)) break;

        symbols.push({
          symbol_type: 'variable',
          name,
          value,
          return_type: varType,
          line_start: lineStart,
          is_exported: isExported,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. Pragmas ({.pragma.})
    // ══════════════════════════════════════════════
    // Pragmas are inline markers — skip for now (too noisy)

    // ══════════════════════════════════════════════
    // 8. TODO / FIXME / HACK
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

    // ══════════════════════════════════════════════
    // 9. Doc comments (## ...)
    // ══════════════════════════════════════════════
    const docRe = /((?:##[^\n]*\n)+)/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/##\s?/g, '').trim();
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
}

export const nimParser = new NimParser();
