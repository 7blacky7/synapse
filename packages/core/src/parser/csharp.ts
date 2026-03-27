/**
 * MODUL: C# Parser
 * ZWECK: Extrahiert Struktur-Informationen aus C#-Dateien
 *
 * EXTRAHIERT: class, struct, interface, enum, record, method, property,
 *             field, using, namespace, delegate, event, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

function isExportedMod(modifiers: string): boolean {
  return /\b(public|protected|internal)\b/.test(modifiers);
}

class CSharpParser implements LanguageParser {
  language = 'csharp';
  extensions = ['.cs'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. using-Deklarationen
    // ══════════════════════════════════════════════
    const usingRe = /^using\s+(?:static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      const alias = m[1] || null;
      const ns = m[2];
      const name = alias || ns.split('.').pop() || ns;
      symbols.push({
        symbol_type: 'import',
        name,
        value: ns,
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
    // 2. Namespaces
    // ══════════════════════════════════════════════
    // File-scoped namespace
    const fileScopedNsRe = /^namespace\s+([\w.]+)\s*;/m;
    m = fileScopedNsRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }
    // Block namespace
    const blockNsRe = /^namespace\s+([\w.]+)\s*\{/gm;
    while ((m = blockNsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Typen: class, struct, interface, enum, record
    // ══════════════════════════════════════════════
    const typeRe = /^([ \t]*)((?:(?:public|protected|private|internal|static|abstract|sealed|partial|readonly|ref)\s+)*)(class|struct|interface|enum|record)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\n{]+))?\s*(?:where\s+[^\n{]+\s*)?\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const baseClause = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const bases: string[] = [];
      if (baseClause) {
        bases.push(...baseClause.split(',').map(s => s.trim().split('<')[0].trim()).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: bases.length > 0 ? bases : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isExportedMod(modifiers),
      });

      for (const base of bases) {
        if (base) {
          references.push({
            symbol_name: base,
            line_number: lineStart,
            context: `${kind} ${name} : ${baseClause?.trim()}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Methoden
    // ══════════════════════════════════════════════
    const methodRe = /^([ \t]+)((?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|async|new|extern|partial|unsafe)\s+)*)(?:(\w[\w.<>,\[\]?]*)\s+)(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:where\s+[^\n{]+\s*)?(?:\{|=>)/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const modifiers = m[2];
      const returnType = m[3];
      const methodName = m[4];
      const paramsRaw = m[5];
      const lineStart = lineAt(content, m.index);

      // Skip bekannte nicht-Methoden
      if (['if', 'for', 'foreach', 'while', 'switch', 'catch', 'lock', 'using', 'return', 'new', 'throw', 'class', 'struct', 'namespace'].includes(methodName)) continue;
      if (['get', 'set', 'init', 'add', 'remove'].includes(methodName)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => {
          const parts = p.trim().split(/\s+/);
          return parts[parts.length - 1];
        })
        .filter(p => p && p.length > 0);

      const parentType = this.findParentType(content, m.index);
      const isAsync = modifiers.includes('async');

      symbols.push({
        symbol_type: 'function',
        name: methodName,
        value: isAsync ? 'async' : undefined,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: m[0].includes('{') ? this.findClosingBrace(content, m.index + m[0].length - 1) : lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // Konstruktoren
    const ctorRe = /^([ \t]+)((?:(?:public|protected|private|internal|static)\s+)*)(\w+)\s*\(([^)]*)\)\s*(?::\s*(?:base|this)\s*\([^)]*\)\s*)?\{/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      const modifiers = m[2];
      const name = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      const parentType = this.findParentType(content, m.index);
      if (parentType !== name) continue;

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
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Properties
    // ══════════════════════════════════════════════
    const propRe = /^([ \t]+)((?:(?:public|protected|private|internal|static|virtual|override|abstract|sealed|new|required)\s+)*)(\w[\w.<>,\[\]?]*)\s+(\w+)\s*\{(?:\s*(?:get|set|init)\s*[;{])/gm;
    while ((m = propRe.exec(content)) !== null) {
      const modifiers = m[2];
      const propType = m[3];
      const propName = m[4];
      const lineStart = lineAt(content, m.index);
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: propName,
        value: propType,
        return_type: propType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Felder
    // ══════════════════════════════════════════════
    const fieldRe = /^([ \t]+)((?:(?:public|protected|private|internal|static|readonly|volatile|const|new)\s+)+)(\w[\w.<>,\[\]?]*)\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
    while ((m = fieldRe.exec(content)) !== null) {
      const modifiers = m[2];
      const fieldType = m[3];
      const fieldName = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name: fieldName,
        value: value || fieldType,
        return_type: fieldType,
        line_start: lineStart,
        is_exported: isExportedMod(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Delegates und Events
    // ══════════════════════════════════════════════
    const delegateRe = /^([ \t]*)((?:(?:public|protected|private|internal)\s+)*)delegate\s+(\w[\w.<>,\[\]?]*)\s+(\w+)\s*\(([^)]*)\)\s*;/gm;
    while ((m = delegateRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[4],
        value: 'delegate',
        return_type: m[3],
        line_start: lineAt(content, m.index),
        is_exported: isExportedMod(m[2]),
      });
    }

    const eventRe = /^([ \t]+)((?:(?:public|protected|private|internal|static)\s+)*)event\s+(\w[\w.<>,]*)\s+(\w+)\s*;/gm;
    while ((m = eventRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[4],
        value: `event ${m[3]}`,
        line_start: lineAt(content, m.index),
        is_exported: isExportedMod(m[2]),
        parent_id: this.findParentType(content, m.index),
      });
    }

    // ══════════════════════════════════════════════
    // 8. Attributes ([Attribute])
    // ══════════════════════════════════════════════
    const attrRe = /^\s*\[(\w+)(?:\([^)]*\))?\]/gm;
    while ((m = attrRe.exec(content)) !== null) {
      const name = m[1];
      if (['assembly', 'module'].includes(name.toLowerCase())) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
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
    // 10. XML-Doc-Comments (/// <summary>)
    // ══════════════════════════════════════════════
    const lines = content.split('\n');
    let docBlock: string[] = [];
    let docStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('///')) {
        if (docBlock.length === 0) docStart = i + 1;
        docBlock.push(line.replace(/^\/\/\/\s?/, '').replace(/<[^>]+>/g, '').trim());
      } else {
        if (docBlock.length >= 1) {
          const text = docBlock.join(' ').trim();
          if (text.length > 3) {
            symbols.push({
              symbol_type: 'comment',
              name: null,
              value: text.slice(0, 500),
              line_start: docStart,
              line_end: docStart + docBlock.length - 1,
              is_exported: false,
            });
          }
        }
        docBlock = [];
      }
    }
    if (docBlock.length >= 1) {
      const text = docBlock.join(' ').trim();
      if (text.length > 3) {
        symbols.push({
          symbol_type: 'comment',
          name: null,
          value: text.slice(0, 500),
          line_start: docStart,
          line_end: docStart + docBlock.length - 1,
          is_exported: false,
        });
      }
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
    const classMatch = before.match(/(?:class|struct|interface|enum|record)\s+(\w+)[^{]*\{[^}]*$/);
    return classMatch ? classMatch[1] : undefined;
  }
}

export const csharpParser = new CSharpParser();
