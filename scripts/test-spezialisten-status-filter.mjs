#!/usr/bin/env node
// test-spezialisten-status-filter.mjs — P7-T10: specialist(status) filtert nach Namen und blendet Leichen aus.
// Reine Funktionen (packages/core/src/services/spezialisten-status-filter.ts), ohne DB.
// ANNAHME (Koordinator, T18): wrapper.ts schreibt last_activity ueber einen unabhaengigen 90-s-Timer,
// auch in der Leerlauf-Pause -> ein lebender Wrapper veraltet nie; last_activity aelter als
// Schwelle (Standard 24 h) heisst: Leiche.
// Aufruf: node scripts/test-spezialisten-status-filter.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';

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

const mod = await import('../packages/core/dist/services/spezialisten-status-filter.js');
const { waehleSpezialisten, parseNamen, veraltetSchwelleMs, beschrifteZeile } = mod;

const JETZT = Date.parse('2026-09-30T12:00:00Z');
const H = 3600_000;
const zeile = (agentName, status, alterMs) => ({ agentName, status, lastActivity: new Date(JETZT - alterMs) });
const rows = [
  zeile('plan-specht', 'running', 60_000),
  zeile('idle-frisch', 'idle', 2 * H),
  zeile('abgestuerzt-frisch', 'crashed', 5 * 60_000),
  zeile('parity-1', 'idle', 120 * 24 * H),
  zeile('agy-x', 'running', 100 * 24 * H),
  zeile('t5-a', 'stopped', 30 * H),
];

await pruefe('parseNamen: Array, JSON-String, Komma-String, leer verworfen', () => {
  assert.deepEqual(parseNamen(['a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(parseNamen('["a","b"]'), ['a', 'b']);
  assert.deepEqual(parseNamen('a, b,,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseNamen('a'), ['a']);
  assert.deepEqual(parseNamen(undefined), []);
  assert.deepEqual(parseNamen(''), []);
  assert.deepEqual(parseNamen(42), []);
});

await pruefe('Schwelle: Standard 24 h, Env in Stunden, Muell -> Standard', () => {
  assert.equal(veraltetSchwelleMs({}), 24 * H);
  assert.equal(veraltetSchwelleMs({ SYNAPSE_STATUS_VERALTET_H: '48' }), 48 * H);
  assert.equal(veraltetSchwelleMs({ SYNAPSE_STATUS_VERALTET_H: 'x' }), 24 * H);
  assert.equal(veraltetSchwelleMs({ SYNAPSE_STATUS_VERALTET_H: '0' }), 24 * H);
});

await pruefe('ohne Namen: Leichen ausgeblendet, Namen genannt', () => {
  const r = waehleSpezialisten(rows, { jetzt: JETZT });
  assert.deepEqual(r.sichtbar.map(s => s.row.agentName), ['plan-specht', 'idle-frisch', 'abgestuerzt-frisch']);
  assert.equal(r.ausgeblendetAnzahl, 3);
  assert.deepEqual(r.ausgeblendet.sort(), ['agy-x', 'parity-1', 't5-a']);
});

await pruefe('frisch abgestuerzt bleibt sichtbar, nicht verwaist', () => {
  const r = waehleSpezialisten(rows, { jetzt: JETZT });
  const a = r.sichtbar.find(s => s.row.agentName === 'abgestuerzt-frisch');
  assert.equal(a.row.status, 'crashed');
  assert.equal(a.verwaist, false);
  assert.equal(a.inaktivSeit, null);
});

await pruefe('alle:true zeigt alles, Leichen gekennzeichnet', () => {
  const r = waehleSpezialisten(rows, { jetzt: JETZT, alle: true });
  assert.equal(r.sichtbar.length, 6);
  assert.equal(r.ausgeblendetAnzahl, 0);
  const p = r.sichtbar.find(s => s.row.agentName === 'parity-1');
  assert.equal(p.verwaist, true);
  assert.equal(p.inaktivSeit, '120 Tage');
  assert.equal(r.sichtbar.find(s => s.row.agentName === 't5-a').inaktivSeit, '30 Stunden');
});

await pruefe('genannte Namen: immer zeigen, auch veraltet (mit verwaist)', () => {
  const r = waehleSpezialisten(rows, { jetzt: JETZT, namen: ['parity-1', 'plan-specht'] });
  assert.deepEqual(r.sichtbar.map(s => s.row.agentName).sort(), ['parity-1', 'plan-specht']);
  assert.equal(r.sichtbar.find(s => s.row.agentName === 'parity-1').verwaist, true);
  assert.equal(r.ausgeblendetAnzahl, 0);
  assert.deepEqual(r.nichtGefunden, []);
});

await pruefe('Einzelname als String + Komma-String', () => {
  assert.equal(waehleSpezialisten(rows, { jetzt: JETZT, namen: 'agy-x' }).sichtbar.length, 1);
  assert.equal(waehleSpezialisten(rows, { jetzt: JETZT, namen: 'agy-x, t5-a' }).sichtbar.length, 2);
});

await pruefe('unbekannter Name -> nichtGefunden, Rest kommt', () => {
  const r = waehleSpezialisten(rows, { jetzt: JETZT, namen: ['plan-specht', 'gibtsnicht'] });
  assert.equal(r.sichtbar.length, 1);
  assert.deepEqual(r.nichtGefunden, ['gibtsnicht']);
});

await pruefe('Schwelle per Option: 200 Tage blendet nichts aus', () => {
  const r = waehleSpezialisten(rows, { jetzt: JETZT, veraltetMs: 200 * 24 * H });
  assert.equal(r.sichtbar.length, 6);
});

await pruefe('beschrifteZeile: Grenzen und Einheiten', () => {
  assert.deepEqual(beschrifteZeile(zeile('a', 'idle', 24 * H - 1), JETZT, 24 * H), { verwaist: false, inaktivSeit: null });
  const b = beschrifteZeile(zeile('a', 'idle', 25 * H), JETZT, 24 * H);
  assert.equal(b.verwaist, true);
  assert.equal(b.inaktivSeit, '25 Stunden');
  assert.equal(beschrifteZeile(zeile('a', 'idle', 24 * H), JETZT, 24 * H).inaktivSeit, '24 Stunden');
  assert.equal(beschrifteZeile(zeile('a', 'idle', 49 * H), JETZT, 24 * H).inaktivSeit, '2 Tage');
});

await pruefe('leere Liste', () => {
  const r = waehleSpezialisten([], { jetzt: JETZT });
  assert.deepEqual(r.sichtbar, []);
  assert.equal(r.ausgeblendetAnzahl, 0);
});

console.log(`${ok} OK, ${fehler} Fehler`);
process.exit(fehler > 0 ? 1 : 0);
