/**
 * P22-T165: reine Logik anklickbarer Artefakte (Web-UI). Aufruf: node --experimental-strip-types packages/web-ui/tests/artefakt-verweise-p22-t165.test.mjs
 * Verweis-Muster (data-synapse-verweis, href #verweis:, art:id fuer alle Arten des Lesefensters), Projekt-Vorrang, Zustand ueber Revisionen.
 */
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const L = await import(pathToFileURL(join(hier, '..', 'src', 'kios', 'verweis-klick-logik.ts')).href);
let fails = 0;
const check = (ok, name, info) => { if (ok) console.log('OK   ' + name); else { fails++; console.log('FAIL ' + name + (info !== undefined ? ' ' + JSON.stringify(info) : '')); } };
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Muster
check(gleich(L.zerlegeVerweisWert('P22-T153'), { art: 'task', id: 'P22-T153' }) && gleich(L.zerlegeVerweisWert('p22-t5'), { art: 'task', id: 'P22-T5' }), 'Task-Kurz-ID (auch klein)');
check(gleich(L.zerlegeVerweisWert('P22'), { art: 'plan', id: 'P22' }) && gleich(L.zerlegeVerweisWert('#verweis:P3'), { art: 'plan', id: 'P3' }), 'Plan-Kurz-ID, auch als href #verweis:');
const arten = ['thought', 'memory', 'task', 'plan', 'doc', 'event', 'nachricht', 'chat', 'asset'];
check(gleich(L.VERWEIS_ARTEN, arten) && arten.every((art) => gleich(L.zerlegeVerweisWert(art + ':x-1'), { art, id: 'x-1' })), 'art:id fuer alle Arten des Lesefensters');
check(gleich(L.zerlegeVerweisWert('thought:ba4ebbc0-f40c-49c9-b5a5-25fd5e38a2f9'), { art: 'thought', id: 'ba4ebbc0-f40c-49c9-b5a5-25fd5e38a2f9' })
  && gleich(L.zerlegeVerweisWert('MEMORY:regel-x'), { art: 'memory', id: 'regel-x' }) && gleich(L.zerlegeVerweisWert('task:p1-t2'), { art: 'task', id: 'P1-T2' }), 'art:-Praefix: Gross/klein, UUID bleibt, Kurz-ID gross');
check(gleich(L.zerlegeVerweisWert('asset:ui/a:b.png'), { art: 'asset', id: 'ui/a:b.png' }) && gleich(L.zerlegeVerweisWert('#verweis:memory%3Aregel%20x'), { art: 'memory', id: 'regel x' }), 'Doppelpunkt im Wert, URL-kodiertes href');
check(gleich(L.zerlegeVerweisWert('ba4ebbc0'), { art: null, text: 'ba4ebbc0' }) && gleich(L.zerlegeVerweisWert('https://x'), { art: null, text: 'https://x' }), 'freier Wert -> Aufloesung am Server');
check(L.zerlegeVerweisWert('') === null && L.zerlegeVerweisWert('  ') === null && L.zerlegeVerweisWert('thought:') === null && L.zerlegeVerweisWert('x'.repeat(301)) === null && L.zerlegeVerweisWert(null) === null, 'leer/zu lang -> null');

// Element-Attribute
const el = (attrs, vorfahr) => ({ getAttribute: (n) => attrs[n] ?? null, closest: (sel) => (sel === '[data-synapse-projekt]' ? (attrs['data-synapse-projekt'] ? el(attrs) : vorfahr ?? null) : null) });
check(L.verweisWertVon(el({ 'data-synapse-verweis': 'P1-T1', href: '#verweis:P2' })) === 'P1-T1' && L.verweisWertVon(el({ href: '#verweis:P2' })) === '#verweis:P2'
  && L.verweisWertVon(el({ href: 'https://x' })) === null && L.verweisWertVon(el({ 'data-synapse-verweis': ' ' })) === null, 'Wert: data-synapse-verweis vor href, fremde Links nicht');
check(L.verweisProjektVon(el({}, el({ 'data-synapse-projekt': 'synapse' })), 'anders') === 'synapse' && L.verweisProjektVon(el({}), ' ort ') === 'ort' && L.verweisProjektVon(el({}), null) === null,
  'Projekt: data-synapse-projekt (Vorfahr) vor Anzeigeort, sonst null');
check(L.VERWEIS_SELEKTOR.includes('[data-synapse-verweis]') && L.VERWEIS_SELEKTOR.includes('a[href^="#verweis:"]'), 'Selektor');

// Zustand ueber Revisionen (Attrappe statt DOM)
const wurzel = (eingaben, details) => ({ querySelectorAll: (sel) => (sel === 'details' ? details : eingaben) });
const alt = wurzel([{ id: 'r-P1', name: 'plan', value: 'on', type: 'radio', checked: false }, { id: 'r-P2', name: 'plan', value: 'on', type: 'radio', checked: true },
  { id: '', name: 'f', value: 'x', type: 'checkbox', checked: true }], [{ id: 'd1', open: true }, { id: '', open: false }]);
const z = L.merkeZustand(alt);
check(z.geprueft['#r-P2'] === true && z.geprueft['#r-P1'] === false && z.geprueft['checkbox:f=x'] === true && z.offen['#d1'] === true && z.offen['@1'] === false, 'merkeZustand: Schluessel id / name=wert / index', z);
const neuR1 = { id: 'r-P1', name: 'plan', value: 'on', type: 'radio', checked: true }, neuR2 = { id: 'r-P2', name: 'plan', value: 'on', type: 'radio', checked: false };
const neuCb = { id: '', name: 'f', value: 'x', type: 'checkbox', checked: false }, neuD1 = { id: 'd1', open: false }, neuNeu = { id: 'r-P9', name: 'plan', value: 'on', type: 'radio', checked: false };
const n = L.stelleZustandHer(wurzel([neuR1, neuR2, neuCb, neuNeu], [neuD1, { id: '', open: false }]), z);
check(neuR2.checked === true && neuR1.checked === true /* Browser loest die Gruppe, Attrappe nicht */ && neuCb.checked === true && neuD1.open === true && neuNeu.checked === false && n === 3,
  'stelleZustandHer: gewaehltes Radio, Checkbox, details; neue Elemente unberuehrt', { n, neuR2, neuCb, neuD1 });
check(L.eingabeSchluessel({ id: '', name: '', value: '', type: 'radio' }, 4) === 'radio@4', 'Schluessel ohne id/name: Index');

// Verdrahtung (Quelltext): Surface nutzt die Logik, alle vier Orte reichen das Projekt durch, KnowledgeView hat einen Provider.
const src = (p) => readFileSync(join(hier, '..', 'src', p), 'utf8');
const surface = src('kios/AgentRenderingSurface.tsx');
check(/VERWEIS_SELEKTOR/.test(surface) && /useVerweisFenster\(\)/.test(surface) && /leseArtefaktVerweiseAktiv/.test(surface) && /aktivRef\.current !== true\) return/.test(surface)
  && /merkeZustand\(content\)/.test(surface) && /sofort,/.test(surface), 'Surface: Klick nur mit Schalter, Zustand + sofort-Tausch');
check(/updateOhneAnimation=\{!!vorlage\}/.test(src('components/ArtefaktLiveBlock.tsx')) && /verweisProjekt=\{project\}/.test(src('components/EinheitlicherAgentChat.tsx'))
  && /verweisProjekt=\{e\.project \?\? e\.standard_project \?\? project\}/.test(src('components/TopArtefakte.tsx'))
  && /<VerweisFensterProvider><PersonalArtifacts \/><\/VerweisFensterProvider>/.test(src('components/KnowledgeView.tsx'))
  && /<NativeHtmlMessage message=\{message\} project=\{project\}/.test(src('components/SynapseWorkspaceMock.tsx')), 'Koordinator-Fenster, Main-Chat, Persoenliche und Top-Artefakte verdrahtet');
check(/sofort\?: boolean/.test(src('kios/fakeStream.ts')) && /reducedMotion \|\| options\.sofort/.test(src('kios/fakeStream.ts')), 'fakeStream: sofort ohne Animation');

console.log(fails ? `FEHLER: ${fails}` : 'Alle Pruefungen gruen');
process.exit(fails ? 1 : 0);
