-- P22-T264: Herkunft des Web-Editor-User-Plans (Spiegel aus schema.ts). editor_pruefplaene ist mit P22-T272 entfernt (175).
ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS editor_userplan BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_editor_userplan_offen ON file_batch_plans(project) WHERE editor_userplan AND status = 'open';
