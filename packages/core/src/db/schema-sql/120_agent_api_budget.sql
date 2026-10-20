-- P22-T8 / 120. Additiv und idempotent: nur CREATE ... IF NOT EXISTS, nichts wird gedroppt oder umgeschrieben.
-- Kostenpflichtiger API-Agent (Claude per API-Key, User 58d2c6cb/ca755410/bf473136). Spiegel: db/agent-api-budget-schema.ts.
-- Lesestelle und Regeln: services/api-agent-dienst.ts. Reihenfolge: nach 111 (agent_identitaeten).
--
-- api_agent_budget: GENAU EINE globale Zeile (id = 1). Fehlt sie, gibt es KEINE kostenpflichtigen Aufrufe.
--   grenze_usd je Zeitraum (tag | woche | monat ab reset_tag), erlaubte_modelle = Registry-Aliase (leer = keins).
CREATE TABLE IF NOT EXISTS api_agent_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  grenze_usd NUMERIC(18,6) NOT NULL CHECK (grenze_usd > 0),
  zeitraum TEXT NOT NULL DEFAULT 'monat' CHECK (zeitraum IN ('tag','woche','monat')),
  reset_tag INTEGER NOT NULL DEFAULT 1 CHECK (reset_tag BETWEEN 1 AND 28),
  erlaubte_modelle TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- api_agent_einstellungen: Einstellwerte (Regel 7: nie Hartwert, nie nur Env). Fehlt eine Zeile, gilt der Code-Standard.
--   max_tokens_obergrenze  hoechstes max_tokens je Aufruf (Standard 32000)
--   reservierung_minuten   offene Reservierung ohne Abschluss verfaellt danach und zaehlt VOLL (Standard 15)
--   toolrunden_max         Toolrunden je Nachricht im Worker (Standard 50)
--   laufzeit_minuten       Laufzeit je Nachricht im Worker (Standard 30)
--   cache_schreib_faktor   Aufschlag auf den Eingabepreis fuer cache_creation-Tokens (Standard 1.25)
CREATE TABLE IF NOT EXISTS api_agent_einstellungen (
  name TEXT PRIMARY KEY CHECK (name IN ('max_tokens_obergrenze','reservierung_minuten','toolrunden_max','laufzeit_minuten','cache_schreib_faktor')),
  wert NUMERIC(18,6) NOT NULL CHECK (wert > 0),
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  setter_identity_id TEXT REFERENCES agent_identitaeten(id),
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- api_agent_reservierungen: atomare Budget-Reservierung VOR jedem Anbieter-Aufruf (obere Kostenschranke), danach Abschluss
-- mit den echten Kosten. Verbraucht im Zeitraum = gebucht (usd) + offen + verfallen (reserviert_usd, konservativ).
--   offen        reserviert, Aufruf laeuft
--   gebucht      abgeschlossen, usd = echte Kosten (usd_quelle antwort) bzw. volle Reservierung (usd_quelle reservierung)
--   freigegeben  Anbieter hat nachweislich nichts berechnet (Fehler vor der Antwort), usd 0
--   verfallen    ohne Abschluss abgelaufen, zaehlt voll (nie als kostenlos)
CREATE TABLE IF NOT EXISTS api_agent_reservierungen (
  id UUID PRIMARY KEY,
  identity_id TEXT REFERENCES agent_identitaeten(id),
  project TEXT,
  modell TEXT NOT NULL,
  anbieter_modell TEXT NOT NULL,
  reserviert_usd NUMERIC(18,8) NOT NULL CHECK (reserviert_usd >= 0),
  status TEXT NOT NULL DEFAULT 'offen' CHECK (status IN ('offen','gebucht','freigegeben','verfallen')),
  usd NUMERIC(18,8),
  usd_quelle TEXT CHECK (usd_quelle IS NULL OR usd_quelle IN ('antwort','reservierung','keine')),
  input_tokens BIGINT,
  output_tokens BIGINT,
  cache_read_tokens BIGINT,
  cache_creation_tokens BIGINT,
  stop_reason TEXT,
  fehler TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  frist_bis TIMESTAMPTZ NOT NULL,
  abgeschlossen_am TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_agent_reservierungen_zeit ON api_agent_reservierungen(erstellt_am);
CREATE INDEX IF NOT EXISTS idx_api_agent_reservierungen_offen ON api_agent_reservierungen(frist_bis) WHERE status = 'offen';
CREATE INDEX IF NOT EXISTS idx_api_agent_reservierungen_identity ON api_agent_reservierungen(identity_id, erstellt_am);
