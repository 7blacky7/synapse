-- P20-T20 / R5.2: korrektheitsrelevante Aktivitaet, getrennt vom best-effort Audit.
CREATE TABLE IF NOT EXISTS tool_aktivitaet (
 id BIGSERIAL PRIMARY KEY,
 projekt TEXT NOT NULL CHECK (length(btrim(projekt)) > 0),
 tool TEXT NOT NULL CHECK (length(btrim(tool)) > 0),
 aktion TEXT NOT NULL CHECK (length(btrim(aktion)) > 0),
 agent_id TEXT,
 tool_id TEXT NOT NULL CHECK (length(btrim(tool_id)) > 0),
 container_id TEXT,
 job_id TEXT,
 akzeptiert BOOLEAN NOT NULL,
 berechtigt BOOLEAN NOT NULL,
 projekt_gebunden BOOLEAN NOT NULL,
 zaehlt_als_aktivitaet BOOLEAN NOT NULL,
 zeit TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK (NOT zaehlt_als_aktivitaet OR (akzeptiert AND berechtigt AND projekt_gebunden))
);
CREATE INDEX IF NOT EXISTS idx_tool_aktivitaet_passend
 ON tool_aktivitaet(projekt, tool_id, tool, zeit DESC, id DESC)
 WHERE zaehlt_als_aktivitaet;
CREATE INDEX IF NOT EXISTS idx_tool_aktivitaet_zeit ON tool_aktivitaet(zeit);
