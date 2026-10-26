/** P22-T183: Spiegel 164_api_agent_lauf.sql. Additiv/idempotent; nach model_registry, agent_identitaeten und 120 ausfuehren. */
export const API_AGENT_LAUF_SCHEMA_SQL = `
-- P22-T183 / 164. API-Agenten laufen direkt IM synapse-api-Prozess (User 26.10.2026, Memory entscheidung-api-agenten-im-synapse-api-container):
-- kein Runtime-Container, kein Wrapper. Lauf-Verwaltung: rest-api services/api-agent-lauf.ts (Schalter api_agenten_lauf_intern, Standard AUS).
-- Additiv und idempotent: nur CREATE ... IF NOT EXISTS bzw. INSERT ... ON CONFLICT DO NOTHING, nichts wird gedroppt.
CREATE TABLE IF NOT EXISTS api_agent_laeufe (
  identity_id TEXT PRIMARY KEY REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  rolle TEXT NOT NULL,
  modell TEXT NOT NULL,
  anbieter TEXT NOT NULL CHECK (anbieter IN ('anthropic-api','openrouter-api')),
  status TEXT NOT NULL DEFAULT 'bereit' CHECK (status IN ('bereit','laeuft','pausiert','gestoppt','fehler')),
  sitzung UUID NOT NULL,
  system_prompt TEXT,
  lease_token UUID,
  lease_bis TIMESTAMPTZ,
  turns INTEGER NOT NULL DEFAULT 0,
  kontext_tokens INTEGER,
  kontext_fenster INTEGER,
  kontext_anteil NUMERIC(6,4),
  neustarts INTEGER NOT NULL DEFAULT 0,
  letzter_fehler TEXT,
  letzte_aktivitaet TIMESTAMPTZ,
  gestartet_von TEXT NOT NULL,
  gestartet_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_agent_laeufe_status ON api_agent_laeufe (status);
CREATE TABLE IF NOT EXISTS api_agent_verlauf (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  sitzung UUID NOT NULL,
  nr INTEGER NOT NULL,
  art TEXT NOT NULL CHECK (art IN ('nachricht','aufruf')),
  inhalt JSONB NOT NULL,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (identity_id, sitzung, nr)
);
CREATE TABLE IF NOT EXISTS api_agent_eingang (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  quelle TEXT NOT NULL CHECK (quelle IN ('auftrag','chat','inbox','job_ende','heartbeat','neustart','main_chat')),
  absender TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  faellig_ab TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id BIGINT,
  erledigt_am TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_agent_eingang_offen ON api_agent_eingang (identity_id, faellig_ab) WHERE erledigt_am IS NULL;
CREATE TABLE IF NOT EXISTS api_agent_turns (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  sitzung UUID NOT NULL,
  modell TEXT NOT NULL,
  gestartet_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  beendet_am TIMESTAMPTZ,
  ende TEXT,
  meldung TEXT,
  runden INTEGER NOT NULL DEFAULT 0,
  kosten_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  kontext_tokens INTEGER,
  antwort TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_agent_turns_identity ON api_agent_turns (identity_id, gestartet_am DESC);
CREATE TABLE IF NOT EXISTS api_agent_lauf_einstellungen (
  name TEXT PRIMARY KEY CHECK (name IN ('api_laeufe_max','buendel_sekunden','neustart_schwelle_prozent','lease_sekunden')),
  wert NUMERIC(18,6) NOT NULL CHECK (wert > 0),
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS api_modell_preisstand (
  alias TEXT PRIMARY KEY,
  quelle TEXT NOT NULL,
  eingabe_usd_mtok NUMERIC(12,6),
  ausgabe_usd_mtok NUMERIC(12,6),
  context_window INTEGER,
  stand TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO model_registry
  (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max, pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit)
VALUES
  ('or-deepseek-chat', 'deepseek/deepseek-chat', 'openrouter-api', 128000, ARRAY[]::TEXT[], 'node', '@synapse/agents/api-worker', 73, 88, NULL, NULL, NULL, NULL, NULL),
  ('or-deepseek-r1',   'deepseek/deepseek-r1',   'openrouter-api', 128000, ARRAY[]::TEXT[], 'node', '@synapse/agents/api-worker', 73, 88, NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (alias) DO NOTHING;
`;
