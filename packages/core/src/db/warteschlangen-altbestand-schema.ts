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
