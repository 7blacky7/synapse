/**
 * MODUL: Java Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Java-Dateien
 *
 * EXTRAHIERT: class, interface, enum, record, method, field, import,
 *             package, annotation, comment, todo
 * ANSATZ: Regex-basiert — Java hat konsistente Deklarations-Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

/** Java: public/protected = exported, private/package-private = nicht */
function isExportedMod(modifiers: string): boolean {
  return /\b(public|protected)\b/.test(modifiers);
}

class JavaParser implements LanguageParser {
  language = 'java';
  extensions = ['.java'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package-Deklaration
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+([\w.]+)\s*;/m;
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
    const importRe = /^import\s+(?:static\s+)?([\w.*]+)\s*;/gm;
    while ((m = importRe.exec(content)) !== null) {
      const pkg = m[1];
      const name = pkg.split('.').pop() || pkg;
      symbols.push({
        symbol_type: 'import',
        name,
        value: pkg,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name === '*' ? pkg.split('.').slice(-2, -1)[0] || pkg : name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Klassen, Interfaces, Enums, Records
    // ══════════════════════════════════════════════
    const classRe = /^([ \t]*)((?:(?:public|protected|private|static|abstract|final|sealed|non-sealed)\s+)*)(class|interface|enum|record|@interface)\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+([\w.<>,\s]+))?(?:\s+implements\s+([\w.<>,\s]+))?\s*(?:\([^)]*\)\s*)?\{/gm;
    while ((m = classRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const extendsClause = m[5];
      const implementsClause = m[6];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' || kind === '@interface' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (extendsClause) {
        parents.push(...extendsClause.split(',').map(s => s.trim().split('<')[0]));
      }
      if (implementsClause) {
        parents.push(...implementsClause.split(',').map(s => s.trim().split('<')[0]));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExportedMod(modifiers),
      });

      for (const parent of parents) {
        if (parent) {
          references.push({
            symbol_name: parent,
            line_number: lineStart,
            context: `${kind} ${name} ${extendsClause ? 'extends ' + extendsClause.trim() : ''} ${implementsClause ? 'implements ' + implementsClause.trim() : ''}`.trim().slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methoden
    // ══════════════════════════════════════════════
    const methodRe = /^([ \t]+)((?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*)(?:(<[^>]+>)\s+)?(\w[\w.<>,\[\]]*)\s+(\w+)\s*\(([^)]*)\)(?:\s+throws\s+([\w.<>,\s]+))?\s*\{/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const modifiers = m[2];
      const returnType = m[4];
      const methodName = m[5];
      const paramsRaw = m[6];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      // Skip: class/interface/enum (already matched above)
      if (['class', 'interface', 'enum', 'record', 'new', 'if', 'for', 'while', 'switch', 'try', 'catch'].includes(methodName)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(/\s+/);
          return parts[parts.length - 1]; // letztes Wort = Parametername
        })
        .filter(p => p && p.length > 0);

      const parentClass = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: methodName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExportedMod(modifiers),
        parent_id: parentClass,
      });
    }

    // Konstruktoren
    const ctorRe = /^([ \t]+)((?:(?:public|protected|private)\s+)?)(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.<>,\s]+\s*)?\{/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      const modifiers = m[2];
      const name = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      // Nur wenn Name == umgebende Klasse (Konstruktor-Heuristik)
      const parentClass = this.findParentType(content, m.index);
      if (parentClass !== name) continue;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'constructor',
        params,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: isExportedMod(modifiers),
        parent_id: parentClass,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Felder (Variablen in Klassen)
    // ══════════════════════════════════════════════
    const fieldRe = /^([ \t]+)((?:(?:public|protected|private|static|final|volatile|transient)\s+)+)(\w[\w.<>,\[\]]*)\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
    while ((m = fieldRe.exec(content)) !== null) {
      const modifiers = m[2];
      const fieldType = m[3];
      const fieldName = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      const parentClass = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: fieldName,
        value: value || fieldType,
        return_type: fieldType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentClass,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Annotations (@Override, @Inject, etc.)
    // ══════════════════════════════════════════════
    const annotRe = /^[ \t]*@(\w+)(?:\([^)]*\))?/gm;
    while ((m = annotRe.exec(content)) !== null) {
      const name = m[1];
      if (['Override', 'Deprecated', 'SuppressWarnings', 'FunctionalInterface'].includes(name)) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
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
    // 8. Block-Kommentare (/** ... */ und /* ... */)
    // ══════════════════════════════════════════════
    const blockCommentRe = /\/\*\*([\s\S]*?)\*\//g;
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
    const classMatch = before.match(/(?:class|interface|enum|record)\s+(\w+)[^{]*\{[^}]*$/);
    return classMatch ? classMatch[1] : undefined;
  }
}

export const javaParser = new JavaParser();
