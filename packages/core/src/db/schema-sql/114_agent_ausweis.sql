-- P22-T23 / 114 (Welle 12, Delta-Vertrag). Additiv und idempotent: nur ADD COLUMN IF NOT EXISTS,
-- CREATE INDEX IF NOT EXISTS und ein DROP NOT NULL (Stilllegung). Nichts wird gedroppt, kein Backfill.
-- Reihenfolge: nach 111_agent_identitaet, 112_agent_bezug und 113_agent_profil.
-- User-Entscheidungen 19.10.2026: Ausweise OFFEN speichern (63911bc7, kein Hash, kein Tresor),
-- Lebenszyklus Weg A/B (eeac2976), je Identitaet genau EIN dauerhafter Ausweis, keine Start-Rotation,
-- KEINE Sitzungsbindung (K1 gestrichen) -> keine Sitzungstabelle.

-- (1) Offener Ausweis. Lookup ausschliesslich ueber token_offen (unique). token_hash, token_verschluesselt,
--     token_schluessel_id und start_art sind STILLGELEGT: neue Zeilen lassen sie NULL; Altzeilen bleiben
--     lesbar, gelten aber nicht mehr als gueltiger Ausweis (Lookup findet sie nicht -> neu ausstellen).
ALTER TABLE agent_identitaet_tokens ADD COLUMN IF NOT EXISTS token_offen TEXT;
ALTER TABLE agent_identitaet_tokens ALTER COLUMN token_hash DROP NOT NULL;
-- Herkunft des Ausweises (nur Anzeige/Debug): vorbereitet | schatten_bestaetigt | uebernahme | register
-- | erster_koordinator | daemon_start | neu_ausgestellt.
ALTER TABLE agent_identitaet_tokens ADD COLUMN IF NOT EXISTS ausweis_weg TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_identitaet_tokens_offen
  ON agent_identitaet_tokens(token_offen) WHERE token_offen IS NOT NULL;
-- Je Identitaet hoechstens EIN nicht geloeschter offener Ausweis (ausgestellt oder aktiv).
-- Ein verfallener, nie benutzter Ausweis wird vor einer Neuausstellung geloescht (widerrufen_am).
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_identitaet_tokens_einer
  ON agent_identitaet_tokens(identity_id) WHERE widerrufen_am IS NULL AND token_offen IS NOT NULL;

-- (2) Lauf-Zustellbuchhaltung: Bezugspunkt 'aktueller Kontext' = agent_identitaet_laeufe.id (lauf_id).
--     zugestellt_profil_revision: agent_identitaeten.profil_revision, deren Profilblock in DIESEM Lauf
--       zugestellt wurde (NULL = noch keiner).
--     zugestellt_regeln_stand: Stand (sha256-Hex) der in DIESEM Lauf voll zugestellten Pflichtregeln (NULL = keine).
--     zugestellt_am: Zeitpunkt der letzten Zustellung (Bezug fuer seitdem geaenderte Task-Bindungen).
--     uebernommen_aus: Legacy-Herkunft bei Uebernahme {agent_id, sitzung, schattenprofil_id}, sonst NULL.
--     beginn_art: anmelden | fortsetzung | implizit | uebernahme (Debug, NULL = Altbestand vor 114).
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS zugestellt_profil_revision INTEGER;
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS zugestellt_regeln_stand TEXT;
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS zugestellt_am TIMESTAMPTZ;
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS uebernommen_aus JSONB;
ALTER TABLE agent_identitaet_laeufe ADD COLUMN IF NOT EXISTS beginn_art TEXT;
-- Uebernahme-Bruecke laeuft je Legacy-Ursprung hoechstens einmal (Idempotenz ueber den Lauf).
CREATE INDEX IF NOT EXISTS idx_agent_identitaet_laeufe_uebernahme
  ON agent_identitaet_laeufe(identity_id) WHERE uebernommen_aus IS NOT NULL;
