-- P10-T61: von Hand gepflegte Strukturspiegelung aus schema.ts/topf-namen-schema.ts.
-- Kein Bestands-Nachtrag; fuer Aufbau einer leeren DB. ensureSchema bleibt der Migrationsweg.
CREATE TABLE IF NOT EXISTS erklaerungen (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennung TEXT UNIQUE,
  familie TEXT NOT NULL,
  schluessel TEXT,
  lage_de TEXT,
  wieso_de TEXT,
  abhilfe_de TEXT,
  lage_en TEXT,
  wieso_en TEXT,
  abhilfe_en TEXT,
  status TEXT NOT NULL DEFAULT 'vorgeschlagen' CHECK (status IN ('vorgeschlagen', 'verifiziert', 'stillgelegt')),
  status_grund TEXT,
  gewaehlt_n INTEGER NOT NULL DEFAULT 0,
  verifiziert_n INTEGER NOT NULL DEFAULT 0,
  passt_nicht_n INTEGER NOT NULL DEFAULT 0,
  verifiziert_am TIMESTAMPTZ,
  erstellt_von TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geaendert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (lage_de IS NOT NULL OR lage_en IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_erklaerungen_familie ON erklaerungen(familie, status);

CREATE TABLE IF NOT EXISTS jev_entscheidungstopf (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kennung TEXT UNIQUE,
  herkunft_projekt TEXT,
  themen TEXT[] NOT NULL DEFAULT '{}',
  kategorie TEXT NOT NULL,
  kandidat BOOLEAN NOT NULL DEFAULT true,
  frage_de TEXT,
  frage_en TEXT,
  optionen JSONB,
  gewaehlte_option TEXT,
  kontext TEXT,
  antwort_wortlaut TEXT NOT NULL,
  wortlaut_rekonstruiert BOOLEAN NOT NULL DEFAULT false,
  aufbereitet_de JSONB,
  aufbereitet_en JSONB,
  herkunft TEXT NOT NULL CHECK (herkunft IN ('tool', 'thought', 'seed', 'korrektur', 'chat', 'ask_user_question')),
  quelle_ref TEXT,
  status TEXT NOT NULL DEFAULT 'roh' CHECK (status IN ('roh', 'aktiv', 'ersetzt', 'stillgelegt')),
  ersetzt_durch UUID,
  status_grund TEXT,
  gewaehlt_n INTEGER NOT NULL DEFAULT 0,
  bestaetigt_n INTEGER NOT NULL DEFAULT 0,
  korrigiert_n INTEGER NOT NULL DEFAULT 0,
  embedding_en REAL[],
  embedding_modell TEXT,
  erfasst_von TEXT,
  aufbereitet_von TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  geaendert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (frage_de IS NOT NULL OR frage_en IS NOT NULL),
  CHECK (status <> 'aktiv' OR aufbereitet_de IS NOT NULL OR aufbereitet_en IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_jev_entscheidungstopf_status ON jev_entscheidungstopf(status, kategorie);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jev_entscheidungstopf_thought ON jev_entscheidungstopf(quelle_ref) WHERE herkunft = 'thought';
CREATE TABLE IF NOT EXISTS topf_namen (
  name TEXT PRIMARY KEY,
  topf TEXT NOT NULL CHECK (topf IN ('entscheidung', 'erklaerung')),
  eintrag_id UUID NOT NULL,
  UNIQUE (topf, eintrag_id)
);
CREATE OR REPLACE FUNCTION pflege_topf_namen() RETURNS trigger LANGUAGE plpgsql AS $topf_trigger$
DECLARE
  art text := CASE TG_TABLE_NAME WHEN 'erklaerungen' THEN 'erklaerung' ELSE 'entscheidung' END;
  registriert text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('DELETE FROM %I.topf_namen WHERE topf = $1 AND eintrag_id = $2', TG_TABLE_SCHEMA)
      USING art, OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.kennung IS DISTINCT FROM NEW.kennung OR OLD.id IS DISTINCT FROM NEW.id THEN
      EXECUTE format('DELETE FROM %I.topf_namen WHERE topf = $1 AND eintrag_id = $2', TG_TABLE_SCHEMA)
        USING art, OLD.id;
    END IF;
  END IF;
  IF NEW.kennung IS NOT NULL THEN
    EXECUTE format(
      'INSERT INTO %I.topf_namen AS r(name,topf,eintrag_id) VALUES($1,$2,$3)
       ON CONFLICT(name) DO UPDATE SET name = EXCLUDED.name
       WHERE r.topf = EXCLUDED.topf AND r.eintrag_id = EXCLUDED.eintrag_id RETURNING name', TG_TABLE_SCHEMA)
      INTO registriert USING NEW.kennung, art, NEW.id;
    IF registriert IS NULL THEN
      RAISE EXCEPTION 'Topf-Name "%" bereits vergeben', NEW.kennung USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END $topf_trigger$;
CREATE OR REPLACE TRIGGER topf_namen_pflegen AFTER INSERT OR UPDATE OF kennung, id OR DELETE
 ON erklaerungen FOR EACH ROW EXECUTE FUNCTION pflege_topf_namen();
CREATE OR REPLACE TRIGGER topf_namen_pflegen AFTER INSERT OR UPDATE OF kennung, id OR DELETE
 ON jev_entscheidungstopf FOR EACH ROW EXECUTE FUNCTION pflege_topf_namen();
