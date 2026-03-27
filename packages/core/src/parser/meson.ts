/**
 * MODUL: Meson Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Meson-Build-Dateien (meson.build, meson_options.txt)
 *
 * EXTRAHIERT: project, executable, library, dependency, subdir, option,
 *             custom_target, function calls, variables, TODO
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class MesonParser implements LanguageParser {
  language = 'meson';
  extensions = ['.wrap'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // 1. Project declaration
    const projRe = /^project\s*\(\s*'([^']+)'/gm;
    while ((m = projRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'project', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 2. Executable
    const exeRe = /(\w+)\s*=\s*executable\s*\(\s*'([^']+)'/g;
    while ((m = exeRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: `executable(${m[2]})`, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 3. Library (shared_library, static_library, library, both_libraries)
    const libRe = /(\w+)\s*=\s*(?:shared_library|static_library|library|both_libraries)\s*\(\s*'([^']+)'/g;
    while ((m = libRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: `library(${m[2]})`, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 4. Dependency
    const depRe = /(\w+)\s*=\s*dependency\s*\(\s*'([^']+)'/g;
    while ((m = depRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: m[2], line_start: lineAt(content, m.index), is_exported: false });
    }

    // 5. Subdir
    const subdirRe = /^subdir\s*\(\s*'([^']+)'/gm;
    while ((m = subdirRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: 'subdir', line_start: lineAt(content, m.index), is_exported: false });
    }

    // 6. Option (meson_options.txt)
    const optRe = /^option\s*\(\s*'([^']+)'\s*,\s*type\s*:\s*'([^']+)'/gm;
    while ((m = optRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'variable', name: m[1], value: `option(${m[2]})`, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 7. Custom target
    const ctRe = /(\w+)\s*=\s*custom_target\s*\(\s*'([^']+)'/g;
    while ((m = ctRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: `custom_target(${m[2]})`, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 8. Variable assignments (generic)
    const varRe = /^(\w+)\s*=\s*(?!executable|library|shared_library|static_library|both_libraries|dependency|custom_target)(.+)/gm;
    while ((m = varRe.exec(content)) !== null) {
      if (symbols.some(s => s.name === m![1] && s.line_start === lineAt(content, m!.index))) continue;
      if (['if', 'elif', 'else', 'endif', 'foreach', 'endforeach'].includes(m[1])) continue;
      symbols.push({ symbol_type: 'variable', name: m[1], value: m[2].trim().slice(0, 100), line_start: lineAt(content, m.index), is_exported: true });
    }

    // 9. Function calls (install_*, configure_file, etc.)
    const fnRe = /^(install_\w+|configure_file|test|benchmark|find_program|include_directories|declare_dependency|gnome\.\w+|i18n\.\w+)\s*\(/gm;
    while ((m = fnRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'call', line_start: lineAt(content, m.index), is_exported: false });
    }

    // 10. TODO / FIXME
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'todo', name: null, value: m[0].trim(), line_start: lineAt(content, m.index), is_exported: false });
    }

    return { symbols, references };
  }
}

export const mesonParser = new MesonParser();
