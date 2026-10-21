-- P18-T44: configurable read-only code/file linking (product switch is in agent_profil_schalter).
CREATE TABLE IF NOT EXISTS reverse_einstellungen (
 ebene TEXT NOT NULL CHECK (ebene IN ('global','projekt')),
 project TEXT,
 name TEXT NOT NULL,
 wert BIGINT NOT NULL CHECK(wert>0 AND wert<=2147483647),
 grund TEXT NOT NULL,
 gesetzt_von TEXT NOT NULL,
 gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK ((ebene='global' AND project IS NULL) OR (ebene='projekt' AND project IS NOT NULL))
);
-- P18-T86: auch auf wiederholtem Schema-Lauf keine alte, zu enge Eindeutigkeit erzeugen.
ALTER TABLE reverse_einstellungen ADD COLUMN IF NOT EXISTS eintrag_id TEXT REFERENCES reverse_eintraege(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS reverse_einstellungen_scope_name ON reverse_einstellungen(ebene,(COALESCE(project,'')),(COALESCE(eintrag_id,'')),name);
