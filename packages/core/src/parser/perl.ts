/**
 * MODUL: Perl Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Perl-Dateien (.pl, .pm)
 *
 * EXTRAHIERT: package, sub, use/require, my/our/local variables,
 *             BEGIN/END/INIT blocks, Moose/Moo attributes (has),
 *             extends/with (roles), constant, POD comments, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class PerlParser implements LanguageParser {
  language = 'perl';
  extensions = ['.pl', '.pm', '.t'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package declarations
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+([\w:]+)\s*;/gm;
    while ((m = pkgRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'package',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Use / Require
    // ══════════════════════════════════════════════
    const useRe = /^(use|require)\s+([\w:]+)(?:\s+([^;]+))?;/gm;
    while ((m = useRe.exec(content)) !== null) {
      const kind = m[1];
      const module = m[2];
      const args = m[3] ? m[3].trim() : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip pragmas for symbol creation but still create reference
      const isPragma = ['strict', 'warnings', 'utf8', 'v5', 'feature',
                        'constant', 'lib', 'Carp', 'Data::Dumper'].includes(module);

      if (!isPragma || kind === 'require') {
        symbols.push({
          symbol_type: 'import',
          name: module.split('::').pop() || module,
          value: args ? `${kind} ${module} ${args}` : `${kind} ${module}`,
          line_start: lineStart,
          is_exported: false,
        });
      }

      references.push({
        symbol_name: module.split('::').pop() || module,
        line_number: lineStart,
        context: m[0].trim().slice(0, 80),
      });

      // use constant { NAME => value }
      if (module === 'constant') {
        const constRe = /(\w+)\s*=>/g;
        let cm: RegExpExecArray | null;
        const constStr = args || '';
        while ((cm = constRe.exec(constStr)) !== null) {
          symbols.push({
            symbol_type: 'const_object',
            name: cm[1],
            value: 'constant',
            line_start: lineStart,
            is_exported: true,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. Subroutines (sub)
    // ══════════════════════════════════════════════
    const subRe = /^(\s*)sub\s+(\w+)(?:\s*\(([^)]*)\))?\s*\{/gm;
    while ((m = subRe.exec(content)) !== null) {
      const indent = m[1].length;
      const name = m[2];
      const prototype = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const parentPkg = this.findParentPackage(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name,
        params: prototype !== undefined ? [prototype] : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
        parent_id: parentPkg,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Method modifiers (before/after/around — Moose)
    // ══════════════════════════════════════════════
    const modifierRe = /^(\s*)(before|after|around)\s+['"](\w+)['"]\s*=>/gm;
    while ((m = modifierRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: `${m[2]} ${m[3]}`,
        value: m[2],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
      references.push({
        symbol_name: m[3],
        line_number: lineAt(content, m.index),
        context: `${m[2]} '${m[3]}' => ...`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Moose/Moo attributes (has)
    // ══════════════════════════════════════════════
    const hasRe = /^(\s*)has\s+['"](\w+)['"]\s*=>\s*\(([^)]*)\)/gm;
    while ((m = hasRe.exec(content)) !== null) {
      const name = m[2];
      const attrs = m[3];
      const lineStart = lineAt(content, m.index);

      // Extract isa
      const isaMatch = attrs.match(/isa\s*=>\s*['"](\w+)['"]/);
      const isReq = /is\s*=>\s*['"](?:rw|ro|bare)['"]/.test(attrs);

      symbols.push({
        symbol_type: 'variable',
        name,
        value: isaMatch ? isaMatch[1] : 'attribute',
        return_type: isaMatch ? isaMatch[1] : undefined,
        line_start: lineStart,
        is_exported: isReq,
      });

      if (isaMatch) {
        references.push({
          symbol_name: isaMatch[1],
          line_number: lineStart,
          context: `has '${name}' => (isa => '${isaMatch[1]}')`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Extends / With (inheritance / roles)
    // ══════════════════════════════════════════════
    const extendsRe = /^(\s*)(extends|with)\s+['"]([^'"]+)['"]/gm;
    while ((m = extendsRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      references.push({
        symbol_name: m[3].split('::').pop() || m[3],
        line_number: lineStart,
        context: `${m[2]} '${m[3]}'`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 7. Our / My / Local declarations (top-level only)
    // ══════════════════════════════════════════════
    const varDeclRe = /^(our|my|local)\s+(\$[\w:]+(?:\s*,\s*\$[\w:]+)*)\s*(?:=\s*(.+))?;/gm;
    while ((m = varDeclRe.exec(content)) !== null) {
      const scope = m[1];
      const vars = m[2].split(',').map(v => v.trim());
      const value = m[3] ? m[3].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      for (const v of vars) {
        symbols.push({
          symbol_type: 'variable',
          name: v.replace(/^\$/, ''),
          value: value || scope,
          line_start: lineStart,
          is_exported: scope === 'our',
        });
      }
    }

    // Our arrays and hashes
    const ourArrRe = /^our\s+(@|%)(\w+)/gm;
    while ((m = ourArrRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `${m[1]}${m[2]}`,
        value: m[1] === '@' ? 'array' : 'hash',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. BEGIN / END / INIT blocks
    // ══════════════════════════════════════════════
    const blockRe = /^(BEGIN|END|INIT|CHECK|UNITCHECK)\s*\{/gm;
    while ((m = blockRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'block',
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 9. @EXPORT / @EXPORT_OK
    // ══════════════════════════════════════════════
    const exportRe = /our\s+@(EXPORT(?:_OK)?)\s*=\s*qw\(([^)]*)\)/gm;
    while ((m = exportRe.exec(content)) !== null) {
      const exportType = m[1];
      const exports = m[2].trim().split(/\s+/).filter(Boolean);
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'export',
        name: `@${exportType}`,
        value: exports.join(', ').slice(0, 200),
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
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
    // 11. POD documentation (=head1 ... =cut)
    // ══════════════════════════════════════════════
    const podRe = /^=head[12]\s+(.+)[\s\S]*?(?=^=cut|^=head|$(?![\s\S]))/gm;
    while ((m = podRe.exec(content)) !== null) {
      const title = m[1].trim();
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: title.slice(0, 500),
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

  private findParentPackage(content: string, pos: number): string | undefined {
    const before = content.substring(0, pos);
    const pkgMatch = before.match(/package\s+([\w:]+)\s*;[^;]*$/);
    return pkgMatch ? pkgMatch[1] : undefined;
  }
}

export const perlParser = new PerlParser();
