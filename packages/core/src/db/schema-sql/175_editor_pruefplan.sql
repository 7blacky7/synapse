-- P22-T256: isolierte User-Prüfpläne; keine Datei-Reservation und kein Co-Edit-Gate.
CREATE TABLE IF NOT EXISTS editor_pruefplaene (
 id UUID PRIMARY KEY,
 project TEXT NOT NULL,
 abbild_id UUID NOT NULL,
 file_path TEXT NOT NULL,
 entwurf TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'wartet' CHECK(status IN ('wartet','zugeteilt','konflikt','freigegeben','abgelehnt')),
 pruefer_identity_id TEXT REFERENCES agent_identitaeten(id),
 pruefer_name TEXT,
 pruefung TEXT,
 files_plan_id BIGINT REFERENCES file_batch_plans(id),
 erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(abbild_id,file_path) REFERENCES editor_abbild_dateien(abbild_id,file_path)
);
ALTER TABLE editor_pruefplaene ADD COLUMN IF NOT EXISTS files_plan_id BIGINT REFERENCES file_batch_plans(id);
CREATE INDEX IF NOT EXISTS idx_editor_pruefplaene_project ON editor_pruefplaene(project,erstellt_am DESC);
