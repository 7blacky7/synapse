/**
 * P22-T169 (User 25.10.2026, Entscheidung thought 403c12bd Punkt 3): persoenliche Auswahl (Radio/Checkbox/details) je Artefakt und
 * Betrachter auch ueber das Neuladen merken; ohne gemerkten Zustand bleibt das Artefakt wie heute.
 * SICHERT AB: P22-T169
 *   web-ui/src/kios/verweis-klick-logik.ts  dauerhafterZustand, speichereArtefaktZustand, leseArtefaktZustand (rein, Speicher-Attrappe)
 *   web-ui/src/kios/AgentRenderingSurface.tsx  Prop zustandSchluessel: merkt nur nach change/summary-Klick, setzt beim ersten Anzeigen ein
 *   web-ui/src/components/ArtefaktLiveBlock.tsx  reicht 'artefakt:<id>' durch
 * Keine DB, kein Browser (Browserabnahme mit KI-Browser erst nach Freigabe des Koordinators).
 * Aufruf: node --experimental-strip-types packages/web-ui/tests/artefakt-zustand-p22-t169.test.mjs
 * Bei FAIL: Debugzeile mit Herkunft (Label), erwartet/tatsaechlich.
 */
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const L = await import(pathToFileURL(join(hier, '..', 'src', 'kios', 'verweis-klick-logik.ts')).href);
let fails = 0;
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 700) : '')); } };
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const speicher = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } }; };

// Nur stabile Schluessel dauerhaft (Index-Schluessel verrutschen, wenn neue Plaene/Tasks dazukommen).
const z = { geprueft: { '#r-P2': true, '#r-P1': false, 'radio:sort=nummer': true, 'checkbox@4': true }, offen: { '#d-P2': true, '@1': false } };
const d = L.dauerhafterZustand(z);
check(gleich(d, { geprueft: { '#r-P2': true, '#r-P1': false, 'radio:sort=nummer': true }, offen: { '#d-P2': true } }),
  'P22-T169 verweis-klick-logik.ts dauerhafterZustand: #id und name=wert bleiben, Index-Schluessel fallen weg', { erwartet: 'ohne checkbox@4/@1', tatsaechlich: d });

// Speichern + Lesen je Artefakt-ID (Praefix), getrennt je Artefakt.
const s = speicher();
check(L.speichereArtefaktZustand(s, 'artefakt:a1', z) === true && s.m.has(L.ZUSTAND_SPEICHER_PRAEFIX + 'artefakt:a1') && L.ZUSTAND_SPEICHER_PRAEFIX === 'synapse-artefakt-zustand:',
  'P22-T169 verweis-klick-logik.ts speichereArtefaktZustand: Eintrag synapse-artefakt-zustand:<schluessel>', { tatsaechlich: [...s.m.keys()] });
check(gleich(L.leseArtefaktZustand(s, 'artefakt:a1'), d) && L.leseArtefaktZustand(s, 'artefakt:a2') === null,
  'P22-T169 verweis-klick-logik.ts leseArtefaktZustand: eigener Stand, anderes Artefakt -> null (Standard bleibt)', { tatsaechlich: L.leseArtefaktZustand(s, 'artefakt:a1') });

// Wiederherstellen nach dem Neuladen: gemerktes Radio wird gesetzt, neue Elemente bleiben im Standard.
const neu = { r1: { id: 'r-P1', name: 'plan', value: 'on', type: 'radio', checked: true }, r2: { id: 'r-P2', name: 'plan', value: 'on', type: 'radio', checked: false },
  r9: { id: 'r-P9', name: 'plan', value: 'on', type: 'radio', checked: false }, sort: { id: '', name: 'sort', value: 'nummer', type: 'radio', checked: false } };
const wurzel = { querySelectorAll: (sel) => (sel === 'details' ? [{ id: 'd-P2', open: false }] : [neu.r1, neu.r2, neu.r9, neu.sort]) };
const n = L.stelleZustandHer(wurzel, L.leseArtefaktZustand(s, 'artefakt:a1'));
check(neu.r2.checked === true && neu.sort.checked === true && neu.r9.checked === false && n === 3,
  'P22-T169 verweis-klick-logik.ts stelleZustandHer mit gelesenem Zustand: Plan P2 und Sortierung Nummer wieder gewaehlt, neue Elemente unberuehrt', { n, neu });

// Robust: gesperrter/voller Speicher, kaputter Inhalt, fehlender Schluessel -> kein Wurf, Standard.
const gesperrt = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceededError'); } };
check(L.speichereArtefaktZustand(gesperrt, 'artefakt:a1', z) === false && L.leseArtefaktZustand(gesperrt, 'artefakt:a1') === null
  && L.speichereArtefaktZustand(null, 'artefakt:a1', z) === false && L.speichereArtefaktZustand(s, '', z) === false,
  'P22-T169 verweis-klick-logik.ts: Speicher gesperrt/fehlt oder Schluessel leer -> false/null, wirft nie');
const kaputt = speicher();
kaputt.setItem(L.ZUSTAND_SPEICHER_PRAEFIX + 'artefakt:x', '{kein json');
kaputt.setItem(L.ZUSTAND_SPEICHER_PRAEFIX + 'artefakt:y', JSON.stringify({ geprueft: { '#a': 'ja' }, offen: {} }));
check(L.leseArtefaktZustand(kaputt, 'artefakt:x') === null && gleich(L.leseArtefaktZustand(kaputt, 'artefakt:y'), { geprueft: {}, offen: {} }),
  'P22-T169 verweis-klick-logik.ts leseArtefaktZustand: kaputtes JSON -> null, Nicht-Boolesches faellt weg', { y: L.leseArtefaktZustand(kaputt, 'artefakt:y') });

// Verdrahtung (Quelltext): Surface merkt nur Betrachter-Aenderungen und setzt beim ersten Anzeigen ein; LiveBlock reicht die Artefakt-ID durch.
const src = (p) => readFileSync(join(hier, '..', 'src', p), 'utf8');
const surface = src('kios/AgentRenderingSurface.tsx');
check(/zustandSchluessel\?: string \| null/.test(surface) && /addEventListener\('change'/.test(surface) && /closest\?\.\('summary'\)/.test(surface)
  && /speichereArtefaktZustand\(lokalerSpeicher\(\), s, merkeZustand\(content\)\)/.test(surface) && /leseArtefaktZustand\(lokalerSpeicher\(\), s\)/.test(surface)
  && /aktivRef\.current !== true \|\| wiederhergestelltRef\.current === s/.test(surface) && /'erstes_anzeigen'/.test(surface) && /'schalter_geladen'/.test(surface),
  'P22-T169 AgentRenderingSurface.tsx: merkt nach change/summary-Klick, liest einmal je Artefakt (Schalter artefakt_verweise), auch wenn der Schalter spaet kommt');
check(/window\.localStorage/.test(surface) && /catch \{ return null; \}/.test(surface), 'P22-T169 AgentRenderingSurface.tsx lokalerSpeicher: localStorage in try/catch');
check(/zustandSchluessel=\{'artefakt:' \+ id\}/.test(src('components/ArtefaktLiveBlock.tsx')), 'P22-T169 ArtefaktLiveBlock.tsx: reicht artefakt:<id> an die Surface');

console.log(fails ? 'FAILS ' + fails : 'PASS artefakt-zustand-p22-t169 (web-ui)');
process.exit(fails ? 1 : 0);
