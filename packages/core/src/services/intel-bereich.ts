/**
 * P18-T12/RV2: feste interne Lesebereiche. Keine Tool-Parameter, keine freien
 * Tabellennamen. Projekt-SQL bleibt unverändert; Reverse nutzt dieselbe Engine.
 */
import type { QueryResult, QueryResultRow } from 'pg';
import { getPool } from '../db/client.js';

export const PROJEKT_BEREICH = Object.freeze({
  dateien: 'code_files', symbole: 'code_symbols', verweise: 'code_references',
  kanten: 'code_call_edges', statements: 'code_statements', scope_spalte: 'project',
} as const);
export const REVERSE_BEREICH = Object.freeze({
  dateien: 'reverse_code_dateien', symbole: 'reverse_code_symbole', verweise: 'reverse_code_verweise',
  kanten: 'reverse_code_kanten', statements: 'reverse_code_statements', scope_spalte: 'eintrag_id',
} as const);
export type CodeBereich = typeof PROJEKT_BEREICH | typeof REVERSE_BEREICH;

export const ASSET_BEREICH = Object.freeze({
  dateien: 'asset_files', objekte: 'asset_objects', verweise: 'asset_references', scope_spalte: 'project',
} as const);
export const REVERSE_ASSET_BEREICH = Object.freeze({
  dateien: 'reverse_dateien', objekte: 'reverse_objekte', verweise: 'reverse_verweise', scope_spalte: 'eintrag_id',
} as const);
export type AssetBereich = typeof ASSET_BEREICH | typeof REVERSE_ASSET_BEREICH;

export function pruefeCodeBereich(bereich: CodeBereich): void {
  if (bereich !== PROJEKT_BEREICH && bereich !== REVERSE_BEREICH) {
    throw new TypeError('Code-Bereich muss eine der festen Bereich-Konstanten sein.');
  }
}
export function pruefeAssetBereich(bereich: AssetBereich): void {
  if (bereich !== ASSET_BEREICH && bereich !== REVERSE_ASSET_BEREICH) {
    throw new TypeError('Asset-Bereich muss eine der festen Bereich-Konstanten sein.');
  }
}

/**
 * Ersetzt ausschließlich unquotierte SQL-Bezeichner aus festem internem SQL.
 * Werte/Filter bleiben gebundene Parameter. Literale, Kommentare und quotierte
 * Bezeichner bleiben bytegleich (auch JSON-Schlüssel oder das Wort project).
 */
function bezeichnerSql(sql: string, namen: Readonly<Record<string, string>>): string {
  return sql.replace(/'(?:''|\\.|[^'])*'|"(?:""|[^"])*"|--[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9]*/g,
    wort => namen[wort] ?? wort);
}

export function codeBereichSql(sql: string, bereich: CodeBereich = PROJEKT_BEREICH): string {
  pruefeCodeBereich(bereich);
  if (bereich === PROJEKT_BEREICH) return sql;
  return bezeichnerSql(sql, {
    code_files: bereich.dateien, code_symbols: bereich.symbole,
    code_references: bereich.verweise, code_call_edges: bereich.kanten,
    code_statements: bereich.statements, project: bereich.scope_spalte,
  });
}

/** Typisierte Lesegrenze: auch Alias-/Suffix-Helfer benutzen denselben Bereich. */
export function codeBereichLeser(bereich: CodeBereich = PROJEKT_BEREICH) {
  pruefeCodeBereich(bereich);
  const pool = getPool();
  return {
    // pg.query verwendet bisher ebenfalls any als Standard-Zeilentyp.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query<R extends QueryResultRow = any>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
      return pool.query<R>(codeBereichSql(sql, bereich), params);
    },
  };
}

/**
 * Reverse-Dateien sind keine asset_files: pfad/groesse/metadaten sind die
 * fachlichen Spalten. Optionale Inspektionswerte stammen aus metadaten; später
 * ergänzte eigene Spalten haben Vorrang. Die Projektausgabe bleibt unberührt.
 * Die Objekte/Verweise besitzen datei_id statt asset_id.
 */
const REVERSE_DATEI_SICHT = `(SELECT
  d.id, d.eintrag_id, d.pfad AS file_path,
  COALESCE(to_jsonb(d)->>'file_name', regexp_replace(d.pfad, '^.*/', '')) AS file_name,
  COALESCE(to_jsonb(d)->>'extension', substring(d.pfad from '\\.([^./]+)$')) AS extension,
  COALESCE(to_jsonb(d)->>'asset_type', d.metadaten->>'asset_type', 'unbekannt') AS asset_type,
  d.format, d.status, d.groesse AS file_size, d.sha256, d.metadaten AS metadata,
  COALESCE(to_jsonb(d)->>'inspector', d.metadaten->>'inspector') AS inspector,
  COALESCE((to_jsonb(d)->>'parser_version')::int,
    CASE WHEN jsonb_typeof(d.metadaten->'parser_version') = 'number'
      THEN (d.metadaten->>'parser_version')::numeric::int ELSE 0 END) AS parser_version,
  (to_jsonb(d)->>'mtime')::timestamptz AS mtime,
  COALESCE(to_jsonb(d)->'format_specific', d.metadaten->'format_specific', '{}'::jsonb) AS format_specific,
  COALESCE(to_jsonb(d)->'warnings', d.metadaten->'warnings', '[]'::jsonb) AS warnings,
  (SELECT count(*)::int FROM reverse_objekte o WHERE o.datei_id = d.id) AS n_objects,
  (SELECT count(*)::int FROM reverse_verweise r WHERE r.datei_id = d.id) AS n_references,
  COALESCE((to_jsonb(d)->>'objekte_gekappt')::boolean, false) AS objekte_gekappt,
  (to_jsonb(d)->>'extracted_at')::timestamptz AS extracted_at,
  (to_jsonb(d)->>'quelle_fehlt_seit')::timestamptz AS quelle_fehlt_seit,
  COALESCE(to_jsonb(d)->>'inspiziert_von', d.metadaten->>'inspiziert_von') AS inspiziert_von,
  (to_jsonb(d)->>'updated_at')::timestamptz AS updated_at
  FROM reverse_dateien d)`;

export function assetBereichSql(sql: string, bereich: AssetBereich = ASSET_BEREICH): string {
  pruefeAssetBereich(bereich);
  if (bereich === ASSET_BEREICH) return sql;
  return bezeichnerSql(sql, {
    asset_files: REVERSE_DATEI_SICHT,
    asset_objects: '(SELECT o.*, o.datei_id AS asset_id FROM reverse_objekte o)',
    asset_references: '(SELECT r.*, r.datei_id AS asset_id FROM reverse_verweise r)',
    project: bereich.scope_spalte,
  });
}
