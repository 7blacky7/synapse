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
  parse(content: string, filePath: string): ParseResult;
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
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const lit = m[1] ?? m[2] ?? m[3];
    if (!lit || /\s/.test(lit)) continue;
    // Zeile berechnen
    let line = 1;
    for (let i = 0; i < m.index; i++) if (content.charCodeAt(i) === 10) line++;
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
