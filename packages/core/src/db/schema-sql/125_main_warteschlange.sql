-- P22-T71/P22-T73 / 125. Additiv und idempotent: keine Daten werden geaendert, alle bisherigen Werte bleiben gueltig.
-- T73 Warteschlange des Main-Chats: eine User-Nachricht, die der Main gerade nicht annehmen kann, bleibt mit ihrer Antwortzeile
-- im Verlauf stehen (status 'wartet', meta.warteschlange) und wird nach der Wiederherstellung zugestellt. Kein eigener Ledger.
DO $verlauf_status$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'hauptagent_verlauf'::regclass
                   AND conname = 'hauptagent_verlauf_status_check'
                   AND pg_get_constraintdef(oid) LIKE '%wartet%') THEN
    ALTER TABLE hauptagent_verlauf DROP CONSTRAINT IF EXISTS hauptagent_verlauf_status_check;
    ALTER TABLE hauptagent_verlauf ADD CONSTRAINT hauptagent_verlauf_status_check
      CHECK (status IN ('laeuft','fertig','fehler','abgebrochen','wartet'));
  END IF;
END
$verlauf_status$;
CREATE INDEX IF NOT EXISTS idx_hauptagent_verlauf_wartet ON hauptagent_verlauf(identity_id, id) WHERE status = 'wartet';
-- T71 Zwischenschritt eines laufenden Runtime-Auftrags (stoppt_alt, alt_gestoppt, startet, laeuft) fuer den Chip der Web-UI.
ALTER TABLE agent_runtime_auftraege ADD COLUMN IF NOT EXISTS fortschritt JSONB
  CHECK (fortschritt IS NULL OR jsonb_typeof(fortschritt) = 'object');
