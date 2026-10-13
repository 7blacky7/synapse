/** RV5/RV33: Spiegel 100_reverse_eingang.sql. */
export const REVERSE_EINGANG_SCHEMA_SQL = `
-- RV5/RV33: Upload-Metadaten, Inhalt einmal, immutable Status-Snapshots.
ALTER TABLE reverse_eintraege ADD COLUMN IF NOT EXISTS eingang_schluessel TEXT;
ALTER TABLE reverse_eintraege ADD COLUMN IF NOT EXISTS eingang_stand TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_eingang_schluessel ON reverse_eintraege(eingang_schluessel);
ALTER TABLE reverse_medien ADD COLUMN IF NOT EXISTS vorschlag JSONB NOT NULL DEFAULT '{}'::jsonb;
-- Ein Ordner kann dieselben Bytes unter mehreren Namen enthalten.
ALTER TABLE reverse_medien_dateien DROP CONSTRAINT IF EXISTS reverse_medien_dateien_sha256_medium_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_medien_datei_name ON reverse_medien_dateien(medium_id,original_name);
CREATE TABLE IF NOT EXISTS reverse_eingang_bytes (
 sha256 TEXT PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 groesse BIGINT NOT NULL CHECK(groesse>=0), storage_key TEXT,
 ziel_ref TEXT NOT NULL, logischer_pfad TEXT NOT NULL, host_id TEXT NOT NULL,
 upload_id UUID REFERENCES asset_upload_sitzungen(id), generation INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','prepared','ready')),
 format TEXT, referenzen JSONB, erkannt BOOLEAN NOT NULL DEFAULT FALSE, refcount BIGINT NOT NULL DEFAULT 0 CHECK(refcount>=0),
 CHECK(storage_key IS NULL OR (storage_key<>'' AND storage_key !~ '^/' AND storage_key !~ '(^|/)[.]{1,2}(/|$)' AND position(chr(92) in storage_key)=0))
);
CREATE TABLE IF NOT EXISTS reverse_eingang_dateien (
 id BIGSERIAL PRIMARY KEY, host_id TEXT NOT NULL, rel_pfad TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES reverse_eingang_bytes(sha256),
 quelle TEXT NOT NULL CHECK(quelle IN ('tray','unraid_eingang')),
 groesse BIGINT NOT NULL, mtime TIMESTAMPTZ,
 eintrag_id TEXT NOT NULL REFERENCES reverse_eintraege(id), medium_id BIGINT REFERENCES reverse_medien(id),
 original_name TEXT NOT NULL, rolle TEXT NOT NULL DEFAULT 'haupt', medien_datei_id BIGINT REFERENCES reverse_medien_dateien(id),
 UNIQUE(host_id,rel_pfad,sha256,eintrag_id)
);
CREATE INDEX IF NOT EXISTS idx_reverse_eingang_dateien_eintrag ON reverse_eingang_dateien(eintrag_id);
CREATE TABLE IF NOT EXISTS reverse_fund_snapshots (
 id UUID PRIMARY KEY, host_id TEXT NOT NULL, lease_bis TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS reverse_fund_snapshot_zeilen (
 snapshot_id UUID REFERENCES reverse_fund_snapshots(id) ON DELETE CASCADE,
 id BIGINT NOT NULL, daten JSONB NOT NULL, PRIMARY KEY(snapshot_id,id)
);
CREATE OR REPLACE FUNCTION reverse_bytes_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') THEN UPDATE reverse_eingang_bytes SET refcount=refcount-1 WHERE sha256=OLD.sha256; END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN UPDATE reverse_eingang_bytes SET refcount=refcount+1 WHERE sha256=NEW.sha256; END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS reverse_medien_bytes_refs ON reverse_medien_dateien;
CREATE TRIGGER reverse_medien_bytes_refs AFTER INSERT OR DELETE OR UPDATE OF sha256 ON reverse_medien_dateien FOR EACH ROW EXECUTE FUNCTION reverse_bytes_refs();
`;
