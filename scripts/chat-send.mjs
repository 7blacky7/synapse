#!/usr/bin/env node
// chat-send.mjs — Sendet eine Nachricht in den Synapse-Chat
// Args: <project> <sender> <content> <recipient> <db_url>

import pg from '/home/blacky/dev/synapse/node_modules/.pnpm/pg@8.20.0/node_modules/pg/lib/index.js';
const { Pool } = pg;

const [,, project, sender, content, recipient, dbUrl] = process.argv;
const pool = new Pool({ connectionString: dbUrl, max: 1 });

try {
  const r = await pool.query(
    `INSERT INTO chat_messages (project, sender_id, recipient_id, content, timestamp)
     VALUES ($1, $2, $3, $4, NOW())
     RETURNING id, timestamp`,
    [project, sender, recipient || null, content]
  );
  console.log(`Nachricht #${r.rows[0].id} gesendet (${sender} → ${recipient || 'alle'})`);
} catch (e) {
  console.error('Fehler:', e.message);
}
await pool.end();
