/** Additiver Spiegel von schema-sql/142_reverse_leser_nachzug.sql. */
export const REVERSE_LESER_NACHZUG_SCHEMA_SQL = `
-- P18-T43: Planungscheckpoint; Arbeit bleibt in P20 WorkJobs.
CREATE TABLE IF NOT EXISTS reverse_leser_nachzug (
 eintrag_id TEXT NOT NULL, leser_id TEXT NOT NULL,
 datei_cursor BIGINT NOT NULL DEFAULT 0 CHECK(datei_cursor>=0),
 hash_cursor TEXT CHECK(hash_cursor ~ '^[0-9a-f]{64}$'),
 scan_bis BIGINT NOT NULL DEFAULT 0 CHECK(scan_bis>=0),
 scan_id UUID NOT NULL, scan_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 quellstand TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
 einstellungen_revision TEXT NOT NULL CHECK(einstellungen_revision ~ '^[0-9a-f]{64}$'),
 policy_revision TEXT NOT NULL CHECK(policy_revision ~ '^[0-9a-f]{64}$'),
 status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN('offen','fertig','teilweise')),
 geprueft BIGINT NOT NULL DEFAULT 0 CHECK(geprueft>=0),
 passend BIGINT NOT NULL DEFAULT 0 CHECK(passend>=0),
 auftraege BIGINT NOT NULL DEFAULT 0 CHECK(auftraege>=0),
 offen BIGINT NOT NULL DEFAULT 0 CHECK(offen>=0),
 fehlercode TEXT, fehler_datei BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(eintrag_id,leser_id)
);
DO $nachzug_fk$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_leser_nachzug'::regclass AND conname='reverse_leser_nachzug_eintrag_fk') THEN
  ALTER TABLE reverse_leser_nachzug ADD CONSTRAINT reverse_leser_nachzug_eintrag_fk
   FOREIGN KEY(eintrag_id) REFERENCES reverse_eintraege(id) ON DELETE RESTRICT NOT VALID;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='reverse_leser_nachzug'::regclass AND conname='reverse_leser_nachzug_leser_fk') THEN
  ALTER TABLE reverse_leser_nachzug ADD CONSTRAINT reverse_leser_nachzug_leser_fk
   FOREIGN KEY(leser_id) REFERENCES reverse_leser(id) ON DELETE RESTRICT NOT VALID;
 END IF;
END $nachzug_fk$;
`;
