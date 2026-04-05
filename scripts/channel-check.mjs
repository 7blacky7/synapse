#!/usr/bin/env node
// channel-check.mjs — Prüft ungelesene Channel-Nachrichten via PostgreSQL
// Aufgerufen von chat-notify.sh
// Args: <agent_name> <project> <since_id> <db_url>

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../packages/core/package.json'));
const pg = require('pg');
const { Pool } = pg;

const [,, agentName, project, sinceId, dbUrl] = process.argv;
const pool = new Pool({ connectionString: dbUrl, max: 1 });

try {
  // Alle Channels finden in denen der Agent Mitglied ist
  const r = await pool.query(
    `SELECT c.name AS channel_name, COUNT(m.id) AS unread
     FROM specialist_channels c
     JOIN specialist_channel_members mem ON mem.channel_id = c.id
     JOIN specialist_channel_messages m ON m.channel_id = c.id
     WHERE c.project = $1
       AND mem.agent_name = $2
       AND m.sender != $2
       AND m.id > $3
     GROUP BY c.name
     HAVING COUNT(m.id) > 0
     ORDER BY c.name`,
    [project, agentName, sinceId || '0']
  );
  // Format: channel1:3,channel2:1
  const parts = r.rows.map(row => `${row.channel_name}:${row.unread}`);
  console.log(parts.join(','));
} catch {
  console.log('');
}
await pool.end();
