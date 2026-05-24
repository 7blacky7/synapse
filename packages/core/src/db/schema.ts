/**
 * MODUL: PostgreSQL Schema
 * ZWECK: DDL-Migration fuer alle Synapse-Tabellen — einmalig ausfuehren beim Start.
 *
 * INPUT:
 *   - Kein direkter Input; nutzt intern getPool() aus client.ts
 *
 * OUTPUT:
 *   - void: Schema ist nach ensureSchema() garantiert vorhanden
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: Erstellt Tabellen memories, thoughts, plans, proposals,
 *     agent_sessions, chat_messages, tech_docs, code_files, agent_events, agent_event_acks,
 *     code_symbols, code_references, code_chunks
 *   - Erweitert code_files um: content, content_hash, parsed_at, tsv (mit GIN-Index + Trigger)
 *   - Legt Indizes fuer alle Projekt- und Zeitstempel-Felder an
 *   - Idempotent: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 */

import { getPool } from './client.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT DEFAULT 'note',
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS thoughts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[] DEFAULT '{}',
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: task_id fuer Verknuepfung Thought↔Plan-Task (Idea 1, 2026-05-02)
ALTER TABLE thoughts ADD COLUMN IF NOT EXISTS task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_thoughts_project_task_id ON thoughts(project, task_id) WHERE task_id IS NOT NULL;


CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  goals TEXT[] DEFAULT '{}',
  architecture TEXT,
  tasks JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  suggested_content TEXT NOT NULL,
  description TEXT,
  author TEXT,
  status TEXT DEFAULT 'pending',
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  model TEXT,
  cutoff_date DATE,
  status TEXT DEFAULT 'active',
  server_instance_id TEXT,
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migration: server_instance_id nachtraeglich hinzufuegen
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS server_instance_id TEXT;

CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  recipient_id TEXT,
  content TEXT NOT NULL,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tech_docs (
  id TEXT PRIMARY KEY,
  framework TEXT NOT NULL,
  version TEXT NOT NULL,
  section TEXT,
  content TEXT NOT NULL,
  type TEXT,
  category TEXT DEFAULT 'framework',
  content_hash TEXT UNIQUE,
  source TEXT DEFAULT 'context7',
  indexed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS code_files (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  chunk_count INTEGER DEFAULT 0,
  file_size INTEGER DEFAULT 0,
  indexed_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project, file_path)
);

CREATE TABLE IF NOT EXISTS projects (
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_access TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (name, hostname)
);

CREATE TABLE IF NOT EXISTS agent_events (
  id SERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  scope TEXT NOT NULL DEFAULT 'all',
  source_id TEXT NOT NULL,
  payload TEXT,
  requires_ack BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_event_acks (
  event_id INTEGER REFERENCES agent_events(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  acked_at TIMESTAMPTZ DEFAULT NOW(),
  reaction TEXT,
  PRIMARY KEY (event_id, agent_id)
);

CREATE TABLE IF NOT EXISTS file_versions (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  edit_action TEXT,
  agent_id TEXT,
  batch_id BIGINT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS reason TEXT;
-- IDEA-3a: History Enrichment (additive, alle nullable)
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS feature_tag TEXT;
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS parent_version_id BIGINT;
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS git_commit_sha TEXT;
-- IDEA-6: KI-eigene Analyse/Beobachtungen pro Batch, optional
ALTER TABLE file_versions ADD COLUMN IF NOT EXISTS agent_note TEXT;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'file_versions_parent_version_id_fkey'
  ) THEN
    ALTER TABLE file_versions ADD CONSTRAINT file_versions_parent_version_id_fkey
      FOREIGN KEY (parent_version_id) REFERENCES file_versions(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_fv_feature_tag ON file_versions(project, feature_tag) WHERE feature_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fv_git_sha ON file_versions(git_commit_sha) WHERE git_commit_sha IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_fv_parent ON file_versions(parent_version_id) WHERE parent_version_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_thoughts_project ON thoughts(project);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project);
CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project, timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_messages_recipient ON chat_messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project);
CREATE INDEX IF NOT EXISTS idx_tech_docs_framework ON tech_docs(framework, version);
CREATE INDEX IF NOT EXISTS idx_tech_docs_hash ON tech_docs(content_hash);
CREATE INDEX IF NOT EXISTS idx_code_files_project ON code_files(project);
CREATE INDEX IF NOT EXISTS idx_code_files_path ON code_files(project, file_path);
CREATE INDEX IF NOT EXISTS idx_code_files_type ON code_files(project, file_type);

CREATE INDEX IF NOT EXISTS idx_agent_events_project ON agent_events(project, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type);
CREATE INDEX IF NOT EXISTS idx_agent_event_acks_agent ON agent_event_acks(agent_id);

CREATE INDEX IF NOT EXISTS idx_file_versions_lookup ON file_versions(project, file_path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_versions_batch ON file_versions(batch_id) WHERE batch_id IS NOT NULL;

-- Migration: Neue Spalten fuer Code-Intelligence
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS content TEXT;
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS parsed_at TIMESTAMPTZ;
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS tsv TSVECTOR;
ALTER TABLE code_files ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_code_files_tsv ON code_files USING GIN(tsv);
CREATE INDEX IF NOT EXISTS idx_code_files_hash ON code_files(project, content_hash);

CREATE OR REPLACE FUNCTION code_files_tsv_trigger() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector('english', COALESCE(NEW.content, ''));
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_code_files_tsv ON code_files;
CREATE TRIGGER trg_code_files_tsv
  BEFORE INSERT OR UPDATE OF content ON code_files
  FOR EACH ROW EXECUTE FUNCTION code_files_tsv_trigger();

CREATE TABLE IF NOT EXISTS code_symbols (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  symbol_type TEXT NOT NULL,
  name TEXT,
  value TEXT,
  line_start INTEGER NOT NULL,
  line_end INTEGER,
  parent_symbol TEXT REFERENCES code_symbols(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  params TEXT[],
  return_type TEXT,
  is_exported BOOLEAN DEFAULT false,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_code_symbols_project ON code_symbols(project);
CREATE INDEX IF NOT EXISTS idx_code_symbols_type ON code_symbols(project, symbol_type);
CREATE INDEX IF NOT EXISTS idx_code_symbols_name ON code_symbols(project, name);
CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(project, file_path);

CREATE TABLE IF NOT EXISTS code_references (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  symbol_id TEXT NOT NULL REFERENCES code_symbols(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  line_number INTEGER NOT NULL,
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_code_references_symbol ON code_references(symbol_id);
CREATE INDEX IF NOT EXISTS idx_code_references_file ON code_references(project, file_path);
CREATE INDEX IF NOT EXISTS idx_code_references_project ON code_references(project);

CREATE TABLE IF NOT EXISTS code_chunks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  embedded_at TIMESTAMPTZ,
  FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(project, file_path);
CREATE INDEX IF NOT EXISTS idx_code_chunks_unembedded ON code_chunks(project) WHERE embedded_at IS NULL;

-- Migration: FKs auf code_files DEFERRABLE machen (fuer move-Operation)
DO $$ BEGIN
  -- code_symbols FK
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'code_symbols_project_file_path_fkey') THEN
    ALTER TABLE code_symbols DROP CONSTRAINT code_symbols_project_file_path_fkey;
    ALTER TABLE code_symbols ADD CONSTRAINT code_symbols_project_file_path_fkey
      FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  -- code_references FK
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'code_references_project_file_path_fkey') THEN
    ALTER TABLE code_references DROP CONSTRAINT code_references_project_file_path_fkey;
    ALTER TABLE code_references ADD CONSTRAINT code_references_project_file_path_fkey
      FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  -- code_chunks FK
  IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'code_chunks_project_file_path_fkey') THEN
    ALTER TABLE code_chunks DROP CONSTRAINT code_chunks_project_file_path_fkey;
    ALTER TABLE code_chunks ADD CONSTRAINT code_chunks_project_file_path_fkey
      FOREIGN KEY (project, file_path) REFERENCES code_files(project, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- Watcher Debug-Log (alle rohen chokidar-Events, auch nicht-indexierte)
CREATE TABLE IF NOT EXISTS watcher_events (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  event_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_watcher_events_project_time ON watcher_events(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_watcher_events_path ON watcher_events(project, file_path);

-- Error Patterns (global, kein Projekt-Filter)
CREATE TABLE IF NOT EXISTS error_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  description TEXT NOT NULL,
  fix TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  model_scope TEXT NOT NULL,
  found_by TEXT NOT NULL,
  found_in_model TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Error Pattern Seen Tracking
CREATE TABLE IF NOT EXISTS error_pattern_seen (
  pattern_id UUID REFERENCES error_patterns(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  shown_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (pattern_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_error_pattern_seen_session
  ON error_pattern_seen(session_id);

-- Specialist Channels (Gruppenchat) — aus agents/schema.ts nach core verschoben
CREATE TABLE IF NOT EXISTS specialist_channels (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  project TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(name, project)
);

CREATE TABLE IF NOT EXISTS specialist_channel_members (
  channel_id INTEGER REFERENCES specialist_channels(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (channel_id, agent_name)
);

CREATE TABLE IF NOT EXISTS specialist_channel_messages (
  id SERIAL PRIMARY KEY,
  channel_id INTEGER REFERENCES specialist_channels(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Specialist Inbox (1:1 Messaging)
CREATE TABLE IF NOT EXISTS specialist_inbox (
  id SERIAL PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  content TEXT NOT NULL,
  processed BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indices (Channels + Inbox)
CREATE INDEX IF NOT EXISTS idx_specialist_inbox_unprocessed
  ON specialist_inbox(to_agent, processed) WHERE processed = false;
CREATE INDEX IF NOT EXISTS idx_specialist_channel_messages_channel
  ON specialist_channel_messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_specialist_channel_messages_created
  ON specialist_channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_specialist_channels_project
  ON specialist_channels(project);

-- LISTEN/NOTIFY Trigger fuer Event-Driven Watcher

-- Migration: UNIQUE(name) → UNIQUE(name, project) fuer Multi-Projekt-Support
ALTER TABLE specialist_channels DROP CONSTRAINT IF EXISTS specialist_channels_name_key;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'specialist_channels_name_project_key') THEN
    ALTER TABLE specialist_channels ADD CONSTRAINT specialist_channels_name_project_key UNIQUE(name, project);
  END IF;
END $$;
-- Payload: JSON mit project, sender, type etc. fuer Client-seitiges Filtering

CREATE OR REPLACE FUNCTION notify_chat_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('synapse_chat', json_build_object(
    'project', NEW.project,
    'sender_id', NEW.sender_id,
    'recipient_id', COALESCE(NEW.recipient_id, ''),
    'id', NEW.id
  )::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_chat_message ON chat_messages;
CREATE TRIGGER trg_notify_chat_message
  AFTER INSERT ON chat_messages
  FOR EACH ROW EXECUTE FUNCTION notify_chat_message();

CREATE OR REPLACE FUNCTION notify_agent_event() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('synapse_event', json_build_object(
    'project', NEW.project,
    'event_type', NEW.event_type,
    'priority', NEW.priority,
    'source_id', NEW.source_id,
    'id', NEW.id
  )::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_agent_event ON agent_events;
CREATE TRIGGER trg_notify_agent_event
  AFTER INSERT ON agent_events
  FOR EACH ROW EXECUTE FUNCTION notify_agent_event();

CREATE OR REPLACE FUNCTION notify_channel_message() RETURNS trigger AS $$
DECLARE
  ch_name TEXT;
  ch_project TEXT;
BEGIN
  SELECT name, project INTO ch_name, ch_project
    FROM specialist_channels WHERE id = NEW.channel_id;
  PERFORM pg_notify('synapse_channel', json_build_object(
    'project', COALESCE(ch_project, ''),
    'channel', COALESCE(ch_name, ''),
    'sender', NEW.sender,
    'id', NEW.id
  )::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_channel_message ON specialist_channel_messages;
CREATE TRIGGER trg_notify_channel_message
  AFTER INSERT ON specialist_channel_messages
  FOR EACH ROW EXECUTE FUNCTION notify_channel_message();

-- ==========================================================================
-- Shell-Queue (Task 1): shell_jobs + shell_stream_chunks + NOTIFY-Trigger
-- REST-API ↔ FileWatcher-Daemon Shell-Exec via PostgreSQL LISTEN/NOTIFY.
-- ==========================================================================

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

-- Additive Migrations: actionable error-message + persistenter Voll-Output.
-- message: getrennt vom error-Code, damit Web-KI-Connectors dem User
--   sagen koennen was zu tun ist ("Projekt im Tray aktivieren").
-- output: Worker schreibt stdout+stderr bei Completion direkt in PG
--   (gecappt 1MB) — REST-API auf Unraid kann ohne Filesystem-Zugriff
--   zur Projekt-Maschine den Log lesen.
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS message TEXT;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS output TEXT;
ALTER TABLE shell_jobs ADD COLUMN IF NOT EXISTS output_truncated BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_shell_jobs_project_status ON shell_jobs(project, status);
CREATE INDEX IF NOT EXISTS idx_shell_jobs_created ON shell_jobs(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_shell_jobs_history ON shell_jobs(project, created_at DESC);

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

CREATE TABLE IF NOT EXISTS shell_stream_chunks (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES shell_jobs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  line TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shell_stream_chunks_job ON shell_stream_chunks(job_id, chunk_index);

-- ==========================================================================
-- Specialist-Queue: REST-API ↔ FileWatcher-Daemon Specialist-Calls.
-- Alle Specialist-Actions (spawn, stop, purge, wake, etc.) werden via PG
-- Queue an den lokalen Daemon delegiert. Erlaubt Web-KIs (REST) Spezialisten
-- auf dem Host-PC zu spawnen wo Claude-CLI + FS verfuegbar sind.
-- ==========================================================================

DO $$ BEGIN
  CREATE TYPE specialist_job_status AS ENUM ('pending', 'running', 'done', 'failed', 'rejected', 'timeout');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS specialist_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project TEXT NOT NULL,
  action TEXT NOT NULL,
  args JSONB NOT NULL,
  status specialist_job_status NOT NULL DEFAULT 'pending',
  result JSONB,
  error TEXT,
  message TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_specialist_jobs_project_status ON specialist_jobs(project, status);
CREATE INDEX IF NOT EXISTS idx_specialist_jobs_created ON specialist_jobs(created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_specialist_jobs_history ON specialist_jobs(project, created_at DESC);

CREATE OR REPLACE FUNCTION notify_specialist_job_created() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('specialist_job_created', NEW.project || ':' || NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_specialist_jobs_notify ON specialist_jobs;
CREATE TRIGGER trg_specialist_jobs_notify
  AFTER INSERT ON specialist_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_specialist_job_created();

-- ==========================================================================
-- Project-Init-Queue: REST-API ↔ FileWatcher-Daemon Project-Bootstrap.
-- Web-KIs (REST) koennen neue Projekte anlegen ohne Filesystem-Zugriff —
-- der Daemon auf dem Ziel-PC resolved den Workspace-Root, mkdir, git init,
-- registriert in projects-Tabelle und startet ggf. den FileWatcher.
-- ==========================================================================

DO $$ BEGIN
  CREATE TYPE project_init_status AS ENUM ('pending', 'running', 'done', 'failed', 'rejected', 'timeout');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS project_init_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  hostname TEXT,
  template TEXT,
  requested_by TEXT,
  status project_init_status NOT NULL DEFAULT 'pending',
  resolved_path TEXT,
  error TEXT,
  message TEXT,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_init_jobs_status ON project_init_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_project_init_jobs_pending ON project_init_jobs(created_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION notify_project_init_job_created() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('project_init_job_created', NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_project_init_jobs_notify ON project_init_jobs;
CREATE TRIGGER trg_project_init_jobs_notify
  AFTER INSERT ON project_init_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_project_init_job_created();

-- ==========================================================================
-- Multi-File Edit-Plans: Plan/Commit-Phase fuer atomare Multi-Datei-Aenderungen.
-- Eine KI/Agent ruft files.plan(ops[]) -> erhaelt plan_id + previews.
-- files.commit(plan_id) wendet alle Ops in einer TX an, prueft expected_hashes
-- gegen aktuellen Stand. Bei Mismatch -> stale. Erfolgreicher Commit setzt
-- batch_id in jedem file_versions-Snapshot -> restore_batch funktioniert.
-- ==========================================================================

DO $$ BEGIN
  CREATE TYPE file_batch_status AS ENUM ('open', 'committed', 'cancelled', 'expired', 'stale');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS file_batch_plans (
  id BIGSERIAL PRIMARY KEY,
  project TEXT NOT NULL,
  owner_agent_id TEXT,
  ops JSONB NOT NULL,
  expected_hashes JSONB NOT NULL,
  previews JSONB NOT NULL,
  status file_batch_status NOT NULL DEFAULT 'open',
  open_for_coedit BOOLEAN NOT NULL DEFAULT TRUE,
  notify_channel TEXT,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_file_batch_plans_status ON file_batch_plans(project, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_file_batch_plans_open ON file_batch_plans(project, expires_at) WHERE status = 'open';
ALTER TABLE file_batch_plans ADD COLUMN IF NOT EXISTS reason TEXT;

-- File-Change-Notify: jeder INSERT in file_versions feuert pg_notify('synapse_file', ...)
-- damit Wrapper bei File-Aenderungen sofort reagieren koennen (Heartbeat-Reset auf 10s
-- + buffered wake-message mit "welche Datei wurde von wem geaendert").
CREATE OR REPLACE FUNCTION notify_file_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('synapse_file', json_build_object(
    'project', NEW.project,
    'file_path', NEW.file_path,
    'edit_action', NEW.edit_action,
    'agent_id', COALESCE(NEW.agent_id, ''),
    'id', NEW.id::text
  )::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_file_change ON file_versions;
CREATE TRIGGER trg_notify_file_change
  AFTER INSERT ON file_versions
  FOR EACH ROW EXECUTE FUNCTION notify_file_change();

-- ==========================================================================
-- model_registry: zentrale Source-of-Truth fuer Spezialisten-Modelle.
-- Web-UI/REST kann neue Modelle anlegen ohne Recompile.
-- Wrapper macht 1x Lookup beim Start, In-Memory-Cache fuer Lebensdauer (DB-1).
-- Multi-Daemon: kein Cache-Drift weil Sessions PK haben + Modell pro Spawn fixiert (DB-2 nicht relevant).
-- ALTER TABLE-Risiko bei vielen agent_sessions Rows (>10k): siehe DB-3 Doku.
-- Unbekannter Alias bei Spawn: clear error mit listAliases-Output (DB-4).
-- ==========================================================================
CREATE TABLE IF NOT EXISTS model_registry (
  alias TEXT PRIMARY KEY,
  full_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  context_window INT NOT NULL,
  output_limit INT,
  env_required TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  runtime_binary TEXT NOT NULL DEFAULT 'claude',  -- 'binary' ist SQL-reserved
  runtime_path TEXT,
  corridor_min INT NOT NULL,
  corridor_max INT NOT NULL,
  pricing_input_usd_per_mtok NUMERIC(10,4),
  pricing_output_usd_per_mtok NUMERIC(10,4),
  pricing_cache_usd_per_mtok NUMERIC(10,4),
  cutoff_date DATE,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Provider-Credentials (optional — wenn SYNAPSE_GEMINI_USE_EMBEDDING_KEY=false)
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- agent_sessions: Provider + Model-Full-ID nachtraeglich
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS provider TEXT;
ALTER TABLE agent_sessions ADD COLUMN IF NOT EXISTS model_full_id TEXT;

-- Initial-Seed (idempotent via ON CONFLICT)
INSERT INTO model_registry
  (alias, full_id, provider, context_window, env_required, runtime_binary, runtime_path, corridor_min, corridor_max, pricing_input_usd_per_mtok, pricing_output_usd_per_mtok, pricing_cache_usd_per_mtok, cutoff_date)
VALUES
  ('opus',              'claude-opus-4-7',                'anthropic',  200000, ARRAY[]::TEXT[],          'claude', NULL,                                90, 99, 15.00, 75.00, 1.50, '2025-01-01'),
  ('sonnet',            'claude-sonnet-4-6',              'anthropic',  200000, ARRAY[]::TEXT[],          'claude', NULL,                                80, 88,  3.00, 15.00, 0.30, '2025-01-01'),
  ('haiku',             'claude-haiku-4-5',               'anthropic',  200000, ARRAY[]::TEXT[],          'claude', NULL,                                80, 88,  1.00,  5.00, 0.10, '2025-01-01'),
  ('opus[1m]',          'claude-opus-4-7',                'anthropic', 1000000, ARRAY[]::TEXT[],          'claude', NULL,                                80, 99, 15.00, 75.00, 1.50, '2025-01-01'),
  ('sonnet[1m]',        'claude-sonnet-4-6',              'anthropic', 1000000, ARRAY[]::TEXT[],          'claude', NULL,                                70, 88,  3.00, 15.00, 0.30, '2025-01-01'),
  ('gemini-flash-lite', 'gemini-3.1-flash-lite-preview',  'google',    1000000, ARRAY['GOOGLE_API_KEY'],  'node',   '@synapse/agents-gemini/runtime',    80, 88,  0.25,  1.50, 0.025, '2025-01-01'),
  ('gemini-flash',      'gemini-3-flash-preview',         'google',    1000000, ARRAY['GOOGLE_API_KEY'],  'node',   '@synapse/agents-gemini/runtime',    80, 88,  0.50,  3.00, 0.05,  '2025-01-01'),
  ('gemini-pro',        'gemini-2.5-pro',                 'google',    1000000, ARRAY['GOOGLE_API_KEY'],  'node',   '@synapse/agents-gemini/runtime',    80, 88,  1.25, 10.00, 0.13,  '2025-01-01'),
  -- agy-CLI: Pro-Abo via Keyring, KEIN API-Key (env_required leer), provider 'antigravity' (getrennt von 'google')
  ('antigravity',       'agy-1.0.2',                      'antigravity', 1000000, ARRAY[]::TEXT[],         'node',   '@synapse/agents-antigravity/runtime', 95, 99, NULL,  NULL,  NULL,  NULL)
ON CONFLICT (alias) DO NOTHING;

-- ==========================================================================
-- wrapper_status: Source-of-Truth fuer laufende Wrapper/Spezialisten.
-- Ersetzt .synapse/agents/status.json als primaere Datenquelle.
-- Beide Eingangs-Pfade (stdio-MCP + REST) lesen/schreiben diese Tabelle.
-- status.json bleibt als optionaler Cache fuer Backward-Compat.
-- ==========================================================================

CREATE TABLE IF NOT EXISTS wrapper_status (
  agent_name TEXT NOT NULL,
  project TEXT NOT NULL,
  wrapper_pid INTEGER,
  inner_pid INTEGER,
  socket_path TEXT,
  model TEXT,
  model_full_id TEXT,
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'idle',  -- running/idle/crashed/stopped
  busy BOOLEAN NOT NULL DEFAULT false,
  current_task TEXT,
  context_ceiling INTEGER,
  tokens_input INTEGER,
  tokens_output INTEGER,
  tokens_percent NUMERIC(5,2),
  channels TEXT[] NOT NULL DEFAULT '{}',
  connected_mcp BOOLEAN NOT NULL DEFAULT false,
  last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_name, project)
);

CREATE INDEX IF NOT EXISTS idx_wrapper_status_project ON wrapper_status(project);
CREATE INDEX IF NOT EXISTS idx_wrapper_status_last_activity ON wrapper_status(last_activity);
-- Reaper-Query-Index: WHERE status='running' AND last_activity < NOW() - INTERVAL '3 min'
CREATE INDEX IF NOT EXISTS idx_wrapper_status_status ON wrapper_status(status, last_activity);

`;

export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(SCHEMA_SQL);
  console.error('[Synapse] PostgreSQL Schema bereit');
}
