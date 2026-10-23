/** P18-T109; Spiegel von schema-sql/146_reverse_fehlerlog.sql. */
export const REVERSE_FEHLERLOG_SCHEMA_SQL = `-- P18-T109 Teil 3: zentrales Reverse-Fehlerlog (nur Flüchtiges; Rest wird lesend abgeleitet). Kein FK.
CREATE TABLE IF NOT EXISTS reverse_fehlerlog (
 id BIGSERIAL PRIMARY KEY, schluessel TEXT NOT NULL UNIQUE,
 eintrag_id TEXT, datei TEXT, schicht TEXT, komponente TEXT NOT NULL, name TEXT, grund TEXT NOT NULL, detail TEXT, quelle TEXT NOT NULL,
 anzahl INTEGER NOT NULL DEFAULT 1, zuerst_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), zuletzt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reverse_fehlerlog_eintrag ON reverse_fehlerlog(eintrag_id,zuletzt_at DESC);
`;
