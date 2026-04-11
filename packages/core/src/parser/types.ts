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

export interface ParseResult {
  symbols: ParsedSymbol[];
  references: ParsedReference[];
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
