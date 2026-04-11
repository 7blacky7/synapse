/**
 * MODUL: C++ Parser
 * ZWECK: Extrahiert Struktur-Informationen aus C++-Dateien
 *
 * EXTRAHIERT: class, struct, namespace, template, method, function,
 *             enum class, #include, using, const/constexpr, comment, todo
 * ANSATZ: Regex-basiert — erweitert C Parser um C++-Konstrukte
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

class CppParser implements LanguageParser {
  language = 'cpp';
  extensions = ['.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.hh'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;
    const isHeader = /\.(?:hpp|hxx|hh|h)$/.test(filePath);

    // ══════════════════════════════════════════════
    // 1. #include
    // ══════════════════════════════════════════════
    const includeRe = /^#include\s+[<"]([^>"]+)[>"]/gm;
    while ((m = includeRe.exec(content)) !== null) {
      const header = m[1];
      const name = header.replace(/\.(?:h|hpp|hxx)$/, '').split('/').pop() || header;
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
    // 2. using-Deklarationen
    // ══════════════════════════════════════════════
    const usingNsRe = /^using\s+namespace\s+([\w:]+)\s*;/gm;
    while ((m = usingNsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: `using namespace ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    const usingTypeRe = /^using\s+(\w+)\s*=\s*(.+)\s*;/gm;
    while ((m = usingTypeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Namespaces
    // ══════════════════════════════════════════════
    const nsRe = /^namespace\s+(\w+)\s*\{/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Classes & Structs
    // ══════════════════════════════════════════════
    const classRe = /^(?:template\s*<[^>]+>\s*\n\s*)?(class|struct)\s+(?:\[\[[\w:]+\]\]\s+)?(\w+)(?:\s+final)?(?:\s*:\s*(?:public|protected|private)\s+([\w:<>,\s]+))?\s*\{/gm;
    while ((m = classRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const baseClause = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const bases: string[] = [];
      if (baseClause) {
        bases.push(...baseClause.split(',').map(s =>
          s.trim().replace(/^(public|protected|private)\s+/, '').split('<')[0].trim()
        ).filter(Boolean));
      }

      symbols.push({
        symbol_type: 'class',
        name,
        value: kind,
        params: bases.length > 0 ? bases : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isHeader,
      });

      for (const base of bases) {
        references.push({
          symbol_name: base,
          line_number: lineStart,
          context: `${kind} ${name} : ${baseClause?.trim()}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Enums (enum class / enum)
    // ══════════════════════════════════════════════
    const enumRe = /^enum\s+(?:class\s+)?(\w+)(?:\s*:\s*\w+)?\s*\{([\s\S]*?)\}\s*;/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const variants = body.split(',')
        .map(v => v.trim().split(/[\s=]/)[0])
        .filter(v => v && !v.startsWith('/') && !v.startsWith('*'));

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
    // 6. Methoden / Funktionen
    // ══════════════════════════════════════════════
    // Class methods (inline in header)
    const methodRe = /^([ \t]+)(?:(?:virtual|static|explicit|inline|constexpr|override|final|noexcept)\s+)*((?:const\s+)?(?:\w[\w:<>*&\s]*?))\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:const|noexcept|override|final|\s))*\s*\{/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const returnType = m[2].trim();
      const funcName = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else'].includes(funcName)) continue;
      if (['class', 'struct', 'namespace', 'enum'].includes(returnType)) continue;

      const params = this.parseParams(paramsRaw);
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: isHeader,
        parent_id: parentType,
      });
    }

    // Free functions (top-level)
    const freeFuncRe = /^(?:(?:inline|static|extern|constexpr|template\s*<[^>]+>\s*\n\s*)*)((?:const\s+)?(?:\w[\w:<>*&\s]*?))\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:const|noexcept))*\s*\{/gm;
    while ((m = freeFuncRe.exec(content)) !== null) {
      const returnType = m[1].trim();
      const funcName = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);

      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'class', 'struct', 'namespace', 'enum'].includes(funcName)) continue;
      if (['class', 'struct', 'namespace', 'enum'].includes(returnType)) continue;

      // Skip if already found as method
      if (symbols.some(s => s.symbol_type === 'function' && s.name === funcName && s.line_start === lineStart)) continue;

      const params = this.parseParams(paramsRaw);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !m[0].includes('static'),
      });
    }

    // Scope-resolved methods: RetType ClassName::method(...)
    const scopeMethodRe = /^((?:const\s+)?(?:\w[\w:<>*&\s]*?))\s+(\w+)::(\w+)\s*\(([^)]*)\)(?:\s*(?:const|noexcept))*\s*\{/gm;
    while ((m = scopeMethodRe.exec(content)) !== null) {
      const returnType = m[1].trim();
      const className = m[2];
      const methodName = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      const params = this.parseParams(paramsRaw);

      symbols.push({
        symbol_type: 'function',
        name: methodName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
        parent_id: className,
      });

      references.push({
        symbol_name: className,
        line_number: lineStart,
        context: `${className}::${methodName}(...)`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 7. const / constexpr / #define
    // ══════════════════════════════════════════════
    const constexprRe = /^(?:(?:static|inline)\s+)?constexpr\s+(\w[\w:<>]*)\s+(\w+)\s*=\s*([^;]+);/gm;
    while ((m = constexprRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        return_type: m[1],
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    const defineRe = /^#define\s+(\w+)(?:\(([^)]*)\))?\s+(.*)/gm;
    while ((m = defineRe.exec(content)) !== null) {
      const name = m[1];
      if (name.endsWith('_H') || name.endsWith('_HPP') || name.startsWith('_')) continue;
      if (m[2] !== undefined) {
        symbols.push({
          symbol_type: 'function',
          name,
          value: 'macro',
          params: m[2].split(',').map(p => p.trim()).filter(Boolean),
          line_start: lineAt(content, m.index),
          is_exported: isHeader,
        });
      } else {
        symbols.push({
          symbol_type: 'variable',
          name,
          value: m[3].trim().slice(0, 200),
          line_start: lineAt(content, m.index),
          is_exported: isHeader,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 8. TODO / FIXME / HACK
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
    // 9. Block-Kommentare
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

    symbols.push(...extractStringLiterals(content));


    return { symbols, references };
  }

  private parseParams(raw: string): string[] {
    if (!raw.trim() || raw.trim() === 'void') return [];
    return raw
      .split(',')
      .map(p => {
        const parts = p.trim().split(/\s+/);
        return parts[parts.length - 1]?.replace(/[*&]/g, '') || '';
      })
      .filter(p => p && p !== '...');
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
    const classMatch = before.match(/(?:class|struct)\s+(\w+)[^{]*\{[^}]*$/);
    return classMatch ? classMatch[1] : undefined;
  }
}

export const cppParser = new CppParser();
