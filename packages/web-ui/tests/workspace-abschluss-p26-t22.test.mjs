/**
 * P26-T22: Abschluss des Web-UI-Refactors. App.tsx laedt nur noch components/workspace/SynapseWorkspace (P26-Module),
 * die alte Huelle SynapseWorkspaceMock.tsx und der Umschalter aus P22-T222 (oberflaeche-wahl.ts, oberflaeche-umschalter.css)
 * sind entfernt; kein Quelltext unter src importiert sie noch. Rueckweg: files versions/restore der alten Datei.
 *   node packages/web-ui/tests/workspace-abschluss-p26-t22.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(web, 'src');
let n = 0;
const ok = (bed, text) => { assert.ok(bed, text); n++; };

const app = readFileSync(join(src, 'App.tsx'), 'utf8');
ok(/import SynapseWorkspace from '\.\/components\/workspace\/SynapseWorkspace'/.test(app), 'P26-T22 App.tsx: importiert SynapseWorkspace');
ok(/<SynapseWorkspace project="synapse" onLogout=\{handleLogout\} \/>/.test(app), 'P26-T22 App.tsx: rendert SynapseWorkspace');
const appCode = app.split('\n').filter((z) => !/^\s*(\/\/|\/?\*)/.test(z)).join('\n');
ok(!/SynapseWorkspaceMock|oberflaeche-wahl|oberflaeche-umschalter|lazy\(/.test(appCode), 'P26-T22 App.tsx: keine alte Huelle, kein Umschalter (ohne Kommentare)');
ok(/getDerivedStateFromError/.test(app), 'P26-T22 App.tsx: Fehlergrenze vorhanden');

for (const p of ['components/SynapseWorkspaceMock.tsx', 'components/oberflaeche-wahl.ts', 'oberflaeche-umschalter.css']) {
  ok(!existsSync(join(src, p)), 'P26-T22 entfernt: src/' + p);
}

// Kein Import der alten Huelle mehr unter src (Kommentare duerfen sie als Herkunft nennen).
const dateien = [];
const lauf = (d) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) lauf(p); else if (/\.(tsx?|css)$/.test(e)) dateien.push(p); } };
lauf(src);
const importe = dateien.filter((p) => /^\s*import[^\n]*SynapseWorkspaceMock/m.test(readFileSync(p, 'utf8')));
ok(importe.length === 0, 'P26-T22 kein Import von SynapseWorkspaceMock unter src (' + importe.join(', ') + ')');

const huelle = readFileSync(join(src, 'components/workspace/SynapseWorkspace.tsx'), 'utf8');
ok(/export default function SynapseWorkspace\(/.test(huelle), 'P26-T22 SynapseWorkspace.tsx: Default-Export der Huelle');
ok(/import '\.\.\/\.\.\/workspace-mock\.css';/.test(huelle), 'P26-T22 SynapseWorkspace.tsx: Arbeitsflaechen-CSS weiter eingebunden');

console.log('P26-T22 Abschluss: ' + n + ' Pruefungen gruen');
