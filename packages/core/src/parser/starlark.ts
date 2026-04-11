/**
 * MODUL: Starlark/Bazel Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Starlark/Bazel-Dateien
 *
 * EXTRAHIERT: load (imports), def (functions), rule definitions (rule/macro),
 *             BUILD targets (cc_library, java_binary, etc.), variable assignments,
 *             visibility, deps, srcs, select statements, comment, todo
 * ANSATZ: Regex-basiert
 *
 * Dateien: .bzl, .star, BUILD, BUILD.bazel, WORKSPACE, WORKSPACE.bazel
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class StarlarkParser implements LanguageParser {
  language = 'starlark';
  extensions = ['.bzl', '.star'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    const isBuild = /(?:^|\/)(?:BUILD|BUILD\.bazel|WORKSPACE|WORKSPACE\.bazel)$/i.test(filePath);

    // ══════════════════════════════════════════════
    // 1. Load statements (imports)
    // ══════════════════════════════════════════════
    const loadRe = /^load\s*\(\s*"([^"]+)"\s*,\s*((?:"[^"]+"\s*(?:,\s*)?)+)\)/gm;
    while ((m = loadRe.exec(content)) !== null) {
      const source = m[1];
      const lineStart = lineAt(content, m.index);
      const namesRaw = m[2];

      const nameRe = /"(\w+)"/g;
      let nm: RegExpExecArray | null;
      while ((nm = nameRe.exec(namesRaw)) !== null) {
        symbols.push({
          symbol_type: 'import',
          name: nm[1],
          value: source,
          line_start: lineStart,
          is_exported: false,
        });
      }

      references.push({
        symbol_name: source.split(':').pop()?.split('/').pop() || source,
        line_number: lineStart,
        context: `load("${source}", ...)`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Function definitions (def)
    // ══════════════════════════════════════════════
    const defRe = /^def\s+(\w+)\s*\(([^)]*)\)\s*:/gm;
    while ((m = defRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split('=')[0].split(':')[0].trim())
        .filter(p => p && p !== '*' && !p.startsWith('**'));

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: !name.startsWith('_'),
      });
    }

    // ══════════════════════════════════════════════
    // 3. BUILD targets (rule invocations)
    // ══════════════════════════════════════════════
    const ruleRe = /^(\w+)\s*\(\s*\n?\s*name\s*=\s*"([^"]+)"/gm;
    while ((m = ruleRe.exec(content)) !== null) {
      const ruleType = m[1];
      const targetName = m[2];
      const lineStart = lineAt(content, m.index);

      // Skip common non-rule calls
      if (['load', 'print', 'fail', 'select', 'glob', 'package', 'exports_files',
           'licenses', 'def', 'if', 'for', 'len', 'str', 'int', 'list', 'dict',
           'range', 'enumerate', 'zip', 'sorted', 'reversed', 'any', 'all'].includes(ruleType)) continue;

      symbols.push({
        symbol_type: 'class',
        name: targetName,
        value: ruleType,
        line_start: lineStart,
        is_exported: true,
      });

      // Extract deps if visible
      const afterRule = content.substring(m.index, m.index + 2000);
      const depsMatch = afterRule.match(/deps\s*=\s*\[([\s\S]*?)\]/);
      if (depsMatch) {
        const depRe = /"([^"]+)"/g;
        let dm: RegExpExecArray | null;
        while ((dm = depRe.exec(depsMatch[1])) !== null) {
          const dep = dm[1];
          references.push({
            symbol_name: dep.split(':').pop() || dep,
            line_number: lineStart,
            context: `${ruleType} "${targetName}" deps: "${dep}"`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Top-level variable assignments
    // ══════════════════════════════════════════════
    const varRe = /^([A-Z_][\w]*)\s*=\s*(.+)/gm;
    while ((m = varRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim().slice(0, 200);
      const lineStart = lineAt(content, m.index);

      // Skip if already captured as a rule
      if (symbols.some(s => s.line_start === lineStart)) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value.replace(/\s*\\$/, ''),
        line_start: lineStart,
        is_exported: !name.startsWith('_'),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Package / workspace declarations
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s*\(\s*([\s\S]*?)\)/gm;
    while ((m = pkgRe.exec(content)) !== null) {
      const visMatch = m[1].match(/default_visibility\s*=\s*\["([^"]+)"\]/);
      symbols.push({
        symbol_type: 'variable',
        name: 'package',
        value: visMatch ? `visibility: ${visMatch[1]}` : 'package',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    const wsRe = /^workspace\s*\(\s*name\s*=\s*"([^"]+)"/gm;
    while ((m = wsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'workspace',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. TODO / FIXME / HACK
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
    // 7. Docstrings
    // ══════════════════════════════════════════════
    const docRe = /"""([\s\S]*?)"""/g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 5) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.split('\n')[0].slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }
}

export const starlarkParser = new StarlarkParser();
