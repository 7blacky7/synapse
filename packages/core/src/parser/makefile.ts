/**
 * MODUL: Makefile Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Makefiles
 *
 * EXTRAHIERT: targets (mit dependencies), variables (=, :=, ?=, +=),
 *             .PHONY targets, include/sinclude, define/endef blocks,
 *             conditionals (ifeq/ifdef/ifndef), export, vpath,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class MakefileParser implements LanguageParser {
  language = 'makefile';
  extensions = ['.mk'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // Check if this is a Makefile by path (no extension match needed for "Makefile")
    const isMakefile = /(?:^|\/)(?:Makefile|GNUmakefile|makefile)(?:\.|$)/i.test(filePath)
      || filePath.endsWith('.mk');

    if (!isMakefile && !filePath.endsWith('.mk')) {
      return { symbols, references };
    }

    // ══════════════════════════════════════════════
    // 1. .PHONY declarations
    // ══════════════════════════════════════════════
    const phonyTargets = new Set<string>();
    const phonyRe = /^\.PHONY\s*:\s*(.+)/gm;
    while ((m = phonyRe.exec(content)) !== null) {
      const targets = m[1].trim().split(/\s+/);
      for (const t of targets) {
        if (t && !t.startsWith('#')) phonyTargets.add(t);
      }
    }

    // ══════════════════════════════════════════════
    // 2. Variables (=, :=, ::=, ?=, +=, !=)
    // ══════════════════════════════════════════════
    const varRe = /^(\s*)(export\s+)?([A-Za-z_][\w.-]*)\s*([?:+!]?=)\s*(.*)/gm;
    while ((m = varRe.exec(content)) !== null) {
      const indent = m[1];
      // Skip recipe-level variable assignments (indented with tab)
      if (indent.includes('\t')) continue;

      const isExport = !!m[2];
      const name = m[3];
      const operator = m[4];
      const value = m[5].trim().slice(0, 200);
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || operator,
        line_start: lineStart,
        is_exported: isExport,
      });

      // Extract references to other variables $(VAR) or ${VAR}
      const varRefRe = /\$[({]([A-Za-z_][\w.-]*)[)}]/g;
      let vm: RegExpExecArray | null;
      while ((vm = varRefRe.exec(m[5])) !== null) {
        references.push({
          symbol_name: vm[1],
          line_number: lineStart,
          context: `${name} ${operator} ${value}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Targets (must not match variable assignments like := ?= +=)
    // ══════════════════════════════════════════════
    const targetRe = /^([A-Za-z_][\w./%*-]*(?:\s+[A-Za-z_][\w./%*-]*)*)\s*:([^:=\n][^=\n]*)?$/gm;
    while ((m = targetRe.exec(content)) !== null) {
      const targetNames = m[1].trim().split(/\s+/);
      const depsRaw = (m[2] || '').trim();
      const lineStart = lineAt(content, m.index);

      // Find end of recipe (next non-tab-indented line or next target)
      const afterTarget = content.substring(m.index + m[0].length);
      const recipeLines = afterTarget.split('\n');
      let recipeEnd = lineStart;
      for (const line of recipeLines) {
        if (line === '' || line.startsWith('\t') || line.startsWith('  ')) {
          recipeEnd++;
        } else {
          break;
        }
      }

      const deps = depsRaw
        .replace(/#.*$/, '')
        .split(/\s+/)
        .filter(d => d && !d.startsWith('$'));

      for (const targetName of targetNames) {
        // Skip special targets except .PHONY (already handled), .DEFAULT, .SUFFIXES etc.
        if (targetName.startsWith('.') && targetName !== '.DEFAULT') continue;

        const isPhony = phonyTargets.has(targetName);

        symbols.push({
          symbol_type: 'function',
          name: targetName,
          value: isPhony ? 'phony' : 'target',
          params: deps.length > 0 ? deps : undefined,
          line_start: lineStart,
          line_end: recipeEnd > lineStart ? recipeEnd : undefined,
          is_exported: true,
        });

        // Dependencies are references
        for (const dep of deps) {
          if (dep && !dep.startsWith('|') && !dep.includes('%') && !dep.includes('$')) {
            references.push({
              symbol_name: dep,
              line_number: lineStart,
              context: `${targetName}: ${depsRaw}`.slice(0, 80),
            });
          }
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Include / -include / sinclude
    // ══════════════════════════════════════════════
    const includeRe = /^(-?include|sinclude)\s+(.+)/gm;
    while ((m = includeRe.exec(content)) !== null) {
      const kind = m[1];
      const files = m[2].trim().split(/\s+/);
      const lineStart = lineAt(content, m.index);

      for (const file of files) {
        if (file.startsWith('#')) break;
        const name = file.replace(/\$[({][^)}]+[)}]/g, '*');
        symbols.push({
          symbol_type: 'import',
          name,
          value: `${kind} ${file}`,
          line_start: lineStart,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. define / endef blocks
    // ══════════════════════════════════════════════
    const defineRe = /^(export\s+)?define\s+(\w+)/gm;
    while ((m = defineRe.exec(content)) !== null) {
      const isExport = !!m[1];
      const name = m[2];
      const lineStart = lineAt(content, m.index);

      // Find endef
      const rest = content.substring(m.index);
      const endefMatch = rest.match(/\nendef\b/);
      const lineEnd = endefMatch
        ? lineAt(content, m.index + (endefMatch.index || 0) + 1)
        : lineStart;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: 'define',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExport,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Export statements (standalone)
    // ══════════════════════════════════════════════
    const exportRe = /^export\s+([A-Za-z_][\w]*)\s*$/gm;
    while ((m = exportRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: m[1],
        value: 'export',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Conditionals (ifeq, ifdef, ifndef, ifneq)
    // ══════════════════════════════════════════════
    const condRe = /^(ifeq|ifneq|ifdef|ifndef)\s+(.+)/gm;
    while ((m = condRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 8. vpath
    // ══════════════════════════════════════════════
    const vpathRe = /^vpath\s+(\S+)\s+(.+)/gm;
    while ((m = vpathRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'vpath',
        value: `${m[1]} ${m[2].trim()}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
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

    return { symbols, references };
  }
}

export const makefileParser = new MakefileParser();
