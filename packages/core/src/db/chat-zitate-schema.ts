/** P22-T168: Spiegel 157_chat_zitate.sql. Additiv/idempotent. */
export const CHAT_ZITATE_SCHEMA_SQL = `
-- P22-T168 / 157. Zitat-Anhaenge im Chat: Grenzen der Zitate als Einstellwerte (Regel 7; Code-Standard CHAT_ZITATE_EINSTELLUNGEN in
-- chat-zitate.ts, keine Zeile = Standard). Additiv und idempotent.
-- Laufzeit-Spiegel: packages/core/src/db/chat-zitate-schema.ts (CHAT_ZITATE_SCHEMA_SQL).
CREATE TABLE IF NOT EXISTS chat_zitate_einstellungen (
 name TEXT PRIMARY KEY, wert JSONB NOT NULL, grund TEXT NOT NULL,
 gesetzt_von TEXT NOT NULL, gesetzt_am TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
