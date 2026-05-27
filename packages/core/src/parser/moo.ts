/**
 * MODUL: moo Parser
 * ZWECK: Extrahiert Struktur-Informationen aus moo-Dateien (.moo)
 *
 * moo ist eine einrueckungsbasierte Sprache (Python-like) mit zweisprachigen Keywords
 * (Deutsch + Englisch + Lern-Modus + 2-Buchstaben-Kurzformen), Unicode-Identifiern
 * und expliziter exportiere/export-Sichtbarkeit.
 *
 * EXTRAHIERT: function, class (inkl. daten-Klassen), interface, import, export,
 *             variable, const, comment, todo, string (via Helper)
 * ANSATZ: Regex-basiert, Indent-Block-Logik wie python.ts
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

// Unicode-faehige Identifier-Klasse (erlaubt deutsche Umlaute in Namen wie `länge`, `für`, `gib_zurück`)
const ID = '[\\p{L}_][\\p{L}\\p{N}_]*';

// Keyword-Gruppen als Regex-Alternation (laengste Varianten zuerst, damit z.B. setze_variable vor setze greift).
// Reihenfolge: Lern-Modus (am laengsten) → DE-Standard → EN-Standard → Experten-Kurzformen.
const KW_FUNC = [
  'funktion_definiere',
  'funktion', 'func', 'fn',
  'fu',
].join('|');
const KW_CLASS = [
  'neue_klasse',
  'klasse', 'class',
  'kl',
].join('|');
const KW_DATA = 'daten|data';
const KW_INTERFACE = 'schnittstelle|interface';
const KW_SET = [
  'setze_variable',
  'setze', 'set', 'konstante', 'const',
  'se', 'ko',
].join('|');
const KW_IMPORT = [
  'importiere_modul',
  'importiere', 'import',
  'im',
].join('|');
const KW_FROM = 'aus|from|von';
const KW_IMPORT_INNER = 'importiere|import|im';
const KW_EXPORT = 'exportiere|export';
const KW_AS = 'als|as';
const KW_NEW = 'neu|new';
const KW_RETURN = 'gib_wert_zurück|gib_zurück|return|gr';
const KW_GUARD = 'garantiere|guard|gr';
const KW_DEFER = 'aufräumen|defer';
const KW_UNSAFE = 'unsicher|unsafe|un';
const KW_TEST = 'teste|test';
const KW_INHERITS = 'implementiert|implements';

function lineAt(text: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function isPublic(name: string): boolean {
  return !name.startsWith('_');
}

class MooParser implements LanguageParser {
  language = 'moo';
  extensions = ['.moo'];

  parse(content: string, _filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');
    let m: RegExpExecArray | null;

    // Exports-Set sammeln (wird am Ende aufgeloest)
    const exportedNames = new Set<string>();

    // ══════════════════════════════════════════════
    // 1. Imports
    //    a) aus/from/von <mod> importiere/import <names>
    //    b) importiere/import <mod> [als/as <alias>]
    // ══════════════════════════════════════════════
    const fromImportRe = new RegExp(
      `^(?:${KW_FROM})\\s+(${ID}(?:\\.${ID})*)\\s+(?:${KW_IMPORT_INNER})\\s+(.+)$`,
      'gmu'
    );
    while ((m = fromImportRe.exec(content)) !== null) {
      const line = lineAt(content, m.index);
      const mod = m[1];
      const names = m[2]
        .split(',')
        .map(s => s.trim().split(new RegExp(`\\s+(?:${KW_AS})\\s+`, 'u'))[0].trim())
        .filter(Boolean);
      symbols.push({
        symbol_type: 'import',
        name: mod,
        value: m[0].trim(),
        params: names,
        line_start: line,
        is_exported: false,
      });
      references.push({
        symbol_name: mod,
        line_number: line,
        context: m[0].trim().slice(0, 80),
      });
    }

    const plainImportRe = new RegExp(
      `^(?:${KW_IMPORT})\\s+(${ID}(?:\\.${ID})*)(?:\\s+(?:${KW_AS})\\s+(${ID}))?`,
      'gmu'
    );
    while ((m = plainImportRe.exec(content)) !== null) {
      const line = lineAt(content, m.index);
      const mod = m[1];
      symbols.push({
        symbol_type: 'import',
        name: mod,
        value: m[0].trim(),
        line_start: line,
        is_exported: false,
      });
      references.push({
        symbol_name: mod,
        line_number: line,
        context: m[0].trim().slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 2. Exports: exportiere/export <name>
    // ══════════════════════════════════════════════
    const exportRe = new RegExp(`^(?:${KW_EXPORT})\\s+(${ID})`, 'gmu');
    while ((m = exportRe.exec(content)) !== null) {
      const line = lineAt(content, m.index);
      exportedNames.add(m[1]);
      symbols.push({
        symbol_type: 'export',
        name: m[1],
        line_start: line,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Klassen (klasse/class Name(Base):  oder  daten klasse Name(...))
    // ══════════════════════════════════════════════
    const dataClassRe = new RegExp(
      `^([ \\t]*)(?:${KW_DATA})\\s+(?:${KW_CLASS})\\s+(${ID})\\s*(?:\\(([^)]*)\\))?`,
      'gmu'
    );
    while ((m = dataClassRe.exec(content)) !== null) {
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const idx = lineStart - 1;
      const lineEnd = this.findBlockEnd(lines, idx);
      const fieldsRaw = (m[3] ?? '').trim();
      const fields = fieldsRaw
        ? fieldsRaw.split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)
        : [];
      symbols.push({
        symbol_type: 'class',
        name,
        value: 'dataclass',
        params: fields,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPublic(name),
      });
    }

    const classRe = new RegExp(
      `^([ \\t]*)(?:${KW_CLASS})\\s+(${ID})\\s*(?:\\(([^)]*)\\))?\\s*(?:(?:${KW_INHERITS})\\s+(${ID}(?:\\s*,\\s*${ID})*))?\\s*:`,
      'gmu'
    );
    while ((m = classRe.exec(content)) !== null) {
      // Nicht doppelt erfassen wenn schon als data-class gematcht (unique line)
      const lineStart = lineAt(content, m.index);
      if (/^\s*(?:daten|data)\s/.test(lines[lineStart - 1] ?? '')) continue;
      const name = m[2];
      const baseList = m[3] ?? '';
      const implementsList = m[4] ?? '';
      const idx = lineStart - 1;
      const lineEnd = this.findBlockEnd(lines, idx);

      const bases: string[] = [];
      if (baseList.trim()) {
        for (const b of baseList.split(',').map(s => s.trim()).filter(Boolean)) {
          bases.push(b);
          references.push({
            symbol_name: b,
            line_number: lineStart,
            context: m[0].trim().slice(0, 80),
          });
        }
      }
      if (implementsList.trim()) {
        for (const i of implementsList.split(',').map(s => s.trim()).filter(Boolean)) {
          bases.push(i);
          references.push({
            symbol_name: i,
            line_number: lineStart,
            context: m[0].trim().slice(0, 80),
          });
        }
      }

      symbols.push({
        symbol_type: 'class',
        name,
        value: bases.length ? `(${bases.join(', ')})` : undefined,
        params: bases,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPublic(name),
      });
    }

    // ══════════════════════════════════════════════
    // 4. Interfaces (schnittstelle/interface Name:)
    // ══════════════════════════════════════════════
    const interfaceRe = new RegExp(
      `^([ \\t]*)(?:${KW_INTERFACE})\\s+(${ID})\\s*:`,
      'gmu'
    );
    while ((m = interfaceRe.exec(content)) !== null) {
      const name = m[2];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findBlockEnd(lines, lineStart - 1);
      symbols.push({
        symbol_type: 'interface',
        name,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isPublic(name),
      });
    }

    // ══════════════════════════════════════════════
    // 5. Funktionen (funktion/func/fn/fu Name(params):)
    // ══════════════════════════════════════════════
    const funcRe = new RegExp(
      `^([ \\t]*)(?:${KW_FUNC})\\s+(${ID})\\s*\\(([^)]*)\\)`,
      'gmu'
    );
    while ((m = funcRe.exec(content)) !== null) {
      const indent = m[1];
      const name = m[2];
      const paramsRaw = m[3] ?? '';
      const lineStart = lineAt(content, m.index);
      const idx = lineStart - 1;
      const lineEnd = this.findBlockEnd(lines, idx);

      const params = paramsRaw
        .split(',')
        .map(s => s.trim().split(':')[0].split('=')[0].trim())
        .filter(Boolean)
        .filter(p => p !== 'self' && p !== 'selbst');

      const parentClass = indent.length > 0 ? this.findParentClass(lines, idx) : undefined;

      symbols.push({
        symbol_type: 'function',
        name,
        params,
        line_start: lineStart,
        line_end: lineEnd,
        parent_id: parentClass,
        is_exported: isPublic(name),
      });
    }

    // ══════════════════════════════════════════════
    // 6. setze/set/konstante/const Variablen
    // ══════════════════════════════════════════════
    const setVarRe = new RegExp(
      `^([ \\t]*)(?:${KW_SET})\\s+(${ID})\\s*(?:=|(?:${KW_AS})\\s+|\\s+(?:to|auf)\\s+)\\s*(.*)$`,
      'gmu'
    );
    while ((m = setVarRe.exec(content)) !== null) {
      const name = m[2];
      const value = (m[3] ?? '').trim().slice(0, 200);
      const lineStart = lineAt(content, m.index);
      const isConst = /^(konstante|const|ko)\b/u.test((lines[lineStart - 1] ?? '').trim());
      symbols.push({
        symbol_type: 'variable',
        name,
        value: isConst ? `const ${value}` : value,
        line_start: lineStart,
        is_exported: isPublic(name),
      });
    }

    // ══════════════════════════════════════════════
    // 7. Direkte top-level Assignments (ohne Einrueckung, ohne Keyword-Prefix)
    //    z.B.  zahlen = [1, 2, 3]
    // ══════════════════════════════════════════════
    const directAssignRe = new RegExp(`^(${ID})\\s*=\\s*(.+)$`, 'gmu');
    while ((m = directAssignRe.exec(content)) !== null) {
      const name = m[1];
      const value = m[2].trim().slice(0, 200);
      // Filter: keine Keywords als "Variablen"
      if (/^(setze|set|konstante|const|se|ko|importiere|import|im|exportiere|export|aus|from|von|klasse|class|kl|funktion|func|fn|fu|schnittstelle|interface|daten|data|wenn|if|sonst|else|solange|while|für|for|in|und|and|oder|or|nicht|not|wahr|true|falsch|false|nichts|none|neu|new|selbst|this|versuche|try|fange|catch|wirf|throw|stopp|break|weiter|continue|prüfe|match|fall|case|standard|default|aufräumen|defer|garantiere|guard|unsicher|unsafe|teste|test|erwarte|expect|implementiert|implements|zeige|show|gib_zurück|return|setze_variable|zeige_auf_bildschirm|wenn_bedingung|sonst_alternative|solange_wiederhole|fuer_jedes|funktion_definiere|gib_wert_zurück|neue_klasse|importiere_modul|versuche_ausfuehrung|fange_fehler)$/.test(name)) continue;
      symbols.push({
        symbol_type: 'variable',
        name,
        value,
        line_start: lineAt(content, m.index),
        is_exported: isPublic(name),
      });
    }

    // ══════════════════════════════════════════════
    // 8. neu/new Instanziierungen → References
    // ══════════════════════════════════════════════
    const newRe = new RegExp(`(?:${KW_NEW})\\s+(${ID})\\s*\\(`, 'gmu');
    while ((m = newRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: m[0].slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 8b. Funktions-/Methoden-Aufrufe → References
    //    Matcht IDENTIFIER( aber filtert:
    //    - Definitions (funktion/func/fn/fu Name — davor)
    //    - Klassen-Definitionen (klasse/class Name(Base) — `klasse` davor)
    //    - moo-Keywords (wenn/if/solange/while/für/for/gib_zurück/return etc.)
    //    - String-artige Literale
    // ══════════════════════════════════════════════
    const MOO_KEYWORDS = new Set([
      // Kontrollfluss
      'wenn', 'if', 'sonst', 'else', 'solange', 'while', 'für', 'for', 'in',
      'prüfe', 'match', 'fall', 'case', 'standard', 'default',
      // Deklarationen (werden separat behandelt)
      'funktion', 'func', 'fn', 'fu', 'klasse', 'class', 'kl',
      'daten', 'data', 'schnittstelle', 'interface',
      'neue_klasse', 'funktion_definiere', 'setze_variable',
      // Variablen
      'setze', 'set', 'konstante', 'const', 'se', 'ko',
      // Module
      'importiere', 'import', 'im', 'aus', 'from', 'von',
      'exportiere', 'export', 'als', 'as', 'importiere_modul',
      // Control-Flow
      'versuche', 'try', 'fange', 'catch', 'wirf', 'throw',
      'stopp', 'break', 'weiter', 'continue',
      'gib_zurück', 'return', 'gr', 'gib_wert_zurück',
      // Literale
      'wahr', 'true', 'falsch', 'false', 'nichts', 'none',
      // Instanziierung
      'neu', 'new', 'selbst', 'this',
      // Operatoren
      'und', 'and', 'oder', 'or', 'nicht', 'not',
      // Features
      'aufräumen', 'defer', 'garantiere', 'guard',
      'unsicher', 'unsafe', 'un', 'implementiert', 'implements',
      'zeige', 'show', 'ze', 'teste', 'test', 'erwarte', 'expect',
      // Lern-Modus
      'zeige_auf_bildschirm', 'wenn_bedingung', 'sonst_alternative',
      'solange_wiederhole', 'fuer_jedes', 'versuche_ausfuehrung',
      'fange_fehler', 'vorbedingung', 'nachbedingung',
      // SQL-artige
      'where', 'wo', 'select', 'wähle', 'order', 'sortiere',
    ]);

    // Skip die erste Spalte einer Funktions-/Klassen-Definitionszeile,
    // damit `funktion foo(` nicht als Call auf `foo` gezaehlt wird.
    const DEFINITION_PREFIX_RE = new RegExp(
      `^[ \\t]*(?:${KW_FUNC}|${KW_CLASS}|${KW_DATA}\\s+${KW_CLASS}|${KW_INTERFACE})\\s+${ID}\\s*\\(`,
      'u'
    );

    const callRe = new RegExp(`(${ID})\\s*\\(`, 'gu');
    const allLines = content.split('\n');
    let lineStartOffset = 0;
    for (let lineIdx = 0; lineIdx < allLines.length; lineIdx++) {
      const line = allLines[lineIdx];
      // Kommentar-Zeilen skippen
      const codeOnly = line.split('#')[0];
      if (codeOnly.trim().length === 0) {
        lineStartOffset += line.length + 1;
        continue;
      }
      // Definition selbst ueberspringen — aber Calls INNERHALB der Signatur (default-Werte)
      // oder spaeter in der Zeile nicht.
      const isDefLine = DEFINITION_PREFIX_RE.test(codeOnly);

      callRe.lastIndex = 0;
      let cm: RegExpExecArray | null;
      while ((cm = callRe.exec(codeOnly)) !== null) {
        const name = cm[1];
        if (MOO_KEYWORDS.has(name)) continue;
        if (name === 'selbst' || name === 'this' || name === 'self') continue;
        // Wenn es die Definition selbst ist (der erste Identifier nach dem Keyword), skippen
        if (isDefLine) {
          const defMatch = DEFINITION_PREFIX_RE.exec(codeOnly);
          if (defMatch && cm.index < defMatch[0].length) continue;
        }
        references.push({
          symbol_name: name,
          line_number: lineIdx + 1,
          context: codeOnly.trim().slice(0, 80),
        });
      }
      lineStartOffset += line.length + 1;
    }

    // ══════════════════════════════════════════════
    // 9. Kommentar-Bloecke (zusammenhaengende #-Zeilen, >= 2)
    // ══════════════════════════════════════════════
    let commentBlock: string[] = [];
    let commentStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('#') && !/^#\s*(TODO|FIXME|HACK)\b/i.test(trimmed)) {
        if (commentBlock.length === 0) commentStart = i + 1;
        commentBlock.push(trimmed.replace(/^#+\s?/, ''));
      } else {
        if (commentBlock.length >= 2) {
          symbols.push({
            symbol_type: 'comment',
            name: null,
            value: commentBlock.join(' ').trim().slice(0, 500),
            line_start: commentStart,
            line_end: commentStart + commentBlock.length - 1,
            is_exported: false,
          });
        }
        commentBlock = [];
      }
    }
    if (commentBlock.length >= 2) {
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: commentBlock.join(' ').trim().slice(0, 500),
        line_start: commentStart,
        line_end: commentStart + commentBlock.length - 1,
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. TODO/FIXME/HACK — case-sensitive mit Wortgrenze,
    //    damit "Todo-Liste" oder "Todos" keine False-Positives ergeben.
    // ══════════════════════════════════════════════
    const todoRe = /^[ \t]*#\s*(TODO|FIXME|HACK)\b:?\s*(.*)$/gm;
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
    // 11. String-Literale (inkl. f-Strings via "..."/"...")
    // ══════════════════════════════════════════════
    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));

    // ══════════════════════════════════════════════
    // 12. is_exported anhand des Export-Sets finalisieren
    //    Wenn mindestens ein exportiere/export-Statement im File → Export-Gating aktiv.
    //    Sonst: Fallback auf isPublic() (kein fuehrender Underscore).
    // ══════════════════════════════════════════════
    if (exportedNames.size > 0) {
      for (const sym of symbols) {
        if (sym.symbol_type === 'export' || sym.symbol_type === 'import') continue;
        if (sym.name) sym.is_exported = exportedNames.has(sym.name);
      }
    }

    // ══════════════════════════════════════════════
    // 13. Routen (manueller Dispatch, Heuristik)
    //     wenn pfad == "/x" und methode == "GET":
    //     wenn methode == "GET" und pfad == "/x":
    // ══════════════════════════════════════════════
    const routePathFirstRe = /\b(?:wenn|if)\s+(?:pfad|path)\s*==\s*['"]([^'"]+)['"]\s+(?:und|and)\s+(?:methode|method)\s*==\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]/g;
    while ((m = routePathFirstRe.exec(content)) !== null) {
      const path = m[1];
      const verb = m[2];
      if (!isLikelyHttpPath(path)) continue;
      if (!HTTP_VERBS.has(verb.toLowerCase())) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, path),
        value: path,
        params: [verb],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }
    const routeMethodFirstRe = /\b(?:wenn|if)\s+(?:methode|method)\s*==\s*['"](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['"]\s+(?:und|and)\s+(?:pfad|path)\s*==\s*['"]([^'"]+)['"]/g;
    while ((m = routeMethodFirstRe.exec(content)) !== null) {
      const verb = m[1];
      const path = m[2];
      if (!isLikelyHttpPath(path)) continue;
      if (!HTTP_VERBS.has(verb.toLowerCase())) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(verb, path),
        value: path,
        params: [verb],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 14. Embedded SQL: db_ausführen / db_abfrage (+_mit_params), <obj>.query(...)
    // ══════════════════════════════════════════════
    const dbCallRe = /\bdb_(?:ausführen|abfrage|execute|query)(?:_mit_params|_with_params)?\s*\(\s*\w+\s*,\s*['"]((?:[^'"\\]|\\.){10,})['"]/g;
    while ((m = dbCallRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (!looksLikeSql(sqlText)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlText, _filePath, baseLine));
    }
    const queryCallRe = /\b\w+\.query\s*\(\s*['"]((?:[^'"\\]|\\.){10,})['"]/g;
    while ((m = queryCallRe.exec(content)) !== null) {
      const sqlText = m[1];
      if (!looksLikeSql(sqlText)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlText, _filePath, baseLine));
    }

    const { statements, callEdges } = extractMooFlow(content);
    return { symbols, references, statements, callEdges };
  }

  /** Findet das Ende eines eingerueckten Blocks (naechste Zeile mit <= Einrueckung) */
  private findBlockEnd(lines: string[], startIdx: number): number {
    const startIndent = lines[startIdx].search(/\S/);
    for (let i = startIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.search(/\S/);
      if (indent <= startIndent) return i;
    }
    return lines.length;
  }

  /** Findet die uebergeordnete Klasse fuer eine Methode */
  private findParentClass(lines: string[], methodIdx: number): string | undefined {
    const methodIndent = lines[methodIdx].search(/\S/);
    for (let i = methodIdx - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const indent = line.search(/\S/);
      if (indent < methodIndent) {
        const classMatch = line.match(/^\s*(?:klasse|class|kl|neue_klasse|daten\s+klasse|data\s+class)\s+([\p{L}_][\p{L}\p{N}_]*)/u);
        if (classMatch) return classMatch[1];
        break;
      }
    }
    return undefined;
  }
}

export const mooParser = new MooParser();

// ---------------------------------------------------------------------------
// Execution-Flow Extraktion fuer die Synapse-moo-Sprache
// Indentation-basiert (wie Python). Funktions-Bodies als Scopes.
// Statements: if/sonst/wenn, for/für/solange/while, try/versuche/fange,
//             Zuweisungen, Calls, return/gib_zurück, throw/wirf
// ---------------------------------------------------------------------------
function extractMooFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = (): string => `s${tempId++}`;
  const orderCounters = new Map<string, number>();

  function nextOrder(parentId: string | undefined, sc: { n: number }): number {
    if (parentId === undefined) return sc.n++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  const allLines = content.split('\n');

  // moo keywords that open a block (DE + EN + Lernmodus)
  const IF_KW = /^(?:wenn|if|wenn_bedingung)\b/u;
  const ELSE_KW = /^(?:sonst|else|sonst_alternative)\b/u;
  const FOR_KW = /^(?:für|fur|for|fuer_jedes)\b/u;
  const WHILE_KW = /^(?:solange|while|solange_wiederhole)\b/u;
  const TRY_KW = /^(?:versuche|try|versuche_ausfuehrung)\b/u;
  const CATCH_KW = /^(?:fange|catch|fange_fehler)\b/u;
  const RETURN_KW = /^(?:gib_zurück|gib_wert_zurück|return|gr)\b/u;
  const THROW_KW = /^(?:wirf|throw)\b/u;
  const FUNC_KW = new RegExp(`^(?:${KW_FUNC})\\s+(${ID})`, 'u');
  const SET_KW = new RegExp(`^(?:${KW_SET})\\s+(${ID})`, 'u');

  // Parse a block of lines (given as indices into allLines)
  // indent = the indent level of the block header (body lines are deeper)
  function parseLines(
    lineIndices: number[],
    scopeType: string,
    scopeName: string | null,
    depth: number,
    parentId: string | undefined,
    sc: { n: number },
  ): void {
    let i = 0;
    while (i < lineIndices.length) {
      const li = lineIndices[i];
      const raw = allLines[li];
      const lineNum = li + 1;
      const codeOnly = raw.split('#')[0].trimEnd();
      const trimmed = codeOnly.trim();
      if (!trimmed) { i++; continue; }

      const indent = codeOnly.search(/\S/);

      // Collect child lines (more indented than current)
      function collectChildren(startI: number): number[] {
        const childIndent = indent + 1; // at least 1 more
        const result: number[] = [];
        let j = startI;
        while (j < lineIndices.length) {
          const cRaw = allLines[lineIndices[j]];
          const cCode = cRaw.split('#')[0].trimEnd();
          if (cCode.trim() === '') { result.push(lineIndices[j]); j++; continue; }
          const cIndent = cCode.search(/\S/);
          if (cIndent > indent) { result.push(lineIndices[j]); j++; }
          else break;
        }
        return result;
      }

      // if/wenn
      if (IF_KW.test(trimmed)) {
        const condText = trimmed.replace(IF_KW, '').replace(/:$/, '').trim().slice(0, 200);
        const id = nextId();
        const st: ParsedStatement = {
          temp_id: id, parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'if', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
          condition_text: condText,
        };
        statements.push(st);
        i++;
        // collect then-body
        const thenLines = collectChildren(i);
        i += thenLines.length;
        parseLines(thenLines, scopeType, scopeName, depth + 1, id, { n: 0 });
        // check for else
        if (i < lineIndices.length) {
          const nextTrimmed = allLines[lineIndices[i]].split('#')[0].trim();
          if (ELSE_KW.test(nextTrimmed)) {
            i++;
            const elseLines = collectChildren(i);
            i += elseLines.length;
            const elseOffset = orderCounters.get(`p:${id}`) ?? 0;
            parseLines(elseLines, scopeType, scopeName, depth + 1, id, { n: elseOffset });
          }
        }
        continue;
      }

      // for/für
      if (FOR_KW.test(trimmed)) {
        const condText = trimmed.replace(FOR_KW, '').replace(/:$/, '').trim().slice(0, 200);
        const id = nextId();
        const st: ParsedStatement = {
          temp_id: id, parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'for', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
          condition_text: condText,
        };
        statements.push(st);
        i++;
        const bodyLines = collectChildren(i);
        i += bodyLines.length;
        parseLines(bodyLines, scopeType, scopeName, depth + 1, id, { n: 0 });
        continue;
      }

      // while/solange
      if (WHILE_KW.test(trimmed)) {
        const condText = trimmed.replace(WHILE_KW, '').replace(/:$/, '').trim().slice(0, 200);
        const id = nextId();
        const st: ParsedStatement = {
          temp_id: id, parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'while', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
          condition_text: condText,
        };
        statements.push(st);
        i++;
        const bodyLines = collectChildren(i);
        i += bodyLines.length;
        parseLines(bodyLines, scopeType, scopeName, depth + 1, id, { n: 0 });
        continue;
      }

      // try/versuche
      if (TRY_KW.test(trimmed)) {
        const id = nextId();
        const st: ParsedStatement = {
          temp_id: id, parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'try', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
        };
        statements.push(st);
        i++;
        const tryLines = collectChildren(i);
        i += tryLines.length;
        parseLines(tryLines, scopeType, scopeName, depth + 1, id, { n: 0 });
        if (i < lineIndices.length && CATCH_KW.test(allLines[lineIndices[i]].split('#')[0].trim())) {
          i++;
          const catchLines = collectChildren(i);
          i += catchLines.length;
          const off = orderCounters.get(`p:${id}`) ?? 0;
          parseLines(catchLines, scopeType, scopeName, depth + 1, id, { n: off });
        }
        continue;
      }

      // Skip else/catch at top level (already consumed above)
      if (ELSE_KW.test(trimmed) || CATCH_KW.test(trimmed)) { i++; continue; }

      // Function definition — enter new scope
      const funcM = FUNC_KW.exec(trimmed);
      if (funcM) {
        const funcName = funcM[2];
        i++;
        const bodyLines = collectChildren(i);
        i += bodyLines.length;
        parseLines(bodyLines, 'function', funcName, 0, undefined, { n: 0 });
        continue;
      }

      // return/gib_zurück
      if (RETURN_KW.test(trimmed)) {
        statements.push({
          temp_id: nextId(), parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'return', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
        });
        i++; continue;
      }

      // throw/wirf
      if (THROW_KW.test(trimmed)) {
        statements.push({
          temp_id: nextId(), parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'throw', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
        });
        i++; continue;
      }

      // setze/set variable assignment
      const setM = SET_KW.exec(trimmed);
      if (setM) {
        const assignedTo = setM[2];
        const id = nextId();
        statements.push({
          temp_id: id, parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'assignment', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
          assigned_to: assignedTo,
          text: trimmed.slice(0, 200),
        });
        // check for function call in RHS
        const rhsCallM = /=\s*([a-zA-Z_À-ſ][\wÀ-ſ]*)\s*\(/.exec(trimmed);
        if (rhsCallM) {
          callEdges.push({ statement_temp_id: id, caller_scope: scopeName, callee_name: rhsCallM[1], line_number: lineNum, call_kind: 'function' });
        }
        i++; continue;
      }

      // Direct assignment: ident = value
      const directAssM = /^([\p{L}_][\p{L}\p{N}_]*)\s*=/u.exec(trimmed);
      if (directAssM) {
        const assignedTo = directAssM[1];
        const id = nextId();
        statements.push({
          temp_id: id, parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'assignment', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
          assigned_to: assignedTo,
          text: trimmed.slice(0, 200),
        });
        const rhsCallM = /=\s*([\p{L}_][\p{L}\p{N}_]*)\s*\(/u.exec(trimmed);
        if (rhsCallM && !IF_KW.test(rhsCallM[1]) && !FUNC_KW.test(rhsCallM[1])) {
          callEdges.push({ statement_temp_id: id, caller_scope: scopeName, callee_name: rhsCallM[1], line_number: lineNum, call_kind: 'function' });
        }
        i++; continue;
      }

      // Function call: ident(
      const callLineM = /^([\p{L}_][\p{L}\p{N}_]*)\s*\(/u.exec(trimmed);
      if (callLineM) {
        const callee = callLineM[1];
        const id = nextId();
        statements.push({
          temp_id: id, parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'call', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
          callee,
          text: trimmed.slice(0, 200),
        });
        callEdges.push({ statement_temp_id: id, caller_scope: scopeName, callee_name: callee, line_number: lineNum, call_kind: 'function' });
        i++; continue;
      }

      // Method call: obj.method(
      const methodCallM = /^([\p{L}_][\p{L}\p{N}_]*)\.(\w+)\s*\(/u.exec(trimmed);
      if (methodCallM) {
        const receiver = methodCallM[1];
        const callee = methodCallM[2];
        const id = nextId();
        statements.push({
          temp_id: id, parent_temp_id: parentId,
          scope_type: scopeType, scope_name: scopeName,
          statement_type: 'call', line_start: lineNum,
          order_index: nextOrder(parentId, sc),
          depth, is_top_level: scopeType === 'function' && depth === 0, is_awaited: false,
          callee, receiver,
          text: trimmed.slice(0, 200),
        });
        callEdges.push({ statement_temp_id: id, caller_scope: scopeName, callee_name: callee, callee_receiver: receiver, line_number: lineNum, call_kind: 'method' });
        i++; continue;
      }

      i++;
    }
  }

  // Start parsing: top-level lines as module scope
  const topLevelIndices = allLines.map((_, idx) => idx);
  parseLines(topLevelIndices, 'module', null, 0, undefined, { n: 0 });

  return { statements, callEdges };
}
