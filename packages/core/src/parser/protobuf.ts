/**
 * MODUL: Protobuf Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Protocol Buffer-Dateien (.proto)
 *
 * EXTRAHIERT: syntax, package, import, option, message, field, oneof,
 *             enum, enum value, service, rpc, map field, reserved,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ProtobufParser implements LanguageParser {
  language = 'protobuf';
  extensions = ['.proto'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Syntax
    // ══════════════════════════════════════════════
    const syntaxRe = /^syntax\s*=\s*"([^"]+)"/m;
    m = syntaxRe.exec(content);
    if (m) {
      symbols.push({
        symbol_type: 'variable',
        name: 'syntax',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Package
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
    // 3. Imports
    // ══════════════════════════════════════════════
    const importRe = /^import\s+(?:(weak|public)\s+)?"([^"]+)"\s*;/gm;
    while ((m = importRe.exec(content)) !== null) {
      const modifier = m[1] || '';
      const path = m[2];
      const name = path.split('/').pop()?.replace('.proto', '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: modifier ? `${modifier} ${path}` : path,
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
    // 4. Options (file-level)
    // ══════════════════════════════════════════════
    const optionRe = /^option\s+([\w.()]+)\s*=\s*([^;]+);/gm;
    while ((m = optionRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Messages
    // ══════════════════════════════════════════════
    const msgRe = /^(\s*)message\s+(\w+)\s*\{/gm;
    while ((m = msgRe.exec(content)) !== null) {
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'message',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Parse fields inside this message
      this.parseFields(content, m.index + m[0].length, lineEnd, name, symbols, references);
    }

    // ══════════════════════════════════════════════
    // 6. Enums
    // ══════════════════════════════════════════════
    const enumRe = /^(\s*)enum\s+(\w+)\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'enum',
        name,
        value: 'enum',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Parse enum values
      const blockStart = m.index + m[0].length;
      const blockEnd = content.indexOf('}', blockStart);
      if (blockEnd > blockStart) {
        const block = content.substring(blockStart, blockEnd);
        const valRe = /^\s*(\w+)\s*=\s*(\d+)/gm;
        let vm: RegExpExecArray | null;
        while ((vm = valRe.exec(block)) !== null) {
          symbols.push({
            symbol_type: 'variable',
            name: vm[1],
            value: vm[2],
            line_start: lineAt(content, blockStart + vm.index),
            is_exported: true,
            parent_id: name,
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 7. Services
    // ══════════════════════════════════════════════
    const svcRe = /^service\s+(\w+)\s*\{/gm;
    while ((m = svcRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'service',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Parse RPCs inside the service
      const blockStart = m.index + m[0].length;
      const blockContent = content.substring(blockStart);
      const rpcRe = /^\s*rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)/gm;
      let rm: RegExpExecArray | null;
      while ((rm = rpcRe.exec(blockContent)) !== null) {
        const rpcLine = lineAt(content, blockStart + rm.index);
        if (rpcLine > lineEnd) break;

        const rpcName = rm[1];
        const inputStream = rm[2] ? 'stream ' : '';
        const inputType = rm[3];
        const outputStream = rm[4] ? 'stream ' : '';
        const outputType = rm[5];

        symbols.push({
          symbol_type: 'function',
          name: rpcName,
          params: [`${inputStream}${inputType}`],
          return_type: `${outputStream}${outputType}`,
          line_start: rpcLine,
          is_exported: true,
          parent_id: name,
        });

        references.push({
          symbol_name: inputType,
          line_number: rpcLine,
          context: `rpc ${rpcName}(${inputStream}${inputType}) returns (${outputStream}${outputType})`.slice(0, 80),
        });
        if (inputType !== outputType) {
          references.push({
            symbol_name: outputType,
            line_number: rpcLine,
            context: `rpc ${rpcName}(${inputStream}${inputType}) returns (${outputStream}${outputType})`.slice(0, 80),
          });
        }
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
    const commentRe = /\/\*([\s\S]*?)\*\//g;
    while ((m = commentRe.exec(content)) !== null) {
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

  private parseFields(
    content: string, blockStart: number, blockLineEnd: number,
    parentName: string, symbols: ParsedSymbol[], references: ParsedReference[]
  ): void {
    const block = content.substring(blockStart);
    // Regular fields: optional/required/repeated type name = number;
    const fieldRe = /^\s*(optional|required|repeated)?\s*(map<\s*\w+\s*,\s*\w+\s*>|[\w.]+)\s+(\w+)\s*=\s*(\d+)/gm;
    let fm: RegExpExecArray | null;
    while ((fm = fieldRe.exec(block)) !== null) {
      const fieldLine = lineAt(content, blockStart + fm.index);
      if (fieldLine > blockLineEnd) break;

      const modifier = fm[1] || '';
      const fieldType = fm[2];
      const fieldName = fm[3];
      const fieldNumber = fm[4];

      symbols.push({
        symbol_type: 'variable',
        name: fieldName,
        value: `${modifier ? modifier + ' ' : ''}${fieldType} = ${fieldNumber}`,
        return_type: fieldType,
        line_start: fieldLine,
        is_exported: true,
        parent_id: parentName,
      });

      // Reference to type if it's not a scalar
      if (!/^(double|float|int32|int64|uint32|uint64|sint32|sint64|fixed32|fixed64|sfixed32|sfixed64|bool|string|bytes)$/.test(fieldType) && !fieldType.startsWith('map<')) {
        references.push({
          symbol_name: fieldType.split('.').pop() || fieldType,
          line_number: fieldLine,
          context: `${fieldType} ${fieldName} = ${fieldNumber}`.slice(0, 80),
        });
      }
    }

    // Oneof
    const oneofRe = /^\s*oneof\s+(\w+)\s*\{/gm;
    let om: RegExpExecArray | null;
    while ((om = oneofRe.exec(block)) !== null) {
      const oneofLine = lineAt(content, blockStart + om.index);
      if (oneofLine > blockLineEnd) break;

      symbols.push({
        symbol_type: 'variable',
        name: om[1],
        value: 'oneof',
        line_start: oneofLine,
        is_exported: true,
        parent_id: parentName,
      });
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

export const protobufParser = new ProtobufParser();
