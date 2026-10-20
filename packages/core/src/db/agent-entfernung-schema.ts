/** P22-T80: Spiegel 126_agent_entfernung.sql. Additiv/idempotent; keine Abhaengigkeit von anderen Tabellen. */
export const AGENT_ENTFERNUNG_SCHEMA_SQL = `
-- P22-T80 / 126. Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird geaendert, geloescht oder gedroppt.
-- Weiche Entfernung alter Agenten: eine Markierung je Agent (Legacy-Sitzung oder Identitaet) in einer EIGENEN Tabelle. Alle Daten der
-- Agenten (Verlauf, Thoughts, Memories, Tool-Calls, Skills, Ausweise) bleiben unveraendert; Wiederherstellen schliesst die Markierung.
-- Kein Fremdschluessel auf agent_identitaeten: die Markierung ist Historie und darf das Loeschen eines Projekts nicht blockieren.
CREATE TABLE IF NOT EXISTS agent_entfernungen (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  art TEXT NOT NULL CHECK (art IN ('legacy','identitaet')),
  agent_id TEXT NOT NULL,
  identity_id TEXT,
  entfernt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entfernt_grund TEXT NOT NULL,
  letzte_aktivitaet TIMESTAMPTZ,
  schwelle_tage INTEGER,
  entfernt_von TEXT NOT NULL,
  lauf_id TEXT NOT NULL,
  wiederhergestellt_am TIMESTAMPTZ,
  wiederhergestellt_von TEXT,
  wiederhergestellt_grund TEXT,
  CHECK ((art = 'identitaet') = (identity_id IS NOT NULL))
);
-- Hoechstens eine OFFENE Markierung je Agent; geschlossene (wiederhergestellte) bleiben als Historie.
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_entfernungen_offen ON agent_entfernungen(project, art, agent_id) WHERE wiederhergestellt_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_entfernungen_identity ON agent_entfernungen(identity_id) WHERE identity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_entfernungen_lauf ON agent_entfernungen(lauf_id);
-- Einstellwerte (Regel 7: Code-Standard + PG-Wert, Quelle sichtbar): bisher nur die Schwelle in Tagen.
CREATE TABLE IF NOT EXISTS agent_entfernung_einstellungen (
  name TEXT PRIMARY KEY,
  wert JSONB NOT NULL,
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  grund TEXT
);
`;

/** P22-T80 Teil 3: Spiegel 129_agent_umbenennung.sql (Archivieren = Umbenennen). Additiv/idempotent, nach 126. */
export const AGENT_UMBENENNUNG_SCHEMA_SQL = `
-- P22-T80 Teil 3 / 129 (User 8edbc2c7). Additiv und idempotent: nur ADD COLUMN / CREATE INDEX IF NOT EXISTS, nichts wird geaendert oder gedroppt.
-- Archivieren = Umbenennen: der Agent-Eintrag heisst danach 'archiv-<YYYYMMDD>-<alter-name>' (agent_id der Markierung = neuer Name), der alte
-- Name ist frei. frueherer_* haelt fest, was das Wiederherstellen zuruecksetzt. Inhalte (Thoughts, Channel, Verlauf ...) bleiben unter dem alten Namen.
ALTER TABLE agent_entfernungen ADD COLUMN IF NOT EXISTS frueherer_name TEXT;
ALTER TABLE agent_entfernungen ADD COLUMN IF NOT EXISTS neuer_name TEXT;
ALTER TABLE agent_entfernungen ADD COLUMN IF NOT EXISTS frueherer_identitaet_name TEXT;
ALTER TABLE agent_entfernungen ADD COLUMN IF NOT EXISTS frueherer_status TEXT;
CREATE INDEX IF NOT EXISTS idx_agent_entfernungen_frueherer_name ON agent_entfernungen(project, frueherer_name) WHERE wiederhergestellt_am IS NULL AND frueherer_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_entfernungen_neuer_name ON agent_entfernungen(project, neuer_name) WHERE neuer_name IS NOT NULL;
`;
