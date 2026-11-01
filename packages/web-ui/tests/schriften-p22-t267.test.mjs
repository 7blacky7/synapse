/**
 * P22-T267 (Befund f5adb6ff, Entscheidung Koordinator 01.11.2026 #t128-team 34582): Design-Schriften selbst gehostet ueber @fontsource.
 * Prueft ohne Netz und Browser:
 *   A package.json: @fontsource/syne und @fontsource/ibm-plex-mono als Abhaengigkeit (statische Pakete -> Familiennamen wie im CSS).
 *   B schriften.ts: nur Subsets latin + latin-ext, Schnitte Syne 600/700/800 und IBM Plex Mono 400-700; kein CDN; main.tsx importiert.
 *   C Installierte Paketdateien: jede importierte CSS existiert, nennt die Familie exakt wie das CSS der Web-UI und font-display: swap.
 *   node packages/web-ui/tests/schriften-p22-t267.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lies = (p) => readFileSync(join(web, p), 'utf8');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };

const pkg = JSON.parse(lies('package.json'));
ok(/^\^5\./.test(pkg.dependencies?.['@fontsource/syne'] ?? '') && /^\^5\./.test(pkg.dependencies?.['@fontsource/ibm-plex-mono'] ?? ''), 'P22-T267 A package.json: @fontsource/syne und @fontsource/ibm-plex-mono (statisch) als Abhaengigkeit', pkg.dependencies);
const schriften = lies('src/schriften.ts');
const importe = [...schriften.matchAll(/^import '(@fontsource\/[^']+)';$/gm)].map((m) => m[1]);
const erwartet = [...['600', '700', '800'].flatMap((w) => ['@fontsource/syne/latin-' + w + '.css', '@fontsource/syne/latin-ext-' + w + '.css']),
  ...['400', '500', '600', '700'].flatMap((w) => ['@fontsource/ibm-plex-mono/latin-' + w + '.css', '@fontsource/ibm-plex-mono/latin-ext-' + w + '.css'])];
ok(importe.length === 14 && erwartet.every((e) => importe.includes(e)), 'P22-T267 B schriften.ts: genau die 14 Schnitte (latin + latin-ext)', importe);
ok(!/googleapis|gstatic|cdn\./i.test(schriften) && importe.every((i) => /\/latin(-ext)?-\d00\.css$/.test(i)), 'P22-T267 B schriften.ts: kein CDN, keine weiteren Subsets (cyrillic, greek, vietnamese)');
ok(/^import '\.\/schriften';\r?$/m.test(lies('src/main.tsx')), 'P22-T267 B main.tsx: importiert ./schriften einmal beim Start');
for (const i of importe) {
  const datei = join(web, 'node_modules', i);
  const css = existsSync(datei) ? readFileSync(datei, 'utf8') : '';
  const familie = i.includes('/syne/') ? 'Syne' : 'IBM Plex Mono';
  ok(css.includes("font-family: '" + familie + "'") && /font-display: swap/.test(css) && /\.woff2\)/.test(css), 'P22-T267 C ' + i + ': vorhanden, Familie "' + familie + '", font-display swap, woff2', css.slice(0, 200));
}
// Gegenprobe: die Familiennamen, die das CSS der Web-UI nutzt, sind genau diese.
const nutzt = lies('src/live-artefakte.css');
ok(/"Syne"/.test(nutzt) && /"IBM Plex Mono"/.test(nutzt), 'P22-T267 C live-artefakte.css nennt "Syne" und "IBM Plex Mono" (gleiche Familiennamen wie die Pakete)');
console.log('P22-T267 Schriften: ' + n + ' Pruefungen bestanden');
