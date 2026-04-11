/**
 * MODUL: WGSL Parser
 * ZWECK: Extrahiert Struktur-Informationen aus WebGPU Shader-Dateien (.wgsl)
 *
 * EXTRAHIERT: struct, fn, var/let/const/override, @group/@binding,
 *             @vertex/@fragment/@compute, type aliases, enable directives,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class WgslParser implements LanguageParser {
  language = 'wgsl';
  extensions = ['.wgsl'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Enable directives
    // ══════════════════════════════════════════════
    const enableRe = /^enable\s+([\w,\s]+)\s*;/gm;
    while ((m = enableRe.exec(content)) !== null) {
      const extensions = m[1].split(',').map(e => e.trim()).filter(Boolean);
      for (const ext of extensions) {
        symbols.push({
          symbol_type: 'import',
          name: ext,
          value: 'enable',
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 2. Structs
    // ══════════════════════════════════════════════
    const structRe = /^struct\s+(\w+)\s*\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Parse struct fields
      const block = content.substring(m.index + m[0].length);
      const fieldRe = /^\s*(?:@\w+(?:\([^)]*\))?[\s\n]*)*(\w+)\s*:\s*(\w[\w<>,\s]*)/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(block)) !== null) {
        const fieldLine = lineAt(content, m.index + m[0].length + fm.index);
        if (fieldLine > lineEnd) break;

        symbols.push({
          symbol_type: 'variable',
          name: fm[1],
          value: fm[2].trim(),
          return_type: fm[2].trim(),
          line_start: fieldLine,
          is_exported: true,
          parent_id: name,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Functions (fn)
    // ══════════════════════════════════════════════
    const fnRe = /^((?:@\w+(?:\([^)]*\))?[\s\n]*)*)\s*fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*(\S[^\n{]*))?/gm;
    while ((m = fnRe.exec(content)) !== null) {
      const attributes = m[1];
      const name = m[2];
      const paramsRaw = m[3];
      const returnType = m[4] ? m[4].trim() : undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().replace(/@\w+(?:\([^)]*\))?\s*/g, '').split(':')[0].trim())
        .filter(Boolean);

      // Determine shader stage
      let stage: string | undefined;
      if (/@vertex/.test(attributes)) stage = '@vertex';
      else if (/@fragment/.test(attributes)) stage = '@fragment';
      else if (/@compute/.test(attributes)) stage = '@compute';

      symbols.push({
        symbol_type: 'function',
        name,
        value: stage,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !!stage,
      });

      // Extract workgroup_size for compute shaders
      if (stage === '@compute') {
        const wgsMatch = attributes.match(/@workgroup_size\(([^)]+)\)/);
        if (wgsMatch) {
          symbols.push({
            symbol_type: 'variable',
            name: `${name}.workgroup_size`,
            value: wgsMatch[1].trim(),
            line_start: lineStart,
            is_exported: false,
            parent_id: name,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Global variables (var, let, const, override)
    // ══════════════════════════════════════════════
    const varRe = /^((?:@\w+(?:\([^)]*\))?[\s\n]*)*)\s*(var|let|const|override)(?:<([^>]+)>)?\s+(\w+)\s*(?::\s*(\S[^\n=;]*))?(?:\s*=\s*([^\n;]+))?/gm;
    while ((m = varRe.exec(content)) !== null) {
      const attributes = m[1];
      const kind = m[2];
      const addressSpace = m[3];
      const name = m[4];
      const varType = m[5] ? m[5].trim() : undefined;
      const value = m[6] ? m[6].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip local variables (inside functions)
      if (lineStart > 1) {
        const before = content.substring(0, m.index);
        const lastFn = before.lastIndexOf('\nfn ');
        if (lastFn > -1) {
          const afterFn = before.substring(lastFn);
          const opens = (afterFn.match(/\{/g) || []).length;
          const closes = (afterFn.match(/\}/g) || []).length;
          if (opens > closes) continue;
        }
      }

      // Extract @group and @binding
      const groupMatch = attributes.match(/@group\((\d+)\)/);
      const bindingMatch = attributes.match(/@binding\((\d+)\)/);
      const binding = groupMatch && bindingMatch
        ? `@group(${groupMatch[1]}) @binding(${bindingMatch[1]})`
        : undefined;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: binding || value || varType || kind,
        return_type: varType,
        line_start: lineStart,
        is_exported: !!binding || kind === 'override',
      });
    }

    // ══════════════════════════════════════════════
    // 5. Type aliases
    // ══════════════════════════════════════════════
    const aliasRe = /^alias\s+(\w+)\s*=\s*(.+)\s*;/gm;
    while ((m = aliasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: `alias = ${m[2].trim()}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /\/\/\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: m[0].trim(),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content));


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
}

export const wgslParser = new WgslParser();
