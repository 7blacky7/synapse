/**
 * P22-T235 Nachbesserung globale Uebersicht nach der Live-Abnahme P22-T196 auf t221 (claude-birke, thought 014db8fa, Channel 31615).
 * Herkunft: B1 Buehne bei 1080p zu hoch (calc(100vh - 230px)), Sonnenliste angeschnitten (.control-content 1004 px, Liste bis 1030 px);
 *           B2 Sonnenkarte zeigte 'Letzter Aufruf: Nicht im Zeitfenster', obwohl die Sonne aktiv war.
 * Aufruf (Repo-Wurzel, ohne DB, ohne Build):  node packages/web-ui/tests/uebersicht-layout-p22-t235.test.mjs
 * A buehnenHoehe: Messwerte der Abnahme -> Buehne + Sonnenliste passen in 1004 px; kleiner Bildschirm -> Mindesthoehe; ohne Messung
 *   der Liste Standardhoehe; ungueltige Werte -> Mindesthoehe.
 * B Einbau (statisch): CSS liest --uebersicht-buehne statt festem 100vh - 230px, OverviewView misst (ResizeObserver/MutationObserver,
 *   je Bild einmal), Sonnenkarte zeigt 'Letzte Aktivitaet' statt 'Nicht im Zeitfenster', andere Knoten unveraendert.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
let checks = 0;
const ok = (c, m, x) => { assert(c, m + (x === undefined ? '' : ' :: ' + JSON.stringify(x))); checks++; console.log('OK ' + m); };

const L = await import(pathToFileURL(join(repo, 'packages/web-ui/src/views/uebersicht/uebersicht-layout.ts')).href);
// A Messwerte der Abnahme t221: Scrollbereich 1004 px; Buehne beginnt unter Seitenrand + Leiste + Abstand + Netzwerkkopf (~150 px).
const h = L.buehnenHoehe({ behaelterHoehe: 1004, buehneOben: 150, sonnenHoehe: 52 });
ok(h === 1004 - 150 - 52 - L.LUFT && 150 + h + 52 <= 1004, 'A 1080p: Buehne + Sonnenliste passen in den sichtbaren Bereich (' + h + ' px)', h);
ok(h < 1080 - 230, 'A neue Hoehe kleiner als das alte calc(100vh - 230px) = 850 px');
ok(L.buehnenHoehe({ behaelterHoehe: 600, buehneOben: 150, sonnenHoehe: 52 }) === 390, 'A 600 px Scrollbereich: 390 px frei, ueber der Mindesthoehe');
ok(L.buehnenHoehe({ behaelterHoehe: 500, buehneOben: 150, sonnenHoehe: 52 }) === L.BUEHNE_MIN, 'A kleiner Bildschirm (290 px frei): Mindesthoehe ' + L.BUEHNE_MIN);
ok(L.buehnenHoehe({ behaelterHoehe: 1004, buehneOben: 150 }) === 1004 - 150 - L.SONNENLISTE_STANDARD - L.LUFT, 'A Sonnenliste noch nicht gemessen: Standardhoehe');
ok(L.buehnenHoehe({ behaelterHoehe: NaN, buehneOben: 0 }) === L.BUEHNE_MIN, 'A ungueltige Messung: Mindesthoehe');
ok(L.buehnenHoehe({ behaelterHoehe: 1400, buehneOben: 150, sonnenHoehe: 52 }) > h, 'A groesserer Bildschirm: groessere Buehne');

// B Einbau statisch
const css = lies('packages/web-ui/src/uebersicht-netzwerk.css');
ok(css.includes('height:var(--uebersicht-buehne,') && !css.includes('calc(100vh - 230px)'), 'B CSS: Hoehe aus --uebersicht-buehne, kein festes 100vh - 230px mehr');
ok(/@media\(max-width:767px\)\{[\s\S]*\.nw-stage\{height:min\(122vw,580px\)\}/.test(css), 'B Mobil unveraendert (min(122vw, 580px))');
const ov = lies('packages/web-ui/src/views/uebersicht/OverviewView.tsx');
ok(ov.includes('ref={netzRef}') && ov.includes("setProperty('--uebersicht-buehne'") && ov.includes('new ResizeObserver(planen)') && ov.includes('requestAnimationFrame(messen)') && ov.includes('{ childList: true, subtree: true }'), 'B OverviewView misst den freien Platz (Groesse + Inhalt, je Bild einmal)');
ok(!/attributes:\s*true/.test(ov), 'B keine Attribut-Beobachtung (Setzen der Variable loest keine Schleife aus)');
const tsx = lies('packages/web-ui/src/components/Agentennetzwerk.tsx');
ok(tsx.includes("kartenKnoten.rolle === 'sonne'") && tsx.includes('<dt>Letzte Aktivität</dt>') && tsx.includes('datum(new Date(kartenKnoten.letzte).toISOString())'), 'B Sonnenkarte: Letzte Aktivitaet aus kn.letzte');
ok(tsx.includes("<dt>Letzter Aufruf</dt><dd>{kartenAufruf ? kartenAufruf.tool + '.' + kartenAufruf.action"), 'B andere Knoten zeigen weiter den letzten Aufruf');
console.log('PASS P22-T235: ' + checks + ' Pruefungen');
