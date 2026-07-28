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
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';
import { formatRouteName } from './patterns/http.js';

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

// Muster als Modul-Konstanten, weil trefferListe ueber die Regex-IDENTITAET
// zwischenspeichert. Je Muster zwei Fassungen: sticky (ohne ^) fuer die Probe
// genau an der Startposition, global (mit ^ und m) fuer die Zeilenanfaenge.
const RPC_S = /\s*rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)/y;
const RPC_G = /^\s*rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)/gm;
const FELD_S = /\s*(optional|required|repeated)?\s*(map<\s*\w+\s*,\s*\w+\s*>|[\w.]+)\s+(\w+)\s*=\s*(\d+)/y;
const FELD_G = /^\s*(optional|required|repeated)?\s*(map<\s*\w+\s*,\s*\w+\s*>|[\w.]+)\s+(\w+)\s*=\s*(\d+)/gm;
const ONEOF_S = /\s*oneof\s+(\w+)\s*\{/y;
const ONEOF_G = /^\s*oneof\s+(\w+)\s*\{/gm;

// Trefferliste eines Musters, einmal je Datei aufgebaut.
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

// Sucht ein an ^ verankertes Muster ab startPos, OHNE den Dateirest zu kopieren.
// Bildet content.substring(startPos) + Regex mit m-Flag EXAKT nach: in der Kopie
// gilt Position 0 als Zeilenanfang, auch wenn startPos mitten in einer Zeile
// liegt. Deshalb wird zuerst genau an startPos geprueft (sticky, ohne ^), erst
// danach an den echten Zeilenanfaengen.
// Diese Sonderprobe ist kein Schoenheitsfehler: das erste Feld einer message traf
// frueher bei Kopie-Position 0 zu und bekam dadurch die Zeilennummer der
// message-Kopfzeile. Wer sie weglaesst, verschiebt still genau diese Nummer.
//
// Der zweite Teil laeuft ueber die vorbereitete Liste statt ueber einen neuen
// Scan. Das ist der eigentliche Hebel: eine Suche, die NICHTS findet, lief sonst
// je Block bis zum Dateiende. Gemessen an protobuf-Material ohne oneof waren das
// Faktor 3.53 je Verdopplung; mit oneof in jeder message 1.08.
// Dabei gilt eine Annahme, die hier zutrifft: ein global gesammelter Treffer darf
// keinen spaeteren Kandidaten verschlucken. startPos liegt immer unmittelbar
// hinter einer oeffnenden Klammer, davor steht also kein reiner Whitespace-Lauf,
// ueber den ein frueherer Treffer hinweggreifen koennte.
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

class ProtobufParser implements LanguageParser {
  language = 'protobuf';
  extensions = ['.proto'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: rpc- und Feldsuche laufen direkt auf content statt auf einer Kopie des
  //    Dateirests und schlagen in einer vorbereiteten Trefferliste nach, statt
  //    je Block neu zu scannen (siehe trefferAb).
  version = 3;

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
      // Ohne content.substring(blockStart): die Kopie des gesamten Dateirests
      // fiel je service an, obwohl die Schleife am Blockende abbricht.
      const blockStart = m.index + m[0].length;
      for (const rm of trefferAb(content, blockStart, RPC_S, RPC_G)) {
        const rpcLine = lineAt(content, rm.index);
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

    symbols.push(...extractStringLiterals(content));

    // ══════════════════════════════════════════════
    // 10. gRPC Routes (service/rpc)
    // ══════════════════════════════════════════════
    void formatRouteName;
    const serviceOuterRe = /\bservice\s+(\w+)\s*\{([\s\S]*?)\}/g;
    let sm: RegExpExecArray | null;
    while ((sm = serviceOuterRe.exec(content)) !== null) {
      const serviceName = sm[1];
      const blockStart = sm.index + sm[0].indexOf('{') + 1;
      const block = sm[2];
      const rpcInnerRe = /\brpc\s+(\w+)\s*\(/g;
      let rm: RegExpExecArray | null;
      while ((rm = rpcInnerRe.exec(block)) !== null) {
        const method = rm[1];
        symbols.push({
          symbol_type: 'route',
          name: `RPC ${method}`,
          value: `/${serviceName}/${method}`,
          params: ['RPC'],
          line_start: lineAt(content, blockStart + rm.index),
          is_exported: true,
        });
      }
    }

    return { symbols, references, statements: [], callEdges: [] };
  }

  private parseFields(
    content: string, blockStart: number, blockLineEnd: number,
    parentName: string, symbols: ParsedSymbol[], references: ParsedReference[]
  ): void {
    // Regular fields: optional/required/repeated type name = number;
    // Ohne const block = content.substring(blockStart): die Kopie des gesamten
    // Dateirests fiel je message an und wurde hier sogar zweimal durchsucht.
    for (const fm of trefferAb(content, blockStart, FELD_S, FELD_G)) {
      const fieldLine = lineAt(content, fm.index);
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
    for (const om of trefferAb(content, blockStart, ONEOF_S, ONEOF_G)) {
      const oneofLine = lineAt(content, om.index);
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
