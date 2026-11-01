-- P22-T256: unveränderliches PG-Abbild für einen User-Editor, ohne Datei-/Agentenreservierung.
CREATE TABLE IF NOT EXISTS editor_abbilder (
  id UUID PRIMARY KEY,
  project TEXT NOT NULL,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_editor_abbilder_project ON editor_abbilder(project, erstellt_am DESC);
CREATE TABLE IF NOT EXISTS editor_abbild_dateien (
  abbild_id UUID NOT NULL REFERENCES editor_abbilder(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  inhalt TEXT NOT NULL,
  basis_hash TEXT NOT NULL,
  maskiert BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (abbild_id, file_path)
);
