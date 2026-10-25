/** P22-T154: Spiegel 152_artefakt_vorlagen.sql. Additiv/idempotent; nach agent_artifacts (SCHEMA_SQL) und 112 (created_by_identity_id). */
export const ARTEFAKT_VORLAGEN_SCHEMA_SQL = `
-- P22-T154 / 152. Artefakte als Datenvorlagen (Entwurf 689abb81, R3/R9). Additiv und idempotent; bestehende Zeilen bleiben unberuehrt.
-- agent_artifacts: Vorlage + Quellen (nur feste Lesevertraege), Modus fest|stand|live, Standardprojekt. session_id wird optional
-- (Artefakte per Ausweis ohne Hauptagenten-Session); Zeilen ohne vorlage sind fertiges HTML wie bisher (modus 'fest').
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS vorlage TEXT;
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS quellen JSONB CHECK (quellen IS NULL OR jsonb_typeof(quellen) = 'array');
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS modus TEXT NOT NULL DEFAULT 'fest' CHECK (modus IN ('fest','stand','live'));
ALTER TABLE agent_artifacts ADD COLUMN IF NOT EXISTS standard_project TEXT;
ALTER TABLE agent_artifacts ALTER COLUMN session_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_artifacts_owner ON agent_artifacts(created_by_identity_id, updated_at DESC) WHERE created_by_identity_id IS NOT NULL;
-- artefakt_renderungen: eine Momentaufnahme je Artefakt und Projekt (Injektion je Projekt). agent_artifacts.html bleibt die
-- Renderung im standard_project, damit Bewertung, Liste und Livebild unveraendert arbeiten.
CREATE TABLE IF NOT EXISTS artefakt_renderungen (
  artefakt_id UUID NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  html TEXT NOT NULL,
  daten_hash TEXT NOT NULL,
  quellen_stand JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(quellen_stand) = 'array'),
  fehler JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fehler) = 'array'),
  gerendert_von TEXT,
  gerendert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (artefakt_id, project)
);
-- Interne Einstellungen (Drossel, Buendelung, Kappungen); keine Zeile = Code-Standard.
CREATE TABLE IF NOT EXISTS artefakt_vorlagen_einstellungen (
  name TEXT PRIMARY KEY,
  wert JSONB NOT NULL,
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Live-Weg: jede Plan-Aenderung meldet sich auf synapse_plan (Projekt + Plan-ID), der Server zeichnet gedrosselt neu.
CREATE OR REPLACE FUNCTION notify_plan_change() RETURNS trigger AS $fn$
BEGIN
 IF TG_OP = 'DELETE' THEN
  PERFORM pg_notify('synapse_plan', json_build_object('project', OLD.project, 'id', OLD.id::text, 'op', TG_OP)::text);
 ELSE
  PERFORM pg_notify('synapse_plan', json_build_object('project', NEW.project, 'id', NEW.id::text, 'op', TG_OP)::text);
 END IF;
 RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;
DO $block$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_plan_change' AND tgrelid = 'plans'::regclass) THEN
  CREATE TRIGGER trg_notify_plan_change AFTER INSERT OR UPDATE OR DELETE ON plans FOR EACH ROW EXECUTE FUNCTION notify_plan_change();
 END IF;
END;
$block$;
`;
