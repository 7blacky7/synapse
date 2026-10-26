// @testlauf pool
/** P25-T19: Selbsttest scripts/lib/ki-browser-isolation.mjs ohne echten KI-Browser (simuliertes Profil: EIN Storage je Origin
 * ueber alle Tabs, Seite laedt erst nach einem Schritt). Befunde: P25-T16 66e8db66 (localStorage ueber Laeufe), claude-linde
 * 80a6df42 (Zeitzone je Lauf anders, Ursache /tabs/new ohne identity = zufaellige Stealth-Identitaet).
 * Dazu statisch: jeder KI-Browser-Test des Laeufers (art=browser) oeffnet Tabs nur ueber isolierterTab.
 *   node packages/rest-api/tests/kb-isolation-p25-t19.test.mjs */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateWert, isolierterTab, istTestOrigin, STORAGE_LEEREN_SKRIPT, storageSetzenSkript, TEST_IDENTITAET, TEST_ZEITZONE } from '../../../scripts/lib/ki-browser-isolation.mjs';
import { findeTests } from '../../../scripts/lib/testlauf/finden.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
let checks = 0;
const ok = (b, label, info) => { checks++; assert.ok(b, 'P25-T19 ' + label + (info === undefined ? '' : ' | ' + JSON.stringify(info).slice(0, 400))); };

/** Simulierter KI-Browser: storage[origin] = {local:Map, session:Map}; ein neuer Tab steht erst auf about:blank. */
function simBrowser({ zeitzone = TEST_ZEITZONE, ladeSchritte = 1, nieGeladen = false } = {}) {
  const storage = new Map();
  const tabs = new Map();
  const aufrufe = [];
  let n = 0;
  const st = (o) => { if (!storage.has(o)) storage.set(o, { local: new Map(), session: new Map() }); return storage.get(o); };
  const kb = async (path, body) => {
    aufrufe.push({ path, body: structuredClone(body) });
    if (path === '/tabs/new') { const id = 't' + (++n); tabs.set(id, { url: body.url ?? 'about:blank', schritte: nieGeladen ? Infinity : ladeSchritte }); return { tab_id: id, url: body.url ?? 'about:blank', identity: body.identity ?? { timezone: 'Pacific/Fiji' } }; }
    if (path === '/navigate') { tabs.get(body.tab_id).url = body.url; return { url: body.url }; }
    if (path === '/evaluate') {
      const t = tabs.get(body.tab_id);
      const setzen = /^\(\(\)=>\{const v=(.*);for\(const \[k,w\]/.exec(body.script);
      if (setzen) { const v = JSON.parse(setzen[1]); const s = st(new URL(t.url).origin); for (const [k, w] of Object.entries(v)) s.local.set(k, String(w)); return { result: { result: Object.keys(v).length } }; }
      assert.equal(body.script, STORAGE_LEEREN_SKRIPT);
      const geladen = t.schritte-- <= 0;
      const origin = geladen && t.url !== 'about:blank' ? new URL(t.url).origin : 'null';
      if (origin === 'null') return { result: { result: JSON.stringify({ origin, local: -1, session: -1, zeitzone, sprache: 'de-DE' }) } };
      const s = st(origin); const r = { origin, local: s.local.size, session: s.session.size, zeitzone, sprache: 'de-DE' };
      s.local.clear(); s.session.clear();
      // wie der echte KI-Browser: JSON-Text kommt bereits geparst zurueck
      return { result: { result: r } };
    }
    throw new Error('unerwarteter Pfad ' + path);
  };
  return { kb, storage: st, aufrufe };
}

const UI = 'http://192.168.50.10:41234';
const zeilen = [];
const log = (z) => zeilen.push(z);

// 1) Test-Origin mit gemerktem Zustand: feste Identitaet, leeren, neu laden
{
  const b = simBrowser({ ladeSchritte: 2 });
  b.storage(UI).local.set('synapse-artefakt-zustand:artefakt:a', '{"geprueft":{"#r-P2":true}}');
  b.storage(UI).local.set('x', '1'); b.storage(UI).session.set('y', '2');
  const t = await isolierterTab(b.kb, { url: UI + '/tests/seite.html?theme=dark' }, { env: {}, log });
  const neu = b.aufrufe.find((a) => a.path === '/tabs/new');
  ok(JSON.stringify(neu.body.identity) === JSON.stringify(TEST_IDENTITAET), 'isolierterTab: /tabs/new mit fester Test-Identitaet', neu.body);
  ok(TEST_IDENTITAET.timezone === 'Europe/Berlin', 'TEST_IDENTITAET: Zeitzone Europe/Berlin');
  ok(b.aufrufe.filter((a) => a.path === '/evaluate').length === 3, 'isolierterTab: wartet, bis das Dokument zum Ziel-Origin gehoert', b.aufrufe.map((a) => a.path));
  ok(b.storage(UI).local.size === 0 && b.storage(UI).session.size === 0, 'isolierterTab: localStorage und sessionStorage des Test-Origins leer');
  const nav = b.aufrufe.filter((a) => a.path === '/navigate');
  ok(nav.length === 1 && nav[0].body.url === UI + '/tests/seite.html?theme=dark' && nav[0].body.tab_id === t.tab_id, 'isolierterTab: Ziel-URL nach dem Leeren neu geladen', nav);
  ok(t.isolation.geleert === 3 && t.isolation.neu_geladen === true && t.isolation.zeitzone === 'Europe/Berlin', 'isolierterTab: Rueckgabe isolation', t.isolation);
  ok(zeilen.at(-1) === `KI_BROWSER_ISOLATION tab=${t.tab_id} origin=${UI} geleert=3 neu_geladen=1 zeitzone=Europe/Berlin sprache=de-DE`, 'Debugzeile je Tab', zeilen.at(-1));
}

// 2) Test-Origin ohne Zustand: kein Neuladen
{
  const b = simBrowser();
  const t = await isolierterTab(b.kb, { url: 'http://127.0.0.1:5173/x.html' }, { env: {}, log });
  ok(!b.aufrufe.some((a) => a.path === '/navigate') && t.isolation.geleert === 0, 'leerer Storage: kein Neuladen', b.aufrufe.map((a) => a.path));
}

// 3) Fremder Origin (z. B. Live-UI): nie leeren
{
  const b = simBrowser();
  const live = 'http://192.168.50.65:8080';
  b.storage(live).local.set('nutzer', 'bleibt');
  const t = await isolierterTab(b.kb, { url: live + '/' }, { env: {}, log });
  ok(!b.aufrufe.some((a) => a.path === '/evaluate') && b.storage(live).local.get('nutzer') === 'bleibt', 'fremder Origin: Storage unberuehrt', b.aufrufe.map((a) => a.path));
  ok(t.isolation.grund === 'fremder_origin' && /grund=fremder_origin$/.test(zeilen.at(-1)), 'fremder Origin: grund in Rueckgabe und Debugzeile', zeilen.at(-1));
  ok(JSON.stringify(b.aufrufe[0].body.identity) === JSON.stringify(TEST_IDENTITAET), 'fremder Origin: Zeitzone trotzdem fest', b.aufrufe[0].body);
}

// 4) Schalter KI_BROWSER_ISOLATION=0: /tabs/new unveraendert
{
  const b = simBrowser();
  b.storage(UI).local.set('k', 'v');
  await isolierterTab(b.kb, { url: UI + '/a.html', active: false }, { env: { KI_BROWSER_ISOLATION: '0' }, log });
  ok(b.aufrufe.length === 1 && !('identity' in b.aufrufe[0].body) && b.aufrufe[0].body.active === false, 'Schalter aus: nur /tabs/new ohne identity', b.aufrufe);
  ok(b.storage(UI).local.size === 1 && /aus=1$/.test(zeilen.at(-1)), 'Schalter aus: nichts geleert, Debugzeile aus=1', zeilen.at(-1));
}

// 5) eigene identity des Tests bleibt; KI_BROWSER_IDENTITAET ersetzt die Standard-Identitaet
{
  const b = simBrowser();
  await isolierterTab(b.kb, { url: UI + '/a.html', identity: 'consistent:abc' }, { env: {}, log });
  ok(b.aufrufe[0].body.identity === 'consistent:abc', 'eigene identity des Tests bleibt');
  const c = simBrowser();
  await isolierterTab(c.kb, { url: UI + '/a.html' }, { env: { KI_BROWSER_IDENTITAET: '{"timezone":"UTC"}' }, log });
  ok(c.aufrufe[0].body.identity.timezone === 'UTC', 'KI_BROWSER_IDENTITAET ersetzt die Standard-Identitaet', c.aufrufe[0].body);
}

// 6) Zeitzone weicht ab -> Warnung
{
  const b = simBrowser({ zeitzone: 'Asia/Tokyo' });
  await isolierterTab(b.kb, { url: UI + '/a.html' }, { env: {}, log });
  ok(/^KI_BROWSER_ISOLATION_WARNUNG tab=t1 grund=zeitzone_abweichend soll=Europe\/Berlin ist=Asia\/Tokyo$/.test(zeilen.at(-1)), 'abweichende Zeitzone: Warnzeile', zeilen.at(-1));
}

// 7) Seite erreicht den Origin nie: kein Neuladen, grund
{
  const b = simBrowser({ nieGeladen: true });
  const t = await isolierterTab(b.kb, { url: UI + '/a.html' }, { env: {}, log, warteMs: 300 });
  ok(t.isolation.grund === 'origin_nicht_erreicht' && !b.aufrufe.some((a) => a.path === '/navigate'), 'Origin nicht erreicht: grund, kein Neuladen', t.isolation);
}

// 7b) opt.storage: nach dem Leeren gezielt setzen und neu laden (t149 erklaerungen.v1); opt.leeren=false laesst alles stehen (t169)
{
  const b = simBrowser();
  b.storage(UI).local.set('alt', 'weg');
  const t = await isolierterTab(b.kb, { url: UI + '/netz.html' }, { env: {}, log, storage: { 'synapse.agentennetzwerk.erklaerungen.v1': '1' } });
  ok(b.storage(UI).local.get('synapse.agentennetzwerk.erklaerungen.v1') === '1' && !b.storage(UI).local.has('alt'), 'storage: Altes geleert, Vorgabe gesetzt', [...b.storage(UI).local]);
  ok(t.isolation.vorgabe === 1 && t.isolation.neu_geladen === true && b.aufrufe.filter((a) => a.path === '/navigate').length === 1, 'storage: einmal neu geladen', t.isolation);
  ok(/ geleert=1 vorgabe=1 neu_geladen=1 /.test(zeilen.at(-1)), 'storage: Debugzeile mit vorgabe', zeilen.at(-1));
  ok(storageSetzenSkript({ a: 1 }).includes('{"a":1}'), 'storageSetzenSkript: Werte als JSON');
  const c = simBrowser();
  c.storage(UI).local.set('synapse-artefakt-zustand:artefakt:x', '{"geprueft":{"#r-P2":true}}');
  await isolierterTab(c.kb, { url: UI + '/a.html' }, { env: {}, log, leeren: false });
  ok(c.storage(UI).local.size === 1 && !c.aufrufe.some((a) => a.path === '/evaluate') && /grund=abgeschaltet$/.test(zeilen.at(-1)), 'leeren:false: gemerkter Zustand bleibt (Neuladen-Probe)', zeilen.at(-1));
}

// 8) Hilfsfunktionen
ok(evaluateWert({ result: { result: '{"a":1}' } }).a === 1 && evaluateWert({ result: { result: { a: 2 } } }).a === 2 && evaluateWert({ result: { result: true } }) === true, 'evaluateWert: JSON-Text und Objekt');
ok(istTestOrigin('http://127.0.0.1:1/x') && istTestOrigin('http://localhost:2/') && istTestOrigin(UI + '/t') && istTestOrigin('http://[::1]:3/'), 'istTestOrigin: lokale Test-Server');
ok(!istTestOrigin('http://192.168.50.65:8080/') && !istTestOrigin('about:blank') && !istTestOrigin('file:///tmp/x.html') && !istTestOrigin('kaputt'), 'istTestOrigin: Live-UI, about:blank, file, Unsinn nicht');

// 9) Alle KI-Browser-Tests des Laeufers oeffnen Tabs nur ueber isolierterTab.
// Ausnahme main-synapse-p22-t2: dort bedient ein Agent den Browser per Prompt (curl im Prompttext), der Test oeffnet selbst keinen Tab.
const AUSNAHMEN = new Set(['packages/rest-api/tests/main-synapse-p22-t2.test.mjs']);
const browserTests = findeTests(repo).filter((t) => t.art === 'browser' && !AUSNAHMEN.has(t.datei));
ok(browserTests.length >= 20, 'Laeufer findet die KI-Browser-Tests', browserTests.length);
const ohne = browserTests.filter((t) => {
  const text = readFileSync(join(repo, t.datei), 'utf8');
  return /\(\s*['"]\/tabs\/new['"]/.test(text) || !/isolierterTab\(/.test(text);
}).map((t) => t.datei);
ok(ohne.length === 0, 'jeder KI-Browser-Test oeffnet Tabs ueber isolierterTab (kein direktes /tabs/new)', ohne);

console.log(`P25-T19 KI-Browser-Isolation: ${checks} Pruefungen gruen`);
