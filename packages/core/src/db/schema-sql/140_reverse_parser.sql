-- P18-T95 Teil 1: additive Reverse-Parser-Generationen; keine Nutzdatenbereinigung.
CREATE TABLE IF NOT EXISTS reverse_parser_generationen (
 id TEXT PRIMARY KEY, eintrag_id TEXT NOT NULL, datei_id BIGINT NOT NULL,
 schicht TEXT NOT NULL CHECK(schicht IN ('S1','S2','S3')),
 quell_sha256 TEXT NOT NULL, quell_fingerabdruck TEXT NOT NULL,
 adapter_fingerabdruck TEXT NOT NULL, adapter_version TEXT NOT NULL,
 einstellungen_revision TEXT NOT NULL, auftrag_id UUID NOT NULL,
 status TEXT NOT NULL DEFAULT 'laeuft' CHECK(status IN ('laeuft','fertig','teilweise')),
 aktuell BOOLEAN NOT NULL DEFAULT FALSE, checkpoint BIGINT NOT NULL DEFAULT 0 CHECK(checkpoint>=0),
 diagnose JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), beendet_at TIMESTAMPTZ,
 UNIQUE(id,eintrag_id,datei_id), UNIQUE(eintrag_id,datei_id,schicht,adapter_fingerabdruck),
 FOREIGN KEY(datei_id,eintrag_id) REFERENCES reverse_dateien(id,eintrag_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_parser_aktuell ON reverse_parser_generationen(eintrag_id,datei_id,schicht) WHERE aktuell;
CREATE TABLE IF NOT EXISTS reverse_code_abbildungen (
 id TEXT PRIMARY KEY, eintrag_id TEXT NOT NULL, datei_id BIGINT NOT NULL,
 parser_generation_id TEXT NOT NULL, file_path TEXT NOT NULL,
 byte_start BIGINT NOT NULL CHECK(byte_start>=0), byte_ende BIGINT NOT NULL CHECK(byte_ende>=byte_start),
 kodierung TEXT NOT NULL, praezision TEXT NOT NULL, fundstelle JSONB NOT NULL,
 FOREIGN KEY(parser_generation_id,eintrag_id,datei_id) REFERENCES reverse_parser_generationen(id,eintrag_id,datei_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_reverse_code_abbildung ON reverse_code_abbildungen(eintrag_id,datei_id,parser_generation_id,file_path);
ALTER TABLE reverse_code_dateien ADD COLUMN IF NOT EXISTS parser_generation_id TEXT;
ALTER TABLE reverse_code_dateien ADD COLUMN IF NOT EXISTS fundstelle JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $fk$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_code_dateien'::regclass AND conname='reverse_dateien_parser_generation_fk') THEN
 ALTER TABLE reverse_code_dateien ADD CONSTRAINT reverse_dateien_parser_generation_fk FOREIGN KEY(parser_generation_id,eintrag_id,datei_id)
 REFERENCES reverse_parser_generationen(id,eintrag_id,datei_id) ON DELETE RESTRICT;
 END IF;
END $fk$;
ALTER TABLE reverse_code_symbole ADD COLUMN IF NOT EXISTS parser_generation_id TEXT;
ALTER TABLE reverse_code_symbole ADD COLUMN IF NOT EXISTS fundstelle JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $fk$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_code_symbole'::regclass AND conname='reverse_symbole_parser_generation_fk') THEN
 ALTER TABLE reverse_code_symbole ADD CONSTRAINT reverse_symbole_parser_generation_fk FOREIGN KEY(parser_generation_id,eintrag_id,datei_id)
 REFERENCES reverse_parser_generationen(id,eintrag_id,datei_id) ON DELETE RESTRICT;
 END IF;
END $fk$;
ALTER TABLE reverse_code_verweise ADD COLUMN IF NOT EXISTS parser_generation_id TEXT;
ALTER TABLE reverse_code_verweise ADD COLUMN IF NOT EXISTS fundstelle JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $fk$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_code_verweise'::regclass AND conname='reverse_verweise_parser_generation_fk') THEN
 ALTER TABLE reverse_code_verweise ADD CONSTRAINT reverse_verweise_parser_generation_fk FOREIGN KEY(parser_generation_id,eintrag_id,datei_id)
 REFERENCES reverse_parser_generationen(id,eintrag_id,datei_id) ON DELETE RESTRICT;
 END IF;
END $fk$;
ALTER TABLE reverse_code_statements ADD COLUMN IF NOT EXISTS parser_generation_id TEXT;
ALTER TABLE reverse_code_statements ADD COLUMN IF NOT EXISTS fundstelle JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $fk$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_code_statements'::regclass AND conname='reverse_statements_parser_generation_fk') THEN
 ALTER TABLE reverse_code_statements ADD CONSTRAINT reverse_statements_parser_generation_fk FOREIGN KEY(parser_generation_id,eintrag_id,datei_id)
 REFERENCES reverse_parser_generationen(id,eintrag_id,datei_id) ON DELETE RESTRICT;
 END IF;
END $fk$;
ALTER TABLE reverse_code_kanten ADD COLUMN IF NOT EXISTS parser_generation_id TEXT;
ALTER TABLE reverse_code_kanten ADD COLUMN IF NOT EXISTS fundstelle JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $fk$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_code_kanten'::regclass AND conname='reverse_kanten_parser_generation_fk') THEN
 ALTER TABLE reverse_code_kanten ADD CONSTRAINT reverse_kanten_parser_generation_fk FOREIGN KEY(parser_generation_id,eintrag_id,datei_id)
 REFERENCES reverse_parser_generationen(id,eintrag_id,datei_id) ON DELETE RESTRICT;
 END IF;
END $fk$;
