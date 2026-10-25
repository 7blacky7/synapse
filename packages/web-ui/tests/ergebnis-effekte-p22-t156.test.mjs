/**
 * P22-T156: Ergebnis-Effekte, reine Logik (netzwerk/ergebnis-effekte.ts) und Einbau-Proben. Keine DB, kein Netz.
 *   node packages/web-ui/tests/ergebnis-effekte-p22-t156.test.mjs   (laedt die Module ueber vite.ssrLoadModule wie T149)
 * A Art aus Vertrag bzw. Rueckfall; B Haltepunkt 0,5 und R7 (knapp hinter dem Koordinator); C Phasen: Kopf endet bei halb, nie darueber;
 * D Abprall endet beim Agenten, Gegenstoss trifft bei halb; E wartet haelt bis halte_ms; F Zaehler/Farben; G Einbau (Szene, Formular, CSS).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lade = (p) => import(pathToFileURL(join(repo, p)).href);
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const requireUi = createRequire(join(repo, 'packages/web-ui/package.json'));
const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
const vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const E = await vite.ssrLoadModule('/src/components/netzwerk/ergebnis-effekte.ts');
let n = 0;
const ok = (v, label) => { assert(v, label); n++; };
const nah = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// A Art
ok(E.ergebnisArt({ ok: true, ergebnis_art: 'gesperrt' }) === 'gesperrt', 'A Vertrag gewinnt (auch bei ok=true)');
ok(E.ergebnisArt({ ok: true }) === 'erfolg' && E.ergebnisArt({ ok: true, ergebnis_leer: true }) === 'leer' && E.ergebnisArt({ ok: false }) === 'serverfehler', 'A Rueckfall alter Snapshots');
ok(E.istErfolg('leer') && E.istErfolg('erfolg') && E.FEHLER_ARTEN.every((a) => !E.istErfolg(a)), 'A Erfolg nur erfolg/leer');
ok(E.FEHLER_ARTEN.every((a) => E.ERGEBNIS_NAMEN[a] && E.ERGEBNIS_SYMBOL[a] && E.ERGEBNIS_LEGENDE.some(([x]) => x === a)), 'A jede Fehlerart hat Name, Symbol, Legende');

// B Haltepunkt
ok(E.halbStelle([]) === 0.5, 'B ohne Zwischenknoten 0,5');
ok(E.halbStelle([0.2]) === 0.5 && E.halbStelle([0.8]) === 0.5, 'B Koordinator weit weg: 0,5');
ok(nah(E.halbStelle([0.48]), 0.55) && nah(E.halbStelle([0.53]), 0.6), 'B R7: Koordinator nah an 0,5 -> knapp dahinter Richtung Kern');
ok(E.halbStelle([0.88]) === 0.5 && E.halbStelle([0.5], 0.5) <= 0.9, 'B Deckel 0,9');
const k = E.knickAnteile([300, 100]);
ok(k.length === 1 && nah(k[0], 0.75), 'B Knick aus Segmentlaengen');
ok(E.knickAnteile([0, 0]).length === 0, 'B Laenge 0 ohne Knick');

// C Phasen
const z = E.effektZeiten('gesperrt', 1800, 1400, 8000);
ok(z.anlauf === 1080 && z.halten === 0 && z.effekt === 1400 && z.gesamt === 2480, 'C Zeiten ohne Halten');
let maxKopf = 0;
for (let ms = 0; ms <= z.gesamt + 100; ms += 10) { const p = E.effektPhase(ms, z, 0.5); maxKopf = Math.max(maxKopf, p.kopf); }
ok(nah(maxKopf, 0.5), 'C Kopf endet bei 0,5 und geht nie darueber');
ok(E.effektPhase(0, z, 0.5).phase === 'anlauf' && E.effektPhase(1100, z, 0.5).phase === 'effekt' && E.effektPhase(2600, z, 0.5).phase === 'ende', 'C Phasenfolge');
ok(nah(E.effektPhase(1079.999, z, 0.55).kopf, 0.55, 1e-4), 'C Kopf erreicht den verschobenen Haltepunkt');

// D Abprall und Gegenstoss
ok(E.abprallStelle(0, 0.5) === 0.5 && E.abprallStelle(0.1, 0.5) === 0.5 && nah(E.abprallStelle(1, 0.5), 0), 'D Abprall: kurz gestaucht, endet beim Agenten');
for (let u = 0; u <= 1; u += 0.05) ok(E.abprallStelle(u, 0.5) <= 0.5, 'D Abprall nie Richtung Projekt u=' + u.toFixed(2));
ok(nah(E.gegenstossStelle(0, 0.5), 0.64) && nah(E.gegenstossStelle(0.35, 0.5), 0.5) && nah(E.gegenstossStelle(1, 0.5), 0.5), 'D Gegenstoss trifft bei halb');

// E wartet
const w = E.effektZeiten('wartet', 1800, 1400, 8000);
ok(w.halten === 8000 && w.gesamt === 1080 + 8000 + 1400, 'E Haltezeit nur bei wartet');
ok(E.effektPhase(1080 + 4000, w, 0.5).phase === 'halten' && E.effektPhase(1080 + 4000, w, 0.5).kopf === 0.5, 'E steht bei 0,5 und pulsiert');
ok(E.effektPhase(1080 + 8000 + 10, w, 0.5).phase === 'effekt', 'E nach der Haltezeit: verblassen');

// F Zaehler und Farben
const zahl = E.zaehleErgebnisse([{ ok: true }, { ok: false, ergebnis_art: 'konflikt' }, { ok: true, ergebnis_art: 'konflikt' }, { ok: true, ergebnis_leer: true }]);
ok(zahl.erfolg === 1 && zahl.konflikt === 2 && zahl.leer === 1, 'F Zaehler je Art');
ok(JSON.stringify(E.farbeAusCss('#a78bfa')) === JSON.stringify([167 / 255, 139 / 255, 250 / 255]), 'F Hex');
ok(JSON.stringify(E.farbeAusCss(' rgb(124, 58, 237) ')) === JSON.stringify([124 / 255, 58 / 255, 237 / 255]), 'F rgb()');
ok(E.farbeAusCss('var(--x)') === null && E.farbeAusCss('') === null, 'F ungueltig -> null');

// G Einbau
const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
ok(/const ergebnisEffekt = \(/.test(tsx) && /if \(i\.ergebnis && i\.zeiten\) \{ ergebnisEffekt\(/.test(tsx), 'G Effekt im Zeichenweg');
ok(/fehler_effekte', 1\) === 1/.test(tsx) && /wartet_halte_ms', 8000/.test(tsx) && /fehler_effekt_ms', 1400/.test(tsx), 'G Einstellungen mit Code-Rueckfall');
ok(/knickAnteile\(segmente\)/.test(tsx) && /dauer: z\.gesamt \/ 1\.3/.test(tsx), 'G Haltepunkt aus Segmenten, Lebensdauer passt');
ok(/--nw-e-konflikt/.test(tsx) && /dataset\.ergebnisEffekte/.test(tsx), 'G Theme-Tokens und Debug-Zaehler');
ok(/ohne Absender: \{snapshot\.ohne_absender/.test(tsx), 'G T155 Zaehler in der Debug-Zeile');
const css = lies('packages/web-ui/src/agentennetzwerk.css');
ok((css.match(/--nw-e-konflikt:/g) ?? []).length === 2 && (css.match(/--nw-e-nebel:/g) ?? []).length === 2, 'G Tokens hell und dunkel getrennt');
const F = await vite.ssrLoadModule('/src/components/netzwerk/einstellungen-form.ts');
const g = F.gruppiereEinstellungen({ fehler_effekte: { wert: 1, quelle: 'standard', min: 0, max: 1 }, fehler_effekt_ms: { wert: 1400, quelle: 'standard', min: 300, max: 6000 }, wartet_halte_ms: { wert: 8000, quelle: 'standard', min: 1000, max: 60000 } });
ok(g.length === 1 && g[0].titel === 'Ergebnis-Effekte' && g[0].eintraege.length === 3, 'G Formulargruppe Ergebnis-Effekte');
ok(['fehler_effekte', 'fehler_effekt_ms', 'wartet_halte_ms'].every((x) => F.NETZWERK_LABELS[x]), 'G Beschriftungen');
const S = await vite.ssrLoadModule('/src/components/netzwerk/nerven-szene.ts');
const jetzt = Date.now(), zeit = new Date(jetzt - 1000).toISOString();
const snap = { version: 1, stand: zeit, project: 'p', schalter: { aktiv: true, quelle: 'x', bis: null, letzter_fehler: null }, letzter_fehler: null, begrenzt: 0,
  werte: { aktivitaet_sekunden: 60, inaktiv_sekunden: 120, sichtbare_agenten: 24, sichtbare_channels: 8 }, einstellungen: {}, agenten: [],
  ereignisse: [{ id: '1', zeit, project: 'p', agent: 'cloud', identity_id: null, lauf_id: null, tool: 'shell', action: 'exec', ok: false, empfaenger: [], channel: null, interaktion: 'aufruf', quelle: 'tool_calls', routing: 'nicht_erfasst' },
    { id: '2', zeit, project: 'p', agent: 'agent-x', identity_id: null, lauf_id: null, tool: 'channel', action: 'post', ok: true, ergebnis_art: 'falsch_aufgerufen', empfaenger: [], channel: 'c1', interaktion: 'senden', quelle: 'tool_calls', routing: 'vorhanden' }] };
const sz = S.netzwerkSzene(snap, jetzt);
ok(!sz.knoten.some((x) => x.name === 'cloud'), 'G T155: kein Knoten aus source cloud (alter Snapshot)');
ok(sz.knoten.some((x) => x.name === 'agent-x') && sz.channels === 0, 'G T156: abgewiesener Channel-Post macht keinen Channel-Knoten');
// H P22-T162: Projektsonne bis stern_max_promille
const I = await vite.ssrLoadModule('/src/components/netzwerk/index-ebenen.ts');
ok(I.sternFaktor(10000) === 1 && I.sternFaktor(0) === 0.08 && I.indexParameter({}).sternMax === 1, 'H Standard unveraendert (1 bei stern_voll_dateien)');
const p2 = I.indexParameter({ stern_max_promille: 2000, stern_voll_dateien: 5000, stern_min_promille: 80 });
ok(p2.sternMax === 2 && I.sternFaktor(5000, p2) === 2 && I.sternFaktor(9999, p2) === 2, 'H 2000 -> Faktor 2 bei vollen Dateien (Deckel)');
ok(nah(I.sternFaktor(2500, p2), 0.08 + (2 - 0.08) * 0.5), 'H linear von stern_min bis stern_max');
ok(I.indexParameter({ stern_max_promille: 5000 }).sternMax === 2 && I.indexParameter({ stern_max_promille: 10 }).sternMax === 1, 'H Werte ausserhalb 1000..2000 geklemmt');
ok(I.indexEbenen({ werte: { stern_max_promille: 2000, stern_voll_dateien: 100 }, index: { dateien: 100, chunks: 0, stand: '' } }).stern === 2, 'H indexEbenen liefert stern 2');
const sz2 = S.netzwerkSzene({ ...snap, werte: { ...snap.werte, stern_max_promille: 2000, stern_voll_dateien: 100 }, index: { dateien: 100, chunks: 0, stand: zeit } }, jetzt);
ok(sz2.stern === 2 && sz2.radius >= 360 && sz2.kern.radius === 68, 'H Szene: Kern und Einpass-Radius wachsen mit');
const F2 = F.gruppiereEinstellungen({ stern_max_promille: { wert: 1000, quelle: 'standard', min: 1000, max: 2000 } });
ok(F2[0].titel === 'Stern, Trabanten, Nebel' && /Projektsonne maximal/.test(F.NETZWERK_LABELS.stern_max_promille), 'H Formular: Gruppe und Beschriftung');
console.log('P22-T156 Effekte PASS ' + n + ' Pruefungen');
await vite.close();
