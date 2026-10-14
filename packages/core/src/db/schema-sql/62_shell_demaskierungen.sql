-- P10-T73: Rueckfrage-Stufe und Demaskieren. Additiv, Altzeilen bleiben unveraendert.
-- Gefahrkennzeichen an Katalogregeln (NULL = nicht gefaehrlich) und Stufe 'rueckfrage'.
ALTER TABLE shell_sicherungsregeln ADD COLUMN IF NOT EXISTS gefaehrlich JSONB;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='shell_sicherungsregeln_stufe_check'
                 AND pg_get_constraintdef(oid) LIKE '%rueckfrage%') THEN
    ALTER TABLE shell_sicherungsregeln DROP CONSTRAINT IF EXISTS shell_sicherungsregeln_stufe_check;
    ALTER TABLE shell_sicherungsregeln ADD CONSTRAINT shell_sicherungsregeln_stufe_check
      CHECK (stufe IN ('hinweis','anleitung','rueckfrage','sperre'));
  END IF;
END $$;
-- Kleine Liste bestaetigt demaskierter Jobs; der Worker maskiert nur diese nach und loescht den Eintrag.
CREATE TABLE IF NOT EXISTS shell_demaskierungen (
  job_id UUID PRIMARY KEY REFERENCES shell_jobs(id) ON DELETE CASCADE,
  bestaetigung_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project TEXT NOT NULL,
  grund TEXT NOT NULL CHECK (length(trim(grund)) >= 10),
  demaskiert_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  maskieren_bis TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shell_demaskierungen_faellig ON shell_demaskierungen(maskieren_bis);
-- Abgewiesene Rueckfrage-Jobs: Vormerkliste, der Worker loescht per Primaerschluessel (kein Scan ueber shell_jobs).
CREATE TABLE IF NOT EXISTS shell_rueckfrage_jobs (
  job_id UUID PRIMARY KEY REFERENCES shell_jobs(id) ON DELETE CASCADE,
  verfaellt_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shell_rueckfrage_jobs_verfall ON shell_rueckfrage_jobs(verfaellt_at);
