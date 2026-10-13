-- P20-T14/R2.1: allgemeine Nicht-Embedding-Aufträge; keine Fake-code_chunks.
CREATE TABLE IF NOT EXISTS work_jobs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  capability TEXT NOT NULL,
  profile_id TEXT,
  project TEXT NOT NULL,
  scope TEXT NOT NULL,
  input_ref JSONB NOT NULL CHECK (jsonb_typeof(input_ref) = 'object'),
  resource_need JSONB NOT NULL CHECK (jsonb_typeof(resource_need) = 'object'),
  priority TEXT NOT NULL CHECK (priority IN ('interaktiv','hintergrund','nachzug')),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','staged','completed','failed','cancelled','expired')),
  owner_node TEXT,
  boot_generation UUID,
  owner_auth_hash TEXT,
  resource_domain TEXT,
  claim_token UUID,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_until TIMESTAMPTZ,
  deadline TIMESTAMPTZ,
  staged_output_ref JSONB,
  output_ref JSONB,
  error_code TEXT,
  resource_unconfirmed BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  CHECK (state NOT IN ('leased','staged') OR
    (owner_node IS NOT NULL AND boot_generation IS NOT NULL AND owner_auth_hash IS NOT NULL
      AND claim_token IS NOT NULL AND lease_until IS NOT NULL AND resource_domain IS NOT NULL)),
  CHECK (state <> 'staged' OR staged_output_ref IS NOT NULL),
  CHECK (state <> 'completed' OR output_ref IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_work_jobs_pending ON work_jobs(priority,created_at,id)
  WHERE state IN ('pending','leased','staged');
CREATE INDEX IF NOT EXISTS idx_work_jobs_node_lease ON work_jobs(owner_node,lease_until)
  WHERE state IN ('leased','staged');
CREATE INDEX IF NOT EXISTS idx_work_jobs_domain_lease ON work_jobs(resource_domain,lease_until)
  WHERE state IN ('leased','staged');
CREATE INDEX IF NOT EXISTS idx_work_jobs_project ON work_jobs(project,state,created_at);
CREATE TABLE IF NOT EXISTS work_job_audit (
  id UUID PRIMARY KEY,
  job_id UUID REFERENCES work_jobs(id),
  event TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_work_job_audit_job ON work_job_audit(job_id,created_at);
