-- P22-T254: User-Lesestand gehört zum Channel, User ist keine Agentenidentität.
ALTER TABLE specialist_channels ADD COLUMN IF NOT EXISTS user_last_read_message_id BIGINT NOT NULL DEFAULT 0;
