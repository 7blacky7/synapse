/**
 * MODUL: Shell Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Shell-Skripten
 *
 * EXTRAHIERT: function, variable (assignment/export), source/., alias,
 *             shebang, comment, todo
 * ANSATZ: Regex-basiert — Shell hat einfache Deklarations-Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ShellParser implements LanguageParser {
  language = 'shell';
  extensions = ['.sh', '.bash', '.zsh', '.fish'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;
    const isFish = filePath.endsWith('.fish');

    // ══════════════════════════════════════════════
    // 1. Shebang
    // ══════════════════════════════════════════════
    const shebangRe = /^#!\s*(.+)/;
    m = shebangRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: m[1].trim(),
        line_start: 1,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Functions
    // ══════════════════════════════════════════════
    if (isFish) {
      // fish: function name
      const fishFuncRe = /^function\s+(\w+)(?:\s+--description\s+'([^']*)')?/gm;
      while ((m = fishFuncRe.exec(content)) !== null) {
        const name = m[1];
        const desc = m[2] || undefined;
        const lineStart = lineAt(content, m.index);
        const lineEnd = this.findFishEnd(lines, lineStart - 1);

        symbols.push({
          symbol_type: 'function',
          name,
          value: desc,
          line_start: lineStart,
          line_end: lineEnd,
          is_exported: true,
        });
      }
    } else {
      // bash/zsh: function name() { or name() {
      const funcRe = /^(?:function\s+)?(\w+)\s*\(\s*\)\s*\{/gm;
      while ((m = funcRe.exec(content)) !== null) {
        const name = m[1];
        const lineStart = lineAt(content, m.index);
        const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

        symbols.push({
          symbol_type: 'function',
          name,
          line_start: lineStart,
          line_end: lineEnd,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Variable Assignments
    // ══════════════════════════════════════════════
    if (isFish) {
      // fish: set -g / set -gx / set -l
      const fishSetRe = /^set\s+(?:-([gxlu]+)\s+)*(\w+)\s+(.*)/gm;
      while ((m = fishSetRe.exec(content)) !== null) {
        const flags = m[1] || '';
        const name = m[2];
        const value = m[3].trim().slice(0, 200);
        const isExported = flags.includes('x') || flags.includes('g');

        symbols.push({
          symbol_type: 'variable',
          name,
          value,
          line_start: lineAt(content, m.index),
          is_exported: isExported,
        });
      }
    } else {
      // bash/zsh: export VAR=value
      const exportRe = /^export\s+(\w+)(?:=(.*))?/gm;
      while ((m = exportRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'export',
          name: m[1],
          value: m[2] ? m[2].trim().slice(0, 200) : undefined,
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }

      // VAR=value (top-level, ohne export)
      const assignRe = /^(\w+)=(.+)/gm;
      while ((m = assignRe.exec(content)) !== null) {
        const name = m[1];
        // Skip wenn in Funktion (eingerückt)
        const lineIdx = lineAt(content, m.index) - 1;
        if (lineIdx < lines.length && lines[lineIdx].match(/^\S/)) {
          symbols.push({
            symbol_type: 'variable',
            name,
            value: m[2].trim().slice(0, 200),
            line_start: lineIdx + 1,
            is_exported: false,
          });
        }
      }

      // readonly / declare / local / typeset
      const declareRe = /^(readonly|declare|typeset)\s+(?:-\w+\s+)*(\w+)(?:=(.*))?/gm;
      while ((m = declareRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'variable',
          name: m[2],
          value: m[3] ? m[3].trim().slice(0, 200) : m[1],
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Source / Include
    // ══════════════════════════════════════════════
    const sourceRe = /^(?:source|\.)(?:\s+)["']?([^\s"']+)["']?/gm;
    while ((m = sourceRe.exec(content)) !== null) {
      const file = m[1];
      const name = file.split('/').pop() || file;
      symbols.push({
        symbol_type: 'import',
        name,
        value: file,
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
    // 5. Aliases
    // ══════════════════════════════════════════════
    const aliasRe = /^alias\s+(\w+)=['"]?([^'";\n]+)/gm;
    while ((m = aliasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: `alias: ${m[2].trim()}`.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      // Skip shebang
      if (m.index === 0 && m[0].startsWith('#!')) continue;
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Block-Kommentare (zusammenhaengende #-Zeilen)
    // ══════════════════════════════════════════════
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#') && !line.startsWith('#!') && !line.match(/^#\s*(TODO|FIXME|HACK)/i)) {
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

  /** fish: function ... end */
  private findFishEnd(lines: string[], startIdx: number): number {
    let depth = 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/^(function|if|for|while|switch|begin)\b/.test(line)) depth++;
      if (/^end\b/.test(line)) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return lines.length;
  }
}

export const shellParser = new ShellParser();
