#!/usr/bin/env node
// test-spawn-heartbeat.mjs — P7-T25: ein Neu-Spawn setzt heartbeat_enabled wieder auf true
// und heartbeat_interval_ms auf NULL (adaptive Ladder). Vorher erbte er die Einstellung
// der alten wrapper_status-Zeile (plan-specht war so nach einem Neustart unerreichbar).
// Ohne echte DB (pg.Pool.prototype.query ersetzt). Voraussetzung: gebaute dists.
// Aufruf: node scripts/test-spawn-heartbeat.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine_db';
const requireFromCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
const pg = requireFromCore('pg');

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const updates = [];
pg.Pool.prototype.query = async function (sql, values = []) {
  const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
  if (/^UPDATE wrapper_status SET/i.test(text)) {
    updates.push({ sql: text, values });
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`Unerwartete SQL im Test: ${text.slice(0, 80)}`);
};
pg.Pool.prototype.connect = async function () {
  throw new Error('Test darf keine echte DB-Verbindung oeffnen');
};

const ws = await import('../packages/core/dist/services/wrapper-status.js');
const core = await import('../packages/core/dist/index.js');

await pruefe('Export: setzeHeartbeatBeimSpawn ueber @synapse/core', () => {
  assert.equal(typeof ws.setzeHeartbeatBeimSpawn, 'function');
  assert.equal(typeof core.setzeHeartbeatBeimSpawn, 'function');
});

await pruefe('setzt heartbeat_enabled=true UND heartbeat_interval_ms=NULL fuer genau diesen Spezialisten', async () => {
  updates.length = 0;
  await ws.setzeHeartbeatBeimSpawn('p', 'agent-a');
  assert.equal(updates.length, 1);
  const { sql, values } = updates[0];
  assert.match(sql, /heartbeat_enabled = \$2::BOOLEAN/);
  assert.match(sql, /heartbeat_interval_ms = \$3::INTEGER/);
  assert.match(sql, /agent_name = ANY\(\$4::TEXT\[\]\)/);
  assert.deepEqual(values, ['p', true, null, ['agent-a']]);
});

await pruefe('spawnSpecialistTool ruft setzeHeartbeatBeimSpawn im PG-Status-Init, nach dem Upsert, non-fatal', async () => {
  const src = await readFile(new URL('../packages/mcp-server/dist/tools/specialists.js', import.meta.url), 'utf8');
  const iUpsert = src.indexOf('upsertWrapperStatus({');
  const iReset = src.indexOf('setzeHeartbeatBeimSpawn(');
  assert.ok(iReset > 0, 'kein Aufruf im spawn-Tool');
  assert.ok(iUpsert > 0 && iReset > iUpsert, 'Reset muss NACH dem Upsert der Zeile kommen');
  const bereich = src.slice(iUpsert - 200, iReset + 200);
  assert.match(bereich, /try\s*\{/, 'Aufruf steht nicht im try-Block');
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
