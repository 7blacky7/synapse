/** P22-T141: Spiegel 151_artefakt_bewertung.sql. Additiv/idempotent, keine Abhaengigkeit von Bestandstabellen. */
export const ARTEFAKT_BEWERTUNG_SCHEMA_SQL = `
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
`;

/** P22-T161: Spiegel 156_artefakt_bewertung_notify.sql (Trigger fuer den Live-Strom der Top-Artefakte). Nach ARTEFAKT_BEWERTUNG_SCHEMA_SQL. */
export const ARTEFAKT_BEWERTUNG_NOTIFY_SCHEMA_SQL = `
-- P22-T161 / 156. Top-Artefakte live: jede Aenderung einer Bewertung meldet NOTIFY synapse_artefakt_bewertung (id, project, zustand,
-- quelle, op). Additiv und idempotent (CREATE OR REPLACE FUNCTION, Trigger nur wenn noch nicht vorhanden). Nach 151_artefakt_bewertung.sql.
-- Laufzeit-Spiegel: packages/core/src/db/artefakt-bewertung-schema.ts (ARTEFAKT_BEWERTUNG_NOTIFY_SCHEMA_SQL).
CREATE OR REPLACE FUNCTION notify_artefakt_bewertung() RETURNS trigger AS $fn$
BEGIN
 IF TG_OP = 'DELETE' THEN
  PERFORM pg_notify('synapse_artefakt_bewertung', json_build_object('id', OLD.id::text, 'project', COALESCE(OLD.project, ''), 'zustand', OLD.zustand,
   'quelle_art', OLD.quelle_art, 'quelle_ref', OLD.quelle_ref, 'op', TG_OP)::text);
 ELSE
  PERFORM pg_notify('synapse_artefakt_bewertung', json_build_object('id', NEW.id::text, 'project', COALESCE(NEW.project, ''), 'zustand', NEW.zustand,
   'quelle_art', NEW.quelle_art, 'quelle_ref', NEW.quelle_ref, 'op', TG_OP)::text);
 END IF;
 RETURN NULL;
END;
$fn$ LANGUAGE plpgsql;
DO $block$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_notify_artefakt_bewertung' AND tgrelid = 'artefakt_bewertungen'::regclass) THEN
  CREATE TRIGGER trg_notify_artefakt_bewertung AFTER INSERT OR UPDATE OR DELETE ON artefakt_bewertungen FOR EACH ROW EXECUTE FUNCTION notify_artefakt_bewertung();
 END IF;
END;
$block$;
`;
