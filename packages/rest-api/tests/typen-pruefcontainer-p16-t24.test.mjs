/**
 * P16-T24 (claude-linde, 08.11.2026): Plan-Typpruefung im Pruef-Container statt im Projekt-Workspace.
 * Echt: PruefContainer.pruefeTypen (rest-api dist), pruefer_typen.py (Container-Modul, lokal mit python3/node),
 * Core-TS-Worker typen-pruefung-worker.js. Ersetzt ist nur der Docker-Transport (bereitMachen/schicke) - kein Docker,
 * keine DB. Zaehlt ensureProjectRunning: es darf kein synapse-ws-* gestartet werden.
 * Aufruf: cd packages/rest-api && node --test tests/typen-pruefcontainer-p16-t24.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PruefContainer, PruefContainerNichtVerfuegbar, pruefContainerConfigAusEnv } from '../dist/services/pruef-container.js';
import { WorkspaceOrchestrator } from '../dist/services/workspace-orchestrator.js';

const hier = path.dirname(fileURLToPath(import.meta.url));
const pruefDir = path.resolve(hier, '../../../docker/synapse-pruefcontainer');
const typescript = createRequire(path.resolve(hier, '../../core/package.json')).resolve('typescript');

let ensureAufrufe = 0;
WorkspaceOrchestrator.prototype.ensureProjectRunning = async function () { ensureAufrufe++; throw new Error('P16-T24: Workspace-Start verboten'); };

/** pruefer_typen.pruefe wie im Container (pruefserver ruft genau diese Funktion). */
function pythonTypen(nachricht) {
  return new Promise((resolve, reject) => {
    const p = spawn('python3', ['-B', '-c', 'import sys,json,pruefer_typen as t; print(json.dumps(t.pruefe(json.load(sys.stdin))))'], {
      cwd: pruefDir,
      env: { PATH: process.env.PATH, PYTHONPATH: pruefDir, PRUEF_NODE: process.execPath, PRUEF_TYPESCRIPT: typescript, PRUEF_LEER: tmpdir() },
    });
    let out = '', err = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err += b; });
    p.on('error', reject);
    p.on('close', () => { try { resolve(JSON.parse(out)); } catch { reject(new Error('pruefer_typen ohne JSON: ' + err.slice(0, 500))); } });
    p.stdin.end(JSON.stringify(nachricht));
  });
}

function container({ bereit = async () => {}, antwort } = {}) {
  const pc = new PruefContainer({}, pruefContainerConfigAusEnv());
  const gesendet = [];
  pc.bereitMachen = bereit;
  pc.schicke = async (nachricht, limitMs) => {
    gesendet.push({ nachricht, limitMs });
    if (antwort) return antwort(nachricht);
    return { ok: true, typen: await pythonTypen(nachricht.typen) };
  };
  return { pc, gesendet };
}

const root = '/__synapse_typen__/p16t24';
const datei = 'pkg/src/a.ts';
const gut = 'export const enabled: boolean = true;\n';
const schlecht = "export const enabled: boolean = 'yes';\n";
const tsconfig = JSON.stringify({ compilerOptions: { strict: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', noEmit: true, types: [] }, include: ['src'] });
const auftrag = (budget_ms = 20000) => ({
  project: 'p16-t24-test', root, budget_ms, basisvergleich: true, ziele: [datei],
  quellen: [{ file_path: 'pkg/tsconfig.json', content: tsconfig }, { file_path: datei, content: gut }],
  dateien: [{ file_path: datei, basis: gut, ergebnis: schlecht, ops: [{ op_index: 0, agent_id: 'p16-t24-test', spannen: [[0, 1]] }] }],
});

test('P16-T24 Plan mit TS-Typfehler -> Befund aus dem Pruef-Container, kein Workspace-Start', async () => {
  const { pc, gesendet } = container();
  const r = await pc.pruefeTypen(auftrag());
  assert.equal(r.status, 'fertig', JSON.stringify(r));
  assert(r.befunde.some((b) => b.code === 'TS2322' && b.severity === 'error' && b.op_index === 0), JSON.stringify(r.befunde));
  assert.equal(r.ort, 'pruefcontainer');
  assert.equal(typeof r.ort_ms, 'number');
  assert.equal(typeof r.werkzeug_ms, 'number');
  assert.equal(gesendet.length, 1);
  assert(gesendet[0].nachricht.typen.engine.includes('pruefeTypAuftrag'));
  assert(gesendet[0].nachricht.typen.diff.includes('aenderungsBereiche'));
  assert.equal(gesendet[0].nachricht.typen.auftrag.root, root);
  assert.equal(ensureAufrufe, 0, 'Orchestrator-Aufruf muss 0 sein');
  const z = pc.zustand().typen;
  assert.equal(z.ort, 'pruefcontainer');
  assert.equal(z.auftraege, 1);
  assert.equal(z.letzter_status, 'fertig');
});

test('P16-T24 fehlerfreier Plan -> keine Befunde', async () => {
  const { pc } = container();
  const a = auftrag();
  a.dateien[0].ergebnis = 'export const enabled: boolean = false;\n';
  const r = await pc.pruefeTypen(a);
  assert.equal(r.status, 'fertig', JSON.stringify(r));
  assert.equal(r.befunde.filter((b) => b.severity === 'error').length, 0, JSON.stringify(r.befunde));
});

test('P16-T24 Pruef-Container nicht erreichbar -> nicht_verfuegbar, keine Sperre, kein Ersatzweg', async () => {
  const { pc, gesendet } = container({ bereit: async () => { throw new PruefContainerNichtVerfuegbar('Test: Docker weg'); } });
  const r = await pc.pruefeTypen(auftrag());
  assert.equal(r.status, 'nicht_verfuegbar');
  assert.equal(r.befunde.length, 0);
  assert.match(r.hinweis, /Docker weg/);
  assert.equal(gesendet.length, 0);
  assert.equal(ensureAufrufe, 0);
});

test('P16-T24 altes Image ohne typen-Antwort -> nicht_verfuegbar', async () => {
  const { pc } = container({ antwort: async () => ({ ok: true }) });
  const r = await pc.pruefeTypen(auftrag());
  assert.equal(r.status, 'nicht_verfuegbar');
  assert.match(r.hinweis, /Image ohne P16-T24/);
});

test('P16-T24 Pause nach Startfehlern -> sofort nicht_verfuegbar', async () => {
  const { pc, gesendet } = container();
  pc.pauseBis = Date.now() + 60_000;
  pc.pauseGrund = 'Test-Pause';
  const r = await pc.pruefeTypen(auftrag());
  assert.equal(r.status, 'nicht_verfuegbar');
  assert.equal(gesendet.length, 0);
});

test('P16-T24 haengender Container -> zeitlimit nach Budget', async () => {
  const { pc } = container({ antwort: () => new Promise(() => {}) });
  const t0 = Date.now();
  const r = await pc.pruefeTypen(auftrag(200));
  assert.equal(r.status, 'zeitlimit');
  assert(Date.now() - t0 < 5000);
});

test('P16-T24 Core exportiert nur noch den Container-Ort', async () => {
  const core = await import('@synapse/core');
  assert.equal(typeof core.registriereTypContainerPruefer, 'function');
  assert.equal(core.registriereTypWorkspacePruefer, undefined);
});
