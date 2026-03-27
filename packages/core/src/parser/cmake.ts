/**
 * MODUL: CMake Parser
 * ZWECK: Extrahiert Struktur-Informationen aus CMake-Dateien (.cmake, CMakeLists.txt)
 *
 * EXTRAHIERT: project, cmake_minimum_required, find_package, add_library,
 *             add_executable, target_link_libraries, set/option, function/macro,
 *             include, add_subdirectory, install, if/elseif, comment, todo
 * ANSATZ: Regex-basiert (case-insensitive)
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class CMakeParser implements LanguageParser {
  language = 'cmake';
  extensions = ['.cmake'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. cmake_minimum_required
    // ══════════════════════════════════════════════
    const minReqRe = /cmake_minimum_required\s*\(\s*VERSION\s+([\d.]+)/im;
    m = minReqRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'cmake_minimum_required',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Project
    // ══════════════════════════════════════════════
    const projectRe = /project\s*\(\s*(\w+)(?:\s+(?:VERSION\s+([\d.]+)))?/im;
    m = projectRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: m[2] ? `project v${m[2]}` : 'project',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. find_package
    // ══════════════════════════════════════════════
    const findPkgRe = /find_package\s*\(\s*(\w+)(?:\s+([\d.]+))?/gim;
    while ((m = findPkgRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: m[2] ? `find_package ${m[1]} ${m[2]}` : `find_package ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `find_package(${m[1]}${m[2] ? ' ' + m[2] : ''})`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 4. add_library
    // ══════════════════════════════════════════════
    const addLibRe = /add_library\s*\(\s*(\w+)\s+(\w+)?/gim;
    while ((m = addLibRe.exec(content)) !== null) {
      const name = m[1];
      const type = m[2] || '';
      symbols.push({
        symbol_type: 'class',
        name,
        value: type ? `library (${type})` : 'library',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. add_executable
    // ══════════════════════════════════════════════
    const addExeRe = /add_executable\s*\(\s*(\w+)/gim;
    while ((m = addExeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'executable',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. target_link_libraries
    // ══════════════════════════════════════════════
    const linkRe = /target_link_libraries\s*\(\s*(\w+)\s+([\s\S]*?)\)/gim;
    while ((m = linkRe.exec(content)) !== null) {
      const target = m[1];
      const libs = m[2].split(/\s+/).filter(l =>
        l && !['PUBLIC', 'PRIVATE', 'INTERFACE', '${', '}'].includes(l) && !l.startsWith('$')
      );
      for (const lib of libs) {
        references.push({
          symbol_name: lib,
          line_number: lineAt(content, m.index),
          context: `target_link_libraries(${target} ${lib})`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. set / option
    // ══════════════════════════════════════════════
    const setRe = /^\s*set\s*\(\s*(\w+)\s+([^)]+)\)/gim;
    while ((m = setRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().split(/\s+/)[0].slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    const optionRe = /^\s*option\s*\(\s*(\w+)\s+"([^"]+)"\s+(\w+)\s*\)/gim;
    while ((m = optionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: `${m[3]} — ${m[2].slice(0, 150)}`,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. function / macro
    // ══════════════════════════════════════════════
    const funcRe = /^\s*(function|macro)\s*\(\s*(\w+)(?:\s+([^)]*))?\)/gim;
    while ((m = funcRe.exec(content)) !== null) {
      const kind = m[1].toLowerCase();
      const name = m[2];
      const params = m[3] ? m[3].trim().split(/\s+/).filter(Boolean) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        value: kind,
        params,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. include / add_subdirectory
    // ══════════════════════════════════════════════
    const includeRe = /^\s*include\s*\(\s*(\S+)\s*\)/gim;
    while ((m = includeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1].replace(/\$\{[^}]*\}/g, '*'),
        value: `include ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    const subdirRe = /^\s*add_subdirectory\s*\(\s*(\S+)/gim;
    while ((m = subdirRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: `add_subdirectory ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. install
    // ══════════════════════════════════════════════
    const installRe = /^\s*install\s*\(\s*(\w+)\s+(\w+)?/gim;
    while ((m = installRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'export',
        name: `install(${m[1]})`,
        value: m[2] || m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
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

export const cmakeParser = new CMakeParser();
