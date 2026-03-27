/**
 * MODUL: OCaml Parser
 * ZWECK: Extrahiert Struktur-Informationen aus OCaml-Dateien (.ml, .mli)
 *
 * EXTRAHIERT: module/module type, open, let/let rec, type, val (signatures),
 *             exception, class, method, functor, external, include,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class OCamlParser implements LanguageParser {
  language = 'ocaml';
  extensions = ['.ml', '.mli'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;
    const isInterface = filePath.endsWith('.mli');

    // ══════════════════════════════════════════════
    // 1. Open (imports)
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
    // 2. Include
    // ══════════════════════════════════════════════
    const includeRe = /^include\s+([\w.]+)/gm;
    while ((m = includeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1].split('.').pop() || m[1],
        value: `include ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
      references.push({
        symbol_name: m[1].split('.').pop() || m[1],
        line_number: lineAt(content, m.index),
        context: `include ${m[1]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Module definitions
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+(type\s+)?(\w+)(?:\s*:\s*(\w+))?\s*=\s*(struct|sig|functor)/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      const isModuleType = !!m[1];
      const name = m[2];
      const sigName = m[3];
      const kind = m[4];
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: isModuleType ? 'interface' : 'class',
        name,
        value: isModuleType ? 'module type' : kind === 'functor' ? 'functor' : 'module',
        line_start: lineStart,
        is_exported: true,
      });

      if (sigName) {
        references.push({
          symbol_name: sigName,
          line_number: lineStart,
          context: `module ${name} : ${sigName}`.slice(0, 80),
        });
      }
    }

    // Module declarations (without = struct)
    const moduleDeclRe = /^module\s+(type\s+)?(\w+)\s*:\s*sig\b/gm;
    while ((m = moduleDeclRe.exec(content)) !== null) {
      const isModuleType = !!m[1];
      const name = m[2];

      symbols.push({
        symbol_type: 'interface',
        name,
        value: isModuleType ? 'module type' : 'module sig',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Type definitions
    // ══════════════════════════════════════════════
    const typeRe = /^type\s+(?:'[a-z]\s+)?(\w+)(?:\s*=\s*(?:\{([^}]*)\}|(.+)))?/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const name = m[1];
      const recordFields = m[2];
      const typeDef = m[3];
      const lineStart = lineAt(content, m.index);

      if (recordFields) {
        // Record type — extract fields
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'record',
          line_start: lineStart,
          is_exported: true,
        });

        const fieldRe = /(\w+)\s*:\s*([^;]+)/g;
        let fm: RegExpExecArray | null;
        while ((fm = fieldRe.exec(recordFields)) !== null) {
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
      } else if (typeDef && typeDef.includes('|')) {
        // Variant type
        const variants = typeDef.split('|').map(v => v.trim().split(/\s+/)[0]).filter(Boolean);
        symbols.push({
          symbol_type: 'enum',
          name,
          value: 'variant',
          params: variants,
          line_start: lineStart,
          is_exported: true,
        });
      } else {
        // Type alias or abstract type
        symbols.push({
          symbol_type: 'interface',
          name,
          value: typeDef ? `type = ${typeDef.trim().slice(0, 200)}` : 'abstract type',
          line_start: lineStart,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Let bindings (functions + values)
    // ══════════════════════════════════════════════
    const letRe = /^let\s+(rec\s+)?(\w+)(?:\s+([^=\n]+))?\s*=/gm;
    const seenLets = new Set<string>();
    while ((m = letRe.exec(content)) !== null) {
      const isRec = !!m[1];
      const name = m[2];
      const argsRaw = m[3] || '';
      const lineStart = lineAt(content, m.index);

      if (seenLets.has(name)) continue;
      seenLets.add(name);

      // Skip internal helper names
      if (name === '_') continue;

      const args = argsRaw.trim().split(/\s+/).filter(a =>
        a && !a.startsWith('(') && !a.startsWith('~') && !a.startsWith('?') && a !== ':'
      );

      const isFunction = args.length > 0 || argsRaw.includes('fun');

      if (isFunction) {
        const params = argsRaw.trim()
          .split(/\s+/)
          .filter(p => p && p !== ':' && !p.startsWith('('))
          .map(p => p.replace(/^[~?]/, ''));

        symbols.push({
          symbol_type: 'function',
          name,
          value: isRec ? 'let rec' : undefined,
          params: params.length > 0 ? params : undefined,
          line_start: lineStart,
          is_exported: true,
        });
      } else {
        symbols.push({
          symbol_type: 'variable',
          name,
          value: 'let',
          line_start: lineStart,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Val declarations (.mli signatures)
    // ══════════════════════════════════════════════
    if (isInterface) {
      const valRe = /^val\s+(\w+)\s*:\s*(.+)/gm;
      while ((m = valRe.exec(content)) !== null) {
        const name = m[1];
        const sig = m[2].trim();
        const lineStart = lineAt(content, m.index);

        const parts = sig.split('->').map(p => p.trim());
        const returnType = parts.length > 1 ? parts[parts.length - 1] : sig;
        const isFunction = parts.length > 1;

        symbols.push({
          symbol_type: isFunction ? 'function' : 'variable',
          name,
          params: isFunction ? parts.slice(0, -1) : undefined,
          return_type: returnType,
          line_start: lineStart,
          is_exported: true,
        });
      }
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
    // 8. External (FFI)
    // ══════════════════════════════════════════════
    const externalRe = /^external\s+(\w+)\s*:\s*([^=]+)=\s*"([^"]+)"/gm;
    while ((m = externalRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: `external "${m[3]}"`,
        return_type: m[2].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Class definitions
    // ══════════════════════════════════════════════
    const classRe = /^class\s+(?:virtual\s+)?(?:\['[a-z]\]\s+)?(\w+)\s*(?:\(([^)]*)\))?\s*=\s*object/gm;
    while ((m = classRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'class',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Methods
    const methodRe = /^\s+method\s+(virtual\s+)?(\w+)(?:\s+([^=\n]+))?\s*=/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const isVirtual = !!m[1];
      const name = m[2];
      const params = m[3] ? m[3].trim().split(/\s+/).filter(Boolean) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        value: isVirtual ? 'virtual method' : 'method',
        params,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /\(\*\s*(TODO|FIXME|HACK):?\s*([^*]*)\*\)/gi;
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
    // 11. OCamldoc comments ((** ... *))
    // ══════════════════════════════════════════════
    const docRe = /\(\*\*([\s\S]*?)\*\)/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 3 || /^(TODO|FIXME|HACK)/i.test(text)) continue;
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

export const ocamlParser = new OCamlParser();
