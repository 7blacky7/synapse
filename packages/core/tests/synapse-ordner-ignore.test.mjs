/**
 * P15-T40: .synapse/ darf auf keinem Aufnahmeweg in code_files landen.
 *
 *  S1 Standard-Sperre (DEFAULT_IGNORES): .synapse/... gesperrt, auf jeder Ebene;
 *     .synapseignore, .synapse-notiz.md und src/a.ts bleiben erlaubt (Positivkontrolle).
 *  S2 istGesperrt (Weg Platte <-> DB) ohne DB-Regeln: .synapse gesperrt, src nicht.
 *  S3 erklaereIgnore nennt Regel '.synapse' mit Herkunft 'standard'.
 *  S4 echter Watcher: Datei in .synapse/agents/ erzeugt KEIN Ereignis, Datei in src/ schon.
 *  S5 Workspace-Orchestrator (rest-api dist, falls gebaut): istWorkspaceIgnoriert nutzt dieselbe
 *     Quelle, auch bei eigenen ignorePatterns.
 *
 * Keine Datenbank: DATABASE_URL zeigt auf 127.0.0.1:9, Regeln aus der DB fehlen also (Notnagel).
 * AUFRUF: pnpm --filter @synapse/core build && node --test packages/core/tests/synapse-ordner-ignore.test.mjs
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DATABASE_URL = 'postgresql://niemand:nichts@127.0.0.1:9/keine';
process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
process.env.DEBOUNCE_MS = '200';

const hier = dirname(fileURLToPath(import.meta.url));
const lade = (...teile) => import(pathToFileURL(join(...teile)).href);
const ign = await lade(hier, '..', 'dist', 'watcher', 'ignore.js');
const watcherMod = await lade(hier, '..', 'dist', 'watcher', 'index.js');

const GESPERRT = [
  '.synapse',
  '.synapse/status.json',
  '.synapse/agents/status.json',
  '.synapse/agents/feiertag-bau/meta.yaml',
  '.synapse/agents/x/mcp-http.json',
  '.synapse/heartbeat-poke',
  '.synapse/screenshots/a.png',
  'sub/.synapse/status.json',
];
const ERLAUBT = ['.synapseignore', '.synapse-notiz.md', 'src/a.ts', 'docs/synapse/readme.md', 'synapse/x.ts'];

test('S1 Standard-Sperre trifft .synapse auf jeder Ebene, sonst nichts', () => {
  const ig = ign.createDefaultIgnore();
  for (const p of GESPERRT) assert.equal(ign.shouldIgnore(ig, p), true, `gesperrt erwartet: ${p}`);
  for (const p of ERLAUBT) assert.equal(ign.shouldIgnore(ig, p), false, `erlaubt erwartet: ${p}`);
  assert.ok(ign.getDefaultIgnores().includes('.synapse'));
});

test('S2 istGesperrt (Weg Platte <-> DB) ohne DB-Regeln', () => {
  for (const p of GESPERRT) assert.equal(ign.istGesperrt(p, '/tmp/egal', 'p15-t40-test'), true, p);
  for (const p of ERLAUBT) assert.equal(ign.istGesperrt(p, '/tmp/egal', 'p15-t40-test'), false, p);
});

test('S3 erklaereIgnore nennt die Standard-Regel', () => {
  const leer = fs.mkdtempSync(join(os.tmpdir(), 't40-erkl-'));
  const e = ign.erklaereIgnore(leer, '.synapse/agents/status.json', 'p15-t40-test');
  assert.equal(e.ignoriert, true);
  assert.equal(e.regel, '.synapse');
  assert.equal(e.herkunft, 'standard');
  assert.equal(ign.erklaereIgnore(leer, 'src/a.ts', 'p15-t40-test').ignoriert, false);
  fs.rmSync(leer, { recursive: true, force: true });
});

const tmp = fs.mkdtempSync(join(os.tmpdir(), 't40-watch-'));
let watcher = null;
after(async () => {
  try { await watcher?.stop(); } catch { /* egal */ }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('S4 echter Watcher: .synapse/ still, src/ meldet sich', async () => {
  const ereignisse = [];
  let bereit;
  const fertig = new Promise((r) => (bereit = r));
  watcher = watcherMod.startFileWatcher({
    projectPath: tmp,
    projectName: 'p15-t40-test',
    onFileChange: async (ev) => { ereignisse.push(ev.path ?? ev.relativePath ?? String(ev.filePath ?? '')); },
    onError: () => {},
    onReady: () => bereit(),
  });
  await fertig;
  fs.mkdirSync(join(tmp, '.synapse', 'agents'), { recursive: true });
  fs.writeFileSync(join(tmp, '.synapse', 'agents', 'status.json'), '{"specialists":{}}');
  fs.writeFileSync(join(tmp, '.synapse', 'status.json'), '{"id":"x"}');
  fs.mkdirSync(join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(join(tmp, 'src', 'a.ts'), 'export const a = 1;\n');
  const ende = Date.now() + 15000;
  while (Date.now() < ende && !ereignisse.some((p) => p.includes('src'))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  // Noch etwas warten, damit spaete .synapse-Ereignisse sichtbar wuerden.
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(ereignisse.some((p) => p.includes('src')), `Positivkontrolle: src/a.ts muss melden (${JSON.stringify(ereignisse)})`);
  assert.equal(ereignisse.filter((p) => p.includes('.synapse')).length, 0, `keine .synapse-Ereignisse: ${JSON.stringify(ereignisse)}`);
});

test('S5 Workspace-Orchestrator nutzt dieselbe Quelle', async (t) => {
  const pfad = join(hier, '..', '..', 'rest-api', 'dist', 'services', 'workspace-orchestrator.js');
  if (!fs.existsSync(pfad)) { t.skip('rest-api nicht gebaut'); return; }
  const wo = await import(pathToFileURL(pfad).href);
  assert.equal(wo.istWorkspaceIgnoriert('.synapse/agents/status.json'), true);
  assert.equal(wo.istWorkspaceIgnoriert('.synapse/status.json', []), true, 'auch mit eigenen ignorePatterns');
  assert.equal(wo.istWorkspaceIgnoriert('node_modules/x/index.js', []), true);
  assert.equal(wo.istWorkspaceIgnoriert('.env', []), true);
  assert.equal(wo.istWorkspaceIgnoriert('a.tsbuildinfo'), true, 'Zusatzmuster bleiben');
  assert.equal(wo.istWorkspaceIgnoriert('src/a.ts'), false, 'Positivkontrolle');
  assert.equal(wo.istWorkspaceIgnoriert('.synapseignore'), false, 'Positivkontrolle');
});
