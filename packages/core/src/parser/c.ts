/**
 * MODUL: C Parser
 * ZWECK: Extrahiert Struktur-Informationen aus C-Dateien (.c, .h)
 *
 * EXTRAHIERT: function, struct, enum, union, typedef, #include, #define,
 *             global variable, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

class CParser implements LanguageParser {
  language = 'c';
  extensions = ['.c', '.h'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;
    const isHeader = filePath.endsWith('.h');

    // ══════════════════════════════════════════════
    // 1. #include
    // ══════════════════════════════════════════════
    const includeRe = /^#include\s+[<"]([^>"]+)[>"]/gm;
    while ((m = includeRe.exec(content)) !== null) {
      const header = m[1];
      const name = header.replace(/\.h$/, '').split('/').pop() || header;
      symbols.push({
        symbol_type: 'import',
        name,
        value: header,
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
    // 2. #define (Makros und Konstanten)
    // ══════════════════════════════════════════════
    // Objekt-artige Makros: #define NAME value
    const defineConstRe = /^#define\s+(\w+)\s+(.+)/gm;
    while ((m = defineConstRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim().replace(/\\\n/g, ' ').slice(0, 200);
      // Skip include guards
      if (name.endsWith('_H') || name.endsWith('_H_') || name.startsWith('_')) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    // Funktions-artige Makros: #define NAME(params) body
    const defineFuncRe = /^#define\s+(\w+)\(([^)]*)\)\s*(.*)/gm;
    while ((m = defineFuncRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].split(',').map(p => p.trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name,
        value: 'macro',
        params,
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Structs
    // ══════════════════════════════════════════════
    // typedef struct { ... } Name;
    const typedefStructRe = /typedef\s+struct\s*(?:\w+)?\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g;
    while ((m = typedefStructRe.exec(content)) !== null) {
      const body = m[1];
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);
      const fields = this.extractFields(body);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isHeader,
      });
    }

    // struct Name { ... };
    const structRe = /^struct\s+(\w+)\s*\{([\s\S]*?)\}\s*;/gm;
    while ((m = structRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);
      const fields = this.extractFields(body);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Enums
    // ══════════════════════════════════════════════
    const typedefEnumRe = /typedef\s+enum\s*(?:\w+)?\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g;
    while ((m = typedefEnumRe.exec(content)) !== null) {
      const body = m[1];
      const name = m[2];
      const variants = body.split(',').map(v => v.trim().split(/[\s=]/)[0]).filter(v => v && !v.startsWith('/'));

      symbols.push({
        symbol_type: 'enum',
        name,
        params: variants,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: isHeader,
      });
    }

    const enumRe = /^enum\s+(\w+)\s*\{([\s\S]*?)\}\s*;/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const variants = body.split(',').map(v => v.trim().split(/[\s=]/)[0]).filter(v => v && !v.startsWith('/'));

      symbols.push({
        symbol_type: 'enum',
        name,
        params: variants,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Unions
    // ══════════════════════════════════════════════
    const typedefUnionRe = /typedef\s+union\s*(?:\w+)?\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g;
    while ((m = typedefUnionRe.exec(content)) !== null) {
      const name = m[2];
      const fields = this.extractFields(m[1]);
      symbols.push({
        symbol_type: 'class',
        name,
        value: 'union',
        params: fields,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 6. typedef (einfach)
    // ══════════════════════════════════════════════
    const typedefSimpleRe = /^typedef\s+(.+?)\s+(\w+)\s*;/gm;
    while ((m = typedefSimpleRe.exec(content)) !== null) {
      const target = m[1].trim();
      const name = m[2];
      // Skip struct/enum/union (already handled)
      if (target.includes('{')) continue;
      symbols.push({
        symbol_type: 'variable',
        name,
        value: target.slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Funktionen
    // ══════════════════════════════════════════════
    const funcRe = /^((?:static|inline|extern|__attribute__\([^)]*\)\s*)*\s*)((?:const\s+)?(?:unsigned\s+|signed\s+|long\s+|short\s+)?(?:struct\s+)?\w[\w*\s]*?)\s+(\*?\w+)\s*\(([^)]*)\)\s*\{/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const qualifiers = m[1].trim();
      const returnType = m[2].trim();
      const funcName = m[3].replace(/^\*/, '');
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      // Skip if returnType is a keyword
      if (['if', 'for', 'while', 'switch', 'return', 'else', 'do'].includes(returnType)) continue;

      const params = paramsRaw === 'void' ? [] : paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(/\s+/);
          return parts[parts.length - 1]?.replace(/[*&]/g, '') || '';
        })
        .filter(p => p && p !== '...');

      const isStatic = qualifiers.includes('static');

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !isStatic,
      });
    }

    // Funktions-Prototypen (in .h)
    if (isHeader) {
      const protoRe = /^((?:extern\s+)?)((?:const\s+)?(?:unsigned\s+|signed\s+|long\s+|short\s+)?(?:struct\s+)?\w[\w*\s]*?)\s+(\*?\w+)\s*\(([^)]*)\)\s*;/gm;
      while ((m = protoRe.exec(content)) !== null) {
        const returnType = m[2].trim();
        const funcName = m[3].replace(/^\*/, '');
        const paramsRaw = m[4];

        if (['if', 'for', 'while', 'switch', 'return', 'typedef'].includes(returnType)) continue;

        const params = paramsRaw === 'void' ? [] : paramsRaw
          .split(',')
          .map(p => p.trim().split(/\s+/).pop()?.replace(/[*&]/g, '') || '')
          .filter(p => p && p !== '...');

        symbols.push({
          symbol_type: 'function',
          name: funcName,
          params,
          return_type: returnType,
          line_start: lineAt(content, m.index),
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 8. Globale Variablen
    // ══════════════════════════════════════════════
    const globalVarRe = /^((?:static|extern|const|volatile)\s+)+(\w[\w*\s]*?)\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
    while ((m = globalVarRe.exec(content)) !== null) {
      const qualifiers = m[1];
      const varType = m[2].trim();
      const varName = m[3];
      const value = m[4] ? m[4].trim().slice(0, 200) : undefined;

      if (['struct', 'enum', 'union', 'typedef'].includes(varType)) continue;

      symbols.push({
        symbol_type: 'variable',
        name: varName,
        value: value || varType,
        return_type: varType,
        line_start: lineAt(content, m.index),
        is_exported: !qualifiers.includes('static'),
      });
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
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
    // 10. Block-Kommentare
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

    return { symbols, references };
  }

  private extractFields(body: string): string[] {
    const fields: string[] = [];
    const fieldRe = /^\s+(?:const\s+)?(?:unsigned\s+|signed\s+)?(?:struct\s+)?\w[\w*\s]*?\s+(\w+)\s*(?:\[[^\]]*\])?\s*;/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(body)) !== null) {
      fields.push(fm[1]);
    }
    return fields;
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
}

export const cParser = new CParser();
