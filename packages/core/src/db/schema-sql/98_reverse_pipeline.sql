-- RV8/P18-T18: dauerhafte API-Leases und ausschließlich maskierter Ergebnis-Cache.
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS fingerabdruck TEXT;
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS ziel_schicht TEXT;
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS projekt TEXT;
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS ausfuehrung TEXT NOT NULL DEFAULT 'container';
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS lease_token UUID;
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS lease_bis TIMESTAMPTZ;
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS werkzeug TEXT;
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS werkzeug_version TEXT;
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS profil_version TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_pipeline_aktiv ON reverse_auftraege
 (eintrag_id,COALESCE(datei_id,0),COALESCE(medium_id,0),schicht,ausfuehrung)
 WHERE status IN ('offen','wartet','laeuft');
CREATE INDEX IF NOT EXISTS idx_reverse_pipeline_claim ON reverse_auftraege(ausfuehrung,status,prioritaet,created_at);
ALTER TABLE reverse_medien ADD COLUMN IF NOT EXISTS pipeline_gesehen_at TIMESTAMPTZ;
ALTER TABLE reverse_dateien ADD COLUMN IF NOT EXISTS pipeline_gesehen_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS reverse_analyse_cache (
 fingerabdruck TEXT PRIMARY KEY, sha256 TEXT NOT NULL, schicht TEXT NOT NULL,
 werkzeug TEXT NOT NULL, werkzeug_version TEXT NOT NULL, profil_version TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'wartet' CHECK(status IN ('wartet','laeuft','fertig','teilweise','fehler')),
 ergebnis JSONB, lease_token UUID, lease_bis TIMESTAMPTZ, versuche INTEGER NOT NULL DEFAULT 0,
 fehlercode TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK(sha256 ~ '^[a-f0-9]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_reverse_analyse_cache_sha ON reverse_analyse_cache(sha256,schicht,werkzeug_version,profil_version);
ALTER TABLE reverse_analyse_cache ADD COLUMN IF NOT EXISTS p20_auftrag_id UUID REFERENCES work_jobs(id) ON DELETE RESTRICT;
ALTER TABLE reverse_analyse_cache ADD COLUMN IF NOT EXISTS quell_auftrag_id UUID REFERENCES reverse_auftraege(id) ON DELETE SET NULL;
