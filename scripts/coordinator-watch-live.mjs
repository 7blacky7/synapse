#!/usr/bin/env node
/**
 * coordinator-watch-live.mjs — Event-Driven Watcher mit PostgreSQL LISTEN/NOTIFY
 *
 * Reagiert SOFORT auf neue Chat-Nachrichten, Events und Channel-Posts.
 * Kein Polling mehr — nur ein 120s Fallback-Timeout falls gar nichts kommt.
 *
 * Usage:
 *   node coordinator-watch-live.mjs <project> <agent_id> [timeout_s] [--channel=name]
 *
 * Beispiele:
 *   node coordinator-watch-live.mjs synapse koordinator
 *   node coordinator-watch-live.mjs synapse koordinator 180
 *   node coordinator-watch-live.mjs synapse koordinator 120 --channel=synapse-general
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../packages/core/package.json'));
const pg = require('pg');
const { Client } = pg;

// Args parsen
const args = process.argv.slice(2);
const PROJECT = args[0] || 'synapse';
const AGENT_ID = args[1] || 'koordinator';
const TIMEOUT_S = parseInt(args.find(a => /^\d+$/.test(a) && a !== PROJECT && a !== AGENT_ID) || '120', 10);
const CHANNEL_FILTER = args.find(a => a.startsWith('--channel='))?.split('=')[1] || null;

const DB_URL = process.env.SYNAPSE_DB_URL;
if (!DB_URL) {
  console.error('[watch-live] SYNAPSE_DB_URL nicht gesetzt');
  process.exit(1);
}

// PID-Management
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
const PID_FILE = `/tmp/synapse-watch-${PROJECT}.pid`;

if (existsSync(PID_FILE)) {
  const oldPid = readFileSync(PID_FILE, 'utf8').trim();
  try {
    process.kill(parseInt(oldPid, 10), 0); // Check ob Prozess lebt
    console.error(`[watch-live] Watcher fuer ${PROJECT} laeuft bereits (PID: ${oldPid})`);
    process.exit(0);
  } catch {
    // Prozess tot — PID-File aufraeumen
  }
}

writeFileSync(PID_FILE, `${process.pid}`);
const cleanup = () => { try { unlinkSync(PID_FILE); } catch {} };
process.on('exit', cleanup);
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('SIGINT', () => { cleanup(); process.exit(0); });

// PostgreSQL Client fuer LISTEN
const client = new Client({ connectionString: DB_URL });

const collected = [];

function handleNotification(msg) {
  let payload;
  try {
    payload = JSON.parse(msg.payload);
  } catch {
    return; // Ungültiges Payload ignorieren
  }

  // Projekt-Filter
  if (payload.project && payload.project !== PROJECT) return;

  // Eigene Nachrichten ignorieren
  if (payload.sender_id === AGENT_ID || payload.sender === AGENT_ID || payload.source_id === AGENT_ID) return;

  // Channel-Filter (wenn gesetzt)
  if (CHANNEL_FILTER && msg.channel === 'synapse_channel' && payload.channel !== CHANNEL_FILTER) return;

  // Relevante Notification!
  const entry = { channel: msg.channel, ...payload };
  collected.push(entry);

  // Kurz warten ob noch mehr kommt (50ms Debounce)
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(outputAndExit, 50);
}

let debounceTimer = null;

function outputAndExit() {
  const events = collected.filter(c => c.channel === 'synapse_event');
  const dms = collected.filter(c => c.channel === 'synapse_chat' && c.recipient_id === AGENT_ID);
  const broadcasts = collected.filter(c => c.channel === 'synapse_chat' && !c.recipient_id);
  const channels = collected.filter(c => c.channel === 'synapse_channel');

  const parts = [];

  if (events.length > 0) {
    const details = events.map(e => `${e.event_type}(${e.priority}) von ${e.source_id}`).join(', ');
    parts.push(`⛔ ${events.length} Event(s): ${details}`);
  }
  if (dms.length > 0) {
    const senders = [...new Set(dms.map(d => d.sender_id))].join(', ');
    parts.push(`💬 ${dms.length} DM(s) von ${senders}`);
  }
  if (broadcasts.length > 0) {
    const senders = [...new Set(broadcasts.map(b => b.sender_id))].join(', ');
    parts.push(`📢 ${broadcasts.length} Broadcast(s) von ${senders}`);
  }
  if (channels.length > 0) {
    const chNames = [...new Set(channels.map(c => c.channel))].join(', ');
    parts.push(`📣 ${channels.length} Channel-Post(s) in ${chNames}`);
  }

  console.log(`🔔 KOORDINATOR AUFWACHEN! [${PROJECT}]`);
  parts.forEach(p => console.log(p));
  console.log('');
  console.log(`→ chat(action: 'get') + event(action: 'pending') aufrufen!`);

  client.end().catch(() => {});
  process.exit(0);
}

function timeoutExit() {
  console.log(`⏰ Timeout nach ${TIMEOUT_S}s — keine Aktivitaet.`);
  client.end().catch(() => {});
  process.exit(0);
}

// Starten
try {
  await client.connect();

  // LISTEN auf alle 3 Kanaele
  await client.query('LISTEN synapse_chat');
  await client.query('LISTEN synapse_event');
  await client.query('LISTEN synapse_channel');

  client.on('notification', handleNotification);

  const filterInfo = CHANNEL_FILTER ? ` (Channel-Filter: ${CHANNEL_FILTER})` : '';
  console.error(`[watch-live] LISTEN aktiv fuer ${AGENT_ID}@${PROJECT}${filterInfo} (Timeout: ${TIMEOUT_S}s, PID: ${process.pid})`);

  // Fallback-Timeout
  setTimeout(timeoutExit, TIMEOUT_S * 1000);

} catch (err) {
  console.error(`[watch-live] DB-Verbindungsfehler: ${err.message}`);
  cleanup();
  process.exit(1);
}
