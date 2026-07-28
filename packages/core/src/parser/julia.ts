/**
 * MODUL: Julia Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Julia-Dateien (.jl)
 *
 * EXTRAHIERT: module, using/import, export, function, macro, struct/mutable struct,
 *             abstract type, primitive type, const, global, type alias,
 *             docstrings, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

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

// Sucht ein an ^ verankertes Muster ab startPos, OHNE den Dateirest zu kopieren.
// Bildet content.substring(startPos) + Regex mit m-Flag EXAKT nach: in der Kopie
// gilt Position 0 als Zeilenanfang, auch wenn startPos mitten in einer Zeile
// liegt. Deshalb wird zuerst genau an startPos geprueft (sticky, ohne ^), erst
// danach an den echten Zeilenanfaengen (global, mit ^ und m-Flag).
// Diese Sonderprobe ist kein Schoenheitsfehler: das erste Feld eines struct traf
// frueher bei Kopie-Position 0 zu und bekam dadurch die Zeilennummer der
// struct-Kopfzeile. Wer sie weglaesst, verschiebt still genau diese Nummer.
// stickyRe und globalRe muessen dasselbe Muster tragen, einmal mit y-, einmal
// mit gm-Flag; ihr lastIndex wird hier gesetzt.
// Der zweite Teil laeuft ueber eine vorbereitete Liste statt ueber einen neuen
// Scan: eine Suche, die NICHTS findet, liefe sonst je Block bis zum Dateiende
// — etwa die Feldsuche bei einem struct ohne Felder. Die Annahme dabei: ein
// global gesammelter Treffer verschluckt keinen spaeteren Kandidaten. startPos
// liegt hier immer hinter einem struct-Kopf, davor steht also kein reiner
// Whitespace-Lauf, ueber den ein frueherer Treffer hinweggreifen koennte.
const trefferCache = new Map<RegExp, { text: string; treffer: RegExpExecArray[] }>();
function trefferListe(text: string, globalRe: RegExp): RegExpExecArray[] {
  const alt = trefferCache.get(globalRe);
  if (alt && alt.text === text) return alt.treffer;
  const treffer: RegExpExecArray[] = [];
  globalRe.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = globalRe.exec(text)) !== null) {
    treffer.push(m);
    if (globalRe.lastIndex === m.index) globalRe.lastIndex++;
  }
  trefferCache.set(globalRe, { text, treffer });
  return treffer;
}

function* trefferAb(text: string, startPos: number, stickyRe: RegExp, globalRe: RegExp): Generator<RegExpExecArray> {
  stickyRe.lastIndex = startPos;
  const erster = stickyRe.exec(text);
  let weiterAb = startPos;
  if (erster) {
    yield erster;
    weiterAb = stickyRe.lastIndex > startPos ? stickyRe.lastIndex : startPos + 1;
  }
  const liste = trefferListe(text, globalRe);
  let lo = 0;
  let hi = liste.length;
  while (lo < hi) {
    const mitte = (lo + hi) >> 1;
    if (liste[mitte].index < weiterAb) lo = mitte + 1;
    else hi = mitte;
  }
  for (let i = lo; i < liste.length; i++) yield liste[i];
}

// Zeilennummer eines Treffers, gerechnet ab dem ersten NICHT-Leerzeichen des
// Treffers statt ab seinem Anfang.
// Die Muster hier beginnen mit \s+, und das greift ueber Zeilenumbrueche hinweg:
// der Treffer beginnt dann unmittelbar hinter dem struct-Kopf oder auf einer
// Leerzeile, waehrend das Feld selbst erst auf der naechsten Zeile steht. Das
// erste Feld eines struct trug dadurch die Zeilennummer der Kopfzeile.
// Gemessen gegen die Quelle waren 27 % der struct-Feld-Zeilen um genau eine
// Zeile zu klein.
function trefferZeile(text: string, m: RegExpExecArray, basis = 0): number {
  const versatz = m[0].search(/\S/);
  return lineAt(text, basis + m.index + (versatz > 0 ? versatz : 0));
}

// Muster als Modul-Konstanten, weil trefferListe ueber die Regex-IDENTITAET
// zwischenspeichert.
const ENDE_S = /\s*end\b/y;
const ENDE_G = /^\s*end\b/gm;
const FELD_S = /\s+(\w+)\s*::\s*(\S+)/y;
const FELD_G = /^\s+(\w+)\s*::\s*(\S+)/gm;

// Erster Treffer ab startPos, sonst null — gleiche Semantik wie trefferAb.
function ersterTreffer(text: string, startPos: number, stickyRe: RegExp, globalRe: RegExp): RegExpExecArray | null {
  for (const t of trefferAb(text, startPos, stickyRe, globalRe)) return t;
  return null;
}

// Ergebnis von findEnd fuer JEDE Zeile, einmal je Datei berechnet.
//
// WARUM DAS NOETIG IST — per CPU-Profil belegt, nicht vermutet: nach dem Wegfall
// der Praefix-Kopie entfielen immer noch 88,8 % der Laufzeit auf findEnd. Die
// Kopie war also gar nicht die Hauptursache. Der Grund steckt in der
// Abbruchbedingung: depth beginnt bei 0, ein ausgeglichener Block bringt es
// zurueck auf 0 — und geprueft wird auf depth < 0. In wohlgeformtem Julia faellt
// depth deshalb NIE unter 0, und jeder einzelne Aufruf laeuft bis zum Dateiende.
// Bei einem Aufruf je struct UND je function ist das O(Treffer x Dateigroesse).
//
// Gesucht ist damit fuer jede Startzeile s die erste Zeile, ab der die Bilanz
// unter den Stand VOR s faellt — das 'next smaller element' auf der Praefixsumme,
// das ein Stapel fuer alle Startzeilen gemeinsam in einem Durchlauf loest.
// Der Rueckgabewert ist unveraendert (in der Regel die letzte Zeile der Datei);
// er wird nur nicht mehr je Treffer neu erlaufen.
let endeCacheText: string | null = null;
let endeJeZeile: Int32Array = new Int32Array(0);
function baueEndeIndex(text: string): void {
  if (text === endeCacheText) return;
  endeCacheText = text;
  const oeffnerRe = /^(function|struct|mutable\s+struct|module|baremodule|begin|if|for|while|try|let|do|quote|macro)\b/;
  const deltas: number[] = [];
  let start = 0;
  for (;;) {
    let ende = text.indexOf('\n', start);
    const letzteZeile = ende === -1;
    if (letzteZeile) ende = text.length;
    const trimmed = text.slice(start, ende).trim();
    let d = 0;
    if (oeffnerRe.test(trimmed)) d += 1;
    if (trimmed === 'end' || trimmed.startsWith('end ') || trimmed.startsWith('end#') || trimmed.startsWith('end;')) d -= 1;
    deltas.push(d);
    if (letzteZeile) break;
    start = ende + 1;
  }
  const n = deltas.length;
  const bilanz = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) bilanz[i + 1] = bilanz[i] + deltas[i];
  const ergebnis = new Int32Array(n);
  const stapel: number[] = [];
  for (let j = 0; j <= n; j++) {
    while (stapel.length > 0 && bilanz[stapel[stapel.length - 1]] > bilanz[j]) {
      ergebnis[stapel.pop() as number] = j;
    }
    if (j < n) stapel.push(j);
  }
  // Startzeilen ohne solche Stelle liefen frueher bis ans Dateiende durch.
  for (const s of stapel) ergebnis[s] = n + 1;
  endeJeZeile = ergebnis;
}

class JuliaParser implements LanguageParser {
  language = 'julia';
  extensions = ['.jl'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Feldsuche und findEnd arbeiten direkt auf content statt auf einer Kopie
  //    des Dateirests (siehe trefferAb und findEnd).
  // 4: findEnd schlaegt das Blockende nach, statt es je Treffer bis zum
  //    Dateiende neu zu erlaufen (siehe baueEndeIndex).
  version = 4;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^(baremodule|module)\s+(\w+)/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[2],
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Using / Import
    // ══════════════════════════════════════════════
    const usingRe = /^(using|import)\s+(.+)/gm;
    while ((m = usingRe.exec(content)) !== null) {
      const kind = m[1];
      const modules = m[2].split(',').map(s => s.trim());

      for (const mod of modules) {
        const parts = mod.split(':');
        const pkg = parts[0].trim().split('.')[0];
        const specific = parts.length > 1
          ? parts[1].trim().split(',').map(s => s.trim())
          : undefined;

        if (specific) {
          for (const item of specific) {
            const name = item.trim();
            if (!name) continue;
            symbols.push({
              symbol_type: 'import',
              name,
              value: `${kind} ${parts[0].trim()}: ${name}`,
              line_start: lineAt(content, m.index),
              is_exported: false,
            });
          }
        } else {
          symbols.push({
            symbol_type: 'import',
            name: pkg,
            value: `${kind} ${mod}`,
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }

        references.push({
          symbol_name: pkg,
          line_number: lineAt(content, m.index),
          context: `${kind} ${mod}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Export
    // ══════════════════════════════════════════════
    const exportRe = /^export\s+([\w,\s]+)/gm;
    while ((m = exportRe.exec(content)) !== null) {
      const names = m[1].split(',').map(n => n.trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'export',
        name: 'export',
        value: names.join(', ').slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Structs
    // ══════════════════════════════════════════════
    const structRe = /^(mutable\s+)?struct\s+(\w+)(?:\{([^}]*)\})?(?:\s*<:\s*(\w+))?/gm;
    while ((m = structRe.exec(content)) !== null) {
      const isMutable = !!m[1];
      const name = m[2];
      const typeParams = m[3];
      const superType = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(content, m.index);

      const params: string[] = [];
      if (typeParams) params.push(`{${typeParams}}`);
      if (superType) params.push(`<: ${superType}`);

      symbols.push({
        symbol_type: 'class',
        name,
        value: isMutable ? 'mutable struct' : 'struct',
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (superType) {
        references.push({
          symbol_name: superType,
          line_number: lineStart,
          context: `struct ${name} <: ${superType}`.slice(0, 80),
        });
      }

      // Parse fields (only until 'end')
      // Ohne Kopie: vorher entstanden pro struct ZWEI Kopien (afterStruct und
      // fieldBlock) und der gesamte Dateirest wurde durchsucht — O(structs x
      // Dateigroesse). Die alte Fassung kuerzte nur bei endIdx > 0; ein 'end'
      // unmittelbar an Position 0 liess den Block ungekuerzt. Das wird bewusst
      // genauso nachgebildet.
      const feldStart = m.index + m[0].length;
      const endTreffer = ersterTreffer(content, feldStart, ENDE_S, ENDE_G);
      const endIdx = endTreffer ? endTreffer.index - feldStart : -1;
      const feldGrenze = endIdx > 0 ? feldStart + endIdx : content.length;
      for (const fm of trefferAb(content, feldStart, FELD_S, FELD_G)) {
        if (fm.index >= feldGrenze) break;
        const fieldLine = trefferZeile(content, fm);
        if (fieldLine > lineEnd) break;

        symbols.push({
          symbol_type: 'variable',
          name: fm[1],
          value: fm[2],
          return_type: fm[2],
          line_start: fieldLine,
          is_exported: true,
          parent_id: name,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Abstract types
    // ══════════════════════════════════════════════
    const abstractRe = /^abstract\s+type\s+(\w+)(?:\{([^}]*)\})?(?:\s*<:\s*(\w+))?/gm;
    while ((m = abstractRe.exec(content)) !== null) {
      const superType = m[3];
      symbols.push({
        symbol_type: 'interface',
        name: m[1],
        value: 'abstract type',
        params: superType ? [`<: ${superType}`] : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
      if (superType) {
        references.push({
          symbol_name: superType,
          line_number: lineAt(content, m.index),
          context: `abstract type ${m[1]} <: ${superType}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^function\s+(?:(\w+)\.)?(\w+)(?:\{([^}]*)\})?\s*\(([^)]*)\)(?:\s*::\s*(\S+))?/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const parentType = m[1];
      const name = m[2];
      const typeParams = m[3];
      const paramsRaw = m[4];
      const returnType = m[5];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findEnd(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split('::')[0].split('=')[0].trim())
        .filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name: parentType ? `${parentType}.${name}` : name,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // Short-form functions: name(args) = expr
    const shortFuncRe = /^(\w+)\s*\(([^)]*)\)\s*=\s*(.+)/gm;
    while ((m = shortFuncRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);

      // Skip keywords
      if (['if', 'while', 'for', 'let', 'const', 'global', 'struct', 'module'].includes(name)) continue;
      // Skip if already captured
      if (symbols.some(s => s.name === name && s.symbol_type === 'function')) continue;

      const params = m[2].split(',').map(p => p.trim().split('::')[0].trim()).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        line_start: lineStart,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Macros
    // ══════════════════════════════════════════════
    const macroRe = /^macro\s+(\w+)\s*\(([^)]*)\)/gm;
    while ((m = macroRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => p.trim()).filter(Boolean);
      symbols.push({
        symbol_type: 'function',
        name: `@${m[1]}`,
        value: 'macro',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Constants and globals
    // ══════════════════════════════════════════════
    const constRe = /^(const|global)\s+(\w+)(?:\s*::\s*(\S+))?\s*=\s*(.+)/gm;
    while ((m = constRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[4].trim().slice(0, 200),
        return_type: m[3] || undefined,
        line_start: lineAt(content, m.index),
        is_exported: m[1] === 'const',
      });
    }

    // ══════════════════════════════════════════════
    // 9. Type aliases
    // ══════════════════════════════════════════════
    const typeAliasRe = /^const\s+(\w+)\s*=\s*(Union\{[^}]+\}|Type\{[^}]+\})/gm;
    while ((m = typeAliasRe.exec(content)) !== null) {
      // Already captured by const regex, but mark as interface
      const existing = symbols.find(s => s.name === m![1] && s.symbol_type === 'variable');
      if (existing) existing.symbol_type = 'interface';
    }

    // ══════════════════════════════════════════════
    // 10. TODO / FIXME / HACK
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
    // 11. Docstrings (\""" ... \""")
    // ══════════════════════════════════════════════
    const docRe = /"""([\s\S]*?)"""/g;
    while ((m = docRe.exec(content)) !== null) {
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

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 12. Routes — Genie + HTTP.jl
    // ══════════════════════════════════════════════
    // Genie: route("/x", method=POST) do  (mit explizitem method)
    const genieRouteWithMethodRe = /\broute\s*\(\s*["']([^"']+)["']\s*,\s*method\s*=\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    const genieRoutesWithMethod = new Set<string>();
    while ((m = genieRouteWithMethodRe.exec(content)) !== null) {
      const path = m[1];
      const method = m[2].toLowerCase();
      if (!isLikelyHttpPath(path)) continue;
      if (!HTTP_VERBS.has(method)) continue;
      genieRoutesWithMethod.add(`${m.index}:${path}`);
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method.toUpperCase()],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Genie: route("/x") do  (default GET)
    const genieRouteRe = /\broute\s*\(\s*["']([^"']+)["']\s*\)\s*do\b/g;
    while ((m = genieRouteRe.exec(content)) !== null) {
      const path = m[1];
      if (!isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName('get', path),
        value: path,
        params: ['GET'],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // HTTP.jl: HTTP.register!(router, "GET", "/x", handler)
    const httpRegisterRe = /HTTP\.register!\s*\(\s*\w+\s*,\s*["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']\s*,\s*["']([^"']+)["']/g;
    while ((m = httpRegisterRe.exec(content)) !== null) {
      const method = m[1].toLowerCase();
      const path = m[2];
      if (!isLikelyHttpPath(path)) continue;
      if (!HTTP_VERBS.has(method)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method.toUpperCase()],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 13. Embedded SQL
    // ══════════════════════════════════════════════
    const seenSqlRanges = new Set<string>();
    const pushSql = (sql: string, pos: number) => {
      const key = `${pos}:${sql.length}`;
      if (seenSqlRanges.has(key)) return;
      seenSqlRanges.add(key);
      if (!looksLikeSql(sql)) return;
      const baseLine = lineAt(content, pos);
      symbols.push(...parseEmbeddedSql(sql, filePath, baseLine));
    };

    // LibPQ.execute / DBInterface.execute / DBInterface.prepare
    const sqlSpecificRe = /\b(?:LibPQ\.execute|DBInterface\.(?:execute|prepare))\s*\(\s*\w+\s*,\s*["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = sqlSpecificRe.exec(content)) !== null) {
      pushSql(m[1], m.index);
    }

    // Generisches execute(conn, "...")
    const sqlGenericRe = /\bexecute\s*\(\s*\w+\s*,\s*["']((?:[^"'\\]|\\.){10,})["']/g;
    while ((m = sqlGenericRe.exec(content)) !== null) {
      pushSql(m[1], m.index);
    }

    // Triple-quoted multi-line strings """..."""
    const tripleRe = /"""([\s\S]{10,}?)"""/g;
    while ((m = tripleRe.exec(content)) !== null) {
      pushSql(m[1], m.index);
    }

    // ══════════════════════════════════════════════
    // Flow extraction: top-level functions + call edges
    // ══════════════════════════════════════════════
    const statements: ParsedStatement[] = [];
    const callEdges: ParsedCallEdge[] = [];
    let tempIdCounter = 0;
    const nextId = () => `s${tempIdCounter++}`;
    let orderIndex = 0;

    // Long-form functions: function name(...) ... end
    const funcFlowRe = /^function\s+(?:(\w+)\.)?(\w+)(?:\{[^}]*\})?\s*\(([^)]*)\)(?:\s*::\s*\S+)?\s*\n([\s\S]*?)^end\b/gm;
    const emitted = new Set<string>();
    while ((m = funcFlowRe.exec(content)) !== null) {
      const parentType = m[1];
      const name = m[2];
      const body = m[4] || '';
      const fullName = parentType ? `${parentType}.${name}` : name;
      if (emitted.has(fullName)) continue;
      emitted.add(fullName);
      const lineStart = lineAt(content, m.index);
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: 'module',
        scope_name: null,
        statement_type: 'function',
        node_kind: 'FunctionDef',
        line_start: lineStart,
        order_index: orderIndex++,
        depth: 0,
        is_top_level: true,
        is_awaited: false,
        callee: fullName,
        text: `function ${fullName}(...)`.slice(0, 240),
      });

      // Extract calls from body
      const callRe = /\b([a-z_]\w*)\s*\(/g;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(body)) !== null) {
        const callee = cm[1];
        if (['if', 'for', 'while', 'let', 'try', 'begin', 'do', 'macro', 'function', 'struct', 'module'].includes(callee)) continue;
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: fullName,
          callee_name: callee,
          line_number: lineStart,
          call_kind: 'function',
          confidence: 0.8,
        });
      }
      // Method calls: obj.method(
      const methodRe = /\b(\w+)\.(\w+)\s*\(/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(body)) !== null) {
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: fullName,
          callee_name: mm[2],
          callee_receiver: mm[1],
          line_number: lineStart,
          call_kind: 'method',
          confidence: 0.8,
        });
      }
    }

    // Short-form functions: name(args) = expr
    const shortFuncFlowRe = /^(\w+)\s*\([^)]*\)\s*=\s*(.+)/gm;
    while ((m = shortFuncFlowRe.exec(content)) !== null) {
      const name = m[1];
      const rhs = m[2];
      if (['if', 'while', 'for', 'let', 'const', 'global', 'struct', 'module'].includes(name)) continue;
      if (emitted.has(name)) continue;
      emitted.add(name);
      const lineStart = lineAt(content, m.index);
      const tid = nextId();
      statements.push({
        temp_id: tid,
        scope_type: 'module',
        scope_name: null,
        statement_type: 'function',
        node_kind: 'ShortFuncDef',
        line_start: lineStart,
        order_index: orderIndex++,
        depth: 0,
        is_top_level: true,
        is_awaited: false,
        callee: name,
        text: m[0].trim().slice(0, 240),
      });
      const callRe2 = /\b([a-z_]\w*)\s*\(/g;
      let cm2: RegExpExecArray | null;
      while ((cm2 = callRe2.exec(rhs)) !== null) {
        const callee = cm2[1];
        if (['if', 'for', 'while'].includes(callee)) continue;
        callEdges.push({
          statement_temp_id: tid,
          caller_scope: name,
          callee_name: callee,
          line_number: lineStart,
          call_kind: 'function',
          confidence: 0.7,
        });
      }
    }

    return { symbols, references, statements, callEdges };
  }

  private findEnd(content: string, startPos: number): number {
    let currentLine = lineAt(content, startPos);

    // Regelfall: startPos steht am Zeilenanfang (beide Aufrufer verwenden die
    // Fundstelle einer an ^ verankerten Regex). Dann liefert der vorbereitete
    // Index das Ergebnis direkt — siehe baueEndeIndex, warum das noetig ist.
    if (startPos === 0 || content.charCodeAt(startPos - 1) === 10) {
      baueEndeIndex(content);
      const zeile = currentLine - 1;
      if (zeile >= 0 && zeile < endeJeZeile.length) return endeJeZeile[zeile];
    }

    // Rueckfallweg fuer eine Startposition mitten in einer Zeile: dort ist die
    // erste betrachtete Zeile nur der REST der Zeile, was der zeilenweise Index
    // nicht abbildet. Faktisch wird dieser Weg von keinem Aufrufer erreicht, er
    // steht hier, damit die Funktion fuer sich genommen korrekt bleibt.
    let depth = 0;
    let zeilenStart = startPos;
    for (;;) {
      let zeilenEnde = content.indexOf('\n', zeilenStart);
      const letzteZeile = zeilenEnde === -1;
      if (letzteZeile) zeilenEnde = content.length;
      const trimmed = content.slice(zeilenStart, zeilenEnde).trim();
      // Track block depth
      if (/^(function|struct|mutable\s+struct|module|baremodule|begin|if|for|while|try|let|do|quote|macro)\b/.test(trimmed)) depth++;
      if (trimmed === 'end' || trimmed.startsWith('end ') || trimmed.startsWith('end#') || trimmed.startsWith('end;')) depth--;
      if (depth < 0) return currentLine;
      currentLine++;
      if (letzteZeile) break;
      zeilenStart = zeilenEnde + 1;
    }
    return currentLine;
  }
}

export const juliaParser = new JuliaParser();
