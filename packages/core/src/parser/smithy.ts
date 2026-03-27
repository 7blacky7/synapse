/**
 * MODUL: Smithy Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Smithy-Dateien (.smithy)
 *
 * EXTRAHIERT: namespace, use, service, resource, operation, structure,
 *             union, enum, string/integer/list shapes, apply, TODO
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class SmithyParser implements LanguageParser {
  language = 'smithy';
  extensions = ['.smithy'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // 1. $version
    const verRe = /^\$version:\s*"([^"]+)"/m;
    m = verRe.exec(content);
    if (m) {
      symbols.push({ symbol_type: 'variable', name: '$version', value: m[1], line_start: lineAt(content, m.index), is_exported: true });
    }

    // 2. Namespace
    const nsRe = /^namespace\s+([\w.#]+)/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'namespace', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 3. Use
    const useRe = /^use\s+([\w.#]+)/gm;
    while ((m = useRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: m[1], line_start: lineAt(content, m.index), is_exported: false });
    }

    // 4. Service
    const svcRe = /^service\s+(\w+)/gm;
    while ((m = svcRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'service', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 5. Resource
    const resRe = /^resource\s+(\w+)/gm;
    while ((m = resRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'resource', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 6. Operation
    const opRe = /^operation\s+(\w+)/gm;
    while ((m = opRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'operation', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 7. Structure
    const structRe = /^structure\s+(\w+)/gm;
    while ((m = structRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'structure', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 8. Union
    const unionRe = /^union\s+(\w+)/gm;
    while ((m = unionRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'union', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 9. Enum (Smithy 2.0 enum + intEnum)
    const enumRe = /^(?:int)?[Ee]num\s+(\w+)/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'enum', name: m[1], value: 'enum', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 10. Simple shapes (string, integer, boolean, list, map, etc.)
    const simpleRe = /^(string|integer|long|short|byte|float|double|bigInteger|bigDecimal|boolean|blob|timestamp|document|list|set|map)\s+(\w+)/gm;
    while ((m = simpleRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'variable', name: m[2], value: m[1], line_start: lineAt(content, m.index), is_exported: true });
    }

    // 11. Apply
    const applyRe = /^apply\s+([\w.#]+)/gm;
    while ((m = applyRe.exec(content)) !== null) {
      references.push({ symbol_name: m[1], line_number: lineAt(content, m.index), context: `apply ${m[1]}` });
    }

    // 12. TODO / FIXME
    const todoRe = /\/\/\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'todo', name: null, value: m[0].trim(), line_start: lineAt(content, m.index), is_exported: false });
    }

    return { symbols, references };
  }
}

export const smithyParser = new SmithyParser();
