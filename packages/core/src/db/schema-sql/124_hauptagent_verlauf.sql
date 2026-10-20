-- P22-T63 / 124. Additiv und idempotent: nur CREATE ... IF NOT EXISTS bzw. ADD COLUMN IF NOT EXISTS, nichts wird gedroppt.
-- Vollstaendiger Verlauf des Hauptagenten je Main-Identitaet, alle Richtungen (Vertrag 97d9a354 + Nachtrag 823715c5):
-- Web-UI, Zustellungen (inbox/chat/channel/event), eigene Ausgaben und Werkzeuge, Lauf-/Wechsel-Marker. Nie gekuerzt.
-- Reihenfolge = id; rev = Aenderungszaehler fuer den Live-Abgleich der Geraete (nextval bei jedem Schreiben).
CREATE SEQUENCE IF NOT EXISTS hauptagent_verlauf_rev;
CREATE TABLE IF NOT EXISTS hauptagent_verlauf (
  id BIGSERIAL PRIMARY KEY,
  identity_id TEXT NOT NULL REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  rolle TEXT NOT NULL CHECK (rolle IN ('user','agent','nachricht','ausgabe','system')),
  richtung TEXT NOT NULL CHECK (richtung IN ('ein','aus','intern')),
  weg TEXT NOT NULL CHECK (weg IN ('webui','inbox','chat','channel','event','heartbeat','werkzeug','lauf','wechsel')),
  absender JSONB CHECK (absender IS NULL OR jsonb_typeof(absender) = 'object'),
  quelle_ref TEXT,
  antwort_auf BIGINT UNIQUE REFERENCES hauptagent_verlauf(id) ON DELETE CASCADE,
  gehoert_zu BIGINT REFERENCES hauptagent_verlauf(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'fertig' CHECK (status IN ('laeuft','fertig','fehler','abgebrochen')),
  text TEXT NOT NULL DEFAULT '',
  werkzeuge JSONB NOT NULL DEFAULT '{"calls":[],"phasen":[]}'::jsonb CHECK (jsonb_typeof(werkzeuge) = 'object'),
  artefakte JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(artefakte) = 'array'),
  anhaenge JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(anhaenge) = 'array'),
  hinweise JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(hinweise) = 'array'),
  meta JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(meta) = 'object'),
  tokens JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(tokens) = 'object'),
  kontext JSONB CHECK (kontext IS NULL OR jsonb_typeof(kontext) = 'object'),
  zug JSONB CHECK (zug IS NULL OR jsonb_typeof(zug) = 'object'),
  verbrauch_referenzen TEXT[] NOT NULL DEFAULT '{}',
  zaehlt BOOLEAN NOT NULL DEFAULT true,
  lauf_id TEXT,
  session_id TEXT,
  runtime TEXT,
  modell TEXT,
  hauptagent_weg TEXT,
  geraet TEXT,
  rev BIGINT NOT NULL DEFAULT nextval('hauptagent_verlauf_rev'),
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  aktualisiert_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (identity_id, quelle_ref),
  CHECK ((rolle = 'agent') = (antwort_auf IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_hauptagent_verlauf_seite ON hauptagent_verlauf(identity_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_hauptagent_verlauf_rev ON hauptagent_verlauf(identity_id, rev);
CREATE INDEX IF NOT EXISTS idx_hauptagent_verlauf_lauf ON hauptagent_verlauf(identity_id, lauf_id, id);
-- Stand je Identitaet: Ausblenden durch den User (Anzeige ab ausgeblendet_bis_id, Daten bleiben), geleert_rev fuer andere
-- Geraete, Kalibrierfaktoren der eigenen Token-Zaehlung je Modellfamilie.
CREATE TABLE IF NOT EXISTS hauptagent_verlauf_stand (
  identity_id TEXT PRIMARY KEY REFERENCES agent_identitaeten(id) ON DELETE CASCADE,
  geleert_rev BIGINT NOT NULL DEFAULT 0,
  ausgeblendet_bis_id BIGINT NOT NULL DEFAULT 0,
  geleert_am TIMESTAMPTZ,
  geleert_von TEXT,
  geleert_anzahl INTEGER,
  kalibrierung JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(kalibrierung) = 'object')
);
-- Verbrauch (Schema 119) bleibt Quelle der Wahrheit fuer die Abrechnung; messart unterscheidet CLI-Messung und eigene Rechnung.
ALTER TABLE agent_verbrauch ADD COLUMN IF NOT EXISTS messart TEXT NOT NULL DEFAULT 'gemessen' CHECK (messart IN ('gemessen','berechnet'));
