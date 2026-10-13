/** P18-T13: additive Reverse-Tabellen; SQL-Spiegel 97_reverse.sql. */
export const REVERSE_SCHEMA_SQL = `
-- P18-T13/RV3: Reverse-Bibliothek. Nur Metadaten und maskierter Analysetext.
-- Originalbytes bleiben unter SYNAPSE_REVERSE_ROOT; storage_key ist relativ.
CREATE TABLE IF NOT EXISTS reverse_eintraege (
 id TEXT PRIMARY KEY, titel TEXT NOT NULL, beschreibung TEXT,
 status TEXT NOT NULL DEFAULT 'vorschlag' CHECK(status IN ('vorschlag','bestaetigt','archiviert')),
 gruppierung TEXT, fingerabdruck TEXT, analyse_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
 tags TEXT[] NOT NULL DEFAULT '{}', erstellt_von TEXT, bestaetigt_von TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 archiviert_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_bestaetigt ON reverse_eintraege(fingerabdruck) WHERE status='bestaetigt';
CREATE TABLE IF NOT EXISTS reverse_medien (
 id BIGSERIAL PRIMARY KEY, eintrag_id TEXT NOT NULL REFERENCES reverse_eintraege(id) ON DELETE RESTRICT,
 position INTEGER NOT NULL, bezeichnung TEXT, art TEXT NOT NULL, satz_sha256 TEXT, groesse BIGINT,
 status TEXT NOT NULL DEFAULT 'eingang' CHECK(status IN ('eingang','vollstaendig','unvollstaendig','fehler')),
 fehlercode TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(eintrag_id,position),
 UNIQUE(id,eintrag_id)
);
CREATE TABLE IF NOT EXISTS reverse_medien_dateien (
 id BIGSERIAL PRIMARY KEY, medium_id BIGINT NOT NULL REFERENCES reverse_medien(id) ON DELETE RESTRICT,
 rolle TEXT NOT NULL CHECK(rolle IN ('haupt','begleit')), original_name TEXT NOT NULL,
 sha256 TEXT NOT NULL, groesse BIGINT NOT NULL CHECK(groesse>=0), storage_key TEXT NOT NULL,
 upload_id UUID REFERENCES asset_upload_sitzungen(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(sha256,medium_id),
 CHECK(storage_key<>'' AND storage_key !~ '^/' AND storage_key !~ '(^|/)[.]{1,2}(/|$)' AND position(chr(92) in storage_key)=0)
);
CREATE INDEX IF NOT EXISTS idx_reverse_medien_dateien_medium ON reverse_medien_dateien(medium_id);
CREATE INDEX IF NOT EXISTS idx_reverse_medien_dateien_upload ON reverse_medien_dateien(upload_id);
CREATE TABLE IF NOT EXISTS reverse_fundstellen (
 id BIGSERIAL PRIMARY KEY, quelle TEXT NOT NULL CHECK(quelle IN ('tray','unraid_eingang','tool')),
 host_id TEXT NOT NULL, rel_pfad TEXT NOT NULL, sha256 TEXT, groesse BIGINT, mtime TIMESTAMPTZ,
 zuletzt_gesehen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 status TEXT NOT NULL DEFAULT 'gesehen' CHECK(status IN ('gesehen','fehlt','geloescht_lokal')),
 medien_datei_id BIGINT REFERENCES reverse_medien_dateien(id) ON DELETE SET NULL,
 UNIQUE(quelle,host_id,rel_pfad)
);
CREATE INDEX IF NOT EXISTS idx_reverse_fundstellen_sha ON reverse_fundstellen(sha256);
CREATE INDEX IF NOT EXISTS idx_reverse_fundstellen_datei ON reverse_fundstellen(medien_datei_id);
CREATE TABLE IF NOT EXISTS reverse_dateien (
 id BIGSERIAL PRIMARY KEY, eintrag_id TEXT NOT NULL REFERENCES reverse_eintraege(id) ON DELETE RESTRICT,
 medium_id BIGINT NOT NULL, eltern_id BIGINT,
 pfad TEXT NOT NULL, sha256 TEXT, groesse BIGINT NOT NULL DEFAULT 0 CHECK(groesse>=0),
 format TEXT, arch TEXT, bits INTEGER,
 art TEXT NOT NULL CHECK(art IN ('binaer','asset','text','archiv','sonstig')),
 storage_key TEXT, entpackt_mit TEXT, metadaten JSONB NOT NULL DEFAULT '{}'::jsonb,
 status TEXT NOT NULL DEFAULT 'offen', leser_plugin TEXT, leser_version TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(eintrag_id,pfad), UNIQUE(id,eintrag_id),
 FOREIGN KEY(medium_id,eintrag_id) REFERENCES reverse_medien(id,eintrag_id) ON DELETE RESTRICT,
 FOREIGN KEY(eltern_id,eintrag_id) REFERENCES reverse_dateien(id,eintrag_id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
 CHECK(storage_key IS NULL OR (storage_key<>'' AND storage_key !~ '^/' AND storage_key !~ '(^|/)[.]{1,2}(/|$)' AND position(chr(92) in storage_key)=0))
);
CREATE INDEX IF NOT EXISTS idx_reverse_dateien_sha ON reverse_dateien(sha256);
CREATE INDEX IF NOT EXISTS idx_reverse_dateien_medium ON reverse_dateien(medium_id);
CREATE INDEX IF NOT EXISTS idx_reverse_dateien_eltern ON reverse_dateien(eltern_id);
CREATE TABLE IF NOT EXISTS reverse_objekte (
 id BIGSERIAL PRIMARY KEY, datei_id BIGINT NOT NULL, eintrag_id TEXT NOT NULL,
 ordnung INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT, data JSONB NOT NULL DEFAULT '{}'::jsonb,
 byte_offset BIGINT, byte_length BIGINT, line_start INTEGER, line_end INTEGER,
 FOREIGN KEY(datei_id,eintrag_id) REFERENCES reverse_dateien(id,eintrag_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reverse_objekte_datei ON reverse_objekte(datei_id,ordnung);
CREATE INDEX IF NOT EXISTS idx_reverse_objekte_kind ON reverse_objekte(eintrag_id,kind);
CREATE INDEX IF NOT EXISTS idx_reverse_objekte_name ON reverse_objekte USING gin(name gin_trgm_ops);
CREATE TABLE IF NOT EXISTS reverse_verweise (
 id BIGSERIAL PRIMARY KEY, datei_id BIGINT NOT NULL, eintrag_id TEXT NOT NULL,
 ordnung INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, ziel_pfad TEXT,
 aufloesung TEXT NOT NULL CHECK(aufloesung IN ('datei','fehlt','intern','extern','eingebettet','ausserhalb','unbekannt')),
 inspektor_resolved BOOLEAN,
 FOREIGN KEY(datei_id,eintrag_id) REFERENCES reverse_dateien(id,eintrag_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reverse_verweise_datei ON reverse_verweise(datei_id,ordnung);
CREATE INDEX IF NOT EXISTS idx_reverse_verweise_ziel ON reverse_verweise(eintrag_id,ziel_pfad);
CREATE INDEX IF NOT EXISTS idx_reverse_verweise_target ON reverse_verweise USING gin(target gin_trgm_ops);
CREATE TABLE IF NOT EXISTS reverse_auftraege (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 eintrag_id TEXT NOT NULL REFERENCES reverse_eintraege(id) ON DELETE RESTRICT,
 medium_id BIGINT, datei_id BIGINT, schicht TEXT NOT NULL CHECK(schicht IN ('E','S0','S1','S2','S3')),
 prioritaet TEXT NOT NULL DEFAULT 'hintergrund' CHECK(prioritaet IN ('interaktiv','hintergrund','nachzug')),
 status TEXT NOT NULL DEFAULT 'offen', ausloeser TEXT, p20_auftrag_id UUID,
 versuch INTEGER NOT NULL DEFAULT 0, fehlercode TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(medium_id,eintrag_id) REFERENCES reverse_medien(id,eintrag_id) ON DELETE RESTRICT,
 FOREIGN KEY(datei_id,eintrag_id) REFERENCES reverse_dateien(id,eintrag_id) ON DELETE RESTRICT,
 CHECK(medium_id IS NOT NULL OR datei_id IS NOT NULL)
);
-- P20 kann in anderer Reihenfolge landen; bei jedem Start idempotent nachziehen.
DO $reverse_work_fk$ BEGIN
 IF to_regclass('work_jobs') IS NOT NULL AND NOT EXISTS(
  SELECT 1 FROM pg_constraint WHERE conrelid='reverse_auftraege'::regclass AND conname='reverse_auftraege_p20_fkey'
 ) THEN
  ALTER TABLE reverse_auftraege ADD CONSTRAINT reverse_auftraege_p20_fkey FOREIGN KEY(p20_auftrag_id) REFERENCES work_jobs(id) ON DELETE RESTRICT;
 END IF;
END $reverse_work_fk$;
CREATE INDEX IF NOT EXISTS idx_reverse_auftraege_p20 ON reverse_auftraege(p20_auftrag_id);
CREATE INDEX IF NOT EXISTS idx_reverse_auftraege_status ON reverse_auftraege(eintrag_id,status,created_at);
CREATE TABLE IF NOT EXISTS reverse_schichten (
 id BIGSERIAL PRIMARY KEY, datei_id BIGINT REFERENCES reverse_dateien(id) ON DELETE CASCADE,
 medium_id BIGINT REFERENCES reverse_medien(id) ON DELETE RESTRICT,
 schicht TEXT NOT NULL CHECK(schicht IN ('E','S0','S1','S2','S3')),
 fingerabdruck TEXT NOT NULL, aktuell BOOLEAN NOT NULL DEFAULT TRUE,
 status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','wartet','laeuft','fertig','teilweise','fehler','uebersprungen','nicht_unterstuetzt')),
 fehlercode TEXT, werkzeug TEXT, werkzeug_version TEXT, profil_version TEXT,
 auftrag_id UUID REFERENCES reverse_auftraege(id) ON DELETE SET NULL,
 funktionen_gesamt INTEGER, funktionen_fertig INTEGER, dauer_ms BIGINT, ausgabe_key TEXT,
 gestartet_at TIMESTAMPTZ, beendet_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(datei_id,schicht,fingerabdruck),
 CHECK(datei_id IS NOT NULL OR (schicht='E' AND medium_id IS NOT NULL)),
 CHECK(ausgabe_key IS NULL OR (ausgabe_key<>'' AND ausgabe_key !~ '^/' AND ausgabe_key !~ '(^|/)[.]{1,2}(/|$)' AND position(chr(92) in ausgabe_key)=0))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_schicht_aktuell ON reverse_schichten(datei_id,schicht) WHERE aktuell;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_schicht_medium ON reverse_schichten(medium_id,schicht,fingerabdruck) WHERE datei_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_schicht_medium_aktuell ON reverse_schichten(medium_id,schicht) WHERE aktuell AND datei_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_reverse_schichten_retention ON reverse_schichten(beendet_at,created_at) WHERE NOT aktuell;
CREATE INDEX IF NOT EXISTS idx_reverse_schichten_auftrag ON reverse_schichten(auftrag_id);

-- Maskierter Analysetext mit den bestehenden CodeIntel-Spaltennamen.
-- KEIN synapse_code_file_change-Trigger und kein PG->FS-Sync.
CREATE TABLE IF NOT EXISTS reverse_code_dateien (
 id TEXT PRIMARY KEY, eintrag_id TEXT NOT NULL REFERENCES reverse_eintraege(id) ON DELETE RESTRICT,
 file_path TEXT NOT NULL, file_name TEXT NOT NULL, file_type TEXT NOT NULL,
 chunk_count INTEGER DEFAULT 0, file_size INTEGER DEFAULT 0,
 indexed_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
 content TEXT, content_hash TEXT, parsed_at TIMESTAMPTZ, tsv TSVECTOR, tsv_zerlegt TSVECTOR,
 deleted_at TIMESTAMPTZ, parser_version INTEGER, ignored BOOLEAN NOT NULL DEFAULT FALSE,
 datei_id BIGINT NOT NULL, schicht TEXT NOT NULL, fingerabdruck TEXT NOT NULL,
 adresse BIGINT, groesse_bytes BIGINT,
 UNIQUE(eintrag_id,file_path),
 FOREIGN KEY(datei_id,eintrag_id) REFERENCES reverse_dateien(id,eintrag_id) ON DELETE CASCADE,
 CHECK(schicht IN ('S0','S1','S2','S3'))
);
CREATE INDEX IF NOT EXISTS idx_reverse_code_dateien_tsv ON reverse_code_dateien USING gin(tsv);
CREATE INDEX IF NOT EXISTS idx_reverse_code_dateien_zerlegt ON reverse_code_dateien USING gin(tsv_zerlegt);
CREATE INDEX IF NOT EXISTS idx_reverse_code_dateien_hash ON reverse_code_dateien(eintrag_id,content_hash);
CREATE INDEX IF NOT EXISTS idx_reverse_code_dateien_datei ON reverse_code_dateien(datei_id,schicht,fingerabdruck);
CREATE TABLE IF NOT EXISTS reverse_code_symbole (
 id TEXT PRIMARY KEY, eintrag_id TEXT NOT NULL, file_path TEXT NOT NULL,
 symbol_type TEXT NOT NULL, name TEXT, value TEXT, line_start INTEGER NOT NULL, line_end INTEGER,
 parent_symbol TEXT REFERENCES reverse_code_symbole(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 params TEXT[], return_type TEXT, is_exported BOOLEAN DEFAULT FALSE, usage_count INTEGER DEFAULT 0,
 created_at TIMESTAMPTZ DEFAULT NOW(), datei_id BIGINT REFERENCES reverse_dateien(id) ON DELETE CASCADE,
 schicht TEXT, fingerabdruck TEXT, adresse BIGINT, groesse_bytes BIGINT,
 FOREIGN KEY(eintrag_id,file_path) REFERENCES reverse_code_dateien(eintrag_id,file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_reverse_code_symbole_typ_name ON reverse_code_symbole(eintrag_id,symbol_type,name);
CREATE INDEX IF NOT EXISTS idx_reverse_code_symbole_file ON reverse_code_symbole(eintrag_id,file_path);
CREATE INDEX IF NOT EXISTS idx_reverse_code_symbole_parent ON reverse_code_symbole(parent_symbol);
CREATE TABLE IF NOT EXISTS reverse_code_verweise (
 id TEXT PRIMARY KEY, eintrag_id TEXT NOT NULL,
 symbol_id TEXT NOT NULL REFERENCES reverse_code_symbole(id) ON DELETE CASCADE,
 file_path TEXT NOT NULL, line_number INTEGER NOT NULL, context TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
 datei_id BIGINT REFERENCES reverse_dateien(id) ON DELETE CASCADE, schicht TEXT, fingerabdruck TEXT,
 adresse BIGINT, groesse_bytes BIGINT,
 FOREIGN KEY(eintrag_id,file_path) REFERENCES reverse_code_dateien(eintrag_id,file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_reverse_code_verweise_symbol ON reverse_code_verweise(symbol_id);
CREATE INDEX IF NOT EXISTS idx_reverse_code_verweise_file ON reverse_code_verweise(eintrag_id,file_path);
CREATE TABLE IF NOT EXISTS reverse_code_statements (
 id BIGSERIAL PRIMARY KEY, eintrag_id TEXT NOT NULL, file_path TEXT NOT NULL, scope_type TEXT, scope_name TEXT,
 statement_type TEXT NOT NULL, node_kind TEXT, line_start INTEGER NOT NULL, line_end INTEGER,
 order_index INTEGER NOT NULL, depth INTEGER NOT NULL DEFAULT 0,
 parent_statement_id BIGINT REFERENCES reverse_code_statements(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 text TEXT, callee TEXT, receiver TEXT, assigned_to TEXT, condition_text TEXT,
 is_top_level BOOLEAN NOT NULL DEFAULT FALSE, is_awaited BOOLEAN NOT NULL DEFAULT FALSE,
 metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW(),
 datei_id BIGINT REFERENCES reverse_dateien(id) ON DELETE CASCADE, schicht TEXT, fingerabdruck TEXT,
 adresse BIGINT, groesse_bytes BIGINT,
 FOREIGN KEY(eintrag_id,file_path) REFERENCES reverse_code_dateien(eintrag_id,file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_reverse_code_statements_scope ON reverse_code_statements(eintrag_id,file_path,scope_name);
CREATE INDEX IF NOT EXISTS idx_reverse_code_statements_parent ON reverse_code_statements(parent_statement_id);
CREATE TABLE IF NOT EXISTS reverse_code_kanten (
 id BIGSERIAL PRIMARY KEY, eintrag_id TEXT NOT NULL, file_path TEXT NOT NULL, caller_scope TEXT,
 statement_id BIGINT REFERENCES reverse_code_statements(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 callee_name TEXT NOT NULL, callee_receiver TEXT,
 target_symbol_id TEXT REFERENCES reverse_code_symbole(id) ON DELETE SET NULL,
 line_number INTEGER NOT NULL, call_kind TEXT, confidence REAL DEFAULT 1.0, created_at TIMESTAMPTZ DEFAULT NOW(),
 datei_id BIGINT REFERENCES reverse_dateien(id) ON DELETE CASCADE, schicht TEXT, fingerabdruck TEXT,
 adresse BIGINT, groesse_bytes BIGINT,
 FOREIGN KEY(eintrag_id,file_path) REFERENCES reverse_code_dateien(eintrag_id,file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_reverse_code_kanten_file ON reverse_code_kanten(eintrag_id,file_path);
CREATE INDEX IF NOT EXISTS idx_reverse_code_kanten_callee ON reverse_code_kanten(eintrag_id,callee_name);
CREATE INDEX IF NOT EXISTS idx_reverse_code_kanten_statement ON reverse_code_kanten(statement_id);
CREATE INDEX IF NOT EXISTS idx_reverse_code_kanten_target ON reverse_code_kanten(target_symbol_id);
CREATE TABLE IF NOT EXISTS reverse_assets (
 id BIGSERIAL PRIMARY KEY, eintrag_id TEXT NOT NULL, datei_id BIGINT NOT NULL,
 pfad TEXT NOT NULL, format TEXT, mime TEXT, sha256 TEXT, groesse BIGINT,
 storage_key TEXT NOT NULL, erzeugt_mit TEXT, renderbar BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(id,eintrag_id),
 FOREIGN KEY(datei_id,eintrag_id) REFERENCES reverse_dateien(id,eintrag_id) ON DELETE CASCADE,
 CHECK(storage_key<>'' AND storage_key !~ '^/' AND storage_key !~ '(^|/)[.]{1,2}(/|$)' AND position(chr(92) in storage_key)=0)
);
CREATE INDEX IF NOT EXISTS idx_reverse_assets_pfad ON reverse_assets(eintrag_id,pfad);
CREATE INDEX IF NOT EXISTS idx_reverse_assets_sha ON reverse_assets(sha256);
CREATE TABLE IF NOT EXISTS reverse_bindungen (
 id BIGSERIAL PRIMARY KEY, project TEXT NOT NULL,
 eintrag_id TEXT NOT NULL REFERENCES reverse_eintraege(id) ON DELETE RESTRICT,
 gebunden_von TEXT NOT NULL, gebunden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 geloest_at TIMESTAMPTZ, notiz TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reverse_bindung_aktiv ON reverse_bindungen(project,eintrag_id) WHERE geloest_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reverse_bindungen_eintrag ON reverse_bindungen(eintrag_id);
CREATE TABLE IF NOT EXISTS reverse_uebernahmen (
 id BIGSERIAL PRIMARY KEY, eintrag_id TEXT NOT NULL REFERENCES reverse_eintraege(id) ON DELETE RESTRICT,
 reverse_asset_id BIGINT NOT NULL, project TEXT NOT NULL, ziel_pfad TEXT NOT NULL,
 asset_id BIGINT REFERENCES asset_files(id) ON DELETE RESTRICT, asset_revision BIGINT,
 von_agent TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status TEXT NOT NULL DEFAULT 'offen',
 FOREIGN KEY(reverse_asset_id,eintrag_id) REFERENCES reverse_assets(id,eintrag_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_reverse_uebernahmen_eintrag ON reverse_uebernahmen(eintrag_id,at);
CREATE INDEX IF NOT EXISTS idx_reverse_uebernahmen_asset ON reverse_uebernahmen(asset_id,asset_revision);
`;
