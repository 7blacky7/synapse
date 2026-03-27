/**
 * MODUL: Nix Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Nix-Dateien (.nix)
 *
 * EXTRAHIERT: let/in bindings, inherit, import, with, rec attrsets,
 *             function args (pattern), mkDerivation, buildInputs,
 *             flake inputs/outputs, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class NixParser implements LanguageParser {
  language = 'nix';
  extensions = ['.nix'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;
    const isFlake = filePath.endsWith('flake.nix');

    // ══════════════════════════════════════════════
    // 1. Import
    // ══════════════════════════════════════════════
    const importRe = /import\s+([<./][\w./<>-]+)/g;
    while ((m = importRe.exec(content)) !== null) {
      const path = m[1];
      const name = path.replace(/[<>]/g, '').split('/').pop()?.replace('.nix', '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: path,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Let bindings
    // ══════════════════════════════════════════════
    const letBindRe = /^\s{2,}(\w[\w'-]*)\s*=\s*(.+)/gm;
    const inLetBlock = /\blet\b[\s\S]*?\bin\b/g;
    let blockMatch: RegExpExecArray | null;
    while ((blockMatch = inLetBlock.exec(content)) !== null) {
      const block = blockMatch[0];
      const blockStart = blockMatch.index;
      const bindRe = /^\s+(\w[\w'-]*)\s*=\s*(.+)/gm;
      let bm: RegExpExecArray | null;
      while ((bm = bindRe.exec(block)) !== null) {
        const name = bm[1];
        const value = bm[2].trim().slice(0, 200);
        const lineStart = lineAt(content, blockStart + bm.index);

        // Skip keywords
        if (['let', 'in', 'if', 'then', 'else', 'with', 'inherit', 'rec'].includes(name)) continue;

        const isFunction = value.startsWith('{') || value.includes(':') && !value.includes('"');

        symbols.push({
          symbol_type: isFunction && value.includes(':') ? 'function' : 'variable',
          name,
          value: value.replace(/;$/, '').slice(0, 200),
          line_start: lineStart,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Top-level attribute set bindings
    // ══════════════════════════════════════════════
    const topBindRe = /^(\s{2})(\w[\w'-]*)\s*=\s*(.+)/gm;
    while ((m = topBindRe.exec(content)) !== null) {
      const indent = m[1].length;
      const name = m[2];
      const value = m[3].trim();
      const lineStart = lineAt(content, m.index);

      if (indent > 4) continue;
      if (['let', 'in', 'if', 'then', 'else', 'with', 'inherit', 'rec', 'type', 'description', 'default'].includes(name)) continue;
      // Skip if already captured
      if (symbols.some(s => s.name === name && s.line_start === lineStart)) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value.replace(/;$/, '').slice(0, 200),
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Inherit
    // ══════════════════════════════════════════════
    const inheritRe = /^\s*inherit\s+(?:\(([^)]+)\)\s+)?([\w\s]+);/gm;
    while ((m = inheritRe.exec(content)) !== null) {
      const source = m[1] ? m[1].trim() : undefined;
      const names = m[2].trim().split(/\s+/).filter(Boolean);
      const lineStart = lineAt(content, m.index);

      for (const name of names) {
        references.push({
          symbol_name: name,
          line_number: lineStart,
          context: source ? `inherit (${source}) ${name}` : `inherit ${name}`,
        });
      }

      if (source) {
        references.push({
          symbol_name: source,
          line_number: lineStart,
          context: `inherit (${source}) ...`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. mkDerivation / buildPythonPackage etc.
    // ══════════════════════════════════════════════
    const mkDerivRe = /(\w+)\s*=\s*(?:stdenv\.)?mk(\w+)\s*(?:rec\s*)?\{/g;
    while ((m = mkDerivRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: `mk${m[2]}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Flake inputs/outputs
    // ══════════════════════════════════════════════
    if (isFlake) {
      // Inputs
      const inputRe = /^\s{4}(\w[\w-]*)\s*(?:\.url)?\s*=\s*"?([^";{]+)"?\s*;/gm;
      while ((m = inputRe.exec(content)) !== null) {
        const name = m[1];
        const value = m[2].trim();
        if (name === 'url' || name === 'type' || name === 'flake') continue;

        symbols.push({
          symbol_type: 'import',
          name,
          value: `flake input: ${value}`,
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }

      // Outputs
      const outputRe = /^\s{4}(packages|devShells|nixosConfigurations|overlays|apps|checks|formatter|lib)\s*[.=]/gm;
      while ((m = outputRe.exec(content)) !== null) {
        symbols.push({
          symbol_type: 'export',
          name: m[1],
          value: 'flake output',
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. Function patterns ({ arg1, arg2, ... }:)
    // ══════════════════════════════════════════════
    const funcPatternRe = /\{\s*([\w,\s?]+)\s*\}\s*:/g;
    while ((m = funcPatternRe.exec(content)) !== null) {
      const args = m[1].split(',').map(a => a.trim().replace(/\?$/, '')).filter(Boolean);
      // Only capture if it looks like a top-level function
      const before = content.substring(Math.max(0, m.index - 50), m.index);
      const nameMatch = before.match(/(\w[\w'-]*)\s*=\s*$/);
      if (nameMatch && args.length > 1) {
        // Already captured as variable, update to function
        const existing = symbols.find(s => s.name === nameMatch[1]);
        if (existing) {
          existing.symbol_type = 'function';
          existing.params = args;
        }
      }
    }

    // ══════════════════════════════════════════════
    // 8. With statements
    // ══════════════════════════════════════════════
    const withRe = /\bwith\s+(\w[\w.]*)\s*;/g;
    while ((m = withRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `with ${m[1]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
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
    // 10. Multi-line comments (/* ... */)
    // ══════════════════════════════════════════════
    const commentRe = /\/\*([\s\S]*?)\*\//g;
    while ((m = commentRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 5) continue;
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
}

export const nixParser = new NixParser();
