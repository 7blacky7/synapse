/**
 * MODUL: WGSL Parser
 * ZWECK: Extrahiert Struktur- und Ablauf-Informationen aus WebGPU-Shadern (.wgsl)
 *
 * EXTRAHIERT: struct samt Feldern, fn samt Parametern und Rueckgabetyp,
 *             globale var/let/const/override mit @group/@binding, alias,
 *             enable/requires/diagnostic, const_assert, Kommentare (Zeile und
 *             Block, verschachtelt) mit line_end, TODO/FIXME/HACK, Referenzen auf
 *             selbstdefinierte Typen und Funktionen, und die Ablauf-Ebene:
 *             declaration, assignment, if/else, switch/case, for, while, loop,
 *             continuing, return, break, continue, discard, call — mit Call-Kanten.
 *
 * ANSATZ: EIN Scanner ueber einen MASKIERTEN Text. Kommentare werden vorab durch
 *         Leerzeichen ersetzt, wobei Laenge und Zeilenumbrueche erhalten bleiben —
 *         jede Position gilt dadurch in beiden Texten. Angezeigter Text wird immer
 *         aus dem ORIGINAL geschnitten.
 *
 * WARUM KEIN REGEX MEHR FUER DIE STRUKTUR: die alte Feld-Regel lautete
 *         /^\s*(?:@\w+(?:\([^)]*\))?[\s\n]*)*(\w+)\s*:\s*(\w[\w<>,\s]*)/gm.
 *         Beide \s in der Typgruppe und hinter dem Attribut fressen ueber das
 *         Zeilenende; lastIndex landet dadurch MITTEN in der naechsten Zeile, und
 *         ^ greift erst wieder an der uebernaechsten. Gemessen an
 *         naga/tests/out/wgsl/wgsl-fragment-output.wgsl: von zwei structs mit je
 *         sechs Feldern kamen je DREI an (vec4f, vec4u, vec3i), das erste davon
 *         mit der Zeilennummer der struct-Zeile, und jeder Typ trug das
 *         verschluckte Komma der Folgezeile ("vec4<f32>,"). "Jedes zweite Element
 *         fehlt" ist der Fingerabdruck dieser Klasse, keine Zufallsverteilung.
 *         Der Scanner kennt diesen Fehler konstruktiv nicht mehr und hat auch kein
 *         Backtracking-Risiko (die alte Regel verschachtelte zwei Sternchen).
 */

import type {
  ParsedSymbol,
  ParsedReference,
  ParseResult,
  LanguageParser,
  ParsedStatement,
  ParsedCallEdge,
} from './types.js';
import { erstelleZeilenIndex, zeileFuerPosition } from './types.js';

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

// ---------------------------------------------------------------------------
// Maskierung: Kommentare aus dem Text nehmen, Laenge und Zeilen erhalten
// ---------------------------------------------------------------------------

interface Kommentar {
  start: number;
  ende: number;
  roh: string;
  art: 'zeile' | 'block';
  /** true wenn vor dem Kommentar in seiner Zeile nur Leerraum steht */
  alleine: boolean;
}

interface Maskierung {
  text: string;
  kommentare: Kommentar[];
}

function nurLeerraumDavor(content: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const c = content[i];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

/**
 * WGSL kennt KEINE Zeichenketten — maskiert werden ausschliesslich Kommentare.
 * Blockkommentare sind laut Spezifikation VERSCHACHTELBAR; wer beim ersten
 * Sternchen-Schraegstrich aufhoert, beendet einen auskommentierten Block zu frueh
 * und laesst dessen Rest als Code gelten.
 */
function maskiere(content: string): Maskierung {
  const kommentare: Kommentar[] = [];
  const teile: string[] = [];
  let letzte = 0;

  const leeren = (von: number, bis: number): void => {
    teile.push(content.slice(letzte, von));
    teile.push(content.slice(von, bis).replace(/[^\n]/g, ' '));
    letzte = bis;
  };

  const n = content.length;
  let i = 0;
  while (i < n) {
    const c = content[i];

    if (c === '/' && content[i + 1] === '/') {
      const start = i;
      while (i < n && content[i] !== '\n') i++;
      kommentare.push({
        start,
        ende: i,
        roh: content.slice(start, i),
        art: 'zeile',
        alleine: nurLeerraumDavor(content, start),
      });
      leeren(start, i);
      continue;
    }

    if (c === '/' && content[i + 1] === '*') {
      const start = i;
      i += 2;
      let tiefe = 1;
      while (i < n && tiefe > 0) {
        if (content[i] === '/' && content[i + 1] === '*') { tiefe++; i += 2; continue; }
        if (content[i] === '*' && content[i + 1] === '/') { tiefe--; i += 2; continue; }
        i++;
      }
      kommentare.push({
        start,
        ende: i,
        roh: content.slice(start, i),
        art: 'block',
        alleine: nurLeerraumDavor(content, start),
      });
      leeren(start, i);
      continue;
    }

    i++;
  }
  teile.push(content.slice(letzte));

  return { text: teile.join(''), kommentare };
}

/** Kommentartext ohne Marker. */
function kommentarRumpf(k: Kommentar): string {
  if (k.art === 'block') {
    let t = k.roh.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
    t = t.replace(/^[ \t]*\*[ \t]?/gm, '');
    return t.trim();
  }
  return k.roh.replace(/^\/\/+[ \t]?/, '').trim();
}

// ---------------------------------------------------------------------------
// Wortlisten
// ---------------------------------------------------------------------------

/** Woerter, hinter denen eine offene Klammer KEIN Aufruf ist. */
const SCHLUESSELWOERTER = new Set([
  'if', 'else', 'for', 'while', 'loop', 'switch', 'case', 'default', 'break',
  'continue', 'continuing', 'return', 'discard', 'let', 'var', 'const', 'override',
  'fn', 'struct', 'alias', 'enable', 'requires', 'diagnostic', 'const_assert',
  'true', 'false', 'ptr', 'array', 'atomic',
]);

/**
 * Eingebaute Typen und Funktionen. Sie werden fuer die ABLAUF-Ebene voll
 * mitgezaehlt (eine Call-Kante auf textureSample beantwortet "welcher Shader
 * tastet Texturen ab"), aber NICHT als Referenz gefuehrt: Referenzen werden beim
 * Persistieren ueber den Namen gegen Symbole aufgeloest, und fuer f32 oder vec4
 * gibt es projektweit kein Symbol — es entstuenden nur tote Zeilen.
 */
const EINGEBAUTE_NAMEN = new Set([
  // Typen
  'bool', 'i32', 'u32', 'f32', 'f16', 'i64', 'u64', 'f64',
  'vec2', 'vec3', 'vec4', 'array', 'atomic', 'ptr', 'sampler', 'sampler_comparison',
  'vec2f', 'vec3f', 'vec4f', 'vec2i', 'vec3i', 'vec4i', 'vec2u', 'vec3u', 'vec4u',
  'vec2h', 'vec3h', 'vec4h', 'binding_array',
  'mat2x2', 'mat2x3', 'mat2x4', 'mat3x2', 'mat3x3', 'mat3x4',
  'mat4x2', 'mat4x3', 'mat4x4',
  'mat2x2f', 'mat2x3f', 'mat2x4f', 'mat3x2f', 'mat3x3f', 'mat3x4f',
  'mat4x2f', 'mat4x3f', 'mat4x4f',
  'mat2x2h', 'mat2x3h', 'mat2x4h', 'mat3x2h', 'mat3x3h', 'mat3x4h',
  'mat4x2h', 'mat4x3h', 'mat4x4h',
  'texture_1d', 'texture_2d', 'texture_2d_array', 'texture_3d', 'texture_cube',
  'texture_cube_array', 'texture_multisampled_2d', 'texture_external',
  'texture_depth_2d', 'texture_depth_2d_array', 'texture_depth_cube',
  'texture_depth_cube_array', 'texture_depth_multisampled_2d',
  'texture_storage_1d', 'texture_storage_2d', 'texture_storage_2d_array',
  'texture_storage_3d',
  // Adressraeume und Zugriffsarten (stehen in var<...>)
  'function', 'private', 'workgroup', 'uniform', 'storage', 'handle',
  'read', 'write', 'read_write',
  // Funktionen
  'all', 'any', 'select', 'arrayLength', 'abs', 'acos', 'acosh', 'asin', 'asinh',
  'atan', 'atanh', 'atan2', 'ceil', 'clamp', 'cos', 'cosh', 'countLeadingZeros',
  'countOneBits', 'countTrailingZeros', 'cross', 'degrees', 'determinant',
  'distance', 'dot', 'dot4U8Packed', 'dot4I8Packed', 'exp', 'exp2', 'extractBits',
  'faceForward', 'firstLeadingBit', 'firstTrailingBit', 'floor', 'fma', 'fract',
  'frexp', 'insertBits', 'inverseSqrt', 'ldexp', 'length', 'log', 'log2', 'max',
  'min', 'mix', 'modf', 'normalize', 'pow', 'quantizeToF16', 'radians', 'reflect',
  'refract', 'reverseBits', 'round', 'saturate', 'sign', 'sin', 'sinh',
  'smoothstep', 'sqrt', 'step', 'tan', 'tanh', 'transpose', 'trunc', 'bitcast',
  'dpdx', 'dpdxCoarse', 'dpdxFine', 'dpdy', 'dpdyCoarse', 'dpdyFine',
  'fwidth', 'fwidthCoarse', 'fwidthFine',
  'textureDimensions', 'textureGather', 'textureGatherCompare', 'textureLoad',
  'textureNumLayers', 'textureNumLevels', 'textureNumSamples', 'textureSample',
  'textureSampleBias', 'textureSampleCompare', 'textureSampleCompareLevel',
  'textureSampleGrad', 'textureSampleLevel', 'textureSampleBaseClampToEdge',
  'textureStore', 'textureBarrier',
  'atomicLoad', 'atomicStore', 'atomicAdd', 'atomicSub', 'atomicMax', 'atomicMin',
  'atomicAnd', 'atomicOr', 'atomicXor', 'atomicExchange',
  'atomicCompareExchangeWeak',
  'pack4x8snorm', 'pack4x8unorm', 'pack2x16snorm', 'pack2x16unorm',
  'pack2x16float', 'pack4xI8', 'pack4xU8', 'pack4xI8Clamp', 'pack4xU8Clamp',
  'unpack4x8snorm', 'unpack4x8unorm', 'unpack2x16snorm', 'unpack2x16unorm',
  'unpack2x16float', 'unpack4xI8', 'unpack4xU8',
  'storageBarrier', 'workgroupBarrier', 'workgroupUniformLoad',
  'subgroupAdd', 'subgroupAll', 'subgroupAnd', 'subgroupAny', 'subgroupBallot',
  'subgroupBroadcast', 'subgroupBroadcastFirst', 'subgroupElect',
  'subgroupExclusiveAdd', 'subgroupExclusiveMul', 'subgroupInclusiveAdd',
  'subgroupInclusiveMul', 'subgroupMax', 'subgroupMin', 'subgroupMul',
  'subgroupOr', 'subgroupShuffle', 'subgroupShuffleDown', 'subgroupShuffleUp',
  'subgroupShuffleXor', 'subgroupXor', 'quadBroadcast', 'quadSwapDiagonal',
  'quadSwapX', 'quadSwapY',
]);

/** Zusammengesetzte Zuweisungsoperatoren, laengste zuerst. */
const ZUWEISUNGEN = ['<<=', '>>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface Ctx {
  scopeType: string;
  scopeName: string | null;
  parentId: string | undefined;
  depth: number;
  order: { n: number };
}

interface Analyse {
  symbols: ParsedSymbol[];
  statements: ParsedStatement[];
  callEdges: ParsedCallEdge[];
  references: ParsedReference[];
}

function istNameStart(c: string): boolean {
  return c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
}

function istNameZeichen(c: string): boolean {
  return c !== undefined
    && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_');
}

function analysiere(content: string, mask: Maskierung): Analyse {
  const m = mask.text;
  const n = m.length;

  const symbols: ParsedSymbol[] = [];
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  const references: ParsedReference[] = [];
  const gesehenReferenz = new Set<string>();

  let tempId = 0;
  const nextId = (): string => 's' + String(tempId++);

  const zeile = (pos: number): number => lineAt(content, Math.min(Math.max(pos, 0), content.length));
  const ausschnitt = (von: number, bis: number): string =>
    content.slice(Math.max(von, 0), Math.min(bis, content.length))
      .replace(/\s+/g, ' ').trim().slice(0, 200);

  function nichtLeer(pos: number): number {
    let p = pos;
    while (p < n) {
      const c = m[p];
      if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') break;
      p++;
    }
    return p;
  }

  function leseName(pos: number): { name: string; ende: number } | null {
    if (pos >= n || !istNameStart(m[pos])) return null;
    let p = pos + 1;
    while (p < n && istNameZeichen(m[p])) p++;
    return { name: m.slice(pos, p), ende: p };
  }

  /** Position der zu m[pos] passenden schliessenden Klammer, sonst n. */
  function passendeKlammer(pos: number): number {
    const auf = m[pos];
    const zu = auf === '(' ? ')' : auf === '[' ? ']' : auf === '{' ? '}' : '';
    if (zu === '') return pos;
    let tiefe = 0;
    for (let p = pos; p < n; p++) {
      const c = m[p];
      if (c === auf) tiefe++;
      else if (c === zu) { tiefe--; if (tiefe === 0) return p; }
    }
    return n;
  }

  /** Naechstes Semikolon auf oberster Ebene, sonst die Grenze. */
  function semikolon(von: number, grenze: number): number {
    let tiefe = 0;
    for (let p = von; p < grenze; p++) {
      const c = m[p];
      if (c === '(' || c === '[' || c === '{') tiefe++;
      else if (c === ')' || c === ']' || c === '}') { if (tiefe === 0) return p; tiefe--; }
      else if (c === ';' && tiefe === 0) return p;
    }
    return grenze;
  }

  /** Naechste geschweifte Klammer auf oberster Ebene — der Rumpf hinter einem Kopf. */
  function blockAnfang(von: number, grenze: number): number {
    let tiefe = 0;
    for (let p = von; p < grenze; p++) {
      const c = m[p];
      if (c === '(' || c === '[') { tiefe++; continue; }
      if (c === ')' || c === ']') { tiefe--; continue; }
      if (c === '{' && tiefe <= 0) return p;
      if (c === ';' && tiefe <= 0) return -1;
    }
    return -1;
  }

  /** Attributfolge ab pos ueberspringen: @group(0) @binding(1) ... */
  function leseAttribute(pos: number): { ende: number; roh: string } {
    let p = pos;
    for (;;) {
      const q = nichtLeer(p);
      if (m[q] !== '@') break;
      const w = leseName(q + 1);
      if (w === null) { p = q + 1; break; }
      let e = w.ende;
      const k = nichtLeer(e);
      if (m[k] === '(') e = passendeKlammer(k) + 1;
      p = e;
    }
    return { ende: p, roh: content.slice(pos, Math.min(p, content.length)) };
  }

  function emit(
    ctx: Ctx,
    von: number,
    bis: number,
    typ: string,
    extra: Partial<ParsedStatement> = {},
  ): ParsedStatement {
    const st: ParsedStatement = {
      temp_id: nextId(),
      parent_temp_id: ctx.parentId,
      scope_type: ctx.scopeType,
      scope_name: ctx.scopeName,
      statement_type: typ,
      line_start: zeile(von),
      line_end: zeile(Math.max(von, bis - 1)),
      order_index: ctx.order.n++,
      depth: ctx.depth,
      // "direkt im Modul-Scope" — siehe ParsedStatement.is_top_level. Die
      // Abfragen entrypoints und flow(datei) filtern darauf; wuerde hier auch
      // die erste Ebene jedes Funktionsrumpfs true tragen, stuenden 790 WGSL-
      // Funktionen mit ihrem gesamten Rumpf in den Entrypoints des Projekts.
      is_top_level: ctx.scopeType === 'module' && ctx.depth === 0,
      is_awaited: false,
      ...extra,
    };
    statements.push(st);
    return st;
  }

  /**
   * Neuer Rahmen fuer einen Block. Beginnt ein SCOPE (Funktionsrumpf), faengt
   * darin eine eigene Zaehlung an: depth 0 und kein Eltern-Statement.
   *
   * WARUM SCOPE-RELATIV: getExecutionFlow fragt "scope_name = X AND depth = 0"
   * ab. Mit einer ueber Scope-Grenzen durchgezaehlten Tiefe traegt das erste
   * Statement einer Funktion depth 1, und code_intel(flow) liefert fuer JEDE
   * Funktion leer, waehrend statements(scope) dieselben Zeilen anstandslos
   * findet. Genau dieser Nachbau hat scala einen zweiten Durchgang gekostet.
   */
  function unterCtx(ctx: Ctx, parentId: string): Ctx {
    return {
      scopeType: ctx.scopeType,
      scopeName: ctx.scopeName,
      parentId,
      depth: ctx.depth + 1,
      order: { n: 0 },
    };
  }

  function merkeReferenz(name: string, pos: number): void {
    if (name.length === 0 || EINGEBAUTE_NAMEN.has(name) || SCHLUESSELWOERTER.has(name)) return;
    const l = zeile(pos);
    const schluessel = name + '@' + String(l);
    if (gesehenReferenz.has(schluessel)) return;
    gesehenReferenz.add(schluessel);
    references.push({ symbol_name: name, line_number: l, context: ausschnitt(pos, pos + 80) });
  }

  /**
   * Alle Aufrufe in einem Abschnitt. Der Abschnitt ist immer der KOPF eines
   * Statements bzw. eine ;-terminierte Anweisung — Rumpfbloecke werden getrennt
   * besucht. Dadurch wird jede Position genau einmal betrachtet und der Aufwand
   * bleibt linear.
   */
  function sammleAufrufe(von: number, bis: number, stmtId: string, ctx: Ctx): void {
    const grenze = Math.min(bis, n);
    for (let p = Math.max(von, 0); p < grenze; p++) {
      if (!istNameStart(m[p])) continue;
      const w = leseName(p);
      if (w === null) continue;
      const nach = nichtLeer(w.ende);
      p = w.ende - 1;
      if (m[nach] !== '(') continue;
      if (SCHLUESSELWOERTER.has(w.name)) continue;

      // Empfaenger: a.b(...) — in WGSL selten, aber moeglich ueber Strukturfelder.
      let receiver: string | undefined;
      let vor = w.ende - w.name.length - 1;
      while (vor >= 0 && (m[vor] === ' ' || m[vor] === '\t')) vor--;
      if (vor >= 0 && m[vor] === '.') {
        let e = vor;
        let s = vor - 1;
        while (s >= 0 && (istNameZeichen(m[s]) || m[s] === '.')) s--;
        const roh = m.slice(s + 1, e).trim();
        if (roh.length > 0) receiver = roh;
      }

      const l = zeile(w.ende - w.name.length);
      callEdges.push({
        statement_temp_id: stmtId,
        caller_scope: ctx.scopeName,
        callee_name: w.name,
        callee_receiver: receiver,
        line_number: l,
        call_kind: receiver !== undefined ? 'method' : 'function',
        confidence: 1.0,
      });
      merkeReferenz(w.name, w.ende - w.name.length);
    }
  }

  /** Bezeichner in einem Typausdruck als Referenzen vormerken. */
  function sammleTypen(von: number, bis: number): void {
    const grenze = Math.min(bis, n);
    for (let p = Math.max(von, 0); p < grenze; p++) {
      if (!istNameStart(m[p])) continue;
      const w = leseName(p);
      if (w === null) continue;
      merkeReferenz(w.name, p);
      p = w.ende - 1;
    }
  }

  /**
   * Zuweisungsoperator auf oberster Ebene. Liefert Position und Laenge, sonst
   * null. == <= >= != und -> sind KEINE Zuweisungen.
   */
  function zuweisung(von: number, bis: number): { pos: number; laenge: number } | null {
    let tiefe = 0;
    for (let p = von; p < bis; p++) {
      const c = m[p];
      if (c === '(' || c === '[' || c === '{') { tiefe++; continue; }
      if (c === ')' || c === ']' || c === '}') { tiefe--; continue; }
      if (tiefe !== 0) continue;
      for (const op of ZUWEISUNGEN) {
        if (m.startsWith(op, p)) return { pos: p, laenge: op.length };
      }
      if (c === '=' && m[p + 1] !== '=' && m[p - 1] !== '=' && m[p - 1] !== '!'
        && m[p - 1] !== '<' && m[p - 1] !== '>') {
        return { pos: p, laenge: 1 };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Anweisungsblock
  // -------------------------------------------------------------------------

  /** von = Position HINTER der oeffnenden Klammer, bis = Position der schliessenden. */
  function parseBlock(von: number, bis: number, ctx: Ctx): void {
    let i = von;
    while (i < bis) {
      i = nichtLeer(i);
      if (i >= bis) break;
      const c = m[i];

      if (c === ';') { i++; continue; }

      if (c === '@') { i = leseAttribute(i).ende; continue; }

      // Nackter Block
      if (c === '{') {
        const zu = Math.min(passendeKlammer(i), bis);
        const st = emit(ctx, i, zu + 1, 'block', { node_kind: 'CompoundStatement' });
        parseBlock(i + 1, zu, unterCtx(ctx, st.temp_id));
        i = zu + 1;
        continue;
      }

      if (c === '}' || c === ')' || c === ']') { i++; continue; }

      const w = leseName(i);
      const wort = w === null ? '' : w.name;

      // --- if / else if / else ---------------------------------------------
      if (wort === 'if') {
        i = parseIfKette(i, bis, ctx);
        continue;
      }

      // --- Koepfe mit Rumpf: switch / loop / while / for / continuing -------
      if (wort === 'switch' || wort === 'loop' || wort === 'while'
        || wort === 'for' || wort === 'continuing') {
        const kopfEnde = blockAnfang(w!.ende, bis);
        if (kopfEnde < 0) { i = semikolon(w!.ende, bis) + 1; continue; }
        const zu = Math.min(passendeKlammer(kopfEnde), bis);
        const bedingung = ausschnitt(w!.ende, kopfEnde).replace(/^\(|\)$/g, '').trim();
        const knoten = wort === 'switch' ? 'SwitchStatement'
          : wort === 'loop' ? 'LoopStatement'
            : wort === 'while' ? 'WhileStatement'
              : wort === 'for' ? 'ForStatement' : 'ContinuingStatement';
        const extra: Partial<ParsedStatement> = { node_kind: knoten };
        if (bedingung.length > 0) extra.condition_text = bedingung;
        // Beim for die Laufvariable der Initialisierung als Ziel ausweisen.
        if (wort === 'for') {
          const init = leseName(nichtLeer(nichtLeer(w!.ende) + 1));
          if (init !== null && (init.name === 'var' || init.name === 'let')) {
            const v = leseName(nichtLeer(init.ende));
            if (v !== null) extra.assigned_to = v.name;
          }
        }
        const st = emit(ctx, i, zu + 1, wort === 'continuing' ? 'continuing' : wort, {
          ...extra,
          text: ausschnitt(i, kopfEnde + 1),
        });
        sammleAufrufe(w!.ende, kopfEnde, st.temp_id, ctx);
        parseBlock(kopfEnde + 1, zu, unterCtx(ctx, st.temp_id));
        i = zu + 1;
        continue;
      }

      // --- case / default ---------------------------------------------------
      if (wort === 'case' || wort === 'default') {
        const kopfEnde = blockAnfang(w!.ende, bis);
        if (kopfEnde < 0) { i = semikolon(w!.ende, bis) + 1; continue; }
        const zu = Math.min(passendeKlammer(kopfEnde), bis);
        const wahl = ausschnitt(w!.ende, kopfEnde).replace(/:$/, '').trim();
        const st = emit(ctx, i, zu + 1, 'case', {
          node_kind: wort === 'default' ? 'DefaultClause' : 'CaseClause',
          condition_text: wahl.length > 0 ? wahl : undefined,
          text: ausschnitt(i, kopfEnde + 1),
        });
        parseBlock(kopfEnde + 1, zu, unterCtx(ctx, st.temp_id));
        i = zu + 1;
        continue;
      }

      // --- Anweisungen bis zum Semikolon ------------------------------------
      const ende = semikolon(i, bis);
      const nachEnde = ende < bis ? ende + 1 : bis;

      if (wort === 'return' || wort === 'break' || wort === 'continue' || wort === 'discard') {
        const st = emit(ctx, i, nachEnde, wort, {
          node_kind: wort.charAt(0).toUpperCase() + wort.slice(1) + 'Statement',
          text: ausschnitt(i, ende),
        });
        sammleAufrufe(w!.ende, ende, st.temp_id, ctx);
        i = nachEnde;
        continue;
      }

      if (wort === 'let' || wort === 'var' || wort === 'const') {
        // var<workgroup> x : T = wert  — der Adressraum steht in spitzen Klammern.
        let p = nichtLeer(w!.ende);
        if (m[p] === '<') {
          const zu = m.indexOf('>', p);
          p = zu < 0 || zu > ende ? p : nichtLeer(zu + 1);
        }
        const v = leseName(p);
        const st = emit(ctx, i, nachEnde, 'declaration', {
          node_kind: wort === 'let' ? 'LetDeclaration'
            : wort === 'var' ? 'VarDeclaration' : 'ConstDeclaration',
          assigned_to: v !== null ? v.name : undefined,
          text: ausschnitt(i, ende),
        });
        if (v !== null) {
          // Der Typ steht zwischen Doppelpunkt und Gleichheitszeichen; beide sind
          // optional — `var x: T;`, `let y = 1;`, `var z: T = 1;` kommen alle vor.
          const gleich = m.indexOf('=', v.ende);
          const typGrenze = gleich >= 0 && gleich < ende ? gleich : ende;
          const doppelpunkt = nichtLeer(v.ende);
          const typ = m[doppelpunkt] === ':' ? ausschnitt(nichtLeer(doppelpunkt + 1), typGrenze) : '';
          sammleTypen(v.ende, typGrenze);
          // ZUSAETZLICH zum Statement, nicht an seiner Stelle: die Ablauf-Ebene
          // fuehrt dieselbe Deklaration weiter als 'declaration' mit assigned_to.
          // WARUM DOPPELTE BUCHFUEHRUNG: code_intel(variables) fragt die SYMBOL-Ebene
          // ab. Ohne diesen Eintrag findet eine Suche nach einer lokalen Variablen
          // nichts, und das sieht aus wie ein Parser-Ausfall, obwohl die Information
          // als Statement vorliegt. Am wgpu-Bestand sind es 6.134 solcher Deklarationen
          // (LetDeclaration 4.569, VarDeclaration 1.532, ConstDeclaration 33 — `let`
          // ueberwiegt in naga-generiertem Code deutlich).
          // solidity, jsonnet, scala und typescript fuehren sie ebenfalls als Symbol
          // (gemessen 2026-07-31); rust, go, python, java und c nicht.
          symbols.push({
            symbol_type: 'variable',
            name: v.name,
            value: typ.length > 0 ? typ : wort,
            return_type: typ.length > 0 ? typ : undefined,
            line_start: zeile(i),
            line_end: zeile(Math.max(i, ende - 1)),
            is_exported: false,
            parent_id: ctx.scopeName ?? undefined,
          });
        }
        sammleAufrufe(w === null ? i : w.ende, ende, st.temp_id, ctx);
        i = nachEnde;
        continue;
      }

      if (wort === 'const_assert') {
        const st = emit(ctx, i, nachEnde, 'assert', {
          node_kind: 'ConstAssert',
          condition_text: ausschnitt(w!.ende, ende),
          text: ausschnitt(i, ende),
        });
        sammleAufrufe(w!.ende, ende, st.temp_id, ctx);
        i = nachEnde;
        continue;
      }

      // Zuweisung, Aufruf oder sonstiger Ausdruck
      const zu2 = zuweisung(i, ende);
      if (zu2 !== null) {
        const ziel = ausschnitt(i, zu2.pos);
        const st = emit(ctx, i, nachEnde, 'assignment', {
          node_kind: 'AssignmentStatement',
          assigned_to: ziel.length > 0 ? ziel : undefined,
          text: ausschnitt(i, ende),
        });
        sammleAufrufe(i, ende, st.temp_id, ctx);
        i = nachEnde;
        continue;
      }

      // x++ / x--
      const inkr = /^([A-Za-z_][\w.[\]]*)\s*(\+\+|--)/.exec(m.slice(i, ende));
      if (inkr !== null) {
        const st = emit(ctx, i, nachEnde, 'assignment', {
          node_kind: inkr[2] === '++' ? 'IncrementStatement' : 'DecrementStatement',
          assigned_to: inkr[1],
          text: ausschnitt(i, ende),
        });
        i = nachEnde;
        continue;
      }

      if (ende <= i) { i = i + 1; continue; }

      // Reiner Aufruf als Anweisung
      let typ = 'expression';
      let callee: string | undefined;
      if (w !== null && !SCHLUESSELWOERTER.has(wort) && m[nichtLeer(w.ende)] === '(') {
        typ = 'call';
        callee = wort;
      }
      const st = emit(ctx, i, nachEnde, typ, {
        node_kind: typ === 'call' ? 'CallStatement' : 'ExpressionStatement',
        callee,
        text: ausschnitt(i, ende),
      });
      sammleAufrufe(i, ende, st.temp_id, ctx);
      i = nachEnde;
    }
  }

  /**
   * if / else if / else. Alle Zweige sind GESCHWISTER auf derselben Ebene —
   * so wie sie im Quelltext nacheinander stehen. Liefert die Position hinter
   * dem letzten Zweig.
   */
  function parseIfKette(von: number, bis: number, ctx: Ctx): number {
    let i = von;
    for (;;) {
      const w = leseName(i);
      if (w === null || w.name !== 'if') break;
      const kopfEnde = blockAnfang(w.ende, bis);
      if (kopfEnde < 0) return semikolon(w.ende, bis) + 1;
      const zu = Math.min(passendeKlammer(kopfEnde), bis);
      const bed = ausschnitt(w.ende, kopfEnde).replace(/^\(|\)$/g, '').trim();
      const st = emit(ctx, i, zu + 1, 'if', {
        node_kind: 'IfStatement',
        condition_text: bed,
        text: ausschnitt(i, kopfEnde + 1),
      });
      sammleAufrufe(w.ende, kopfEnde, st.temp_id, ctx);
      parseBlock(kopfEnde + 1, zu, unterCtx(ctx, st.temp_id));

      const nach = nichtLeer(zu + 1);
      const e = leseName(nach);
      if (e === null || e.name !== 'else' || nach >= bis) return zu + 1;
      const nach2 = nichtLeer(e.ende);
      const w2 = leseName(nach2);
      if (w2 !== null && w2.name === 'if') { i = nach2; continue; }
      if (m[nach2] !== '{') return e.ende;
      const zu2 = Math.min(passendeKlammer(nach2), bis);
      const stElse = emit(ctx, nach, zu2 + 1, 'else', {
        node_kind: 'ElseClause',
        text: ausschnitt(nach, nach2 + 1),
      });
      parseBlock(nach2 + 1, zu2, unterCtx(ctx, stElse.temp_id));
      return zu2 + 1;
    }
    return i + 1;
  }

  // -------------------------------------------------------------------------
  // Struct-Felder
  // -------------------------------------------------------------------------

  function parseFelder(von: number, bis: number, structName: string): void {
    let i = von;
    while (i < bis) {
      i = nichtLeer(i);
      if (i >= bis) break;
      if (m[i] === ',' || m[i] === ';') { i++; continue; }

      const feldStart = i;
      const attr = leseAttribute(i);
      const nameStart = nichtLeer(attr.ende);
      const w = leseName(nameStart);
      if (w === null) {
        // Nicht deutbar — bis zum naechsten Komma der obersten Ebene weiter.
        i = trennerFeld(nameStart, bis) + 1;
        continue;
      }
      const dp = nichtLeer(w.ende);
      if (m[dp] !== ':') { i = trennerFeld(w.ende, bis) + 1; continue; }

      const typStart = nichtLeer(dp + 1);
      const typEnde = trennerFeld(typStart, bis);
      const typ = ausschnitt(typStart, typEnde);
      sammleTypen(typStart, typEnde);

      symbols.push({
        symbol_type: 'variable',
        name: w.name,
        value: typ,
        return_type: typ,
        line_start: zeile(feldStart),
        line_end: zeile(Math.max(feldStart, typEnde - 1)),
        is_exported: true,
        parent_id: structName,
      });
      i = typEnde + 1;
    }
  }

  /** Komma auf oberster Ebene innerhalb einer Feld- oder Parameterliste. */
  function trennerFeld(von: number, bis: number): number {
    let tiefe = 0;
    for (let p = von; p < bis; p++) {
      const c = m[p];
      if (c === '(' || c === '[' || c === '{' || c === '<') tiefe++;
      else if (c === ')' || c === ']' || c === '}' || c === '>') { if (tiefe === 0) return p; tiefe--; }
      else if ((c === ',' || c === ';') && tiefe === 0) return p;
    }
    return bis;
  }

  // -------------------------------------------------------------------------
  // Modul-Ebene
  // -------------------------------------------------------------------------

  const modul: Ctx = {
    scopeType: 'module',
    scopeName: null,
    parentId: undefined,
    depth: 0,
    order: { n: 0 },
  };

  let i = 0;
  while (i < n) {
    i = nichtLeer(i);
    if (i >= n) break;
    const c = m[i];
    if (c === ';') { i++; continue; }
    if (c === '}' || c === ')' || c === ']') { i++; continue; }

    const start = i;
    const attr = leseAttribute(i);
    const wortStart = nichtLeer(attr.ende);
    const w = leseName(wortStart);
    if (w === null) {
      // Kein deutbares Schluesselwort — bis zum naechsten Semikolon weiter.
      const e = semikolon(wortStart, n);
      i = e >= n ? n : e + 1;
      continue;
    }
    const wort = w.name;
    const attribute = attr.roh;

    // --- enable / requires ---------------------------------------------------
    if (wort === 'enable' || wort === 'requires') {
      const ende = semikolon(w.ende, n);
      const l = zeile(start);
      const lEnde = zeile(Math.max(start, ende - 1));
      const namen = content.slice(w.ende, Math.min(ende, content.length))
        .split(',').map(s => s.trim()).filter(Boolean);
      for (const name of namen) {
        symbols.push({
          symbol_type: 'import',
          name,
          value: wort,
          line_start: l,
          line_end: lEnde,
          is_exported: false,
        });
      }
      emit(modul, start, ende + 1, 'import', {
        node_kind: wort === 'enable' ? 'EnableDirective' : 'RequiresDirective',
        text: ausschnitt(start, ende),
      });
      i = ende >= n ? n : ende + 1;
      continue;
    }

    // --- diagnostic ----------------------------------------------------------
    if (wort === 'diagnostic') {
      const ende = semikolon(w.ende, n);
      emit(modul, start, ende + 1, 'directive', {
        node_kind: 'DiagnosticDirective',
        text: ausschnitt(start, ende),
      });
      i = ende >= n ? n : ende + 1;
      continue;
    }

    // --- const_assert --------------------------------------------------------
    if (wort === 'const_assert') {
      const ende = semikolon(w.ende, n);
      const st = emit(modul, start, ende + 1, 'assert', {
        node_kind: 'ConstAssert',
        condition_text: ausschnitt(w.ende, ende),
        text: ausschnitt(start, ende),
      });
      sammleAufrufe(w.ende, ende, st.temp_id, modul);
      i = ende >= n ? n : ende + 1;
      continue;
    }

    // --- alias ---------------------------------------------------------------
    if (wort === 'alias') {
      const ende = semikolon(w.ende, n);
      const name = leseName(nichtLeer(w.ende));
      const gleich = m.indexOf('=', name === null ? w.ende : name.ende);
      const ziel = gleich >= 0 && gleich < ende ? ausschnitt(gleich + 1, ende) : '';
      if (name !== null) {
        symbols.push({
          symbol_type: 'interface',
          name: name.name,
          value: ziel.length > 0 ? `alias = ${ziel}` : 'alias',
          return_type: ziel.length > 0 ? ziel : undefined,
          line_start: zeile(start),
          line_end: zeile(Math.max(start, ende - 1)),
          is_exported: true,
        });
        if (gleich >= 0 && gleich < ende) sammleTypen(gleich + 1, ende);
      }
      emit(modul, start, ende + 1, 'declaration', {
        node_kind: 'TypeAlias',
        assigned_to: name === null ? undefined : name.name,
        text: ausschnitt(start, ende),
      });
      i = ende >= n ? n : ende + 1;
      continue;
    }

    // --- struct --------------------------------------------------------------
    if (wort === 'struct') {
      const name = leseName(nichtLeer(w.ende));
      const auf = blockAnfang(name === null ? w.ende : name.ende, n);
      if (auf < 0 || name === null) { i = semikolon(w.ende, n) + 1; continue; }
      const zu = passendeKlammer(auf);
      symbols.push({
        symbol_type: 'class',
        name: name.name,
        value: 'struct',
        line_start: zeile(start),
        line_end: zeile(zu),
        is_exported: true,
      });
      emit(modul, start, zu + 1, 'declaration', {
        node_kind: 'StructDeclaration',
        assigned_to: name.name,
        text: ausschnitt(start, auf + 1),
      });
      parseFelder(auf + 1, zu, name.name);
      i = zu + 1;
      continue;
    }

    // --- fn ------------------------------------------------------------------
    if (wort === 'fn') {
      const name = leseName(nichtLeer(w.ende));
      if (name === null) { i = w.ende; continue; }
      const klammerAuf = nichtLeer(name.ende);
      if (m[klammerAuf] !== '(') { i = name.ende; continue; }
      const klammerZu = passendeKlammer(klammerAuf);

      const params: string[] = [];
      let p = klammerAuf + 1;
      while (p < klammerZu) {
        p = nichtLeer(p);
        if (p >= klammerZu) break;
        const pAttr = leseAttribute(p);
        const pName = leseName(nichtLeer(pAttr.ende));
        const trenner = trennerFeld(p, klammerZu);
        if (pName !== null) {
          params.push(pName.name);
          const dp = nichtLeer(pName.ende);
          if (m[dp] === ':') sammleTypen(dp + 1, trenner);
        }
        p = trenner + 1;
      }

      // Rueckgabetyp: -> [Attribute] Typ, bis zur oeffnenden Klammer des Rumpfes.
      const auf = blockAnfang(klammerZu + 1, n);
      let returnType: string | undefined;
      const pfeil = m.indexOf('->', klammerZu);
      const rumpfGrenze = auf < 0 ? semikolon(klammerZu, n) : auf;
      if (pfeil >= 0 && pfeil < rumpfGrenze) {
        const rAttr = leseAttribute(pfeil + 2);
        const t = ausschnitt(rAttr.ende, rumpfGrenze);
        if (t.length > 0) { returnType = t; sammleTypen(rAttr.ende, rumpfGrenze); }
      }

      let stage: string | undefined;
      if (/@vertex\b/.test(attribute)) stage = '@vertex';
      else if (/@fragment\b/.test(attribute)) stage = '@fragment';
      else if (/@compute\b/.test(attribute)) stage = '@compute';

      const zu = auf < 0 ? rumpfGrenze : passendeKlammer(auf);
      symbols.push({
        symbol_type: 'function',
        name: name.name,
        value: stage,
        params: params.length > 0 ? params : undefined,
        return_type: returnType,
        line_start: zeile(start),
        line_end: zeile(zu),
        is_exported: !!stage,
      });

      if (stage === '@compute') {
        const wgs = /@workgroup_size\(([^)]*)\)/.exec(attribute);
        if (wgs !== null) {
          symbols.push({
            symbol_type: 'variable',
            name: `${name.name}.workgroup_size`,
            value: wgs[1].trim(),
            line_start: zeile(start),
            line_end: zeile(start),
            is_exported: false,
            parent_id: name.name,
          });
        }
      }

      emit(modul, start, zu + 1, 'declaration', {
        node_kind: 'FunctionDeclaration',
        assigned_to: name.name,
        text: ausschnitt(start, auf < 0 ? rumpfGrenze : auf + 1),
      });

      if (auf >= 0) {
        parseBlock(auf + 1, zu, {
          scopeType: 'function',
          scopeName: name.name,
          parentId: undefined,
          depth: 0,
          order: { n: 0 },
        });
        i = zu + 1;
      } else {
        i = rumpfGrenze >= n ? n : rumpfGrenze + 1;
      }
      continue;
    }

    // --- globale var / const / override / let --------------------------------
    if (wort === 'var' || wort === 'const' || wort === 'override' || wort === 'let') {
      const ende = semikolon(w.ende, n);
      let p = nichtLeer(w.ende);
      let adressraum: string | undefined;
      if (m[p] === '<') {
        const spitzZu = m.indexOf('>', p);
        if (spitzZu >= 0 && spitzZu < ende) {
          adressraum = content.slice(p + 1, spitzZu).replace(/\s+/g, ' ').trim();
          p = nichtLeer(spitzZu + 1);
        }
      }
      const name = leseName(p);
      if (name === null) { i = ende >= n ? n : ende + 1; continue; }

      const dp = nichtLeer(name.ende);
      let varTyp: string | undefined;
      let gleich = -1;
      const z = zuweisung(name.ende, ende);
      if (z !== null) gleich = z.pos;
      if (m[dp] === ':') {
        const typEnde = gleich >= 0 ? gleich : ende;
        varTyp = ausschnitt(dp + 1, typEnde);
        sammleTypen(dp + 1, typEnde);
      }
      const wert = gleich >= 0 ? ausschnitt(gleich + 1, ende) : undefined;

      const gruppe = /@group\((\d+)\)/.exec(attribute);
      const bindung = /@binding\((\d+)\)/.exec(attribute);
      const binding = gruppe !== null && bindung !== null
        ? `@group(${gruppe[1]}) @binding(${bindung[1]})`
        : undefined;

      symbols.push({
        symbol_type: 'variable',
        name: name.name,
        value: binding ?? wert ?? varTyp ?? adressraum ?? wort,
        return_type: varTyp,
        line_start: zeile(start),
        line_end: zeile(Math.max(start, ende - 1)),
        is_exported: !!binding || wort === 'override',
      });

      const st = emit(modul, start, ende + 1, 'declaration', {
        node_kind: wort === 'override' ? 'OverrideDeclaration'
          : wort === 'const' ? 'ConstDeclaration' : 'VarDeclaration',
        assigned_to: name.name,
        text: ausschnitt(start, ende),
      });
      if (gleich >= 0) sammleAufrufe(gleich + 1, ende, st.temp_id, modul);
      i = ende >= n ? n : ende + 1;
      continue;
    }

    // Unbekanntes Wort auf Modulebene — bis zum naechsten Semikolon weiter.
    const e = semikolon(w.ende, n);
    i = e >= n ? n : e + 1;
  }

  return { symbols, statements, callEdges, references };
}

class WgslParser implements LanguageParser {
  language = 'wgsl';
  extensions = ['.wgsl'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Regex-Struktur durch einen Scanner ueber maskierten Text ersetzt.
  //    - Struct-Felder: vorher kam JEDES ZWEITE Feld an, weil \s in der Feld-Regel
  //      ueber das Zeilenende frass (siehe Modulkopf). Ausserdem trug jeder Typ
  //      das Komma der Folgezeile, und das erste Feld eines structs die
  //      Zeilennummer der struct-Zeile.
  //    - Kommentare (Zeile und Block, verschachtelt) als Symbole mit line_end;
  //      zusammenhaengende Zeilenkommentare gebuendelt.
  //    - Maskierung vor allen Struktur-Regeln: auskommentierter Code liefert
  //      keine Symbole mehr.
  //    - line_end fuer struct, fn, Felder, Globale, alias, enable, Kommentare
  //      (vorher trugen 2.529 von 2.799 Symbolen im Index gar keins).
  //    - Ablauf-Ebene: Statements und Call-Kanten (vorher konstant leer — health
  //      meldete ueber 270 Dateien "ABLAUF-EBENE FEHLT GANZ"). depth ist von
  //      Anfang an scope-relativ, siehe unterCtx.
  //    - Referenzen auf selbstdefinierte Typen und Funktionen; eingebaute Namen
  //      bleiben aussen vor, fuer sie gibt es projektweit kein Symbol.
  //    - enable/requires/diagnostic/const_assert/alias auch ausserhalb des
  //      Zeilenanfangs (die alten Regeln waren mit ^ verankert).
  //    - KEINE string-Symbole mehr: WGSL kennt keine Zeichenketten-Literale. Die
  //      20 im Index stammten samt und sonders aus Kommentartext, weil
  //      extractStringLiterals ueber den Rohtext lief.
  // 4: lokale var/let/const im Funktionsrumpf wieder als variable-SYMBOL, zusaetzlich
  //    zum declaration-Statement der Ablauf-Ebene. In 3 waren sie NUR Statement, damit
  //    fand code_intel(variables) sie nicht mehr — 6.134 Deklarationen im wgpu-Bestand.
  //    ZUM VERGLEICH: Version 2 kannte davon nur 477, also 7,8 Prozent. Der Rueckbau
  //    stellt damit nicht den Zustand von 2 wieder her, sondern einen deutlich
  //    besseren; die alte Regel hat hier nicht "jede zweite" verschluckt, sondern
  //    ueber neun Zehntel. User-Vorgabe: "es soll so funktionieren wie es geplant ist,
  //    KI soll alles finden mit code_intel". parent_id traegt den Funktionsnamen.
  version = 4;

  parse(content: string, _filePath: string): ParseResult {
    const mask = maskiere(content);
    const { symbols, statements, callEdges, references } = analysiere(content, mask);

    // Kommentare: Bloecke als EIN Symbol, aufeinanderfolgende Zeilenkommentare
    // gebuendelt. Ein Kommentar hinter Code bleibt eigenstaendig.
    const ks = mask.kommentare;
    let i = 0;
    while (i < ks.length) {
      const k = ks[i];
      if (k.art === 'block' || !k.alleine) {
        const text = kommentarRumpf(k);
        if (text.length > 0) {
          symbols.push({
            symbol_type: 'comment',
            name: null,
            value: text,
            line_start: lineAt(content, k.start),
            line_end: lineAt(content, Math.max(k.start, k.ende - 1)),
            is_exported: false,
          });
        }
        i++;
        continue;
      }
      let j = i;
      let letzteZeile = lineAt(content, k.start);
      while (j + 1 < ks.length) {
        const nx = ks[j + 1];
        if (nx.art !== 'zeile' || !nx.alleine) break;
        const z = lineAt(content, nx.start);
        if (z !== letzteZeile + 1) break;
        letzteZeile = z;
        j++;
      }
      const gebuendelt = ks.slice(i, j + 1).map(kommentarRumpf).join('\n').trim();
      if (gebuendelt.length > 0) {
        symbols.push({
          symbol_type: 'comment',
          name: null,
          value: gebuendelt,
          line_start: lineAt(content, k.start),
          line_end: letzteZeile,
          is_exported: false,
        });
      }
      i = j + 1;
    }

    // TODO/FIXME/HACK ausschliesslich aus Kommentaren.
    for (const k of mask.kommentare) {
      const treffer = /\b(TODO|FIXME|HACK)\b:?(.*)/i.exec(k.roh);
      if (treffer === null) continue;
      const l = lineAt(content, k.start + treffer.index);
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: k.roh.slice(treffer.index).trim().slice(0, 200),
        line_start: l,
        line_end: l,
        is_exported: false,
      });
    }

    return { symbols, references, statements, callEdges };
  }
}

export const wgslParser = new WgslParser();
