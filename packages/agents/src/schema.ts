import { getPool } from '@synapse/core'

export const AGENTS_SCHEMA = `
-- Specialist Channels (Gruppenchat)
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
  last_read_message_id BIGINT,
  last_notified_message_id BIGINT,
  read_initialized_at TIMESTAMPTZ,
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
ALTER TABLE specialist_channel_members ADD COLUMN IF NOT EXISTS last_read_message_id BIGINT;
ALTER TABLE specialist_channel_members ADD COLUMN IF NOT EXISTS last_notified_message_id BIGINT;
ALTER TABLE specialist_channel_members ADD COLUMN IF NOT EXISTS read_initialized_at TIMESTAMPTZ;
UPDATE specialist_channel_members mem
SET last_read_message_id=COALESCE(mem.last_read_message_id,
      (SELECT MAX(msg.id) FROM specialist_channel_messages msg WHERE msg.channel_id=mem.channel_id),0),
    last_notified_message_id=COALESCE(mem.last_notified_message_id,mem.last_read_message_id,
      (SELECT MAX(msg.id) FROM specialist_channel_messages msg WHERE msg.channel_id=mem.channel_id),0),
    read_initialized_at=COALESCE(mem.read_initialized_at,mem.joined_at,NOW())
WHERE mem.last_read_message_id IS NULL OR mem.last_notified_message_id IS NULL
   OR mem.read_initialized_at IS NULL;
ALTER TABLE specialist_channel_members
  ALTER COLUMN last_read_message_id SET DEFAULT 0,
  ALTER COLUMN last_read_message_id SET NOT NULL,
  ALTER COLUMN read_initialized_at SET DEFAULT NOW(),
  ALTER COLUMN read_initialized_at SET NOT NULL;

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
CREATE INDEX IF NOT EXISTS idx_specialist_channel_members_agent
  ON specialist_channel_members(agent_name, channel_id);
`

export async function ensureAgentsSchema(): Promise<void> {
  const pool = getPool()
  await pool.query(AGENTS_SCHEMA)
}
