/**
 * MODUL: PHP Parser
 * ZWECK: Extrahiert Struktur-Informationen aus PHP-Dateien
 *
 * EXTRAHIERT: class, interface, trait, enum, function, method, property,
 *             const, use/namespace, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

function isExportedMod(modifiers: string): boolean {
  return /\b(public|protected)\b/.test(modifiers) || !/\bprivate\b/.test(modifiers);
}

class PhpParser implements LanguageParser {
  language = 'php';
  extensions = ['.php'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Namespace
    // ══════════════════════════════════════════════
    const nsRe = /^namespace\s+([\w\\]+)\s*;/m;
    m = nsRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. use-Statements
    // ══════════════════════════════════════════════
    const useRe = /^use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm;
    while ((m = useRe.exec(content)) !== null) {
      const fqn = m[1];
      const alias = m[2];
      const name = alias || fqn.split('\\').pop() || fqn;
      symbols.push({
        symbol_type: 'import',
        name,
        value: fqn,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // Trait use inside classes
    const traitUseRe = /^\s+use\s+([\w\\,\s]+)\s*;/gm;
    while ((m = traitUseRe.exec(content)) !== null) {
      const traits = m[1].split(',').map(s => s.trim().split('\\').pop() || s.trim()).filter(Boolean);
      for (const trait of traits) {
        references.push({
          symbol_name: trait,
          line_number: lineAt(content, m.index),
          context: `use ${trait}`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Classes, Interfaces, Traits, Enums
    // ══════════════════════════════════════════════
    const typeRe = /^(?:(?:abstract|final|readonly)\s+)*(class|interface|trait|enum)\s+(\w+)(?:\s+extends\s+([\w\\]+))?(?:\s+implements\s+([\w\\,\s]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const extendsClause = m[3];
      const implementsClause = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (extendsClause) parents.push(extendsClause.split('\\').pop() || extendsClause);
      if (implementsClause) {
        parents.push(...implementsClause.split(',').map(s => {
          const p = s.trim();
          return p.split('\\').pop() || p;
        }).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      for (const parent of parents) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methods
    // ══════════════════════════════════════════════
    const methodRe = /^(\s+)((?:(?:public|protected|private|static|abstract|final)\s+)*)function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*(\??\w[\w\\|]*))?(?:\s*\{)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const modifiers = m[2];
      const name = m[3];
      const paramsRaw = m[4];
      const returnType = m[5] || undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/[=]/)[0].trim().split(/\s+/).pop()?.replace(/^\$/, '') || '')
        .filter(Boolean);

      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // Free functions
    const funcRe = /^function\s+(\w+)\s*\(([^)]*)\)(?:\s*:\s*(\??\w[\w\\|]*))?(?:\s*\{)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const returnType = m[3] || undefined;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/[=]/)[0].trim().split(/\s+/).pop()?.replace(/^\$/, '') || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Properties
    // ══════════════════════════════════════════════
    const propRe = /^\s+((?:(?:public|protected|private|static|readonly)\s+)+)(?:(\??\w[\w\\]*)\s+)?\$(\w+)(?:\s*=\s*([^;]+))?\s*;/gm;
    while ((m = propRe.exec(content)) !== null) {
      const modifiers = m[1];
      const propType = m[2] || undefined;
      const propName = m[3];
      const value = m[4] ? m[4].trim().slice(0, 200) : undefined;
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: propName,
        value: value || propType,
        return_type: propType,
        line_start: lineAt(content, m.index),
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Constants
    // ══════════════════════════════════════════════
    const constRe = /^\s+(?:(?:public|protected|private)\s+)?const\s+(\w+)\s*=\s*([^;]+);/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
        parent_id: this.findParentType(content, m.index),
      });
    }

    // ══════════════════════════════════════════════
    // 7. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /(?:\/\/|#)\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 8. PHPDoc-Kommentare (/** ... */)
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
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: false,
      });
    }

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


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
    const classMatch = before.match(/(?:class|interface|trait|enum)\s+(\w+)[^{]*\{[^}]*$/);
    return classMatch ? classMatch[1] : undefined;
  }
}

export const phpParser = new PhpParser();
