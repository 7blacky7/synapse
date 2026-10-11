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
  // P15-T21: Bedingung WORTGLEICH zu getPendingEvents (packages/core/src/services/events.ts),
  // damit der Hook exakt die Menge des Servers zeigt (einziger Unterschied: requires_ack = true,
  // der Hook fordert nur dort zum Quittieren auf, wo ein ACK verlangt ist). Direkt per SQL statt ueber
  // die API: der Hook laeuft nach jedem Tool-Aufruf, muss schnell sein und auch ohne API funktionieren.
  // Aenderungen an getPendingEvents hier nachziehen (test-event-check-hook.mjs vergleicht beide).
  const r = await pool.query(
    `SELECT e.id, e.event_type, e.priority, e.source_id, e.payload
     FROM agent_events e
     WHERE e.project = $1
       AND (e.scope = 'all' OR e.scope = $2)
       AND e.requires_ack = true
       AND NOT EXISTS (
         SELECT 1 FROM agent_event_acks
         WHERE agent_event_acks.event_id = e.id
           AND agent_event_acks.agent_id = $3
       )
       AND (
         e.scope = $2
         OR e.created_at > COALESCE(
           (SELECT registered_at FROM agent_sessions WHERE id = $3),
           NOW() - INTERVAL '1 hour'
         )
       )
       AND (
         e.event_type <> 'PLAN_READY'
         OR EXISTS (
           SELECT 1 FROM file_batch_waits w
           WHERE w.project = e.project
             AND e.dedupe_key = 'plan-ready:' || w.wait_token::text
             AND w.status IN ('waiting', 'linked')
             AND (w.expires_at > NOW() OR EXISTS (SELECT 1 FROM file_batch_plans p WHERE p.id = w.primary_plan_id AND p.status = 'open'))
         )
         AND NOT EXISTS (
           SELECT 1 FROM agent_events e2
             JOIN agent_event_acks a2 ON a2.event_id = e2.id AND a2.agent_id = $3
            WHERE e2.project = e.project AND e2.event_type = 'PLAN_READY' AND e2.scope = e.scope AND e2.id <> e.id
              AND (CASE WHEN e2.payload LIKE '{%' THEN e2.payload::jsonb ->> 'plan_id' END)
                = (CASE WHEN e.payload LIKE '{%' THEN e.payload::jsonb ->> 'plan_id' END)
         )
       )
     ORDER BY CASE e.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, e.created_at ASC
     LIMIT 5`,
    [project, `agent:${agentId}`, agentId]
  );
  console.log(JSON.stringify(r.rows));
} catch {
  console.log('[]');
}
await pool.end();
