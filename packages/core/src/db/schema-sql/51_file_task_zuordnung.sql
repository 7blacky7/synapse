-- P6-T26: Audit ausschliesslich expliziter Nachzuordnungen; Altbestand wird nicht aktualisiert.
CREATE TABLE IF NOT EXISTS public.file_version_task_zuordnungen (
    id BIGSERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    version_id BIGINT NOT NULL,
    vorher_task_id TEXT,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    grund TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fv_task_zuordnung_version
    ON public.file_version_task_zuordnungen(version_id, id);
