/**
 * MODUL: Jsonnet Parser
 * ZWECK: Extrahiert Struktur- und Ablauf-Informationen aus Jsonnet-Dateien (.jsonnet, .libsonnet)
 *
 * EXTRAHIERT: import/importstr/importbin, local-Bindings (Variablen wie Funktionen,
 *             auch Ketten mit Komma), Objektfelder samt Sichtbarkeit, Methoden,
 *             berechnete und in Anfuehrungszeichen geschriebene Feldnamen,
 *             Kommentare (Doppelstrich, Raute, Block) mit line_end, TODO/FIXME/HACK,
 *             Zeichenketten, und die Ablauf-Ebene: assignment, if, for, assert,
 *             throw, import, call — mit Call-Kanten samt receiver.
 *
 * ANSATZ: Ein Scanner ueber einen MASKIERTEN Text. Kommentare und Zeichenketten
 *         werden vorab durch Leerzeichen ersetzt, wobei Laenge und Zeilenumbrueche
 *         erhalten bleiben — sonst zeigen alle Positionen daneben. Der angezeigte
 *         Text der Symbole und Statements wird aus dem ORIGINAL geschnitten.
 *
 * WARUM MASKIERT: ohne sie lief die Feld-Regel ueber Kommentartext. Aus der
 *         Lizenz-URL "http" plus Doppelpunkt in jedem Apache-Kopf wurde ein
 *         exportiertes Objektfeld namens http — in google/jsonnet in dutzenden
 *         Dateien. Zeichenketten maskieren erspart denselben Fehler bei Feldnamen,
 *         die zufaellig einen Doppelpunkt enthalten.
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
// Maskierung: Kommentare und Zeichenketten aus dem Text nehmen, Laenge erhalten
// ---------------------------------------------------------------------------

interface Kommentar {
  start: number;
  ende: number;
  roh: string;
  art: 'zeile' | 'block';
  /** true wenn vor dem Kommentar in seiner Zeile nur Leerraum steht */
  alleine: boolean;
}

interface Zeichenkette {
  start: number;
  ende: number;
  wert: string;
  mehrzeilig: boolean;
}

interface Maskierung {
  text: string;
  kommentare: Kommentar[];
  zeichenketten: Zeichenkette[];
  /** Startposition -> Zeichenkette, fuer Feldnamen und Import-Pfade */
  beiPosition: Map<number, Zeichenkette>;
}

function nurLeerraumDavor(content: string, pos: number): boolean {
  for (let i = pos - 1; i >= 0; i--) {
    const c = content[i];
    if (c === '\n') return true;
    if (c !== ' ' && c !== '\t' && c !== '\r') return false;
  }
  return true;
}

function maskiere(content: string): Maskierung {
  const kommentare: Kommentar[] = [];
  const zeichenketten: Zeichenkette[] = [];
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

    // Zeilenkommentar: Doppelstrich oder Raute
    if ((c === '/' && content[i + 1] === '/') || c === '#') {
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

    // Blockkommentar
    if (c === '/' && content[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) i++;
      i = Math.min(i + 2, n);
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

    // Textblock mit drei senkrechten Strichen (mehrzeilig)
    if (c === '|' && content.startsWith('|||', i)) {
      const start = i;
      const schluss = content.indexOf('|||', i + 3);
      const inhaltEnde = schluss === -1 ? n : schluss;
      i = schluss === -1 ? n : schluss + 3;
      zeichenketten.push({ start, ende: i, wert: content.slice(start + 3, inhaltEnde), mehrzeilig: true });
      leeren(start, i);
      continue;
    }

    // Verbatim-Zeichenkette: Klammeraffe vor dem Anfuehrungszeichen,
    // Escape ist ausschliesslich das verdoppelte Anfuehrungszeichen.
    if (c === '@' && (content[i + 1] === '"' || content[i + 1] === "'")) {
      const q = content[i + 1];
      const start = i;
      i += 2;
      while (i < n) {
        if (content[i] === q) {
          if (content[i + 1] === q) { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      zeichenketten.push({
        start,
        ende: i,
        wert: content.slice(start + 2, Math.max(start + 2, i - 1)),
        mehrzeilig: false,
      });
      leeren(start, i);
      continue;
    }

    // Gewoehnliche Zeichenkette
    if (c === '"' || c === "'") {
      const q = c;
      const start = i;
      i++;
      let offen = true;
      while (i < n) {
        const z = content[i];
        if (z === '\\') { i += 2; continue; }
        if (z === '\n') { offen = false; break; }   // unbeendet: nicht ueber die Zeile hinaus
        if (z === q) { i++; offen = false; break; }
        i++;
      }
      if (offen) i = n;
      const inhaltEnde = Math.max(start + 1, content[i - 1] === q ? i - 1 : i);
      zeichenketten.push({ start, ende: i, wert: content.slice(start + 1, inhaltEnde), mehrzeilig: false });
      leeren(start, i);
      continue;
    }

    i++;
  }
  teile.push(content.slice(letzte));

  const beiPosition = new Map<number, Zeichenkette>();
  for (const s of zeichenketten) beiPosition.set(s.start, s);

  return { text: teile.join(''), kommentare, zeichenketten, beiPosition };
}

/** Kommentartext ohne Marker. Der Inhalt wird NICHT gekuerzt (Vorgabe: nur Anzeige-Filter kuerzen). */
function kommentarRumpf(k: Kommentar): string {
  if (k.art === 'block') {
    let t = k.roh.replace(/^\/\*+/, '').replace(/\*+\/$/, '');
    t = t.replace(/^[ \t]*\*[ \t]?/gm, '');
    return t.trim();
  }
  return k.roh.replace(/^(\/\/+|#+)[ \t]?/, '').trim();
}

// ---------------------------------------------------------------------------
// Kleine Helfer auf dem maskierten Text
// ---------------------------------------------------------------------------

function istNameStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function istNameZeichen(c: string): boolean {
  return /[A-Za-z0-9_]/.test(c);
}

const SCHLUESSELWOERTER = new Set([
  'assert', 'else', 'error', 'false', 'for', 'function', 'if', 'import', 'importstr',
  'importbin', 'in', 'local', 'null', 'tailstrict', 'then', 'self', 'super', 'true',
]);

/** Zerlegt eine Parameterliste an Kommas der obersten Ebene und liefert die Namen. */
function zerlegeParams(roh: string): string[] {
  const namen: string[] = [];
  let tiefe = 0;
  let start = 0;
  const schneiden = (bis: number): void => {
    const stueck = roh.slice(start, bis).trim();
    if (stueck.length === 0) return;
    const name = stueck.split('=')[0].trim();
    if (name.length > 0) namen.push(name);
  };
  for (let i = 0; i < roh.length; i++) {
    const c = roh[i];
    if (c === '(' || c === '[' || c === '{') tiefe++;
    else if (c === ')' || c === ']' || c === '}') tiefe--;
    else if (c === ',' && tiefe === 0) { schneiden(i); start = i + 1; }
  }
  schneiden(roh.length);
  return namen;
}

// ---------------------------------------------------------------------------
// Scanner: Symbole, Statements, Call-Kanten und Referenzen in EINEM Durchlauf
// ---------------------------------------------------------------------------

interface Rahmen {
  /** Position, ab der dieser Rahmen vorbei ist */
  ende: number;
  scopeType: string;
  scopeName: string | null;
  /** Statement, das diesen Rahmen aufgespannt hat */
  parentId?: string;
  depth: number;
  order: { n: number };
  art: 'modul' | 'bind' | 'feld' | 'ausdruck';
  /** nur bei art 'bind': Ende der local-Anweisung, fuer Ketten mit Komma */
  localGrenze?: number;
}

interface Analyse {
  symbols: ParsedSymbol[];
  statements: ParsedStatement[];
  callEdges: ParsedCallEdge[];
  references: ParsedReference[];
}

function analysiere(content: string, mask: Maskierung): Analyse {
  const m = mask.text;
  const n = m.length;

  const symbols: ParsedSymbol[] = [];
  const statements: ParsedStatement[] = [];
  const callEdges: ParsedCallEdge[] = [];
  const references: ParsedReference[] = [];

  /** Name -> wie oft in DIESER Datei definiert. Mehrfach = fuer Referenzen unbrauchbar. */
  const definierteNamen = new Map<string, number>();
  const namensVerwendungen: Array<{ name: string; pos: number }> = [];
  /** Referenzen, die erst nach dem Durchlauf gegen die Eindeutigkeit geprueft werden. */
  const referenzKandidaten: Array<ParsedReference> = [];
  function merkeDefinition(name: string): void {
    definierteNamen.set(name, (definierteNamen.get(name) ?? 0) + 1);
  }

  let tempId = 0;
  const nextId = (): string => 's' + String(tempId++);
  const orderCounters = new Map<string, number>();
  function nextOrder(parentId: string | undefined, order: { n: number }): number {
    if (parentId === undefined) return order.n++;
    const key = 'p:' + parentId;
    const cur = orderCounters.get(key) ?? 0;
    orderCounters.set(key, cur + 1);
    return cur;
  }

  const zeile = (pos: number): number => lineAt(content, pos);
  const ausschnitt = (von: number, bis: number): string =>
    content.slice(von, Math.min(bis, content.length)).replace(/\s+/g, ' ').trim().slice(0, 200);

  const rahmen: Rahmen[] = [{
    ende: n + 1,
    scopeType: 'module',
    scopeName: null,
    depth: 0,
    order: { n: 0 },
    art: 'modul',
  }];
  const oben = (): Rahmen => rahmen[rahmen.length - 1];
  /** Stack der offenen Klammern — entscheidet, ob ein Doppelpunkt ein Objektfeld einleitet */
  const klammern: string[] = [];

  function emit(
    lineStart: number,
    lineEnd: number,
    stmtType: string,
    extra: Partial<ParsedStatement> = {},
  ): ParsedStatement {
    const r = oben();
    const st: ParsedStatement = {
      temp_id: nextId(),
      parent_temp_id: r.parentId,
      scope_type: r.scopeType,
      scope_name: r.scopeName,
      statement_type: stmtType,
      line_start: lineStart,
      line_end: lineEnd,
      order_index: nextOrder(r.parentId, r.order),
      depth: r.depth,
      is_top_level: r.scopeType === 'module' && r.depth === 0,
      is_awaited: false,
      ...extra,
    };
    statements.push(st);
    return st;
  }

  /**
   * Neuer Rahmen. Wird ein SCOPE geoeffnet (Funktion oder Methode), beginnt darin
   * eine eigene Zaehlung: depth 0 und kein Eltern-Statement.
   *
   * WARUM SCOPE-RELATIV: getExecutionFlow fragt "scope_name = X AND depth = 0" ab.
   * Mit einer ueber Scope-Grenzen durchgezaehlten Tiefe traegt das erste Statement
   * einer Funktion depth 1, und code_intel(flow) liefert fuer JEDE Funktion leer,
   * waehrend statements(scope) dieselben Zeilen anstandslos findet. solidity.ts
   * startet den Funktionsrumpf aus demselben Grund mit depth 0 und ohne Eltern.
   */
  function pushRahmen(
    ende: number,
    art: Rahmen['art'],
    parentId: string,
    scopeType?: string,
    scopeName?: string | null,
    localGrenze?: number,
  ): void {
    const r = oben();
    const neuerScope = scopeType !== undefined;
    rahmen.push({
      ende,
      scopeType: scopeType ?? r.scopeType,
      scopeName: neuerScope ? (scopeName ?? null) : r.scopeName,
      parentId: neuerScope ? undefined : parentId,
      depth: neuerScope ? 0 : r.depth + 1,
      order: { n: 0 },
      art,
      localGrenze,
    });
  }

  function nichtLeer(pos: number): number {
    let p = pos;
    while (p < n && /\s/.test(m[p])) p++;
    return p;
  }

  /**
   * Erste Zeichenkette ab dieser Position, wenn davor nur Leerraum steht.
   * NICHT ueber nichtLeer suchen: im maskierten Text IST eine Zeichenkette
   * Leerraum, der Sprung wuerde genau ueber sie hinweggehen.
   */
  function zeichenketteNach(von: number): Zeichenkette | undefined {
    for (const s of mask.zeichenketten) {
      if (s.start < von) continue;
      return content.slice(von, s.start).trim().length === 0 ? s : undefined;
    }
    return undefined;
  }

  function leseName(pos: number): { name: string; ende: number } | null {
    if (pos >= n || !istNameStart(m[pos])) return null;
    let p = pos + 1;
    while (p < n && istNameZeichen(m[p])) p++;
    return { name: m.slice(pos, p), ende: p };
  }

  function passendeKlammer(pos: number): number {
    const auf = m[pos];
    const zu = auf === '(' ? ')' : auf === '[' ? ']' : '}';
    let tiefe = 0;
    for (let p = pos; p < n; p++) {
      const c = m[p];
      if (c === auf) tiefe++;
      else if (c === zu) { tiefe--; if (tiefe === 0) return p; }
    }
    return n;
  }

  /**
   * Ende eines Ausdrucks: Komma auf oberster Ebene, eine schliessende Klammer,
   * die die Ebene verlaesst, oder die uebergebene Grenze.
   *
   * SEMIKOLON IST IN JSONNET KEIN ANWEISUNGSENDE, sondern gehoert zu einem
   * vorangehenden local oder assert: "assert x > 0; wert" ist EIN Ausdruck.
   * Deshalb wird mitgezaehlt, wie viele solcher Verbraucher offen sind; erst ein
   * Semikolon ohne offenen Verbraucher beendet etwas — und auch das nur, wenn der
   * Aufrufer es zulaesst. Bei einem FELDWERT nie (semikolonBeendet=false): der
   * endet am Komma oder an der schliessenden Klammer des Objekts.
   *
   * WAS OHNE DIESE ZAEHLUNG PASSIERT: in std.jsonnet beginnt substr mit vier
   * assert-Zeilen. Der Feldwert galt am ersten Semikolon als beendet, der Rahmen
   * der Methode schloss sich mitten in ihr, und alle Aufrufe danach standen mit
   * caller_scope null statt substr im Index.
   */
  function ausdruckEnde(von: number, grenze: number, semikolonBeendet = true): number {
    let tiefe = 0;
    let verbraucher = 0;
    for (let p = von; p < grenze; p++) {
      const c = m[p];
      if (c === '(' || c === '[' || c === '{') { tiefe++; continue; }
      if (c === ')' || c === ']' || c === '}') { if (tiefe === 0) return p; tiefe--; continue; }
      if (tiefe !== 0) continue;
      if (c === ',') { if (verbraucher === 0) return p; continue; }
      if (c === ';') {
        if (verbraucher > 0) { verbraucher--; continue; }
        if (semikolonBeendet) return p;
        continue;
      }
      if (istNameStart(c)) {
        const w = leseName(p);
        if (w === null) continue;
        if (w.name === 'local' || w.name === 'assert') verbraucher++;
        p = w.ende - 1;
      }
    }
    return Math.min(grenze, n);
  }

  /** Ende einer local-Anweisung: Semikolon auf oberster Ebene bzw. Ende des Objekts. */
  function anweisungsEnde(von: number, grenze: number): number {
    let tiefe = 0;
    for (let p = von; p < grenze; p++) {
      const c = m[p];
      if (c === '(' || c === '[' || c === '{') tiefe++;
      else if (c === ')' || c === ']' || c === '}') { if (tiefe === 0) return p; tiefe--; }
      else if (c === ';' && tiefe === 0) return p;
    }
    return Math.min(grenze, n);
  }

  /** Sucht ein Schluesselwort auf oberster Ebene (fuer 'then' hinter einer Bedingung). */
  function findeWort(wort: string, von: number, grenze: number): number {
    let tiefe = 0;
    for (let p = von; p < grenze; p++) {
      const c = m[p];
      if (c === '(' || c === '[' || c === '{') { tiefe++; continue; }
      if (c === ')' || c === ']' || c === '}') { if (tiefe === 0) return -1; tiefe--; continue; }
      if (tiefe !== 0) continue;
      if (!istNameStart(c)) continue;
      const w = leseName(p);
      if (w === null) continue;
      if (w.name === wort) return p;
      p = w.ende - 1;
    }
    return -1;
  }

  /** Sichtbarkeit hinter einem Feldnamen: ein, zwei oder drei Doppelpunkte. */
  function feldDoppelpunkt(pos: number): { anzahl: number; ende: number } | null {
    let p = pos;
    if (m[p] === '+') p = nichtLeer(p + 1);   // Feld-Mischung mit Pluszeichen
    if (m[p] !== ':') return null;
    let anzahl = 0;
    while (m[p] === ':') { anzahl++; p++; }
    if (anzahl > 3) return null;
    return { anzahl, ende: p };
  }

  function inObjekt(): boolean {
    return klammern.length > 0 && klammern[klammern.length - 1] === '{';
  }

  /** Legt Symbol, Statement und Rahmen fuer ein Objektfeld an. */
  function feldAnlegen(
    nameStart: number,
    name: string,
    params: string[] | undefined,
    doppelpunkte: number,
    wertStart: number,
  ): void {
    const grenze = oben().ende;
    const wertEnde = ausdruckEnde(wertStart, grenze, false);
    const versteckt = doppelpunkte === 2;
    const lStart = zeile(nameStart);
    const lEnde = zeile(Math.max(nameStart, wertEnde - 1));

    if (params !== undefined) {
      symbols.push({
        symbol_type: 'function',
        name,
        params: params.length > 0 ? params : undefined,
        value: versteckt ? 'versteckte Methode' : 'Methode',
        line_start: lStart,
        line_end: lEnde,
        is_exported: !versteckt,
      });
    } else {
      symbols.push({
        symbol_type: 'variable',
        name,
        value: versteckt ? 'verstecktes Feld' : 'Feld',
        line_start: lStart,
        line_end: lEnde,
        is_exported: !versteckt,
      });
    }
    merkeDefinition(name);

    const st = emit(lStart, lEnde, 'assignment', {
      node_kind: params !== undefined ? 'ObjectMethod' : 'ObjectField',
      assigned_to: name,
      text: ausschnitt(nameStart, wertEnde),
    });
    if (params !== undefined) {
      pushRahmen(wertEnde, 'feld', st.temp_id, 'method', name);
    } else {
      pushRahmen(wertEnde, 'feld', st.temp_id);
    }
  }

  let erwarteBinding: number | undefined;
  /** Position, bis zu der ein assert-Ausdruck laeuft — dort gibt es keine Felder. */
  let assertBis = -1;
  let i = 0;

  while (i < n) {
    // Abgelaufene Rahmen schliessen. Endet ein local-Binding und folgt ein Komma,
    // geht dieselbe local-Anweisung mit dem naechsten Binding weiter.
    while (rahmen.length > 1 && i >= oben().ende) {
      const weg = rahmen.pop() as Rahmen;
      if (weg.art === 'bind' && weg.localGrenze !== undefined) {
        const p = nichtLeer(i);
        if (p < weg.localGrenze && m[p] === ',') erwarteBinding = weg.localGrenze;
      }
    }

    const c = m[i];
    if (c === undefined) break;

    // Feldname in Anfuehrungszeichen: die Zeichenkette ist maskiert, ihr Wert
    // steht in der Liste aus der Maskierung. DIESE PRUEFUNG MUSS VOR DEM
    // LEERRAUM-SPRUNG STEHEN — maskierter Text besteht an dieser Stelle aus
    // Leerzeichen, ein vorgezogenes i++ liefe an ihrem Anfang vorbei.
    const str = mask.beiPosition.get(i);
    if (str !== undefined) {
      const nach = nichtLeer(str.ende);
      const dp = inObjekt() ? feldDoppelpunkt(nach) : null;
      if (dp !== null && str.wert.length > 0 && !str.mehrzeilig) {
        feldAnlegen(i, str.wert, undefined, dp.anzahl, nichtLeer(dp.ende));
        i = nichtLeer(dp.ende);
        continue;
      }
      i = str.ende;
      continue;
    }

    if (/\s/.test(c)) { i++; continue; }

    if (c === '{' || c === '(') { klammern.push(c); i++; continue; }

    // Eckige Klammer im Objekt: entweder ein berechneter Feldname oder ein Index.
    if (c === '[') {
      if (inObjekt()) {
        const zu = passendeKlammer(i);
        const nach = nichtLeer(zu + 1);
        const dp = feldDoppelpunkt(nach);
        if (dp !== null) {
          const ausdruck = content.slice(i + 1, zu).replace(/\s+/g, ' ').trim();
          feldAnlegen(i, ausdruck.length > 0 ? ausdruck : '[berechnet]', undefined, dp.anzahl, nichtLeer(dp.ende));
          i = nichtLeer(dp.ende);
          continue;
        }
      }
      klammern.push(c);
      i++;
      continue;
    }

    if (c === '}' || c === ']' || c === ')') { klammern.pop(); i++; continue; }

    if (!istNameStart(c)) { i++; continue; }

    const w = leseName(i);
    if (w === null) { i++; continue; }
    const wort = w.name;
    const nachWort = nichtLeer(w.ende);

    // --- local-Binding ------------------------------------------------------
    if (erwarteBinding !== undefined) {
      const grenze = erwarteBinding;
      let p = nachWort;
      let params: string[] | undefined;
      if (m[p] === '(') {
        const zu = passendeKlammer(p);
        params = zerlegeParams(m.slice(p + 1, zu));
        p = nichtLeer(zu + 1);
      }
      // Nur ein echtes Gleichheitszeichen leitet ein Binding ein; == ist ein Vergleich.
      if (m[p] === '=' && m[p + 1] !== '=') {
        const wertStart = nichtLeer(p + 1);
        const wertEnde = ausdruckEnde(wertStart, grenze);
        const lStart = zeile(i);
        const lEnde = zeile(Math.max(i, wertEnde - 1));

        // local f = function(x) ... ist eine Funktion, keine Variable.
        let literalParams: string[] | undefined;
        const lit = leseName(wertStart);
        if (params === undefined && lit !== null && lit.name === 'function') {
          const kp = nichtLeer(lit.ende);
          if (m[kp] === '(') literalParams = zerlegeParams(m.slice(kp + 1, passendeKlammer(kp)));
        }
        const alsFunktion = params !== undefined || literalParams !== undefined;
        const effParams = params ?? literalParams;

        symbols.push({
          symbol_type: alsFunktion ? 'function' : 'variable',
          name: wort,
          params: effParams !== undefined && effParams.length > 0 ? effParams : undefined,
          value: alsFunktion ? 'lokale Funktion' : 'local',
          line_start: lStart,
          line_end: lEnde,
          is_exported: false,
        });
        merkeDefinition(wort);

        const st = emit(lStart, lEnde, 'assignment', {
          node_kind: alsFunktion ? 'LocalFunction' : 'LocalBind',
          assigned_to: wort,
          text: ausschnitt(i, wertEnde),
        });
        if (alsFunktion) pushRahmen(wertEnde, 'bind', st.temp_id, 'function', wort, grenze);
        else pushRahmen(wertEnde, 'bind', st.temp_id, undefined, undefined, grenze);

        erwarteBinding = undefined;
        i = wertStart;
        continue;
      }
      // Kein Binding — das Wort wird gleich normal behandelt.
      erwarteBinding = undefined;
    }

    if (wort === 'local') {
      erwarteBinding = anweisungsEnde(w.ende, oben().ende);
      i = w.ende;
      continue;
    }

    // --- if / then / else ---------------------------------------------------
    if (wort === 'if') {
      const grenze = oben().ende;
      const bedStart = nachWort;
      const thenPos = findeWort('then', bedStart, grenze);
      const bedEnde = thenPos >= 0 ? thenPos : ausdruckEnde(bedStart, grenze);
      const koerperEnde = ausdruckEnde(thenPos >= 0 ? thenPos + 4 : bedEnde, grenze);
      const st = emit(zeile(i), zeile(Math.max(i, koerperEnde - 1)), 'if', {
        node_kind: 'Conditional',
        condition_text: ausschnitt(bedStart, bedEnde),
        text: ausschnitt(i, koerperEnde),
      });
      pushRahmen(koerperEnde, 'ausdruck', st.temp_id);
      i = bedStart;
      continue;
    }

    // --- for-Comprehension --------------------------------------------------
    if (wort === 'for') {
      const grenze = oben().ende;
      const ende = ausdruckEnde(nachWort, grenze);
      const v = leseName(nachWort);
      const st = emit(zeile(i), zeile(Math.max(i, ende - 1)), 'for', {
        node_kind: 'Comprehension',
        condition_text: ausschnitt(nachWort, ende),
        assigned_to: v !== null ? v.name : undefined,
        text: ausschnitt(i, ende),
      });
      if (v !== null) merkeDefinition(v.name);
      pushRahmen(ende, 'ausdruck', st.temp_id);
      i = nachWort;
      continue;
    }

    // --- assert -------------------------------------------------------------
    if (wort === 'assert') {
      const grenze = oben().ende;
      const ende = ausdruckEnde(nachWort, grenze);
      // "assert BEDINGUNG : MELDUNG" — die Bedingung endet am Doppelpunkt.
      let bedEnde = ende;
      let bedTiefe = 0;
      for (let p = nachWort; p < ende; p++) {
        const z = m[p];
        if (z === '(' || z === '[' || z === '{') bedTiefe++;
        else if (z === ')' || z === ']' || z === '}') bedTiefe--;
        else if (z === ':' && bedTiefe === 0) { bedEnde = p; break; }
      }
      emit(zeile(i), zeile(Math.max(i, ende - 1)), 'assert', {
        node_kind: 'Assert',
        condition_text: ausschnitt(nachWort, bedEnde),
        text: ausschnitt(i, ende),
      });
      // Innerhalb der assert-Bedingung darf kein Objektfeld erkannt werden: der
      // Doppelpunkt in "assert x : meldung" trennt Bedingung und Meldung und ist
      // kein Feld-Doppelpunkt, obwohl wir mitten in einem Objekt stehen.
      assertBis = Math.max(assertBis, ende);
      i = nachWort;
      continue;
    }

    // --- error --------------------------------------------------------------
    if (wort === 'error') {
      const grenze = oben().ende;
      const ende = ausdruckEnde(nachWort, grenze);
      emit(zeile(i), zeile(Math.max(i, ende - 1)), 'throw', {
        node_kind: 'ErrorExpr',
        text: ausschnitt(i, ende),
      });
      i = nachWort;
      continue;
    }

    // --- import / importstr / importbin -------------------------------------
    if (wort === 'import' || wort === 'importstr' || wort === 'importbin') {
      const ziel = zeichenketteNach(w.ende);
      const pfad = ziel !== undefined ? ziel.wert : '';
      const ende = ziel !== undefined ? ziel.ende : w.ende;
      const l = zeile(i);
      symbols.push({
        symbol_type: 'import',
        name: pfad.length > 0 ? pfad : wort,
        value: pfad,
        line_start: l,
        line_end: l,
        is_exported: false,
      });
      emit(l, l, 'import', { node_kind: wort, text: ausschnitt(i, ende) });
      if (pfad.length > 0) {
        // Import-Pfade sind eindeutig und dateiuebergreifend nuetzlich — sie gehen
        // ohne Eindeutigkeitspruefung durch.
        references.push({ symbol_name: pfad, line_number: l, context: ausschnitt(i, ende).slice(0, 80) });
      }
      i = ende;
      continue;
    }

    // Uebrige Schluesselwoerter tragen keine eigene Bedeutung fuer den Index.
    if (wort === 'then' || wort === 'else' || wort === 'in' || wort === 'function'
      || wort === 'true' || wort === 'false' || wort === 'null' || wort === 'tailstrict') {
      i = w.ende;
      continue;
    }

    // --- Bezeichnerkette: Feld, Methode, Aufruf oder Verwendung -------------
    const kette: string[] = [wort];
    let ende = w.ende;
    for (;;) {
      const punkt = nichtLeer(ende);
      if (m[punkt] !== '.') break;
      const nw = leseName(nichtLeer(punkt + 1));
      if (nw === null) break;
      kette.push(nw.name);
      ende = nw.ende;
    }
    const nach = nichtLeer(ende);

    // Objektfeld oder Methode (nur direkt in einem Objekt, nie in einer Liste —
    // sonst wuerde die Schnitt-Syntax a[x:y] zu einem Feld namens x).
    if (kette.length === 1 && inObjekt() && i >= assertBis) {
      if (m[nach] === '(') {
        const zu = passendeKlammer(nach);
        const dp = feldDoppelpunkt(nichtLeer(zu + 1));
        if (dp !== null) {
          const params = zerlegeParams(m.slice(nach + 1, zu));
          feldAnlegen(i, wort, params, dp.anzahl, nichtLeer(dp.ende));
          i = nichtLeer(dp.ende);
          continue;
        }
      } else {
        const dp = feldDoppelpunkt(nach);
        if (dp !== null && !SCHLUESSELWOERTER.has(wort)) {
          feldAnlegen(i, wort, undefined, dp.anzahl, nichtLeer(dp.ende));
          i = nichtLeer(dp.ende);
          continue;
        }
      }
    }

    // Aufruf
    if (m[nach] === '(') {
      const zu = passendeKlammer(nach);
      const callee = kette[kette.length - 1];
      const receiver = kette.length > 1 ? kette.slice(0, -1).join('.') : undefined;
      const l = zeile(i);
      const st = emit(l, zeile(Math.max(i, zu)), 'call', {
        node_kind: 'Apply',
        callee,
        receiver,
        text: ausschnitt(i, zu + 1),
      });
      callEdges.push({
        statement_temp_id: st.temp_id,
        caller_scope: oben().scopeName,
        callee_name: callee,
        callee_receiver: receiver,
        line_number: l,
        call_kind: receiver !== undefined ? 'method' : 'function',
        confidence: 1.0,
      });
      referenzKandidaten.push({ symbol_name: callee, line_number: l, context: ausschnitt(i, zu + 1).slice(0, 80) });
      // Auf die Klammer setzen, NICHT dahinter: sie muss durch die normale
      // Behandlung auf den Klammer-Stack. Sonst poppt ihre schliessende Klammer
      // die Objekt-Klammer, und alle folgenden Felder gelten als nicht im Objekt.
      i = nach;
      continue;
    }

    // Blosse Verwendung — am Ende gegen die in dieser Datei definierten Namen gefiltert.
    if (!SCHLUESSELWOERTER.has(wort)) namensVerwendungen.push({ name: kette[0], pos: i });
    i = ende;
  }

  for (const v of namensVerwendungen) {
    if (!definierteNamen.has(v.name)) continue;
    const l = zeile(v.pos);
    referenzKandidaten.push({ symbol_name: v.name, line_number: l, context: ausschnitt(v.pos, v.pos + 80) });
  }

  // EINDEUTIGKEIT ENTSCHEIDET. Beim Persistieren wird eine Referenz ueber den
  // Namen gegen alle gleichnamigen Symbole aufgeloest. Ist ein Name in dieser
  // Datei mehrfach definiert — in jsonnet heissen Comprehension-Variablen
  // durchweg i, v, x und Hilfsfunktionen aux —, entstuende je Verwendung ein
  // Eintrag PRO Definition. In std.jsonnet ist 'i' zwanzigmal definiert; eine
  // Verwendung wurde dort zu 20 Zeilen, und references() lieferte nur noch
  // Rauschen. Welche der zwanzig gemeint ist, entscheidet der Scope — den kann
  // dieser Parser nicht aufloesen, also wird nicht geraten.
  for (const r of referenzKandidaten) {
    if ((definierteNamen.get(r.symbol_name) ?? 0) > 1) continue;
    references.push(r);
  }

  return { symbols, statements, callEdges, references };
}

class JsonnetParser implements LanguageParser {
  language = 'jsonnet';
  extensions = ['.jsonnet', '.libsonnet'];
  /** Bei inhaltlichen Parser-Aenderungen erhoehen (siehe LanguageParser.version). */
  // 2: Zeilenberechnung ueber Index statt Praefix-Kopie (siehe lineAt).
  // 3: Kommentare (Zeile, Raute, Block) als Symbole mit line_end, zusammenhaengende
  //    Zeilenkommentare gebuendelt; Maskierung von Kommentaren und Zeichenketten vor
  //    allen Struktur-Regeln (vorher wurde die Lizenz-URL im Dateikopf als Objektfeld
  //    'http' gefuehrt); Ablauf-Ebene mit Statements und Call-Kanten (vorher konstant
  //    leer); Sichtbarkeit mit zwei Doppelpunkten gilt als nicht exportiert; line_end
  //    fuer Bindings, Felder und Kommentare; Felder auch ausserhalb des Zeilenanfangs
  //    und mit Namen in Anfuehrungszeichen oder berechnet; local-Ketten mit Komma;
  //    Zeichenketten aus der Maskierung statt aus einer Regex ueber den Rohtext.
  // 4: Semikolon beendet in jsonnet nur ein vorangehendes local oder assert, nicht
  //    den umgebenden Ausdruck — ein Feldwert endet am Komma oder an der
  //    schliessenden Klammer. Vorher schloss sich der Rahmen einer Methode schon
  //    in ihrer ersten assert-Zeile (std.jsonnet: substr), wodurch scope_name und
  //    caller_scope aller folgenden Statements auf null fielen. Ausserdem wird in
  //    einer assert-Bedingung kein Objektfeld mehr erkannt.
  // 5: keine Referenz mehr fuer Namen, die in derselben Datei mehrfach definiert
  //    sind. Die Persistenz loest Referenzen ueber den NAMEN auf; bei 'i' mit
  //    zwanzig Definitionen in std.jsonnet wurde aus einer Verwendung zwanzig
  //    Eintraege (25.612 statt 6.925 ueber das ganze Repo). Import-Pfade bleiben
  //    ausgenommen, sie sind eindeutig.
  // 6: depth ist scope-relativ statt absolut. getExecutionFlow filtert auf
  //    "scope_name = X AND depth = 0" — mit durchgezaehlter Tiefe lieferte
  //    code_intel(flow) fuer jede Funktion leer.
  // 7: condition_text eines assert endet am Doppelpunkt; die Fehlermeldung
  //    dahinter gehoert nicht in die Bedingung.
  version = 7;

  parse(content: string, _filePath: string): ParseResult {
    const mask = maskiere(content);
    const { symbols, statements, callEdges, references } = analysiere(content, mask);

    // Kommentare: Bloecke als EIN Symbol, aufeinanderfolgende Zeilenkommentare
    // gebuendelt. Ein Kommentar hinter Code bleibt eigenstaendig.
    const ks = mask.kommentare;
    let i = 0;
    while (i < ks.length) {
      const k = ks[i];
      const text = kommentarRumpf(k);
      if (k.art === 'block' || !k.alleine) {
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

    // TODO/FIXME/HACK aus den Kommentaren — nicht mehr aus dem Rohtext, sonst
    // zaehlt eine Zeichenkette mit dem Wort TODO als Aufgabe.
    for (const k of mask.kommentare) {
      const treffer = /\b(TODO|FIXME|HACK)\b:?(.*)/i.exec(k.roh);
      if (treffer === null) continue;
      const l = lineAt(content, k.start + treffer.index);
      symbols.push({
        symbol_type: 'todo',
        name: null,
        value: k.roh.slice(treffer.index).trim(),
        line_start: l,
        line_end: l,
        is_exported: false,
      });
    }

    // Zeichenketten: dieselbe Auswahl wie extractStringLiterals (2 bis 64 Zeichen,
    // kein Leerraum), aber aus der Maskierung — dadurch keine Treffer mehr aus
    // Kommentaren und keine zerschnittenen Textbloecke.
    const gesehen = new Set<string>();
    for (const s of mask.zeichenketten) {
      if (s.mehrzeilig) continue;
      const wert = s.wert;
      if (wert.length < 2 || wert.length > 64 || /\s/.test(wert)) continue;
      const l = lineAt(content, s.start);
      const schluessel = wert + '@' + String(l);
      if (gesehen.has(schluessel)) continue;
      gesehen.add(schluessel);
      symbols.push({
        symbol_type: 'string',
        name: wert,
        value: wert,
        line_start: l,
        line_end: l,
        is_exported: false,
      });
    }

    return { symbols, references, statements, callEdges };
  }
}

export const jsonnetParser = new JsonnetParser();
