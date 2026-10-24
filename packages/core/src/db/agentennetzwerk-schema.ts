/** P22-T93: Spiegel 135_agentennetzwerk.sql. */
export const AGENTENNETZWERK_SCHEMA_SQL = `
-- P22-T93: Metadaten-Signal fuer den bestehenden Projekt-SSE-Weg; niemals Inhalte.
-- P22-T102: successful automatic commit, never inferred from timestamps or user text.
ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS auto_commit BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS agentennetzwerk_einstellungen (
 name TEXT PRIMARY KEY, wert JSONB NOT NULL, grund TEXT NOT NULL,
 gesetzt_von TEXT NOT NULL, gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- P22-T123 (Abnahme 2ecbc7e7 R1/R4): belegte Akteur-Identitaet eines Aufrufs im fremden Projekt (logToolCall, nie aus einem
-- Namen) und Einstellwerte der Tool-Karten. Additiv; die Spalte vor der Funktion, die sie liest.
ALTER TABLE tool_calls ADD COLUMN IF NOT EXISTS akteur_identity_id TEXT;
CREATE TABLE IF NOT EXISTS verlauf_tool_karten_einstellungen (
 name TEXT PRIMARY KEY, wert JSONB NOT NULL, grund TEXT NOT NULL,
 gesetzt_von TEXT NOT NULL, gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE OR REPLACE FUNCTION notify_tool_activity() RETURNS trigger AS $fn$
BEGIN
 PERFORM pg_notify('synapse_tool_activity', json_build_object(
  'project', NEW.project, 'id', NEW.id::text, 'identity_id', NEW.identity_id, 'akteur_identity_id', NEW.akteur_identity_id)::text);
 RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
DO $block$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_tool_activity' AND tgrelid='tool_calls'::regclass) THEN
  CREATE TRIGGER trg_tool_activity AFTER INSERT ON tool_calls FOR EACH ROW EXECUTE FUNCTION notify_tool_activity();
 END IF;
END;
$block$;
CREATE INDEX IF NOT EXISTS idx_tool_calls_network ON tool_calls(project, id DESC);
`;
