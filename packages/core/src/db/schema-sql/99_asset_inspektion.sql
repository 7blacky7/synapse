-- P13-T30/A12: Metadatenaufträge, keine Assetbytes.
CREATE TABLE IF NOT EXISTS asset_inspektions_projekte (
  project TEXT PRIMARY KEY,
  modus TEXT NOT NULL CHECK (modus IN ('legacy_local','asset_sync')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS asset_inspektions_auftraege (
  id UUID PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  transport_revision BIGINT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  profil TEXT NOT NULL,
  grenzen JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','done','stale','error')),
  lease_token UUID,
  lease_bis TIMESTAMPTZ,
  versuche INTEGER NOT NULL DEFAULT 0,
  fehler TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(asset_id,transport_revision,sha256,profil)
);
CREATE INDEX IF NOT EXISTS asset_inspektions_queue ON asset_inspektions_auftraege(status,lease_bis,created_at);
