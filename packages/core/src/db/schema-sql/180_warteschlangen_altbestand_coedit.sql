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
