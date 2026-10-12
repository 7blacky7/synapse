-- P10-T37: additive Sicherungsdaten; Altzeilen bleiben NULL, keine Migration.
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS sicherung JSONB;
