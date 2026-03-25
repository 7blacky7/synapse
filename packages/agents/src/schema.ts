import { getPool } from '@synapse/core'

export const AGENTS_SCHEMA = `
-- Specialist Channels (Gruppenchat)
CREATE TABLE IF NOT EXISTS specialist_channels (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  description TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
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

-- Performance Indices
CREATE INDEX IF NOT EXISTS idx_specialist_inbox_unprocessed
  ON specialist_inbox(to_agent, processed) WHERE processed = false;
CREATE INDEX IF NOT EXISTS idx_specialist_channel_messages_channel
  ON specialist_channel_messages(channel_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_specialist_channel_messages_created
  ON specialist_channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_specialist_channels_project
  ON specialist_channels(project);
`

export async function ensureAgentsSchema(): Promise<void> {
  const pool = getPool()
  await pool.query(AGENTS_SCHEMA)
}
