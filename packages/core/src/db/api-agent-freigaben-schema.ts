/** P22-T179: Spiegel 161_api_agent_freigaben.sql. Additiv/idempotent. */
export const API_AGENT_FREIGABEN_SCHEMA_SQL = `
-- P22-T179 / 161. Freigabe eines kostenpflichtigen API-Agenten JE IDENTITAET (Arbeitsagent subagent oder Koordinator).
-- User 24.10.2026 (P22-T106): kostenpflichtig NUR auf ausdruecklichen Wunsch - der User stellt es selbst ein oder der Main verlangt
-- es ausdruecklich (user_auftrag); nie automatisch durch Fallback oder Koordinator. Ohne aktive Zeile kein Aufruf ueber den Transport.
-- modelle = erlaubte API-Modelle dieses Agenten (Teilmenge der Registry-Aliase provider anthropic-api; das globale Budget prueft
-- zusaetzlich seine erlaubte_modelle). grenze_usd = optionale Grenze NUR dieses Agenten im Zeitraum des globalen Budgets.
-- heartbeat = Heartbeat des Agenten (Standard AUS: jeder Weckruf kostet). Additiv und idempotent.
-- Laufzeit-Spiegel: packages/core/src/db/api-agent-freigaben-schema.ts (API_AGENT_FREIGABEN_SCHEMA_SQL).
CREATE TABLE IF NOT EXISTS api_agent_freigaben (
  identity_id TEXT PRIMARY KEY REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  aktiv BOOLEAN NOT NULL DEFAULT TRUE,
  modelle TEXT[] NOT NULL CHECK (cardinality(modelle) > 0),
  grenze_usd NUMERIC(12,4) CHECK (grenze_usd IS NULL OR grenze_usd > 0),
  heartbeat BOOLEAN NOT NULL DEFAULT FALSE,
  grund TEXT NOT NULL,
  user_auftrag TEXT,
  gesetzt_von TEXT NOT NULL CHECK (gesetzt_von IN ('user', 'main')),
  setter_identity_id TEXT,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_agent_freigaben_project ON api_agent_freigaben (project);
CREATE INDEX IF NOT EXISTS idx_api_agent_reservierungen_identity_zeit ON api_agent_reservierungen (identity_id, erstellt_am);
`;
