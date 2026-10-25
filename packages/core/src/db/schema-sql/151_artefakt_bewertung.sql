-- P22-T141 / 151. Artefakt-Bewertung (Design-Gedaechtnis, global). Additiv und idempotent: nur neue Tabellen und Indizes.
-- artefakt_bewertungen: aktueller Stand je Quelle (Hauptagent-Artefakt, HTML-Antwort per Inbox, HTML aus dem Verlauf).
-- Zustand aus dem Urteil: hoch -> vorbild; runter + Kommentar -> ueberarbeiten; runter ohne Kommentar -> verbannt;
-- versuch_gezeigt = zu einem 'ueberarbeiten' ist ein Nachfolger-Versuch verknuepft (nachfolger_art/_ref).
-- html/titel/urheber = Schnappschuss, den der Server selbst aus der Quelle liest. Jede Aenderung steht in der Historie.
CREATE TABLE IF NOT EXISTS artefakt_bewertungen (
  id BIGSERIAL PRIMARY KEY,
  quelle_art TEXT NOT NULL CHECK (quelle_art IN ('artefakt','inbox','verlauf')),
  quelle_ref TEXT NOT NULL,
  quelle_revision INTEGER,
  project TEXT,
  urheber_agent TEXT,
  urheber_identity_id TEXT,
  titel TEXT,
  html TEXT NOT NULL,
  merkmale JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(merkmale) = 'object'),
  urteil TEXT NOT NULL CHECK (urteil IN ('hoch','runter')),
  kommentar TEXT,
  zustand TEXT NOT NULL CHECK (zustand IN ('vorbild','ueberarbeiten','verbannt','versuch_gezeigt')),
  nachfolger_art TEXT CHECK (nachfolger_art IS NULL OR nachfolger_art IN ('artefakt','inbox','verlauf')),
  nachfolger_ref TEXT,
  versuch_von TEXT,
  versuch_am TIMESTAMPTZ,
  bewertet_von TEXT NOT NULL DEFAULT 'user',
  bewertet_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  erstellt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  anzahl_bewertungen INTEGER NOT NULL DEFAULT 1,
  UNIQUE (quelle_art, quelle_ref)
);
CREATE INDEX IF NOT EXISTS idx_artefakt_bewertungen_zustand ON artefakt_bewertungen(zustand, bewertet_am DESC);
CREATE TABLE IF NOT EXISTS artefakt_bewertungen_historie (
  id BIGSERIAL PRIMARY KEY,
  bewertung_id BIGINT NOT NULL REFERENCES artefakt_bewertungen(id) ON DELETE CASCADE,
  urteil TEXT NOT NULL,
  kommentar TEXT,
  zustand TEXT NOT NULL,
  nachfolger_art TEXT,
  nachfolger_ref TEXT,
  von TEXT NOT NULL,
  am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_artefakt_bewertungen_historie ON artefakt_bewertungen_historie(bewertung_id, am);
