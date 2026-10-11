/**
 * P15-T21 (11.10.2026): scripts/event-check.mjs (PostToolUse-Hook) liefert dieselbe Menge wie getPendingEvents.
 *
 * Eigene Testevents im eigenen Test-Projekt 'zz-hook-t21' der TEST-DB, am Ende entfernt.
 * POSITIVKONTROLLE: Die alte Hook-SQL (OLD_SQL, Stand vor P15-T21) zeigt einem frisch registrierten Agenten
 *   das Alt-Event (30 Tage vor der Registrierung) - der Testaufbau loest den Fehler also wirklich aus.
 * Neuer Hook:  Alt-Event NICHT, Event nach der Registrierung JA, an den Agenten adressiertes Alt-Event JA,
 *   Event ohne requires_ack nicht (bewusster Hook-Unterschied), quittiertes nicht, totes PLAN_READY nicht.
 * Gleichheit: Menge des echten Hook-Skripts == getPendingEvents(...) (nur requires_ack=true) - exakt.
 *
 * AUFRUF: set -a; . <test-db.env>; set +a; node scripts/test-event-check-hook.mjs
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DB_URL = process.env.DATABASE_URL ?? '';
if (!/:5433\/synapse_test(\?|$)/.test(DB_URL)) {
  console.error('ABBRUCH: dieser Test laeuft nur gegen die Test-DB (...:5433/synapse_test).');
  process.exit(2);
}
const hier = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(hier, '..', 'packages', 'core', 'package.json'));
const { Pool } = require('pg');
const pool = new Pool({ connectionString: DB_URL, max: 2 });
const events = await import(pathToFileURL(join(hier, '..', 'packages', 'core', 'dist', 'services', 'events.js')).href);

const P = 'zz-hook-t21';
const A = 'zz-hook-agent';
const OLD_SQL = `SELECT id FROM agent_events
  WHERE project = $1 AND (scope = 'all' OR scope = 'agent:' || $2) AND requires_ack = true
    AND NOT EXISTS (SELECT 1 FROM agent_event_acks WHERE event_id = agent_events.id AND agent_id = $2)`;

let fehler = 0;
function pruefe(b, text, detail) {
  if (b) console.log('OK      ' + text);
  else { fehler++; console.log('FEHLER  ' + text + (detail ? '  -> ' + detail : '')); }
}
const ids = (rows) => rows.map((r) => Number(r.id)).sort((a, b) => a - b);
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function ev(typ, scope, alter, extra = {}) {
  const r = await pool.query(
    `INSERT INTO agent_events (project, event_type, priority, scope, source_id, payload, requires_ack, dedupe_key, created_at)
     VALUES ($1,$2,'normal',$3,'test-p15-t21',$4,$5,$6, NOW() - $7::interval) RETURNING id`,
    [P, typ, scope, 'TESTEVENT P15-T21 ' + (extra.name ?? ''), extra.ack ?? true, extra.dedupe ?? null, alter]);
  return Number(r.rows[0].id);
}
async function aufraeumen() {
  await pool.query('DELETE FROM agent_events WHERE project = $1', [P]); // acks per CASCADE
  await pool.query('DELETE FROM agent_sessions WHERE id = $1', [A]);
}
function hook() {
  const out = execFileSync('node', [join(hier, 'event-check.mjs'), A, P, DB_URL], { encoding: 'utf8' });
  return JSON.parse(out);
}

try {
  await aufraeumen();
  // Agent ist frisch registriert (vor 1 Minute)
  await pool.query(`INSERT INTO agent_sessions (id, project, registered_at) VALUES ($1,$2, NOW() - interval '1 minute')`, [A, P]);
  const alt = await ev('ANNOUNCEMENT', 'all', '30 days', { name: 'alt' });
  const altDirekt = await ev('ANNOUNCEMENT', 'agent:' + A, '30 days', { name: 'alt-adressiert' });
  const neu = await ev('ANNOUNCEMENT', 'all', '10 seconds', { name: 'neu' });
  const neuOhneAck = await ev('ANNOUNCEMENT', 'all', '10 seconds', { name: 'neu-ohne-ack', ack: false });
  const neuQuittiert = await ev('ANNOUNCEMENT', 'all', '10 seconds', { name: 'neu-quittiert' });
  await pool.query('INSERT INTO agent_event_acks (event_id, agent_id) VALUES ($1,$2)', [neuQuittiert, A]);
  const totPlanReady = await ev('PLAN_READY', 'all', '10 seconds', { name: 'plan-ready-ohne-wait', dedupe: 'plan-ready:00000000-0000-0000-0000-000000000000' });

  // Positivkontrolle: die alte Hook-SQL zeigt das Alt-Event
  const alte = ids((await pool.query(OLD_SQL, [P, A])).rows);
  pruefe(alte.includes(alt), 'P0 Positivkontrolle: alte Hook-SQL zeigt dem frisch registrierten Agenten das Alt-Event ' + alt, JSON.stringify(alte));
  pruefe(alte.includes(totPlanReady), 'P0b Positivkontrolle: alte SQL zeigt auch das tote PLAN_READY', JSON.stringify(alte));

  // Neuer Hook
  const h = ids(hook());
  pruefe(!h.includes(alt), 'H1 neuer Hook zeigt das Alt-Event (vor der Registrierung) NICHT', JSON.stringify(h));
  pruefe(h.includes(neu), 'H2 Gegenprobe: Event nach der Registrierung wird gezeigt', JSON.stringify(h));
  pruefe(h.includes(altDirekt), 'H3 Gegenprobe: an den Agenten adressiertes Alt-Event wird gezeigt', JSON.stringify(h));
  pruefe(!h.includes(neuOhneAck), 'H4 Event ohne requires_ack wird nicht gezeigt (bewusster Hook-Unterschied)');
  pruefe(!h.includes(neuQuittiert), 'H5 quittiertes Event wird nicht gezeigt');
  pruefe(!h.includes(totPlanReady), 'H6 PLAN_READY ohne offenen Wait wird nicht gezeigt');

  // Gleichheit mit dem Server
  const server = ids((await events.getPendingEvents(P, A, 100)).filter((e) => e.requiresAck));
  pruefe(gleich(h, server), 'G1 Hook-Menge == getPendingEvents (requires_ack)', `hook=${JSON.stringify(h)} server=${JSON.stringify(server)}`);
  pruefe(!server.includes(alt) && server.includes(neu) && server.includes(altDirekt), 'G2 Server-Kontrolle: gleiche Erwartung wie am Hook');

  // Agent ohne Sitzung: Server nimmt NOW()-1h, der Hook muss gleich entscheiden
  await pool.query('DELETE FROM agent_sessions WHERE id = $1', [A]);
  const h2 = ids(hook());
  const s2 = ids((await events.getPendingEvents(P, A, 100)).filter((e) => e.requiresAck));
  pruefe(gleich(h2, s2), 'G3 ohne Sitzung: Hook == Server', `hook=${JSON.stringify(h2)} server=${JSON.stringify(s2)}`);
} finally {
  await aufraeumen();
  const rest = (await pool.query('SELECT count(*)::int AS n FROM agent_events WHERE project = $1', [P])).rows[0].n;
  pruefe(rest === 0, 'Z Testevents entfernt', String(rest));
  await pool.end();
}
console.log(fehler === 0 ? '\nALLE ZUSAGEN ERFUELLT' : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
