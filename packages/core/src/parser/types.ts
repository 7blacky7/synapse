/**
 * MODUL: Parser Types
 * ZWECK: Sprachunabhaengige Interfaces fuer Code-Parser
 */

export interface ParsedSymbol {
  symbol_type:
    | 'function' | 'variable' | 'string' | 'comment'
    | 'import' | 'export' | 'class' | 'interface'
    | 'enum' | 'const_object' | 'todo'
    // SQL-spezifische Typen
    | 'table' | 'column' | 'index' | 'view' | 'trigger' | 'constraint'
    // Erweiterbar fuer weitere Sprachen
    | string;
  name: string | null;
  value?: string;
  line_start: number;
  line_end?: number;
  parent_id?: string;
  params?: string[];
  return_type?: string;
  is_exported: boolean;
}

export interface ParsedReference {
  /** Name des referenzierten Symbols */
  symbol_name: string;
  /** Zeile der Referenz */
  line_number: number;
  /** Kontext (umgebender Code, ~80 Zeichen) */
  context?: string;
}

/**
 * Ein einzelnes Statement der Ablauf-Ebene (Execution-Flow).
 * Wird von Parsern OPTIONAL geliefert — bestehende Parser ohne Flow-Support
 * lassen ParseResult.statements einfach undefined.
 *
 * parent_id ist eine TEMPORAERE, parser-lokale ID (z.B. lfd. Nummer als String),
 * die beim Persistieren in echte DB-IDs (BIGINT) aufgeloest wird. Top-Level-
 * bzw. Wurzel-Statements haben parent_id = undefined.
 */
export interface ParsedStatement {
  /** Temporaere, parser-lokale ID (eindeutig je ParseResult) zur parent-Verknuepfung */
  temp_id: string;
  /** Temporaere ID des Eltern-Statements; undefined = Wurzel/Top-Level */
  parent_temp_id?: string;
  /** Scope-Art des umschliessenden Kontextes: 'module' | 'function' | 'method' | 'class' | ... */
  scope_type?: string;
  /** Name des umschliessenden Scopes (z.B. Funktionsname); null im Modul-Scope */
  scope_name?: string | null;
  /** Logischer Statement-Typ: 'if'|'for'|'while'|'do'|'switch'|'try'|'throw'|'return'|'await'|'new'|'call'|'assignment'|... */
  statement_type: string;
  /** Roher AST-Node-Kind (z.B. 'IfStatement', 'CallExpression') */
  node_kind?: string;
  line_start: number;
  line_end?: number;
  /** Reihenfolge innerhalb des Scopes (0-basiert) */
  order_index: number;
  /** Verschachtelungstiefe (0 = direkt im Scope) */
  depth: number;
  /** Gekuerzter Quelltext des Statements */
  text?: string;
  /** Bei calls: aufgerufener Name */
  callee?: string;
  /** Bei method-calls: Receiver-Ausdruck (z.B. 'pool') */
  receiver?: string;
  /** Bei assignments: Ziel-Variable */
  assigned_to?: string;
  /** Bei if/while/for/switch: Bedingungstext */
  condition_text?: string;
  /** true wenn Statement direkt im Modul-/Top-Level-Scope liegt */
  is_top_level: boolean;
  /** true wenn das Statement (oder sein Ausdruck) awaited wird */
  is_awaited: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Eine Aufruf-Kante (Call-Edge) der Ablauf-Ebene. OPTIONAL von Parsern geliefert.
 * Verknuepft ein Statement (ueber dessen temporaere ID) mit dem aufgerufenen Namen.
 */
export interface ParsedCallEdge {
  /** Temporaere ID des zugehoerigen Statements (siehe ParsedStatement.temp_id); optional */
  statement_temp_id?: string;
  /** Umschliessender Scope-Name des Aufrufs */
  caller_scope?: string | null;
  /** Aufgerufener Funktions-/Methodenname */
  callee_name: string;
  /** Receiver-Ausdruck bei method-calls (z.B. 'pool') */
  callee_receiver?: string;
  line_number: number;
  /** Art des Aufrufs: 'function' | 'method' | 'new' | 'await' */
  call_kind?: string;
  /** Konfidenz der Aufloesung (0..1), Standard 1.0 */
  confidence?: number;
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  references: ParsedReference[];
  /** OPTIONAL: Ablauf-Ebene — geordnete Statements je Scope. Abwaertskompatibel. */
  statements?: ParsedStatement[];
  /** OPTIONAL: Aufruf-Kanten der Ablauf-Ebene. Abwaertskompatibel. */
  callEdges?: ParsedCallEdge[];
}

export interface LanguageParser {
  language: string;
  extensions: string[];
  /**
   * Version dieses Parsers. Fehlt sie, gilt 1.
   *
   * WOFUER: In code_files steht je Datei, mit welcher Parser-Version sie zuletzt
   * geparst wurde. Liegt der gespeicherte Wert unter dieser Konstante, zieht der
   * Backlog die Datei selbsttaetig nach. Ohne das behaelt eine Datei ihre alten
   * Symbole fuer immer — die Datei auf der Platte aendert sich ja nicht, wenn der
   * PARSER besser wird, also meldet der Watcher nichts. Genau daran standen 33
   * Dateien monatelang leer im Index (INDEX-2).
   *
   * WANN ERHOEHEN: bei jeder INHALTLICHEN Aenderung am Parser, die andere oder
   * mehr Symbole, Statements oder Call-Kanten liefert. NICHT bei Formatierung,
   * Kommentaren oder Umbenennungen.
   *
   * BEWUSST NICHT AUTOMATISCH: die Version wird nicht aus einem Hash der Datei
   * abgeleitet, sonst loest jede Formatierung einen Vollreparse dieser Sprache
   * aus. Der Preis dafuer ist, dass man sie von Hand erhoehen muss — wer das
   * vergisst, bekommt keinen Fehler, sondern einen Mechanismus, der aussieht als
   * liefe er. Deshalb steht dieser Hinweis auch in den Parser-Modulen selbst.
   */
  version?: number;
  /**
   * Kennt diese Sprache ueberhaupt eine Ablauf-Ebene (Anweisungen, Aufrufe)?
   * Fehlt die Angabe, gilt true.
   *
   * WOFUER: health kann damit "Parser liefert null Statements" von "Sprache hat
   * konstruktiv keine" unterscheiden. Ohne die Angabe war beides gleich und der
   * Fall musste ungemeldet bleiben — ein kaputter Parser sah aus wie yaml.
   * Belegt an drei Faellen: scala lieferte 363 Statements auf 580.621 Zeilen,
   * jsonnet und dhall exakt null bei 343 bzw. 379 gefundenen Funktionen.
   *
   * FALSE SETZEN nur bei Daten- und Auszeichnungsformaten, die wirklich keine
   * Anweisungen kennen (yaml, toml, css, markdown, make, cmake, dockerfile,
   * starlark, nix). Im ZWEIFEL weglassen: dann meldet health lieber einmal zu
   * viel, als einen Totalausfall zu verschweigen.
   *
   * NICHT VERWECHSELN mit "liefert gerade keine": genau das soll ja auffallen.
   */
  hatAblaufEbene?: boolean;
  parse(content: string, filePath: string): ParseResult;
}

/**
 * Positionen aller Zeilenumbrueche einer Datei — Grundlage fuer zeileFuerPosition.
 */
export function erstelleZeilenIndex(content: string): number[] {
  const umbrueche: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) umbrueche.push(i);
  }
  return umbrueche;
}

/**
 * 1-basierte Zeilennummer zu einer Zeichenposition, per Binaersuche im Index.
 *
 * WARUM DAS WICHTIG IST: Hier stand frueher pro Treffer eine Schleife, die ab
 * Position 0 alle Zeilenumbrueche neu zaehlte. Das ist O(Treffer x Dateigroesse).
 * Bei einer 7-MB-HTML mit rund 700.000 Wort-Treffern sind das ~2,5 Billionen
 * Zeichenvergleiche — der Parse lief ueber 45 Minuten und war nie fertig, obwohl
 * derselbe Parser 1,3 MB in 3 ms schafft. Die Regex-Muster waren nie das Problem;
 * einzeln gemessen sind sie alle unauffaellig.
 */
export function zeileFuerPosition(umbrueche: number[], pos: number): number {
  let lo = 0;
  let hi = umbrueche.length;
  while (lo < hi) {
    const mitte = (lo + hi) >> 1;
    if (umbrueche[mitte] < pos) lo = mitte + 1;
    else hi = mitte;
  }
  return lo + 1;
}

/**
 * Parst einen eingebetteten Sprachblock (z.B. <script> oder <style> in HTML) mit
 * einem anderen Parser und rechnet dessen Zeilennummern auf die Wirtsdatei um.
 *
 * WARUM DAS NOETIG IST: der eingebettete Parser sieht nur den Block und zaehlt
 * dessen Zeilen ab 1. Ohne Umrechnung zeigen alle Symbole eines <script>-Blocks,
 * der bei Zeile 64.000 beginnt, auf die ersten Hundert Zeilen der Datei — also
 * auf fremdes Markup. Die Rechnung: die erste Zeile des Blocks liegt auf jener
 * Zeile der Wirtsdatei, in der blockStartPos steht; alles Weitere ist eine
 * Verschiebung um diesen Betrag minus eins, weil beide Zaehlungen 1-basiert sind.
 *
 * TEMP-ID-PRAEFIX: Statement-IDs sind nur innerhalb EINES Parse-Laufs eindeutig.
 * Enthaelt eine Datei mehrere Bloecke, vergeben diese dieselben IDs, und die
 * parent-Verknuepfung zeigt beim Persistieren auf den falschen Block. Wer mehrere
 * Bloecke parst, MUSS je Block einen eigenen Praefix setzen.
 *
 * @param gesamtInhalt   Inhalt der Wirtsdatei (fuer die Zeilenberechnung)
 * @param blockInhalt    Inhalt des eingebetteten Blocks
 * @param blockStartPos  Zeichenposition des Block-INHALTS in der Wirtsdatei
 * @param parser         Zielparser (z.B. typescriptParser, cssParser)
 * @param virtuellerPfad Pfad, den der Zielparser sieht — seine Endung entscheidet
 *                       ueber den Dialekt (z.B. .scss gegenueber .css)
 */
export function parseEingebettet(
  gesamtInhalt: string,
  blockInhalt: string,
  blockStartPos: number,
  parser: LanguageParser,
  virtuellerPfad: string,
  opts: { zeilenIndex?: number[]; tempIdPraefix?: string } = {},
): ParseResult {
  const leer: ParseResult = { symbols: [], references: [], statements: [], callEdges: [] };
  if (blockInhalt.trim().length === 0) return leer;

  const index = opts.zeilenIndex ?? erstelleZeilenIndex(gesamtInhalt);
  const versatz = zeileFuerPosition(index, blockStartPos) - 1;
  const praefix = opts.tempIdPraefix ?? '';

  let teil: ParseResult;
  try {
    teil = parser.parse(blockInhalt, virtuellerPfad);
  } catch {
    // Ein kaputter eingebetteter Block darf den Parse der Wirtsdatei nicht kippen:
    // sonst verliert eine 100.000-Zeilen-Datei wegen eines Tippfehlers in einem
    // einzigen <script>-Tag ihren gesamten Index.
    return leer;
  }

  const verschoben = (n: number | undefined): number | undefined =>
    typeof n === 'number' ? n + versatz : undefined;

  return {
    symbols: teil.symbols.map(s => ({
      ...s,
      line_start: s.line_start + versatz,
      line_end: verschoben(s.line_end),
    })),
    references: teil.references.map(r => ({ ...r, line_number: r.line_number + versatz })),
    statements: (teil.statements ?? []).map(s => ({
      ...s,
      temp_id: praefix + s.temp_id,
      parent_temp_id: s.parent_temp_id === undefined ? undefined : praefix + s.parent_temp_id,
      line_start: s.line_start + versatz,
      line_end: verschoben(s.line_end),
    })),
    callEdges: (teil.callEdges ?? []).map(c => ({
      ...c,
      statement_temp_id:
        c.statement_temp_id === undefined ? undefined : praefix + c.statement_temp_id,
      line_number: c.line_number + versatz,
    })),
  };
}

/**
 * Extrahiert String-Literale aus Source-Code als ParsedSymbols (symbol_type='string').
 * Erfasst "identifier-like" Strings (2-64 Zeichen, keine Whitespaces) damit sie via
 * code_intel.references auffindbar sind (z.B. Dict-Keys, Match-Arms, lokalisierte Keywords).
 *
 * @param content  Datei-Inhalt
 * @param opts.includeSingleQuotes  Wenn true, werden auch 'foo' Strings erfasst (nur Sprachen
 *                                   wo einfache Quotes String-Literale sind, NICHT char-literals).
 * @param opts.includeBackticks     Wenn true, werden auch `foo` Template-Strings erfasst.
 */
export function extractStringLiterals(
  content: string,
  opts: { includeSingleQuotes?: boolean; includeBackticks?: boolean } = {}
): ParsedSymbol[] {
  const patterns: string[] = ['"([^"\\\\\\n]{2,64})"'];
  if (opts.includeSingleQuotes) patterns.push("'([^'\\\\\\n]{2,64})'");
  if (opts.includeBackticks) patterns.push('`([^`\\\\\\n]{2,64})`');
  const re = new RegExp(patterns.join('|'), 'g');

  const out: ParsedSymbol[] = [];
  const seen = new Set<string>();
  const zeilenIndex = erstelleZeilenIndex(content);
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const lit = m[1] ?? m[2] ?? m[3];
    if (!lit || /\s/.test(lit)) continue;
    const line = zeileFuerPosition(zeilenIndex, m.index);
    const dedup = `${lit}@${line}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({
      symbol_type: 'string',
      name: lit,
      value: lit,
      line_start: line,
      is_exported: false,
    });
  }
  return out;
}
