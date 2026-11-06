/** P27-T11: Spiegel 179_warteschlangen_altbestand.sql. Additiv/idempotent; keine Abhaengigkeit von anderen Tabellen. */
export const WARTESCHLANGEN_ALTBESTAND_SCHEMA_SQL = `
-- P27-T11 / 179. Additiv und idempotent: CREATE ... IF NOT EXISTS und eine einmalige Erweiterung des Status-CHECK von agent_zustellungen;
-- keine Daten werden geaendert oder geloescht, alle bisherigen Werte bleiben gueltig.
-- Altbestand in Warteschlangen AUSBLENDEN statt loeschen (User 01.11.2026: "nichts loeschen, sondern einfach nur nicht mehr anzeigen").
-- Eine Markierung je ausgeblendetem Eintrag in einer EIGENEN Tabelle; vorher haelt den Zustand vor dem Ausblenden fuer den Rueckweg.
-- Kein Fremdschluessel: die Markierung ist Historie und darf das Loeschen von Inbox-/Zustellungs-Zeilen nie blockieren.
CREATE TABLE IF NOT EXISTS warteschlangen_ausblendungen (
  id BIGSERIAL PRIMARY KEY,
  warteschlange TEXT NOT NULL CHECK (warteschlange IN ('specialist_inbox','zustellungen')),
  eintrag_id BIGINT NOT NULL,
  project TEXT,
  empfaenger TEXT,
  eintrag_erstellt_am TIMESTAMPTZ,
  vorher JSONB NOT NULL,
  ausgeblendet_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ausgeblendet_von TEXT NOT NULL,
  ausgeblendet_grund TEXT NOT NULL,
  user_auftrag TEXT,
  schwelle_tage INTEGER NOT NULL,
  lauf_id TEXT NOT NULL,
  wiederhergestellt_am TIMESTAMPTZ,
  wiederhergestellt_von TEXT,
  wiederhergestellt_grund TEXT
);
-- Hoechstens eine OFFENE Markierung je Eintrag; geschlossene (wiederhergestellte) bleiben als Historie.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warteschlangen_ausblendungen_offen ON warteschlangen_ausblendungen(warteschlange, eintrag_id) WHERE wiederhergestellt_am IS NULL;
CREATE INDEX IF NOT EXISTS idx_warteschlangen_ausblendungen_lauf ON warteschlangen_ausblendungen(lauf_id);
-- Einstellwerte (Code-Standard + PG-Wert, Quelle sichtbar): bisher nur die Schwelle in Tagen.
CREATE TABLE IF NOT EXISTS warteschlangen_altbestand_einstellungen (
  name TEXT PRIMARY KEY,
  wert JSONB NOT NULL,
  gesetzt_von TEXT NOT NULL,
  gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  grund TEXT
);
-- Zustellungen: eigener Status 'ausgeblendet' statt 'fehler' (Koordinator #t128-team 34681). Alle Ledger-Leser filtern status='pending';
-- ein ausgeblendeter Eintrag sieht so nicht wie ein echter Fehler aus. Nur umgestellt, solange die Definition 'ausgeblendet' nicht kennt.
DO $zustellung_status$
BEGIN
  IF to_regclass('agent_zustellungen') IS NOT NULL AND EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('agent_zustellungen')
       AND conname = 'agent_zustellungen_status_check' AND pg_get_constraintdef(oid) NOT LIKE '%ausgeblendet%') THEN
    ALTER TABLE agent_zustellungen DROP CONSTRAINT IF EXISTS agent_zustellungen_status_check;
    ALTER TABLE agent_zustellungen ADD CONSTRAINT agent_zustellungen_status_check
      CHECK (status IN ('pending','zugestellt','fehler','ausgeblendet'));
  END IF;
END
$zustellung_status$;
`;

/** P27-T10: Spiegel 180_warteschlangen_altbestand_coedit.sql (nach 179). Additiv/idempotent. */
export const WARTESCHLANGEN_ALTBESTAND_COEDIT_SCHEMA_SQL = `
-- P27-T10 / 180. Additiv und idempotent, nach 179_warteschlangen_altbestand: warteschlangen_ausblendungen kennt die Warteschlange
-- 'coedit_waits' (admin warteschlangen_aufraeumen, abgelaufene nicht geschlossene Co-Edit-Waits). Keine Daten werden geaendert oder geloescht.
-- Co-Edit-Waits haben einen UUID-Schluessel (file_batch_waits.wait_token): eigene Spalte eintrag_uuid, eintrag_id darf dafuer leer bleiben.
-- Alle bisherigen Markierungen haben eintrag_id und bleiben gueltig; je Zeile ist mindestens einer der beiden Schluessel gesetzt.
ALTER TABLE warteschlangen_ausblendungen ADD COLUMN IF NOT EXISTS eintrag_uuid UUID;
ALTER TABLE warteschlangen_ausblendungen ALTER COLUMN eintrag_id DROP NOT NULL;
-- Hoechstens eine OFFENE Markierung je Wait (wie uq_warteschlangen_ausblendungen_offen fuer eintrag_id).
CREATE UNIQUE INDEX IF NOT EXISTS uq_warteschlangen_ausblendungen_offen_uuid ON warteschlangen_ausblendungen(warteschlange, eintrag_uuid)
  WHERE wiederhergestellt_am IS NULL AND eintrag_uuid IS NOT NULL;
-- CHECK der Warteschlange: der alte (ohne coedit_waits) wird durch den erweiterten ersetzt; ist er schon erweitert, passiert nichts.
DO $ausblendung_coedit$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = to_regclass('warteschlangen_ausblendungen') AND contype = 'c'
             AND pg_get_constraintdef(oid) LIKE '%specialist_inbox%' AND pg_get_constraintdef(oid) NOT LIKE '%coedit_waits%' LOOP
    EXECUTE format('ALTER TABLE warteschlangen_ausblendungen DROP CONSTRAINT %I', r.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('warteschlangen_ausblendungen') AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%coedit_waits%') THEN
    ALTER TABLE warteschlangen_ausblendungen ADD CONSTRAINT warteschlangen_ausblendungen_warteschlange_check
      CHECK (warteschlange IN ('specialist_inbox','zustellungen','coedit_waits'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('warteschlangen_ausblendungen')
       AND conname = 'warteschlangen_ausblendungen_schluessel_check') THEN
    ALTER TABLE warteschlangen_ausblendungen ADD CONSTRAINT warteschlangen_ausblendungen_schluessel_check
      CHECK (eintrag_id IS NOT NULL OR eintrag_uuid IS NOT NULL);
  END IF;
END
$ausblendung_coedit$;
`;
