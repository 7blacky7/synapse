#!/usr/bin/env node
// test-token-stand.mjs — P7-T29: Wrapper zaehlte Output doppelt (Rotation bei ~55 % statt 97 %).
// Prueft die reine Funktion berechneTokenStand/kontextTokens mit einer JSONL-Fixture (mehrere Turns,
// wachsender Kontext, grosser kumulierter Output) und dass wrapper.ts sie benutzt.
// Ohne Prozess, ohne DB. Voraussetzung: gebaute dists (pnpm build).
// Aufruf: node scripts/test-token-stand.mjs   (Exit 1 bei Fehler)

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let ok = 0;
let fehler = 0;
async function pruefe(name, fn) {
  try {
    await fn();
    ok++;
    console.log(`OK     ${name}`);
  } catch (err) {
    fehler++;
    console.log(`FEHLER ${name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

const turn = (input, cacheRead, cacheCreate, output) =>
  JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreate, output_tokens: output } } });

// Beleg-Szenario: Kontext waechst auf 462k, kumulierter Output 345k
const FIXTURE = [
  JSON.stringify({ type: 'user', message: { content: 'hallo' } }),
  turn(10, 40_000, 20_000, 50_000),
  '   ',
  'kein json {',
  turn(12, 100_000, 30_000, 120_000),
  JSON.stringify({ type: 'system' }),
  turn(15, 200_000, 60_000, 150_000),
  turn(20, 400_000, 30_000, 25_000), // letzter Turn: Eingabe 430_020, Output 25_000
];

let mod;
await pruefe('Modul agents/dist/token-stand.js vorhanden', async () => {
  mod = await import('../packages/agents/dist/token-stand.js');
  assert.equal(typeof mod.berechneTokenStand, 'function');
  assert.equal(typeof mod.kontextTokens, 'function');
});

await pruefe('Kontext = Eingabe des LETZTEN Turns + nur dessen Output (nicht kumuliert)', () => {
  const s = mod.berechneTokenStand(FIXTURE);
  assert.equal(s.turns, 4);
  assert.equal(s.kontextInput, 20 + 400_000 + 30_000);
  assert.equal(s.letzterOutput, 25_000);
  assert.equal(mod.kontextTokens(s), 455_020);
});

await pruefe('Kumulierter Output bleibt als Statistik erhalten, zaehlt aber nicht zum Kontext', () => {
  const s = mod.berechneTokenStand(FIXTURE);
  assert.equal(s.kumulierterOutput, 50_000 + 120_000 + 150_000 + 25_000);
  assert.ok(mod.kontextTokens(s) < s.kontextInput + s.kumulierterOutput, 'alte Rechnung waere hoeher');
});

await pruefe('Alte Rechnung (doppelt) haette 1M-Fenster bei ~77 % ueberschritten — neue liegt bei ~46 %', () => {
  const s = mod.berechneTokenStand(FIXTURE);
  const alt = s.kontextInput + s.kumulierterOutput; // 430_020 + 345_000 = 775_020
  const neu = mod.kontextTokens(s);
  assert.equal(alt, 775_020);
  assert.equal(Math.round((neu / 1_000_000) * 100), 46);
  assert.equal(Math.round((alt / 1_000_000) * 100), 78);
});

await pruefe('Leere/ungueltige Eingabe: alles 0', () => {
  const s = mod.berechneTokenStand(['', 'muell', '{"a":1}']);
  assert.deepEqual(s, { kontextInput: 0, letzterOutput: 0, kumulierterOutput: 0, turns: 0 });
  assert.equal(mod.kontextTokens(s), 0);
});

await pruefe('Ein Turn: Kontext = Eingabe + eigener Output', () => {
  const s = mod.berechneTokenStand([turn(5, 1000, 500, 200)]);
  assert.equal(mod.kontextTokens(s), 1705);
});

await pruefe('wrapper.ts nutzt berechneTokenStand; totalOutputTokens ist der Output des letzten Turns', async () => {
  const src = await readFile(new URL('../packages/agents/dist/wrapper.js', import.meta.url), 'utf8');
  assert.match(src, /berechneTokenStand/);
  assert.match(src, /letzterOutput/);
  assert.ok(!/cumulativeOutput\s*\+=/.test(src), 'kumulierte Zaehlung im Wrapper noch vorhanden');
});

console.log(`\n${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
