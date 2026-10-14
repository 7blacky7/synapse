-- P3-T15: abgeleitete Projektion; plans.tasks bleibt Wahrheit.
CREATE TABLE IF NOT EXISTS plan_tasks (
  id TEXT NOT NULL,
  project TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  task JSONB NOT NULL,
  plan_kurz_id TEXT,
  updated_at TEXT NOT NULL,
  embedded_at TIMESTAMPTZ,
  key TEXT GENERATED ALWAYS AS (project || ':' || id) STORED,
  PRIMARY KEY (project, id)
);
-- Auch den noch nicht deployten ersten Entwurf idempotent umstellen.
ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS key TEXT GENERATED ALWAYS AS (project || ':' || id) STORED;
DO $$
DECLARE pk RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'plan_tasks'::regclass AND contype = 'p'
                 AND pg_get_constraintdef(oid) = 'PRIMARY KEY (project, id)') THEN
    FOR pk IN SELECT conname FROM pg_constraint WHERE conrelid = 'plan_tasks'::regclass AND contype = 'p' LOOP
      EXECUTE format('ALTER TABLE plan_tasks DROP CONSTRAINT %I', pk.conname);
    END LOOP;
    ALTER TABLE plan_tasks ADD PRIMARY KEY (project, id);
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_tasks_key ON plan_tasks(key);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(project, plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_backlog ON plan_tasks(project, updated_at) WHERE embedded_at IS NULL;

CREATE OR REPLACE FUNCTION synapse_plan_tasks_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM plan_tasks WHERE project = OLD.project AND plan_id = OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.project IS DISTINCT FROM NEW.project THEN
    DELETE FROM plan_tasks WHERE project = OLD.project AND plan_id = OLD.id;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.tasks, '[]'::jsonb)) x
             WHERE NULLIF(x->>'id', '') IS NOT NULL GROUP BY x->>'id' HAVING count(*) > 1) THEN
    RAISE NOTICE 'Synapse Task-Projektion: doppelte Task-ID in Plan %, letzte Position gewinnt', NEW.id;
  END IF;
  DELETE FROM plan_tasks t WHERE t.project = NEW.project AND t.plan_id = NEW.id
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.tasks, '[]'::jsonb)) x WHERE x->>'id' = t.id);
  INSERT INTO plan_tasks(id, project, plan_id, task, plan_kurz_id, updated_at)
    SELECT x->>'id', NEW.project, NEW.id, x, NEW.kurz_id,
           COALESCE(x->>'updatedAt', x->>'createdAt', NEW.updated_at::text, '')
    FROM (
      SELECT DISTINCT ON (x->>'id') x
      FROM jsonb_array_elements(COALESCE(NEW.tasks, '[]'::jsonb)) WITH ORDINALITY AS a(x, pos)
      WHERE NULLIF(x->>'id', '') IS NOT NULL ORDER BY x->>'id', pos DESC
    ) letzte
  ON CONFLICT(project, id) DO UPDATE SET plan_id = EXCLUDED.plan_id,
    task = EXCLUDED.task, plan_kurz_id = EXCLUDED.plan_kurz_id,
    updated_at = EXCLUDED.updated_at, embedded_at = NULL
  WHERE (plan_tasks.plan_id, plan_tasks.task, plan_tasks.plan_kurz_id, plan_tasks.updated_at)
    IS DISTINCT FROM (EXCLUDED.plan_id, EXCLUDED.task, EXCLUDED.plan_kurz_id, EXCLUDED.updated_at);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_plan_tasks_sync ON plans;
CREATE TRIGGER trg_plan_tasks_sync AFTER INSERT OR UPDATE OF tasks, kurz_id, project OR DELETE ON plans
  FOR EACH ROW EXECUTE FUNCTION synapse_plan_tasks_sync();

-- Bestand dedupliziert übernehmen; fertige Marker bei weiteren Starts erhalten.
INSERT INTO plan_tasks(id, project, plan_id, task, plan_kurz_id, updated_at)
  SELECT x->>'id', project, plan_id, x, plan_kurz_id,
         COALESCE(x->>'updatedAt', x->>'createdAt', plan_updated_at::text, '')
  FROM (
    SELECT DISTINCT ON (p.project, x->>'id') p.project, p.id AS plan_id, p.kurz_id AS plan_kurz_id,
           p.updated_at AS plan_updated_at, x
    FROM plans p CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.tasks, '[]'::jsonb)) WITH ORDINALITY AS a(x, pos)
    WHERE NULLIF(x->>'id', '') IS NOT NULL
    ORDER BY p.project, x->>'id', p.updated_at DESC, p.id, pos DESC
  ) letzte
ON CONFLICT(project, id) DO NOTHING;
