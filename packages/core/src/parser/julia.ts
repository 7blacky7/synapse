/**
 * MODUL: Julia Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Julia-Dateien (.jl)
 *
 * EXTRAHIERT: module, using/import, export, function, macro, struct/mutable struct,
 *             abstract type, primitive type, const, global, type alias,
 *             docstrings, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class JuliaParser implements LanguageParser {
  language = 'julia';
  extensions = ['.jl'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^(baremodule|module)\s+(\w+)/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Using / Import
    // ══════════════════════════════════════════════
    const usingRe = /^(using|import)\s+(.+)/gm;
    while ((m = usingRe.exec(content)) !== null) {
      const kind = m[1];
      const modules = m[2].split(',').map(s => s.trim());

      for (const mod of modules) {
        const parts = mod.split(':');
        const pkg = parts[0].trim().split('.')[0];
        const specific = parts.length > 1
          ? parts[1].trim().split(',').map(s => s.trim())
          : undefined;

        if (specific) {
          for (const item of specific) {
            const name = item.trim();
            if (!name) continue;
            symbols.push({
              symbol_type: 'import',
              name,
              value: `${kind} ${parts[0].trim()}: ${name}`,
              line_start: lineAt(content, m.index),
              is_exported: false,
            });
          }
        } else {
          symbols.push({
            symbol_type: 'import',
            name: pkg,
            value: `${kind} ${mod}`,
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }

        references.push({
          symbol_name: pkg,
          line_number: lineAt(content, m.index),
          context: `${kind} ${mod}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Export
    // ══════════════════════════════════════════════
    const exportRe = /^export\s+([\w,\s]+)/gm;
    while ((m = exportRe.exec(content)) !== null) {
      const names = m[1].split(',').map(n => n.trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'export',
        name: 'export',
        value: names.join(', ').slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Structs
    // ══════════════════════════════════════════════
    const structRe = /^(mutable\s+)?struct\s+(\w+)(?:\{([^}]*)\})?(?:\s*<:\s*(\w+))?/gm;
    while ((m = structRe.exec(content)) !== null) {
      const isMutable = !!m[1];
      const name = m[2];
      const typeParams = m[3];
      const superType = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(content, m.index);

      const params: string[] = [];
      if (typeParams) params.push(`{${typeParams}}`);
      if (superType) params.push(`<: ${superType}`);

      symbols.push({
        symbol_type: 'class',
        name,
        value: isMutable ? 'mutable struct' : 'struct',
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (superType) {
        references.push({
          symbol_name: superType,
          line_number: lineStart,
          context: `struct ${name} <: ${superType}`.slice(0, 80),
        });
      }

      // Parse fields (only until 'end')
      const afterStruct = content.substring(m.index + m[0].length);
      const endIdx = afterStruct.search(/^\s*end\b/m);
      const fieldBlock = endIdx > 0 ? afterStruct.substring(0, endIdx) : afterStruct;
      const fieldRe = /^\s+(\w+)\s*::\s*(\S+)/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(fieldBlock)) !== null) {
        const fieldLine = lineAt(content, m.index + m[0].length + fm.index);
        if (fieldLine > lineEnd) break;

        symbols.push({
          symbol_type: 'variable',
          name: fm[1],
          value: fm[2],
          return_type: fm[2],
          line_start: fieldLine,
          is_exported: true,
          parent_id: name,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Abstract types
    // ══════════════════════════════════════════════
    const abstractRe = /^abstract\s+type\s+(\w+)(?:\{([^}]*)\})?(?:\s*<:\s*(\w+))?/gm;
    while ((m = abstractRe.exec(content)) !== null) {
      const superType = m[3];
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: 'abstract type',
        params: superType ? [`<: ${superType}`] : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
      if (superType) {
        references.push({
          symbol_name: superType,
          line_number: lineAt(content, m.index),
          context: `abstract type ${m[1]} <: ${superType}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^function\s+(?:(\w+)\.)?(\w+)(?:\{([^}]*)\})?\s*\(([^)]*)\)(?:\s*::\s*(\S+))?/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const parentType = m[1];
      const name = m[2];
      const typeParams = m[3];
      const paramsRaw = m[4];
      const returnType = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split('::')[0].split('=')[0].trim())
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name: parentType ? `${parentType}.${name}` : name,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // Short-form functions: name(args) = expr
    const shortFuncRe = /^(\w+)\s*\(([^)]*)\)\s*=\s*(.+)/gm;
    while ((m = shortFuncRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);

      // Skip keywords
      if (['if', 'while', 'for', 'let', 'const', 'global', 'struct', 'module'].includes(name)) continue;
      // Skip if already captured
      if (symbols.some(s => s.name === name && s.symbol_type === 'function')) continue;

      const params = m[2].split(',').map(p => p.trim().split('::')[0].trim()).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Macros
    // ══════════════════════════════════════════════
    const macroRe = /^macro\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((m = macroRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => p.trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: `@${m[1]}`,
        value: 'macro',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Constants and globals
    // ══════════════════════════════════════════════
    const constRe = /^(const|global)\s+(\w+)(?:\s*::\s*(\S+))?\s*=\s*(.+)/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[4].trim().slice(0, 200),
        return_type: m[3] || undefined,
        line_start: lineAt(content, m.index),
        is_exported: m[1] === 'const',
      });
    }

    // ══════════════════════════════════════════════
    // 9. Type aliases
    // ══════════════════════════════════════════════
    const typeAliasRe = /^const\s+(\w+)\s*=\s*(Union\{[^}]+\}|Type\{[^}]+\})/gm;
    while ((m = typeAliasRe.exec(content)) !== null) {
      // Already captured by const regex, but mark as interface
      const existing = symbols.find(s => s.name === m![1] && s.symbol_type === 'variable');
      if (existing) existing.symbol_type = 'interface';
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
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
    // 11. Docstrings (\""" ... \""")
    // ══════════════════════════════════════════════
    const docRe = /"""([\s\S]*?)"""/g;
    while ((m = docRe.exec(content)) !== null) {
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

    return { symbols, references };
  }

  private findEnd(content: string, startPos: number): number {
    const lines = content.substring(startPos).split('\n');
    let currentLine = lineAt(content, startPos);
    let depth = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      // Track block depth
      if (/^(function|struct|mutable\s+struct|module|baremodule|begin|if|for|while|try|let|do|quote|macro)\b/.test(trimmed)) depth++;
      if (trimmed === 'end' || trimmed.startsWith('end ') || trimmed.startsWith('end#') || trimmed.startsWith('end;')) depth--;
      if (depth < 0) return currentLine;
      currentLine++;
    }
    return currentLine;
  }
}

export const juliaParser = new JuliaParser();
