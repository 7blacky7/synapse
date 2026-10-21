-- P18-T84: Kuratierte Verweise sind keine wegwerfbaren Analysezeilen.
ALTER TABLE reverse_verweise ADD COLUMN IF NOT EXISTS ursprung TEXT NOT NULL DEFAULT 'analyse';
ALTER TABLE reverse_verweise ADD COLUMN IF NOT EXISTS erstellt_von TEXT;
ALTER TABLE reverse_verweise ADD COLUMN IF NOT EXISTS quellprojekt TEXT;
ALTER TABLE reverse_verweise ADD COLUMN IF NOT EXISTS anfrage_id TEXT;
ALTER TABLE reverse_verweise ADD COLUMN IF NOT EXISTS erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE reverse_verweise ALTER COLUMN datei_id DROP NOT NULL;
ALTER TABLE reverse_verweise ALTER COLUMN ordnung DROP NOT NULL;
ALTER TABLE reverse_verweise ALTER COLUMN target DROP NOT NULL;
ALTER TABLE reverse_verweise ALTER COLUMN aufloesung DROP NOT NULL;
DO $erkenntnis_constraints$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_verweise'::regclass AND conname='reverse_verweise_ursprung_check') THEN
  ALTER TABLE reverse_verweise ADD CONSTRAINT reverse_verweise_ursprung_check CHECK (
   (ursprung='analyse' AND datei_id IS NOT NULL AND ordnung IS NOT NULL AND target IS NOT NULL AND aufloesung IS NOT NULL)
   OR (ursprung='manuell' AND datei_id IS NULL AND ordnung IS NULL AND target IS NULL AND aufloesung IS NULL
       AND ziel_pfad IS NULL AND inspektor_resolved IS NULL AND kind='erkenntnis'
       AND erstellt_von IS NOT NULL AND quellprojekt IS NOT NULL AND anfrage_id IS NOT NULL));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_verweise'::regclass AND conname='reverse_verweise_eintrag_fkey') THEN
  ALTER TABLE reverse_verweise ADD CONSTRAINT reverse_verweise_eintrag_fkey FOREIGN KEY(eintrag_id) REFERENCES reverse_eintraege(id) ON DELETE RESTRICT;
 END IF;
END $erkenntnis_constraints$;
CREATE UNIQUE INDEX IF NOT EXISTS reverse_verweise_anfrage ON reverse_verweise(quellprojekt,anfrage_id) WHERE ursprung='manuell';
CREATE INDEX IF NOT EXISTS reverse_verweise_manuell ON reverse_verweise(eintrag_id,id) WHERE ursprung='manuell';
CREATE TABLE IF NOT EXISTS reverse_verweis_versionen (
 verweis_id BIGINT NOT NULL REFERENCES reverse_verweise(id) ON DELETE RESTRICT,
 version INTEGER NOT NULL CHECK(version>0),
 schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1),
 titel TEXT NOT NULL, kategorie TEXT NOT NULL,
 inhalt JSONB NOT NULL CHECK(jsonb_typeof(inhalt)='object'),
 canonical_hash TEXT NOT NULL CHECK(canonical_hash ~ '^[a-f0-9]{64}$'),
 anfrage_id TEXT NOT NULL, autor TEXT NOT NULL, quellprojekt TEXT NOT NULL,
 task_ref JSONB, erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(verweis_id,version), UNIQUE(verweis_id,quellprojekt,anfrage_id)
);
-- Kein privilegierter GUC-Bypass: auch der Erkenntnisdienst haengt nur Versionen an.
CREATE OR REPLACE FUNCTION reverse_manuell_unveraenderlich() RETURNS TRIGGER LANGUAGE plpgsql AS $erkenntnis_guard$
BEGIN
 IF TG_OP='TRUNCATE' THEN
  RAISE EXCEPTION 'reverse_erkenntnisse_truncate_verboten';
 END IF;
 IF TG_TABLE_NAME='reverse_verweis_versionen' THEN
  RAISE EXCEPTION 'reverse_erkenntnis_unveraenderlich';
 END IF;
 IF OLD.ursprung='manuell' THEN
  RAISE EXCEPTION 'reverse_erkenntnis_unveraenderlich';
 END IF;
 IF TG_OP='UPDATE' AND NEW.ursprung IS DISTINCT FROM OLD.ursprung THEN
  RAISE EXCEPTION 'reverse_verweis_ursprung_unveraenderlich';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $erkenntnis_guard$;
CREATE OR REPLACE TRIGGER reverse_manuell_guard BEFORE UPDATE OR DELETE ON reverse_verweise
 FOR EACH ROW EXECUTE FUNCTION reverse_manuell_unveraenderlich();
CREATE OR REPLACE TRIGGER reverse_manuell_truncate_guard BEFORE TRUNCATE ON reverse_verweise
 FOR EACH STATEMENT EXECUTE FUNCTION reverse_manuell_unveraenderlich();
CREATE OR REPLACE TRIGGER reverse_version_guard BEFORE UPDATE OR DELETE ON reverse_verweis_versionen
 FOR EACH ROW EXECUTE FUNCTION reverse_manuell_unveraenderlich();
CREATE OR REPLACE TRIGGER reverse_version_truncate_guard BEFORE TRUNCATE ON reverse_verweis_versionen
 FOR EACH STATEMENT EXECUTE FUNCTION reverse_manuell_unveraenderlich();
CREATE OR REPLACE FUNCTION reverse_erkenntnis_version_pruefen() RETURNS TRIGGER LANGUAGE plpgsql AS $erkenntnis_version$
DECLARE herkunft TEXT; letzte INTEGER;
BEGIN
 SELECT ursprung INTO herkunft FROM reverse_verweise WHERE id=NEW.verweis_id FOR UPDATE;
 IF herkunft IS DISTINCT FROM 'manuell' THEN RAISE EXCEPTION 'reverse_erkenntnis_verweis_falsch'; END IF;
 SELECT COALESCE(max(version),0) INTO letzte FROM reverse_verweis_versionen WHERE verweis_id=NEW.verweis_id;
 IF NEW.version<>letzte+1 THEN RAISE EXCEPTION 'reverse_erkenntnis_versionskonflikt'; END IF;
 RETURN NEW;
END $erkenntnis_version$;
CREATE OR REPLACE TRIGGER reverse_version_insert_guard BEFORE INSERT ON reverse_verweis_versionen
 FOR EACH ROW EXECUTE FUNCTION reverse_erkenntnis_version_pruefen();
ALTER TABLE hex_format_freigaben ADD COLUMN IF NOT EXISTS bereich TEXT NOT NULL DEFAULT 'global';
ALTER TABLE hex_format_freigaben ADD COLUMN IF NOT EXISTS eintrag_id TEXT REFERENCES reverse_eintraege(id) ON DELETE RESTRICT;
ALTER TABLE hex_format_freigaben DROP CONSTRAINT IF EXISTS hex_format_freigaben_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS hex_format_freigaben_global ON hex_format_freigaben(format_id,version) WHERE eintrag_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hex_format_freigaben_reverse ON hex_format_freigaben(format_id,version,eintrag_id) WHERE eintrag_id IS NOT NULL;
DO $format_scope$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='hex_format_freigaben'::regclass AND conname='hex_format_freigaben_bereich_check') THEN
  ALTER TABLE hex_format_freigaben ADD CONSTRAINT hex_format_freigaben_bereich_check CHECK (
   (bereich='global' AND eintrag_id IS NULL) OR (bereich='reverse' AND eintrag_id IS NOT NULL));
 END IF;
END $format_scope$;
