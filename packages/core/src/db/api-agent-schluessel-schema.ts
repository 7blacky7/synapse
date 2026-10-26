/** P22-T176: Spiegel 160_api_agent_schluessel.sql. Additiv/idempotent. */
export const API_AGENT_SCHLUESSEL_SCHEMA_SQL = `
-- P22-T176 / 160. Anthropic-API-Key des API-Agenten aus der Web-UI, VERSCHLUESSELT im bestehenden Server-Tresor
-- (services/agent-token-tresor.ts: AES-256-GCM, Schluessel nur aus Env SYNAPSE_AGENT_TOKEN_SCHLUESSEL). Genau eine Zeile (id = 1);
-- keine Zeile = nur Env SYNAPSE_ANTHROPIC_API_KEY. Der Klartext steht nie in PG. Additiv und idempotent.
-- Laufzeit-Spiegel: packages/core/src/db/api-agent-schluessel-schema.ts (API_AGENT_SCHLUESSEL_SCHEMA_SQL).
CREATE TABLE IF NOT EXISTS api_agent_schluessel (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  chiffre TEXT NOT NULL CHECK (chiffre LIKE 'v1:%'),
  schluessel_id TEXT NOT NULL,
  letzte4 TEXT NOT NULL CHECK (char_length(letzte4) = 4),
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
