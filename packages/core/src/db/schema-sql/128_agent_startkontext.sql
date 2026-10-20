-- P22-T78 / 128. Additiv und idempotent: nur ADD COLUMN IF NOT EXISTS, nichts wird geaendert, geloescht oder gedroppt.
-- Startkontext (Startpaket) nur bei Beginn eines NEUEN Laufs: beim Bauen fuer die System-Prompt-Route wird er an der Identitaet als
-- offen gemerkt; die naechste Anmeldung (= neuer Lauf) bucht ihn genau einmal auf den Lauf.
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS startkontext_offen JSONB;
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS startkontext_am TIMESTAMPTZ;
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS startkontext_meta JSONB;
