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
CREATE UNIQUE INDEX IF NOT EXISTS reverse_einstellungen_eindeutig ON reverse_einstellungen(ebene,(COALESCE(project,'')),name);
