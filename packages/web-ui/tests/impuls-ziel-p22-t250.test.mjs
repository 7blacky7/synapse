/**
 * P22-T250: Effekt-Impulse treffen ihr Ziel auch, wenn es sich bewegt - ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/impuls-ziel-p22-t250.test.mjs
 * Anlass (User 31.10.2026 ~22:28/22:30): in Uebersicht und Hauptagent-Netz bewegen sich die Agentenpunkte; das Resultat (Rueckfluss) zum
 * Agenten verfehlte den bewegten Punkt und landete im Nichts, weil die Bahn beim Start fest gebaut wurde.
 * Sichert ab:
 *   A components/netzwerk/impuls-ziel.ts: rohPunkt = bisherige feste Bahn; mitgefuehrt fuehrt Start/Ziel mit (f=0 exakt Start, f=1 exakt
 *     Ziel, dazwischen linear); ohne Anker unveraendert; ankunftAbweichung (mitgefuehrt ~0, roh = Fehlweite).
 *   B Simulation: Agent kreist um seine Sonne (wie P22-T244 bahnPunkt), Aufruf hin und Rueckfluss zurueck -> Treffer exakt, feste Bahn verfehlt.
 *   C Einbau Agentennetzwerk.tsx: punkt() fuehrt Bahnen mit, Anker fuer Impuls und Rueckfluss (umgekehrt), Messung an beiden Ankuenften,
 *     Debug dataset.ankunftAbweichung; weiterhin 21 nwWert-Stellen (keine neue Zahl).
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | tatsaechlich: ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const Z = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/netzwerk/impuls-ziel.ts')).href);
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const nah = (a, b, eps = 1e-3) => Math.hypot(a.x - b.x, a.y - b.y) < eps;
// Kurve wie nerven-szene kurve(): quadratische Bezier mit Woelbung, n Stuetzpunkte.
const kurve = (a, b, w, k = 16) => { const mx = (a.x + b.x) / 2 - (b.y - a.y) * w, my = (a.y + b.y) / 2 + (b.x - a.x) * w, p = [];
  for (let i = 0; i <= k; i++) { const t = i / k, u = 1 - t; p.push(u * u * a.x + 2 * u * t * mx + t * t * b.x, u * u * a.y + 2 * u * t * my + t * t * b.y); } return new Float32Array(p); };
const umkehren = (p) => { const m = p.length / 2, r = new Float32Array(p.length); for (let k = 0; k < m; k++) { r[k * 2] = p[(m - 1 - k) * 2]; r[k * 2 + 1] = p[(m - 1 - k) * 2 + 1]; } return r; };

// ---------------------------------------------------------------- A Logik (impuls-ziel.ts)
const S0 = { x: 100, y: 0 }, Z0 = { x: 0, y: 0 }, P = kurve(S0, Z0, 0.2);
ok(nah(Z.rohPunkt(P, 0), S0) && nah(Z.rohPunkt(P, 1), Z0), 'P22-T250 impuls-ziel.ts rohPunkt: feste Bahn von Start bis Ziel (bisheriges punkt)');
for (const f of [0, 0.3, 0.5, 1]) ok(nah(Z.mitgefuehrt(P, f, S0, Z0), Z.rohPunkt(P, f)) && nah(Z.mitgefuehrt(P, f, null, null), Z.rohPunkt(P, f)),
  'P22-T250 impuls-ziel.ts mitgefuehrt: ohne Bewegung bzw. ohne Anker = feste Bahn (Optik unveraendert), f=' + f);
const S1 = { x: 130, y: 25 }, Z1 = { x: -12, y: 40 };
ok(nah(Z.mitgefuehrt(P, 1, S1, Z1), Z1, 1e-4), 'P22-T250 impuls-ziel.ts mitgefuehrt: f=1 exakt auf der AKTUELLEN Lage des Ziels', Z.mitgefuehrt(P, 1, S1, Z1));
ok(nah(Z.mitgefuehrt(P, 0, S1, Z1), S1, 1e-4), 'P22-T250 impuls-ziel.ts mitgefuehrt: f=0 exakt auf der aktuellen Lage des Starts');
const m = Z.mitgefuehrt(P, 0.5, S1, Z1), r = Z.rohPunkt(P, 0.5);
ok(nah(m, { x: r.x + ((S1.x - S0.x) + (Z1.x - Z0.x)) / 2, y: r.y + ((S1.y - S0.y) + (Z1.y - Z0.y)) / 2 }, 1e-3), 'P22-T250 impuls-ziel.ts mitgefuehrt: Mitte verschiebt sich um den Mittelwert (Kurve wandert mit)', m);
ok(nah(Z.mitgefuehrt(P, 1, null, Z1), Z1, 1e-4) && nah(Z.mitgefuehrt(P, 0, null, Z1), S0, 1e-4), 'P22-T250 impuls-ziel.ts mitgefuehrt: nur Ziel bewegt (Start unbekannt) -> Start bleibt, Ziel getroffen');
const aussen = Z.mitgefuehrt(P, 1, S1, null);
ok(nah(aussen, Z0, 1e-4), "P22-T250 impuls-ziel.ts mitgefuehrt: Ziel ohne Knoten (Signal 'aussen') bleibt am Bahnende", aussen);
let ab = Z.ankunftAbweichung(P, S1, Z1, 2);
ok(ab.px < 1e-3 && Math.abs(ab.roh_px - Math.hypot(Z1.x, Z1.y) * 2) < 1e-3, 'P22-T250 impuls-ziel.ts ankunftAbweichung: mitgefuehrt ~0 px, roh = Fehlweite in px (Zoom)', ab);
ok(Z.ankunftAbweichung(P, S1, null, 1).px === 0 && Z.ankunftAbweichung(new Float32Array([1, 2]), S1, Z1, 1).px === 0, 'P22-T250 impuls-ziel.ts ankunftAbweichung: ohne Ziel bzw. ohne Bahn 0');

// ---------------------------------------------------------------- B Simulation: kreisender Agent, Aufruf hin, Resultat zurueck
// Agent kreist mit Radius 80 um seine Sonne (0,0) wie P22-T244 (omega 0,07 rad/s, bei Aktivitaet schneller - hier bewusst 1,2 rad/s).
const agentBei = (s) => ({ x: Math.cos(1.2 * s) * 80, y: Math.sin(1.2 * s) * 80 });
const sonne = { x: 0, y: 0 }, hinDauer = 0.9, rueckDauer = 0.6;
const hin = kurve(agentBei(0), sonne, 0.13), rueck = umkehren(hin);
let maxHin = 0, maxRueck = 0;
for (let k = 0; k <= 30; k++) { const s = (k / 30) * hinDauer, q = Z.mitgefuehrt(hin, s / hinDauer, agentBei(s), sonne); if (k === 30) maxHin = Math.hypot(q.x - sonne.x, q.y - sonne.y); }
ok(maxHin < 1e-4, 'P22-T250 Simulation: Aufruf trifft die Sonne', maxHin);
const start = hinDauer;
for (let k = 0; k <= 30; k++) {
  const s = start + (k / 30) * rueckDauer, q = Z.mitgefuehrt(rueck, k / 30, sonne, agentBei(s));
  if (k === 0) ok(nah(q, sonne, 1e-4), 'P22-T250 Simulation: Rueckfluss startet an der Sonne');
  if (k === 30) maxRueck = Math.hypot(q.x - agentBei(s).x, q.y - agentBei(s).y);
}
const rohFehl = Math.hypot(Z.rohPunkt(rueck, 1).x - agentBei(start + rueckDauer).x, Z.rohPunkt(rueck, 1).y - agentBei(start + rueckDauer).y);
ok(maxRueck < 1e-4 && rohFehl > 50, 'P22-T250 Simulation: Resultat trifft den bewegten Agentenpunkt exakt; feste Bahn haette um ' + rohFehl.toFixed(0) + ' Weltpunkte verfehlt', { maxRueck, rohFehl });
ab = Z.ankunftAbweichung(rueck, sonne, agentBei(start + rueckDauer), 1.4);
ok(ab.px < 1e-3 && ab.roh_px > 50, 'P22-T250 Simulation: Debug-Wert max_px ~0, roh_max_px zeigt die alte Fehlweite', ab);

// ---------------------------------------------------------------- C Einbau (Agentennetzwerk.tsx)
const nw = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
ok(/import \{ rohPunkt, mitgefuehrt, ankunftAbweichung, type Anker \} from '\.\/netzwerk\/impuls-ziel'/.test(nw), 'P22-T250 Agentennetzwerk.tsx: importiert die Logik aus netzwerk/impuls-ziel.ts');
ok(/const punkt = \(p: Float32Array, f: number\) => \{ const a = anker\.get\(p\); return a \? mitgefuehrt\(p, f, liveLage\(a\.von\), liveLage\(a\.nach\)\) : rohPunkt\(p, f\); \};/.test(nw),
  'P22-T250 Agentennetzwerk.tsx punkt(): jede verankerte Bahn je Frame aus der aktuellen Lage von Start und Ziel');
ok(/p\.impuls = baue\(p\.e, g, s\.werte\); if \(p\.impuls\) anker\.set\(p\.impuls\.pfad, \{ von: p\.impuls\.von, nach: p\.impuls\.nach \}\)/.test(nw), 'P22-T250 Agentennetzwerk.tsx: Hinweg-Impuls verankert (von -> nach)');
ok(/anker\.set\(r, \{ von: i\.nach, nach: i\.von \}\)/.test(nw), 'P22-T250 Agentennetzwerk.tsx zurueck(): Rueckfluss verankert (Ziel -> Agent), Ende folgt dem Agentenpunkt');
ok(/i\.angekommen = true; messeAnkunft\(i\.pfad, false\)/.test(nw) && /r0\.gemessen = true; messeAnkunft\(r0\.pfad, true\)/.test(nw), 'P22-T250 Agentennetzwerk.tsx: Messung an Ankunft hin und zurueck');
ok(/el\.dataset\.ankunftAbweichung = JSON\.stringify\(\{ max_px:/.test(nw), 'P22-T250 Agentennetzwerk.tsx: Debug dataset.ankunftAbweichung (max_px, roh_max_px, ankuenfte, rueck)');
ok(!/const punkt = \(p: Float32Array, f: number\) => \{\n/.test(nw), 'P22-T250 Agentennetzwerk.tsx: keine zweite feste punkt()-Variante mehr');
ok(!/nwWert\([^)]*(ankunft|mitfuehr|impuls_ziel)/.test(nw), 'P22-T250 Agentennetzwerk.tsx: keine neue nwWert-Stelle fuer die Mitfuehrung (t153 zaehlt die 21 Rueckfallstellen)');
console.log('P22-T250 Web-UI: ' + n + ' Pruefungen bestanden');
