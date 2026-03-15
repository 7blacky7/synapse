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
  registered_at TIMESTAMPTZ DEFAULT NOW()
);

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

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_thoughts_project ON thoughts(project);
CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project);
CREATE INDEX IF NOT EXISTS idx_proposals_project ON proposals(project);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project, timestamp);
CREATE INDEX IF NOT EXISTS idx_chat_messages_recipient ON chat_messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project);
CREATE INDEX IF NOT EXISTS idx_tech_docs_framework ON tech_docs(framework, version);
CREATE INDEX IF NOT EXISTS idx_tech_docs_hash ON tech_docs(content_hash);
`;

export async function ensureSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(SCHEMA_SQL);
  console.error('[Synapse] PostgreSQL Schema bereit');
}
