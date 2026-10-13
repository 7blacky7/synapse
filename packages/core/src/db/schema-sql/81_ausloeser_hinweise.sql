-- P18-T29 RV19: additive gemeinsame Hinweis-Infrastruktur.
CREATE TABLE IF NOT EXISTS ausloeser_hinweis_aufrufe (
  agent_id TEXT PRIMARY KEY,
  sequenz BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ausloeser_hinweis_profile (
  project TEXT NOT NULL,
  ziel TEXT NOT NULL,
  hinweise_aus TEXT[] NOT NULL DEFAULT '{}',
  hinweise_nur TEXT[],
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(project,ziel)
);
CREATE TABLE IF NOT EXISTS ausloeser_hinweis_zustellungen (
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  sitzung TEXT NOT NULL,
  quelle_id TEXT NOT NULL,
  hinweis_id TEXT NOT NULL,
  gezeigt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aufruf BIGINT NOT NULL,
  voll BOOLEAN NOT NULL DEFAULT TRUE,
  folgeaktion JSONB,
  gefolgt BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY(project,agent_id,sitzung,quelle_id,hinweis_id)
);
CREATE INDEX IF NOT EXISTS idx_ausloeser_hinweis_folge
  ON ausloeser_hinweis_zustellungen(agent_id,project,sitzung,aufruf) WHERE NOT gefolgt AND folgeaktion IS NOT NULL;
CREATE TABLE IF NOT EXISTS ausloeser_hinweis_metriken (
  project TEXT NOT NULL,
  quelle_id TEXT NOT NULL,
  ausgeliefert BIGINT NOT NULL DEFAULT 0,
  gefolgt BIGINT NOT NULL DEFAULT 0,
  unterdrueckt BIGINT NOT NULL DEFAULT 0,
  fehler BIGINT NOT NULL DEFAULT 0,
  zeitueberschreitung BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY(project,quelle_id)
);
