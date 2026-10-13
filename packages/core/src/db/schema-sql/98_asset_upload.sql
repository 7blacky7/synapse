-- P13-T24/A6: nur Uploadmetadaten und interne Teilreferenzen, niemals Bytes.
ALTER TABLE asset_upload_sitzungen ADD COLUMN IF NOT EXISTS auftrag JSONB;
ALTER TABLE asset_upload_sitzungen ADD COLUMN IF NOT EXISTS finalisierer_token UUID;
ALTER TABLE asset_upload_sitzungen ADD COLUMN IF NOT EXISTS finalisierer_bis TIMESTAMPTZ;
ALTER TABLE asset_upload_sitzungen ADD COLUMN IF NOT EXISTS publish_operation JSONB;
ALTER TABLE asset_upload_sitzungen ADD COLUMN IF NOT EXISTS ergebnis JSONB;
ALTER TABLE asset_upload_sitzungen ADD COLUMN IF NOT EXISTS vorherige_datei JSONB;
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS prepared_upload_id UUID REFERENCES asset_upload_sitzungen(id) ON DELETE RESTRICT;
CREATE TABLE IF NOT EXISTS asset_upload_teile (
  upload_id UUID NOT NULL REFERENCES asset_upload_sitzungen(id) ON DELETE RESTRICT,
  byte_offset BIGINT NOT NULL CHECK (byte_offset >= 0),
  groesse BIGINT NOT NULL CHECK (groesse > 0),
  staging_id UUID NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (upload_id,byte_offset),
  UNIQUE(staging_id)
);
