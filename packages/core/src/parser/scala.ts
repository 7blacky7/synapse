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

/**
 * Macht Kommentare und Zeichenketten unkenntlich, OHNE die Laenge zu aendern:
 * jede Position im Ergebnis entspricht derselben Position im Original, damit
 * lineAt() und die Textausschnitte weiter stimmen.
 *
 * WARUM: die Ablauf-Regexes liefen bisher ueber den rohen Text. Solange nur
 * Top-Level erfasst wurde, fiel das nicht auf — sobald eingerueckter Code
 * dazukommt, treffen sie auch Scaladoc-Beispiele. Ueber den gesamten Bestand
 * gemessen sind das 586 def- und 500 val-Treffer; XMLTesting.scala faellt von
 * 12 auf 0, dort steckt alles in XML-Literalen und Zeichenketten.
 *
 * ZWEI SCALA-EIGENHEITEN, die eine naive Fassung falsch macht:
 *   - Blockkommentare sind SCHACHTELBAR: ein geoeffneter Block darf einen
 *     weiteren enthalten, deshalb wird die Tiefe gezaehlt statt das erste
 *     schliessende Zeichenpaar zu suchen (das endet zu frueh).
 *   - Dreifach gequotete Zeichenketten duerfen einfache Anfuehrungszeichen
 *     enthalten und muessen deshalb vor dem Einzelfall geprueft werden.
 */
function maskiereKommentareUndStrings(text: string): string {
  const zeichen = text.split('');
  const leere = (von: number, bis: number) => {
    for (let k = von; k < bis && k < zeichen.length; k++) {
      if (zeichen[k] !== '\n') zeichen[k] = ' ';
    }
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const c2 = text[i + 1];

    if (c === '/' && c2 === '/') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      leere(i, j);
      i = j;
      continue;
    }

    if (c === '/' && c2 === '*') {
      let tiefe = 1;
      let j = i + 2;
      while (j < text.length && tiefe > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { tiefe++; j += 2; continue; }
        if (text[j] === '*' && text[j + 1] === '/') { tiefe--; j += 2; continue; }
        j++;
      }
      leere(i, j);
      i = j;
      continue;
    }

    if (c === '"' && c2 === '"' && text[i + 2] === '"') {
      const ende = text.indexOf('"""', i + 3);
      const j = ende < 0 ? text.length : ende + 3;
      leere(i, j);
      i = j;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') {
        if (text[j] === '\\') j++;
        j++;
      }
      leere(i, Math.min(j + 1, text.length));
      i = j + 1;
      continue;
    }

    i++;
  }

  return zeichen.join('');
}


class ScalaParser implements LanguageParser {
  language = 'scala';
  extensions = ['.scala', '.sc'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Eltern-Typ ueber vorberechnete Grenzen statt Rueckwaertssuche je Treffer.
  // 4: Eltern-Typ ist jetzt die INNERSTE umschliessende Deklaration. Version 3
  //    bildete die alte match()-Semantik nach und verlor den Eltern-Typ, sobald
  //    vor der Fundstelle eine schliessende Klammer stand (siehe findParentType).
  // 5: Ablauf-Ebene auf JEDER Ebene statt nur am Dateianfang, plus Maskierung
  //    von Kommentaren und Zeichenketten. Bis 4 sprang die Flow-Schleife bei
  //    jeder Einrueckung heraus; in Scala ist damit fast alles uebersprungen
  //    worden (363 Statements und 34 Call-Kanten auf 580.621 Zeilen).
  // 6: depth ist jetzt 0 (Tiefe IM Scope) statt der Einrueckungstiefe der Datei.
  //    getExecutionFlow filtert auf depth = 0 — vorher lieferte flow(scope) fuer
  //    scala nichts, obwohl die Statements im Index standen.
  version = 6;

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

    // Die Ablauf-Regexes laufen ueber die maskierte Fassung, die Textausschnitte
    // kommen aus dem Original — sonst stuenden Leerzeichen im Statement-Text.
    const flowText = maskiereKommentareUndStrings(content);

    // def auf JEDER Ebene. Bis Version 4 stand hier ein
    //   if (indent > 0) continue; // skip indented method bodies
    // und damit fiel praktisch der gesamte Scala-Code heraus.
    // ^([ \t]*) statt ^(\s*): \s schliesst den Zeilenumbruch ein, dadurch begann
    // der Treffer auf der LEERZEILE davor — Zeilennummer und Tiefe waren falsch.
    const defFlowRe = /^([ \t]*)((?:(?:private|protected|final|override|implicit|inline|lazy|transparent|infix)\s+(?:\[\w+\]\s*)?)*)?def\s+(\w+)(?:\[([^\]]*)\])?\s*(?:\(([^)]*)\))*(?:\s*:\s*([^\n={]+))?(?:\s*=\s*([^\n{]*))?/gm;
    while ((m = defFlowRe.exec(flowText)) !== null) {
      const indent = m[1].length;
      const name = m[3];
      const lineStart = lineAt(content, m.index);
      const isTop = indent === 0;
      // Der Eltern-Typ ist seit Version 4 die innerste umschliessende Deklaration.
      const scopeName = isTop ? null : this.findParentType(content, m.index) ?? null;
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: isTop ? 'module' : 'class',
        scope_name: scopeName,
        statement_type: 'function',
        node_kind: 'DefDef',
        line_start: lineStart,
        order_index: nextOrder(scopeName ?? undefined),
        // Scala rueckt konventionell in Zweierschritten ein; die Tiefe ist damit
        // eine Naeherung und keine Zusicherung (Tabs zaehlen als ein Zeichen).
        // 0 = direkt im Scope, so steht es im Interface. scope_name ist ueber
        // findParentType bereits die INNERSTE umschliessende Deklaration, also
        // liegt dieses Statement definitionsgemaess direkt darin.
        // ⚠️ NICHT die Einrueckung der Datei: getExecutionFlow filtert hart auf
        // depth = 0, und mit der Einrueckung passierte in List.scala 0 von 124
        // Statements diesen Filter — flow(scope) lieferte leer, obwohl alles da war.
        depth: 0,
        is_top_level: isTop,
        is_awaited: false,
        callee: name,
        text: content.slice(m.index, m.index + m[0].length).trim().slice(0, 240),
      });

      // Aufrufe aus der rechten Seite (nach dem Gleichheitszeichen)
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

    // val/var auf JEDER Ebene (vorher nur Spalte 0)
    const valFlowRe = /^([ \t]*)(?:(?:private|protected|final|override|implicit|lazy|inline|given)\s+(?:\[\w+\]\s*)?)*(val|var)\s+(\w+)(?:\s*:\s*(\S[^\n=]*))?(?:\s*=\s*([^\n]+))?/gm;
    while ((m = valFlowRe.exec(flowText)) !== null) {
      const indent = m[1].length;
      const kind = m[2];
      const name = m[3];
      const rhs = m[5] || '';
      const lineStart = lineAt(content, m.index);
      const isTop = indent === 0;
      const scopeName = isTop ? null : this.findParentType(content, m.index) ?? null;
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: isTop ? 'module' : 'class',
        scope_name: scopeName,
        statement_type: 'variable',
        node_kind: kind === 'val' ? 'ValDef' : 'VarDef',
        line_start: lineStart,
        order_index: nextOrder(scopeName ?? undefined),
        // 0 = direkt im Scope (siehe Begruendung beim def-Zweig oben).
        depth: 0,
        is_top_level: isTop,
        is_awaited: false,
        assigned_to: name,
        text: content.slice(m.index, m.index + m[0].length).trim().slice(0, 240),
      });

      const callRe3 = /\b([a-z_]\w*)\s*\(/g;
      let cm2: RegExpExecArray | null;
      while ((cm2 = callRe3.exec(rhs)) !== null) {
        const callee = cm2[1];
        if (['if', 'while', 'for', 'match', 'try', 'catch', 'new'].includes(callee)) continue;
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: scopeName,
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

  // Typ-Grenzen EINMAL vorwaerts sammeln statt pro Treffer rueckwaerts zu suchen.
  private grenzenText: string | null = null;
  private typBereiche: Array<{ name: string; start: number; end: number; eltern: number }> = [];

  private bereiteTypGrenzenVor(content: string): void {
    if (content === this.grenzenText) return;
    this.grenzenText = content;
    const nameAnKlammer = new Map<number, string>();
    const deklRe = /(?:class|object|trait|enum)\s+(\w+)[^{]*\{/g;
    let d: RegExpExecArray | null;
    while ((d = deklRe.exec(content)) !== null) {
      nameAnKlammer.set(d.index + d[0].length - 1, d[1]);
    }
    // Ein einziger Durchlauf mit Klammer-Stapel paart jede oeffnende Klammer mit
    // ihrer schliessenden. Das ergibt echte Bereiche und bleibt linear in der
    // Dateigroesse — die Vorberechnung aus Version 3 wird dadurch nicht teurer.
    const bereiche: Array<{ name: string; start: number; end: number; eltern: number }> = [];
    const offen: number[] = [];
    for (let i = 0; i < content.length; i++) {
      const zeichen = content.charCodeAt(i);
      if (zeichen === 123) offen.push(i);
      else if (zeichen === 125) {
        const auf = offen.pop();
        if (auf === undefined) continue;
        const name = nameAnKlammer.get(auf);
        if (name !== undefined) bereiche.push({ name, start: auf, end: i, eltern: -1 });
      }
    }
    bereiche.sort((x, y) => x.start - y.start);
    // Elternkette: Typ-Bereiche sind ineinander geschachtelt und ueberlappen nie,
    // deshalb genuegt ein Stapel ueber die nach start sortierte Liste.
    const stapel: number[] = [];
    for (let i = 0; i < bereiche.length; i++) {
      while (stapel.length > 0 && bereiche[stapel[stapel.length - 1]].end < bereiche[i].start) stapel.pop();
      bereiche[i].eltern = stapel.length > 0 ? stapel[stapel.length - 1] : -1;
      stapel.push(i);
    }
    this.typBereiche = bereiche;
  }

  /**
   * In welcher Typ-Deklaration liegt pos? Geliefert wird die INNERSTE
   * umschliessende: der Scope eines Symbols ist die naechstgelegene Deklaration,
   * die es enthaelt — nur sie ergibt einen richtigen qualifizierten Namen.
   *
   * Bis Version 3 wurde hier die Eigenheit von String.match ohne g nachgebildet
   * ("erste Deklaration hinter der letzten schliessenden Klammer vor pos"). Das
   * war in zwei Faellen falsch: bei direkt verschachtelten Deklarationen lieferte
   * es die AEUSSERE — in Scala trifft das jedes companion object am Anfang einer
   * Klasse — und, weit haeufiger, sobald vor pos ueberhaupt eine schliessende
   * Klammer stand und danach keine neue Deklaration folgte, lieferte es gar nichts.
   *
   * ABWEICHUNG VON cpp.ts, bewusst und nicht zu "vereinheitlichen": cpp liefert den
   * vollen Pfad ("Aussen::Innen"), die uebrigen acht Parser nur den innersten Namen.
   * Grund: java.ts und dart.ts erkennen Konstruktoren daran, dass der Eltern-Typ
   * GLEICH dem Symbolnamen ist. Ein Pfad waere nie gleich dem Namen — saemtliche
   * Konstruktoren fielen aus dem Index. Wer das angleichen will, muss zuerst diesen
   * Vergleich umbauen.
   */
  private findParentType(content: string, pos: number): string | undefined {
    this.bereiteTypGrenzenVor(content);
    const bereiche = this.typBereiche;
    let lo = 0;
    let hi = bereiche.length;
    while (lo < hi) {
      const mitte = (lo + hi) >> 1;
      if (bereiche[mitte].start < pos) lo = mitte + 1;
      else hi = mitte;
    }
    // Letzter Bereich, der vor pos beginnt. Endet er schon vor pos, ist er ein
    // abgeschlossener Nachbar — dann ueber die Elternkette nach aussen weiter.
    let i = lo - 1;
    while (i >= 0 && bereiche[i].end <= pos) i = bereiche[i].eltern;
    return i >= 0 ? bereiche[i].name : undefined;
  }
}

export const scalaParser = new ScalaParser();
