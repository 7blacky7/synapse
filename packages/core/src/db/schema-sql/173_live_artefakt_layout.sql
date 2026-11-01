-- P22-T164: Layout des authentifizierten Synapse-Users, pro Artefakt und Renderprojekt.
CREATE TABLE IF NOT EXISTS user_live_artefakt_layout (
  user_key TEXT NOT NULL,
  artefakt_id UUID NOT NULL REFERENCES agent_artifacts(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  x DOUBLE PRECISION NOT NULL,
  y DOUBLE PRECISION NOT NULL,
  breite DOUBLE PRECISION NOT NULL,
  hoehe DOUBLE PRECISION NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  aktualisiert TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_key, artefakt_id, project)
);


-- P22-T259 L3/L4 (Nachtrag, Quelle: SCHEMA_SQL in schema.ts): auf_leinwand + Einmal-Umstieg beim Anlegen der Spalte.
DO $block$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='user_live_artefakt_layout' AND column_name='auf_leinwand') THEN
  ALTER TABLE user_live_artefakt_layout ADD COLUMN auf_leinwand BOOLEAN NOT NULL DEFAULT TRUE;
  IF to_regclass('artefakt_renderungen') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='agent_artifacts' AND column_name='vorlage') THEN
   INSERT INTO user_live_artefakt_layout(user_key,artefakt_id,project,x,y,breite,hoehe)
   SELECT 'user', k.artefakt_id, k.project, ((k.nr-1)%2)*50, ((k.nr-1)/2)*340, 48, 320
   FROM (SELECT p.artefakt_id, p.project, row_number() OVER (ORDER BY p.artefakt_id::text, p.project) AS nr FROM (
     SELECT id AS artefakt_id, standard_project AS project FROM agent_artifacts
     WHERE modus='live' AND vorlage IS NOT NULL AND standard_project IS NOT NULL AND standard_project <> ''
     UNION
     SELECT a.id, r.project FROM agent_artifacts a JOIN artefakt_renderungen r ON r.artefakt_id=a.id
     WHERE a.modus='live' AND a.vorlage IS NOT NULL AND r.project <> '') p) k
   ON CONFLICT (user_key,artefakt_id,project) DO NOTHING;
  END IF;
 END IF;
END;
$block$;
