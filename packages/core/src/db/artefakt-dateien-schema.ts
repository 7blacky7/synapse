/** P22-T191: Spiegel von 165_artefakt_dateien.sql. */
export const ARTEFAKT_DATEIEN_SCHEMA_SQL = `
-- P22-T191: Artefakte als versionierte Projekt-/globale Texte. Keine Laufzeitdateien.
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS text_inhalt TEXT;
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS beschreibung TEXT;
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS bereich TEXT CHECK (bereich IN ('projekt','global'));
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS ueberlauf BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS ablauf_am TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_artefakt_name ON agent_artifacts(lower(name));
CREATE INDEX IF NOT EXISTS idx_artefakt_ablauf ON agent_artifacts(ablauf_am) WHERE ueberlauf;
CREATE TABLE IF NOT EXISTS artefakt_datei_versionen (
  artefakt_id UUID NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, stand JSONB NOT NULL, erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(artefakt_id, revision)
);
CREATE TABLE IF NOT EXISTS artefakt_datei_einstellungen (
  name TEXT PRIMARY KEY, wert JSONB NOT NULL, grund TEXT NOT NULL, gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Virtuelle Inhalte verwenden den VORHANDENEN Code-Index/Parser; diese Namen werden nie als PC-Projekt registriert/gebunden.
CREATE TABLE IF NOT EXISTS artefakt_code_index (
  artefakt_id UUID NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  index_project TEXT NOT NULL, file_path TEXT NOT NULL, content_hash TEXT NOT NULL,
  PRIMARY KEY(artefakt_id, file_path)
);
CREATE OR REPLACE FUNCTION versioniere_artefakt_datei() RETURNS trigger AS $af$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.text_inhalt IS DISTINCT FROM OLD.text_inhalt OR NEW.html IS DISTINCT FROM OLD.html OR NEW.vorlage IS DISTINCT FROM OLD.vorlage OR
     NEW.name IS DISTINCT FROM OLD.name OR NEW.title IS DISTINCT FROM OLD.title OR
     NEW.beschreibung IS DISTINCT FROM OLD.beschreibung OR NEW.bereich IS DISTINCT FROM OLD.bereich THEN
   NEW.revision := GREATEST(NEW.revision, OLD.revision+1);
   INSERT INTO artefakt_datei_versionen(artefakt_id,revision,stand)
     VALUES(OLD.id,OLD.revision,to_jsonb(OLD)) ON CONFLICT DO NOTHING;
  END IF;
 END IF;
 RETURN NEW;
END; $af$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION merke_artefakt_datei_version() RETURNS trigger AS $af$
BEGIN
 INSERT INTO artefakt_datei_versionen(artefakt_id,revision,stand)
   VALUES(NEW.id,NEW.revision,to_jsonb(NEW)) ON CONFLICT DO NOTHING;
 RETURN NULL;
END; $af$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_artefakt_datei_version ON agent_artifacts;
CREATE TRIGGER trg_artefakt_datei_version BEFORE UPDATE ON agent_artifacts FOR EACH ROW EXECUTE FUNCTION versioniere_artefakt_datei();
DROP TRIGGER IF EXISTS trg_artefakt_datei_stand ON agent_artifacts;
CREATE TRIGGER trg_artefakt_datei_stand AFTER INSERT OR UPDATE ON agent_artifacts FOR EACH ROW EXECUTE FUNCTION merke_artefakt_datei_version();
`;
