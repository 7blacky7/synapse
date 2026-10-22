/** P18-T40/T42: additiver Spiegel von schema-sql/141_reverse_leser.sql. */
export const REVERSE_LESER_SCHEMA_SQL = `
-- P18-T40/T42 Teil A: nur neue Registry-Tabellen. Keine Ausführung/Bestandsmigration.
CREATE TABLE IF NOT EXISTS reverse_leser (
 id TEXT PRIMARY KEY CHECK(id ~ '^[0-9a-f]{64}$'),
 name TEXT NOT NULL, version TEXT NOT NULL, schnittstelle_version INTEGER NOT NULL CHECK(schnittstelle_version=1),
 runtime TEXT NOT NULL CHECK(runtime='python3'), manifest JSONB NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 manifest_sha256 TEXT NOT NULL CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 code_sha256 TEXT NOT NULL CHECK(code_sha256 ~ '^[0-9a-f]{64}$'),
 paket_sha256 TEXT NOT NULL CHECK(paket_sha256 ~ '^[0-9a-f]{64}$'),
 quelle JSONB NOT NULL CHECK(jsonb_typeof(quelle)='object'),
 quell_bytes BIGINT NOT NULL CHECK(quell_bytes>0),
 registriert_von TEXT NOT NULL, registriert_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(name,version), UNIQUE(id,name),
 CHECK(manifest->>'name'=name AND manifest->>'version'=version AND manifest->>'runtime'=runtime)
);
-- Inhalt unveränderlich; Freigabestand/aktiver Zeiger bewusst separat.
CREATE TABLE IF NOT EXISTS reverse_leser_zustaende (
 leser_id TEXT PRIMARY KEY, name TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'entwurf' CHECK(status IN('entwurf','aktiv','deaktiviert','ersetzt')),
 storage_key TEXT, paket_bytes BIGINT CHECK(paket_bytes>0),
 freigegeben_von TEXT, freigegeben_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(leser_id,name) REFERENCES reverse_leser(id,name) ON DELETE RESTRICT,
 CHECK(status='entwurf' OR (storage_key IS NOT NULL AND paket_bytes IS NOT NULL AND freigegeben_von IS NOT NULL AND freigegeben_at IS NOT NULL)),
 CHECK(storage_key IS NULL OR (storage_key<>'' AND storage_key !~ '^/' AND storage_key !~ '(^|/)[.]{1,2}(/|$)' AND position(chr(92) in storage_key)=0))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_leser_aktiv ON reverse_leser_zustaende(name) WHERE status='aktiv';
CREATE TABLE IF NOT EXISTS reverse_leser_laeufe (
 id UUID PRIMARY KEY, leser_id TEXT NOT NULL REFERENCES reverse_leser(id) ON DELETE RESTRICT,
 eintrag_id TEXT NOT NULL, datei_id BIGINT NOT NULL, quell_sha256 TEXT NOT NULL CHECK(quell_sha256 ~ '^[0-9a-f]{64}$'),
 generation UUID NOT NULL, work_job_id UUID,
 status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN('offen','laeuft','teilweise','fertig','fehler','abgebrochen')),
 einstellungen_revision TEXT NOT NULL CHECK(einstellungen_revision ~ '^[0-9a-f]{64}$'),
 cursor_key TEXT, manifest_key TEXT, manifest_sha256 TEXT CHECK(manifest_sha256 ~ '^[0-9a-f]{64}$'),
 position BIGINT NOT NULL DEFAULT 0 CHECK(position>=0), ausgabe_anzahl BIGINT NOT NULL DEFAULT 0 CHECK(ausgabe_anzahl>=0),
 ausgabe_bytes BIGINT NOT NULL DEFAULT 0 CHECK(ausgabe_bytes>=0), offen BIGINT NOT NULL DEFAULT 0 CHECK(offen>=0),
 abgewiesen BIGINT NOT NULL DEFAULT 0 CHECK(abgewiesen>=0), dauer_ms BIGINT CHECK(dauer_ms>=0),
 fehlercode TEXT, diagnose JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(diagnose)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), beendet_at TIMESTAMPTZ,
 UNIQUE(id,eintrag_id,datei_id), UNIQUE(eintrag_id,datei_id,leser_id,quell_sha256,generation),
 CHECK(status<>'fertig' OR (offen=0 AND manifest_key IS NOT NULL AND manifest_sha256 IS NOT NULL AND beendet_at IS NOT NULL)),
 CHECK(cursor_key IS NULL OR (cursor_key<>'' AND cursor_key !~ '^/' AND cursor_key !~ '(^|/)[.]{1,2}(/|$)' AND position(chr(92) in cursor_key)=0)),
 CHECK(manifest_key IS NULL OR (manifest_key<>'' AND manifest_key !~ '^/' AND manifest_key !~ '(^|/)[.]{1,2}(/|$)' AND position(chr(92) in manifest_key)=0))
);
CREATE INDEX IF NOT EXISTS idx_reverse_leser_laeufe_eintrag ON reverse_leser_laeufe(eintrag_id,datei_id,created_at,id);
-- Neue Zeilen sofort prüfen, keine Validierung/Scans großer Bestandstabellen beim Start.
DO $leser_fk$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_leser_laeufe'::regclass AND conname='reverse_leser_lauf_datei_fk') THEN
  ALTER TABLE reverse_leser_laeufe ADD CONSTRAINT reverse_leser_lauf_datei_fk FOREIGN KEY(datei_id,eintrag_id)
   REFERENCES reverse_dateien(id,eintrag_id) ON DELETE RESTRICT NOT VALID;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_leser_laeufe'::regclass AND conname='reverse_leser_lauf_job_fk') THEN
  ALTER TABLE reverse_leser_laeufe ADD CONSTRAINT reverse_leser_lauf_job_fk FOREIGN KEY(work_job_id)
   REFERENCES work_jobs(id) ON DELETE RESTRICT NOT VALID;
 END IF;
END $leser_fk$;
CREATE OR REPLACE FUNCTION reverse_leser_revision_schuetzen() RETURNS trigger LANGUAGE plpgsql AS $leser_guard$
BEGIN
 RAISE EXCEPTION 'reverse_leser_revision_unveraenderlich' USING ERRCODE='23514';
END $leser_guard$;
DO $leser_trigger$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='reverse_leser'::regclass AND tgname='reverse_leser_revision_guard') THEN
  CREATE TRIGGER reverse_leser_revision_guard BEFORE UPDATE OR DELETE ON reverse_leser
   FOR EACH ROW EXECUTE FUNCTION reverse_leser_revision_schuetzen();
 END IF;
END $leser_trigger$;
-- Laufzustand darf fortschreiten, Herkunft/Generation nie wechseln. Entfernen später explizit per eintrag_id (T99).
CREATE OR REPLACE FUNCTION reverse_leser_lauf_schuetzen() RETURNS trigger LANGUAGE plpgsql AS $lauf_guard$
BEGIN
 IF ROW(NEW.id,NEW.leser_id,NEW.eintrag_id,NEW.datei_id,NEW.quell_sha256,NEW.generation,NEW.work_job_id)
    IS DISTINCT FROM ROW(OLD.id,OLD.leser_id,OLD.eintrag_id,OLD.datei_id,OLD.quell_sha256,OLD.generation,OLD.work_job_id) THEN
  RAISE EXCEPTION 'reverse_leser_lauf_herkunft_unveraenderlich' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $lauf_guard$;
DO $lauf_trigger$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='reverse_leser_laeufe'::regclass AND tgname='reverse_leser_lauf_guard') THEN
  CREATE TRIGGER reverse_leser_lauf_guard BEFORE UPDATE ON reverse_leser_laeufe
   FOR EACH ROW EXECUTE FUNCTION reverse_leser_lauf_schuetzen();
 END IF;
END $lauf_trigger$;
`;
