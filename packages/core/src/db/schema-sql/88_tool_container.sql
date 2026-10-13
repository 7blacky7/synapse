-- P20-T19 R5.1: Descriptor/Policy/Instanzzustand additiv, keine Altcontainer umschreiben.
CREATE TABLE IF NOT EXISTS tool_descriptors (
 tool_id TEXT PRIMARY KEY, capability TEXT NOT NULL UNIQUE, descriptor JSONB NOT NULL,
 descriptor_hash TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT FALSE,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS tool_activation (
 tool_id TEXT NOT NULL REFERENCES tool_descriptors(tool_id), project TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT FALSE, updated_by TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(tool_id,project)
);
CREATE TABLE IF NOT EXISTS tool_containers (
 instance_id TEXT PRIMARY KEY, tool_id TEXT NOT NULL REFERENCES tool_descriptors(tool_id),
 project TEXT NOT NULL, work_job_id UUID, generation UUID NOT NULL,
 state TEXT NOT NULL DEFAULT 'cold' CHECK(state IN('cold','waiting','warm','stopping','blocked')),
 container_id TEXT, resource_token TEXT, operation_token UUID,
 start_inflight BOOLEAN NOT NULL DEFAULT FALSE,
 wake_requested BOOLEAN NOT NULL DEFAULT FALSE,
 warmup_job_id UUID REFERENCES work_jobs(id), ready_at TIMESTAMPTZ,
 operation_at TIMESTAMPTZ, measurement_at TIMESTAMPTZ,
 cpu_percent DOUBLE PRECISION, gpu_percent DOUBLE PRECISION,
 coldstart_ms INTEGER, starts TIMESTAMPTZ[] NOT NULL DEFAULT '{}',
 blocked_until TIMESTAMPTZ, last_error TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE tool_containers ADD COLUMN IF NOT EXISTS start_inflight BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_tool_containers_tool_project ON tool_containers(tool_id,project);
CREATE TABLE IF NOT EXISTS tool_container_runs (
 job_id UUID NOT NULL REFERENCES work_jobs(id), attempt INTEGER NOT NULL,
 instance_id TEXT NOT NULL REFERENCES tool_containers(instance_id), generation UUID NOT NULL,
 state TEXT NOT NULL CHECK(state IN('running','done','unknown')), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(job_id,attempt)
);
