/** P18-T86: additive Migration; Werte, Grenzen und Querbedingungen kommen aus EINEM Katalog. */
import {REVERSE_EINSTELLKATALOG,REVERSE_EINSTELL_REGELN} from '../services/reverse-einstellkatalog.js';
const literal=(s:string)=>"'"+s.split("'").join("''")+"'";
const feld=(v:string|null)=>v===null?'NULL':v;
const textArray=(a:readonly string[]|null)=>a===null?'NULL':'ARRAY['+a.map(literal).join(',')+']::text[]';
const katalog=Object.entries(REVERSE_EINSTELLKATALOG).map(([name,d])=>'('+[literal(name),literal(d.typ),literal(d.einheit),feld(d.min),feld(d.max),
 d.typ==='enum'?'NULL':d.standard,d.typ==='enum'?literal(d.standard):'NULL',textArray(d.werte),textArray(d.ebenen)].join(',')+')').join(',\n');
const wirksam=(name:string)=>`reverse_einstell_wirksam(${literal(name)},kontext.project,kontext.eintrag_id)`;
const summe=(t:readonly (readonly [string,bigint])[])=>t.map(([n,f])=>f+'::numeric*'+wirksam(n)).join('+');
const regeln=REVERSE_EINSTELL_REGELN.map(r=>
 ` IF (${summe(r.links)}) ${r.strikt?'>=':'>'} (${summe(r.rechts)}) THEN RAISE EXCEPTION 'reverse_einstellungen_widerspruch: %',${literal(r.name)}; END IF;`).join('\n');
export const REVERSE_EINSTELLWERTE_SCHEMA_SQL=`
ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS uebernahme JSONB;
-- Bestehende Werte bleiben erhalten. Nicht mehr passende Projektscopes werden lesend als Migrationsbefund gemeldet.
ALTER TABLE reverse_einstellungen ADD COLUMN IF NOT EXISTS eintrag_id TEXT REFERENCES reverse_eintraege(id) ON DELETE RESTRICT;
ALTER TABLE reverse_einstellungen ADD COLUMN IF NOT EXISTS wert_text TEXT;
ALTER TABLE reverse_einstellungen ALTER COLUMN wert DROP NOT NULL;
ALTER TABLE reverse_einstellungen DROP CONSTRAINT IF EXISTS reverse_einstellungen_ebene_check;
ALTER TABLE reverse_einstellungen DROP CONSTRAINT IF EXISTS reverse_einstellungen_wert_check;
ALTER TABLE reverse_einstellungen DROP CONSTRAINT IF EXISTS reverse_einstellungen_check;
DO $scope$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_einstellungen'::regclass AND conname='reverse_einstellungen_scope_v2') THEN
 ALTER TABLE reverse_einstellungen ADD CONSTRAINT reverse_einstellungen_scope_v2 CHECK (
 (ebene='global' AND project IS NULL AND eintrag_id IS NULL) OR
 (ebene='projekt' AND project IS NOT NULL AND eintrag_id IS NULL) OR
 (ebene='eintrag' AND project IS NULL AND eintrag_id IS NOT NULL));
 END IF;
 -- Genau eine Wertspalte: Ganzzahlen in wert (BIGINT), Auswahlwerte in wert_text.
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_einstellungen'::regclass AND conname='reverse_einstellungen_wert_v2') THEN
 ALTER TABLE reverse_einstellungen ADD CONSTRAINT reverse_einstellungen_wert_v2 CHECK ((wert IS NULL)<>(wert_text IS NULL));
 END IF;
END $scope$;
DROP INDEX IF EXISTS reverse_einstellungen_eindeutig;
CREATE UNIQUE INDEX IF NOT EXISTS reverse_einstellungen_scope_name ON reverse_einstellungen(ebene,(COALESCE(project,'')),(COALESCE(eintrag_id,'')),name);
CREATE TABLE IF NOT EXISTS reverse_einstellkatalog(
 name TEXT PRIMARY KEY,typ TEXT NOT NULL,einheit TEXT NOT NULL,min BIGINT,max BIGINT,
 standard BIGINT,standard_text TEXT,werte TEXT[],ebenen TEXT[] NOT NULL);
ALTER TABLE reverse_einstellkatalog ADD COLUMN IF NOT EXISTS standard_text TEXT;
ALTER TABLE reverse_einstellkatalog ADD COLUMN IF NOT EXISTS werte TEXT[];
ALTER TABLE reverse_einstellkatalog ALTER COLUMN min DROP NOT NULL;
ALTER TABLE reverse_einstellkatalog ALTER COLUMN max DROP NOT NULL;
ALTER TABLE reverse_einstellkatalog ALTER COLUMN standard DROP NOT NULL;
ALTER TABLE reverse_einstellkatalog DROP CONSTRAINT IF EXISTS reverse_einstellkatalog_check;
DO $katalog$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_einstellkatalog'::regclass AND conname='reverse_einstellkatalog_typ_v2') THEN
 ALTER TABLE reverse_einstellkatalog ADD CONSTRAINT reverse_einstellkatalog_typ_v2 CHECK (
 (typ='enum' AND werte IS NOT NULL AND standard_text=ANY(werte) AND min IS NULL AND max IS NULL AND standard IS NULL) OR
 (typ IN ('integer','bigint') AND min<=standard AND standard<=max AND werte IS NULL AND standard_text IS NULL));
 END IF;
END $katalog$;
INSERT INTO reverse_einstellkatalog(name,typ,einheit,min,max,standard,standard_text,werte,ebenen) VALUES ${katalog}
 ON CONFLICT(name) DO UPDATE SET typ=EXCLUDED.typ,einheit=EXCLUDED.einheit,min=EXCLUDED.min,max=EXCLUDED.max,standard=EXCLUDED.standard,
 standard_text=EXCLUDED.standard_text,werte=EXCLUDED.werte,ebenen=EXCLUDED.ebenen;
-- Aus dem Katalog entfernte Schlüssel: gesetzte Zeilen bleiben stehen und erscheinen im Resolver als Migrationsbefund.
DELETE FROM reverse_einstellkatalog WHERE name<>ALL(${textArray(Object.keys(REVERSE_EINSTELLKATALOG))});
CREATE OR REPLACE FUNCTION reverse_einstellwert_pruefen() RETURNS trigger LANGUAGE plpgsql AS $guard$
DECLARE d reverse_einstellkatalog;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('reverse-einstellungen'));
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 SELECT * INTO d FROM reverse_einstellkatalog WHERE name=NEW.name;
 IF NOT FOUND OR NOT NEW.ebene=ANY(d.ebenen)
  OR d.typ='enum' AND (NEW.wert IS NOT NULL OR NEW.wert_text IS NULL OR NOT NEW.wert_text=ANY(d.werte))
  OR d.typ<>'enum' AND (NEW.wert_text IS NOT NULL OR NEW.wert IS NULL OR NEW.wert<d.min OR NEW.wert>d.max) THEN
  RAISE EXCEPTION 'reverse_einstellung_ungueltig: %/%',NEW.ebene,NEW.name;
 END IF;
 RETURN NEW;
END $guard$;
CREATE OR REPLACE TRIGGER reverse_einstellwert_guard BEFORE INSERT OR UPDATE OR DELETE ON reverse_einstellungen
 FOR EACH ROW EXECUTE FUNCTION reverse_einstellwert_pruefen();
-- Wirksamer Ganzzahlwert eines Kontexts: Projekt bzw. Eintrag vor global, sonst Katalogstandard (wie der TS-Resolver).
CREATE OR REPLACE FUNCTION reverse_einstell_wirksam(p_name TEXT,p_project TEXT,p_eintrag TEXT) RETURNS BIGINT LANGUAGE sql STABLE AS $wirksam$
 SELECT COALESCE((SELECT e.wert FROM reverse_einstellungen e WHERE e.name=k.name AND e.ebene=ANY(k.ebenen) AND e.wert IS NOT NULL
  AND (e.ebene='global' OR e.ebene='projekt' AND e.project=p_project OR e.ebene='eintrag' AND e.eintrag_id=p_eintrag)
  ORDER BY (e.ebene<>'global') DESC LIMIT 1),k.standard) FROM reverse_einstellkatalog k WHERE k.name=p_name
$wirksam$;
-- Kontextbezogene Pruefung am Transaktionsende, damit mehrere zusammenhaengende Werte atomar setzbar sind.
CREATE OR REPLACE FUNCTION reverse_einstell_konsistenz() RETURNS trigger LANGUAGE plpgsql AS $konsistenz$
DECLARE kontext record;
BEGIN
 FOR kontext IN SELECT DISTINCT project,eintrag_id FROM reverse_einstellungen UNION SELECT NULL::text,NULL::text LOOP
${regeln}
 END LOOP;
 RETURN NULL;
END $konsistenz$;
DROP TRIGGER IF EXISTS reverse_einstell_konsistenz_guard ON reverse_einstellungen;
CREATE CONSTRAINT TRIGGER reverse_einstell_konsistenz_guard AFTER INSERT OR UPDATE OR DELETE ON reverse_einstellungen
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reverse_einstell_konsistenz();
`;
