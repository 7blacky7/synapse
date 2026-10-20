-- P21-T15: Analyse-Metadaten; niemals Schluessel oder Ergebnisbytes in PG.
CREATE TABLE IF NOT EXISTS hex_analysen (
 id UUID PRIMARY KEY,
 project TEXT NOT NULL,
 akteur TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('vorbereitet','bereit','fehler')),
 groesse BIGINT NOT NULL CHECK(groesse>=0 AND groesse<=9007199254740991),
 sha256 TEXT CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
 herkunft JSONB NOT NULL,
 wurzeln JSONB NOT NULL,
 tiefe INTEGER NOT NULL CHECK(tiefe>0),
 work_job_id UUID,
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS hex_analysen_project ON hex_analysen(project,status);
