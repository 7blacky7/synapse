/**
 * MODUL: YAML Parser
 * ZWECK: Extrahiert Struktur-Informationen aus YAML-Dateien
 *
 * EXTRAHIERT: top-level keys (als variable), nested sections,
 *             anchors (&), aliases (*), comments, todo
 * ANSATZ: Regex-basiert — YAML hat einrueckungsbasierte Struktur
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser } from './types.js';
import { extractStringLiterals, zeilenKommentarSymbol } from './types.js';

/**
 * Position des Kommentar-# in einer YAML-Zeile, -1 wenn keiner.
 * Ein # ist nur dann ein Kommentar, wenn er am Zeilenanfang oder nach
 * Leerraum steht UND nicht in einem gequoteten String liegt. Daher sind
 * url: http://a#b und farbe: "#ff0000" KEINE Kommentare.
 * Ein Quote eroeffnet nur am Token-Anfang einen String (it's bleibt Text).
 */
export function yamlKommentarPosition(line: string): number {
  let inEinfach = false;
  let inDoppelt = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inDoppelt) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inDoppelt = false;
      continue;
    }
    if (inEinfach) {
      if (c === "'") {
        if (line[i + 1] === "'") { i++; continue; }
        inEinfach = false;
      }
      continue;
    }
    if (c === '#') {
      if (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t') return i;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s:,[{?-]/.test(line[i - 1]))) {
      if (c === '"') inDoppelt = true;
      else inEinfach = true;
    }
  }
  return -1;
}

class YamlParser implements LanguageParser {
  language = 'yaml';
  extensions = ['.yaml', '.yml'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: JEDER #-Kommentar ist ein eigenes comment-Symbol — ganzzeilig UND
  //    nachgestellt (key: wert  # Hinweis). Vorher nur Bloecke ab 2 Zeilen,
  //    mit Leerzeichen verbunden; Einzelzeilen fehlten ganz. # in Quotes oder
  //    ohne Leerraum davor (url: http://a#b) ist kein Kommentar und kappt
  //    auch den Variablenwert nicht mehr.
  version = 2;
  /** Reines Datenformat — kennt keine Anweisungen. */
  hatAblaufEbene = false;

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    const lines = content.split('\n');

    let currentParent: string | undefined;
    let parentIndent = -1;
    /** Einrueckung der Zeile, die einen Block-Skalar (| oder >) eroeffnet hat. */
    let blockSkalarEinrueckung: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Skip empty lines and document separators
      if (!trimmed || trimmed === '---' || trimmed === '...') continue;

      // Block-Skalar (key: | / key: > / - |): Folgezeilen mit groesserer
      // Einrueckung sind TEXT. Ein nachgestelltes # darin ist kein Kommentar.
      const einrueckung = line.length - line.trimStart().length;
      const inBlockSkalar = blockSkalarEinrueckung !== null && einrueckung > blockSkalarEinrueckung;
      if (!inBlockSkalar) blockSkalarEinrueckung = null;

      // Ganzzeilige Kommentare — JEDE Zeile ein eigenes Symbol (Vertrag siehe
      // types.ts). Bewusst auch innerhalb eines Block-Skalars: dort stehen in
      // der Praxis eingebettete Shell-Skripte (run: |, command: >), deren
      // #-Zeilen genau die gesuchten Marken tragen.
      if (trimmed.startsWith('#')) {
        // TODO / FIXME / HACK
        const todoMatch = trimmed.match(/^#\s*(TODO|FIXME|HACK):?\s*(.*)/i);
        if (todoMatch) {
          symbols.push({
            symbol_type: 'todo',
            name: null,
            value: trimmed,
            line_start: lineNum,
            is_exported: false,
          });
        } else {
          const sym = zeilenKommentarSymbol(trimmed.replace(/^#+/, ''), lineNum);
          if (sym) symbols.push(sym);
        }
        continue;
      }

      // Nachgestellter Kommentar: key: wert  # Hinweis
      const kPos = inBlockSkalar ? -1 : yamlKommentarPosition(line);
      const ohneKommentar = kPos >= 0 ? line.slice(0, kPos) : line;
      if (kPos >= 0) {
        const text = line.slice(kPos).replace(/^#+/, '');
        if (/^\s*(TODO|FIXME|HACK)\b/i.test(text)) {
          symbols.push({
            symbol_type: 'todo',
            name: null,
            value: line.slice(kPos).trim(),
            line_start: lineNum,
            is_exported: false,
          });
        } else {
          const sym = zeilenKommentarSymbol(text, lineNum);
          if (sym) symbols.push(sym);
        }
      }
      if (!inBlockSkalar && /(?::|^\s*-)\s+[|>][-+0-9]*\s*$/.test(ohneKommentar)) {
        blockSkalarEinrueckung = einrueckung;
      }

      // Key-value pairs
      const kvMatch = line.match(/^(\s*)([\w.-]+)\s*:(.*)/);
      if (kvMatch) {
        const indent = kvMatch[1].length;
        const key = kvMatch[2];
        const rest = kvMatch[3].trim();

        // Track parent hierarchy
        if (indent === 0) {
          currentParent = undefined;
          parentIndent = -1;
        } else if (indent > parentIndent + 2) {
          // Deeper nested — find parent
          for (let j = i - 1; j >= 0; j--) {
            const prevLine = lines[j];
            const prevTrimmed = prevLine.trim();
            if (!prevTrimmed || prevTrimmed.startsWith('#')) continue;
            const prevMatch = prevLine.match(/^(\s*)([\w.-]+)\s*:/);
            if (prevMatch && prevMatch[1].length < indent) {
              currentParent = prevMatch[2];
              parentIndent = prevMatch[1].length;
              break;
            }
          }
        }

        // Determine value
        let value: string | undefined;
        if (rest && !rest.startsWith('#') && rest !== '|' && rest !== '>' && rest !== '|-' && rest !== '>-') {
          // Nur einen ECHTEN Kommentar abschneiden: url: http://a#b behaelt #b.
          const kvOhne = ohneKommentar.match(/^(\s*)([\w.-]+)\s*:(.*)/);
          value = (kvOhne ? kvOhne[3] : rest).trim().slice(0, 200);
        }

        // Check for anchors
        const anchorMatch = rest.match(/&(\w+)/);
        if (anchorMatch) {
          symbols.push({
            symbol_type: 'variable',
            name: `&${anchorMatch[1]}`,
            value: 'anchor',
            line_start: lineNum,
            is_exported: true,
          });
        }

        // Check for aliases
        const aliasMatch = rest.match(/\*(\w+)/);
        if (aliasMatch) {
          references.push({
            symbol_name: `&${aliasMatch[1]}`,
            line_number: lineNum,
            context: `${key}: *${aliasMatch[1]}`,
          });
        }

        // Is this a section header (has children, no value)?
        const isSection = !value && !rest;

        symbols.push({
          symbol_type: isSection && indent === 0 ? 'class' : 'variable',
          name: key,
          value: value || (isSection ? 'section' : undefined),
          line_start: lineNum,
          is_exported: indent === 0,
          parent_id: indent > 0 ? currentParent : undefined,
        });

        if (indent === 0) {
          currentParent = key;
          parentIndent = 0;
        }
      }
    }

    // (Kommentare werden oben in der Hauptschleife je Zeile erfasst — der
    //  fruehere Block-Sammler mit Schwelle >= 2 Zeilen ist entfallen.)

    symbols.push(...extractStringLiterals(content, { includeSingleQuotes: true }));


    return { symbols, references, statements: [], callEdges: [] };
  }
}

export const yamlParser = new YamlParser();
