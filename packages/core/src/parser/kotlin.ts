/**
 * MODUL: Kotlin Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Kotlin-Dateien
 *
 * EXTRAHIERT: class, object, data class, sealed class, interface, enum,
 *             fun, val/var, import, package, annotation, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class KotlinParser implements LanguageParser {
  language = 'kotlin';
  extensions = ['.kt', '.kts'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+([\w.]+)/m;
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
    const importRe = /^import\s+([\w.*]+)/gm;
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
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Classes, Objects, Interfaces, Enums
    // ══════════════════════════════════════════════
    const typeRe = /^(\s*)((?:(?:public|protected|private|internal|open|abstract|sealed|data|inner|value|inline|annotation|expect|actual)\s+)*)(class|object|interface|enum\s+class)\s+(\w+)(?:<[^>]+>)?(?:\s*(?:\([^)]*\)\s*)?)?(?:\s*:\s*([^\n{]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3].trim();
      const name = m[4];
      const baseClause = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface'
        : kind === 'enum class' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (baseClause) {
        parents.push(...baseClause.split(',').map(s =>
          s.trim().split('(')[0].split('<')[0].trim()
        ).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !/\bprivate\b/.test(modifiers),
      });

      for (const parent of parents) {
        if (parent) {
          references.push({
            symbol_name: parent,
            line_number: lineStart,
            context: `${kind} ${name} : ${baseClause?.trim()}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Functions (fun)
    // ══════════════════════════════════════════════
    const funRe = /^(\s*)((?:(?:public|protected|private|internal|open|override|abstract|suspend|inline|infix|operator|tailrec|expect|actual)\s+)*)fun\s+(?:<[^>]+>\s+)?(?:(\w+)\.)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*(\S[^\n{]*))?/gm;
    while ((m = funRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const extensionType = m[3] || undefined;
      const name = m[4];
      const paramsRaw = m[5];
      const returnType = m[6] ? m[6].trim().replace(/\s*\{$/, '') : undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].trim())
        .filter(Boolean);

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;
      const isSuspend = modifiers.includes('suspend');

      symbols.push({
        symbol_type: 'function',
        name: extensionType ? `${extensionType}.${name}` : name,
        value: isSuspend ? 'suspend' : undefined,
        params,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
        parent_id: parentType,
      });

      if (extensionType) {
        references.push({
          symbol_name: extensionType,
          line_number: lineStart,
          context: `fun ${extensionType}.${name}(...)`,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Properties (val/var)
    // ══════════════════════════════════════════════
    const propRe = /^(\s*)((?:(?:public|protected|private|internal|open|override|abstract|const|lateinit|lazy)\s+)*)(val|var)\s+(\w+)(?:\s*:\s*(\S+))?\s*(?:=\s*([^\n]+))?/gm;
    while ((m = propRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const propType = m[5] || undefined;
      const value = m[6] ? m[6].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip lokale Variablen (zu tief eingerückt oder in Funktionen)
      if (indent > 4 && !modifiers.includes('const')) continue;

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || propType || kind,
        return_type: propType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Companion Objects (const val)
    // ══════════════════════════════════════════════
    const constValRe = /^\s+const\s+val\s+(\w+)(?:\s*:\s*\S+)?\s*=\s*(.+)/gm;
    while ((m = constValRe.exec(content)) !== null) {
      // Already caught by property regex, skip duplicates
    }

    // ══════════════════════════════════════════════
    // 7. Annotations
    // ══════════════════════════════════════════════
    const annotRe = /^\s*@(\w+)(?:\([^)]*\))?/gm;
    while ((m = annotRe.exec(content)) !== null) {
      const name = m[1];
      if (['JvmStatic', 'JvmField', 'JvmOverloads', 'Suppress'].includes(name)) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
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
    // 9. KDoc-Kommentare (/** ... */)
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
    const classMatch = before.match(/(?:class|object|interface|enum\s+class)\s+(\w+)[^{]*\{[^}]*$/);
    return classMatch ? classMatch[1] : undefined;
  }
}

export const kotlinParser = new KotlinParser();
