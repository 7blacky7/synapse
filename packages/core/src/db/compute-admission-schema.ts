/** P20-T15: einzige DDL-Quelle, Spiegel91_compute_admission.sql. */
export const COMPUTE_ADMISSION_SCHEMA_SQL = `
-- P20-T15/R2.2: HTTP-Rechnung, Chunk-Lease und residenter Modellspeicher getrennt.
CREATE TABLE IF NOT EXISTS compute_admission_domains (
 resource_domain TEXT PRIMARY KEY, host_domain TEXT NOT NULL,
 policy_hash TEXT NOT NULL CHECK(policy_hash ~ '^[a-f0-9]{64}$'),
 policy JSONB NOT NULL CHECK(jsonb_typeof(policy)='object'),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS compute_admission_requests (
 id UUID PRIMARY KEY, token UUID NOT NULL, resource_domain TEXT NOT NULL, host_domain TEXT NOT NULL,
 node_id TEXT NOT NULL, boot_id TEXT NOT NULL, auth_hash TEXT NOT NULL, source TEXT NOT NULL,
 priority TEXT NOT NULL CHECK(priority IN ('interaktiv','hintergrund','nachzug')), model TEXT NOT NULL, request_hash TEXT,
 state TEXT NOT NULL CHECK(state IN ('waiting','running','unconfirmed','finished','cancelled')),
 queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), deadline_at TIMESTAMPTZ NOT NULL,
 started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ,
 CHECK(state <> 'running' OR started_at IS NOT NULL)
);
ALTER TABLE compute_admission_requests ADD COLUMN IF NOT EXISTS request_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_compute_admission_domain ON compute_admission_requests(resource_domain,state,queued_at);
CREATE TABLE IF NOT EXISTS compute_admission_models (
 resource_domain TEXT NOT NULL, model TEXT NOT NULL, reserved_mb INTEGER NOT NULL CHECK(reserved_mb>=0),
 observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0), PRIMARY KEY(resource_domain,model)
);
ALTER TABLE compute_admission_models ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0);
CREATE TABLE IF NOT EXISTS compute_admission_metrics (
 resource_domain TEXT NOT NULL, source TEXT NOT NULL,
 requested BIGINT NOT NULL DEFAULT 0, started BIGINT NOT NULL DEFAULT 0,
 completed BIGINT NOT NULL DEFAULT 0, unconfirmed BIGINT NOT NULL DEFAULT 0,
 uncovered BIGINT NOT NULL DEFAULT 0, cancelled BIGINT NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(resource_domain,source)
);
ALTER TABLE compute_admission_metrics ADD COLUMN IF NOT EXISTS cancelled BIGINT NOT NULL DEFAULT 0;
`;
