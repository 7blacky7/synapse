/**
 * P22-T254 / P22-T270 (Abnahme 576de978 B1, Auftrag Koordinator 01.11.2026): gemeinsame Viewport-Begrenzung der verschiebbaren Fenster.
 *   node --experimental-strip-types packages/web-ui/tests/fenster-grenze-p22-t254.test.mjs
 * Sichert ab: components/fenster-grenze.ts fensterImViewport (390px, Desktop, Ziehen nach rechts/links/unten) und dass ChannelFenster.tsx
 * und AusweisFenster.tsx dieselbe Funktion beim Start, beim Ziehen und bei resize nutzen. Ohne DB, Netz und Browser.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
let n = 0;
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + JSON.stringify(info) : '')); assert.ok(wert, label); };

const G = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/fenster-grenze.ts')).href);
const R = G.FENSTER_RAND;
// 390px: CSS (<=760px) macht das Fenster 100vw-16px breit; Start x=80 (Channel) bzw. 140 (Ausweis) stand rechts ueber (Befund 576de978).
for (const start of [80, 140]) {
  const p = G.fensterImViewport(start, 55, 388 - 16, 388, 842);
  ok(p.x === R && p.x + 372 <= 388 - R + 0.001, 'P22-T254/T270 fenster-grenze.ts: 390px, Start x=' + start + ' -> ganz im Viewport (Rand ' + R + ')', p);
}
const desk = G.fensterImViewport(80, 55, 880, 1920, 1080);
ok(desk.x === 80 && desk.y === 55, 'P22-T254 fenster-grenze.ts: Desktop-Startposition bleibt unveraendert', desk);
const rechts = G.fensterImViewport(1700, 55, 880, 1920, 1080);
ok(rechts.x === 1920 - 880 - R, 'P22-T254 fenster-grenze.ts: Ziehen nach rechts haelt den Kopf mit Minimieren/Schliessen im Viewport', rechts);
const links = G.fensterImViewport(-300, -40, 880, 1920, 1080);
ok(links.x === R && links.y === 0, 'P22-T254 fenster-grenze.ts: Ziehen nach links/oben stoppt am Rand', links);
const unten = G.fensterImViewport(100, 5000, 880, 1920, 1080);
ok(unten.y === 1080 - G.FENSTER_KOPF_MIN, 'P22-T254 fenster-grenze.ts: unten bleibt der Kopf sichtbar', unten);

for (const [pfad, task] of [['packages/web-ui/src/components/ChannelFenster.tsx', 'P22-T254'], ['packages/web-ui/src/components/AusweisFenster.tsx', 'P22-T270']]) {
  const t = lies(pfad);
  ok(t.includes("import { fensterImViewport } from './fenster-grenze';") && /fensterImViewport\(x, y, fenster\.current\?\.getBoundingClientRect\(\)\.width \?\? 0, window\.innerWidth, window\.innerHeight\)/.test(t),
    task + ' ' + pfad + ': nutzt die gemeinsame Begrenzung mit gemessener Fensterbreite');
  ok(/useLayoutEffect\(\(\) => \{[\s\S]{0,240}addEventListener\('resize', anpassen\)/.test(t) && /setPosition\(grenze\(/.test(t) && t.includes('ref={fenster}'),
    task + ' ' + pfad + ': Begrenzung beim Start, bei resize und beim Ziehen');
  ok(!t.includes('window.innerWidth-100') && !t.includes('window.innerWidth - 100'), task + ' ' + pfad + ': alte Grenze (innerWidth-100) ist entfernt');
}
console.log('OK P22-T254 Fenster-Grenze: ' + n + ' Pruefungen');
