/** P22-T58 (W2e): Spiegel 122_runtime_ueberwachung.sql. Additiv/idempotent; ohne Fremdschluessel, Reihenfolge beliebig nach dem Basisschema. */
export const RUNTIME_UEBERWACHUNG_SCHEMA_SQL = `
-- P22-T58 / 122 (W2e). Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt oder umgeschrieben.
-- Ueberwachung der Runtime-Container durch die API (User 59995e5d: Steuerung in der API, Prozesshalter im Container).
-- Lesestelle und Regeln: services/runtime-ueberwachung.ts. Ohne Fremdschluessel (Protokoll bleibt, wie agent_verbrauch).
--   runtime_ueberwachung_stand        eine Zeile je ueberwachter Runtime (claude|codex); ueberlebt API-Neustarts
--   runtime_ueberwachung_ereignisse   Protokoll der Ausfaelle und Massnahmen (details ohne Geheimnisse)
--   runtime_ueberwachung_einstellungen Einstellwerte; fehlt eine Zeile, gilt der Code-Standard
CREATE TABLE IF NOT EXISTS runtime_ueberwachung_stand (
  runtime TEXT PRIMARY KEY,
  zustand TEXT NOT NULL DEFAULT 'unbekannt'
    CHECK (zustand IN ('unbekannt','ok','gestoert','neustart_laeuft','ausgefallen','abgeloest','angehalten','erschoepft')),
  ursache TEXT,
  seit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  letzter_ok TIMESTAMPTZ,
  versuche JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(versuche) = 'array'),
  container_soll_laufen BOOLEAN NOT NULL DEFAULT FALSE,
  main_laeuft_seit TIMESTAMPTZ,
  beobachtung JSONB CHECK (beobachtung IS NULL OR jsonb_typeof(beobachtung) = 'object'),
  letzter_fehler TEXT,
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS runtime_ueberwachung_ereignisse (
  id BIGSERIAL PRIMARY KEY,
  zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  runtime TEXT NOT NULL,
  art TEXT NOT NULL,
  ursache TEXT,
  details JSONB CHECK (details IS NULL OR jsonb_typeof(details) = 'object'),
  auftrag_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_runtime_ueberwachung_ereignisse_zeit ON runtime_ueberwachung_ereignisse(zeit DESC);
CREATE INDEX IF NOT EXISTS idx_runtime_ueberwachung_ereignisse_runtime ON runtime_ueberwachung_ereignisse(runtime, zeit DESC);
CREATE TABLE IF NOT EXISTS runtime_ueberwachung_einstellungen (
  name TEXT PRIMARY KEY,
  wert JSONB NOT NULL,
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Nachtrag 2 (User 9faa5c9f): Wiederbelebung nach Fencing, CLI-Update aus der API.
ALTER TABLE runtime_ueberwachung_stand ADD COLUMN IF NOT EXISTS wiederbelebung_letzter TIMESTAMPTZ;
ALTER TABLE runtime_ueberwachung_stand ADD COLUMN IF NOT EXISTS cli_update_am TIMESTAMPTZ;
ALTER TABLE runtime_ueberwachung_stand ADD COLUMN IF NOT EXISTS cli_update_ergebnis JSONB;
-- Abo-Kontingent erschoepft (Meldung des Wrappers: Claude rate_limit_event status rejected, Codex Usage-Limit) bis zur Reset-Zeit.
ALTER TABLE runtime_ueberwachung_stand ADD COLUMN IF NOT EXISTS kontingent_bis TIMESTAMPTZ;
ALTER TABLE runtime_ueberwachung_stand ADD COLUMN IF NOT EXISTS kontingent_art TEXT;
ALTER TABLE runtime_ueberwachung_stand ADD COLUMN IF NOT EXISTS kontingent_von TEXT;
ALTER TABLE runtime_ueberwachung_stand ADD COLUMN IF NOT EXISTS kontingent_gemeldet_am TIMESTAMPTZ;
-- Umzuege der Kette Claude -> Codex -> Free und zurueck (je Identitaet hoechstens ein offener Umzug). Ausweis/Profil bleiben.
CREATE TABLE IF NOT EXISTS runtime_ueberwachung_umzuege (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL,
  project TEXT NOT NULL,
  agent_name TEXT,
  ist_main BOOLEAN NOT NULL DEFAULT FALSE,
  ursprung_runtime TEXT NOT NULL,
  von_runtime TEXT NOT NULL,
  nach_runtime TEXT NOT NULL,
  rueck_ziel TEXT,
  modell_ursprung TEXT,
  spawn_args JSONB CHECK (spawn_args IS NULL OR jsonb_typeof(spawn_args) = 'object'),
  status TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv','wechsel_stop','zurueck_stop','zurueck','fehlgeschlagen')),
  ursache TEXT,
  job_id TEXT,
  stop_job_id TEXT,
  auftrag_id TEXT,
  letzter_fehler TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  abgeschlossen_am TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_ueberwachung_umzug_offen ON runtime_ueberwachung_umzuege(identity_id) WHERE status IN ('aktiv','wechsel_stop','zurueck_stop');
CREATE INDEX IF NOT EXISTS idx_runtime_ueberwachung_umzuege_zeit ON runtime_ueberwachung_umzuege(erstellt_am DESC);
`;
