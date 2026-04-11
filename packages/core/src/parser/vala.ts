/**
 * MODUL: Vala Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Vala-Dateien (.vala, .vapi)
 *
 * EXTRAHIERT: using, namespace, class, interface, struct, enum, delegate,
 *             signal, property, method, const, TODO
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ValaParser implements LanguageParser {
  language = 'vala';
  extensions = ['.vala', '.vapi'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // 1. Using
    const usingRe = /^using\s+([\w.]+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'import', name: m[1], value: m[1], line_start: lineAt(content, m.index), is_exported: false });
    }

    // 2. Namespace
    const nsRe = /^(?:public\s+)?namespace\s+([\w.]+)/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'namespace', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 3. Class
    const classRe = /^(?:(?:public|private|internal|abstract|sealed)\s+)*class\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\s{]+))?/gm;
    while ((m = classRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: m[2] ? `extends ${m[2]}` : 'class', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 4. Interface
    const ifaceRe = /^(?:(?:public|private|internal)\s+)*interface\s+(\w+)(?:<[^>]+>)?/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'interface', name: m[1], value: 'interface', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 5. Struct
    const structRe = /^(?:(?:public|private|internal)\s+)*struct\s+(\w+)/gm;
    while ((m = structRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'class', name: m[1], value: 'struct', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 6. Enum
    const enumRe = /^(?:(?:public|private|internal)\s+)*enum\s+(\w+)/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'enum', name: m[1], value: 'enum', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 7. Delegate
    const delegateRe = /^(?:(?:public|private|internal)\s+)*delegate\s+\S+\s+(\w+)\s*\(/gm;
    while ((m = delegateRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'delegate', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 8. Signal
    const signalRe = /^[ \t]*(?:public\s+)?signal\s+\S+\s+(\w+)\s*\(/gm;
    while ((m = signalRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'function', name: m[1], value: 'signal', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 9. Property
    const propRe = /^[ \t]*(?:(?:public|private|internal|protected)\s+)*(?:(?:virtual|override|abstract|static)\s+)*\S+\s+(\w+)\s*\{[^}]*(?:get|set)/gm;
    while ((m = propRe.exec(content)) !== null) {
      if (['if', 'else', 'for', 'while', 'switch', 'return', 'new', 'class', 'namespace'].includes(m[1])) continue;
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'property', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 10. Methods
    const methodRe = /^[ \t]*(?:(?:public|private|internal|protected)\s+)*(?:(?:virtual|override|abstract|static|async)\s+)*(\S+)\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      if (['if', 'else', 'for', 'while', 'switch', 'return', 'new', 'class', 'namespace', 'using', 'enum', 'struct', 'interface', 'delegate', 'signal'].includes(m[2])) continue;
      if (symbols.some(s => s.name === m![2] && s.line_start === lineAt(content, m!.index))) continue;
      const params = m[3].split(',').map(p => p.trim().split(/\s+/).pop()!).filter(Boolean);
      symbols.push({ symbol_type: 'function', name: m[2], params: params.length > 0 ? params : undefined, line_start: lineAt(content, m.index), is_exported: true });
    }

    // 11. Constants
    const constRe = /^[ \t]*(?:(?:public|private|internal)\s+)*const\s+\S+\s+(\w+)\s*=/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'variable', name: m[1], value: 'const', line_start: lineAt(content, m.index), is_exported: true });
    }

    // 12. TODO / FIXME
    const todoRe = /\/\/\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
    while ((m = todoRe.exec(content)) !== null) {
      symbols.push({ symbol_type: 'todo', name: null, value: m[0].trim(), line_start: lineAt(content, m.index), is_exported: false });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references };
  }
}

export const valaParser = new ValaParser();
