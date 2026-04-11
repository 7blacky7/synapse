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

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals } from './types.js';

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
    // 10. TODO/FIXME/HACK
    // ══════════════════════════════════════════════
    const todoRe = /^\s*#\s*(TODO|FIXME|HACK):?\s*(.*)$/gmi;
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

    return { symbols, references };
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
