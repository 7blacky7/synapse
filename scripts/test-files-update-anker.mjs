#!/usr/bin/env node
// test-files-update-anker.mjs — P7-T11 (a): files(update) auf oberster Ebene kennt anchor_text/anchor_contains.
//   - geteilte Pruefung (core update-anker.ts): Treffer, Mismatch (Drift), anchor_text getrimmt, nur Strings zaehlen
//   - Fehlertexte unveraendert (wie bisher in file-batch.ts)
//   - file-batch.ts nutzt dieselbe Funktion statt Kopie (PFLICHT-Pruefung bleibt dort)
//   - REST + stdio: Schema-Properties oben, Handler prueft VOR dem Schreiben, ohne Anker unveraendert
//   - Beschreibung ehrlich: kein 'ohne Anker = Error' mehr fuer das oberste update
// Aufruf: node scripts/test-files-update-anker.mjs   (Exit 1 bei Fehler)
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

const m = await import('../packages/core/dist/services/update-anker.js');
const { leseUpdateAnker, hatUpdateAnker, pruefeUpdateAnker } = m;
const INHALT = 'zeile eins\nconst wert = 42;\nzeile drei\n';

await pruefe('leseUpdateAnker: nur Strings zaehlen', () => {
  assert.deepEqual(leseUpdateAnker({ anchor_text: 'a', anchor_contains: 'b' }), { anchor_text: 'a', anchor_contains: 'b' });
  assert.deepEqual(leseUpdateAnker({ anchor_text: 5, anchor_contains: null }), {});
  assert.deepEqual(leseUpdateAnker({}), {});
  assert.equal(hatUpdateAnker({}), false);
  assert.equal(hatUpdateAnker({ anchor_contains: '' }), true);
});

await pruefe('Treffer: kein Fehler (beide Anker)', () => {
  pruefeUpdateAnker(INHALT, { anchor_contains: 'const wert = 42;' }, 'a.ts');
  pruefeUpdateAnker(INHALT, { anchor_text: '  const wert = 42;  ' }, 'a.ts');
  pruefeUpdateAnker(INHALT, { anchor_text: 'zeile eins', anchor_contains: 'zeile drei' }, 'a.ts');
  pruefeUpdateAnker(INHALT, {}, 'a.ts');
});

await pruefe('Mismatch anchor_contains: Fehlertext wie bisher, Anker auf 80 Zeichen gekuerzt', () => {
  assert.throws(() => pruefeUpdateAnker(INHALT, { anchor_contains: 'gibt es nicht' }, 'src/x.ts'),
    /update: anchor_contains "gibt es nicht" in "src\/x\.ts" nicht gefunden — Drift erkannt, keine Mutation\./);
  try { pruefeUpdateAnker(INHALT, { anchor_contains: 'x'.repeat(200) }, 'a.ts'); assert.fail('sollte werfen'); }
  catch (e) { assert.ok(e.message.includes('x'.repeat(80)) && !e.message.includes('x'.repeat(81))); }
});

await pruefe('Mismatch anchor_text: Fehlertext wie bisher', () => {
  assert.throws(() => pruefeUpdateAnker(INHALT, { anchor_text: 'fehlt' }, 'src/x.ts'),
    /update: anchor_text in "src\/x\.ts" nicht gefunden — Datei wurde eventuell extern geaendert\. Aktualisiere deinen Lese-Snapshot/);
});

await pruefe('ein Anker passt, der andere nicht -> Fehler', () => {
  assert.throws(() => pruefeUpdateAnker(INHALT, { anchor_text: 'zeile eins', anchor_contains: 'nein' }, 'a.ts'), /anchor_contains/);
});

const batch = await readFile(new URL('../packages/core/src/services/file-batch.ts', import.meta.url), 'utf8');
await pruefe('file-batch.ts: geteilte Funktion statt Kopie, PFLICHT-Pruefung bleibt', () => {
  assert.match(batch, /from '\.\/update-anker\.js'/);
  assert.match(batch, /pruefeUpdateAnker\(cur, op, op\.file_path\)/);
  assert.match(batch, /update: anchor_text ODER anchor_contains ist PFLICHT/);
  assert.ok(!/update: anchor_text in "\$\{op\.file_path\}" nicht gefunden/.test(batch), 'Kopie des Fehlertexts muss weg sein');
});

const rest = await readFile(new URL('../packages/rest-api/src/routes/mcp.ts', import.meta.url), 'utf8');
const stdio = await readFile(new URL('../packages/mcp-server/src/tools/consolidated/files.ts', import.meta.url), 'utf8');

await pruefe('REST: Top-Level-Properties anchor_text/anchor_contains im files-Schema', () => {
  const start = rest.indexOf("name: 'files',");
  assert.ok(start >= 0);
  const block = rest.slice(start, start + 40000);
  assert.match(block, /\n {8}anchor_text: \{ type: 'string'/);
  assert.match(block, /\n {8}anchor_contains: \{ type: 'string'/);
});

await pruefe('stdio: Top-Level-Properties im files-Schema', () => {
  assert.match(stdio, /\n {8}anchor_text: \{\s*\n\s*type: 'string'/);
  assert.match(stdio, /\n {8}anchor_contains: \{\s*\n\s*type: 'string'/);
});

await pruefe('REST + stdio: update prueft den Anker VOR dem Schreiben (updateFileInPg)', () => {
  for (const [name, src] of [['REST', rest], ['stdio', stdio]]) {
    const i = src.indexOf('pruefeUpdateAnker(');
    assert.ok(i >= 0, `${name}: pruefeUpdateAnker fehlt`);
    const j = src.indexOf('updateFileInPg(project, filePath, content', i);
    assert.ok(j > i, `${name}: Anker-Pruefung steht nicht vor dem Schreiben`);
    assert.match(src, /leseUpdateAnker\(args\)/);
    assert.match(src, /anchor_mismatch/);
  }
});

await pruefe('Beschreibung ehrlich: nirgends mehr "ohne Anker = Error" fuer das oberste update', () => {
  assert.ok(!rest.includes('ohne Anker = Error'), 'REST-Text');
  assert.ok(!stdio.includes('ohne Anker = Error'), 'stdio-Text');
  assert.match(rest, /Anker (ist )?optional/i);
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
