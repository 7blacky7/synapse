-- Migration: shell_jobs Queue (Task 1 der Shell-Queue)
-- Additiv, idempotent. Fuer produktive PG.

-- ENUM idempotent anlegen
DO $$ BEGIN
  CREATE TYPE shell_job_status AS ENUM ('pending', 'running', 'done', 'failed', 'rejected', 'timeout');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS shell_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd_relative TEXT,
  timeout_ms INTEGER DEFAULT 30000,
  tail_lines INTEGER DEFAULT 5,
  status shell_job_status NOT NULL DEFAULT 'pending',
  exit_code INTEGER,
  tail JSONB,
  error TEXT,
  stream_id TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shell_jobs_project_status ON shell_jobs(project, status);
CREATE INDEX IF NOT EXISTS idx_shell_jobs_created ON shell_jobs(created_at) WHERE status = 'pending';

-- NOTIFY trigger: pusht beim INSERT mit "project:uuid" als Payload
CREATE OR REPLACE FUNCTION notify_shell_job_created() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('shell_job_created', NEW.project || ':' || NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_shell_jobs_notify ON shell_jobs;
CREATE TRIGGER trg_shell_jobs_notify
  AFTER INSERT ON shell_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_shell_job_created();

-- Stream-Chunks fuer get_stream bei langlaufenden Jobs
CREATE TABLE IF NOT EXISTS shell_stream_chunks (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES shell_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  line TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shell_stream_chunks_job ON shell_stream_chunks(job_id, chunk_index);
