/**
 * MODUL: Solidity Parser
 * ZWECK: Extrahiert Struktur-Informationen aus Solidity-Dateien (.sol)
 *
 * EXTRAHIERT: pragma, import, contract, interface, library, abstract contract,
 *             struct, enum, event, error, modifier, function, constructor,
 *             mapping, using, state variables, comment, todo
 * ANSATZ: Regex-basiert
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals, erstelleZeilenIndex, zeileFuerPosition } from './types.js';

// Zeilenindex je Text zwischenspeichern — siehe zeileFuerPosition in types.ts.
// Vorher wurde pro Treffer ein Praefix der Datei kopiert und zerlegt: das ist
// O(Treffer x Dateigroesse) und laesst grosse Dateien praktisch nie fertig werden.
//
// WARUM EIN CACHE UEBER MEHRERE TEXTE, obwohl es jetzt nur noch einen gibt:
// parseBlock hat frueher bei der Rekursion den AUSGESCHNITTENEN Rumpf als neuen
// Text weitergereicht, waehrend die oberste Ebene je Funktion wieder mit dem vollen
// Dateiinhalt arbeitete. Mit einem Slot wurde der Index des ganzen Textes deshalb je
// Funktion neu gebaut — gemessen an 587 KB: 3601 Indexbauten ueber 238 Mio. Zeichen,
// das 406-fache der Dateigroesse. Bei 40-fach verschachteltem Material war der Parser
// dadurch LANGSAMER als vor der Umstellung auf den Index (923 ms gegen 540 ms),
// derselbe Rueckschlag wie in cpp.ts. Ein Ring mit 2, 4 oder 8 Slots half messbar
// NICHT (unveraendert 3601 Bauten) — je Funktion waren mehr Texte im Spiel als Slots.
// Seit parseBlock mit Grenzen auf content arbeitet, gibt es nur noch EINEN Text und
// der Index wird genau einmal je Datei gebaut. Der Cache bleibt trotzdem textbasiert:
// er kostet dann einen Eintrag, faengt aber sofort ab, wenn hier wieder jemand einen
// Teiltext hineinreicht. Geleert wird er zu Beginn jeder parse-Fassung, damit nichts
// ueber Dateien hinweg liegen bleibt.
//
// Klebrige Regexe (Flag y): sie ersetzen die frueheren ^-verankerten Muster auf
// body.slice(pos). Ohne ausgeschnittenen Rumpf gibt es keinen Textanfang mehr, an dem
// ^ greifen koennte; lastIndex leistet dasselbe ohne Teilstring. Vor jedem exec wird
// lastIndex gesetzt, es gibt also keinen Zustand ueber Aufrufe hinweg.
const reIf = /if\s*\(/y;
const reElse = /\s*else\s*\{/y;
const reFor = /for\s*\(/y;
const reWhile = /while\s*\(/y;
const reReq = /(require|revert)\s*\(/y;
const reEmit = /emit\s+(\w+)\s*\(/y;
const reRet = /return\b/y;
const reCall = /([a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*)\s*\(/y;
let zeilenCache = new Map<string, number[]>();
function zeilenCacheLeeren(): void {
  zeilenCache = new Map();
}
function lineAt(text: string, pos: number): number {
  let index = zeilenCache.get(text);
  if (index === undefined) {
    index = erstelleZeilenIndex(text);
    zeilenCache.set(text, index);
  }
  return zeileFuerPosition(index, pos);
}

// ---------------------------------------------------------------------------
// Execution-Flow Extraktion fuer Solidity
// Erfasst: function/modifier Bodies mit if/for/while/require/revert/emit/calls
// ---------------------------------------------------------------------------
function extractSolidityFlow(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempId = 0;
  const nextId = (): string => `s${tempId++}`;

  const lines = content.split('\n');

  // Per-parent order counter
  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, scopeCounter: { n: number }): number {
    if (parentId === undefined) return scopeCounter.n++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  function emitStmt(
    lineStart: number,
    lineEnd: number,
    scopeType: string,
    scopeName: string | null,
    stmtType: string,
    depth: number,
    parentId: string | undefined,
    scopeCounter: { n: number },
    extra: Partial<ParsedStatement> = {},
  ): ParsedStatement {
    const isTop = scopeType === 'function' && depth === 0;
    const id = nextId();
    const st: ParsedStatement = {
      temp_id: id,
      parent_temp_id: parentId,
      scope_type: scopeType,
      scope_name: scopeName,
      statement_type: stmtType,
      line_start: lineStart,
      line_end: lineEnd,
      order_index: nextOrder(parentId, scopeCounter),
      depth,
      is_top_level: isTop,
      is_awaited: false,
      ...extra,
    };
    statements.push(st);
    return st;
  }

  // Find matching closing brace position (char index)
  // Findet die zur oeffnenden Klammer bei openIdx passende schliessende Klammer.
  // ende begrenzt die Suche auf den umgebenden Block; ohne Angabe gilt der ganze Text.
  // Frueher ergab sich diese Grenze von selbst, weil auf einem ausgeschnittenen
  // Rumpf gesucht wurde — die Begrenzung ersetzt das Ausschneiden.
  function findClose(src: string, openIdx: number, ende: number = src.length): number {
    let depth = 1;
    for (let i = openIdx + 1; i < ende; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return ende - 1;
  }

  // Naechstes Semikolon, aber nur bis zum Blockende. Ersetzt body.indexOf(';'),
  // das am ausgeschnittenen Rumpf von selbst an der Blockgrenze endete.
  function semikolonBis(von: number, ende: number): number {
    const i = content.indexOf(';', von);
    return i >= 0 && i < ende ? i : -1;
  }

  function charToLine(pos: number): number {
    return lineAt(content, pos);
  }

  // Verarbeitet einen Block zwischen { und }. blockStart und blockEnd sind
  // Positionen in content — es wird NICHTS mehr ausgeschnitten (siehe Modulkopf).
  function parseBlock(
    blockStart: number,    // Position von '{' in content
    blockEnd: number,      // Position von '}' in content
    scopeType: string,
    scopeName: string | null,
    depth: number,
    parentId: string | undefined,
    scopeCounter: { n: number },
  ): void {
    let pos = blockStart + 1;
    while (pos < blockEnd) {
      // Zeichenketten ueberspringen
      if (content[pos] === '"' || content[pos] === "'") {
        const q = content[pos]; pos++;
        while (pos < blockEnd && content[pos] !== q) { if (content[pos] === '\\') pos++; pos++; }
        pos++; continue;
      }
      // Zeilenkommentar
      if (content[pos] === '/' && content[pos + 1] === '/') {
        while (pos < blockEnd && content[pos] !== '\n') pos++;
        continue;
      }
      // Blockkommentar
      if (content[pos] === '/' && content[pos + 1] === '*') {
        pos += 2;
        while (pos < blockEnd - 1 && !(content[pos] === '*' && content[pos + 1] === '/')) pos++;
        pos += 2; continue;
      }

      // if(...) { ... } [else { ... }]
      reIf.lastIndex = pos;
      const ifM = reIf.exec(content);
      if (ifM) {
        const lineStart = charToLine(pos);
        let condEnd = pos + ifM[0].length - 1;
        let pDepth = 1;
        while (condEnd < blockEnd && pDepth > 0) {
          condEnd++;
          if (content[condEnd] === '(') pDepth++;
          else if (content[condEnd] === ')') pDepth--;
        }
        // Start aus der Trefferlaenge, nicht aus einer festen Zahl: die oeffnende
        // Klammer ist das letzte Zeichen des Treffers. Die alte Rechnung pos + 3
        // stimmte nur bei 'if(' und nahm bei 'if (' die Klammer mit in den Text.
        const condText = content.substring(pos + ifM[0].length, condEnd).trim().slice(0, 200);
        let thenStart = condEnd + 1;
        while (thenStart < blockEnd && /\s/.test(content[thenStart])) thenStart++;
        let lineEnd = lineStart;
        if (content[thenStart] === '{') {
          const thenClose = findClose(content, thenStart, blockEnd);
          lineEnd = charToLine(thenClose);
          const st = emitStmt(lineStart, lineEnd, scopeType, scopeName, 'if', depth, parentId, scopeCounter, { condition_text: condText });
          parseBlock(thenStart, thenClose, scopeType, scopeName, depth + 1, st.temp_id, { n: 0 });
          pos = thenClose + 1;
          // else?
          reElse.lastIndex = pos;
          const elseM = reElse.exec(content);
          if (elseM) {
            const elseStart = pos + elseM[0].lastIndexOf('{');
            const elseClose = findClose(content, elseStart, blockEnd);
            parseBlock(elseStart, elseClose, scopeType, scopeName, depth + 1, st.temp_id, { n: orderCounters.get(`p:${st.temp_id}`) ?? 0 });
            pos = elseClose + 1;
          }
        } else {
          // einzeiliger then-Zweig
          const stmtEnd = semikolonBis(thenStart, blockEnd);
          lineEnd = stmtEnd >= 0 ? charToLine(stmtEnd) : lineStart;
          emitStmt(lineStart, lineEnd, scopeType, scopeName, 'if', depth, parentId, scopeCounter, { condition_text: condText });
          if (stmtEnd >= 0) pos = stmtEnd + 1;
          else pos = thenStart + 1;
        }
        continue;
      }

      // for(...) { ... }
      reFor.lastIndex = pos;
      const forM = reFor.exec(content);
      if (forM) {
        const lineStart = charToLine(pos);
        let condEnd = pos + forM[0].length - 1;
        let pDepth = 1;
        while (condEnd < blockEnd && pDepth > 0) {
          condEnd++;
          if (content[condEnd] === '(') pDepth++;
          else if (content[condEnd] === ')') pDepth--;
        }
        const condText = content.substring(pos + forM[0].length, condEnd).trim().slice(0, 200);
        let bodyStart = condEnd + 1;
        while (bodyStart < blockEnd && /\s/.test(content[bodyStart])) bodyStart++;
        if (content[bodyStart] === '{') {
          const bodyClose = findClose(content, bodyStart, blockEnd);
          const lineEnd = charToLine(bodyClose);
          const st = emitStmt(lineStart, lineEnd, scopeType, scopeName, 'for', depth, parentId, scopeCounter, { condition_text: condText });
          parseBlock(bodyStart, bodyClose, scopeType, scopeName, depth + 1, st.temp_id, { n: 0 });
          pos = bodyClose + 1;
        } else {
          emitStmt(lineStart, lineStart, scopeType, scopeName, 'for', depth, parentId, scopeCounter, { condition_text: condText });
          pos = condEnd + 1;
        }
        continue;
      }

      // while(...) { ... }
      reWhile.lastIndex = pos;
      const whileM = reWhile.exec(content);
      if (whileM) {
        const lineStart = charToLine(pos);
        let condEnd = pos + whileM[0].length - 1;
        let pDepth = 1;
        while (condEnd < blockEnd && pDepth > 0) {
          condEnd++;
          if (content[condEnd] === '(') pDepth++;
          else if (content[condEnd] === ')') pDepth--;
        }
        const condText = content.substring(pos + whileM[0].length, condEnd).trim().slice(0, 200);
        let bodyStart = condEnd + 1;
        while (bodyStart < blockEnd && /\s/.test(content[bodyStart])) bodyStart++;
        if (content[bodyStart] === '{') {
          const bodyClose = findClose(content, bodyStart, blockEnd);
          const lineEnd = charToLine(bodyClose);
          const st = emitStmt(lineStart, lineEnd, scopeType, scopeName, 'while', depth, parentId, scopeCounter, { condition_text: condText });
          parseBlock(bodyStart, bodyClose, scopeType, scopeName, depth + 1, st.temp_id, { n: 0 });
          pos = bodyClose + 1;
        } else {
          emitStmt(lineStart, lineStart, scopeType, scopeName, 'while', depth, parentId, scopeCounter, { condition_text: condText });
          pos = condEnd + 1;
        }
        continue;
      }

      // require(...); oder revert(...);
      reReq.lastIndex = pos;
      const reqM = reReq.exec(content);
      if (reqM) {
        const lineStart = charToLine(pos);
        let argEnd = pos + reqM[0].length - 1;
        let pDepth = 1;
        while (argEnd < blockEnd && pDepth > 0) {
          argEnd++;
          if (content[argEnd] === '(') pDepth++;
          else if (content[argEnd] === ')') pDepth--;
        }
        const argText = content.substring(pos + reqM[0].length, argEnd).trim().slice(0, 200);
        const stmtType = reqM[1] === 'require' ? 'call' : 'throw';
        const st = emitStmt(lineStart, lineStart, scopeType, scopeName, stmtType, depth, parentId, scopeCounter, {
          callee: reqM[1],
          condition_text: argText,
        });
        callEdges.push({ statement_temp_id: st.temp_id, caller_scope: scopeName, callee_name: reqM[1], line_number: lineStart, call_kind: 'function' });
        pos = argEnd + 2; // ');' ueberspringen
        continue;
      }

      // emit EventName(...);
      reEmit.lastIndex = pos;
      const emitM = reEmit.exec(content);
      if (emitM) {
        const lineStart = charToLine(pos);
        const st = emitStmt(lineStart, lineStart, scopeType, scopeName, 'call', depth, parentId, scopeCounter, { callee: emitM[1] });
        callEdges.push({ statement_temp_id: st.temp_id, caller_scope: scopeName, callee_name: emitM[1], line_number: lineStart, call_kind: 'function' });
        const semi = semikolonBis(pos, blockEnd);
        pos = semi >= 0 ? semi + 1 : pos + emitM[0].length;
        continue;
      }

      // return ...;
      reRet.lastIndex = pos;
      const retM = reRet.exec(content);
      if (retM) {
        const lineStart = charToLine(pos);
        const semi = semikolonBis(pos, blockEnd);
        emitStmt(lineStart, lineStart, scopeType, scopeName, 'return', depth, parentId, scopeCounter);
        pos = semi >= 0 ? semi + 1 : pos + 6;
        continue;
      }

      // Sonstiges Statement, endet auf ;
      if (content[pos] === ';') { pos++; continue; }
      if (content[pos] === '{') { pos = findClose(content, pos, blockEnd) + 1; continue; }
      if (content[pos] === '}') { pos++; continue; }

      // Allgemeiner Funktionsaufruf: bezeichner(
      reCall.lastIndex = pos;
      const callM = reCall.exec(content);
      if (callM) {
        const lineStart = charToLine(pos);
        const parts = callM[1].split('.');
        const callee = parts[parts.length - 1];
        const receiver = parts.length > 1 ? parts.slice(0, -1).join('.') : undefined;
        // Ende des Statements suchen
        let argEnd = pos + callM[0].length - 1;
        let pDepth = 1;
        while (argEnd < blockEnd && pDepth > 0) {
          argEnd++;
          if (content[argEnd] === '(') pDepth++;
          else if (content[argEnd] === ')') pDepth--;
        }
        const semi = semikolonBis(argEnd, blockEnd);
        // Nur als Aufruf erfassen, wenn ein ; folgt (Statement-Ebene)
        if (semi >= 0 && semi - argEnd < 5) {
          const st = emitStmt(lineStart, lineStart, scopeType, scopeName, 'call', depth, parentId, scopeCounter, { callee, receiver });
          callEdges.push({ statement_temp_id: st.temp_id, caller_scope: scopeName, callee_name: callee, callee_receiver: receiver, line_number: lineStart, call_kind: receiver ? 'method' : 'function' });
          pos = semi + 1;
          continue;
        }
      }

      pos++;
    }
  }

  // Extract function/modifier bodies and process them
  const funcBodyRe = /\b(function|modifier|constructor|receive|fallback)\s*(\w*)?\s*(?:\([^)]*\))?\s*(?:[^{]*?)\{/g;
  let fm: RegExpExecArray | null;
  while ((fm = funcBodyRe.exec(content)) !== null) {
    const kind = fm[1];
    const name = fm[2] || kind;
    const openBrace = content.indexOf('{', fm.index + fm[0].length - 1);
    if (openBrace < 0) continue;
    const closeBrace = findClose(content, openBrace);
    const scopeCounter = { n: 0 };
    parseBlock(openBrace, closeBrace, 'function', name, 0, undefined, scopeCounter);
  }

  return { statements, callEdges };
}

class SolidityParser implements LanguageParser {
  language = 'solidity';
  extensions = ['.sol'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Zeilenindex je Text statt je Slot (siehe lineAt). Die AUSGABE ist unveraendert
  //    (13837 Eintraege ueber 10 Faelle gegen den Stand vor 496f003, 0 Abweichungen);
  //    erhoeht wird trotzdem, weil .sol-Dateien, die vorher in den Parse-Timeout
  //    gelaufen sind, mit 0 Symbolen als "aktuell geparst" im Index stehen und nur
  //    ueber eine hoehere Version wieder nachgezogen werden.
  // 4: parseBlock arbeitet mit Grenzen auf content statt auf ausgeschnittenen Ruempfen.
  //    AENDERT DIE AUSGABE, und zwar absichtlich: die Zeilennummern verschachtelter
  //    Statements und ihrer Call-Kanten waren blockrelativ statt dateirelativ (ein if
  //    aus Quellzeile 6 wurde als 3 gemeldet, ab Ebene 1 war jede Sprungmarke falsch).
  //    Ausserdem verliert condition_text die fuehrende Klammer, die eine feste
  //    Startposition bei 'if (' faelschlich mitgenommen hat. Struktur und Reihenfolge
  //    der Statements bleiben unveraendert.
  version = 4;

  parse(content: string, filePath: string): ParseResult {
    zeilenCacheLeeren();
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;

    // ══════════════════════════════════════════════
    // 1. Pragma
    // ══════════════════════════════════════════════
    const pragmaRe = /^pragma\s+(\w+)\s+([^;]+);/gm;
    while ((m = pragmaRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: `pragma ${m[1]}`,
        value: m[2].trim(),
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 2. Import
    // ══════════════════════════════════════════════
    const importRe = /^import\s+(?:\{([^}]+)\}\s+from\s+)?["']([^"']+)["']\s*;/gm;
    while ((m = importRe.exec(content)) !== null) {
      const names = m[1] ? m[1].split(',').map(n => n.trim()).filter(Boolean) : [];
      const path = m[2];
      const shortName = path.split('/').pop()?.replace('.sol', '') || path;

      if (names.length > 0) {
        for (const name of names) {
          symbols.push({
            symbol_type: 'import',
            name: name.split(' as ').pop()!.trim(),
            value: `${name} from ${path}`,
            line_start: lineAt(content, m.index),
            is_exported: false,
          });
        }
      } else {
        symbols.push({
          symbol_type: 'import',
          name: shortName,
          value: path,
          line_start: lineAt(content, m.index),
          is_exported: false,
        });
      }
    }

    // ══════════════════════════════════════════════
    // 3. Contract / Interface / Library
    // ══════════════════════════════════════════════
    const contractRe = /^(abstract\s+)?(contract|interface|library)\s+(\w+)(?:\s+is\s+([^\n{]+))?\s*\{/gm;
    while ((m = contractRe.exec(content)) !== null) {
      const isAbstract = !!m[1];
      const kind = m[2];
      const name = m[3];
      const inherits = m[4];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const symbolType = kind === 'interface' ? 'interface' : 'class';
      const parents: string[] = [];
      if (inherits) {
        parents.push(...inherits.split(',').map(s => s.trim().split('(')[0].trim()).filter(Boolean));
      }

      symbols.push({
        symbol_type: symbolType,
        name,
        value: isAbstract ? `abstract ${kind}` : kind,
        params: parents.length > 0 ? parents : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });

      for (const parent of parents) {
        references.push({
          symbol_name: parent,
          line_number: lineStart,
          context: `${kind} ${name} is ${inherits?.trim()}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 4. Struct
    // ══════════════════════════════════════════════
    const structRe = /^\s*struct\s+(\w+)\s*\{/gm;
    while ((m = structRe.exec(content)) !== null) {
      const name = m[1];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      symbols.push({
        symbol_type: 'class',
        name,
        value: 'struct',
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 5. Enum
    // ══════════════════════════════════════════════
    const enumRe = /^\s*enum\s+(\w+)\s*\{/gm;
    while ((m = enumRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'enum',
        name: m[1],
        value: 'enum',
        line_start: lineAt(content, m.index),
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Event
    // ══════════════════════════════════════════════
    const eventRe = /^\s*event\s+(\w+)\s*\(([^)]*)\)\s*;/gm;
    while ((m = eventRe.exec(content)) !== null) {
      const params = m[2].split(',').map(p => {
        const parts = p.trim().split(/\s+/);
        return parts[parts.length - 1];
      }).filter(Boolean);

      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'event',
        params: params.length > 0 ? params : undefined,
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 7. Error (custom errors)
    // ══════════════════════════════════════════════
    const errorRe = /^\s*error\s+(\w+)\s*\(([^)]*)\)\s*;/gm;
    while ((m = errorRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'class',
        name: m[1],
        value: 'error',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 8. Modifier
    // ══════════════════════════════════════════════
    const modRe = /^\s*modifier\s+(\w+)\s*(?:\(([^)]*)\))?\s*\{/gm;
    while ((m = modRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: 'modifier',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 9. Functions
    // ══════════════════════════════════════════════
    const funcRe = /^\s*function\s+(\w+)\s*\(([^)]*)\)\s*((?:(?:public|external|internal|private|view|pure|payable|virtual|override|returns)\s*(?:\([^)]*\))?\s*)*)/gm;
    while ((m = funcRe.exec(content)) !== null) {
      const name = m[1];
      const paramsRaw = m[2];
      const modifiers = m[3];
      const lineStart = lineAt(content, m.index);

      const params = paramsRaw
        .split(',')
        .map(p => p.trim().split(/\s+/).pop() || '')
        .filter(Boolean);

      const returnsMatch = modifiers.match(/returns\s*\(([^)]*)\)/);
      const returnType = returnsMatch ? returnsMatch[1].trim() : undefined;

      const visibility = /\b(public|external|internal|private)\b/.exec(modifiers);

      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: lineStart,
        is_exported: visibility ? !['private', 'internal'].includes(visibility[1]) : true,
      });
    }

    // Constructor
    const ctorRe = /^\s*constructor\s*\(([^)]*)\)/gm;
    while ((m = ctorRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: 'constructor',
        value: 'constructor',
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // Receive / Fallback
    const specialRe = /^\s*(receive|fallback)\s*\(\s*\)/gm;
    while ((m = specialRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'function',
        name: m[1],
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 10. State variables
    // ══════════════════════════════════════════════
    const stateVarRe = /^\s*(mapping\s*\([^)]+\)|[\w\[\]]+)\s+(public\s+|private\s+|internal\s+)?(constant\s+|immutable\s+)?(\w+)(?:\s*=\s*([^;]+))?;/gm;
    while ((m = stateVarRe.exec(content)) !== null) {
      const varType = m[1];
      const visibility = m[2] ? m[2].trim() : '';
      const modifier = m[3] ? m[3].trim() : '';
      const name = m[4];
      const value = m[5] ? m[5].trim().slice(0, 200) : undefined;
      const lineStart = lineAt(content, m.index);

      // Skip common false positives
      if (['return', 'emit', 'require', 'revert', 'delete', 'event', 'error', 'struct', 'enum'].includes(varType)) continue;

      symbols.push({
        symbol_type: 'variable',
        name,
        value: value || `${modifier} ${varType}`.trim(),
        return_type: varType,
        line_start: lineStart,
        is_exported: visibility === 'public',
      });
    }

    // ══════════════════════════════════════════════
    // 11. Using
    // ══════════════════════════════════════════════
    const usingRe = /^\s*using\s+([\w.]+)\s+for\s+(\S+)\s*;/gm;
    while ((m = usingRe.exec(content)) !== null) {
      references.push({
        symbol_name: m[1],
        line_number: lineAt(content, m.index),
        context: `using ${m[1]} for ${m[2]}`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 12. TODO / FIXME / HACK
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
    // 13. NatSpec comments (/** ... */ or /// ...)
    // ══════════════════════════════════════════════
    const natspecRe = /\/\*\*([\s\S]*?)\*\//g;
    while ((m = natspecRe.exec(content)) !== null) {
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

    const { statements, callEdges } = extractSolidityFlow(content);
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
}

export const solidityParser = new SolidityParser();
