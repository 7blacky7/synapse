#!/usr/bin/env node
// channel-check.mjs — Prüft neue Channel-Nachrichten via PostgreSQL
// Aufgerufen von coordinator-watch.sh
// Args: <agent_id> <project> <since_timestamp> <db_url>
// Output: <count>|<channel_names>

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
      COUNT(*)::int AS msg_count,
      STRING_AGG(DISTINCT c.name, ', ') AS channels
    FROM specialist_channel_messages cm
    JOIN specialist_channels c ON c.id = cm.channel_id
    WHERE c.project = $1 AND cm.created_at > $2 AND cm.sender != $3`,
    [project, since, agentId]
  );
  const { msg_count, channels } = r.rows[0];
  console.log(`${msg_count}|${channels || ''}`);
} catch {
  console.log('0|');
}
await pool.end();
