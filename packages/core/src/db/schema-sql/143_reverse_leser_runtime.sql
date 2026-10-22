-- P18-T102: immutable RO-Runtime, getrennte Imagebelege und Aktivierungs-/Auditereignisse.
CREATE TABLE IF NOT EXISTS reverse_leser_runtimes (
 pin TEXT PRIMARY KEY CHECK(pin ~ '^[a-f0-9]{64}$'),
 vertrag TEXT NOT NULL CHECK(vertrag='leser-python3-v1'),
 inhaltsindex JSONB NOT NULL CHECK(jsonb_typeof(inhaltsindex)='object'),
 storage_key TEXT NOT NULL UNIQUE CHECK(storage_key='.intern/leser-runtime/'||pin),
 quelle JSONB NOT NULL CHECK(jsonb_typeof(quelle)='object'),
 bytes BIGINT NOT NULL CHECK(bytes>0),erstellt_von TEXT NOT NULL,erstellt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS reverse_leser_runtime_images (
 pin TEXT NOT NULL REFERENCES reverse_leser_runtimes(pin) ON DELETE RESTRICT,
 image_digest TEXT NOT NULL CHECK(image_digest ~ '^sha256:[a-f0-9]{64}$'),
 image TEXT NOT NULL,erstellt_von TEXT NOT NULL,erstellt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(pin,image_digest)
);
CREATE TABLE IF NOT EXISTS reverse_leser_runtime_ereignisse (
 id UUID PRIMARY KEY,sequenz BIGSERIAL UNIQUE NOT NULL,
 request_key TEXT NOT NULL CHECK(request_key ~ '^[a-f0-9]{64}$'),
 payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
 phase TEXT NOT NULL CHECK(phase IN('begonnen','bereitgestellt','aktiviert','deaktiviert','fehler')),
 image_digest TEXT NOT NULL CHECK(image_digest ~ '^sha256:[a-f0-9]{64}$'),
 pin TEXT,basis_revision TEXT,akteur TEXT NOT NULL,grund TEXT NOT NULL,
 details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_key,phase),
 FOREIGN KEY(pin,image_digest) REFERENCES reverse_leser_runtime_images(pin,image_digest) ON DELETE RESTRICT,
 CHECK(phase NOT IN('bereitgestellt','aktiviert') OR pin IS NOT NULL),
 CHECK(phase<>'deaktiviert' OR pin IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_reverse_leser_runtime_standard ON reverse_leser_runtime_ereignisse(image_digest,sequenz DESC)
 WHERE phase IN('aktiviert','deaktiviert');
CREATE OR REPLACE FUNCTION reverse_leser_runtime_immutable() RETURNS trigger LANGUAGE plpgsql AS $runtime_immutable$
BEGIN RAISE EXCEPTION 'leser_runtime_unveraenderlich' USING ERRCODE='23514';END $runtime_immutable$;
DO $runtime_triggers$ DECLARE t TEXT;BEGIN
 FOREACH t IN ARRAY ARRAY['reverse_leser_runtimes','reverse_leser_runtime_images','reverse_leser_runtime_ereignisse'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=t::regclass AND tgname=t||'_immutable') THEN
   EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reverse_leser_runtime_immutable()',t||'_immutable',t);
  END IF;
 END LOOP;
END $runtime_triggers$;
ALTER TABLE reverse_leser_laeufe ADD COLUMN IF NOT EXISTS runtime_sha256 TEXT;
ALTER TABLE reverse_leser_laeufe ADD COLUMN IF NOT EXISTS runtime_image_digest TEXT;
ALTER TABLE reverse_leser_nachzug ADD COLUMN IF NOT EXISTS runtime_sha256 TEXT;
ALTER TABLE reverse_leser_nachzug ADD COLUMN IF NOT EXISTS runtime_image_digest TEXT;
DO $runtime_fks$ DECLARE t TEXT;BEGIN
 FOREACH t IN ARRAY ARRAY['reverse_leser_laeufe','reverse_leser_nachzug'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_runtime_paar') THEN
   EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK((runtime_sha256 IS NULL)=(runtime_image_digest IS NULL)) NOT VALID',t,t||'_runtime_paar');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=t::regclass AND conname=t||'_runtime_fk') THEN
   EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY(runtime_sha256,runtime_image_digest) REFERENCES reverse_leser_runtime_images(pin,image_digest) ON DELETE RESTRICT NOT VALID',t,t||'_runtime_fk');
  END IF;
 END LOOP;
END $runtime_fks$;
CREATE OR REPLACE FUNCTION reverse_leser_lauf_runtime_schuetzen() RETURNS trigger LANGUAGE plpgsql AS $runtime_lauf$
BEGIN
 IF ROW(NEW.runtime_sha256,NEW.runtime_image_digest) IS DISTINCT FROM ROW(OLD.runtime_sha256,OLD.runtime_image_digest) THEN
  RAISE EXCEPTION 'leser_runtime_laufpin_unveraenderlich' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $runtime_lauf$;
CREATE OR REPLACE FUNCTION reverse_leser_scan_runtime_schuetzen() RETURNS trigger LANGUAGE plpgsql AS $runtime_scan$
BEGIN
 IF ROW(NEW.runtime_sha256,NEW.runtime_image_digest) IS DISTINCT FROM ROW(OLD.runtime_sha256,OLD.runtime_image_digest)
  AND (NEW.scan_id=OLD.scan_id OR OLD.status='offen') THEN
  RAISE EXCEPTION 'leser_runtime_scanpin_unveraenderlich' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $runtime_scan$;
DO $runtime_pin_triggers$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='reverse_leser_laeufe'::regclass AND tgname='reverse_leser_lauf_runtime_guard') THEN
  CREATE TRIGGER reverse_leser_lauf_runtime_guard BEFORE UPDATE ON reverse_leser_laeufe FOR EACH ROW EXECUTE FUNCTION reverse_leser_lauf_runtime_schuetzen();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='reverse_leser_nachzug'::regclass AND tgname='reverse_leser_scan_runtime_guard') THEN
  CREATE TRIGGER reverse_leser_scan_runtime_guard BEFORE UPDATE ON reverse_leser_nachzug FOR EACH ROW EXECUTE FUNCTION reverse_leser_scan_runtime_schuetzen();
 END IF;
END $runtime_pin_triggers$;
