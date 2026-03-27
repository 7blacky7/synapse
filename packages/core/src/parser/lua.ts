/**
 * MODUL: Lua Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Lua-Dateien
 *
 * EXTRAHIERT: function (global/local/method), local variable, table,
 *             require, module, comment, todo
 * ANSATZ: Regex-basiert — Lua hat minimale, klare Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class LuaParser implements LanguageParser {
  language = 'lua';
  extensions = ['.lua'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. require
    // ══════════════════════════════════════════════
    const requireRe = /(?:local\s+(\w+)\s*=\s*)?require\s*\(?['"]([^'"]+)['"]\)?/g;
    while ((m = requireRe.exec(content)) !== null) {
      const alias = m[1] || m[2].split(/[./]/).pop() || m[2];
      symbols.push({
        symbol_type: 'import',
        name: alias,
        value: m[2],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: alias,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Functions
    // ══════════════════════════════════════════════
    // Global: function name(...)
    const globalFuncRe = /^function\s+([\w.]+)\s*\(([^)]*)\)/gm;
    while ((m = globalFuncRe.exec(content)) !== null) {
      const fullName = m[1];
      const paramsRaw = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1);

      const parts = fullName.split('.');
      const name = parts[parts.length - 1];
      const parent = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;

      const params = paramsRaw.split(',').map(p => p.trim()).filter(p => p && p !== '...');

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
        parent_id: parent,
      });
    }

    // Method: function name:method(...)
    const methodRe = /^function\s+(\w+):(\w+)\s*\(([^)]*)\)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const parent = m[1];
      const name = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1);

      const params = paramsRaw.split(',').map(p => p.trim()).filter(p => p && p !== '...');

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
        parent_id: parent,
      });

      references.push({
        symbol_name: parent,
        line_number: lineStart,
        context: `function ${parent}:${name}(...)`,
      });
    }

    // Local: local function name(...)
    const localFuncRe = /^local\s+function\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((m = localFuncRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1);

      const params = paramsRaw.split(',').map(p => p.trim()).filter(p => p && p !== '...');

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: false,
      });
    }

    // Anonymous function assignment: name = function(...)
    const anonFuncRe = /^(local\s+)?(\w+(?:\.\w+)*)\s*=\s*function\s*\(([^)]*)\)/gm;
    while ((m = anonFuncRe.exec(content)) !== null) {
      const isLocal = !!m[1];
      const fullName = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(lines, lineStart - 1);

      const parts = fullName.split('.');
      const name = parts[parts.length - 1];
      const parent = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;

      const params = paramsRaw.split(',').map(p => p.trim()).filter(p => p && p !== '...');

      // Skip if already found as global function
      if (symbols.some(s => s.name === name && s.line_start === lineStart)) continue;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !isLocal,
        parent_id: parent,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Local Variables / Tables
    // ══════════════════════════════════════════════
    const localVarRe = /^local\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = localVarRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim();

      // Skip function assignments (already handled)
      if (value.startsWith('function')) continue;
      if (value === 'require') continue;

      const isTable = value.startsWith('{');

      symbols.push({
        symbol_type: 'variable',
        name,
        value: isTable ? 'table' : value.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // Global assignments (top-level): NAME = value
    const globalVarRe = /^(\w+)\s*=\s*(.+)/gm;
    while ((m = globalVarRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim();

      if (value.startsWith('function') || name === 'local' || name === 'return') continue;
      if (symbols.some(s => s.name === name && s.line_start === lineAt(content, m!.index))) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value.startsWith('{') ? 'table' : value.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Module pattern: M = {} ... return M
    // ══════════════════════════════════════════════
    const moduleRe = /^local\s+(\w+)\s*=\s*\{\s*\}/m;
    const returnRe = /^return\s+(\w+)\s*$/m;
    const modMatch = moduleRe.exec(content);
    const retMatch = returnRe.exec(content);
    if (modMatch && retMatch && modMatch[1] === retMatch[1]) {
      symbols.push({
        symbol_type: 'export',
        name: modMatch[1],
        value: 'module',
        line_start: lineAt(content, modMatch.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. TODO / FIXME / HACK
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
    // 6. Block-Kommentare (--[[ ... ]])
    // ══════════════════════════════════════════════
    const blockCommentRe = /--\[\[([\s\S]*?)\]\]/g;
    while ((m = blockCommentRe.exec(content)) !== null) {
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

    // Zusammenhaengende -- Kommentare
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('--') && !line.startsWith('--[[') && !line.match(/^--\s*(TODO|FIXME|HACK)/i)) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(line.replace(/^--\s?/, ''));
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

  /** Findet das passende 'end' */
  private findEnd(lines: string[], startIdx: number): number {
    let depth = 1;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/\b(function|if|for|while|repeat)\b/.test(line) && !/^--/.test(line)) {
        // Count openers (but not in strings/comments)
        const cleaned = line.replace(/--.*$/, '').replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
        if (/\b(function|if|for|while)\b/.test(cleaned)) depth++;
      }
      if (/\bend\b/.test(line) && !/^--/.test(line)) {
        depth--;
        if (depth === 0) return i + 1;
      }
    }
    return lines.length;
  }
}

export const luaParser = new LuaParser();
