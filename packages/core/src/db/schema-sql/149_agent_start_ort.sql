-- P22-T113 / 149. Additiv und idempotent: nur ADD COLUMN IF NOT EXISTS, nichts wird geaendert, geloescht oder gedroppt.
-- Startort JEDER Identitaet: container = API -> Runtime-Container (Web-UI), daemon = API -> lokaler Daemon/Tray (PC),
-- extern = selbst gestartet, nur angemeldet (CLI, Web-KI). start_ziel: Runtime (claude/codex), PC-Hostname bzw. Herkunft.
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS start_ort TEXT CHECK (start_ort IS NULL OR start_ort IN ('container','daemon','extern'));
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS start_ziel TEXT;
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS start_ort_quelle TEXT;
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS start_ort_am TIMESTAMPTZ;
-- Stufe 2 (nur vorbereitet, keine Erkennung): genauere Art eines externen Starts, setzt spaeter der Tray.
ALTER TABLE agent_identitaeten ADD COLUMN IF NOT EXISTS start_ort_art TEXT CHECK (start_ort_art IS NULL OR start_ort_art IN ('desktop_cli','web_ki'));
