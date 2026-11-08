-- P10-T90 / 181. Zwangs-Pin: Pflicht-Memory an einen Stamm (Ordner-Praefix/Glob). Schreibende files-Ops unter dem Stamm sind fuer
-- ueberwachte Claude-CLI-Kontexte gesperrt, bis dieselbe Identitaet die Memory im aktuellen Lauf + context_epoch gelesen hat.
-- Additiv und idempotent. Schalter: Produkt-Schalter zwangs_pin (Standard AUS).
-- Laufzeit-Spiegel: packages/core/src/db/zwangs-pin-schema.ts (ZWANGS_PIN_SCHEMA_SQL).
-- Die Pins selbst stehen an der Memory (Tags pflicht:<stamm> / pflicht-kurz:<text>), keine eigene Tabelle.
CREATE TABLE IF NOT EXISTS zwangs_pin_quittungen (
  project TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  lauf_id TEXT NOT NULL,
  context_epoch INTEGER NOT NULL,
  memory_name TEXT NOT NULL,
  memory_hash TEXT NOT NULL,
  agent_id TEXT,
  quittiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project, identity_id, lauf_id, context_epoch, memory_name)
);
CREATE TABLE IF NOT EXISTS zwangs_pin_ereignisse (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  art TEXT NOT NULL CHECK (art IN ('sperre','quittung','hinweis_schreiben')),
  identity_id TEXT,
  agent_id TEXT,
  lauf_id TEXT,
  context_epoch INTEGER,
  tool TEXT,
  action TEXT,
  pfade TEXT[] NOT NULL DEFAULT '{}',
  memories TEXT[] NOT NULL DEFAULT '{}',
  geltung TEXT,
  herkunft TEXT,
  wann TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_zwangs_pin_ereignisse_projekt ON zwangs_pin_ereignisse(project, wann DESC);
