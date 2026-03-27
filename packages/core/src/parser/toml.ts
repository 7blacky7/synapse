/**
 * MODUL: TOML Parser
 * ZWECK: Extrahiert Struktur-Informationen aus TOML-Dateien
 *
 * EXTRAHIERT: sections [table], [[array-of-tables]], key-value pairs,
 *             comment, todo
 * ANSATZ: Regex-basiert — TOML hat klare, zeilenbasierte Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

class TomlParser implements LanguageParser {
  language = 'toml';
  extensions = ['.toml'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let currentSection: string | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      if (!trimmed) continue;

      // Comments
      if (trimmed.startsWith('#')) {
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

      // Array of tables: [[section.name]]
      const arrayTableMatch = trimmed.match(/^\[\[([^\]]+)\]\]/);
      if (arrayTableMatch) {
        const name = arrayTableMatch[1].trim();
        currentSection = name;
        symbols.push({
          symbol_type: 'class',
          name,
          value: 'array-of-tables',
          line_start: lineNum,
          is_exported: true,
        });
        continue;
      }

      // Table: [section.name]
      const tableMatch = trimmed.match(/^\[([^\]]+)\]/);
      if (tableMatch) {
        const name = tableMatch[1].trim();
        currentSection = name;

        // Find section end
        let lineEnd = lineNum;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].trim().match(/^\[/)) {
            lineEnd = j;
            break;
          }
          lineEnd = j + 1;
        }

        symbols.push({
          symbol_type: 'class',
          name,
          value: 'table',
          line_start: lineNum,
          line_end: lineEnd,
          is_exported: true,
        });
        continue;
      }

      // Key-value pairs
      const kvMatch = trimmed.match(/^([\w.-]+)\s*=\s*(.*)/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2].trim()
          .replace(/^["']|["']$/g, '')
          .slice(0, 200);

        symbols.push({
          symbol_type: 'variable',
          name: key,
          value,
          line_start: lineNum,
          is_exported: !currentSection,
          parent_id: currentSection,
        });
      }
    }

    // Block comments
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

    return { symbols, references };
  }
}

export const tomlParser = new TomlParser();
