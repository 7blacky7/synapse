/**
 * MODUL: Dart Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Dart-Dateien
 *
 * EXTRAHIERT: class, mixin, extension, enum, function, method,
 *             field, import/export, typedef, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class DartParser implements LanguageParser {
  language = 'dart';
  extensions = ['.dart'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Imports / Exports
    // ══════════════════════════════════════════════
    const importRe = /^(import|export)\s+'([^']+)'(?:\s+as\s+(\w+))?(?:\s+(?:show|hide)\s+[\w,\s]+)?;/gm;
    while ((m = importRe.exec(content)) !== null) {
      const kind = m[1];
      const uri = m[2];
      const alias = m[3];
      const name = alias || uri.split('/').pop()?.replace('.dart', '') || uri;
      symbols.push({
        symbol_type: 'import',
        name,
        value: uri,
        line_start: lineAt(content, m.index),
        is_exported: kind === 'export',
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // part / part of
    const partRe = /^part\s+(?:of\s+)?'([^']+)';/gm;
    while ((m = partRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1].split('/').pop()?.replace('.dart', '') || m[1],
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Classes, Mixins, Extensions, Enums
    // ══════════════════════════════════════════════
    const typeRe = /^(abstract\s+)?(class|mixin|enum)\s+(\w+)(?:<[^>]+>)?(?:\s+(?:extends|with|implements|on)\s+([^\n{]+))?\s*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const isAbstract = !!m[1];
      const kind = m[2];
      const name = m[3];
      const clause = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'mixin' ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (clause) {
        parents.push(...clause.split(/,|\s+with\s+|\s+implements\s+/).map(s =>
          s.trim().split('<')[0].trim()
        ).filter(s => s && !['extends', 'with', 'implements', 'on'].includes(s)));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: isAbstract ? `abstract ${kind}` : kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !name.startsWith('_'),
      });

      for (const p of parents) {
        references.push({ symbol_name: p, line_number: lineStart, context: `${kind} ${name}` });
      }
    }

    // extension
    const extRe = /^extension\s+(\w+)?\s+on\s+(\w+)(?:<[^>]+>)?\s*\{/gm;
    while ((m = extRe.exec(content)) !== null) {
      const name = m[1] || m[2];
      references.push({
        symbol_name: m[2],
        line_number: lineAt(content, m.index),
        context: `extension ${m[1] || ''} on ${m[2]}`.trim(),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Functions / Methods
    // ══════════════════════════════════════════════
    const funcRe = /^(\s*)((?:(?:static|external|abstract)\s+)?)((?:Future|Stream|FutureOr|void|dynamic|int|double|String|bool|List|Map|Set|\w+)(?:<[^>]*>)?(?:\??)?)\s+(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?:async\s*\*?|sync\s*\*)?\s*(?:\{|=>|;)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const returnType = m[3];
      const name = m[4];
      const paramsRaw = m[5];
      const lineStart = lineAt(content, m.index);

      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'class', 'enum'].includes(name)) continue;

      const params = paramsRaw
        .split(',')
        .map(p => {
          const clean = p.trim().replace(/^\{|\}$/g, '').replace(/^required\s+/, '').trim();
          const parts = clean.split(/\s+/);
          return parts[parts.length - 1]?.replace(/[?]$/, '') || '';
        })
        .filter(p => p && !p.startsWith('//'));

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !name.startsWith('_'),
        parent_id: parentType,
      });
    }

    // Constructors
    const ctorRe = /^(\s*)(?:const\s+)?(\w+)(?:\.(\w+))?\s*\(([^)]*)\)\s*(?::\s*[^\n{]+)?\s*(?:\{|;)/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      const name = m[2];
      const named = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      const parentType = this.findParentType(content, m.index);
      if (parentType !== name) continue;

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().replace(/^\{|\}$/g, '').replace(/^(required\s+)?this\./, '').split(/\s+/).pop()?.replace(/[?,]$/, '') || '')
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name: named ? `${name}.${named}` : name,
        value: 'constructor',
        params,
        line_start: lineStart,
        is_exported: !name.startsWith('_'),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Fields / Properties
    // ══════════════════════════════════════════════
    const fieldRe = /^(\s+)((?:(?:static|late|final|const|external)\s+)*)(\w[\w<>,?]*)\s+(\w+)\s*(?:=\s*([^;]+))?\s*;/gm;
    while ((m = fieldRe.exec(content)) !== null) {
      const modifiers = m[2];
      const fieldType = m[3];
      const name = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      if (['return', 'throw', 'print', 'assert'].includes(fieldType)) continue;
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || fieldType,
        return_type: fieldType,
        line_start: lineStart,
        is_exported: !name.startsWith('_'),
        parent_id: parentType,
      });
    }

    // Top-level const/final
    const topVarRe = /^((?:const|final)\s+)(?:(\w[\w<>,?]*)\s+)?(\w+)\s*=\s*([^;]+);/gm;
    while ((m = topVarRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[3],
        value: m[4].trim().slice(0, 200),
        return_type: m[2] || undefined,
        line_start: lineAt(content, m.index),
        is_exported: !m[3].startsWith('_'),
      });
    }

    // typedef
    const typedefRe = /^typedef\s+(\w+)\s*(?:<[^>]+>)?\s*=\s*(.+);/gm;
    while ((m = typedefRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: !m[1].startsWith('_'),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Annotations (@override, @injectable, etc.)
    // ══════════════════════════════════════════════
    const annotRe = /^\s*@(\w+)(?:\([^)]*\))?/gm;
    while ((m = annotRe.exec(content)) !== null) {
      const name = m[1];
      if (['override', 'protected', 'required', 'immutable', 'mustCallSuper'].includes(name)) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 6. TODO / FIXME / HACK
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
    // 7. Doc-Comments (/// und /** */)
    // ══════════════════════════════════════════════
    const lines = content.split('\n');
    let docBlock: string[] = [];
    let docStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('///')) {
        if (docBlock.length === 0) docStart = i + 1;
        docBlock.push(line.replace(/^\/\/\/\s?/, ''));
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
    const match = before.match(/(?:class|mixin|enum|extension)\s+(\w+)[^{]*\{[^}]*$/);
    return match ? match[1] : undefined;
  }
}

export const dartParser = new DartParser();
