-- P22-T161 / 156. Top-Artefakte live: jede Aenderung einer Bewertung meldet NOTIFY synapse_artefakt_bewertung (id, project, zustand,
-- quelle, op). Additiv und idempotent (CREATE OR REPLACE FUNCTION, Trigger nur wenn noch nicht vorhanden). Nach 151_artefakt_bewertung.sql.
-- Laufzeit-Spiegel: packages/core/src/db/artefakt-bewertung-schema.ts (ARTEFAKT_BEWERTUNG_NOTIFY_SCHEMA_SQL).
CREATE OR REPLACE FUNCTION notify_artefakt_bewertung() RETURNS trigger AS $fn$
BEGIN
 IF TG_OP = 'DELETE' THEN
  PERFORM pg_notify('synapse_artefakt_bewertung', json_build_object('id', OLD.id::text, 'project', COALESCE(OLD.project, ''), 'zustand', OLD.zustand,
   'quelle_art', OLD.quelle_art, 'quelle_ref', OLD.quelle_ref, 'op', TG_OP)::text);
 ELSE
  PERFORM pg_notify('synapse_artefakt_bewertung', json_build_object('id', NEW.id::text, 'project', COALESCE(NEW.project, ''), 'zustand', NEW.zustand,
   'quelle_art', NEW.quelle_art, 'quelle_ref', NEW.quelle_ref, 'op', TG_OP)::text);
 END IF;
 RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;
DO $block$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_artefakt_bewertung' AND tgrelid = 'artefakt_bewertungen'::regclass) THEN
  CREATE TRIGGER trg_notify_artefakt_bewertung AFTER INSERT OR UPDATE OR DELETE ON artefakt_bewertungen FOR EACH ROW EXECUTE FUNCTION notify_artefakt_bewertung();
 END IF;
END;
$block$;
