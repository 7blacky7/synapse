#!/usr/bin/env node
// event-check.mjs — Prüft unbestätigte Agent-Events via PostgreSQL
// Aufgerufen von chat-notify.sh
// Args: <agent_id> <project> <db_url>

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../packages/core/package.json'));
const pg = require('pg');
const { Pool } = pg;

const [,, agentId, project, dbUrl] = process.argv;
const pool = new Pool({ connectionString: dbUrl, max: 1 });

try {
  const r = await pool.query(
    `SELECT id, event_type, priority, source_id, payload
     FROM agent_events
     WHERE project = $1
       AND (scope = 'all' OR scope = 'agent:' || $2)
       AND requires_ack = true
       AND NOT EXISTS (
         SELECT 1 FROM agent_event_acks
         WHERE event_id = agent_events.id AND agent_id = $2
       )
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at ASC
     LIMIT 5`,
    [project, agentId]
  );
  console.log(JSON.stringify(r.rows));
} catch {
  console.log('[]');
}
await pool.end();
