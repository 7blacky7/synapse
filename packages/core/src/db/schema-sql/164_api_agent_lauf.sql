-- P22-T183 / 164. API-Agenten laufen direkt IM synapse-api-Prozess (User 26.10.2026, Memory entscheidung-api-agenten-im-synapse-api-container):
-- kein Runtime-Container, kein Wrapper. Lauf-Verwaltung: rest-api services/api-agent-lauf.ts (Schalter api_agenten_lauf_intern, Standard AUS).
-- Additiv und idempotent: nur CREATE ... IF NOT EXISTS bzw. INSERT ... ON CONFLICT DO NOTHING, nichts wird gedroppt.
-- Laufzeit-Spiegel: packages/core/src/db/api-agent-lauf-schema.ts (API_AGENT_LAUF_SCHEMA_SQL).
--
-- api_agent_laeufe: hoechstens EIN Lauf je Identitaet. Doppel-Turn-Schutz ueber lease_token/lease_bis (EINE API-Instanz, Entscheid F4;
--   die Sperre schuetzt auch gegen einen Neustart mitten im Turn). Kontextmessung je Turn (kontext_tokens/kontext_fenster/anteil) und
--   Neustart-Steuerung (neustarts, sitzung wechselt beim Neustart) fuer die Verwaltung (User-Ergaenzung 26.10. ~02:48).
CREATE TABLE IF NOT EXISTS api_agent_laeufe (
  identity_id TEXT PRIMARY KEY REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  rolle TEXT NOT NULL,
  modell TEXT NOT NULL,
  anbieter TEXT NOT NULL CHECK (anbieter IN ('anthropic-api','openrouter-api','deepseek-api')),
  status TEXT NOT NULL DEFAULT 'bereit' CHECK (status IN ('bereit','laeuft','pausiert','gestoppt','fehler')),
  sitzung UUID NOT NULL,
  system_prompt TEXT,
  lease_token UUID,
  lease_bis TIMESTAMPTZ,
  turns INTEGER NOT NULL DEFAULT 0,
  kontext_tokens INTEGER,
  kontext_fenster INTEGER,
  kontext_anteil NUMERIC(6,4),
  neustarts INTEGER NOT NULL DEFAULT 0,
  letzter_fehler TEXT,
  letzte_aktivitaet TIMESTAMPTZ,
  gestartet_von TEXT NOT NULL,
  gestartet_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_agent_laeufe_status ON api_agent_laeufe (status);
-- P22-T278: bestehende Tabelle - Anbieter-CHECK nur ersetzen, solange er deepseek-api nicht kennt (idempotent, nur erweiternd).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'api_agent_laeufe'::regclass AND conname = 'api_agent_laeufe_anbieter_check'
                   AND pg_get_constraintdef(oid) LIKE '%deepseek-api%') THEN
    ALTER TABLE api_agent_laeufe DROP CONSTRAINT IF EXISTS api_agent_laeufe_anbieter_check;
    ALTER TABLE api_agent_laeufe ADD CONSTRAINT api_agent_laeufe_anbieter_check CHECK (anbieter IN ('anthropic-api','openrouter-api','deepseek-api'));
  END IF;
END $$;
-- api_agent_verlauf: Gespraechsverlauf je Identitaet und Sitzung (statt Datei-Verlauf des Workers). art 'nachricht' = interne
--   Nachricht (core api-agent-schleife.ts), art 'aufruf' = Vermerk VOR einem Werkzeugaufruf (Neustart-Schutz: nie wiederholen).
CREATE TABLE IF NOT EXISTS api_agent_verlauf (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  sitzung UUID NOT NULL,
  nr INTEGER NOT NULL,
  art TEXT NOT NULL CHECK (art IN ('nachricht','aufruf')),
  inhalt JSONB NOT NULL,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (identity_id, sitzung, nr)
);
-- api_agent_eingang: Auftraege/Nachrichten an einen API-Agenten. Offene Eingaenge (erledigt_am NULL) ab faellig_ab werden zu EINEM
--   Turn gebuendelt (Entscheid O3: Buendelfenster buendel_sekunden).
CREATE TABLE IF NOT EXISTS api_agent_eingang (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  quelle TEXT NOT NULL CHECK (quelle IN ('auftrag','chat','inbox','job_ende','heartbeat','neustart','main_chat')),
  absender TEXT,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  faellig_ab TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  turn_id BIGINT,
  erledigt_am TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_api_agent_eingang_offen ON api_agent_eingang (identity_id, faellig_ab) WHERE erledigt_am IS NULL;
-- api_agent_turns: ein Eintrag je Turn - Ende, Runden, Kosten, Kontext. Grundlage fuer Verbrauch je Lauf/Tag neben agent_verbrauch.
CREATE TABLE IF NOT EXISTS api_agent_turns (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  sitzung UUID NOT NULL,
  modell TEXT NOT NULL,
  gestartet_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  beendet_am TIMESTAMPTZ,
  ende TEXT,
  meldung TEXT,
  runden INTEGER NOT NULL DEFAULT 0,
  kosten_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  kontext_tokens INTEGER,
  antwort TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_agent_turns_identity ON api_agent_turns (identity_id, gestartet_am DESC);
-- api_agent_lauf_einstellungen: Einstellwerte der Lauf-Verwaltung (Regel 7: Code-Standard + PG-Wert, Quelle in der Antwort).
--   api_laeufe_max Standard 3, 1..10 (Entscheid F5, nur User); buendel_sekunden Standard 10 (O3); neustart_schwelle_prozent
--   Standard 80 (Neustart mit Uebergabe); lease_sekunden Standard 120.
-- P22-T278 C: Rueckfall-Kette bei erreichtem Tageslimit (core api-rueckfall.ts); keine Zeile = Standard haiku -> codex/gpt-6.1-terra -> codex/gpt-6.1-luna.
CREATE TABLE IF NOT EXISTS api_agent_rueckfall (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  modelle TEXT[] NOT NULL,
  effort TEXT,
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- P22-T286: einmal gebauter Sitzungs-Prompt je (Identitaet, Sitzung); Wiederverwendung nach einem Neustart des API-Prozesses.
-- Additiv/idempotent. Der Prompt wird so gespeichert, wie er gebaut wird (User-Entscheidung 08.11.: Ausweis ist kein Geheimnis).
CREATE TABLE IF NOT EXISTS api_agent_sitzung_prompt (
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  sitzung UUID NOT NULL,
  system_prompt TEXT NOT NULL,
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (identity_id, sitzung)
);
CREATE INDEX IF NOT EXISTS idx_api_agent_sitzung_prompt_identity ON api_agent_sitzung_prompt (identity_id);
CREATE TABLE IF NOT EXISTS api_agent_lauf_einstellungen (
  name TEXT PRIMARY KEY CHECK (name IN ('api_laeufe_max','buendel_sekunden','neustart_schwelle_prozent','lease_sekunden')),
  wert NUMERIC(18,6) NOT NULL CHECK (wert > 0),
  grund TEXT NOT NULL,
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- api_modell_preisstand: Herkunft der OpenRouter-Preise (Entscheid O2: aus der OpenRouter-Modellliste, mit Zeitstempel und Quelle).
CREATE TABLE IF NOT EXISTS api_modell_preisstand (
  alias TEXT PRIMARY KEY,
  quelle TEXT NOT NULL,
  eingabe_usd_mtok NUMERIC(12,6),
  ausgabe_usd_mtok NUMERIC(12,6),
  context_window INTEGER,
  stand TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- OpenRouter-Modelle der API-Agenten (Entscheid O2: deepseek-chat und deepseek-r1). OHNE Preis angelegt: erst der Abgleich
--   (core aktualisiereOpenRouterPreise) traegt Preis und Kontext aus der OpenRouter-Modellliste ein; ohne Preis kein Aufruf.
INSERT INTO model_registry
  (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max, pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit)
VALUES
  ('or-deepseek-chat', 'deepseek/deepseek-chat', 'openrouter-api', 128000, ARRAY[]::TEXT[], 'node', '@synapse/agents/api-worker', 73, 88, NULL, NULL, NULL, NULL, NULL),
  ('or-deepseek-r1',   'deepseek/deepseek-r1',   'openrouter-api', 128000, ARRAY[]::TEXT[], 'node', '@synapse/agents/api-worker', 73, 88, NULL, NULL, NULL, NULL, NULL)
ON CONFLICT (alias) DO NOTHING;
-- P22-T278: DeepSeek DIREKT (provider deepseek-api, OpenAI-Format, Key SYNAPSE_DEEPSEEK_API_KEY nur serverseitig). Preise je 1 Mio.
--   Tokens zum SPITZENTARIF (Preisseite 08.11.2026, thought c3e6c130): input = Cache-Fehlschuss, cache = Cache-Treffer, output = Ausgabe;
--   Nebenzeit halber Preis rechnet core api-deepseek.ts beim Abschluss. Laut Doku (KI-Browser 08.11.2026, api-docs.deepseek.com
--   quick_start/pricing.md): Modellnamen deepseek-flash (V4.1-Flash-1017) und deepseek-v4-pro (V4-Pro-0813), Kontext 1M bei beiden,
--   MAX OUTPUT 384K, Thinking Standard. output_limit bewusst 65536: die Ausgabe enthaelt die Gedankenkette; 64k reicht fuer Thinking
--   mit Antwort und begrenzt die Reservierung je Aufruf (max_tokens x Ausgabepreis). Ohne Schalter api_deepseek_direkt kein Aufruf.
INSERT INTO model_registry
  (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max, pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date, output_limit)
VALUES
  ('ds-flash',  'deepseek-flash',  'deepseek-api', 1000000, ARRAY[]::TEXT[], 'node', '@synapse/agents/api-worker', 73, 88, 0.30, 1.20, 0.006, NULL, 65536),
  ('ds-v4-pro', 'deepseek-v4-pro', 'deepseek-api', 1000000, ARRAY[]::TEXT[], 'node', '@synapse/agents/api-worker', 73, 88, 1.32, 3.96, 0.044, NULL, 65536)
ON CONFLICT (alias) DO NOTHING;
