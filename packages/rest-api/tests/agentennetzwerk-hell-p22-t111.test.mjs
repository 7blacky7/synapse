/**
 * P22-T111: Agentennetzwerk folgt dem hellen Design. Statische Pruefung (ohne DB, ohne Browser):
 *   node packages/rest-api/tests/agentennetzwerk-hell-p22-t111.test.mjs
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const ui=resolve(dirname(fileURLToPath(import.meta.url)),'../../web-ui/src');
const css=await readFile(join(ui,'agentennetzwerk.css'),'utf8');
const tsx=await readFile(join(ui,'components/Agentennetzwerk.tsx'),'utf8');
const gl=await readFile(join(ui,'components/netzwerk/nerven-renderer.ts'),'utf8');
let checks=0;const ok=(c,m)=>{assert(c,m);checks++;};

// 1. Keine festen Dunkelfarben mehr fuer Flaechen ausserhalb der Token-Definitionen.
const ohneTokens=css.replace(/\.agent-network\{--nw-[^}]*\}/g,'').replace(/\[data-theme="light"\] \.agent-network\{[^}]*\}/g,'');
for(const f of ['#05070b','#0a0d13','#0b0e14','#000000b3','#aab4c0'])ok(!ohneTokens.includes(f),'feste Dunkelfarbe '+f+' ausserhalb der Tokens');
ok(/\.nw-stage\{[^}]*background:var\(--nw-bg\)/.test(css),'.nw-stage nutzt --nw-bg');
ok(/\.nw-feed\{[^}]*background:var\(--nw-bg\)/.test(css),'.nw-feed nutzt --nw-bg');
const hell=css.match(/\.synapse-control\[data-theme="light"\] \.agent-network\{([^}]*)\}/);
ok(hell,'helle Token-Ueberschreibung vorhanden');
const dunkel=css.match(/\.agent-network\{(--nw-[^}]*)\}/);
ok(dunkel,'dunkle Token-Definition vorhanden');
const namen=s=>[...s.matchAll(/(--nw-[a-z-]+):/g)].map(m=>m[1]).sort();
assert.deepEqual(namen(hell[1]),namen(dunkel[1]),'hell definiert dieselben Tokens');checks++;
const bg=hell[1].match(/--nw-bg:#([0-9a-f]{6})/i)[1];
const lum=parseInt(bg.slice(0,2),16)+parseInt(bg.slice(2,4),16)+parseInt(bg.slice(4,6),16);
ok(lum>600,'heller Buehnengrund');

// 2. Renderer: Hell-Modus mit hellem Clear und normalem Blending, dunkel unveraendert additiv.
ok(/begin\([^)]*hell\?: boolean\)/.test(gl),'Licht.begin kennt hell');
ok(gl.includes('HINTERGRUND_HELL'),'heller Clear-Wert');
ok(gl.includes('gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); else gl.blendFunc(gl.ONE, gl.ONE)'),'Blending je Design');
ok(gl.includes("globalCompositeOperation = hell ? 'source-over' : 'lighter'"),'Canvas-Ersatz je Design');

// 3. Komponente: Design live vom data-theme-Vorfahren, Textebene mit lesbaren Farben.
ok(tsx.includes("el.closest('[data-theme=\"light\"]')"),'hell aus data-theme');
ok(tsx.includes('licht.begin(w, h, dpr, k, uhr, hell)'),'hell an Renderer');
ok(tsx.includes('TEXT_HELL[farbe] ?? farbe'),'Textfarben im hellen Design abgebildet');
console.log('P22-T111 hell: '+checks+' Pruefungen gruen');
