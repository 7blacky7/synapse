/**
 * MODUL: Puppet Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Puppet-Dateien (.pp)
 *
 * EXTRAHIERT: class, define (defined types), node, resource declarations,
 *             include/require/contain, variable assignments, function,
 *             type alias, inherits, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class PuppetParser implements LanguageParser {
  language = 'puppet';
  extensions = ['.pp'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Class
    // ══════════════════════════════════════════════
    const classRe = /^class\s+([\w:]+)(?:\s*\(([^)]*)\))?(?:\s+inherits\s+([\w:]+))?\s*\{/gm;
    while ((m = classRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const parent = m[3];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        ? paramsRaw.split(',').map(p => p.trim().replace(/^\$/, '').split(/[=:]/).shift()?.trim() || '').filter(Boolean)
        : undefined;

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'class',
        params: parent ? [...(params || []), `inherits ${parent}`] : params,
        line_start: lineStart,
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `class ${name} inherits ${parent}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 2. Define (defined type)
    // ══════════════════════════════════════════════
    const defineRe = /^define\s+([\w:]+)(?:\s*\(([^)]*)\))?\s*\{/gm;
    while ((m = defineRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2]
        ? m[2].split(',').map(p => p.trim().replace(/^\$/, '').split(/[=:]/).shift()?.trim() || '').filter(Boolean)
        : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'define',
        params,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Node
    // ══════════════════════════════════════════════
    const nodeRe = /^node\s+['"]?([^'"{\s]+)['"]?\s*\{/gm;
    while ((m = nodeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'node',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Resource declarations
    // ══════════════════════════════════════════════
    const resourceRe = /^\s*([\w:]+)\s*\{\s*['"]([^'"]+)['"]\s*:/gm;
    while ((m = resourceRe.exec(content)) !== null) {
      const resourceType = m[1];
      const title = m[2];

      // Skip if it's a variable or keyword
      if (['if', 'elsif', 'else', 'unless', 'case', 'class', 'define', 'node'].includes(resourceType)) continue;
      if (resourceType.startsWith('$')) continue;

      symbols.push({
        symbol_type: 'variable',
        name: `${resourceType}[${title}]`,
        value: resourceType,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Include / Require / Contain
    // ══════════════════════════════════════════════
    const inclRe = /^\s*(include|require|contain)\s+([\w:]+)/gm;
    while ((m = inclRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[2],
        line_number: lineAt(content, m.index),
        context: `${m[1]} ${m[2]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 6. Variable assignments (top-level)
    // ══════════════════════════════════════════════
    const varRe = /^\s*\$([\w:]+)\s*=\s*(.+)/gm;
    while ((m = varRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `$${m[1]}`,
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Function definitions (Puppet 4+)
    // ══════════════════════════════════════════════
    const funcRe = /^function\s+([\w:]+)\s*\(([^)]*)\)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => p.trim().replace(/^\$/, '').split(/[=:]/).shift()?.trim() || '').filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'function',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Type alias (Puppet 4+)
    // ══════════════════════════════════════════════
    const typeRe = /^type\s+([\w:]+)\s*=\s*(.+)/gm;
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
    // 9. TODO / FIXME / HACK
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

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }
}

export const puppetParser = new PuppetParser();
