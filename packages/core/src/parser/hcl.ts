/**
 * MODUL: HCL/Terraform Parser
 * ZWECK: Extrahiert Struktur-Informationen aus HCL/Terraform-Dateien (.tf, .hcl)
 *
 * EXTRAHIERT: resource, data, variable, output, module, provider, locals,
 *             terraform block, backend, provisioner, dynamic block,
 *             moved block, import block, attribute assignments,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class HclParser implements LanguageParser {
  language = 'hcl';
  extensions = ['.tf', '.hcl'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Terraform block
    // ══════════════════════════════════════════════
    const terraformRe = /^terraform\s*\{/gm;
    m = terraformRe.exec(content);
    if (m) {
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);
      symbols.push({
        symbol_type: 'class',
        name: 'terraform',
        value: 'terraform',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Extract required_providers
      const block = content.substring(m.index, content.indexOf('}', m.index + m[0].length) + 1);
      const reqRe = /required_providers\s*\{([^}]*)\}/s;
      const reqMatch = reqRe.exec(block);
      if (reqMatch) {
        const provRe = /(\w+)\s*=\s*\{[^}]*source\s*=\s*"([^"]+)"/g;
        let pm: RegExpExecArray | null;
        while ((pm = provRe.exec(reqMatch[1])) !== null) {
          references.push({
            symbol_name: pm[1],
            line_number: lineStart,
            context: `required_provider ${pm[1]} = ${pm[2]}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 2. Provider
    // ══════════════════════════════════════════════
    const providerRe = /^provider\s+"(\w+)"\s*\{/gm;
    while ((m = providerRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'provider',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Resource
    // ══════════════════════════════════════════════
    const resourceRe = /^resource\s+"([\w_]+)"\s+"([\w_-]+)"\s*\{/gm;
    while ((m = resourceRe.exec(content)) !== null) {
      const resourceType = m[1];
      const resourceName = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name: `${resourceType}.${resourceName}`,
        value: 'resource',
        params: [resourceType],
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Parse attributes inside
      this.parseAttributes(content, m.index + m[0].length, lineEnd,
        `${resourceType}.${resourceName}`, symbols, references);
    }

    // ══════════════════════════════════════════════
    // 4. Data source
    // ══════════════════════════════════════════════
    const dataRe = /^data\s+"([\w_]+)"\s+"([\w_-]+)"\s*\{/gm;
    while ((m = dataRe.exec(content)) !== null) {
      const dataType = m[1];
      const dataName = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name: `data.${dataType}.${dataName}`,
        value: 'data',
        params: [dataType],
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Variable
    // ══════════════════════════════════════════════
    const varRe = /^variable\s+"([\w_-]+)"\s*\{/gm;
    while ((m = varRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      // Extract type and default from block
      const block = content.substring(m.index + m[0].length);
      const typeMatch = block.match(/^\s*type\s*=\s*(.+)/m);
      const defaultMatch = block.match(/^\s*default\s*=\s*(.+)/m);
      const descMatch = block.match(/^\s*description\s*=\s*"([^"]+)"/m);

      const varType = typeMatch ? typeMatch[1].trim() : undefined;
      const defaultVal = defaultMatch ? defaultMatch[1].trim().slice(0, 100) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name: `var.${name}`,
        value: defaultVal || varType || 'variable',
        return_type: varType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (descMatch) {
        symbols.push({
          symbol_type: 'comment',
          name: null,
          value: descMatch[1].slice(0, 500),
          line_start: lineStart,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Output
    // ══════════════════════════════════════════════
    const outputRe = /^output\s+"([\w_-]+)"\s*\{/gm;
    while ((m = outputRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const block = content.substring(m.index + m[0].length);
      const valueMatch = block.match(/^\s*value\s*=\s*(.+)/m);
      const value = valueMatch ? valueMatch[1].trim().slice(0, 200) : 'output';

      symbols.push({
        symbol_type: 'export',
        name: `output.${name}`,
        value,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+"([\w_-]+)"\s*\{/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const block = content.substring(m.index + m[0].length);
      const sourceMatch = block.match(/^\s*source\s*=\s*"([^"]+)"/m);
      const source = sourceMatch ? sourceMatch[1] : undefined;

      symbols.push({
        symbol_type: 'import',
        name: `module.${name}`,
        value: source || 'module',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (source) {
        references.push({
          symbol_name: source.split('/').pop() || source,
          line_number: lineStart,
          context: `module "${name}" { source = "${source}" }`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 8. Locals
    // ══════════════════════════════════════════════
    const localsRe = /^locals\s*\{/gm;
    while ((m = localsRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      // Extract local values
      const block = content.substring(m.index + m[0].length);
      const localValRe = /^\s*(\w+)\s*=\s*(.+)/gm;
      let lm: RegExpExecArray | null;
      while ((lm = localValRe.exec(block)) !== null) {
        const localLine = lineAt(content, m.index + m[0].length + lm.index);
        if (localLine > lineEnd) break;

        symbols.push({
          symbol_type: 'variable',
          name: `local.${lm[1]}`,
          value: lm[2].trim().slice(0, 200),
          line_start: localLine,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 9. Moved blocks (Terraform 1.1+)
    // ══════════════════════════════════════════════
    const movedRe = /^moved\s*\{/gm;
    while ((m = movedRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      const block = content.substring(m.index + m[0].length);
      const fromMatch = block.match(/^\s*from\s*=\s*(\S+)/m);
      const toMatch = block.match(/^\s*to\s*=\s*(\S+)/m);

      if (fromMatch && toMatch) {
        symbols.push({
          symbol_type: 'variable',
          name: 'moved',
          value: `${fromMatch[1]} → ${toMatch[1]}`,
          line_start: lineStart,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 10. Import blocks (Terraform 1.5+)
    // ══════════════════════════════════════════════
    const importRe = /^import\s*\{/gm;
    while ((m = importRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      const block = content.substring(m.index + m[0].length);
      const toMatch = block.match(/^\s*to\s*=\s*(\S+)/m);
      const idMatch = block.match(/^\s*id\s*=\s*"([^"]+)"/m);

      if (toMatch) {
        symbols.push({
          symbol_type: 'import',
          name: toMatch[1],
          value: idMatch ? `import ${idMatch[1]}` : 'import',
          line_start: lineStart,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /(?:#|\/\/)\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 12. Block-Kommentare (/* ... */)
    // ══════════════════════════════════════════════
    const commentRe = /\/\*([\s\S]*?)\*\//g;
    while ((m = commentRe.exec(content)) !== null) {
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

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }

  private parseAttributes(
    content: string, blockStart: number, blockLineEnd: number,
    parentName: string, symbols: ParsedSymbol[], references: ParsedReference[]
  ): void {
    const block = content.substring(blockStart);
    const lines = block.split('\n');
    let currentLine = lineAt(content, blockStart);
    let depth = 0;

    for (const line of lines) {
      if (currentLine > blockLineEnd) break;
      const trimmed = line.trim();

      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }

      // Only parse top-level attributes (depth 0)
      if (depth === 0 && trimmed) {
        const attrMatch = trimmed.match(/^(\w+)\s*=\s*(.+)/);
        if (attrMatch && !['lifecycle', 'provisioner', 'connection', 'dynamic'].includes(attrMatch[1])) {
          // Extract references to other resources
          const refRe = /([\w_]+)\.([\w_]+)\.([\w_]+)/g;
          let rm: RegExpExecArray | null;
          while ((rm = refRe.exec(attrMatch[2])) !== null) {
            references.push({
              symbol_name: `${rm[1]}.${rm[2]}.${rm[3]}`,
              line_number: currentLine,
              context: `${attrMatch[1]} = ${attrMatch[2]}`.slice(0, 80),
            });
          }

          // Var references
          const varRefRe = /var\.([\w_]+)/g;
          while ((rm = varRefRe.exec(attrMatch[2])) !== null) {
            references.push({
              symbol_name: `var.${rm[1]}`,
              line_number: currentLine,
              context: `${attrMatch[1]} = ${attrMatch[2]}`.slice(0, 80),
            });
          }
        }
      }
      currentLine++;
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
}

export const hclParser = new HclParser();
