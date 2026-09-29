#!/usr/bin/env node
// test-agents-zyklus.mjs — P7-T13 (b): kein Abhaengigkeitskreis mehr zwischen agents und den Runtimes.
//   - agents/package.json hat keine Kante zu agents-gemini/agents-antigravity
//   - @synapse/agents liegt in KEINEM Kreis der Workspace-Abhaengigkeiten (dependencies + devDependencies + optional)
//   - Runtime-Pfad: require.resolve klappt -> dieser Pfad; schlaegt fehl -> Workspace-Pfad relativ zur dist-Datei
//     (nicht zu cwd), existiert im Repo nach dem Build; beides fehlt -> klare Fehlermeldung
//   - process.ts nutzt loeseRuntimePfad
// Aufruf: node scripts/test-agents-zyklus.mjs   (Exit 1 bei Fehler)
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const wurzel = join(dirname(fileURLToPath(import.meta.url)), '..');
const pakete = new Map();
for (const ordner of await readdir(join(wurzel, 'packages'))) {
  const pfad = join(wurzel, 'packages', ordner, 'package.json');
  if (!existsSync(pfad)) continue;
  const pj = JSON.parse(await readFile(pfad, 'utf8'));
  const kanten = Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.optionalDependencies })
    .filter(n => n.startsWith('@synapse/'));
  pakete.set(pj.name, kanten);
}

function imKreis(start) {
  // gibt es einen Weg start -> ... -> start?
  const gesehen = new Set();
  const stapel = [...(pakete.get(start) ?? [])];
  while (stapel.length > 0) {
    const n = stapel.pop();
    if (n === start) return true;
    if (gesehen.has(n)) continue;
    gesehen.add(n);
    stapel.push(...(pakete.get(n) ?? []));
  }
  return false;
}

await pruefe('agents/package.json: keine Kante zu agents-gemini / agents-antigravity', () => {
  const k = pakete.get('@synapse/agents');
  assert.ok(k, 'agents gefunden');
  assert.ok(!k.includes('@synapse/agents-gemini'), 'Kante zu agents-gemini');
  assert.ok(!k.includes('@synapse/agents-antigravity'), 'Kante zu agents-antigravity');
});

await pruefe('Runtimes haengen weiter an agents (richtige Build-Reihenfolge: agents zuerst)', () => {
  assert.ok(pakete.get('@synapse/agents-gemini').includes('@synapse/agents'));
  assert.ok(pakete.get('@synapse/agents-antigravity').includes('@synapse/agents'));
});

await pruefe('@synapse/agents, agents-gemini, agents-antigravity liegen in keinem Kreis', () => {
  for (const n of ['@synapse/agents', '@synapse/agents-gemini', '@synapse/agents-antigravity']) {
    assert.equal(imKreis(n), false, `${n} liegt in einem Abhaengigkeitskreis`);
  }
});

const m = await import('../packages/agents/dist/runtime-pfad.js');
const { loeseRuntimePfad, workspaceRuntimePfad, zerlegeRuntimeSpezifikation } = m;
const DIST = join(wurzel, 'packages', 'agents', 'dist');

await pruefe('Spezifikation zerlegen', () => {
  assert.deepEqual(zerlegeRuntimeSpezifikation('@synapse/agents-gemini/runtime'), { paket: 'agents-gemini', unterpfad: 'runtime' });
  assert.equal(zerlegeRuntimeSpezifikation('fremd/paket'), null);
  assert.equal(zerlegeRuntimeSpezifikation('@synapse/agents-gemini'), null);
});

await pruefe('require.resolve klappt -> dieser Pfad, kein Fallback noetig', () => {
  const p = loeseRuntimePfad('@synapse/agents-gemini/runtime', DIST, {
    resolve: () => '/x/aufgeloest.js',
    existsSync: () => { throw new Error('darf nicht gefragt werden'); },
  });
  assert.equal(p, '/x/aufgeloest.js');
});

await pruefe('require.resolve schlaegt fehl -> Workspace-Pfad relativ zur dist-Datei (nicht cwd)', () => {
  const p = loeseRuntimePfad('@synapse/agents-gemini/runtime', '/repo/packages/agents/dist', {
    resolve: () => { throw new Error('MODULE_NOT_FOUND'); },
    existsSync: (pfad) => pfad === '/repo/packages/agents-gemini/dist/runtime.js',
  });
  assert.equal(p, '/repo/packages/agents-gemini/dist/runtime.js');
  assert.equal(workspaceRuntimePfad('@synapse/agents-antigravity/runtime', '/repo/packages/agents/dist'), '/repo/packages/agents-antigravity/dist/runtime.js');
});

await pruefe('Fallback-Pfad existiert im Repo nach dem Build (Gemini + Antigravity)', () => {
  for (const spez of ['@synapse/agents-gemini/runtime', '@synapse/agents-antigravity/runtime']) {
    const pfad = workspaceRuntimePfad(spez, DIST);
    assert.ok(existsSync(pfad), `fehlt: ${pfad}`);
  }
});

await pruefe('beides fehlt -> klare Fehlermeldung mit beiden Pfaden', () => {
  assert.throws(
    () => loeseRuntimePfad('@synapse/agents-gemini/runtime', '/repo/packages/agents/dist', {
      resolve: () => { throw new Error('MODULE_NOT_FOUND'); },
      existsSync: () => false,
    }),
    /require\.resolve: MODULE_NOT_FOUND.*Workspace-Pfad fehlt: \/repo\/packages\/agents-gemini\/dist\/runtime\.js.*gebaut/s,
  );
});

await pruefe('process.ts nutzt loeseRuntimePfad statt direktem require.resolve', async () => {
  const src = await readFile(join(wurzel, 'packages', 'agents', 'src', 'process.ts'), 'utf8');
  assert.match(src, /from '\.\/runtime-pfad\.js'/);
  assert.match(src, /loeseRuntimePfad\(/);
  assert.match(src, /dirname\(fileURLToPath\(import\.meta\.url\)\)/);
  assert.ok(!/runtimePath = requireFn\.resolve\(/.test(src), 'direktes require.resolve darf nicht mehr der einzige Weg sein');
});

console.log(`${ok} OK, ${fehler} FEHLER`);
process.exit(fehler > 0 ? 1 : 0);
