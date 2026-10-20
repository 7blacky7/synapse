-- P21-T7: immutable Formate/Versionen und explizite Freigaben; keine Quelldateibytes.
CREATE TABLE IF NOT EXISTS hex_formate (
 id UUID PRIMARY KEY,
 project TEXT NOT NULL,
 name TEXT NOT NULL,
 erstellt_von TEXT NOT NULL,
 erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS hex_format_versionen (
 id BIGSERIAL UNIQUE NOT NULL,
 format_id UUID NOT NULL REFERENCES hex_formate(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>0),
 profil TEXT NOT NULL CHECK(profil='kaitai-read-v1'),
 canonical_hash TEXT NOT NULL CHECK(canonical_hash ~ '^[a-f0-9]{64}$'),
 definition JSONB NOT NULL,
 beschreibung TEXT NOT NULL,
 erkennung JSONB NOT NULL,
 herkunft JSONB NOT NULL,
 basis JSONB,
 autor TEXT NOT NULL,
 erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(format_id,version)
);
CREATE TABLE IF NOT EXISTS hex_format_freigaben (
 format_id UUID NOT NULL,
 version INTEGER NOT NULL,
 freigegeben_von TEXT NOT NULL,
 freigegeben_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(format_id,version),
 FOREIGN KEY(format_id,version) REFERENCES hex_format_versionen(format_id,version) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION hex_format_unveraenderlich() RETURNS TRIGGER
LANGUAGE plpgsql AS $hex_format_immutable$
BEGIN
 RAISE EXCEPTION 'hex_format_version_unveraenderlich';
END
$hex_format_immutable$;
DROP TRIGGER IF EXISTS hex_format_version_immutable ON hex_format_versionen;
CREATE TRIGGER hex_format_version_immutable BEFORE UPDATE OR DELETE ON hex_format_versionen FOR EACH ROW EXECUTE FUNCTION hex_format_unveraenderlich();
DROP TRIGGER IF EXISTS hex_format_freigabe_immutable ON hex_format_freigaben;
CREATE TRIGGER hex_format_freigabe_immutable BEFORE UPDATE OR DELETE ON hex_format_freigaben FOR EACH ROW EXECUTE FUNCTION hex_format_unveraenderlich();
CREATE TABLE IF NOT EXISTS hex_format_cursor (
 id UUID PRIMARY KEY,
 project TEXT NOT NULL,
 akteur TEXT NOT NULL,
 format_id UUID NOT NULL,
 format_version INTEGER NOT NULL,
 canonical_hash TEXT NOT NULL,
 ref JSONB NOT NULL,
 zustand JSONB NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(format_id,format_version) REFERENCES hex_format_versionen(format_id,version) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ix_hex_format_cursor_ablauf ON hex_format_cursor(expires_at);
