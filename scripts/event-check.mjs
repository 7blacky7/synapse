#!/usr/bin/env node
// event-check.mjs — Prüft unbestätigte Agent-Events via PostgreSQL
// Aufgerufen von chat-notify.sh
// Args: <agent_id> <project> <db_url>

import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../packages/core/package.json'));
const pg = require('pg');
const { Pool } = pg;

const [,, agentId, project, dbUrl] = process.argv;
const pool = new Pool({ connectionString: dbUrl, max: 1 });

try {
  // P15-T26: Die SQL steht an EINER Stelle: packages/core/src/services/event-sichtbarkeit.ts (gebaut nach
  // dist/services/event-sichtbarkeit.js, ohne Abhaengigkeiten, daher schnell geladen). Dieselbe Quelle
  // nutzt intern(ereignisse); getPendingEvents teilt die Bedingung (einziger Hook-Unterschied:
  // requires_ack = true, LIMIT 5). Direkt per SQL statt ueber die API: der Hook laeuft nach jedem
  // Tool-Aufruf, muss schnell sein und auch ohne API funktionieren.
  // Tests: test-event-check-hook.mjs (Hook == getPendingEvents), test-intern-diagnose.mjs E3 (== ereignisse).
  const quelle = await import(pathToFileURL(resolve(__dirname, '../packages/core/dist/services/event-sichtbarkeit.js')).href);
  const r = await pool.query(quelle.HOOK_EVENTS_SQL, quelle.hookEventsParameter(project, agentId));
  // Ausgabe wie bisher (chat-notify.sh/coordinator-watch.sh lesen id, event_type, priority, source_id, payload)
  console.log(JSON.stringify(r.rows.map(({ id, event_type, priority, source_id, payload }) => ({ id, event_type, priority, source_id, payload }))));
} catch {
  console.log('[]');
}
await pool.end();