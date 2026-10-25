-- P22-T6 / 123 (W2c). Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt oder umgeschrieben.
-- Zustellung von Nachrichten an Agenten im Runtime-Container ueber den Container-Daemon (kein Hook, kein Weckweg):
-- je Nachricht genau eine Zeile (identity_id, weg, message_id), Wiederholung bei beschaeftigtem Agenten.
CREATE TABLE IF NOT EXISTS agent_zustellungen (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  weg TEXT NOT NULL CHECK (weg IN ('inbox','chat','channel','event')),
  message_id BIGINT NOT NULL,
  zustellung JSONB NOT NULL CHECK (jsonb_typeof(zustellung) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','zugestellt','fehler')),
  versuche INTEGER NOT NULL DEFAULT 0 CHECK (versuche >= 0),
  naechster_versuch TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  letzter_grund TEXT,
  job_id TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  zugestellt_am TIMESTAMPTZ,
  UNIQUE (identity_id, weg, message_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_zustellungen_offen
  ON agent_zustellungen(identity_id, naechster_versuch) WHERE status = 'pending';
-- Wasserstand je Identitaet und Weg: beim ersten Lauf = hoechste vorhandene ID (keine Historien-Flut).
CREATE TABLE IF NOT EXISTS agent_zustell_wasserstaende (
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id),
  weg TEXT NOT NULL CHECK (weg IN ('inbox','chat','channel','event')),
  bis_id BIGINT NOT NULL,
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (identity_id, weg)
);
-- P22-T144 (additiv): Quittung des Agenten je Zustellung. quittung_seit = Quittung angefordert (nur bei Schalter
-- inbox_quittung gesetzt, kein Altbestand), quittiert_am = vom Agenten quittiert, erinnert_am = letzte Erinnerung des Systems.
ALTER TABLE agent_zustellungen ADD COLUMN IF NOT EXISTS quittung_seit TIMESTAMPTZ;
ALTER TABLE agent_zustellungen ADD COLUMN IF NOT EXISTS quittiert_am TIMESTAMPTZ;
ALTER TABLE agent_zustellungen ADD COLUMN IF NOT EXISTS erinnert_am TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_agent_zustellungen_quittung_offen
  ON agent_zustellungen(identity_id) WHERE quittung_seit IS NOT NULL AND quittiert_am IS NULL;
