/**
 * P27-T7 (Entscheidung Koordinator nach EXPLAIN 5ebd42d8): der Stau-Waechter liest fuer 'parser' den letzten Tick des
 * Parser-Workers (parser-tick-stand.ts) statt je Takt max(parsed_at) + projekteMitBacklog abzufragen.
 * Rein lokal, ohne DB. Aufruf: mise exec node@25 -- node packages/core/tests/parser-tick-stand-p27-t7.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const T = await import('../dist/services/parser-tick-stand.js');
let ok = 0;
const pruefe = (name, fn) => { try { fn(); ok++; console.log('OK  ' + name); } catch (e) { console.error('DEBUG ' + name + ' | ' + (e?.message ?? e)); throw e; } };

pruefe('S1 vor dem ersten Tick: null', () => assert.equal(T.leseParserTickStand(), null));
pruefe('S2 gelaufener Tick: faellig summiert, Dateien zaehlen als Fortschritt', () => {
  T.meldeParserTick({ projekte: [{ faellig: 3 }, { faellig: 4 }], dateien: 2 });
  const s = T.leseParserTickStand();
  assert.equal(s.status, 'gelaufen'); assert.equal(s.projekte, 2); assert.equal(s.faellig, 7);
  assert.equal(s.dateien, 2); assert.equal(s.geparst_gesamt, 2); assert.ok(s.fortschritt_ms > 0);
});
pruefe('S3 Tick ohne geparste Datei: Fortschritt bleibt alt, Zaehler unveraendert', () => {
  const vorher = T.leseParserTickStand();
  T.meldeParserTick({ projekte: [{ faellig: 7 }], dateien: 0 });
  const s = T.leseParserTickStand();
  assert.equal(s.geparst_gesamt, 2); assert.equal(s.fortschritt_ms, vorher.fortschritt_ms); assert.equal(s.faellig, 7);
});
pruefe('S4 Pause/Schalter: Rueckstand bleibt stehen, Status ruht', () => {
  T.meldeParserTick({ ruht: 'pausiert' });
  const s = T.leseParserTickStand();
  assert.equal(s.status, 'pausiert'); assert.equal(s.faellig, 7); assert.equal(s.dateien, 0); assert.equal(s.geparst_gesamt, 2);
  T.meldeParserTick({ ruht: 'schalter' });
  assert.equal(T.leseParserTickStand().status, 'schalter');
});
pruefe('S5 Kopie statt Referenz', () => {
  const s = T.leseParserTickStand(); s.faellig = 999;
  assert.equal(T.leseParserTickStand().faellig, 7);
});
pruefe('S6 Architektur: parserZustand ohne eigene PG-Abfrage, Parser-Worker meldet jeden Tick', () => {
  const adapter = readFileSync(new URL('../src/services/warteschlangen-adapter.ts', import.meta.url), 'utf8');
  // Nur Code, keine Kommentarzeilen (der Kommentar nennt die entfernten Abfragen ausdruecklich).
  const fn = adapter.slice(adapter.indexOf('async function parserZustand'), adapter.indexOf('async function wissenNachzugZustand'))
    .split('\n').filter((z) => !z.trim().startsWith('//')).join('\n');
  assert.ok(fn.includes('leseParserTickStand()'), 'liest den Tick-Stand');
  assert.ok(!/projekteMitBacklog|parsed_at|abfrage</.test(fn), 'keine eigene Abfrage');
  const worker = readFileSync(new URL('../../rest-api/src/services/parser-worker.ts', import.meta.url), 'utf8');
  assert.equal((worker.match(/meldeParserTick\(/g) ?? []).length, 4, 'Schalter, Pause, leerer und gelaufener Tick');
});
console.log(`\nparser-tick-stand-p27-t7: ${ok} Pruefungen gruen`);
