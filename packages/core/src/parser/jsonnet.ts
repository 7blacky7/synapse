/**
 * MODUL: Jsonnet Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Jsonnet-Dateien (.jsonnet, .libsonnet)
 *
 * EXTRAHIERT: import/importstr, local-bindings, functions, object fields,
 *             hidden fields, TODO
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class JsonnetParser implements LanguageParser {
  language = 'jsonnet';
  extensions = ['.jsonnet', '.libsonnet'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // 1. Import / importstr / importbin
    const importRe = /(\w+)\s*[:=]\s*(?:import|importstr|importbin)\s*["']([^"']+)["']/g;
    while ((m = importRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: m[2], line_start: lineAt(content, m.index), is_exported: false });
    }

    // Anonymous imports
    const anonImportRe = /(?:import|importstr|importbin)\s*["']([^"']+)["']/g;
    while ((m = anonImportRe.exec(content)) !== null) {
      if (symbols.some(s => s.value === m![1] && s.symbol_type === 'import')) continue;
      symbols.push({ symbol_type: 'import', name: m[1], value: m[1], line_start: lineAt(content, m.index), is_exported: false });
    }

    // 2. Local functions
    const localFnRe = /local\s+(\w+)\s*\(([^)]*)\)\s*=/g;
    while ((m = localFnRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => p.trim().split('=')[0].trim()).filter(Boolean);
      symbols.push({ symbol_type: 'function', name: m[1], params: params.length > 0 ? params : undefined, line_start: lineAt(content, m.index), is_exported: false });
    }

    // 3. Local variables
    const localVarRe = /local\s+(\w+)\s*=/g;
    while ((m = localVarRe.exec(content)) !== null) {
      if (symbols.some(s => s.name === m![1] && s.line_start === lineAt(content, m!.index))) continue;
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'local', line_start: lineAt(content, m.index), is_exported: false });
    }

    // 4. Top-level object fields (exported, with functions)
    const fieldFnRe = /^[ \t]*(\w+)\s*\(([^)]*)\)\s*(?:::?:?)/gm;
    while ((m = fieldFnRe.exec(content)) !== null) {
      if (symbols.some(s => s.name === m![1] && s.symbol_type === 'function')) continue;
      const params = m[2].split(',').map(p => p.trim().split('=')[0].trim()).filter(Boolean);
      symbols.push({ symbol_type: 'function', name: m[1], params: params.length > 0 ? params : undefined, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 5. Top-level object fields (key: value, key:: value, key::: value)
    const fieldRe = /^[ \t]*(\w+)\s*(?:::?:?)\s*/gm;
    while ((m = fieldRe.exec(content)) !== null) {
      if (['if', 'else', 'then', 'local', 'for', 'in', 'assert', 'error', 'true', 'false', 'null'].includes(m[1])) continue;
      if (symbols.some(s => s.name === m![1] && Math.abs(s.line_start - lineAt(content, m!.index)) < 2)) continue;
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'field', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 6. String fields ("key": value)
    const strFieldRe = /^[ \t]*["'](\w[\w-]*)["']\s*(?:::?:?)\s*/gm;
    while ((m = strFieldRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'field', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 7. TODO / FIXME
    const todoRe = /(?:\/\/|#)\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'todo', name: null, value: m[0].trim(), line_start: lineAt(content, m.index), is_exported: false });
    }

    return { symbols, references };
  }
}

export const jsonnetParser = new JsonnetParser();
