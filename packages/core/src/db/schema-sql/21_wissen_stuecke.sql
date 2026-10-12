-- P12-T10 (sol-1): versionierter Wissens-Stueckindex. PG bleibt Quelle der Wahrheit.
-- Kein Backfill beim Start: lange Alt-Eintraege holt der bestehende gedrosselte Nachzug.
CREATE TABLE IF NOT EXISTS wissen_stueck_status (
  quelle TEXT NOT NULL CHECK (quelle IN ('memories', 'thoughts', 'tech_docs')),
  eintrag_id TEXT NOT NULL,
  project TEXT,
  stand TEXT,
  version TEXT NOT NULL,
  modell TEXT NOT NULL,
  abgeschlossen BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (quelle, eintrag_id)
);
-- Idempotente Erweiterung auch fuer bereits lokal angelegte Test-Schemas.
ALTER TABLE wissen_stueck_status ALTER COLUMN project DROP NOT NULL;
ALTER TABLE wissen_stueck_status DROP CONSTRAINT IF EXISTS wissen_stueck_status_quelle_check;
ALTER TABLE wissen_stueck_status ADD CONSTRAINT wissen_stueck_status_quelle_check
  CHECK (quelle IN ('memories', 'thoughts', 'tech_docs'));
CREATE TABLE IF NOT EXISTS wissen_stuecke (
  quelle TEXT NOT NULL,
  eintrag_id TEXT NOT NULL,
  stueck_nr INTEGER NOT NULL,
  punkt_id TEXT NOT NULL,
  inhalt TEXT NOT NULL,
  embedded_at TIMESTAMPTZ,
  claim_token UUID,
  lease_until TIMESTAMPTZ,
  PRIMARY KEY (quelle, eintrag_id, stueck_nr),
  FOREIGN KEY (quelle, eintrag_id) REFERENCES wissen_stueck_status(quelle, eintrag_id) ON DELETE CASCADE
);
ALTER TABLE wissen_stuecke ADD COLUMN IF NOT EXISTS claim_token UUID;
ALTER TABLE wissen_stuecke ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_wissen_stuecke_offen
  ON wissen_stuecke (quelle, eintrag_id) WHERE embedded_at IS NULL;
-- Ende P12-T10.
