/**
 * MODUL: Ruby Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Ruby-Dateien
 *
 * EXTRAHIERT: class, module, def, attr_*, require, include/extend,
 *             constant, comment, todo
 * ANSATZ: Regex-basiert — Ruby hat klare Keyword-basierte Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class RubyParser implements LanguageParser {
  language = 'ruby';
  extensions = ['.rb', '.rake', '.gemspec'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. require / require_relative
    // ══════════════════════════════════════════════
    const requireRe = /^(require(?:_relative)?)\s+['"]([^'"]+)['"]/gm;
    while ((m = requireRe.exec(content)) !== null) {
      const name = m[2].split('/').pop() || m[2];
      symbols.push({
        symbol_type: 'import',
        name,
        value: m[2],
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
    // 2. Modules
    // ══════════════════════════════════════════════
    const moduleRe = /^(\s*)module\s+(\w+(?:::\w+)*)/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1, m[1].length);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'module',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Classes
    // ══════════════════════════════════════════════
    const classRe = /^(\s*)class\s+(\w+(?:::\w+)*)(?:\s*<\s*(\w+(?:::\w+)*))?/gm;
    while ((m = classRe.exec(content)) !== null) {
      const name = m[2];
      const parent = m[3] || null;
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1, m[1].length);

      symbols.push({
        symbol_type: 'class',
        name,
        value: parent ? `< ${parent}` : undefined,
        params: parent ? [parent] : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (parent) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `class ${name} < ${parent}`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methods (def)
    // ══════════════════════════════════════════════
    const defRe = /^(\s*)def\s+(self\.)?(\w+[?!=]?)(?:\(([^)]*)\))?/gm;
    while ((m = defRe.exec(content)) !== null) {
      const indent = m[1].length;
      const isSelf = !!m[2];
      const name = m[3];
      const paramsRaw = m[4] || '';
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1, indent);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/[=:]/)[0].replace(/[*&]/, '').trim())
        .filter(Boolean);

      const parentClass = this.findParentClass(lines, lineStart - 1, indent);

      symbols.push({
        symbol_type: 'function',
        name: isSelf ? `self.${name}` : name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !name.startsWith('_'),
        parent_id: parentClass,
      });
    }

    // ══════════════════════════════════════════════
    // 5. attr_accessor / attr_reader / attr_writer
    // ══════════════════════════════════════════════
    const attrRe = /^(\s*)(attr_(?:accessor|reader|writer))\s+(.+)/gm;
    while ((m = attrRe.exec(content)) !== null) {
      const kind = m[2];
      const attrs = m[3].split(',').map(s => s.trim().replace(/^:/, '')).filter(Boolean);
      const lineStart = lineAt(content, m.index);
      const parentClass = this.findParentClass(lines, lineStart - 1, m[1].length);

      for (const attr of attrs) {
        symbols.push({
          symbol_type: 'variable',
          name: attr,
          value: kind,
          line_start: lineStart,
          is_exported: true,
          parent_id: parentClass,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Constants (UPPERCASE)
    // ══════════════════════════════════════════════
    const constRe = /^(\s*)([A-Z][A-Z0-9_]+)\s*=\s*(.+)/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. include / extend / prepend
    // ══════════════════════════════════════════════
    const includeRe = /^\s*(include|extend|prepend)\s+(\w+(?:::\w+)*)/gm;
    while ((m = includeRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[2],
        line_number: lineAt(content, m.index),
        context: `${m[1]} ${m[2]}`,
      });
    }

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
    // 9. Block-Kommentare
    // ══════════════════════════════════════════════
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#') && !line.match(/^#\s*(TODO|FIXME|HACK)/i) && !line.startsWith('#!')) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(line.replace(/^#\s?/, ''));
      } else {
        if (commentBlock.length >= 2) {
          symbols.push({
            symbol_type: 'comment',
            name: null,
            value: commentBlock.join(' ').trim().slice(0, 500),
            line_start: commentStart,
            line_end: commentStart + commentBlock.length - 1,
            is_exported: false,
          });
        }
        commentBlock = [];
      }
    }
    if (commentBlock.length >= 2) {
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: commentBlock.join(' ').trim().slice(0, 500),
        line_start: commentStart,
        line_end: commentStart + commentBlock.length - 1,
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }

  /** Findet das passende 'end' fuer einen Block */
  private findEnd(lines: string[], startIdx: number, startIndent: number): number {
    let depth = 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      if (/^(class|module|def|do|if|unless|case|while|until|for|begin)\b/.test(line)) depth++;
      if (/^end\b/.test(line)) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return lines.length;
  }

  private findParentClass(lines: string[], lineIdx: number, indent: number): string | undefined {
    for (let i = lineIdx - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.trim()) continue;
      const lineIndent = line.search(/\S/);
      if (lineIndent < indent) {
        const classMatch = line.match(/(?:class|module)\s+(\w+(?:::\w+)*)/);
        if (classMatch) return classMatch[1];
        break;
      }
    }
    return undefined;
  }
}

export const rubyParser = new RubyParser();
