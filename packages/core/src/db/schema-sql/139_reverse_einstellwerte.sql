-- P18-T86: Reverse-Einstellwerte (Spiegel der Struktur aus reverse-einstellwerte-schema.ts).
-- Katalogzeilen, Prueftrigger und Querbedingungen erzeugt ensureSchema aus dem TS-Katalog
-- (reverse-einstellkatalog.ts); hier steht bewusst keine zweite Liste von Standards oder Grenzen.
-- Review 028940c6/B4: idempotent wie der TS-Weg (Constraints nur, wenn sie noch fehlen).
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS uebernahme JSONB;
ALTER TABLE reverse_einstellungen ADD COLUMN IF NOT EXISTS eintrag_id TEXT REFERENCES reverse_eintraege(id) ON DELETE RESTRICT;
ALTER TABLE reverse_einstellungen ADD COLUMN IF NOT EXISTS wert_text TEXT;
ALTER TABLE reverse_einstellungen ALTER COLUMN wert DROP NOT NULL;
ALTER TABLE reverse_einstellungen DROP CONSTRAINT IF EXISTS reverse_einstellungen_ebene_check;
ALTER TABLE reverse_einstellungen DROP CONSTRAINT IF EXISTS reverse_einstellungen_wert_check;
ALTER TABLE reverse_einstellungen DROP CONSTRAINT IF EXISTS reverse_einstellungen_check;
DO $scope$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_einstellungen'::regclass AND conname='reverse_einstellungen_scope_v2') THEN
 ALTER TABLE reverse_einstellungen ADD CONSTRAINT reverse_einstellungen_scope_v2 CHECK (
 (ebene='global' AND project IS NULL AND eintrag_id IS NULL) OR
 (ebene='projekt' AND project IS NOT NULL AND eintrag_id IS NULL) OR
 (ebene='eintrag' AND project IS NULL AND eintrag_id IS NOT NULL));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_einstellungen'::regclass AND conname='reverse_einstellungen_wert_v2') THEN
 ALTER TABLE reverse_einstellungen ADD CONSTRAINT reverse_einstellungen_wert_v2 CHECK ((wert IS NULL)<>(wert_text IS NULL));
 END IF;
END $scope$;
DROP INDEX IF EXISTS reverse_einstellungen_eindeutig;
CREATE UNIQUE INDEX IF NOT EXISTS reverse_einstellungen_scope_name ON reverse_einstellungen(ebene,(COALESCE(project,'')),(COALESCE(eintrag_id,'')),name);
CREATE TABLE IF NOT EXISTS reverse_einstellkatalog(
 name TEXT PRIMARY KEY,typ TEXT NOT NULL,einheit TEXT NOT NULL,min BIGINT,max BIGINT,
 standard BIGINT,standard_text TEXT,werte TEXT[],ebenen TEXT[] NOT NULL);
ALTER TABLE reverse_einstellkatalog ADD COLUMN IF NOT EXISTS standard_text TEXT;
ALTER TABLE reverse_einstellkatalog ADD COLUMN IF NOT EXISTS werte TEXT[];
ALTER TABLE reverse_einstellkatalog ALTER COLUMN min DROP NOT NULL;
ALTER TABLE reverse_einstellkatalog ALTER COLUMN max DROP NOT NULL;
ALTER TABLE reverse_einstellkatalog ALTER COLUMN standard DROP NOT NULL;
ALTER TABLE reverse_einstellkatalog DROP CONSTRAINT IF EXISTS reverse_einstellkatalog_check;
DO $katalog$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_einstellkatalog'::regclass AND conname='reverse_einstellkatalog_typ_v2') THEN
 ALTER TABLE reverse_einstellkatalog ADD CONSTRAINT reverse_einstellkatalog_typ_v2 CHECK (
 (typ='enum' AND werte IS NOT NULL AND standard_text=ANY(werte) AND min IS NULL AND max IS NULL AND standard IS NULL) OR
 (typ IN ('integer','bigint') AND min<=standard AND standard<=max AND werte IS NULL AND standard_text IS NULL));
 END IF;
END $katalog$;
