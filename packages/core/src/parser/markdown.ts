/**
 * MODUL: Markdown Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Markdown-Dateien
 *
 * EXTRAHIERT: Headings (als function), Code-Blocks, Links/Referenzen,
 *             YAML Frontmatter Keys, TODOs, Inline-Code-Referenzen
 * ANSATZ: Regex-basiert — Markdown hat zeilenbasierte Struktur
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

class MarkdownParser implements LanguageParser {
  language = 'markdown';
  extensions = ['.md', '.mdx'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');

    let inCodeBlock = false;
    let codeBlockStart = 0;
    let codeBlockLang = '';
    let inFrontmatter = false;
    let frontmatterStart = 0;
    let currentHeading: string | undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // YAML Frontmatter (--- am Anfang der Datei)
      if (trimmed === '---' && (i === 0 || inFrontmatter)) {
        if (!inFrontmatter && i === 0) {
          inFrontmatter = true;
          frontmatterStart = lineNum;
          continue;
        }
        if (inFrontmatter) {
          inFrontmatter = false;
          continue;
        }
      }

      // Frontmatter Keys
      if (inFrontmatter) {
        const fmMatch = trimmed.match(/^([\w.-]+)\s*:\s*(.*)/);
        if (fmMatch) {
          symbols.push({
            symbol_type: 'variable',
            name: fmMatch[1],
            value: fmMatch[2] || undefined,
            line_start: lineNum,
            is_exported: false,
          });
        }
        continue;
      }

      // Code-Block Start/End (```)
      if (trimmed.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockStart = lineNum;
          codeBlockLang = trimmed.substring(3).trim().split(/\s/)[0] || '';
          symbols.push({
            symbol_type: 'string',
            name: codeBlockLang || 'code',
            value: `code-block:${codeBlockLang}`,
            line_start: lineNum,
            is_exported: false,
          });
        } else {
          // Code-Block Ende — line_end setzen
          const blockSymbol = symbols.find(
            s => s.symbol_type === 'string' && s.line_start === codeBlockStart
          );
          if (blockSymbol) blockSymbol.line_end = lineNum;
          inCodeBlock = false;
        }
        continue;
      }

      // Innerhalb Code-Block — Referenzen auf Funktionen/Variablen extrahieren
      if (inCodeBlock) {
        // Funktions-Aufrufe in Code-Blocks als Referenzen
        const funcCalls = trimmed.matchAll(/\b([a-zA-Z_]\w{2,})\s*\(/g);
        for (const m of funcCalls) {
          references.push({
            symbol_name: m[1],
            line_number: lineNum,
            context: trimmed.substring(0, 80),
          });
        }
        continue;
      }

      // Headings (# ## ### etc.)
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const title = headingMatch[2].replace(/\s*#+\s*$/, '').trim();
        currentHeading = title;
        symbols.push({
          symbol_type: 'function',
          name: title,
          value: `h${level}`,
          line_start: lineNum,
          is_exported: level <= 2,
          params: [`level:${level}`],
        });
        continue;
      }

      // TODO / FIXME / HACK in Kommentaren oder Text
      const todoMatch = trimmed.match(/\b(TODO|FIXME|HACK|XXX):?\s*(.*)/i);
      if (todoMatch) {
        symbols.push({
          symbol_type: 'todo',
          name: null,
          value: trimmed,
          line_start: lineNum,
          is_exported: false,
        });
      }

      // Links: [text](url) und [text][ref]
      const linkMatches = trimmed.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g);
      for (const m of linkMatches) {
        references.push({
          symbol_name: m[1],
          line_number: lineNum,
          context: m[2],
        });
      }

      // Reference-style Links: [text][ref-id]
      const refLinkMatches = trimmed.matchAll(/\[([^\]]+)\]\[([^\]]+)\]/g);
      for (const m of refLinkMatches) {
        references.push({
          symbol_name: m[2],
          line_number: lineNum,
          context: `ref:${m[1]}`,
        });
      }

      // Inline-Code mit Backticks: `functionName` oder `variable`
      const inlineCodeMatches = trimmed.matchAll(/`([a-zA-Z_][\w.]{2,})`/g);
      for (const m of inlineCodeMatches) {
        references.push({
          symbol_name: m[1],
          line_number: lineNum,
          context: trimmed.substring(0, 80),
        });
      }

      // Link-Definitionen: [ref-id]: url
      const linkDefMatch = trimmed.match(/^\[([^\]]+)\]:\s+(.+)/);
      if (linkDefMatch) {
        symbols.push({
          symbol_type: 'variable',
          name: linkDefMatch[1],
          value: linkDefMatch[2],
          line_start: lineNum,
          is_exported: false,
        });
      }
    }

    return { symbols, references };
  }
}

export const markdownParser = new MarkdownParser();
