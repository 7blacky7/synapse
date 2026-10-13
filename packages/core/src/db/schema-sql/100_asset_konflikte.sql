-- P13-T29/A11: retained PC candidates and physically recoverable conflict resolution.
ALTER TABLE asset_revisionen ADD COLUMN IF NOT EXISTS restore_until TIMESTAMPTZ;
ALTER TABLE asset_konflikte ADD COLUMN IF NOT EXISTS art TEXT NOT NULL DEFAULT 'inhalt';
ALTER TABLE asset_konflikte ADD COLUMN IF NOT EXISTS pc_pfad TEXT;
ALTER TABLE asset_konflikte ADD COLUMN IF NOT EXISTS quelle_asset_id BIGINT REFERENCES asset_files(id);
ALTER TABLE asset_konflikte ADD COLUMN IF NOT EXISTS quelle_revision BIGINT;
CREATE TABLE IF NOT EXISTS asset_konflikt_eingaenge (
 project TEXT NOT NULL,host_id TEXT NOT NULL,event_id TEXT NOT NULL,request_hash TEXT NOT NULL,
 konflikt_id BIGINT NOT NULL REFERENCES asset_konflikte(id),pc_revision BIGINT NOT NULL,
 ergebnis JSONB NOT NULL,PRIMARY KEY(project,host_id,event_id)
);
CREATE TABLE IF NOT EXISTS asset_konflikt_loesungen (
 id UUID PRIMARY KEY,konflikt_id BIGINT NOT NULL REFERENCES asset_konflikte(id),
 project TEXT NOT NULL,agent_id TEXT NOT NULL,basis_revision BIGINT NOT NULL,
 pc_revision BIGINT NOT NULL,status TEXT NOT NULL CHECK(status IN('offen','prepared','fertig','abgebrochen')),
 vorherige_datei JSONB NOT NULL,fs_operation JSONB,ergebnis JSONB,
 lease_bis TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_konflikt_loesung_aktiv
 ON asset_konflikt_loesungen(konflikt_id) WHERE status IN('offen','prepared');
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS prepared_konflikt_id UUID;
