-- P13-T20/A2: Metadaten des Asset-Transports, niemals Originalbytes/Base64.
-- Spiegel des ausgeführten Blocks in schema.ts. FK auf reverse_eintraege folgt RV3.
CREATE TABLE IF NOT EXISTS asset_upload_sitzungen (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bereich TEXT NOT NULL CHECK (bereich IN ('projekt','reverse')),
  ziel_ref TEXT NOT NULL,
  logischer_pfad TEXT NOT NULL,
  groesse BIGINT NOT NULL CHECK (groesse >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  bestaetigte_bytes BIGINT NOT NULL DEFAULT 0 CHECK (bestaetigte_bytes >= 0 AND bestaetigte_bytes <= groesse),
  "offset" BIGINT GENERATED ALWAYS AS (bestaetigte_bytes) STORED,
  -- Fail-closed: eine wirksame Lease verlängert A6 aus PG-Zeit und konfigurierter Dauer.
  lease_bis TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  idempotency_key TEXT NOT NULL UNIQUE,
  host_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offen'
    CHECK (status IN ('offen','laeuft','vollstaendig','finalisiert','abgebrochen','abgelaufen','fehler')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalisiert_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_asset_upload_ziel ON asset_upload_sitzungen(bereich,ziel_ref,status);
CREATE INDEX IF NOT EXISTS idx_asset_upload_lease ON asset_upload_sitzungen(lease_bis) WHERE status IN ('offen','laeuft');

CREATE TABLE IF NOT EXISTS asset_revisionen (
  asset_id BIGINT NOT NULL REFERENCES asset_files(id) ON DELETE RESTRICT,
  revision BIGINT NOT NULL CHECK (revision > 0),
  sha256 TEXT CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  groesse BIGINT NOT NULL CHECK (groesse >= 0),
  storage_key TEXT,
  tombstone BOOLEAN NOT NULL DEFAULT false,
  quelle TEXT NOT NULL CHECK (quelle IN ('pc','share','reverse')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (asset_id,revision),
  CHECK (tombstone OR (sha256 IS NOT NULL AND storage_key IS NOT NULL))
);

-- Stand ist eine Commit-Wasserlinie je Projekt, KEIN BIGSERIAL-/Zeit-Cursor.
-- Der kurze Publikationsabschnitt sperrt nur diese Projektzeile bis zum Commit.
CREATE TABLE IF NOT EXISTS asset_aenderungsstaende (
  project TEXT PRIMARY KEY,
  stand BIGINT NOT NULL DEFAULT 0 CHECK (stand >= 0)
);
CREATE TABLE IF NOT EXISTS asset_aenderungen (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  stand BIGINT NOT NULL,
  asset_id BIGINT REFERENCES asset_files(id) ON DELETE RESTRICT,
  revision BIGINT CHECK (revision > 0),
  art TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project,stand)
);
CREATE OR REPLACE FUNCTION asset_aenderung_wasserlinie() RETURNS trigger
LANGUAGE plpgsql AS $asset_wasserlinie$
BEGIN
  INSERT INTO asset_aenderungsstaende(project) VALUES(NEW.project) ON CONFLICT DO NOTHING;
  UPDATE asset_aenderungsstaende SET stand=stand+1 WHERE project=NEW.project RETURNING stand INTO NEW.stand;
  RETURN NEW;
END
$asset_wasserlinie$;
CREATE OR REPLACE TRIGGER asset_aenderung_commit_cursor
BEFORE INSERT ON asset_aenderungen FOR EACH ROW EXECUTE FUNCTION asset_aenderung_wasserlinie();

-- A13: Beobachtungen/Hash-Checkpoints je vertrauenswürdiger Scannerwurzel, keine Bytes.
CREATE TABLE IF NOT EXISTS asset_scan_checkpoints (
  root_key TEXT PRIMARY KEY,
  stand JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- M4: dauerhafte Retention-Referenzen für A15 und laufende Leser.
CREATE TABLE IF NOT EXISTS asset_retention_referenzen (
 ref_key TEXT PRIMARY KEY,
 asset_id BIGINT NOT NULL REFERENCES asset_files(id) ON DELETE RESTRICT,
 revision BIGINT NOT NULL CHECK(revision>0),
 art TEXT NOT NULL CHECK(art IN('ansicht','transfer')),
 expires_at TIMESTAMPTZ NOT NULL,
 released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_asset_retention_asset ON asset_retention_referenzen(asset_id);
CREATE TABLE IF NOT EXISTS asset_host_checkpoints (
  host_id TEXT NOT NULL,
  project TEXT NOT NULL,
  stand BIGINT NOT NULL DEFAULT 0 CHECK (stand >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(host_id,project)
);
-- NULL = erbt validierte Betreiber-Konfiguration, keine kopierten Defaults.
CREATE TABLE IF NOT EXISTS asset_projekt_optionen (
  project TEXT PRIMARY KEY,
  richtung TEXT CHECK (richtung IN ('both','pc_to_share','share_to_pc')),
  loeschfenster_ms BIGINT CHECK (loeschfenster_ms >= 0),
  max_datei_bytes BIGINT CHECK (max_datei_bytes >= 0),
  max_projekt_bytes BIGINT CHECK (max_projekt_bytes >= 0),
  max_projekt_dateien BIGINT CHECK (max_projekt_dateien >= 0),
  erlaubte_typen TEXT[],
  policy_revision BIGINT NOT NULL DEFAULT 0 CHECK (policy_revision >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS asset_konflikte (
  id BIGSERIAL PRIMARY KEY,
  asset_id BIGINT NOT NULL REFERENCES asset_files(id) ON DELETE RESTRICT,
  basis_revision BIGINT NOT NULL CHECK (basis_revision >= 0),
  share_revision BIGINT NOT NULL CHECK (share_revision > 0),
  pc_revision BIGINT NOT NULL CHECK (pc_revision > 0),
  status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','uebernommen_pc','verworfen_pc')),
  erledigt_von TEXT,
  erledigt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status='offen' OR (erledigt_von IS NOT NULL AND erledigt_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_konflikt_offen ON asset_konflikte(asset_id) WHERE status='offen';
