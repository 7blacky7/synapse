-- P22-T194 Stufe2: letzter Telemetriestand je Identität, keine Reset-/Zustellsteuerung.
CREATE TABLE IF NOT EXISTS cache_waechter_stand (
 identity_id TEXT PRIMARY KEY REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
 lauf_id TEXT NOT NULL,
 sitzung TEXT NOT NULL,
 herkunft JSONB NOT NULL,
 messung JSONB NOT NULL,
 messung_ms BIGINT NOT NULL,
 empfangen_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
