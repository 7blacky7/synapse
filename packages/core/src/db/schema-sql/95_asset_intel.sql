-- ===========================================================================
-- ASSET-INTEL (P4-T67/T70): abgeleitete Daten zu Nicht-Quellcode-Dateien.
--
-- VON HAND GEPFLEGT, NICHT per pg_dump erzeugt: der Block ist neu und noch in
-- keiner Produktionsdatenbank, aus der man ihn exportieren koennte. Der Text
-- entspricht 1:1 dem Block am Ende von SCHEMA_SQL in ../schema.ts.
--
-- Abweichung von der Ordner-Konvention: die beiden Fremdschluessel stehen hier
-- INLINE und nicht in 95_foreign_keys.sql. Sie zeigen nur auf asset_files aus
-- dieser Datei; alphabetisch laeuft 95_asset_intel vor 95_foreign_keys, beide
-- nach 00_extensions_types.sql (pg_trgm fuer die gin_trgm_ops-Indizes).
--
-- BEWUSST EIGENE TABELLEN, NICHT code_files: verifyProjectAgainstFilesystem
-- entfernt code_files-Zeilen, die der Walk nicht liefert (Binaerdateien), und
-- der PG->FS-Sync loescht danach die Datei auf der Platte. Kein Rohinhalt in PG;
-- die Originaldatei bleibt Quelle der Wahrheit. Geschrieben nur vom lokalen
-- Watcher-Prozess (sieht die Datei), gelesen ueberall.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS asset_files (
  id                BIGSERIAL PRIMARY KEY,
  project           TEXT NOT NULL,
  file_path         TEXT NOT NULL,
  file_name         TEXT NOT NULL,
  extension         TEXT,
  asset_type        TEXT NOT NULL DEFAULT 'unbekannt',
  format            TEXT,
  status            TEXT NOT NULL,
  inspector         TEXT,
  parser_version    INTEGER NOT NULL DEFAULT 0,
  file_size         BIGINT NOT NULL DEFAULT 0,
  sha256            TEXT,
  mtime             TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  format_specific   JSONB NOT NULL DEFAULT '{}'::jsonb,
  warnings          JSONB NOT NULL DEFAULT '[]'::jsonb,
  n_objects         INTEGER NOT NULL DEFAULT 0,
  n_references      INTEGER NOT NULL DEFAULT 0,
  objekte_gekappt   BOOLEAN NOT NULL DEFAULT false,
  extracted_at      TIMESTAMPTZ,
  quelle_fehlt_seit TIMESTAMPTZ,
  inspiziert_von    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT asset_files_project_file_path_key UNIQUE (project, file_path),
  CONSTRAINT asset_files_status_check CHECK (status IN ('ok','teilweise','nicht_erkannt','fehler','quelle_nicht_gefunden'))
);
CREATE INDEX IF NOT EXISTS idx_asset_files_format    ON asset_files(project, format);
CREATE INDEX IF NOT EXISTS idx_asset_files_typ       ON asset_files(project, asset_type);
CREATE INDEX IF NOT EXISTS idx_asset_files_status    ON asset_files(project, status) WHERE status <> 'ok';
CREATE INDEX IF NOT EXISTS idx_asset_files_sha256    ON asset_files(project, sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_files_pfad_trgm ON asset_files USING gin (file_path gin_trgm_ops);

-- Ein Objekt je Eintrag in AssetResult.objects (Reihenfolge = ordnung), hoechstens
-- SYNAPSE_ASSET_MAX_OBJEKTE (Standard 2000) je Datei, Rest -> objekte_gekappt.
-- Position in der Originaldatei: Bytebereich ODER Zeilenbereich (AssetSourceRange).
CREATE TABLE IF NOT EXISTS asset_objects (
  id          BIGSERIAL PRIMARY KEY,
  asset_id    BIGINT NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  project     TEXT NOT NULL,
  ordnung     INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  byte_offset BIGINT,
  byte_length BIGINT,
  line_start  INTEGER,
  line_end    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_asset_objects_asset     ON asset_objects(asset_id, ordnung);
CREATE INDEX IF NOT EXISTS idx_asset_objects_kind      ON asset_objects(project, kind);
CREATE INDEX IF NOT EXISTS idx_asset_objects_name_trgm ON asset_objects USING gin (name gin_trgm_ops) WHERE name IS NOT NULL;

-- Beziehungen als eigene Zeilen (T67). target = wie im Asset; ziel_pfad = projekt-
-- relativ aufgeloest (Grundlage fuer used_by/graph); aufloesung = Ergebnis der
-- Pruefung; inspektor_resolved = Urteil des Inspektors (NULL = nicht versucht).
CREATE TABLE IF NOT EXISTS asset_references (
  id                 BIGSERIAL PRIMARY KEY,
  asset_id           BIGINT NOT NULL REFERENCES asset_files(id) ON DELETE CASCADE,
  project            TEXT NOT NULL,
  ordnung            INTEGER NOT NULL,
  kind               TEXT NOT NULL,
  target             TEXT NOT NULL,
  ziel_pfad          TEXT,
  aufloesung         TEXT NOT NULL,
  inspektor_resolved BOOLEAN,
  CONSTRAINT asset_references_aufloesung_check CHECK (aufloesung IN ('datei','fehlt','intern','extern','eingebettet','ausserhalb','unbekannt'))
);
CREATE INDEX IF NOT EXISTS idx_asset_refs_asset       ON asset_references(asset_id, ordnung);
CREATE INDEX IF NOT EXISTS idx_asset_refs_ziel        ON asset_references(project, ziel_pfad) WHERE ziel_pfad IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_asset_refs_fehlt       ON asset_references(project) WHERE aufloesung = 'fehlt';
CREATE INDEX IF NOT EXISTS idx_asset_refs_target_trgm ON asset_references USING gin (target gin_trgm_ops);
