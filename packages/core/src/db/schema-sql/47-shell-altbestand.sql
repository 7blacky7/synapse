-- P10-T42: additive Marker für Shell-Altbestand, niemals Rohwerte.
CREATE TABLE IF NOT EXISTS shell_altbestand_gruppen (
 regelversion TEXT NOT NULL, gruppen_id TEXT NOT NULL,
 literal_hash TEXT NOT NULL, feld TEXT NOT NULL, schluessel TEXT NOT NULL, fundart TEXT NOT NULL,
 kontext TEXT NOT NULL, wertlaenge INTEGER NOT NULL CHECK(wertlaenge >= 0),
 bewertung TEXT NOT NULL CHECK(bewertung IN ('geheimnis','beispiel','falsch','offen')),
 confidence DOUBLE PRECISION CHECK(confidence >= 0 AND confidence <= 1),
 grund TEXT NOT NULL, markiert_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(regelversion,gruppen_id)
);
CREATE TABLE IF NOT EXISTS shell_altbestand_bezuege (
 regelversion TEXT NOT NULL, gruppen_id TEXT NOT NULL,
 tabelle TEXT NOT NULL CHECK(tabelle IN ('shell_jobs','tool_calls')), zeilen_id TEXT NOT NULL,
 project TEXT, pfad TEXT NOT NULL, quell_hash TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'markiert' CHECK(status IN ('markiert','maskiert','behalten','geaendert','offen')),
 maskiert INTEGER NOT NULL DEFAULT 0 CHECK(maskiert >= 0), markiert_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), maskiert_at TIMESTAMPTZ,
 PRIMARY KEY(regelversion,gruppen_id,tabelle,zeilen_id,pfad,quell_hash),
 FOREIGN KEY(regelversion,gruppen_id) REFERENCES shell_altbestand_gruppen(regelversion,gruppen_id)
);
CREATE INDEX IF NOT EXISTS idx_shell_altbestand_zeile ON shell_altbestand_bezuege(regelversion,tabelle,zeilen_id,status);
CREATE INDEX IF NOT EXISTS idx_shell_altbestand_project ON shell_altbestand_bezuege(project,status);

-- P10-T42 Trefferkontext v2: alte Bewertungen/Marker bleiben mit Regel legacy nachvollziehbar.
ALTER TABLE shell_altbestand_gruppen ADD COLUMN IF NOT EXISTS regel TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE shell_altbestand_gruppen ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE shell_altbestand_gruppen ADD COLUMN IF NOT EXISTS zeile INTEGER CHECK (zeile > 0);
ALTER TABLE shell_altbestand_gruppen ADD COLUMN IF NOT EXISTS fenster TEXT;
ALTER TABLE shell_altbestand_gruppen ADD COLUMN IF NOT EXISTS struktur TEXT;
ALTER TABLE shell_altbestand_gruppen ADD COLUMN IF NOT EXISTS konfiguration BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE shell_altbestand_gruppen ADD COLUMN IF NOT EXISTS literal_normales_wort BOOLEAN NOT NULL DEFAULT false;
