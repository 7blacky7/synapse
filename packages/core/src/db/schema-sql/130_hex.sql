-- P21-T3/T13: Hex-Einstellungen und revisionsgebundene Fortsetzungen. Keine Dateibytes.
CREATE TABLE IF NOT EXISTS hex_einstellungen (
 ebene TEXT NOT NULL CHECK (ebene IN ('global','projekt')),
 project TEXT,
 name TEXT NOT NULL,
 wert BIGINT NOT NULL CHECK (wert > 0),
 grund TEXT NOT NULL,
 gesetzt_von TEXT NOT NULL,
 gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK ((ebene='global' AND project IS NULL) OR (ebene='projekt' AND project IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_hex_einstellungen ON hex_einstellungen(ebene,(COALESCE(project,'')),name);
CREATE TABLE IF NOT EXISTS hex_cursor (
 id UUID PRIMARY KEY,
 project TEXT NOT NULL,
 akteur TEXT NOT NULL,
 action TEXT NOT NULL,
 ref JSONB NOT NULL,
 position BIGINT NOT NULL CHECK (position >= 0),
 laenge INTEGER NOT NULL CHECK (laenge > 0),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_hex_cursor_ablauf ON hex_cursor(expires_at);
