/**
 * MODUL: Swift Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Swift-Dateien
 *
 * EXTRAHIERT: class, struct, enum, protocol, extension, func, let/var,
 *             import, typealias, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function isExportedMod(modifiers: string): boolean {
  return /\b(public|open)\b/.test(modifiers) || !/\b(private|fileprivate|internal)\b/.test(modifiers);
}

class SwiftParser implements LanguageParser {
  language = 'swift';
  extensions = ['.swift'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Imports
    // ══════════════════════════════════════════════
    const importRe = /^import\s+(?:(?:class|struct|enum|protocol|func|var|let|typealias)\s+)?(\w[\w.]*)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const name = m[1].split('.').pop() || m[1];
      symbols.push({
        symbol_type: 'import',
        name,
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Classes, Structs, Enums, Protocols
    // ══════════════════════════════════════════════
    const typeRe = /^(\s*)((?:(?:public|open|internal|private|fileprivate|final)\s+)*)(class|struct|enum|protocol|actor)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\n{]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const conformance = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'protocol' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const protocols: string[] = [];
      if (conformance) {
        protocols.push(...conformance.split(',').map(s => s.trim().split('<')[0].trim()).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: protocols.length > 0 ? protocols : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExportedMod(modifiers),
      });

      for (const proto of protocols) {
        references.push({
          symbol_name: proto,
          line_number: lineStart,
          context: `${kind} ${name} : ${conformance?.trim()}`.slice(0, 80),
        });
      }
    }

    // Extensions
    const extRe = /^(\s*)((?:(?:public|private|fileprivate|internal)\s+)*)extension\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\n{]+))?\s*\{/gm;
    while ((m = extRe.exec(content)) !== null) {
      const name = m[3];
      const conformance = m[4];
      const lineStart = lineAt(content, m.index);

      references.push({
        symbol_name: name,
        line_number: lineStart,
        context: `extension ${name}${conformance ? ' : ' + conformance.trim() : ''}`.slice(0, 80),
      });

      if (conformance) {
        for (const proto of conformance.split(',').map(s => s.trim()).filter(Boolean)) {
          references.push({
            symbol_name: proto,
            line_number: lineStart,
            context: `extension ${name} : ${proto}`,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 3. Functions (func)
    // ══════════════════════════════════════════════
    const funcRe = /^(\s*)((?:(?:public|open|internal|private|fileprivate|static|class|override|mutating|@\w+\s+)*\s*)?)func\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*(?:throws|rethrows))?\s*(?:->\s*(\S[^\n{]*))?/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const name = m[3];
      const paramsRaw = m[4];
      const returnType = m[5] ? m[5].trim().replace(/\s*\{$/, '') : undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(':')[0].trim().split(/\s+/);
          return parts[parts.length - 1]; // external/internal name
        })
        .filter(p => p && p !== '_');

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // init()
    const initRe = /^(\s*)((?:(?:public|internal|private|fileprivate|required|convenience|override)\s+)*)init\??\s*\(([^)]*)\)/gm;
    while ((m = initRe.exec(content)) !== null) {
      const modifiers = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: 'init',
        value: 'constructor',
        params,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Properties (let/var)
    // ══════════════════════════════════════════════
    const propRe = /^(\s*)((?:(?:public|open|internal|private|fileprivate|static|class|lazy|weak|unowned|@\w+\s+)*\s*))(let|var)\s+(\w+)(?:\s*:\s*(\S[^\n=]*))?(?:\s*=\s*([^\n{]+))?/gm;
    while ((m = propRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const propType = m[5] ? m[5].trim() : undefined;
      const value = m[6] ? m[6].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip lokale Variablen
      if (indent > 8) continue;

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || propType || kind,
        return_type: propType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // typealias
    const typealiasRe = /^(\s*)(?:(?:public|internal|private|fileprivate)\s+)?typealias\s+(\w+)\s*=\s*(.+)/gm;
    while ((m = typealiasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. TODO / FIXME / HACK
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

    // ══════════════════════════════════════════════
    // 6. Doc-Comments (/// und /** */)
    // ══════════════════════════════════════════════
    const docRe = /\/\*\*([\s\S]*?)\*\//g;
    while ((m = docRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
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

  private findClosingBrace(content: string, openPos: number): number {
    let depth = 1;
    for (let i = openPos + 1; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') depth--;
      if (depth === 0) return lineAt(content, i);
    }
    return lineAt(content, content.length);
  }

  private findParentType(content: string, pos: number): string | undefined {
    const before = content.substring(0, pos);
    const match = before.match(/(?:class|struct|enum|protocol|actor|extension)\s+(\w+)[^{]*\{[^}]*$/);
    return match ? match[1] : undefined;
  }
}

export const swiftParser = new SwiftParser();
