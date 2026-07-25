/**
 * MODUL: C++ Parser
 * ZWECK: Extrahiert Struktur-Informationen aus C++-Dateien
 *
 * EXTRAHIERT: class, struct, namespace, template, method, function,
 *             enum class, #include, using, const/constexpr, comment, todo
 * ANSATZ: Regex-basiert — erweitert C Parser um C++-Konstrukte
 */

import type { ParsedSymbol, ParsedReference, ParseResult, LanguageParser, ParsedStatement, ParsedCallEdge } from './types.js';
import { extractStringLiterals } from './types.js';
import { formatRouteName, isLikelyHttpPath, HTTP_VERBS } from './patterns/http.js';
import { parseEmbeddedSql, looksLikeSql } from './patterns/sql.js';

function lineAt(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function endLineAt(text: string, pos: number, matchLength: number): number {
  return text.substring(0, pos + matchLength).split('\n').length;
}

// ---------------------------------------------------------------------------
// Flow extraction (C++)
// ---------------------------------------------------------------------------

function lineAtCpp(text: string, pos: number): number {
  return text.substring(0, pos).split('\n').length;
}

function extractFlowCpp(content: string): { statements: ParsedStatement[]; callEdges: ParsedCallEdge[] } {
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  let tempIdCounter = 0;
  const nextId = (): string => `s${tempIdCounter++}`;
  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, sc: { v: number }): number {
    if (parentId === undefined) return sc.v++;
    const key = `p:${parentId}`;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  }

  function extractCalls(expr: string, stmtId: string, scopeName: string | null, lineNo: number): void {
    const methodRe = /(\w+)\s*(?:->|\.)\s*(\w+)\s*\(/g;
    let mc: RegExpExecArray | null;
    while ((mc = methodRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[2], callee_receiver: mc[1], line_number: lineNo, call_kind: 'method' });
    }
    const funcRe = /(?<![.\->])\b([a-zA-Z_]\w*)\s*\(/g;
    while ((mc = funcRe.exec(expr)) !== null) {
      const name = mc[1];
      if (['if','for','while','switch','do','return','sizeof','typeof','new','delete','throw','catch','static_cast','dynamic_cast','reinterpret_cast','const_cast'].includes(name)) continue;
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: name, line_number: lineNo, call_kind: 'function' });
    }
    // new Foo(
    const newRe = /\bnew\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
    while ((mc = newRe.exec(expr)) !== null) {
      callEdges.push({ statement_temp_id: stmtId, caller_scope: scopeName, callee_name: mc[1], line_number: lineNo, call_kind: 'new' });
    }
  }

  // Findet zur oeffnenden Klammer bei openIdx die passende schliessende Klammer.
  // Zaehlt Verschachtelung und ueberspringt String-/Char-Literale samt Escapes.
  // -1 wenn die Klammer im uebergebenen Text nicht geschlossen wird.
  function matchParenCpp(s: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  // Ist das Segment ein reines Aufruf-Statement? Kopf, balancierte Klammer,
  // danach nur noch ';'. Ersetzt \([^)]*\), das jede ')' im Argument verbot und
  // damit jeden Aufruf mit verschachteltem Aufruf komplett durchfallen liess.
  function istCallStatement(text: string): boolean {
    const kopf = /^(?:\w[\w.*\[\]:>-]*::)?(?:\w[\w.*\[\]:>-]*\s*(?:->|\.)\s*)*[A-Za-z_]\w*\s*(?:<[^<>()]*>)?\s*\(/.exec(text);
    if (!kopf) return false;
    const openIdx = kopf[0].lastIndexOf('(');
    const close = matchParenCpp(text, openIdx);
    if (close < 0) return false;
    // Nach der Klammer darf nur noch das Semikolon stehen, ein nachgestellter
    // Kommentar ist erlaubt. processBody arbeitet auf dem Original inklusive
    // Kommentaren, deshalb ist 'f(x); // warum' ein realer Fall — wkv.cpp:199
    // ging genau daran verloren.
    return /^;(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))?\s*$/.test(text.slice(close + 1).trim());
  }

  // Zerlegt einen Kontrollfluss-Kopf in Bedingung und Rest der Zeile.
  // cond = alles zwischen der ersten '(' nach dem Keyword und der zugehoerigen ')'.
  //        Vorher fraß /kw\s*\((.+)/ gierig bis Zeilenende und schnitt nur eine ')'
  //        am Zeilenende ab — bei 'if (!f(a)) return;' blieb der Rumpf in der Bedingung.
  // rest = was dahinter noch auf der Zeile steht, ohne umschliessende Braces.
  function kopfAufteilenCpp(line: string, keyword: string): { cond?: string; rest: string } {
    const kw = new RegExp(`\\b${keyword}\\s*\\(`).exec(line);
    if (!kw) return { rest: '' };
    const openIdx = kw.index + kw[0].length - 1;
    const close = matchParenCpp(line, openIdx);
    if (close < 0) {
      const roh = line.slice(openIdx + 1).trim();
      return { cond: roh ? roh.slice(0, 200) : undefined, rest: '' };
    }
    const cond = line.slice(openIdx + 1, close).trim();
    let rest = line.slice(close + 1).trim();
    if (rest.startsWith('{')) rest = rest.slice(1).trim();
    if (rest.endsWith('}')) rest = rest.slice(0, -1).trim();
    return { cond: cond ? cond.slice(0, 200) : undefined, rest };
  }

  // Zerlegt eine Zeile in ihre einzelnen Statements. Geschnitten wird nur an
  // Semikolons auf Tiefe 0 und ausserhalb von Literalen — die Semikolons in
  // 'for (i = 0; i < n; i++)' liegen in Tiefe 1 und bleiben unangetastet.
  function splitTopLevelCpp(s: string): string[] {
    const segmente: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < s.length && s[i] !== quote) {
          if (s[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (ch === ';' && depth <= 0) {
        const seg = s.slice(start, i + 1).trim();
        if (seg) segmente.push(seg);
        start = i + 1;
      }
    }
    const rest = s.slice(start).trim();
    if (rest) segmente.push(rest);
    return segmente;
  }

  interface FuncBody { name: string; bodyOffset: number; bodyContent: string; }

  // Kein Funktionsname, sondern ein Kontrollfluss-/Sprachkonstrukt vor der Klammer.
  const KEIN_FUNKTIONSNAME = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'do', 'else', 'return', 'try',
    'sizeof', 'typeof', 'alignof', 'decltype', 'new', 'delete', 'throw',
    'case', 'default', 'static_cast', 'dynamic_cast', 'reinterpret_cast', 'const_cast',
  ]);

  // Findet die zur oeffnenden Klammer bei openIdx passende schliessende Brace.
  function findeBlockEnde(src: string, openBrace: number): number {
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    return i;
  }

  // Erkennt Funktions- und Methodenbodies per Scanner statt per zeilenverankerter
  // Regex. Die alte funcRe verlangte eine EINZEILIGE Signatur am Zeilenanfang mit
  // '{' am Ende und beschrieb die Parameterliste als \([^)]*\). Damit fielen durch:
  // eingerueckte Methoden in class/struct-Bloecken, mehrzeilige Signaturen,
  // Parameterlisten mit eigenen Klammern (Funktionszeiger, Default-Argument mit
  // Aufruf) und Konstruktoren mit Initializer-Liste. Alles, was hier nicht erkannt
  // wird, besucht processBody nie — gemessen lagen so ueber 90 % einer Datei
  // ausserhalb jedes erkannten Bodys.
  function findBodies(src: string): FuncBody[] {
    const stripped = stripComments(src);

    // class/struct-Bloecke, um Methoden ihren Typ zuzuordnen (scope_name).
    const typBloecke: { name: string; start: number; end: number }[] = [];
    const typRe = /\b(?:class|struct)\s+(\w+)(?:\s*:[^{;]{0,300})?\s*\{/g;
    let tm: RegExpExecArray | null;
    while ((tm = typRe.exec(stripped)) !== null) {
      const ob = tm.index + tm[0].length - 1;
      typBloecke.push({ name: tm[1], start: ob + 1, end: findeBlockEnde(stripped, ob) });
    }

    const treffer: { name: string; openBrace: number; end: number }[] = [];
    for (let i = 0; i < stripped.length; i++) {
      if (stripped[i] !== '(') continue;
      const close = matchParenCpp(stripped, i);
      if (close < 0) continue;

      // Name direkt vor der Klammer (Rueckwaerts-Lookback ohne slice).
      let j = i - 1;
      while (j >= 0 && /\s/.test(stripped[j])) j--;
      const nameEnde = j;
      while (j >= 0 && /[\w~]/.test(stripped[j])) j--;
      if (j === nameEnde) continue;
      const name = stripped.slice(j + 1, nameEnde + 1);
      if (!/^[~A-Za-z_]/.test(name) || KEIN_FUNKTIONSNAME.has(name)) continue;

      // Optionaler Qualifier davor: Klasse::name
      let qualifizierer = '';
      let k = j;
      while (k >= 0 && /\s/.test(stripped[k])) k--;
      if (k >= 1 && stripped[k] === ':' && stripped[k - 1] === ':') {
        let q = k - 2;
        while (q >= 0 && /\s/.test(stripped[q])) q--;
        const qEnde = q;
        while (q >= 0 && /\w/.test(stripped[q])) q--;
        if (q !== qEnde) qualifizierer = stripped.slice(q + 1, qEnde + 1) + '::';
      }

      // Nach der Klammer: Qualifier, optionale Initializer-Liste, dann '{'.
      const nach = stripped.slice(close + 1, close + 500);
      const kopfEnde = /^\s*(?:(?:const|noexcept|override|final|volatile|mutable|constexpr|&&?|throw\s*\([^)]*\)|->\s*[\w:<>*&,\s]+)\s*)*(?::[^{;]{0,400})?\{/.exec(nach);
      if (!kopfEnde) continue;

      const openBrace = close + kopfEnde[0].length;
      if (stripped[openBrace] !== '{') continue;
      treffer.push({ name: qualifizierer + name, openBrace, end: findeBlockEnde(stripped, openBrace) });
    }

    // Verschachtelte Treffer verwerfen: ein Lambda innerhalb einer Funktion wuerde
    // dieselben Zeilen ein zweites Mal liefern und alle Statements verdoppeln.
    // Methoden in Klassenbloecken sind davon NICHT betroffen — ein class-Block ist
    // kein erkannter Funktionsbody.
    treffer.sort((a, b) => a.openBrace - b.openBrace);
    const bodies: FuncBody[] = [];
    let letztesEnde = -1;
    for (const t of treffer) {
      if (t.openBrace < letztesEnde) continue;
      let voll = t.name;
      if (!voll.includes('::')) {
        const typ = typBloecke
          .filter(tb => t.openBrace > tb.start && t.openBrace < tb.end)
          .sort((a, b) => (b.end - b.start) - (a.end - a.start))
          .pop();
        if (typ) voll = `${typ.name}::${voll}`;
      }
      bodies.push({ name: voll, bodyOffset: t.openBrace + 1, bodyContent: src.slice(t.openBrace + 1, t.end - 1) });
      letztesEnde = t.end;
    }
    return bodies;
  }

  function processBody(body: string, bodyOffset: number, scopeName: string | null, scopeType: string): void {
    const sc = { v: 0 };
    const lines = body.split('\n');
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || /^\/[/*]/.test(trimmed) || /^\*/.test(trimmed)) { i++; continue; }
      const charOffset = lines.slice(0, i).reduce((a, l) => a + l.length + 1, 0);
      const fileLine = lineAtCpp(content, bodyOffset + charOffset);
      const isTop = false; // inside function body, never top-level

      function emit(type: string, kind: string, extra: Partial<ParsedStatement> = {}): ParsedStatement {
        const id = nextId();
        const st: ParsedStatement = { temp_id: id, parent_temp_id: undefined, scope_type: scopeType, scope_name: scopeName, statement_type: type, node_kind: kind, line_start: fileLine, order_index: sc.v++, depth: 0, is_top_level: isTop, is_awaited: false, text: trimmed.slice(0, 240), ...extra };
        statements.push(st);
        return st;
      }

      // Rumpf hinter einem einzeiligen Kontrollfluss-Kopf: 'if (!ok) return;' oder
      // 'if (x) { f(); }'. Ohne das verlaesst die Schleife die Zeile nach dem Kopf
      // und alles dahinter faellt weg. Die Aufrufe daraus tauchten vorher nur
      // zufaellig auf, solange der fehlerhafte condition_text den Rumpf mitschleppte.
      function verarbeiteRumpf(rumpf: string, elternId: string): void {
        for (const segment of splitTopLevelCpp(rumpf)) {
          if (/^return\b/.test(segment)) {
            const rst = emit('return', 'ReturnStatement', { text: segment.slice(0, 240), parent_temp_id: elternId, depth: 1 });
            const expr = segment.replace(/^return\s*/, '').replace(/;$/, '');
            if (expr) extractCalls(expr, rst.temp_id, scopeName, fileLine);
            continue;
          }
          if (/^throw\b/.test(segment)) {
            const rst = emit('throw', 'ThrowStatement', { text: segment.slice(0, 240), parent_temp_id: elternId, depth: 1 });
            extractCalls(segment.replace(/^throw\s*/, '').replace(/;$/, ''), rst.temp_id, scopeName, fileLine);
            continue;
          }
          const ram = segment.match(/^(\w[\w.*\[\]:>-]*)\s*(?:[+*/%&|^-]?=)\s*(.+);$/);
          if (ram) {
            const rst = emit('assignment', 'AssignmentExpression', { assigned_to: ram[1].slice(0, 120), text: segment.slice(0, 240), parent_temp_id: elternId, depth: 1 });
            extractCalls(ram[2], rst.temp_id, scopeName, fileLine);
            continue;
          }
          if (istCallStatement(segment)) {
            const rcm = segment.match(/(?:(\w[\w.*\[\]:>-]*)(?:->|\.))?(\w+)\s*\(/);
            const rst = emit('call', 'CallExpression', { callee: rcm ? rcm[2] : undefined, receiver: rcm && rcm[1] ? rcm[1] : undefined, text: segment.slice(0, 240), parent_temp_id: elternId, depth: 1 });
            extractCalls(segment, rst.temp_id, scopeName, fileLine);
          }
        }
      }

      if (/^\s*if\s*\(/.test(line)) {
        const { cond, rest } = kopfAufteilenCpp(line, 'if');
        const st = emit('if', 'IfStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
        if (rest) verarbeiteRumpf(rest, st.temp_id);
      } else if (/^\s*for\s*\(/.test(line)) {
        const { cond, rest } = kopfAufteilenCpp(line, 'for');
        const st = emit('for', 'ForStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
        if (rest) verarbeiteRumpf(rest, st.temp_id);
      } else if (/^\s*while\s*\(/.test(line)) {
        const { cond, rest } = kopfAufteilenCpp(line, 'while');
        const st = emit('while', 'WhileStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
        if (rest) verarbeiteRumpf(rest, st.temp_id);
      } else if (/^\s*do\s*\{/.test(line)) {
        emit('do', 'DoStatement');
      } else if (/^\s*switch\s*\(/.test(line)) {
        const { cond, rest } = kopfAufteilenCpp(line, 'switch');
        const st = emit('switch', 'SwitchStatement', { condition_text: cond });
        if (cond) extractCalls(cond, st.temp_id, scopeName, fileLine);
        if (rest) verarbeiteRumpf(rest, st.temp_id);
      } else if (/^\s*try\s*\{/.test(line)) {
        emit('try', 'TryStatement');
      } else if (/^\s*throw\b/.test(line)) {
        const st = emit('throw', 'ThrowStatement');
        extractCalls(trimmed.replace(/^throw\s*/, '').replace(/;$/, ''), st.temp_id, scopeName, fileLine);
      } else if (/^\s*return\b/.test(line)) {
        const expr = trimmed.replace(/^return\s*/, '').replace(/;$/, '');
        const st = emit('return', 'ReturnStatement');
        if (expr) extractCalls(expr, st.temp_id, scopeName, fileLine);
      } else if (/^\s*\w[\w.*\[\]:>-]*\s*(?:[+*/%&|^-]?=)\s*.+;/.test(line) && !/^\s*(?:if|for|while|switch|return|throw|try|catch)/.test(line)) {
        const am = trimmed.match(/^(\w[\w.*\[\]:>-]*)\s*(?:[+*/%&|^-]?=)\s*(.+);/);
        if (am) {
          const st = emit('assignment', 'AssignmentExpression', { assigned_to: am[1].slice(0, 120) });
          extractCalls(am[2], st.temp_id, scopeName, fileLine);
        }
      } else if (/^\s*(?:auto|const|int|long|short|unsigned|signed|float|double|bool|char|std::\w+|string|vector|map|set|unique_ptr|shared_ptr)\s+\w+/.test(line)) {
        const vm = trimmed.match(/\w+\s+\*?(\w+)\s*(?:=|{)\s*(.+?)[;{]?$/);
        if (vm) {
          const st = emit('variable', 'VariableDeclaration', { assigned_to: vm[1].slice(0, 120) });
          if (vm[2]) extractCalls(vm[2], st.temp_id, scopeName, fileLine);
        }
      } else if (/\bnew\s+\w/.test(line) && /;$/.test(trimmed)) {
        const nm = trimmed.match(/\bnew\s+(\w+)/);
        const st = emit('new', 'NewExpression', { callee: nm ? nm[1] : undefined });
        extractCalls(trimmed, st.temp_id, scopeName, fileLine);
      } else if (!/^\s*(?:if|for|while|switch|return|throw|try|catch)\b/.test(line) && istCallStatement(trimmed)) {
        const cm2 = trimmed.match(/(?:(\w[\w.*\[\]:>-]*)(?:->|\.))?(\w+)\s*\(/);
        if (cm2) {
          const st = emit('call', 'CallExpression', { callee: cm2[2], receiver: cm2[1] || undefined });
          extractCalls(trimmed, st.temp_id, scopeName, fileLine);
        }
      }
      i++;
    }
  }

  const bodies = findBodies(content);
  for (const fb of bodies) {
    processBody(fb.bodyContent, fb.bodyOffset, fb.name, 'function');
  }

  // Top-level: global variable declarations with init (outside function bodies)
  const bodyRanges = bodies.map(b => [b.bodyOffset, b.bodyOffset + b.bodyContent.length] as [number, number]);
  const sc = { v: 0 };
  const stripped = stripComments(content);
  const topVarRe = /^(?:(?:static|extern|const|constexpr|volatile)\s+)+\w[\w:<>*&\s]*?\s+(\w+)\s*=\s*([^;]+);/gm;
  let mv: RegExpExecArray | null;
  while ((mv = topVarRe.exec(stripped)) !== null) {
    if (bodyRanges.some(([s, e]) => mv!.index >= s && mv!.index <= e)) continue;
    const fileLine = lineAtCpp(content, mv.index);
    const stId = nextId();
    statements.push({ temp_id: stId, parent_temp_id: undefined, scope_type: 'module', scope_name: null, statement_type: 'variable', node_kind: 'VariableDeclaration', line_start: fileLine, order_index: sc.v++, depth: 0, is_top_level: true, is_awaited: false, assigned_to: mv[1], text: mv[0].trim().slice(0, 240) });
    extractCalls(mv[2], stId, null, fileLine);
  }

  return { statements, callEdges };
}

class CppParser implements LanguageParser {
  language = 'cpp';
  extensions = ['.cpp', '.hpp', '.cc', '.cxx', '.hxx', '.hh'];

  parse(content: string, filePath: string): ParseResult {
    const symbols: ParsedSymbol[] = [];
    const references: ParsedReference[] = [];
    let m: RegExpExecArray | null;
    const isHeader = /\.(?:hpp|hxx|hh|h)$/.test(filePath);

    // ══════════════════════════════════════════════
    // 1. #include
    // ══════════════════════════════════════════════
    const includeRe = /^#include\s+[<"]([^>"]+)[>"]/gm;
    while ((m = includeRe.exec(content)) !== null) {
      const header = m[1];
      const name = header.replace(/\.(?:h|hpp|hxx)$/, '').split('/').pop() || header;
      symbols.push({
        symbol_type: 'import',
        name,
        value: header,
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
    // 2. using-Deklarationen
    // ══════════════════════════════════════════════
    const usingNsRe = /^using\s+namespace\s+([\w:]+)\s*;/gm;
    while ((m = usingNsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'import',
        name: m[1],
        value: `using namespace ${m[1]}`,
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    const usingTypeRe = /^using\s+(\w+)\s*=\s*(.+)\s*;/gm;
    while ((m = usingTypeRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[1],
        value: m[2].trim().slice(0, 200),
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 3. Namespaces
    // ══════════════════════════════════════════════
    const nsRe = /^namespace\s+(\w+)\s*\{/gm;
    while ((m = nsRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: 'namespace',
        value: m[1],
        line_start: lineAt(content, m.index),
        is_exported: true,
      });
    }

    // ══════════════════════════════════════════════
    // 4. Classes & Structs
    // ══════════════════════════════════════════════
    const classRe = /^(?:template\s*<[^>]+>\s*\n\s*)?(class|struct)\s+(?:\[\[[\w:]+\]\]\s+)?(\w+)(?:\s+final)?(?:\s*:\s*(?:public|protected|private)\s+([\w:<>,\s]+))?\s*\{/gm;
    while ((m = classRe.exec(content)) !== null) {
      const kind = m[1];
      const name = m[2];
      const baseClause = m[3];
      const lineStart = lineAt(content, m.index);
      const lineEnd = this.findClosingBrace(content, m.index + m[0].length - 1);

      const bases: string[] = [];
      if (baseClause) {
        bases.push(...baseClause.split(',').map(s =>
          s.trim().replace(/^(public|protected|private)\s+/, '').split('<')[0].trim()
        ).filter(Boolean));
      }

      symbols.push({
        symbol_type: 'class',
        name,
        value: kind,
        params: bases.length > 0 ? bases : undefined,
        line_start: lineStart,
        line_end: lineEnd,
        is_exported: isHeader,
      });

      for (const base of bases) {
        references.push({
          symbol_name: base,
          line_number: lineStart,
          context: `${kind} ${name} : ${baseClause?.trim()}`.slice(0, 80),
        });
      }
    }

    // ══════════════════════════════════════════════
    // 5. Enums (enum class / enum)
    // ══════════════════════════════════════════════
    const enumRe = /^enum\s+(?:class\s+)?(\w+)(?:\s*:\s*\w+)?\s*\{([\s\S]*?)\}\s*;/gm;
    while ((m = enumRe.exec(content)) !== null) {
      const name = m[1];
      const body = m[2];
      const variants = body.split(',')
        .map(v => v.trim().split(/[\s=]/)[0])
        .filter(v => v && !v.startsWith('/') && !v.startsWith('*'));

      symbols.push({
        symbol_type: 'enum',
        name,
        params: variants,
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: isHeader,
      });
    }

    // ══════════════════════════════════════════════
    // 6. Methoden / Funktionen
    // ══════════════════════════════════════════════
    // Class methods (inline in header)
    const methodRe = /^([ \t]+)(?:(?:virtual|static|explicit|inline|constexpr|override|final|noexcept)\s+)*((?:const\s+)?(?:\w[\w:<>*&\s]*?))\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:const|noexcept|override|final|\s))*\s*\{/gm;
    while ((m = methodRe.exec(content)) !== null) {
      const returnType = m[2].trim();
      const funcName = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'else'].includes(funcName)) continue;
      if (['class', 'struct', 'namespace', 'enum'].includes(returnType)) continue;

      const params = this.parseParams(paramsRaw);
      const parentType = this.findParentType(content, m.index);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: isHeader,
        parent_id: parentType,
      });
    }

    // Free functions (top-level)
    const freeFuncRe = /^(?:(?:inline|static|extern|constexpr|template\s*<[^>]+>\s*\n\s*)*)((?:const\s+)?(?:\w[\w:<>*&\s]*?))\s+(\w+)\s*\(([^)]*)\)(?:\s*(?:const|noexcept))*\s*\{/gm;
    while ((m = freeFuncRe.exec(content)) !== null) {
      const returnType = m[1].trim();
      const funcName = m[2];
      const paramsRaw = m[3];
      const lineStart = lineAt(content, m.index);

      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'do', 'class', 'struct', 'namespace', 'enum'].includes(funcName)) continue;
      if (['class', 'struct', 'namespace', 'enum'].includes(returnType)) continue;

      // Skip if already found as method
      if (symbols.some(s => s.symbol_type === 'function' && s.name === funcName && s.line_start === lineStart)) continue;

      const params = this.parseParams(paramsRaw);

      symbols.push({
        symbol_type: 'function',
        name: funcName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: !m[0].includes('static'),
      });
    }

    // Scope-resolved methods: RetType ClassName::method(...)
    const scopeMethodRe = /^((?:const\s+)?(?:\w[\w:<>*&\s]*?))\s+(\w+)::(\w+)\s*\(([^)]*)\)(?:\s*(?:const|noexcept))*\s*\{/gm;
    while ((m = scopeMethodRe.exec(content)) !== null) {
      const returnType = m[1].trim();
      const className = m[2];
      const methodName = m[3];
      const paramsRaw = m[4];
      const lineStart = lineAt(content, m.index);

      const params = this.parseParams(paramsRaw);

      symbols.push({
        symbol_type: 'function',
        name: methodName,
        params,
        return_type: returnType,
        line_start: lineStart,
        line_end: this.findClosingBrace(content, m.index + m[0].length - 1),
        is_exported: true,
        parent_id: className,
      });

      references.push({
        symbol_name: className,
        line_number: lineStart,
        context: `${className}::${methodName}(...)`.slice(0, 80),
      });
    }

    // ══════════════════════════════════════════════
    // 7. const / constexpr / #define
    // ══════════════════════════════════════════════
    const constexprRe = /^(?:(?:static|inline)\s+)?constexpr\s+(\w[\w:<>]*)\s+(\w+)\s*=\s*([^;]+);/gm;
    while ((m = constexprRe.exec(content)) !== null) {
      symbols.push({
        symbol_type: 'variable',
        name: m[2],
        value: m[3].trim().slice(0, 200),
        return_type: m[1],
        line_start: lineAt(content, m.index),
        is_exported: isHeader,
      });
    }

    const defineRe = /^#define\s+(\w+)(?:\(([^)]*)\))?\s+(.*)/gm;
    while ((m = defineRe.exec(content)) !== null) {
      const name = m[1];
      if (name.endsWith('_H') || name.endsWith('_HPP') || name.startsWith('_')) continue;
      if (m[2] !== undefined) {
        symbols.push({
          symbol_type: 'function',
          name,
          value: 'macro',
          params: m[2].split(',').map(p => p.trim()).filter(Boolean),
          line_start: lineAt(content, m.index),
          is_exported: isHeader,
        });
      } else {
        symbols.push({
          symbol_type: 'variable',
          name,
          value: m[3].trim().slice(0, 200),
          line_start: lineAt(content, m.index),
          is_exported: isHeader,
        });
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
    const blockCommentRe = /\/\*([\s\S]*?)\*\//g;
    while ((m = blockCommentRe.exec(content)) !== null) {
      const text = m[1].replace(/^\s*\*\s?/gm, '').trim();
      if (text.length < 3) continue;
      symbols.push({
        symbol_type: 'comment',
        name: null,
        value: text.slice(0, 500),
        line_start: lineAt(content, m.index),
        line_end: endLineAt(content, m.index, m[0].length),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 10. Routes — Crow: CROW_ROUTE(app, "/x")[.methods("POST"_method)]
    // ══════════════════════════════════════════════
    const crowRouteRe = /CROW_ROUTE\s*\(\s*\w+\s*,\s*"([^"]+)"\s*\)(?:\.methods?\(\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"_method\s*\))?/g;
    while ((m = crowRouteRe.exec(content)) !== null) {
      const path = m[1];
      const method = m[2] || 'GET';
      if (!isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }

    // ══════════════════════════════════════════════
    // 11. Routes — drogon: ADD_METHOD_TO(Class::method, "/x", Get, Options)
    // ══════════════════════════════════════════════
    const drogonRouteRe = /ADD_METHOD_TO\s*\([^,]+,\s*"([^"]+)"\s*,\s*(Get|Post|Put|Patch|Delete|Head|Options)/g;
    while ((m = drogonRouteRe.exec(content)) !== null) {
      const path = m[1];
      const method = m[2].toUpperCase();
      if (!isLikelyHttpPath(path)) continue;
      symbols.push({
        symbol_type: 'route',
        name: formatRouteName(method, path),
        value: path,
        params: [method],
        line_start: lineAt(content, m.index),
        is_exported: false,
      });
    }
    void HTTP_VERBS;

    // ══════════════════════════════════════════════
    // 12. Embedded SQL — libpqxx + sqlite3
    // ══════════════════════════════════════════════
    const seenSqlIdx = new Set<number>();
    const sqlCallRe = /\b(?:txn\.exec[01]?|conn\.exec|prepared|sqlite3_exec|sqlite3_prepare(?:_v2|_v3)?)\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = sqlCallRe.exec(content)) !== null) {
      const sqlContent = m[1];
      if (!looksLikeSql(sqlContent)) continue;
      seenSqlIdx.add(m.index);
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlContent, filePath, baseLine));
    }
    const sqlGenericRe = /\b\w+\.(?:query|exec[01]?)\s*\(\s*"((?:[^"\\]|\\.){10,})"/g;
    while ((m = sqlGenericRe.exec(content)) !== null) {
      if (seenSqlIdx.has(m.index)) continue;
      const sqlContent = m[1];
      if (!looksLikeSql(sqlContent)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlContent, filePath, baseLine));
    }
    const sqlRawRe = /R"\(([\s\S]{10,}?)\)"/g;
    while ((m = sqlRawRe.exec(content)) !== null) {
      const sqlContent = m[1];
      if (!looksLikeSql(sqlContent)) continue;
      const baseLine = lineAt(content, m.index);
      symbols.push(...parseEmbeddedSql(sqlContent, filePath, baseLine));
    }

    symbols.push(...extractStringLiterals(content));

    const { statements, callEdges } = extractFlowCpp(content);
    return { symbols, references, statements, callEdges };
  }

  private parseParams(raw: string): string[] {
    if (!raw.trim() || raw.trim() === 'void') return [];
    return raw
      .split(',')
      .map(p => {
        const parts = p.trim().split(/\s+/);
        return parts[parts.length - 1]?.replace(/[*&]/g, '') || '';
      })
      .filter(p => p && p !== '...');
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
    const classMatch = before.match(/(?:class|struct)\s+(\w+)[^{]*\{[^}]*$/);
    return classMatch ? classMatch[1] : undefined;
  }
}

export const cppParser = new CppParser();
