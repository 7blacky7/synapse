/** P10-T61: global eindeutige Namen. Einzelanweisungen auch fuer messbare Schema-Proben. */
export const TOPF_NAMEN_ANWEISUNGEN = [
`CREATE TABLE IF NOT EXISTS topf_namen (
  name TEXT PRIMARY KEY,
  topf TEXT NOT NULL CHECK (topf IN ('entscheidung', 'erklaerung')),
  eintrag_id UUID NOT NULL,
  UNIQUE (topf, eintrag_id)
)`,
`DO $topf_pruefen$
BEGIN
  IF EXISTS (
    SELECT kennung FROM (
      SELECT kennung FROM erklaerungen UNION ALL SELECT kennung FROM jev_entscheidungstopf
    ) n WHERE kennung IS NOT NULL GROUP BY kennung HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Topf-Namen im Bestand doppelt; zuerst topf_namen_nachtragen(bestand_pruefen:true) auswerten'
      USING ERRCODE = '23505';
  END IF;
END $topf_pruefen$`,
`CREATE OR REPLACE FUNCTION pflege_topf_namen() RETURNS trigger LANGUAGE plpgsql AS $topf_trigger$
DECLARE
  art text := CASE TG_TABLE_NAME WHEN 'erklaerungen' THEN 'erklaerung' ELSE 'entscheidung' END;
  registriert text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    EXECUTE format('DELETE FROM %I.topf_namen WHERE topf = $1 AND eintrag_id = $2', TG_TABLE_SCHEMA)
      USING art, OLD.id;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.kennung IS DISTINCT FROM NEW.kennung OR OLD.id IS DISTINCT FROM NEW.id THEN
      EXECUTE format('DELETE FROM %I.topf_namen WHERE topf = $1 AND eintrag_id = $2', TG_TABLE_SCHEMA)
        USING art, OLD.id;
    END IF;
  END IF;
  IF NEW.kennung IS NOT NULL THEN
    EXECUTE format(
      'INSERT INTO %I.topf_namen AS r(name,topf,eintrag_id) VALUES($1,$2,$3)
       ON CONFLICT(name) DO UPDATE SET name = EXCLUDED.name
       WHERE r.topf = EXCLUDED.topf AND r.eintrag_id = EXCLUDED.eintrag_id RETURNING name', TG_TABLE_SCHEMA)
      INTO registriert USING NEW.kennung, art, NEW.id;
    IF registriert IS NULL THEN
      RAISE EXCEPTION 'Topf-Name "%" bereits vergeben', NEW.kennung USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END $topf_trigger$`,
`CREATE OR REPLACE TRIGGER topf_namen_pflegen AFTER INSERT OR UPDATE OF kennung, id OR DELETE
 ON erklaerungen FOR EACH ROW EXECUTE FUNCTION pflege_topf_namen()`,
`CREATE OR REPLACE TRIGGER topf_namen_pflegen AFTER INSERT OR UPDATE OF kennung, id OR DELETE
 ON jev_entscheidungstopf FOR EACH ROW EXECUTE FUNCTION pflege_topf_namen()`,
`INSERT INTO topf_namen(name,topf,eintrag_id)
 SELECT kennung, 'erklaerung', id FROM erklaerungen WHERE kennung IS NOT NULL
 UNION ALL SELECT kennung, 'entscheidung', id FROM jev_entscheidungstopf WHERE kennung IS NOT NULL
 ON CONFLICT(name) DO NOTHING`,
`DO $topf_register_pruefen$
BEGIN
 IF EXISTS (
   SELECT 1 FROM (
     SELECT kennung AS name, 'erklaerung' AS topf, id FROM erklaerungen WHERE kennung IS NOT NULL
     UNION ALL SELECT kennung, 'entscheidung', id FROM jev_entscheidungstopf WHERE kennung IS NOT NULL
   ) n LEFT JOIN topf_namen r ON r.name=n.name AND r.topf=n.topf AND r.eintrag_id=n.id
   WHERE r.name IS NULL
 ) THEN
   RAISE EXCEPTION 'Topf-Namensregister widerspricht dem Bestand' USING ERRCODE = '23505';
 END IF;
END $topf_register_pruefen$`
] as const;
export const TOPF_NAMEN_SCHEMA_SQL = TOPF_NAMEN_ANWEISUNGEN.join(';\n') + ';';
