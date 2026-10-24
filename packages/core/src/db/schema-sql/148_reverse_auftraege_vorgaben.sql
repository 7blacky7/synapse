-- P18-T114: Teilindex fuer vorgaben() (reverse-analyse-policy.ts): nur explizite/alte Agent-Wurzeln (wenige Zeilen).
-- Praedikat identisch zur Abfrage, damit der Planer ihn statt eines Voll-Scans je Policy-Pruefung nimmt.
CREATE INDEX IF NOT EXISTS idx_reverse_auftraege_vorgaben ON reverse_auftraege(eintrag_id,created_at)
 WHERE (policy_pin->>'ursprung'='manuell' OR policy_pin IS NULL AND ausloeser LIKE 'agent:%' AND ausloeser<>'agent:reverse-pipeline');
