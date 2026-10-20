/** P22-T8: Spiegel 120_agent_api_budget.sql. Additiv/idempotent; nach 111 (agent_identitaeten) ausfuehren. */
export const AGENT_API_BUDGET_SCHEMA_SQL = `
-- P22-T8 / 120. Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt oder umgeschrieben.
-- Kostenpflichtiger API-Agent (Claude per API-Key). Lesestelle und Regeln: services/api-agent-dienst.ts.
-- api_agent_budget: GENAU EINE globale Zeile (id = 1). Fehlt sie, gibt es KEINE kostenpflichtigen Aufrufe.
CREATE TABLE IF NOT EXISTS api_agent_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  grenze_usd NUMERIC(18,6) NOT NULL CHECK (grenze_usd > 0),
  zeitraum TEXT NOT NULL DEFAULT 'monat' CHECK (zeitraum IN ('tag','woche','monat')),
  reset_tag INTEGER NOT NULL DEFAULT 1 CHECK (reset_tag BETWEEN 1 AND 28),
  erlaubte_modelle TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- api_agent_einstellungen: Einstellwerte; fehlt eine Zeile, gilt der Code-Standard.
CREATE TABLE IF NOT EXISTS api_agent_einstellungen (
  name TEXT PRIMARY KEY CHECK (name IN ('max_tokens_obergrenze','reservierung_minuten','toolrunden_max','laufzeit_minuten','cache_schreib_faktor')),
  wert NUMERIC(18,6) NOT NULL CHECK (wert > 0),
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- api_agent_reservierungen: atomare Reservierung vor jedem Anbieter-Aufruf, Abschluss mit echten Kosten.
CREATE TABLE IF NOT EXISTS api_agent_reservierungen (
  id UUID PRIMARY KEY,
  identity_id TEXT REFERENCES agent_identitaeten(id),
  project TEXT,
  modell TEXT NOT NULL,
  anbieter_modell TEXT NOT NULL,
  reserviert_usd NUMERIC(18,8) NOT NULL CHECK (reserviert_usd >= 0),
  status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','gebucht','freigegeben','verfallen')),
  usd NUMERIC(18,8),
  usd_quelle TEXT CHECK (usd_quelle IS NULL OR usd_quelle IN ('antwort','reservierung','keine')),
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_creation_tokens BIGINT,
  stop_reason TEXT,
  fehler TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  frist_bis TIMESTAMPTZ NOT NULL,
  abgeschlossen_am TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_agent_reservierungen_zeit ON api_agent_reservierungen(erstellt_am);
CREATE INDEX IF NOT EXISTS idx_api_agent_reservierungen_offen ON api_agent_reservierungen(frist_bis) WHERE status = 'offen';
CREATE INDEX IF NOT EXISTS idx_api_agent_reservierungen_identity ON api_agent_reservierungen(identity_id, erstellt_am);
`;
