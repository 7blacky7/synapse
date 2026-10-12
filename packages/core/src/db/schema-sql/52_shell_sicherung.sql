-- P10-T35 E1: reine Katalogdaten; noch keine Ausführungswirkung.
CREATE TABLE IF NOT EXISTS shell_antworttopf (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
  beschreibung TEXT NOT NULL, risiko TEXT NOT NULL,
  sicher JSONB NOT NULL DEFAULT '{}', danach TEXT NOT NULL,
  platzhalter JSONB NOT NULL DEFAULT '{}', quelle TEXT NOT NULL,
  os TEXT[] NOT NULL DEFAULT '{}', bereich TEXT NOT NULL DEFAULT 'global' CHECK (bereich IN ('global','projekt')),
  project TEXT, rechner TEXT[] NOT NULL DEFAULT '{}',
  positiv JSONB NOT NULL DEFAULT '[]', negativ JSONB NOT NULL DEFAULT '[]',
  CHECK (bereich <> 'projekt' OR project IS NOT NULL),
  status TEXT NOT NULL DEFAULT 'vorschlag' CHECK (status IN ('aktiv','vorschlag','stillgelegt')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shell_sicherungsregeln (
  id TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 1,
  art TEXT NOT NULL CHECK (art IN ('text','lage')),
  stufe TEXT NOT NULL CHECK (stufe IN ('hinweis','anleitung','sperre')),
  os TEXT[] NOT NULL DEFAULT '{}', bereich TEXT NOT NULL DEFAULT 'global' CHECK (bereich IN ('global','projekt')),
  project TEXT, rechner TEXT[] NOT NULL DEFAULT '{}',
  positiv JSONB NOT NULL DEFAULT '[]', negativ JSONB NOT NULL DEFAULT '[]',
  CHECK (bereich <> 'projekt' OR project IS NOT NULL),
  muster JSONB NOT NULL,
  antwort_id TEXT NOT NULL REFERENCES shell_antworttopf(id),
  quelle TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'vorschlag' CHECK (status IN ('aktiv','vorschlag','stillgelegt')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS shell_risiko_verben (
  id TEXT PRIMARY KEY, muster JSONB NOT NULL, quelle TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'vorschlag' CHECK (status IN ('aktiv','vorschlag','stillgelegt')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shell_sicherung_aktiv
  ON shell_sicherungsregeln(bereich, project, art) WHERE status = 'aktiv';

CREATE TABLE IF NOT EXISTS shell_sicherungs_audit (
  id BIGSERIAL PRIMARY KEY, objekt_art TEXT NOT NULL CHECK (objekt_art IN ('regel','antwort','risiko_verb')),
  objekt_id TEXT NOT NULL, version INTEGER NOT NULL,
  vorher JSONB, nachher JSONB NOT NULL,
  agent_id TEXT NOT NULL, grund TEXT NOT NULL CHECK (length(trim(grund)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_shell_sicherungs_audit_objekt
  ON shell_sicherungs_audit(objekt_art, objekt_id, id);
