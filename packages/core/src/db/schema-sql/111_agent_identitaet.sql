-- P22-T10: Identitaet dauerhaft, Ausweis nur Hash, keine Lauf-/Inboxmigration.
CREATE TABLE IF NOT EXISTS agent_identitaeten (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  instanz_nr INTEGER NOT NULL DEFAULT 1 CHECK (instanz_nr > 0),
  agent_id TEXT NOT NULL,
  rolle TEXT NOT NULL DEFAULT 'subagent',
  modell_bestaetigt TEXT,
  modell_selbstauskunft TEXT,
  profil JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(profil) = 'object'),
  startrezept JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(startrezept) = 'object'),
  status TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv','deaktiviert')),
  erstellt_von TEXT NOT NULL,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  zuletzt_aktiv TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  context_epoch INTEGER NOT NULL DEFAULT 0 CHECK (context_epoch >= 0),
  UNIQUE (project, name, instanz_nr),
  UNIQUE (project, agent_id)
);
CREATE TABLE IF NOT EXISTS agent_identitaet_tokens (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_praefix TEXT NOT NULL,
  start_art TEXT,
  start_uebergang BOOLEAN NOT NULL DEFAULT FALSE,
  gueltig_bis TIMESTAMPTZ,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  zuletzt_benutzt TIMESTAMPTZ,
  widerrufen_am TIMESTAMPTZ,
  widerrufen_von TEXT,
  widerrufen_grund TEXT
);
ALTER TABLE agent_identitaet_tokens ADD COLUMN IF NOT EXISTS start_uebergang BOOLEAN NOT NULL DEFAULT FALSE;
-- Bisher ungenutzte Start-Ausweise beim Schemawechsel ebenfalls begrenzen.
UPDATE agent_identitaet_tokens SET gueltig_bis=erstellt_am+INTERVAL '10 minutes'
  WHERE start_art IS NOT NULL AND zuletzt_benutzt IS NULL AND gueltig_bis IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_identitaet_tokens_identity ON agent_identitaet_tokens(identity_id);
CREATE TABLE IF NOT EXISTS agent_identitaet_audit (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  wer TEXT NOT NULL,
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktion TEXT NOT NULL,
  alt JSONB,
  neu JSONB,
  grund TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_identitaet_audit_identity ON agent_identitaet_audit(identity_id, wann DESC);
-- User27698: eine Identitaet hat genau einen aktiven logischen Lauf.
CREATE TABLE IF NOT EXISTS agent_identitaet_laeufe (
  id TEXT PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  context_epoch INTEGER NOT NULL CHECK (context_epoch > 0),
  status TEXT NOT NULL CHECK (status IN ('aktiv','abgeloest')),
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  abgeloest_am TIMESTAMPTZ,
  abgeloest_durch TEXT,
  UNIQUE (identity_id, context_epoch)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_identitaet_lauf_aktiv
  ON agent_identitaet_laeufe(identity_id) WHERE status='aktiv';
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS identity_id TEXT REFERENCES agent_identitaeten(id);
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS context_epoch INTEGER NOT NULL DEFAULT 0;
