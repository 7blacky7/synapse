/**
 * MODUL: CSS/SCSS/LESS Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Stylesheets
 *
 * EXTRAHIERT: selectors, @import, @mixin, @include, $variables, --custom-properties,
 *             @media, @keyframes, @font-face, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

class CssParser implements LanguageParser {
  language = 'css';
  extensions = ['.css', '.scss', '.less', '.sass'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;
    const isScss = /\.scss$/.test(filePath);
    const isLess = /\.less$/.test(filePath);

    // ══════════════════════════════════════════════
    // 1. @import / @use / @forward
    // ══════════════════════════════════════════════
    const importRe = /^@(import|use|forward)\s+['"]([^'"]+)['"]/gm;
    while ((m = importRe.exec(content)) !== null) {
      const kind = m[1];
      const path = m[2];
      const name = path.split('/').pop()?.replace(/^_/, '').replace(/\.(?:css|scss|less)$/, '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: path,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: `@${kind} '${path}'`,
      });
    }

    // ══════════════════════════════════════════════
    // 2. SCSS $variables / LESS @variables
    // ══════════════════════════════════════════════
    if (isScss) {
      const scssVarRe = /^(\$[\w-]+)\s*:\s*([^;]+);/gm;
      while ((m = scssVarRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'variable',
          name: m[1],
          value: m[2].trim().slice(0, 200),
          line_start: lineAt(content, m.index),
          is_exported: !m[2].includes('!default') || true,
        });
      }
    }

    if (isLess) {
      const lessVarRe = /^(@[\w-]+)\s*:\s*([^;]+);/gm;
      while ((m = lessVarRe.exec(content)) !== null) {
        // Skip @media, @import etc.
        if (m[1].startsWith('@media') || m[1].startsWith('@import') || m[1].startsWith('@keyframes')) continue;
        symbols.push({
          symbol_type: 'variable',
          name: m[1],
          value: m[2].trim().slice(0, 200),
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }
    }

    // CSS Custom Properties (--var)
    const customPropRe = /(--[\w-]+)\s*:\s*([^;]+);/gm;
    while ((m = customPropRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. @mixin (SCSS) / .mixin() (LESS)
    // ══════════════════════════════════════════════
    if (isScss) {
      const mixinRe = /^@mixin\s+([\w-]+)\s*(?:\(([^)]*)\))?\s*\{/gm;
      while ((m = mixinRe.exec(content)) !== null) {
        const params = m[2] ? m[2].split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean) : [];
        symbols.push({
          symbol_type: 'function',
          name: m[1],
          value: 'mixin',
          params,
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }
    }

    // @include references (SCSS)
    if (isScss) {
      const includeRe = /^\s*@include\s+([\w-]+)/gm;
      while ((m = includeRe.exec(content)) !== null) {
        references.push({
          symbol_name: m[1],
          line_number: lineAt(content, m.index),
          context: `@include ${m[1]}`,
        });
      }
    }

    // SCSS %placeholder
    if (isScss) {
      const placeholderRe = /^%([\w-]+)\s*\{/gm;
      while ((m = placeholderRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'class',
          name: `%${m[1]}`,
          value: 'placeholder',
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }
    }

    // @extend references
    const extendRe = /^\s*@extend\s+([.%#][\w-]+)/gm;
    while ((m = extendRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `@extend ${m[1]}`,
      });
    }

    // ══════════════════════════════════════════════
    // 4. @keyframes
    // ══════════════════════════════════════════════
    const keyframesRe = /^@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/gm;
    while ((m = keyframesRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'keyframes',
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. @media Queries
    // ══════════════════════════════════════════════
    const mediaRe = /^@media\s+([^\n{]+)\s*\{/gm;
    while ((m = mediaRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: '@media',
        value: m[1].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 6. @font-face
    // ══════════════════════════════════════════════
    const fontFaceRe = /^@font-face\s*\{([\s\S]*?)\}/gm;
    while ((m = fontFaceRe.exec(content)) !== null) {
      const familyMatch = m[1].match(/font-family\s*:\s*['"]?([^;'"]+)/);
      symbols.push({
        symbol_type: 'variable',
        name: '@font-face',
        value: familyMatch ? familyMatch[1].trim() : undefined,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Top-Level Selectors (Classes, IDs, Elements)
    // ══════════════════════════════════════════════
    const selectorRe = /^([.#]?[\w-][\w\-\s,.:>#~+[\]=*()]+?)\s*\{/gm;
    while ((m = selectorRe.exec(content)) !== null) {
      const selector = m[1].trim();
      // Skip @-rules (already handled)
      if (selector.startsWith('@') || selector.startsWith('$') || selector.startsWith('//')) continue;
      // Skip too generic ones
      if (['from', 'to'].includes(selector)) continue;

      symbols.push({
        symbol_type: 'class',
        name: selector,
        value: 'selector',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /\/[/*]\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 9. Block-Kommentare (/* ... */)
    // ══════════════════════════════════════════════
    const blockCommentRe = /\/\*([\s\S]*?)\*\//g;
    while ((m = blockCommentRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
      if (text.length < 3) continue;
      // Skip TODO/FIXME already handled
      if (/^(TODO|FIXME|HACK)/i.test(text)) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }
}

export const cssParser = new CssParser();
