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

-- LISTEN/NOTIFY Trigger fuer Event-Driven Watcher
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
`;

export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(SCHEMA_SQL);
  console.error('[Synapse] PostgreSQL Schema bereit');
}
