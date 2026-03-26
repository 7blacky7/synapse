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
