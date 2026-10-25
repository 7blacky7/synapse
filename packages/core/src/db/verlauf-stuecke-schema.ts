/** P22-T157: Spiegel 153_verlauf_stuecke.sql. Additiv/idempotent; nach 111 (agent_identitaeten) und 124 (hauptagent_verlauf). */
export const VERLAUF_STUECKE_SCHEMA_SQL = `
-- P22-T157 / 153. Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt.
-- Sitzungsverlaeufe semantisch durchsuchbar (Entwurf e8d2f0dc Fassung 2, GO mit R1-R8): geschwaerzte Stuecke des Verlaufs
-- (hauptagent_verlauf) je Ausweis-Identitaet. PG ist die Wahrheit; Qdrant 'agent_verlauf' ist nur der Suchindex
-- (Pflichtfilter identity_id, aus PG wiederherstellbar). text = genau der eingebettete, geschwaerzte Text.
CREATE TABLE IF NOT EXISTS verlauf_stuecke (
  id UUID PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  project TEXT,
  lauf_id TEXT,
  context_epoch INTEGER,
  von_verlauf_id BIGINT NOT NULL,
  bis_verlauf_id BIGINT NOT NULL,
  zeit_von TIMESTAMPTZ NOT NULL,
  zeit_bis TIMESTAMPTZ NOT NULL,
  stueck_nr INTEGER NOT NULL DEFAULT 0,
  rollen TEXT[] NOT NULL DEFAULT '{}',
  text TEXT NOT NULL,
  stand TEXT NOT NULL,
  schwaerz_treffer INTEGER NOT NULL DEFAULT 0,
  zerleger_version TEXT NOT NULL,
  embedded_at TIMESTAMPTZ,
  embedding_modell TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (identity_id, von_verlauf_id, stueck_nr, zerleger_version)
);
CREATE INDEX IF NOT EXISTS idx_verlauf_stuecke_zeit ON verlauf_stuecke(identity_id, zeit_von);
CREATE INDEX IF NOT EXISTS idx_verlauf_stuecke_offen ON verlauf_stuecke(zeit_von) WHERE embedded_at IS NULL;
-- Stand je Identitaet: bis wohin der Verlauf zerlegt ist (Schnitt nach hauptagent_verlauf.id), Debug-Werte des letzten Laufs.
CREATE TABLE IF NOT EXISTS verlauf_einbett_stand (
  identity_id TEXT PRIMARY KEY REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  bis_verlauf_id BIGINT NOT NULL DEFAULT 0,
  letzter_lauf TEXT,
  zuletzt_am TIMESTAMPTZ,
  letzte_dauer_ms INTEGER,
  stuecke_gesamt INTEGER NOT NULL DEFAULT 0,
  schwaerz_treffer BIGINT NOT NULL DEFAULT 0,
  letzter_fehler TEXT
);
`;
