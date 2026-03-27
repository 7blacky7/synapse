/**
 * MODUL: Objective-C Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Objective-C-Dateien (.m, .mm)
 *
 * EXTRAHIERT: #import/#include, @interface, @implementation, @protocol,
 *             @property, method declarations (-/+), @synthesize, @dynamic,
 *             typedef, enum (NS_ENUM/NS_OPTIONS), struct, #define,
 *             @class forward declarations, comment, todo
 * ANSATZ: Regex-basiert
 *
 * HINWEIS: .h Header-Dateien werden vom C-Parser behandelt,
 *          .m/.mm Dateien von diesem Parser.
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

class ObjcParser implements LanguageParser {
  language = 'objc';
  extensions = ['.m', '.mm'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. #import / #include
    // ══════════════════════════════════════════════
    const importRe = /^#(import|include)\s+[<"]([^>"]+)[>"]/gm;
    while ((m = importRe.exec(content)) !== null) {
      const path = m[2];
      const name = path.split('/').pop()?.replace(/\.h$/, '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: path,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: `#${m[1]} ${path}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. @class (forward declarations)
    // ══════════════════════════════════════════════
    const classForwardRe = /^@class\s+([\w,\s]+)\s*;/gm;
    while ((m = classForwardRe.exec(content)) !== null) {
      const classes = m[1].split(',').map(c => c.trim()).filter(Boolean);
      for (const cls of classes) {
        references.push({
          symbol_name: cls,
          line_number: lineAt(content, m.index),
          context: `@class ${cls}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. @interface
    // ══════════════════════════════════════════════
    const ifaceRe = /^@interface\s+(\w+)\s*(?::\s*(\w+))?\s*(?:<([^>]+)>)?/gm;
    while ((m = ifaceRe.exec(content)) !== null) {
      const name = m[1];
      const superClass = m[2];
      const protocols = m[3] ? m[3].split(',').map(p => p.trim()).filter(Boolean) : [];
      const lineStart = lineAt(content, m.index);

      const params: string[] = [];
      if (superClass) params.push(superClass);
      if (protocols.length > 0) params.push(...protocols.map(p => `<${p}>`));

      symbols.push({
        symbol_type: 'class',
        name,
        value: '@interface',
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: true,
      });

      if (superClass) {
        references.push({
          symbol_name: superClass,
          line_number: lineStart,
          context: `@interface ${name} : ${superClass}`.slice(0, 80),
        });
      }
      for (const proto of protocols) {
        references.push({
          symbol_name: proto,
          line_number: lineStart,
          context: `@interface ${name} <${protocols.join(', ')}>`.slice(0, 80),
        });
      }
    }

    // Category
    const catRe = /^@interface\s+(\w+)\s*\(\s*(\w*)\s*\)/gm;
    while ((m = catRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2] ? `${m[1]}(${m[2]})` : `${m[1]}()`,
        value: m[2] ? 'category' : 'extension',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. @implementation
    // ══════════════════════════════════════════════
    const implRe = /^@implementation\s+(\w+)/gm;
    while ((m = implRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: '@implementation',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. @protocol
    // ══════════════════════════════════════════════
    const protoRe = /^@protocol\s+(\w+)\s*(?:<([^>]+)>)?/gm;
    while ((m = protoRe.exec(content)) !== null) {
      if (m[0].trim().endsWith(';')) continue; // Forward declaration
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: '@protocol',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. @property
    // ══════════════════════════════════════════════
    const propRe = /^@property\s*\(([^)]*)\)\s*(\w[\w\s*<>]*?)\s*\*?\s*(\w+)\s*;/gm;
    while ((m = propRe.exec(content)) !== null) {
      const attrs = m[1];
      const propType = m[2].trim();
      const name = m[3];

      symbols.push({
        symbol_type: 'variable',
        name,
        value: propType,
        return_type: propType,
        line_start: lineAt(content, m.index),
        is_exported: !/\breadonly\b/.test(attrs) || true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Method declarations (-/+)
    // ══════════════════════════════════════════════
    const methodRe = /^([+-])\s*\(([^)]+)\)\s*(\w+)(?::(\s*\([^)]+\)\s*\w+\s*(?:\w+:\s*\([^)]+\)\s*\w+\s*)*))?/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const isClassMethod = m[1] === '+';
      const returnType = m[2].trim();
      const name = m[3];
      const paramsRaw = m[4] || '';
      const lineStart = lineAt(content, m.index);

      // Build selector name from params
      const paramParts = paramsRaw.match(/\w+:/g);
      const selector = paramParts ? `${name}:${paramParts.join('')}` : name;

      symbols.push({
        symbol_type: 'function',
        name: selector.replace(/:$/, ''),
        value: isClassMethod ? 'class method' : 'instance method',
        return_type: returnType,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. NS_ENUM / NS_OPTIONS
    // ══════════════════════════════════════════════
    const nsEnumRe = /typedef\s+NS_(?:ENUM|OPTIONS)\s*\(\s*\w+\s*,\s*(\w+)\s*\)\s*\{/gm;
    while ((m = nsEnumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[1],
        value: 'NS_ENUM',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. #define macros
    // ══════════════════════════════════════════════
    const defineRe = /^#define\s+(\w+)(?:\(([^)]*)\))?\s+(.+)/gm;
    while ((m = defineRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2] ? m[2].split(',').map(p => p.trim()).filter(Boolean) : undefined;
      const value = m[3].trim().replace(/\\$/, '').slice(0, 200);

      symbols.push({
        symbol_type: params ? 'function' : 'variable',
        name,
        value: params ? 'macro' : value,
        params,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
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
    // 11. Doc comments (/** ... */)
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
}

export const objcParser = new ObjcParser();
