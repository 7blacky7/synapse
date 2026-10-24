-- P22-T118 / 150. Additiv und idempotent: nur ADD COLUMN IF NOT EXISTS, nichts wird geaendert, geloescht oder gedroppt.
-- Ende eines Wrappers belegbar machen: wann das Ende ERKANNT wurde (nicht der tatsaechliche Todeszeitpunkt, der ist ohne
-- Prozessbeleg unbekannt), welche Ursache belegt ist (container_restart, container_start, prozess_weg) und Details
-- (letztes Lebenszeichen, verknuepftes runtime_ueberwachung_ereignisse.id, Quelle der Erkennung).
-- Gueltig nur, solange status = 'crashed'; ein neuer Lauf ueberschreibt status, die Felder bleiben als letzter Befund stehen.
ALTER TABLE wrapper_status ADD COLUMN IF NOT EXISTS beendet_erkannt_am TIMESTAMPTZ;
ALTER TABLE wrapper_status ADD COLUMN IF NOT EXISTS beendet_ursache TEXT;
ALTER TABLE wrapper_status ADD COLUMN IF NOT EXISTS beendet_details JSONB CHECK (beendet_details IS NULL OR jsonb_typeof(beendet_details) = 'object');
ALTER TABLE agent_identitaet_wrapper_status ADD COLUMN IF NOT EXISTS beendet_erkannt_am TIMESTAMPTZ;
ALTER TABLE agent_identitaet_wrapper_status ADD COLUMN IF NOT EXISTS beendet_ursache TEXT;
ALTER TABLE agent_identitaet_wrapper_status ADD COLUMN IF NOT EXISTS beendet_details JSONB CHECK (beendet_details IS NULL OR jsonb_typeof(beendet_details) = 'object');
