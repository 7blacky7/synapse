-- P22-T7 / 119 (W2d). Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt oder umgeschrieben.
-- Verbrauch der Agenten je Aufruf/Turn (User bf473136, 523133e6): Abo-CLIs (claude, codex) nur Tokens ohne Grenze,
-- API-Zugaenge zusaetzlich USD (bucht P22-T8, Budget dort). Eine Zeile je Buchung; Auswertung je Agent/Projekt/Monat in
-- services/agent-verbrauch.ts. Bewusst OHNE Fremdschluessel auf agent_identitaeten: der Verbrauch bleibt als Protokoll
-- erhalten, auch wenn eine Identitaet entfernt wird (wie jev_aufrufe).
--   zugang    abo (CLI mit Abo-Login) | api (kostenpflichtiger Schluessel)
--   quelle    main_chat (Web-UI-Main-Chat, Altweg je Turn) | wrapper (Wrapper je Turn) | api_worker (T8-Transport)
--   referenz  optionaler Idempotenz-Schluessel je Quelle (doppelte Meldung desselben Turns bucht nicht doppelt)
CREATE TABLE IF NOT EXISTS agent_verbrauch (
  id BIGSERIAL PRIMARY KEY,
  zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  project TEXT NOT NULL,
  identity_id TEXT,
  agent_id TEXT NOT NULL,
  runtime TEXT NOT NULL,
  zugang TEXT NOT NULL CHECK (zugang IN ('abo','api')),
  modell TEXT,
  input_tokens BIGINT NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cache_creation_tokens >= 0),
  usd NUMERIC(18,8) CHECK (usd IS NULL OR usd >= 0),
  usd_quelle TEXT CHECK (usd_quelle IS NULL OR usd_quelle IN ('antwort','listenpreis','reservierung')),
  quelle TEXT NOT NULL CHECK (quelle IN ('main_chat','wrapper','api_worker')),
  lauf_id TEXT,
  referenz TEXT,
  CHECK (zugang = 'api' OR usd IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_verbrauch_referenz
  ON agent_verbrauch(quelle, referenz) WHERE referenz IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_verbrauch_zeit ON agent_verbrauch(zeit DESC);
CREATE INDEX IF NOT EXISTS idx_agent_verbrauch_project ON agent_verbrauch(project, zeit DESC);
CREATE INDEX IF NOT EXISTS idx_agent_verbrauch_identity ON agent_verbrauch(identity_id, zeit DESC) WHERE identity_id IS NOT NULL;
