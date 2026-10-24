/** P18-T113; Spiegel von schema-sql/147_reverse_belegung.sql. */
export const REVERSE_BELEGUNG_SCHEMA_SQL = `-- P18-T113: laufender Belegungszaehler je Reverse-Eintrag (Summe reverse_dateien.groesse).
-- Pflege per Statement-Trigger mit Transition-Tables: dieselbe TX wie die Zeilenaenderung, jeder Schreiber.
-- Lesen nur bei Reverse-Einstellwert belegung_zaehler an|debug; Abgleich korrigiert kontrolliert (reverse-belegung.ts).
CREATE OR REPLACE FUNCTION reverse_belegung_ins() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
 INSERT INTO reverse_eintrag_belegung(eintrag_id,dateien_bytes)
  SELECT eintrag_id,sum(COALESCE(groesse,0)) FROM reverse_belegung_neu GROUP BY eintrag_id ORDER BY eintrag_id
 ON CONFLICT(eintrag_id) DO UPDATE SET dateien_bytes=reverse_eintrag_belegung.dateien_bytes+EXCLUDED.dateien_bytes,updated_at=clock_timestamp();
 RETURN NULL;
END $f$;
CREATE OR REPLACE FUNCTION reverse_belegung_del() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
 INSERT INTO reverse_eintrag_belegung(eintrag_id,dateien_bytes)
  SELECT eintrag_id,-sum(COALESCE(groesse,0)) FROM reverse_belegung_alt GROUP BY eintrag_id ORDER BY eintrag_id
 ON CONFLICT(eintrag_id) DO UPDATE SET dateien_bytes=reverse_eintrag_belegung.dateien_bytes+EXCLUDED.dateien_bytes,updated_at=clock_timestamp();
 RETURN NULL;
END $f$;
CREATE OR REPLACE FUNCTION reverse_belegung_upd() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
 INSERT INTO reverse_eintrag_belegung(eintrag_id,dateien_bytes)
  SELECT eintrag_id,sum(b) FROM (SELECT eintrag_id,COALESCE(groesse,0) AS b FROM reverse_belegung_neu
   UNION ALL SELECT eintrag_id,-COALESCE(groesse,0) FROM reverse_belegung_alt) x GROUP BY eintrag_id HAVING sum(b)<>0 ORDER BY eintrag_id
 ON CONFLICT(eintrag_id) DO UPDATE SET dateien_bytes=reverse_eintrag_belegung.dateien_bytes+EXCLUDED.dateien_bytes,updated_at=clock_timestamp();
 RETURN NULL;
END $f$;
CREATE OR REPLACE FUNCTION reverse_belegung_truncate() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
 DELETE FROM reverse_eintrag_belegung;RETURN NULL;
END $f$;
-- Einmalig bei Neuanlage: Tabelle, Trigger und Bestand atomar unter Schreibsperre (kein Zeilenverlust zwischen Summe und Trigger).
DO $belegung$ BEGIN
 -- Je Schema pruefen (search_path privat,public: eine public-Tabelle darf die Anlage im aktuellen Schema nicht verhindern).
 IF to_regclass(format('%I.reverse_eintrag_belegung',current_schema())) IS NULL THEN
  LOCK TABLE reverse_dateien IN SHARE ROW EXCLUSIVE MODE;
  CREATE TABLE reverse_eintrag_belegung (
   eintrag_id TEXT PRIMARY KEY,
   dateien_bytes NUMERIC NOT NULL DEFAULT 0,
   abgeglichen_at TIMESTAMPTZ, letzte_abweichung NUMERIC,
   updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  );
  INSERT INTO reverse_eintrag_belegung(eintrag_id,dateien_bytes,abgeglichen_at)
   SELECT eintrag_id,sum(COALESCE(groesse,0)),clock_timestamp() FROM reverse_dateien GROUP BY eintrag_id;
  CREATE TRIGGER trg_reverse_belegung_ins AFTER INSERT ON reverse_dateien REFERENCING NEW TABLE AS reverse_belegung_neu
   FOR EACH STATEMENT EXECUTE FUNCTION reverse_belegung_ins();
  CREATE TRIGGER trg_reverse_belegung_del AFTER DELETE ON reverse_dateien REFERENCING OLD TABLE AS reverse_belegung_alt
   FOR EACH STATEMENT EXECUTE FUNCTION reverse_belegung_del();
  CREATE TRIGGER trg_reverse_belegung_upd AFTER UPDATE ON reverse_dateien REFERENCING OLD TABLE AS reverse_belegung_alt NEW TABLE AS reverse_belegung_neu
   FOR EACH STATEMENT EXECUTE FUNCTION reverse_belegung_upd();
  CREATE TRIGGER trg_reverse_belegung_truncate AFTER TRUNCATE ON reverse_dateien
   FOR EACH STATEMENT EXECUTE FUNCTION reverse_belegung_truncate();
 END IF;
END $belegung$;
`;
