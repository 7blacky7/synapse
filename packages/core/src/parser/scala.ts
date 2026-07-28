/**
 * MODUL: Scala Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Scala-Dateien (.scala, .sc)
 *
 * EXTRAHIERT: package, import, class, case class, abstract class, object,
 *             trait, sealed trait, def, val/var, type alias, enum (Scala 3),
 *             given/using (Scala 3), extension, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';

// Zeilenindex je Datei zwischenspeichern — siehe zeileFuerPosition in types.ts.
// Vorher wurde pro Treffer ein Praefix der Datei kopiert und zerlegt: das ist
// O(Treffer x Dateigroesse) und laesst grosse Dateien praktisch nie fertig werden.
let zeilenCacheText: string | null = null;
let zeilenCacheIndex: number[] = [];
function lineAt(text: string, pos: number): number {
  if (text !== zeilenCacheText) {
    zeilenCacheText = text;
    zeilenCacheIndex = erstelleZeilenIndex(text);
  }
  return zeileFuerPosition(zeilenCacheIndex, pos);
}

class ScalaParser implements LanguageParser {
  language = 'scala';
  extensions = ['.scala', '.sc'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  version = 2;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Package
    // ══════════════════════════════════════════════
    const pkgRe = /^package\s+([\w.]+)/gm;
    while ((m = pkgRe.exec(content)) !== null) {
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
    const importRe = /^import\s+([\w.{}_ ,*]+)/gm;
    while ((m = importRe.exec(content)) !== null) {
      const raw = m[1].trim();
      const name = raw.includes('{')
        ? raw.split('{')[0].replace(/\.$/, '')
        : raw.split('.').pop() || raw;
      symbols.push({
        symbol_type: 'import',
        name: name === '_' || name === '*' ? raw.split('.').slice(-2, -1)[0] || raw : name,
        value: raw,
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
    // 3. Classes, Objects, Traits
    // ══════════════════════════════════════════════
    const typeRe = /^(\s*)((?:(?:private|protected|final|sealed|abstract|implicit|lazy|override|inline|open|transparent|opaque)\s+)*(?:\[\w+\]\s*)?)((?:case\s+)?class|object|(?:sealed\s+)?trait|enum)\s+(\w+)(?:\[([^\]]*)\])?(?:\s*\(([^)]*)\))?(?:\s+extends\s+([^\n{]+))?\s*[{:]/gm;
    while ((m = typeRe.exec(content)) !== null) {
      const modifiers = m[2];
      const kind = m[3].trim();
      const name = m[4];
      const typeParams = m[5] || undefined;
      const ctorParams = m[6] || undefined;
      const extendsClause = m[7];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind.includes('trait') ? 'interface'
        : kind === 'enum' ? 'enum'
        : 'class';

      const parents: string[] = [];
      if (extendsClause) {
        parents.push(...extendsClause
          .replace(/\bwith\b/g, ',')
          .split(',')
          .map(s => s.trim().split('(')[0].split('[')[0].trim())
          .filter(Boolean));
      }

      const params: string[] = [];
      if (typeParams) params.push(`[${typeParams}]`);
      if (ctorParams) {
        params.push(...ctorParams.split(',').map(p => p.trim().split(':')[0].trim()).filter(Boolean));
      }
      if (parents.length > 0) params.push(...parents.map(p => `extends ${p}`));

      symbols.push({
        symbol_type: symbolType,
        name,
        value: kind,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: !/\bprivate\b/.test(modifiers),
      });

      for (const parent of parents) {
        if (parent) {
          references.push({
            symbol_name: parent,
            line_number: lineStart,
            context: `${kind} ${name} extends ${extendsClause?.trim()}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 4. Functions (def)
    // ══════════════════════════════════════════════
    const defRe = /^(\s*)((?:(?:private|protected|final|override|implicit|inline|lazy|transparent|infix)\s+(?:\[\w+\]\s*)?)*)?def\s+(\w+)(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))*(?:\s*:\s*([^\n={]+))?/gm;
    while ((m = defRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2] || '';
      const name = m[3];
      const typeParams = m[4] || undefined;
      const paramsRaw = m[5] || '';
      const returnType = m[6] ? m[6].trim().replace(/\s*[={]$/, '') : undefined;
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(':')[0].replace(/\bimplicit\b/, '').trim())
        .filter(Boolean);
      if (typeParams) params.unshift(`[${typeParams}]`);

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        return_type: returnType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Values and Variables (val/var)
    // ══════════════════════════════════════════════
    const valRe = /^(\s*)((?:(?:private|protected|final|override|implicit|lazy|inline|given)\s+(?:\[\w+\]\s*)?)*)(val|var)\s+(\w+)(?:\s*:\s*(\S[^\n=]*))?(?:\s*=\s*([^\n]+))?/gm;
    while ((m = valRe.exec(content)) !== null) {
      const indent = m[1].length;
      const modifiers = m[2];
      const kind = m[3];
      const name = m[4];
      const valType = m[5] ? m[5].trim() : undefined;
      const value = m[6] ? m[6].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      if (indent > 4 && !modifiers.includes('lazy')) continue;

      const parentType = indent > 0 ? this.findParentType(content, m.index) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || valType || kind,
        return_type: valType,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
        parent_id: parentType,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Type Aliases
    // ══════════════════════════════════════════════
    const typeAliasRe = /^(\s*)((?:(?:private|protected|opaque|transparent)\s+)*)type\s+(\w+)(?:\[([^\]]*)\])?\s*=\s*(.+)/gm;
    while ((m = typeAliasRe.exec(content)) !== null) {
      const modifiers = m[2];
      const name = m[3];
      const value = m[5].trim().slice(0, 200);
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'interface',
        name,
        value: `type = ${value}`,
        line_start: lineStart,
        is_exported: !/\bprivate\b/.test(modifiers),
      });
    }

    // ══════════════════════════════════════════════
    // 7. Given instances (Scala 3)
    // ══════════════════════════════════════════════
    const givenRe = /^(\s*)given\s+(\w+)(?:\[([^\]]*)\])?\s*:\s*(\S[^\n=]*)\s*(?:=|with)/gm;
    while ((m = givenRe.exec(content)) !== null) {
      const name = m[2];
      const givenType = m[4].trim();
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'variable',
        name,
        value: `given ${givenType}`,
        return_type: givenType,
        line_start: lineStart,
        is_exported: true,
      });

      references.push({
        symbol_name: givenType.split('[')[0].trim(),
        line_number: lineStart,
        context: `given ${name}: ${givenType}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 8. Extension methods (Scala 3)
    // ══════════════════════════════════════════════
    const extRe = /^(\s*)extension\s*(?:\[([^\]]*)\])?\s*\((\w+)\s*:\s*(\w[^\n)]*)\)/gm;
    while ((m = extRe.exec(content)) !== null) {
      const paramName = m[3];
      const extType = m[4].trim();
      const lineStart = lineAt(content, m.index);

      symbols.push({
        symbol_type: 'class',
        name: `extension(${extType})`,
        value: 'extension',
        line_start: lineStart,
        is_exported: true,
      });

      references.push({
        symbol_name: extType.split('[')[0].trim(),
        line_number: lineStart,
        context: `extension (${paramName}: ${extType})`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 9. Annotations
    // ══════════════════════════════════════════════
    const annotRe = /^\s*@(\w+)(?:\([^)]*\))?/gm;
    while ((m = annotRe.exec(content)) !== null) {
      const name = m[1];
      if (['deprecated', 'inline', 'specialized', 'transient', 'volatile'].includes(name)) continue;
      references.push({
        symbol_name: name,
        line_number: lineAt(content, m.index),
        context: m[0].trim().slice(0, 80),
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
    // 11. ScalaDoc-Kommentare (/** ... */)
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

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 12. Routes — Akka HTTP DSL: path("x") { get { ... } }, post(...) etc.
    //     Auch path("a" / "b") wird als /a/b erkannt.
    // ══════════════════════════════════════════════
    const akkaPathRe = /\bpath\s*\(\s*((?:"[^"\n]+"\s*(?:\/\s*"[^"\n]+"\s*)*))\)\s*\{([\s\S]*?)\}/g;
    while ((m = akkaPathRe.exec(content)) !== null) {
      const segs = [...m[1].matchAll(/"([^"\n]+)"/g)].map(x => x[1]);
      if (segs.length === 0) continue;
      const path = '/' + segs.join('/');
      if (!isLikelyHttpPath(path)) continue;
      const block = m[2];
      const baseLine = lineAt(content, m.index);
      // Eigener Index fuer den Block: lineAt haelt nur EINEN Text im Cache. Ein
      // Wechsel zwischen content und block wuerde ihn bei jedem Treffer verwerfen.
      const blockZeilenIndex = erstelleZeilenIndex(block);
      const verbRe = /\b(get|post|put|patch|delete|head|options)\s*[{(]/g;
      let v: RegExpExecArray | null;
      let foundVerb = false;
      while ((v = verbRe.exec(block)) !== null) {
        const verb = v[1].toLowerCase();
        if (!HTTP_VERBS.has(verb)) continue;
        foundVerb = true;
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName(verb, path),
          value: path,
          params: [verb.toUpperCase()],
          line_start: baseLine + zeileFuerPosition(blockZeilenIndex, v.index) - 1,
          is_exported: false,
        });
      }
      if (!foundVerb) {
        symbols.push({
          symbol_type: 'route',
          name: formatRouteName('ANY', path),
          value: path,
          params: ['ANY'],
          line_start: baseLine,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 13. Routes — Play routes file Heuristik:
    //     "GET   /path   controllers.HomeController.index"
    //     Auch in .scala denkbar via Comment/String oder als Inline-Routes-DSL.
    // ══════════════════════════════════════════════
    const playRouteRe = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/\S*)\s+([\w.$]+)/gm;
    while ((m = playRouteRe.exec(content)) !== null) {
      const method = m[1];
      const path = m[2];
      const handler = m[3];
      if (!isLikelyHttpPath(path)) continue;
      const line = lineAt(content, m.index);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method],
        line_start: line,
        is_exported: false,
      });
      references.push({
        symbol_name: handler.split('.').slice(-2).join('.'),
        line_number: line,
        context: `${method} ${path} -> ${handler}`.slice(0, 80),
      });
    }


    // ══════════════════════════════════════════════
    // Flow extraction: top-level defs + call edges
    // ══════════════════════════════════════════════
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let tempIdCounter = 0;
    const nextId = () => `s${tempIdCounter++}`;
    const orderCounters = new Map<string, number>();
    const nextOrder = (parentId: string | undefined) => {
      const key = parentId ?? '__root__';
      const cur = orderCounters.get(key) ?? 0;
      orderCounters.set(key, cur + 1);
      return cur;
    };

    // Top-level def statements
    const defFlowRe = /^(\s*)((?:(?:private|protected|final|override|implicit|inline|lazy|transparent|infix)\s+(?:\[\w+\]\s*)?)*)?def\s+(\w+)(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))*(?:\s*:\s*([^\n={]+))?(?:\s*=\s*([^\n{]*))?/gm;
    while ((m = defFlowRe.exec(content)) !== null) {
      const indent = m[1].replace(/\n/g, '').length;
      if (indent > 0) continue; // skip indented method bodies
      const name = m[3];
      const lineStart = lineAt(content, m.index);
      const isTop = indent === 0;
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: 'module',
        scope_name: null,
        statement_type: 'function',
        node_kind: 'DefDef',
        line_start: lineStart,
        order_index: nextOrder(undefined),
        depth: 0,
        is_top_level: isTop,
        is_awaited: false,
        callee: name,
        text: m[0].trim().slice(0, 240),
      });

      // Extract calls from the method body (RHS after `=`)
      const rhs = m[7] || '';
      const callRe2 = /\b([a-z_]\w*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe2.exec(rhs)) !== null) {
        const callee = cm[1];
        if (['if', 'while', 'for', 'match', 'try', 'catch', 'new'].includes(callee)) continue;
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: name,
          callee_name: callee,
          line_number: lineStart,
          call_kind: 'function',
          confidence: 0.8,
        });
      }
    }

    // Top-level val/var statements (indent 0)
    const valFlowRe = /^(val|var)\s+(\w+)(?:\s*:\s*(\S[^\n=]*))?(?:\s*=\s*([^\n]+))?/gm;
    while ((m = valFlowRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const rhs = m[4] || '';
      const lineStart = lineAt(content, m.index);
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: 'module',
        scope_name: null,
        statement_type: 'variable',
        node_kind: kind === 'val' ? 'ValDef' : 'VarDef',
        line_start: lineStart,
        order_index: nextOrder(undefined),
        depth: 0,
        is_top_level: true,
        is_awaited: false,
        assigned_to: name,
        text: m[0].trim().slice(0, 240),
      });
      // Extract calls from RHS
      const callRe3 = /\b([a-z_]\w*)\s*\(/g;
      let cm2: RegExpExecArray | null;
      while ((cm2 = callRe3.exec(rhs)) !== null) {
        const callee = cm2[1];
        if (['if', 'while', 'for', 'match', 'try', 'catch', 'new'].includes(callee)) continue;
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: null,
          callee_name: callee,
          line_number: lineStart,
          call_kind: 'function',
          confidence: 0.7,
        });
      }
    }

    return { symbols, references, statements, callEdges };
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
    const classMatch = before.match(/(?:class|object|trait|enum)\s+(\w+)[^{]*\{[^}]*$/);
    return classMatch ? classMatch[1] : undefined;
  }
}

export const scalaParser = new ScalaParser();
