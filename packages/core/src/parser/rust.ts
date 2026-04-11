/**
 * MODUL: Rust Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Rust-Dateien
 *
 * EXTRAHIERT: fn, struct, enum, trait, impl, type alias, const/static,
 *             use, mod, macro, comment, todo
 * ANSATZ: Regex-basiert — Rust hat klare Deklarations-Syntax
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

/** Rust: pub = exported */
function isPub(line: string): boolean {
  return /^\s*pub\b/.test(line);
}

class RustParser implements LanguageParser {
  language = 'rust';
  extensions = ['.rs'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. use-Deklarationen (imports)
    // ══════════════════════════════════════════════
    const useRe = /^(?:pub\s+)?use\s+(.+);/gm;
    while ((m = useRe.exec(content)) !== null) {
      const path = m[1].trim();
      const name = path.split('::').pop()?.replace(/[{}*\s]/g, '') || path;
      symbols.push({
        symbol_type: 'import',
        name,
        value: path,
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
      const crate = path.split('::')[0];
      if (crate && crate !== 'self' && crate !== 'super' && crate !== 'crate') {
        references.push({
          symbol_name: crate,
          line_number: lineAt(content, m.index),
          context: m[0].trim().slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 2. mod-Deklarationen
    // ══════════════════════════════════════════════
    const modRe = /^(?:pub\s+)?mod\s+(\w+)\s*;/gm;
    while ((m = modRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: `mod ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
    }

    // ══════════════════════════════════════════════
    // 3. Structs
    // ══════════════════════════════════════════════
    const structRe = /^(?:#\[[\w(,\s="]*\]\s*\n\s*)*(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)(?:<[^>]+>)?\s*\{([\s\S]*?)\n\}/gm;
    while ((m = structRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      const fields: string[] = [];
      const fieldRe = /^\s+(?:pub(?:\([\w:]+\))?\s+)?(\w+)\s*:\s*([^\n,]+)/gm;
      let fm: RegExpExecArray | null;
      while ((fm = fieldRe.exec(body)) !== null) {
        fields.push(fm[1]);
        // Referenzen auf benutzerdefinierte Typen
        const typeRef = fm[2].trim().replace(/[&*<>\[\]]/g, ' ').split(/\s+/)[0];
        if (typeRef && /^[A-Z]/.test(typeRef) && !['String', 'Vec', 'Option', 'Result', 'Box', 'Arc', 'Rc', 'HashMap', 'HashSet', 'BTreeMap'].includes(typeRef)) {
          references.push({
            symbol_name: typeRef,
            line_number: lineAt(content, m.index + (fm.index || 0)),
            context: `${name}.${fm[1]}: ${fm[2].trim()}`.slice(0, 80),
          });
        }
      }

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub(m[0]),
      });
    }

    // Tuple structs: struct Name(Type);
    const tupleStructRe = /^(?:pub(?:\([\w:]+\))?\s+)?struct\s+(\w+)(?:<[^>]+>)?\s*\(([^)]*)\)\s*;/gm;
    while ((m = tupleStructRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: `struct(${m[2].trim()})`,
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Enums
    // ══════════════════════════════════════════════
    const enumRe = /^(?:pub(?:\([\w:]+\))?\s+)?enum\s+(\w+)(?:<[^>]+>)?\s*\{([\s\S]*?)\n\}/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      const variants: string[] = [];
      const variantRe = /^\s+(\w+)/gm;
      let vm: RegExpExecArray | null;
      while ((vm = variantRe.exec(body)) !== null) {
        if (!['pub', 'fn', 'type', 'use', 'const', 'let'].includes(vm[1])) {
          variants.push(vm[1]);
        }
      }

      symbols.push({
        symbol_type: 'enum',
        name,
        params: variants,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub(m[0]),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Traits
    // ══════════════════════════════════════════════
    const traitRe = /^(?:pub(?:\([\w:]+\))?\s+)?trait\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^\n{]+))?\s*\{([\s\S]*?)\n\}/gm;
    while ((m = traitRe.exec(content)) !== null) {
      const name = m[1];
      const superTraits = m[2] ? m[2].split('+').map(s => s.trim()).filter(Boolean) : [];
      const body = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = endLineAt(content, m.index, m[0].length);

      const methods: string[] = [];
      const methodRe = /fn\s+(\w+)/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(body)) !== null) {
        methods.push(mm[1]);
      }

      symbols.push({
        symbol_type: 'interface',
        name,
        value: superTraits.length > 0 ? superTraits.join(' + ') : undefined,
        params: methods,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub(m[0]),
      });

      for (const st of superTraits) {
        const stName = st.split('<')[0].trim();
        if (stName) {
          references.push({ symbol_name: stName, line_number: lineStart, context: `trait ${name}: ${superTraits.join(' + ')}` });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 6. impl Blocks
    // ══════════════════════════════════════════════
    const implRe = /^impl(?:<[^>]+>)?\s+(?:(\w+)(?:<[^>]+>)?\s+for\s+)?(\w+)(?:<[^>]+>)?\s*\{/gm;
    while ((m = implRe.exec(content)) !== null) {
      const traitName = m[1] || null;
      const typeName = m[2];
      const lineStart = lineAt(content, m.index);

      if (traitName) {
        references.push({
          symbol_name: traitName,
          line_number: lineStart,
          context: `impl ${traitName} for ${typeName}`,
        });
      }
      references.push({
        symbol_name: typeName,
        line_number: lineStart,
        context: traitName ? `impl ${traitName} for ${typeName}` : `impl ${typeName}`,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Funktionen (fn) — multi-line Signaturen + Trait-Method-Stubs
    //
    // Strategie: Erst nur den Header matchen (fn NAME), dann von der Position
    // aus die Parameter-Klammern per Balancing zaehlen, anschliessend bis zum
    // naechsten ';' oder '{' lesen. Das erfasst:
    //   - Multi-line Signaturen  fn foo(\n  a: T,\n  b: U\n) -> R { ... }
    //   - Trait-Method-Stubs     fn foo() -> R;
    //   - Komplexe Return-Types  fn foo() -> Result<HashMap<K,V>,E> { ... }
    //   - Lifetime/Generic-Mix   fn foo<'a, T: Trait<Item=U>>(x: &'a T)
    // ══════════════════════════════════════════════
    const fnHeaderRe = /^([ \t]*)((?:pub(?:\([\w:]+\))?\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?(?:extern\s+(?:"[^"]+"\s+)?)?)fn\s+(\w+)/gm;
    while ((m = fnHeaderRe.exec(content)) !== null) {
      const indentStr = m[1];
      const modifiers = m[2] ?? '';
      const funcName = m[3];

      // Nach dem Namen: optionale Generics <...> per balanced matching ueberspringen,
      // dann die Parameter-Liste ( finden. Das ist robust gegen nested Generics wie
      // Fn(i32) -> i32 oder Iterator<Item = Vec<T>>.
      let cursor = m.index + m[0].length;
      while (cursor < content.length && /[ \t\n\r]/.test(content[cursor])) cursor++;
      if (content[cursor] === '<') {
        let genDepth = 1;
        cursor++;
        while (cursor < content.length && genDepth > 0) {
          const ch = content[cursor];
          if (ch === '<') genDepth++;
          else if (ch === '>') genDepth--;
          cursor++;
        }
      }
      while (cursor < content.length && /[ \t\n\r]/.test(content[cursor])) cursor++;
      if (content[cursor] !== '(') continue;
      const openParenPos = cursor;

      // Balanced paren matching fuer Parameter-Liste.
      // WICHTIG: Nur double-quoted Strings als Literal ueberspringen.
      // Rust-Lifetimes wie 'a oder '_ sind KEINE Strings — sie als Char-Literal zu
      // behandeln wuerde den Parser bis zum naechsten ' Zeichen durchfressen lassen.
      let depth = 1;
      let i = openParenPos + 1;
      while (i < content.length && depth > 0) {
        const c = content[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === '"') {
          i++;
          while (i < content.length && content[i] !== '"') {
            if (content[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }
      if (depth !== 0) continue;
      const closeParenPos = i - 1;
      const paramsRaw = content.slice(openParenPos + 1, closeParenPos);

      // Return-Type/where-Klausel bis zum naechsten ';' oder '{' (Body).
      // -> ist Arrow-Operator: das > darf bracketDepth NICHT senken.
      let j = closeParenPos + 1;
      let bodyStart = -1;
      let isStub = false;
      let bracketDepth = 0;
      while (j < content.length) {
        const c = content[j];
        if (c === '-' && content[j + 1] === '>') { j += 2; continue; }
        if (c === '"') {
          j++;
          while (j < content.length && content[j] !== '"') {
            if (content[j] === '\\') j++;
            j++;
          }
          j++;
          continue;
        }
        if (c === '<' || c === '(' || c === '[') bracketDepth++;
        else if (c === '>' || c === ')' || c === ']') bracketDepth--;
        else if (bracketDepth === 0) {
          if (c === '{') { bodyStart = j; break; }
          if (c === ';') { isStub = true; break; }
        }
        j++;
      }
      if (!isStub && bodyStart === -1) continue;

      const header = content.slice(m.index, isStub ? j : bodyStart);
      const returnMatch = /->\s*(.+?)(?:\s+where\s+[\s\S]+)?$/.exec(header.slice(header.indexOf(')') + 1));
      const returnType = returnMatch ? returnMatch[1].trim() : undefined;

      const lineStart = lineAt(content, m.index);
      const lineEnd = isStub
        ? lineAt(content, j)
        : this.findClosingBrace(content, bodyStart);

      // Parameter parsen (multi-line tolerant)
      const params = paramsRaw
        .split(',')
        .map(p => p.replace(/\s+/g, ' ').trim().split(':')[0].replace(/^&?\s*mut\s+/, '').replace(/^&/, '').trim())
        .filter(p => p && p !== 'self' && p !== '&self' && p !== '&mut self');

      // Parent finden (impl Block) — immer versuchen, auch bei indent=0 (kann nested sein)
      const parentType = this.findImplType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        value: modifiers.includes('async') ? 'async' : (isStub ? 'stub' : undefined),
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPub(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 8. const / static
    // ══════════════════════════════════════════════
    const constRe = /^(?:pub(?:\([\w:]+\))?\s+)?(const|static)\s+(\w+)\s*:\s*([^=]+)=\s*([^;]+);/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[4].trim().slice(0, 200),
        return_type: m[3].trim(),
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
    }

    // type aliases
    const typeAliasRe = /^(?:pub(?:\([\w:]+\))?\s+)?type\s+(\w+)(?:<[^>]+>)?\s*=\s*([^;]+);/gm;
    while ((m = typeAliasRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isPub(m[0]),
      });
    }

    // ══════════════════════════════════════════════
    // 9. Macros (macro_rules!)
    // ══════════════════════════════════════════════
    const macroRe = /^(?:#\[macro_export\]\s*\n\s*)?macro_rules!\s+(\w+)/gm;
    while ((m = macroRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: `${m[1]}!`,
        value: 'macro',
        line_start: lineAt(content, m.index),
        is_exported: m[0].includes('macro_export'),
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
    // 11. Doc-Comments (/// und //!)
    // ══════════════════════════════════════════════
    const lines = content.split('\n');
    let docBlock: string[] = [];
    let docStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('///') || line.startsWith('//!')) {
        if (docBlock.length === 0) docStart = i + 1;
        docBlock.push(line.replace(/^\/\/[\/!]\s?/, ''));
      } else {
        if (docBlock.length >= 1) {
          symbols.push({
            symbol_type: 'comment',
            name: null,
            value: docBlock.join(' ').trim().slice(0, 500),
            line_start: docStart,
            line_end: docStart + docBlock.length - 1,
            is_exported: false,
          });
        }
        docBlock = [];
      }
    }
    if (docBlock.length >= 1) {
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: docBlock.join(' ').trim().slice(0, 500),
        line_start: docStart,
        line_end: docStart + docBlock.length - 1,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // String-Literale als benannte Symbole (via Helper — Rust: nur ", 'a' ist char)
    // ══════════════════════════════════════════════
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

  /**
   * Findet den impl-Typ (Struct/Trait/Enum-Name) fuer eine Methode an Position fnPos.
   *
   * Strategie: Alle impl-Bloecke vor fnPos finden, pro Block die schliessende `}` per
   * Balanced-Matching bestimmen und pruefen ob fnPos innerhalb liegt. Der INNERSTE
   * (letzte vor fnPos, aber noch offen) ist der Container.
   */
  private findImplType(content: string, fnPos: number): string | undefined {
    const implHeaderRe = /^impl\b/gm;
    let match: RegExpExecArray | null;
    let result: string | undefined;
    while ((match = implHeaderRe.exec(content)) !== null) {
      if (match.index >= fnPos) break;

      // Impl-Header parsen: impl<Generics>? TraitName<...> for TypeName<...> { ... }
      // Name extrahieren (vor dem {) — letzter "richtiger" Name im Header.
      const openBracePos = content.indexOf('{', match.index);
      if (openBracePos === -1) break;
      const header = content.slice(match.index, openBracePos);

      // "impl Foo" | "impl<T> Foo<T>" | "impl<T> TraitA<T> for Bar<T>"
      let typeName: string | undefined;
      const forMatch = /\bfor\s+(\w+)/.exec(header);
      if (forMatch) {
        typeName = forMatch[1];
      } else {
        // Kein "for" — direkte impl auf einen Typ. Nimm den letzten Identifier vor dem {.
        const direct = /impl(?:<[^>]*>)?\s+(\w+)/.exec(header);
        if (direct) typeName = direct[1];
      }
      if (!typeName) continue;

      // Schliessende Klammer finden per Brace-Balancing
      let depth = 1;
      let i = openBracePos + 1;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        else if (ch === '"') {
          i++;
          while (i < content.length && content[i] !== '"') {
            if (content[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }
      const closeBracePos = i - 1;

      // Liegt fnPos innerhalb dieses impl-Blocks?
      if (openBracePos < fnPos && fnPos < closeBracePos) {
        result = typeName; // Innerster gewinnt (wird weiter overridden wenn nested)
      }
    }
    return result;
  }
}

export const rustParser = new RustParser();
