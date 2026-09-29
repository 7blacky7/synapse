#!/usr/bin/env node
// test-rotations-marker.mjs — P7-T13: angeforderte Rotation kommt nicht mehr erst beim naechsten Heartbeat.
//   - Entscheidungstabelle (packages/agents/src/rotations-marker.ts), ohne Prozess, ohne DB
//   - wrapper.ts: gemeinsame Funktion pruefeRotationsMarker, 10-s-Timer (nur existsSync, unref, aufgeraeumt),
//     Turn-Ende-Pruefung, heartbeatPoll ruft dieselbe Funktion (Quelltext-Pruefung)
// Aufruf: node scripts/test-rotations-marker.mjs   (Exit 1 bei Fehler)
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

const m = await import('../packages/agents/dist/rotations-marker.js');
const { rotationsMarkerAktion, MARKER_PRUEF_MS } = m;
const lage = (o = {}) => ({ vorhanden: true, busy: false, rotationLaeuft: false, beendet: false, ...o });

await pruefe('Marker da, Agent frei -> rotieren', () => {
  assert.equal(rotationsMarkerAktion(lage()), 'rotieren');
});

await pruefe('kein Marker -> nichts', () => {
  assert.equal(rotationsMarkerAktion(lage({ vorhanden: false })), 'nichts');
});

await pruefe('Agent busy -> nichts (Marker bleibt, Turn-Ende prueft erneut)', () => {
  assert.equal(rotationsMarkerAktion(lage({ busy: true })), 'nichts');
});

await pruefe('Rotation laeuft schon -> nichts (kein Doppelstart)', () => {
  assert.equal(rotationsMarkerAktion(lage({ rotationLaeuft: true })), 'nichts');
});

await pruefe('Wrapper faehrt herunter -> nichts', () => {
  assert.equal(rotationsMarkerAktion(lage({ beendet: true })), 'nichts');
});

await pruefe('alle 16 Kombinationen: rotiert nur bei vorhanden && !busy && !rotationLaeuft && !beendet', () => {
  for (let i = 0; i < 16; i++) {
    const l = { vorhanden: !!(i & 1), busy: !!(i & 2), rotationLaeuft: !!(i & 4), beendet: !!(i & 8) };
    const erwartet = l.vorhanden && !l.busy && !l.rotationLaeuft && !l.beendet ? 'rotieren' : 'nichts';
    assert.equal(rotationsMarkerAktion(l), erwartet, JSON.stringify(l));
  }
});

await pruefe('Takt: 10 s', () => {
  assert.equal(MARKER_PRUEF_MS, 10_000);
});

const src = await readFile(new URL('../packages/agents/src/wrapper.ts', import.meta.url), 'utf8');

await pruefe('wrapper.ts: gemeinsame Funktion + Entscheidungsfunktion angeschlossen', () => {
  assert.match(src, /from '\.\/rotations-marker\.js'/);
  assert.match(src, /async function pruefeRotationsMarker\(/);
  assert.match(src, /rotationsMarkerAktion\(\{/);
});

await pruefe('wrapper.ts: heartbeatPoll ruft dieselbe Funktion (kein eigener Marker-Block mehr)', () => {
  assert.match(src, /await pruefeRotationsMarker\('heartbeat'\)/);
  assert.ok(!/log\('RESPAWN-MARKER erkannt → Rotation'\)\s*\n\s*try \{\s*\n\s*await unlink/.test(src), 'alter Block muss weg sein');
});

await pruefe('wrapper.ts: Timer nur existsSync, unref, beim Cleanup aufgeraeumt', () => {
  assert.match(src, /setInterval\([\s\S]{0,200}pruefeRotationsMarker\('timer'\)[\s\S]{0,200}MARKER_PRUEF_MS/);
  assert.match(src, /markerTimerId\.unref\(\)/);
  assert.match(src, /clearInterval\(markerTimerId\)/);
});

await pruefe('wrapper.ts: Turn-Ende prueft den Marker (wakeAgent finally)', () => {
  assert.match(src, /finally \{\s*\n\s*agentBusy = false\s*\n[\s\S]{0,400}pruefeRotationsMarker\('turn-ende'\)/);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
