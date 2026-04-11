/**
 * MODUL: Go Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Go-Dateien
 *
 * EXTRAHIERT: function, method (receiver), struct, interface, type alias,
 *             const, var, import, comment, todo
 * ANSATZ: Regex-basiert — Go hat klare, einfache Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

/** Zeilennummer fuer eine Position im Text (1-basiert) */
function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

/** Endzeile eines Matches */
function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

/** Go-Exports: Grossbuchstabe am Anfang */
function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

class GoParser implements LanguageParser {
  language = 'go';
  extensions = ['.go'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package-Deklaration
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+(\w+)/m;
    m = pkgRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'package',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Imports
    // ══════════════════════════════════════════════
    // Single import
    const singleImportRe = /^import\s+"([^"]+)"/gm;
    while ((m = singleImportRe.exec(content)) !== null) {
      const pkg = m[1];
      const name = pkg.split('/').pop() || pkg;
      symbols.push({
        symbol_type: 'import',
        name,
        value: pkg,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // Grouped imports
    const groupImportRe = /^import\s*\(([\s\S]*?)\)/gm;
    while ((m = groupImportRe.exec(content)) !== null) {
      const block = m[1];
      const importLineRe = /(?:(\w+)\s+)?"([^"]+)"/g;
      let im: RegExpExecArray | null;
      while ((im = importLineRe.exec(block)) !== null) {
        const alias = im[1] || null;
        const pkg = im[2];
        const name = alias || pkg.split('/').pop() || pkg;
        const line = lineAt(content, m.index + (im.index || 0));
        symbols.push({
          symbol_type: 'import',
          name,
          value: pkg,
          line_start: line,
          is_exported: false,
        });
        references.push({
          symbol_name: name,
          line_number: line,
          context: `import "${pkg}"`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Funktionen (func name(...) ...)
    // ══════════════════════════════════════════════
    const funcRe = /^func\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]*)\)|(\S[^\n{]*)))?\s*\{/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const funcName = m[1];
      const paramsRaw = m[2];
      const returnMulti = m[3];
      const returnSingle = m[4];
      const returnType = returnMulti
        ? `(${returnMulti.trim()})`
        : returnSingle ? returnSingle.trim() : undefined;

      const params = this.parseGoParams(paramsRaw);
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExported(funcName),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Methoden (func (receiver) name(...) ...)
    // ══════════════════════════════════════════════
    const methodRe = /^func\s+\((\w+)\s+\*?(\w+)\)\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:\(([^)]*)\)|(\S[^\n{]*)))?\s*\{/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const receiverName = m[1];
      const receiverType = m[2];
      const methodName = m[3];
      const paramsRaw = m[4];
      const returnMulti = m[5];
      const returnSingle = m[6];
      const returnType = returnMulti
        ? `(${returnMulti.trim()})`
        : returnSingle ? returnSingle.trim() : undefined;

      const params = this.parseGoParams(paramsRaw);
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'function',
        name: methodName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExported(methodName),
        parent_id: receiverType,
      });

      references.push({
        symbol_name: receiverType,
        line_number: lineStart,
        context: `func (${receiverName} ${receiverType}) ${methodName}(...)`,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Type-Deklarationen (struct, interface, type alias)
    // ══════════════════════════════════════════════
    // type X struct { ... }
    const structRe = /^type\s+(\w+)\s+struct\s*\{([\s\S]*?)\n\}/gm;
    while ((m = structRe.exec(content)) !== null) {
      const typeName = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      // Felder extrahieren
      const fields: string[] = [];
      const fieldRe = /^\s+(\w+)\s+(\S+)/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(body)) !== null) {
        fields.push(fm[1]);
        // Embedded structs / Referenzen
        const fieldType = fm[2].replace(/^\*/, '');
        if (/^[A-Z]/.test(fieldType) && !['string', 'int', 'bool', 'float64', 'float32', 'byte', 'rune', 'error'].includes(fieldType.toLowerCase())) {
          references.push({
            symbol_name: fieldType,
            line_number: lineAt(content, m.index + (fm.index || 0)),
            context: `${typeName}.${fm[1]} ${fm[2]}`.slice(0, 80),
          });
        }
      }

      symbols.push({
        symbol_type: 'class',
        name: typeName,
        value: 'struct',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExported(typeName),
      });
    }

    // type X interface { ... }
    const ifaceRe = /^type\s+(\w+)\s+interface\s*\{([\s\S]*?)\n\}/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      const typeName = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      // Methoden-Signaturen
      const methods: string[] = [];
      const methodSigRe = /^\s+(\w+)\s*\(/gm;
      let mm: RegExpExecArray | null;
      while ((mm = methodSigRe.exec(body)) !== null) {
        methods.push(mm[1]);
      }

      symbols.push({
        symbol_type: 'interface',
        name: typeName,
        params: methods,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExported(typeName),
      });
    }

    // type X = Y (alias) / type X Y (definition)
    const typeAliasRe = /^type\s+(\w+)\s+=?\s*([^\n{]+)/gm;
    while ((m = typeAliasRe.exec(content)) !== null) {
      // Skip struct/interface (already handled)
      if (m[2].trim().startsWith('struct') || m[2].trim().startsWith('interface')) continue;
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isExported(m[1]),
      });
    }

    // ══════════════════════════════════════════════
    // 6. Const / Var Deklarationen
    // ══════════════════════════════════════════════
    // const X = ... / var X = ...
    const constVarRe = /^(const|var)\s+(\w+)(?:\s+(\S+))?\s*=\s*(.+)/gm;
    while ((m = constVarRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[4].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isExported(m[2]),
      });
    }

    // Grouped const/var blocks
    const groupConstRe = /^(const|var)\s*\(([\s\S]*?)\)/gm;
    while ((m = groupConstRe.exec(content)) !== null) {
      const kind = m[1];
      const block = m[2];
      const entryRe = /^\s+(\w+)(?:\s+\S+)?\s*=\s*(.*)/gm;
      let em: RegExpExecArray | null;
      while ((em = entryRe.exec(block)) !== null) {
        symbols.push({
          symbol_type: 'variable',
          name: em[1],
          value: em[2].trim().slice(0, 200),
          line_start: lineAt(content, m.index + (em.index || 0)),
          is_exported: isExported(em[1]),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 7. TODO / FIXME / HACK
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
    // 8. Block-Kommentare (/* ... */)
    // ══════════════════════════════════════════════
    const blockCommentRe = /\/\*([\s\S]*?)\*\//g;
    while ((m = blockCommentRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: false,
      });
    }

    // Zusammenhaengende //-Kommentarbloeecke
    const lines = content.split('\n');
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//') && !line.match(/^\/\/\s*(TODO|FIXME|HACK)/i)) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(line.replace(/^\/\/\s?/, ''));
      } else {
        if (commentBlock.length >= 2) {
          symbols.push({
            symbol_type: 'comment',
            name: null,
            value: commentBlock.join(' ').trim().slice(0, 500),
            line_start: commentStart,
            line_end: commentStart + commentBlock.length - 1,
            is_exported: false,
          });
        }
        commentBlock = [];
      }
    }
    if (commentBlock.length >= 2) {
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: commentBlock.join(' ').trim().slice(0, 500),
        line_start: commentStart,
        line_end: commentStart + commentBlock.length - 1,
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content));


    return { symbols, references };
  }

  /** Parst Go-Parameter-Listen ("name type, name type") */
  private parseGoParams(raw: string): string[] {
    if (!raw.trim()) return [];
    return raw
      .split(',')
      .map(p => p.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  /** Findet die schliessende Klammer ab einer Position */
  private findClosingBrace(content: string, openPos: number): number {
    let depth = 1;
    for (let i = openPos + 1; i < content.length; i++) {
      if (content[i] === '{') depth++;
      if (content[i] === '}') depth--;
      if (depth === 0) return lineAt(content, i);
    }
    return lineAt(content, content.length);
  }
}

export const goParser = new GoParser();
