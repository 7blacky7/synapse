/** P22-T173: Spiegel 159_agent_namens_alias.sql. Additiv/idempotent; keine Abhaengigkeit von anderen Tabellen. */
export const AGENT_NAMENS_ALIAS_SCHEMA_SQL = `
-- P22-T173 / 159. Agenten-Identitaet umbenennen (Name aendern, Ausweis bleibt). Additiv und idempotent: nur CREATE ... IF NOT EXISTS.
-- Je Umbenennung eine Zeile: der fruehere Name (agent_id) bleibt als ALIAS der Identitaet auffindbar und fuer sie reserviert; Inhalte
-- (Thoughts, Channel-/Chat-Nachrichten, Dateiversionen ...) bleiben unter dem alten Namen. Kein Fremdschluessel: Historie, blockiert das
-- Loeschen eines Projekts nicht (wie agent_entfernungen). profil_revision = die mit der Umbenennung angelegte Profil-Revision (Hinweis
-- w1b.profil_update nennt 'Name alt -> neu').
-- Laufzeit-Spiegel: packages/core/src/db/agent-namens-alias-schema.ts (AGENT_NAMENS_ALIAS_SCHEMA_SQL).
CREATE TABLE IF NOT EXISTS agent_namens_aliase (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  alter_name TEXT NOT NULL,
  alter_identitaet_name TEXT,
  alte_instanz_nr INTEGER,
  neuer_name TEXT NOT NULL,
  umbenannt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  umbenannt_von TEXT NOT NULL,
  actor_identity_id TEXT,
  grund TEXT NOT NULL,
  user_auftrag TEXT,
  profil_revision INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_namens_aliase_alt ON agent_namens_aliase(project, alter_name);
CREATE INDEX IF NOT EXISTS idx_agent_namens_aliase_identity ON agent_namens_aliase(identity_id, umbenannt_am DESC);
`;
