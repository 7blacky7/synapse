/** P22-T195: Spiegel von 166_quellenanmerkungen.sql. */
export const QUELLENANMERKUNGEN_SCHEMA_SQL = `
-- P22-T195 / b48ad571: dauerhafte Quellenanmerkungen; Vorversion bleibt in derselben PG-Transaktion erhalten.
CREATE TABLE IF NOT EXISTS quellenanmerkung_versionen (
 id BIGSERIAL PRIMARY KEY, project TEXT NOT NULL, art TEXT NOT NULL, quelle_id TEXT NOT NULL,
 hash TEXT NOT NULL, stand JSONB NOT NULL, erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(project,art,quelle_id,hash)
);
CREATE TABLE IF NOT EXISTS quellenanmerkungen (
 id UUID PRIMARY KEY, project TEXT NOT NULL, art TEXT NOT NULL, quelle_id TEXT NOT NULL,
 version_id BIGINT NOT NULL REFERENCES quellenanmerkung_versionen(id),
 ausschnitt TEXT NOT NULL, position JSONB NOT NULL, anmerkung TEXT NOT NULL,
 nutzer TEXT NOT NULL, erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 status TEXT NOT NULL DEFAULT 'offen' CHECK(status IN ('offen','eingearbeitet','abgelehnt')),
 beleg_version_id BIGINT REFERENCES quellenanmerkung_versionen(id), begruendung TEXT,
 bearbeitet_von TEXT, bearbeitet_am TIMESTAMPTZ, vorgang UUID NOT NULL,
 UNIQUE(vorgang,id)
);
CREATE INDEX IF NOT EXISTS idx_quellenanmerkungen_quelle ON quellenanmerkungen(project,art,quelle_id,status);
CREATE TABLE IF NOT EXISTS quellenanmerkung_ereignisse (
 id BIGSERIAL PRIMARY KEY, anmerkung_id UUID NOT NULL REFERENCES quellenanmerkungen(id),
 stand JSONB NOT NULL, zeit TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS quellenanmerkung_sendungen (
 vorgang UUID NOT NULL, ziel TEXT NOT NULL, inhalt_hash TEXT NOT NULL,
 ergebnis JSONB NOT NULL, erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(vorgang,ziel)
);
-- Index-Nachlaeufe aendern keine vom User kommentierte Quelle; der vollstaendige Stand bleibt trotzdem im Snapshot.
CREATE OR REPLACE FUNCTION quellenanmerkung_hash(s JSONB) RETURNS TEXT AS $qh$
 SELECT md5((s - 'embedded_at' - 'tsv')::text);
$qh$ LANGUAGE sql IMMUTABLE;
CREATE OR REPLACE FUNCTION merke_quellenanmerkung_version(p TEXT,a TEXT,k TEXT,s JSONB) RETURNS BIGINT AS $qa$
DECLARE v BIGINT;
BEGIN
 INSERT INTO quellenanmerkung_versionen(project,art,quelle_id,hash,stand)
 VALUES(p,a,k,quellenanmerkung_hash(s),s) ON CONFLICT DO NOTHING;
 SELECT id INTO v FROM quellenanmerkung_versionen WHERE project=p AND art=a AND quelle_id=k AND hash=quellenanmerkung_hash(s);
 RETURN v;
END; $qa$ LANGUAGE plpgsql;
-- Nur annotierte Quellen werden historisiert, auch wenn der Produktschalter spaeter AUS ist.
CREATE OR REPLACE FUNCTION sichere_annotierte_quelle() RETURNS trigger AS $qa$
DECLARE a TEXT; p TEXT; k TEXT; alt JSONB; neu JSONB; t JSONB;
BEGIN
 alt:=to_jsonb(OLD);
 IF TG_OP<>'DELETE' THEN neu:=to_jsonb(NEW); END IF;
 a:=TG_ARGV[0]; p:=alt->>'project'; k:=alt->>'id';
 IF a='artefakt' THEN
  FOR p IN SELECT DISTINCT project FROM quellenanmerkungen WHERE art=a AND quelle_id=k LOOP
   PERFORM merke_quellenanmerkung_version(p,a,k,alt);
   IF neu IS NOT NULL THEN PERFORM merke_quellenanmerkung_version(p,a,k,neu); END IF;
  END LOOP;
  p:=NULL;
 END IF;
 IF a='nachricht' THEN SELECT project INTO p FROM specialist_channels WHERE id=(alt->>'channel_id')::bigint; END IF;
 IF EXISTS(SELECT 1 FROM quellenanmerkungen WHERE project=p AND art=a AND quelle_id=k) THEN
  PERFORM merke_quellenanmerkung_version(p,a,k,alt);
  IF neu IS NOT NULL THEN PERFORM merke_quellenanmerkung_version(p,a,k,neu); END IF;
 END IF;
 IF a='plan' THEN
  -- Auch Task-Verschiebungen: die Menge beider Staende, identifiziert durch stabile Task-UUID.
  FOR k IN
   SELECT value->>'id' FROM jsonb_array_elements(coalesce(alt->'tasks','[]'::jsonb))
   UNION SELECT value->>'id' FROM jsonb_array_elements(coalesce(neu->'tasks','[]'::jsonb))
  LOOP
   IF EXISTS(SELECT 1 FROM quellenanmerkungen WHERE project=p AND art='task' AND quelle_id=k) THEN
    SELECT value INTO t FROM jsonb_array_elements(coalesce(alt->'tasks','[]'::jsonb)) WHERE value->>'id'=k;
    IF t IS NOT NULL THEN PERFORM merke_quellenanmerkung_version(p,'task',k,t); END IF;
    SELECT value INTO t FROM jsonb_array_elements(coalesce(neu->'tasks','[]'::jsonb)) WHERE value->>'id'=k;
    IF t IS NOT NULL THEN PERFORM merke_quellenanmerkung_version(p,'task',k,t); END IF;
   END IF;
  END LOOP;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END; $qa$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_quellenanmerkungen ON thoughts;
CREATE TRIGGER trg_quellenanmerkungen AFTER UPDATE OR DELETE ON thoughts FOR EACH ROW EXECUTE FUNCTION sichere_annotierte_quelle('thought');
DROP TRIGGER IF EXISTS trg_quellenanmerkungen ON memories;
CREATE TRIGGER trg_quellenanmerkungen AFTER UPDATE OR DELETE ON memories FOR EACH ROW EXECUTE FUNCTION sichere_annotierte_quelle('memory');
DROP TRIGGER IF EXISTS trg_quellenanmerkungen ON plans;
CREATE TRIGGER trg_quellenanmerkungen AFTER UPDATE OR DELETE ON plans FOR EACH ROW EXECUTE FUNCTION sichere_annotierte_quelle('plan');
DROP TRIGGER IF EXISTS trg_quellenanmerkungen ON agent_artifacts;
CREATE TRIGGER trg_quellenanmerkungen AFTER UPDATE OR DELETE ON agent_artifacts FOR EACH ROW EXECUTE FUNCTION sichere_annotierte_quelle('artefakt');
DROP TRIGGER IF EXISTS trg_quellenanmerkungen ON chat_messages;
CREATE TRIGGER trg_quellenanmerkungen AFTER UPDATE OR DELETE ON chat_messages FOR EACH ROW EXECUTE FUNCTION sichere_annotierte_quelle('chat');
DROP TRIGGER IF EXISTS trg_quellenanmerkungen ON specialist_channel_messages;
CREATE TRIGGER trg_quellenanmerkungen AFTER UPDATE OR DELETE ON specialist_channel_messages FOR EACH ROW EXECUTE FUNCTION sichere_annotierte_quelle('nachricht');
`;
