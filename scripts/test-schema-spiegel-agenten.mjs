#!/usr/bin/env node
// test-schema-spiegel-agenten.mjs — P7-T11 (c): der SQL-Spiegel schema-sql/40_agenten.sql darf hinter
// schema.ts nicht zurueckfallen. Fuer jede Tabelle des Spiegels muss jede in schema.ts per
// "ALTER TABLE <t> ADD COLUMN IF NOT EXISTS <spalte>" ergaenzte Spalte auch im CREATE TABLE stehen.
// Reiner Textvergleich, ohne DB.
// Aufruf: node scripts/test-schema-spiegel-agenten.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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

const schemaTs = await readFile(new URL('../packages/core/src/db/schema.ts', import.meta.url), 'utf8');
const spiegel = await readFile(new URL('../packages/core/src/db/schema-sql/40_agenten.sql', import.meta.url), 'utf8');

/** Tabellen des Spiegels: name -> Text des CREATE-TABLE-Blocks */
const tabellen = new Map();
for (const m of spiegel.matchAll(/CREATE TABLE public\.([a-z_0-9]+) \(([\s\S]*?)\n\);/g)) {
  tabellen.set(m[1], m[2]);
}

/** Spalten, die schema.ts nachtraeglich per ADD COLUMN ergaenzt: tabelle -> Set(spalte) */
const ergaenzt = new Map();
for (const m of schemaTs.matchAll(/ALTER TABLE\s+([a-z_0-9]+)\s+ADD COLUMN IF NOT EXISTS\s+([a-z_0-9]+)/g)) {
  if (!ergaenzt.has(m[1])) ergaenzt.set(m[1], new Set());
  ergaenzt.get(m[1]).add(m[2]);
}

await pruefe('Spiegel enthaelt Tabellen (Parser-Sanity)', () => {
  assert.ok(tabellen.size >= 5, `nur ${tabellen.size} Tabellen erkannt`);
  assert.ok(tabellen.has('wrapper_status'));
});

await pruefe('wrapper_status: heartbeat_enabled + heartbeat_interval_ms + effort im Spiegel', () => {
  const t = tabellen.get('wrapper_status');
  assert.match(t, /heartbeat_enabled boolean DEFAULT true NOT NULL/);
  assert.match(t, /heartbeat_interval_ms integer/);
  assert.match(t, /effort text/);
});

for (const [tabelle, block] of tabellen) {
  const spalten = ergaenzt.get(tabelle);
  if (!spalten) continue;
  await pruefe(`Tabelle ${tabelle}: alle per ADD COLUMN ergaenzten Spalten stehen im Spiegel`, () => {
    const fehlen = [...spalten].filter(s => !new RegExp(`(^|\\n)\\s+${s}\\s`).test(block));
    assert.deepEqual(fehlen, [], `fehlen im Spiegel: ${fehlen.join(', ')}`);
  });
}

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
