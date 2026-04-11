/**
 * MODUL: YAML Parser
 * ZWECK: Extrahiert Struktur-Informationen aus YAML-Dateien
 *
 * EXTRAHIERT: top-level keys (als variable), nested sections,
 *             anchors (&), aliases (*), comments, todo
 * ANSATZ: Regex-basiert — YAML hat einrueckungsbasierte Struktur
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

class YamlParser implements LanguageParser {
  language = 'yaml';
  extensions = ['.yaml', '.yml'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');

    let currentParent: string | undefined;
    let parentIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Skip empty lines and document separators
      if (!trimmed || trimmed === '---' || trimmed === '...') continue;

      // Comments
      if (trimmed.startsWith('#')) {
        // TODO / FIXME / HACK
        const todoMatch = trimmed.match(/^#\s*(TODO|FIXME|HACK):?\s*(.*)/i);
        if (todoMatch) {
          symbols.push({
            symbol_type: 'todo',
            name: null,
            value: trimmed,
            line_start: lineNum,
            is_exported: false,
          });
        }
        continue;
      }

      // Key-value pairs
      const kvMatch = line.match(/^(\s*)([\w.-]+)\s*:(.*)/);
      if (kvMatch) {
        const indent = kvMatch[1].length;
        const key = kvMatch[2];
        const rest = kvMatch[3].trim();

        // Track parent hierarchy
        if (indent === 0) {
          currentParent = undefined;
          parentIndent = -1;
        } else if (indent > parentIndent + 2) {
          // Deeper nested — find parent
          for (let j = i - 1; j >= 0; j--) {
            const prevLine = lines[j];
            const prevTrimmed = prevLine.trim();
            if (!prevTrimmed || prevTrimmed.startsWith('#')) continue;
            const prevMatch = prevLine.match(/^(\s*)([\w.-]+)\s*:/);
            if (prevMatch && prevMatch[1].length < indent) {
              currentParent = prevMatch[2];
              parentIndent = prevMatch[1].length;
              break;
            }
          }
        }

        // Determine value
        let value: string | undefined;
        if (rest && !rest.startsWith('#') && rest !== '|' && rest !== '>' && rest !== '|-' && rest !== '>-') {
          value = rest.replace(/#.*$/, '').trim().slice(0, 200);
        }

        // Check for anchors
        const anchorMatch = rest.match(/&(\w+)/);
        if (anchorMatch) {
          symbols.push({
            symbol_type: 'variable',
            name: `&${anchorMatch[1]}`,
            value: 'anchor',
            line_start: lineNum,
            is_exported: true,
          });
        }

        // Check for aliases
        const aliasMatch = rest.match(/\*(\w+)/);
        if (aliasMatch) {
          references.push({
            symbol_name: `&${aliasMatch[1]}`,
            line_number: lineNum,
            context: `${key}: *${aliasMatch[1]}`,
          });
        }

        // Is this a section header (has children, no value)?
        const isSection = !value && !rest;

        symbols.push({
          symbol_type: isSection && indent === 0 ? 'class' : 'variable',
          name: key,
          value: value || (isSection ? 'section' : undefined),
          line_start: lineNum,
          is_exported: indent === 0,
          parent_id: indent > 0 ? currentParent : undefined,
        });

        if (indent === 0) {
          currentParent = key;
          parentIndent = 0;
        }
      }
    }

    // Collect block comments
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#') && !line.match(/^#\s*(TODO|FIXME|HACK)/i)) {
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
}

export const yamlParser = new YamlParser();
