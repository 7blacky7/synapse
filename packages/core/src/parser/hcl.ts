/**
 * MODUL: HCL/Terraform Parser
 * ZWECK: Extrahiert Struktur-Informationen aus HCL/Terraform-Dateien (.tf, .hcl)
 *
 * EXTRAHIERT: resource, data, variable, output, module, provider, locals,
 *             terraform block, backend, provisioner, dynamic block,
 *             moved block, import block, attribute assignments,
 *             comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';

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

// Muster, die frueher je Block in einer frischen Kopie des Dateirests gesucht
// wurden. Als Modul-Konstanten, weil trefferListe ueber die Regex-IDENTITAET
// zwischenspeichert — in einer Schleife erzeugte Literale waeren jedes Mal ein
// neues Objekt und der Zwischenspeicher damit wirkungslos.
// Je Muster zwei Fassungen: sticky (ohne ^) fuer die Probe genau an der
// Startposition, global (mit ^ und m) fuer die echten Zeilenanfaenge.
const TYP_S = /\s*type\s*=\s*(.+)/y;
const TYP_G = /^\s*type\s*=\s*(.+)/gm;
const STANDARD_S = /\s*default\s*=\s*(.+)/y;
const STANDARD_G = /^\s*default\s*=\s*(.+)/gm;
const BESCHREIBUNG_S = /\s*description\s*=\s*"([^"]+)"/y;
const BESCHREIBUNG_G = /^\s*description\s*=\s*"([^"]+)"/gm;
const WERT_S = /\s*value\s*=\s*(.+)/y;
const WERT_G = /^\s*value\s*=\s*(.+)/gm;
const QUELLE_S = /\s*source\s*=\s*"([^"]+)"/y;
const QUELLE_G = /^\s*source\s*=\s*"([^"]+)"/gm;
const VON_S = /\s*from\s*=\s*(\S+)/y;
const VON_G = /^\s*from\s*=\s*(\S+)/gm;
const NACH_S = /\s*to\s*=\s*(\S+)/y;
const NACH_G = /^\s*to\s*=\s*(\S+)/gm;
const KENNUNG_S = /\s*id\s*=\s*"([^"]+)"/y;
const KENNUNG_G = /^\s*id\s*=\s*"([^"]+)"/gm;
const LOKAL_S = /\s*(\w+)\s*=\s*(.+)/y;
const LOKAL_G = /^\s*(\w+)\s*=\s*(.+)/gm;

// Trefferliste eines Musters, einmal je Datei aufgebaut. Ersetzt die Suche im
// kopierten Dateirest: pro Block bleibt nur noch eine Binaersuche.
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

/**
 * Ersetzt content.substring(pos).match(/^.../m) — ohne Kopie und ohne neuen Scan.
 * Zwei Teile, die zusammen die alte Semantik ergeben:
 *  1. Probe genau an pos: in der Kopie galt Position 0 als Zeilenanfang, auch
 *     wenn pos mitten in einer Zeile liegt (hier immer direkt hinter '{').
 *     Ohne diese Probe faende 'variable "x" { type = string }' auf EINER Zeile
 *     nichts mehr.
 *  2. sonst der erste vorbereitete Treffer mit Index >= pos, per Binaersuche.
 * Zu (2) gilt eine Annahme, die fuer die hier verwendeten Muster geprueft ist:
 * ein global gesammelter Treffer darf keinen spaeteren Kandidaten verschlucken.
 * Alle Muster beginnen mit \s* und enden am Zeilenende; ein Treffer kann davor
 * hoechstens Leerzeilen mitnehmen und traegt dann dasselbe Capture wie der
 * verschluckte Kandidat. Genutzt werden ausschliesslich die Captures.
 */
function ersterTrefferAb(text: string, pos: number, stickyRe: RegExp, globalRe: RegExp): RegExpExecArray | null {
  stickyRe.lastIndex = pos;
  const direkt = stickyRe.exec(text);
  if (direkt) return direkt;
  const liste = trefferListe(text, globalRe);
  let lo = 0;
  let hi = liste.length;
  while (lo < hi) {
    const mitte = (lo + hi) >> 1;
    if (liste[mitte].index < pos) lo = mitte + 1;
    else hi = mitte;
  }
  return lo < liste.length ? liste[lo] : null;
}

// Wie ersterTrefferAb, liefert aber ALLE Treffer ab pos der Reihe nach — fuer
// Schleifen, die ohnehin am Blockende abbrechen. Auch hier ueber die
// vorbereitete Liste: sonst laeuft die Suche nach dem letzten Eintrag eines
// Blocks bis zum Dateiende weiter.
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

class HclParser implements LanguageParser {
  language = 'hcl';
  extensions = ['.tf', '.hcl'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Alle sieben Block-Auswertungen suchen direkt in content statt in einer
  //    Kopie des Dateirests (siehe ersterTrefferAb, trefferAb, parseAttributes).
  version = 3;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Terraform block
    // ══════════════════════════════════════════════
    const terraformRe = /^terraform\s*\{/gm;
    m = terraformRe.exec(content);
    if (m) {
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);
      symbols.push({
        symbol_type: 'class',
        name: 'terraform',
        value: 'terraform',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Extract required_providers
      const block = content.substring(m.index, content.indexOf('}', m.index + m[0].length) + 1);
      const reqRe = /required_providers\s*\{([^}]*)\}/s;
      const reqMatch = reqRe.exec(block);
      if (reqMatch) {
        const provRe = /(\w+)\s*=\s*\{[^}]*source\s*=\s*"([^"]+)"/g;
        let pm: RegExpExecArray | null;
        while ((pm = provRe.exec(reqMatch[1])) !== null) {
          references.push({
            symbol_name: pm[1],
            line_number: lineStart,
            context: `required_provider ${pm[1]} = ${pm[2]}`.slice(0, 80),
          });
        }
      }
    }

    // ══════════════════════════════════════════════
    // 2. Provider
    // ══════════════════════════════════════════════
    const providerRe = /^provider\s+"(\w+)"\s*\{/gm;
    while ((m = providerRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'provider',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Resource
    // ══════════════════════════════════════════════
    const resourceRe = /^resource\s+"([\w_]+)"\s+"([\w_-]+)"\s*\{/gm;
    while ((m = resourceRe.exec(content)) !== null) {
      const resourceType = m[1];
      const resourceName = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name: `${resourceType}.${resourceName}`,
        value: 'resource',
        params: [resourceType],
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      // Parse attributes inside
      this.parseAttributes(content, m.index + m[0].length, lineEnd,
        `${resourceType}.${resourceName}`, symbols, references);
    }

    // ══════════════════════════════════════════════
    // 4. Data source
    // ══════════════════════════════════════════════
    const dataRe = /^data\s+"([\w_]+)"\s+"([\w_-]+)"\s*\{/gm;
    while ((m = dataRe.exec(content)) !== null) {
      const dataType = m[1];
      const dataName = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name: `data.${dataType}.${dataName}`,
        value: 'data',
        params: [dataType],
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Variable
    // ══════════════════════════════════════════════
    const varRe = /^variable\s+"([\w_-]+)"\s*\{/gm;
    while ((m = varRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      // Extract type and default from block
      // Ohne Kopie des Dateirests: content.substring(...) fiel je Variable an und
      // wurde dreimal vollstaendig durchsucht — O(Variablen x Dateigroesse).
      const blockStart = m.index + m[0].length;
      const typeMatch = ersterTrefferAb(content, blockStart, TYP_S, TYP_G);
      const defaultMatch = ersterTrefferAb(content, blockStart, STANDARD_S, STANDARD_G);
      const descMatch = ersterTrefferAb(content, blockStart, BESCHREIBUNG_S, BESCHREIBUNG_G);

      const varType = typeMatch ? typeMatch[1].trim() : undefined;
      const defaultVal = defaultMatch ? defaultMatch[1].trim().slice(0, 100) : undefined;

      symbols.push({
        symbol_type: 'variable',
        name: `var.${name}`,
        value: defaultVal || varType || 'variable',
        return_type: varType,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (descMatch) {
        symbols.push({
          symbol_type: 'comment',
          name: null,
          value: descMatch[1].slice(0, 500),
          line_start: lineStart,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 6. Output
    // ══════════════════════════════════════════════
    const outputRe = /^output\s+"([\w_-]+)"\s*\{/gm;
    while ((m = outputRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const valueMatch = ersterTrefferAb(content, m.index + m[0].length, WERT_S, WERT_G);
      const value = valueMatch ? valueMatch[1].trim().slice(0, 200) : 'output';

      symbols.push({
        symbol_type: 'export',
        name: `output.${name}`,
        value,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Module
    // ══════════════════════════════════════════════
    const moduleRe = /^module\s+"([\w_-]+)"\s*\{/gm;
    while ((m = moduleRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const sourceMatch = ersterTrefferAb(content, m.index + m[0].length, QUELLE_S, QUELLE_G);
      const source = sourceMatch ? sourceMatch[1] : undefined;

      symbols.push({
        symbol_type: 'import',
        name: `module.${name}`,
        value: source || 'module',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      if (source) {
        references.push({
          symbol_name: source.split('/').pop() || source,
          line_number: lineStart,
          context: `module "${name}" { source = "${source}" }`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 8. Locals
    // ══════════════════════════════════════════════
    const localsRe = /^locals\s*\{/gm;
    while ((m = localsRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      // Extract local values
      // Ohne Kopie: die Schleife bricht ohnehin am Blockende ab, die Kopie des
      // gesamten Dateirests fiel trotzdem je locals-Block an.
      for (const lm of trefferAb(content, m.index + m[0].length, LOKAL_S, LOKAL_G)) {
        const localLine = lineAt(content, lm.index);
        if (localLine > lineEnd) break;

        symbols.push({
          symbol_type: 'variable',
          name: `local.${lm[1]}`,
          value: lm[2].trim().slice(0, 200),
          line_start: localLine,
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 9. Moved blocks (Terraform 1.1+)
    // ══════════════════════════════════════════════
    const movedRe = /^moved\s*\{/gm;
    while ((m = movedRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      const movedStart = m.index + m[0].length;
      const fromMatch = ersterTrefferAb(content, movedStart, VON_S, VON_G);
      const toMatch = ersterTrefferAb(content, movedStart, NACH_S, NACH_G);

      if (fromMatch && toMatch) {
        symbols.push({
          symbol_type: 'variable',
          name: 'moved',
          value: `${fromMatch[1]} → ${toMatch[1]}`,
          line_start: lineStart,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 10. Import blocks (Terraform 1.5+)
    // ══════════════════════════════════════════════
    const importRe = /^import\s*\{/gm;
    while ((m = importRe.exec(content)) !== null) {
      const lineStart = lineAt(content, m.index);
      const importStart = m.index + m[0].length;
      const toMatch = ersterTrefferAb(content, importStart, NACH_S, NACH_G);
      const idMatch = ersterTrefferAb(content, importStart, KENNUNG_S, KENNUNG_G);

      if (toMatch) {
        symbols.push({
          symbol_type: 'import',
          name: toMatch[1],
          value: idMatch ? `import ${idMatch[1]}` : 'import',
          line_start: lineStart,
          is_exported: true,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 11. TODO / FIXME / HACK
    // ══════════════════════════════════════════════
    const todoRe = /(?:#|\/\/)\s*(TODO|FIXME|HACK):?\s*(.*)/gi;
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
    // 12. Block-Kommentare (/* ... */)
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

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references, statements: [], callEdges: [] };
  }

  private parseAttributes(
    content: string, blockStart: number, blockLineEnd: number,
    parentName: string, symbols: ParsedSymbol[], references: ParsedReference[]
  ): void {
    let currentLine = lineAt(content, blockStart);
    let depth = 0;

    // Zeilen ab blockStart durchlaufen, OHNE den Dateirest zu kopieren und zu
    // zerlegen. Das war die teuerste der sieben Stellen: je resource eine volle
    // Kopie PLUS ein Array aller restlichen Zeilen, obwohl die Schleife am
    // Blockende abbricht. Die Zerlegung ist zeichengleich nachgebildet: erste
    // Zeile ist der REST der Zeile ab blockStart, danach ganze Zeilen.
    let zeilenStart = blockStart;
    for (;;) {
      if (currentLine > blockLineEnd) break;
      let zeilenEnde = content.indexOf('\n', zeilenStart);
      const letzteZeile = zeilenEnde === -1;
      if (letzteZeile) zeilenEnde = content.length;
      const line = content.slice(zeilenStart, zeilenEnde);
      const trimmed = line.trim();

      for (const ch of line) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
      }

      // Only parse top-level attributes (depth 0)
      if (depth === 0 && trimmed) {
        const attrMatch = trimmed.match(/^(\w+)\s*=\s*(.+)/);
        if (attrMatch && !['lifecycle', 'provisioner', 'connection', 'dynamic'].includes(attrMatch[1])) {
          // Extract references to other resources
          const refRe = /([\w_]+)\.([\w_]+)\.([\w_]+)/g;
          let rm: RegExpExecArray | null;
          while ((rm = refRe.exec(attrMatch[2])) !== null) {
            references.push({
              symbol_name: `${rm[1]}.${rm[2]}.${rm[3]}`,
              line_number: currentLine,
              context: `${attrMatch[1]} = ${attrMatch[2]}`.slice(0, 80),
            });
          }

          // Var references
          const varRefRe = /var\.([\w_]+)/g;
          while ((rm = varRefRe.exec(attrMatch[2])) !== null) {
            references.push({
              symbol_name: `var.${rm[1]}`,
              line_number: currentLine,
              context: `${attrMatch[1]} = ${attrMatch[2]}`.slice(0, 80),
            });
          }
        }
      }
      currentLine++;
      if (letzteZeile) break;
      zeilenStart = zeilenEnde + 1;
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

export const hclParser = new HclParser();
