-- P22-T80 Teil 3 / 129 (User 8edbc2c7). Additiv und idempotent: nur ADD COLUMN / CREATE INDEX IF NOT EXISTS, nichts wird geaendert oder gedroppt.
-- Archivieren = Umbenennen: der Agent-Eintrag heisst danach 'archiv-<YYYYMMDD>-<alter-name>' (agent_id der Markierung = neuer Name), der alte
-- Name ist frei. frueherer_* haelt fest, was das Wiederherstellen zuruecksetzt. Inhalte (Thoughts, Channel, Verlauf ...) bleiben unter dem alten Namen.
ALTER TABLE agent_entfernungen ADD COLUMN IF NOT EXISTS frueherer_name TEXT;
ALTER TABLE agent_entfernungen ADD COLUMN IF NOT EXISTS neuer_name TEXT;
ALTER TABLE agent_entfernungen ADD COLUMN IF NOT EXISTS frueherer_identitaet_name TEXT;
ALTER TABLE agent_entfernungen ADD COLUMN IF NOT EXISTS frueherer_status TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_entfernungen_frueherer_name ON agent_entfernungen(project, frueherer_name) WHERE wiederhergestellt_am IS NULL AND frueherer_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_entfernungen_neuer_name ON agent_entfernungen(project, neuer_name) WHERE neuer_name IS NOT NULL;
