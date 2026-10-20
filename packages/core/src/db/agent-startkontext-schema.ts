/** P22-T78: Spiegel 128_agent_startkontext.sql. Additiv/idempotent; setzt agent_identitaeten (111) und agent_identitaet_laeufe voraus. */
export const AGENT_STARTKONTEXT_SCHEMA_SQL = `
-- P22-T78 / 128. Additiv und idempotent: nur ADD COLUMN IF NOT EXISTS, nichts wird geaendert, geloescht oder gedroppt.
-- Startkontext (Startpaket) nur bei Beginn eines NEUEN Laufs: beim Bauen fuer die System-Prompt-Route wird er an der Identitaet als
-- offen gemerkt; die naechste Anmeldung (= neuer Lauf) bucht ihn genau einmal auf den Lauf.
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS startkontext_offen JSONB;
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS startkontext_am TIMESTAMPTZ;
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS startkontext_meta JSONB;
`;
