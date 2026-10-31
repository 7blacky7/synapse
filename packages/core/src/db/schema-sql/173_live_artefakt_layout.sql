-- P22-T164: Layout des authentifizierten Synapse-Users, pro Artefakt und Renderprojekt.
CREATE TABLE IF NOT EXISTS user_live_artefakt_layout (
  user_key TEXT NOT NULL,
  artefakt_id UUID NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  breite DOUBLE PRECISION NOT NULL,
  hoehe DOUBLE PRECISION NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  aktualisiert TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_key, artefakt_id, project)
);
