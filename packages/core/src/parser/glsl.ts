/**
 * MODUL: GLSL Parser
 * ZWECK: Extrahiert Struktur-Informationen aus GLSL Shader-Dateien
 *
 * EXTRAHIERT: #version, #extension, struct, function, uniform/varying/attribute,
 *             in/out, layout qualifiers, const, #define, precision, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class GlslParser implements LanguageParser {
  language = 'glsl';
  extensions = ['.glsl', '.vert', '.frag', '.geom', '.comp', '.tesc', '.tese'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. #version
    // ══════════════════════════════════════════════
    const versionRe = /^#version\s+(\d+)(?:\s+(\w+))?/m;
    m = versionRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: '#version',
        value: m[2] ? `${m[1]} ${m[2]}` : m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. #extension
    // ══════════════════════════════════════════════
    const extRe = /^#extension\s+([\w_]+)\s*:\s*(\w+)/gm;
    while ((m = extRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: m[2],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Precision
    // ══════════════════════════════════════════════
    const precisionRe = /^precision\s+(lowp|mediump|highp)\s+(\w+)\s*;/gm;
    while ((m = precisionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `precision ${m[2]}`,
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Structs
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

      // Parse fields
      const block = content.substring(m.index + m[0].length);
      const endIdx = block.indexOf('}');
      if (endIdx > 0) {
        const fieldRe = /^\s*(\w+)\s+(\w+)(?:\[(\d+)\])?\s*;/gm;
        let fm: RegExpExecArray | null;
        while ((fm = fieldRe.exec(block.substring(0, endIdx))) !== null) {
          symbols.push({
            symbol_type: 'variable',
            name: fm[2],
            value: fm[3] ? `${fm[1]}[${fm[3]}]` : fm[1],
            return_type: fm[1],
            line_start: lineAt(content, m.index + m[0].length + fm.index),
            is_exported: true,
            parent_id: name,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 5. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^(\w+)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const returnType = m[1];
      const name = m[2];
      const paramsRaw = m[3];

      // Skip keywords that look like functions
      if (['if', 'for', 'while', 'switch', 'struct'].includes(returnType)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        value: name === 'main' ? 'entry point' : undefined,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineAt(content, m.index),
        is_exported: name === 'main',
      });
    }

    // ══════════════════════════════════════════════
    // 6. Uniforms / Varying / Attribute / In / Out
    // ══════════════════════════════════════════════
    const qualRe = /^(?:(layout\s*\([^)]+\))\s+)?(uniform|varying|attribute|in|out|flat\s+(?:in|out)|centroid\s+(?:in|out))\s+(\w+)\s+(\w+)(?:\[(\d+)\])?\s*;/gm;
    while ((m = qualRe.exec(content)) !== null) {
      const layout = m[1] || '';
      const qualifier = m[2];
      const varType = m[3];
      const name = m[4];
      const arraySize = m[5];
      const lineStart = lineAt(content, m.index);

      // Extract location from layout
      const locMatch = layout.match(/location\s*=\s*(\d+)/);
      const bindingMatch = layout.match(/binding\s*=\s*(\d+)/);
      const setMatch = layout.match(/set\s*=\s*(\d+)/);

      let value = qualifier;
      if (locMatch) value += ` location=${locMatch[1]}`;
      if (bindingMatch) value += ` binding=${bindingMatch[1]}`;
      if (setMatch) value += ` set=${setMatch[1]}`;

      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        return_type: arraySize ? `${varType}[${arraySize}]` : varType,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Uniform blocks / Interface blocks
    // ══════════════════════════════════════════════
    const uboRe = /^(?:layout\s*\([^)]+\)\s+)?uniform\s+(\w+)\s*\{/gm;
    while ((m = uboRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'uniform block',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Constants
    // ══════════════════════════════════════════════
    const constRe = /^const\s+(\w+)\s+(\w+)\s*=\s*([^;]+);/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        return_type: m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 9. #define
    // ══════════════════════════════════════════════
    const defineRe = /^#define\s+(\w+)(?:\(([^)]*)\))?\s*(.*)/gm;
    while ((m = defineRe.exec(content)) !== null) {
      if (m[1].startsWith('GL_')) continue; // Skip guard macros
      symbols.push({
        symbol_type: m[2] !== undefined ? 'function' : 'variable',
        name: m[1],
        value: m[2] !== undefined ? 'macro' : m[3].trim().slice(0, 200) || 'define',
        params: m[2] ? m[2].split(',').map(p => p.trim()).filter(Boolean) : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
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

export const glslParser = new GlslParser();
