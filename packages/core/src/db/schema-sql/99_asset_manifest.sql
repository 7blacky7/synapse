-- P13-T25/A7: metadata only; stable manifest pages and owned filesystem mutations.
CREATE TABLE IF NOT EXISTS asset_manifest_sitzungen (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(), project TEXT NOT NULL, host_id TEXT NOT NULL,
 stand BIGINT NOT NULL CHECK(stand>=0), erstellt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 lease_bis TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS asset_manifest_eintraege (
 manifest_id UUID NOT NULL REFERENCES asset_manifest_sitzungen(id) ON DELETE RESTRICT,
 asset_id BIGINT NOT NULL REFERENCES asset_files(id) ON DELETE RESTRICT, metadaten JSONB NOT NULL,
 PRIMARY KEY(manifest_id,asset_id)
);
CREATE TABLE IF NOT EXISTS asset_mutationen (
 id UUID PRIMARY KEY, project TEXT NOT NULL, host_id TEXT NOT NULL, event_id TEXT NOT NULL,
 asset_id BIGINT NOT NULL REFERENCES asset_files(id) ON DELETE RESTRICT,
 art TEXT NOT NULL CHECK(art IN ('verschieben','loeschen','wiederherstellen')),
 auftrag JSONB NOT NULL, vorherige_datei JSONB NOT NULL, fs_operation JSONB, ergebnis JSONB,
 status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','prepared','fertig','abgebrochen','fehler')),
 lease_bis TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(project,host_id,event_id)
);
ALTER TABLE asset_files ADD COLUMN IF NOT EXISTS prepared_mutation_id UUID REFERENCES asset_mutationen(id) ON DELETE RESTRICT;
ALTER TABLE asset_aenderungen ADD COLUMN IF NOT EXISTS metadaten JSONB;
CREATE OR REPLACE FUNCTION asset_aenderung_metadaten() RETURNS trigger LANGUAGE plpgsql AS $asset_meta$
BEGIN
 IF NEW.metadaten IS NULL THEN
   SELECT jsonb_build_object('asset_id',a.id::text,'pfad',a.file_path,'revision',a.transport_revision::text,
    'sha256',a.transport_sha256,'groesse',a.file_size,'mime_type',a.mime_type,'storage_kind',a.storage_kind,
    'storage_status',a.storage_status,'deleted_at',a.deleted_at,'restore_until',a.restore_until)
   INTO NEW.metadaten FROM asset_files a WHERE a.id=NEW.asset_id AND a.project=NEW.project;
 END IF;
 RETURN NEW;
END
$asset_meta$;
CREATE OR REPLACE TRIGGER asset_aenderung_metadaten_cursor BEFORE INSERT ON asset_aenderungen
 FOR EACH ROW EXECUTE FUNCTION asset_aenderung_metadaten();
