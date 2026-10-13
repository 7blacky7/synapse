/** Kompatibler Modulpfad; Regeln und Implementierung liegen zentral im Masken-Katalog (P18-T11). */
export {
  MCP_JSON_PFAD_REGEX_SQL,
  MCP_JSON_FELD_PREFIX,
  MCP_JSON_FELD_WERT,
  SHELL_LITERAL_MIN_LAENGE,
  istShellGeheimnisName,
  istShellJsonGeheimnisName,
  URL_ZUGANGSDATEN,
  istMcpJsonDatei,
  maskiereUrl,
  shellUrlPasswoerter,
  maskiereMcpJson,
  mcpJsonSicht,
  entmaskiereMcpJson,
  mcpJsonWerte,
  mcpJsonHinweise,
  maskiereMcpJsonDiffText,
  maskiereMcpJsonFragment
} from './masken-katalog.js';
