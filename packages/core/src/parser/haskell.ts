/**
 * MODUL: Haskell Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Haskell-Dateien (.hs, .lhs)
 *
 * EXTRAHIERT: module, import, data/newtype/type, class, instance,
 *             function type signatures, function definitions, where bindings,
 *             deriving, pragma, pattern synonyms, type families, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class HaskellParser implements LanguageParser {
  language = 'haskell';
  extensions = ['.hs', '.lhs'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Module declaration
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+([\w.]+)(?:\s*\(([^)]*)\))?\s+where/m;
    m = moduleRe.exec(content);
    if (m) {
      const exports = m[2] ? m[2].split(',').map(e => e.trim()).filter(Boolean) : undefined;
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'module',
        params: exports,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Imports
    // ══════════════════════════════════════════════
    const importRe = /^import\s+(qualified\s+)?([\w.]+)(?:\s+as\s+(\w+))?(?:\s+(?:hiding\s+)?\(([^)]*)\))?/gm;
    while ((m = importRe.exec(content)) !== null) {
      const isQualified = !!m[1];
      const module = m[2];
      const alias = m[3];
      const imports = m[4];
      const lineStart = lineAt(content, m.index);

      const shortName = alias || module.split('.').pop() || module;

      symbols.push({
        symbol_type: 'import',
        name: alias || shortName,
        value: isQualified ? `qualified ${module}` : module,
        line_start: lineStart,
        is_exported: false,
      });

      references.push({
        symbol_name: shortName,
        line_number: lineStart,
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Data types
    // ══════════════════════════════════════════════
    const dataRe = /^data\s+(\w+)(?:\s+([a-z][\w\s]*))?(?:\s*=\s*([^\n]+))?/gm;
    while ((m = dataRe.exec(content)) !== null) {
      const name = m[1];
      const typeVars = m[2] ? m[2].trim() : undefined;
      const constructors = m[3] ? m[3].trim() : undefined;
      const lineStart = lineAt(content, m.index);

      // Extract constructor names
      const ctors: string[] = [];
      if (constructors) {
        const ctorNames = constructors.split('|').map(c => {
          const match = c.trim().match(/^(\w+)/);
          return match ? match[1] : '';
        }).filter(Boolean);
        ctors.push(...ctorNames);
      }

      // Check for deriving
      const afterData = content.substring(m.index);
      const derivingMatch = afterData.match(/deriving\s*\(([^)]+)\)/);
      const deriving = derivingMatch
        ? derivingMatch[1].split(',').map(d => d.trim()).filter(Boolean)
        : undefined;

      symbols.push({
        symbol_type: 'class',
        name,
        value: typeVars ? `data ${name} ${typeVars}` : `data ${name}`,
        params: ctors.length > 0 ? ctors : undefined,
        line_start: lineStart,
        is_exported: true,
      });

      if (deriving) {
        for (const d of deriving) {
          references.push({
            symbol_name: d,
            line_number: lineStart,
            context: `data ${name} deriving (${deriving.join(', ')})`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Newtype
    // ══════════════════════════════════════════════
    const newtypeRe = /^newtype\s+(\w+)(?:\s+([a-z][\w\s]*))?(?:\s*=\s*(\w+)\s+(.+))?/gm;
    while ((m = newtypeRe.exec(content)) !== null) {
      const name = m[1];
      const ctor = m[3] || name;
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'newtype',
        params: [ctor],
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Type aliases
    // ══════════════════════════════════════════════
    const typeRe = /^type\s+(\w+)(?:\s+[a-z][\w\s]*)?\s*=\s*(.+)/gm;
    while ((m = typeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: `type = ${m[2].trim().slice(0, 200)}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Type classes
    // ══════════════════════════════════════════════
    const classRe = /^class\s+(?:\(([^)]*)\)\s*=>\s*)?(\w+)\s+([a-z]\w*)\s+where/gm;
    while ((m = classRe.exec(content)) !== null) {
      const constraints = m[1];
      const name = m[2];
      const typeVar = m[3];
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'interface',
        name,
        value: `class ${name} ${typeVar}`,
        params: constraints ? [constraints.trim()] : undefined,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Instance declarations
    // ══════════════════════════════════════════════
    const instanceRe = /^instance\s+(?:\(([^)]*)\)\s*=>\s*)?(\w+)\s+(\S[^\n]*?)\s+where/gm;
    while ((m = instanceRe.exec(content)) !== null) {
      const className = m[2];
      const forType = m[3].trim();
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'class',
        name: `${className} ${forType}`,
        value: 'instance',
        line_start: lineStart,
        is_exported: true,
      });

      references.push({
        symbol_name: className,
        line_number: lineStart,
        context: `instance ${className} ${forType}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 8. Type signatures (name :: type)
    // ══════════════════════════════════════════════
    const sigRe = /^(\w+)\s*::\s*(.+)/gm;
    const seenSigs = new Set<string>();
    while ((m = sigRe.exec(content)) !== null) {
      const name = m[1];
      const sig = m[2].trim();
      const lineStart = lineAt(content, m.index);

      // Skip common keywords
      if (['module', 'import', 'data', 'newtype', 'type', 'class', 'instance', 'where', 'let', 'in'].includes(name)) continue;

      seenSigs.add(name);

      // Parse params from signature
      const parts = sig.split('->').map(p => p.trim());
      const returnType = parts.length > 1 ? parts[parts.length - 1] : sig;
      const params = parts.length > 1 ? parts.slice(0, -1) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Top-level function definitions (without type sig)
    // ══════════════════════════════════════════════
    const funcDefRe = /^(\w+)\s+(?!::)([^=\n]*?)=\s/gm;
    const seenDefs = new Set<string>();
    while ((m = funcDefRe.exec(content)) !== null) {
      const name = m[1];
      const args = m[2].trim();

      // Skip keywords and already-seen type signatures
      if (['module', 'import', 'data', 'newtype', 'type', 'class', 'instance',
           'where', 'let', 'in', 'if', 'then', 'else', 'do', 'case', 'of'].includes(name)) continue;
      if (seenSigs.has(name) || seenDefs.has(name)) continue;
      seenDefs.add(name);

      const params = args.split(/\s+/).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Pragmas ({-# ... #-})
    // ══════════════════════════════════════════════
    const pragmaRe = /\{-#\s*(\w+)\s+([^#]+)#-\}/g;
    while ((m = pragmaRe.exec(content)) !== null) {
      const kind = m[1];
      const value = m[2].trim();
      if (kind === 'LANGUAGE') {
        for (const ext of value.split(',').map(e => e.trim()).filter(Boolean)) {
          symbols.push({
            symbol_type: 'variable',
            name: ext,
            value: 'LANGUAGE',
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
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

    // ══════════════════════════════════════════════
    // 12. Haddock comments (-- | ... or {- | ... -})
    // ══════════════════════════════════════════════
    const haddockRe = /-- \|\s*(.+(?:\n--\s+.+)*)/g;
    while ((m = haddockRe.exec(content)) !== null) {
      const text = m[1].replace(/\n--\s*/g, ' ').trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // Block Haddock comments
    const haddockBlockRe = /\{-\s*\|([\s\S]*?)-\}/g;
    while ((m = haddockBlockRe.exec(content)) !== null) {
      const text = m[1].trim();
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

export const haskellParser = new HaskellParser();
