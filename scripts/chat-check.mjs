#!/usr/bin/env node
// chat-check.mjs — Prüft ungelesene Chat-Nachrichten via PostgreSQL
// Aufgerufen von chat-notify.sh
// Args: <agent_id> <project> <since_timestamp> <db_url>

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../packages/core/package.json'));
const pg = require('pg');
const { Pool } = pg;

const [,, agentId, project, since, dbUrl] = process.argv;
const pool = new Pool({ connectionString: dbUrl, max: 1 });

try {
  const r = await pool.query(
    `SELECT
      COALESCE(SUM(CASE WHEN recipient_id IS NULL AND sender_id != $1 THEN 1 ELSE 0 END), 0)::int AS bc,
      COALESCE(SUM(CASE WHEN recipient_id = $1 THEN 1 ELSE 0 END), 0)::int AS dms,
      STRING_AGG(DISTINCT CASE WHEN recipient_id = $1 THEN sender_id END, ', ') AS senders
    FROM chat_messages
    WHERE project = $2 AND timestamp > $3 AND sender_id != $1`,
    [agentId, project, since]
  );
  const { bc, dms, senders } = r.rows[0];
  console.log(`${bc}|${dms}|${senders || ''}`);
} catch {
  console.log('0|0|');
}
await pool.end();
