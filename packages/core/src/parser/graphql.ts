/**
 * MODUL: GraphQL Parser
 * ZWECK: Extrahiert Struktur-Informationen aus GraphQL-Dateien (.graphql, .gql)
 *
 * EXTRAHIERT: type, input, interface, enum, union, scalar, directive,
 *             query, mutation, subscription, fragment, field, argument,
 *             extend, schema, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class GraphQLParser implements LanguageParser {
  language = 'graphql';
  extensions = ['.graphql', '.gql'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Schema definition
    // ══════════════════════════════════════════════
    const schemaRe = /^schema\s*\{/gm;
    m = schemaRe.exec(content);
    if (m) {
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);
      symbols.push({
        symbol_type: 'class',
        name: 'schema',
        value: 'schema',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Types, Inputs, Interfaces (with extend)
    // ══════════════════════════════════════════════
    const typeRe = /^(extend\s+)?(type|input|interface)\s+(\w+)(?:\s+implements\s+([^\n{]+))?\s*(?:@\w+(?:\([^)]*\))?\s*)*\{/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const isExtend = !!m[1];
      const kind = m[2];
      const name = m[3];
      const implementsClause = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface' : 'class';

      const parents: string[] = [];
      if (implementsClause) {
        parents.push(...implementsClause.split('&').map(s => s.trim()).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name: isExtend ? `extend ${name}` : name,
        value: isExtend ? `extend ${kind}` : kind,
        params: parents.length > 0 ? parents.map(p => `implements ${p}`) : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      for (const parent of parents) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name} implements ${implementsClause?.trim()}`.slice(0, 80),
        });
      }

      // Parse fields inside this type
      this.parseFields(content, m.index + m[0].length, lineEnd, name, symbols, references);
    }

    // ══════════════════════════════════════════════
    // 3. Enums
    // ══════════════════════════════════════════════
    const enumRe = /^(extend\s+)?enum\s+(\w+)\s*(?:@\w+(?:\([^)]*\))?\s*)*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const isExtend = !!m[1];
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'enum',
        name: isExtend ? `extend ${name}` : name,
        value: isExtend ? 'extend enum' : 'enum',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Parse enum values
      const blockStart = m.index + m[0].length;
      const blockEnd = content.indexOf('}', blockStart);
      if (blockEnd > blockStart) {
        const block = content.substring(blockStart, blockEnd);
        const valRe = /^\s*(\w+)/gm;
        let vm: RegExpExecArray | null;
        while ((vm = valRe.exec(block)) !== null) {
          const valName = vm[1];
          if (valName === 'extend' || valName === 'type' || valName === 'enum') continue;
          symbols.push({
            symbol_type: 'variable',
            name: valName,
            value: 'enum_value',
            line_start: lineAt(content, blockStart + vm.index),
            is_exported: true,
            parent_id: name,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Unions
    // ══════════════════════════════════════════════
    const unionRe = /^(extend\s+)?union\s+(\w+)\s*(?:@\w+(?:\([^)]*\))?\s*)*=\s*([^\n]+)/gm;
    while ((m = unionRe.exec(content)) !== null) {
      const isExtend = !!m[1];
      const name = m[2];
      const members = m[3].split('|').map(s => s.trim()).filter(Boolean);
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'interface',
        name: isExtend ? `extend ${name}` : name,
        value: 'union',
        params: members,
        line_start: lineStart,
        is_exported: true,
      });

      for (const member of members) {
        references.push({
          symbol_name: member,
          line_number: lineStart,
          context: `union ${name} = ${members.join(' | ')}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Scalars
    // ══════════════════════════════════════════════
    const scalarRe = /^scalar\s+(\w+)/gm;
    while ((m = scalarRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: 'scalar',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Directives
    // ══════════════════════════════════════════════
    const directiveRe = /^directive\s+@(\w+)(?:\s*\(([^)]*)\))?\s+(?:repeatable\s+)?on\s+([^\n]+)/gm;
    while ((m = directiveRe.exec(content)) !== null) {
      const name = m[1];
      const args = m[2] || '';
      const locations = m[3].split('|').map(s => s.trim()).filter(Boolean);
      const lineStart = lineAt(content, m.index);

      const params = args
        .split(',')
        .map(p => p.trim().split(':')[0].replace(/^\$/, '').trim())
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name: `@${name}`,
        value: 'directive',
        params: params.length > 0 ? params : locations,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Fragment definitions
    // ══════════════════════════════════════════════
    const fragmentRe = /^fragment\s+(\w+)\s+on\s+(\w+)\s*\{/gm;
    while ((m = fragmentRe.exec(content)) !== null) {
      const name = m[1];
      const onType = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'function',
        name,
        value: 'fragment',
        params: [`on ${onType}`],
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      references.push({
        symbol_name: onType,
        line_number: lineStart,
        context: `fragment ${name} on ${onType}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 8. Standalone Query/Mutation/Subscription operations
    // ══════════════════════════════════════════════
    const opRe = /^(query|mutation|subscription)\s+(\w+)(?:\s*\(([^)]*)\))?\s*\{/gm;
    while ((m = opRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const argsRaw = m[3] || '';
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const params = argsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].replace(/^\$/, '').trim())
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        value: kind,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /#\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 10. Description strings (""" ... """)
    // ══════════════════════════════════════════════
    const descRe = /"""([\s\S]*?)"""/g;
    while ((m = descRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // Single-line descriptions ("...")
    const descSingleRe = /^"([^"]+)"\s*$/gm;
    while ((m = descSingleRe.exec(content)) !== null) {
      const text = m[1].trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Line comments (#)
    // ══════════════════════════════════════════════
    // Already handled by TODO regex; skip generic comments

    symbols.push(...extractStringLiterals(content));


    return { symbols, references };
  }

  private parseFields(
    content: string, blockStart: number, blockLineEnd: number,
    parentName: string, symbols: ParsedSymbol[], references: ParsedReference[]
  ): void {
    const lines = content.substring(blockStart).split('\n');
    let currentLine = lineAt(content, blockStart);
    let depth = 0;

    for (const line of lines) {
      if (currentLine > blockLineEnd) break;
      const trimmed = line.trim();

      // Track brace depth to skip nested types
      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }

      if (depth === 0 && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('"')) {
        const fieldMatch = trimmed.match(/^(\w+)(?:\s*\(([^)]*)\))?\s*:\s*(\S[^\n#@]*)/);
        if (fieldMatch) {
          const fieldName = fieldMatch[1];
          const args = fieldMatch[2] || '';
          const fieldType = fieldMatch[3].trim().replace(/\s*@.*$/, '');

          symbols.push({
            symbol_type: 'variable',
            name: fieldName,
            value: fieldType,
            return_type: fieldType,
            line_start: currentLine,
            is_exported: true,
            parent_id: parentName,
          });

          // Reference to non-scalar types
          const baseType = fieldType.replace(/[!\[\]]/g, '').trim();
          if (!/^(String|Int|Float|Boolean|ID)$/.test(baseType)) {
            references.push({
              symbol_name: baseType,
              line_number: currentLine,
              context: `${fieldName}: ${fieldType}`.slice(0, 80),
            });
          }
        }
      }
      currentLine++;
    }
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

export const graphqlParser = new GraphQLParser();
