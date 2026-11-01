-- P22-T256: nur Metadaten, keine Dateiinhalte in NOTIFY.
CREATE OR REPLACE FUNCTION editor_plan_benachrichtigen() RETURNS trigger AS $fn$
BEGIN
 IF TG_OP = 'DELETE' THEN
  PERFORM pg_notify('synapse_editor_plan',json_build_object('project',OLD.project,'plan_id',OLD.id::text,'op',TG_OP)::text);
 ELSE
  PERFORM pg_notify('synapse_editor_plan',json_build_object('project',NEW.project,'plan_id',NEW.id::text,'op',TG_OP)::text);
 END IF;
 RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;
DO $block$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_editor_plan_benachrichtigen' AND tgrelid='file_batch_plans'::regclass) THEN
  CREATE TRIGGER trg_editor_plan_benachrichtigen AFTER INSERT OR UPDATE OR DELETE ON file_batch_plans FOR EACH ROW EXECUTE FUNCTION editor_plan_benachrichtigen();
 END IF;
END;
$block$;
-- P22-T264: trg_editor_pruefplan_benachrichtigen (editor_pruefplaene) entfaellt; schema.ts legt ihn nicht mehr an und entfernt ihn (siehe 178).
