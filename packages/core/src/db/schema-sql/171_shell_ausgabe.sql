-- P22-T243: Spiegel von shell-ausgabe-schema.ts (nach 60_shell.sql; wie 169 ALTER auf shell_jobs).
-- shell_stream_chunks (bisher ungenutzt) wird wiederverwendet:
-- chunk_index = Teilnummer ab 0, line = maskierter Teiltext; neu bytes/zeilen/zeilen_anfang/art.
ALTER TABLE shell_stream_chunks ADD COLUMN IF NOT EXISTS bytes INTEGER;
ALTER TABLE shell_stream_chunks ADD COLUMN IF NOT EXISTS zeilen INTEGER;
ALTER TABLE shell_stream_chunks ADD COLUMN IF NOT EXISTS zeilen_anfang BIGINT;
ALTER TABLE shell_stream_chunks ADD COLUMN IF NOT EXISTS art TEXT;
CREATE INDEX IF NOT EXISTS idx_shell_stream_chunks_zeilen ON shell_stream_chunks(job_id, zeilen_anfang) WHERE zeilen_anfang IS NOT NULL;
-- Summen je Job (NULL = keine Teile, Altweg ueber shell_jobs.output).
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS ausgabe_teile INTEGER;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS ausgabe_bytes BIGINT;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS ausgabe_zeilen BIGINT;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS ausgabe_offen BOOLEAN;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS ausgabe_ausgelassen_bytes BIGINT;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS ausgabe_stand TEXT;
-- Einstellwerte (projekt > global > Code-Standard), admin shell_ausgabe_einstellungen.
CREATE TABLE IF NOT EXISTS shell_ausgabe_einstellungen (
 ebene TEXT NOT NULL CHECK (ebene IN ('global','projekt')),
 project TEXT,
 name TEXT NOT NULL,
 wert BIGINT NOT NULL CHECK (wert > 0),
 grund TEXT NOT NULL,
 gesetzt_von TEXT NOT NULL,
 gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK ((ebene='global' AND project IS NULL) OR (ebene='projekt' AND project IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_shell_ausgabe_einstellungen ON shell_ausgabe_einstellungen(ebene,(COALESCE(project,'')),name);
