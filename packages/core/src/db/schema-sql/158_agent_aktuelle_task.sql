-- P22-T172 / 158. Aktuelle Task je Agent: Zeitfenster der Aktivitaets-Signale als Einstellwert (Regel 7; Code-Standard
-- AKTUELLE_TASK_EINSTELLUNGEN in agent-aktuelle-task.ts, keine Zeile = Standard). Additiv und idempotent.
-- Laufzeit-Spiegel: packages/core/src/db/agent-aktuelle-task-schema.ts (AGENT_AKTUELLE_TASK_SCHEMA_SQL).
CREATE TABLE IF NOT EXISTS agent_aktuelle_task_einstellungen (
 name TEXT PRIMARY KEY, wert JSONB NOT NULL, grund TEXT NOT NULL,
 gesetzt_von TEXT NOT NULL, gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
