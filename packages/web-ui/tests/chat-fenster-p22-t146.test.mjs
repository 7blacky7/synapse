/**
 * P22-T146: Chatfenster ohne Neuladen. Reine Fensterlogik (chat-fenster-logik), Sitzungsspeicher (chat-fenster-speicher) und das
 * Koordinator-Fenster (EinheitlicherAgentChat) als Probe mit Hook-/API-Attrappen. Keine DB, kein Netz.
 *   node --experimental-strip-types packages/web-ui/tests/chat-fenster-p22-t146.test.mjs
 * A Erstladen; B Abgleich (nichts Neues = derselbe Stand, an Ort und Stelle, kein Rueckschritt); C Luecke; D Fenster 50 (gleiten,
 * hochgescrollt kein Gleiten, fest); E Inbox; F Ladegrenze/Quellen; G Speicher bis Logout + Ladetiefe; H Komponente (Erstladen 50,
 * Takt nur seit_rev/ab_id, kein Schreiben ohne Neues, Gleiten, Aendern an Ort und Stelle, Tool-Karte gebuendelt, Wiederoeffnen aus dem
 * Speicher, Aeltere per vor_id + fest, F5 stellt die Ladetiefe her, Logout leert); I Einbau Main/App.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lade = (p) => import(pathToFileURL(join(repo, p)).href);
const F = await lade('packages/web-ui/src/components/chat-fenster-logik.ts');
const SP = await lade('packages/web-ui/src/components/chat-fenster-speicher.ts');
const L = await lade('packages/web-ui/src/components/agent-chat-logik.ts');
const B = await lade('packages/web-ui/src/components/artefakt-bewertung-logik.ts');
const lies = (p) => readFileSync(join(repo, p), 'utf8');

const zeit = (i) => new Date(Date.UTC(2026, 9, 25, 10, 0, 0) + i * 1000).toISOString();
const e = (id, x = {}) => ({ id: String(id), rolle: id % 2 ? 'user' : 'agent', richtung: id % 2 ? 'ein' : 'aus', weg: 'webui', text: 'Text ' + id,
  status: 'fertig', absender: null, gehoert_zu: null, quelle_ref: null, antwort_auf: null, werkzeuge: { calls: [], phasen: [] }, hinweise: [], modell: null,
  zug: null, tokens: {}, kontext: null, artefakte: [], anhaenge: [], meta: {}, rev: String(id), erstellt_am: zeit(id), aktualisiert_am: zeit(id), ...x });
const seite = (ids, x = {}) => ({ verfuegbar: true, identity_id: 'x', eintraege: ids.map((i) => e(i)), mehr: false,
  max_rev: String(Math.max(0, ...ids)), geleert_rev: '0', tool_karten: { aktiv: false }, ...x });
const bereich = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const ib = (id, x = {}) => ({ id, richtung: 'aus', von: 'koordinator', an: 'user', text: 'Inbox ' + id, erstellt_am: zeit(id), ...x });

// A Erstladen: juengste 50
const s = F.uebernimmVerlaufSeite(F.leererStand(), seite(bereich(51, 100), { mehr: true }));
assert.equal(s.verlauf.size, 50); assert.equal(s.verlaufAelteste, '51'); assert.equal(s.verlaufMehr, true);
assert.equal(s.maxRev, '100'); assert.equal(s.verlaufGeladen, true); assert.equal(s.geleertRev, '0');
assert.equal(F.uebernimmVerlaufSeite(s, { ...seite([]), verfuegbar: false }), s, 'nicht verfuegbar -> Stand bleibt');
console.log('OK A Erstladen');

// B Abgleich
assert.equal(F.uebernimmVerlaufAbgleich(s, seite([100], { max_rev: '100' })).stand, s, 'Abgleich ohne Neues -> derselbe Stand (kein Neuzeichnen)');
assert.equal(F.uebernimmVerlaufAbgleich(s, seite([], { max_rev: '100' })).stand, s);
const s2 = F.uebernimmVerlaufAbgleich(s, { ...seite([]), eintraege: [e(100, { text: 'fertig geworden', status: 'fertig', rev: '102' }), e(101, { rev: '101' })], max_rev: '102' }).stand;
assert.notEqual(s2, s); assert.equal(s2.verlauf.size, 51); assert.equal(s2.verlauf.get('100').text, 'fertig geworden', 'an Ort und Stelle (gleiche id)');
assert.equal(s2.maxRev, '102'); assert.equal(s.verlauf.get('100').text, 'Text 100', 'alter Stand bleibt unveraendert');
assert.equal(s2.verlauf.get('99'), s.verlauf.get('99'), 'unveraenderte Eintraege behalten ihr Objekt');
assert.equal(F.uebernimmVerlaufAbgleich(s2, { ...seite([]), eintraege: [e(100, { text: 'alt', rev: '100' })], max_rev: '102' }).stand, s2, 'aeltere rev ersetzt keine neuere');
assert.equal(F.uebernimmVerlaufAbgleich(s2, seite([10], { max_rev: '102' })).stand, s2, 'unter der aeltesten geladenen id: ignoriert');
console.log('OK B Abgleich');

// C Luecke
assert.equal(F.uebernimmVerlaufAbgleich(s2, seite(bereich(200, 399))).luecke, true, 'Kappung 200 -> Luecke');
assert.equal(F.uebernimmVerlaufAbgleich(s2, seite([], { geleert_rev: '500' })).luecke, true, 'geleert -> Luecke');
const ohne = F.ohneVerlauf(F.fixiere(s2, '60'));
assert.equal(ohne.verlauf.size, 0); assert.equal(ohne.verlaufGeladen, false); assert.equal(ohne.aeltereGeladen, false); assert.equal(ohne.maxRev, '0');
console.log('OK C Luecke');

// D Fenster 50
const msgs = bereich(1, 51).map((i) => ({ id: String(i) }));
const k = (m) => m.id;
let f = F.fensterAusschnitt(msgs, k, { fest: false, anzeigeAb: null, unten: true, bisherAb: null });
assert.equal(f.sichtbar.length, 50); assert.equal(f.ab, '2'); assert.equal(f.versteckt, 1);
f = F.fensterAusschnitt([...msgs, { id: '52' }], k, { fest: false, anzeigeAb: null, unten: true, bisherAb: f.ab });
assert.equal(f.ab, '3', 'neuer Eintrag: der aelteste faellt aus der Ansicht'); assert.equal(f.sichtbar.length, 50);
f = F.fensterAusschnitt([...msgs, { id: '52' }, { id: '53' }], k, { fest: false, anzeigeAb: null, unten: false, bisherAb: '3' });
assert.equal(f.ab, '3', 'hochgescrollt: nichts gleitet'); assert.equal(f.sichtbar.length, 51);
f = F.fensterAusschnitt(msgs, k, { fest: true, anzeigeAb: '1', unten: true, bisherAb: null });
assert.equal(f.sichtbar.length, 51, 'fest ab anzeigeAb');
const kurz = msgs.slice(0, 10);
assert.equal(F.fensterAusschnitt(kurz, k, { fest: false, anzeigeAb: null, unten: true, bisherAb: null }).sichtbar, kurz, 'unter 50: dieselbe Liste');
console.log('OK D Fenster');

// E Inbox
const i1 = F.uebernimmInbox(F.leererStand(), { aktiv: true, nachrichten: bereich(11, 60).map((n) => ib(n)), mehr: true }, 'letzte', 50);
assert.equal(i1.inbox.size, 50); assert.equal(i1.inboxNeueste, 60); assert.equal(i1.inboxAelteste, 11); assert.equal(i1.inboxMehr, true);
assert.equal(F.uebernimmInbox(i1, { aktiv: true, nachrichten: [], mehr: false }, 'ab', 100), i1, 'Inbox ohne Neues -> derselbe Stand');
assert.equal(F.uebernimmInbox(i1, { aktiv: true, nachrichten: [ib(60)], mehr: false }, 'ab', 100), i1, 'bekannte Inbox-Zeile -> derselbe Stand');
const i2 = F.uebernimmInbox(i1, { aktiv: true, nachrichten: [ib(61)], mehr: false }, 'ab', 100);
assert.equal(i2.inbox.size, 51); assert.equal(i2.inboxNeueste, 61); assert.equal(i2.inboxMehr, true, 'ab aendert mehr (aeltere) nicht');
const i3 = F.uebernimmInbox(i2, { aktiv: true, nachrichten: bereich(1, 10).map((n) => ib(n)), mehr: false }, 'vor', 50);
assert.equal(i3.inboxAelteste, 1); assert.equal(i3.inboxMehr, false);
assert.equal(F.uebernimmInbox(F.leererStand(), { aktiv: true, nachrichten: bereich(1, 50).map((n) => ib(n)) }, 'letzte', 50).inboxMehr, true, 'ohne Feld mehr: volle Seite = mehr');
const aus = F.uebernimmInbox(i3, { aktiv: false, nachrichten: [] }, 'ab', 100);
assert.equal(aus.inbox.size, 0); assert.equal(F.uebernimmInbox(aus, { aktiv: false, nachrichten: [] }, 'ab', 100), aus, 'Schalter AUS bleibt derselbe Stand');
console.log('OK E Inbox');

// F Ladegrenze und Quellen: Verlauf ab 51 (mehr), Inbox dichter ab 11 (mehr) -> Grenze = Zeit von Verlauf 51
const beide = F.uebernimmInbox(s, { aktiv: true, nachrichten: bereich(11, 60).map((n) => ib(n)), mehr: true }, 'letzte', 50);
assert.equal(F.ladegrenze(beide), Date.parse(zeit(51)));
const gemischt = [{ id: 'a', zeit: zeit(40) }, { id: 'b', zeit: zeit(51) }, { id: 'c' }];
assert.deepEqual(F.innerhalbGrenze(gemischt, F.ladegrenze(beide)).map((m) => m.id), ['b', 'c'], 'unter der Grenze ausgeblendet, ohne Zeit bleibt');
assert.equal(F.innerhalbGrenze(gemischt, Number.NEGATIVE_INFINITY), gemischt);
assert.deepEqual(F.aeltereQuellen(beide), { verlauf: true, inbox: false }, 'die bindende (juengere) Quelle zuerst');
assert.deepEqual(F.aeltereQuellen(F.leererStand()), { verlauf: false, inbox: false });
assert.equal(F.ladegrenze(F.leererStand()), Number.NEGATIVE_INFINITY);
const fix = F.fixiere(s, '60'); assert.equal(fix.aeltereGeladen, true); assert.equal(F.fixiere(fix, '60'), fix);
console.log('OK F Ladegrenze');

// G Sitzungsspeicher bis Logout, Ladetiefe in sessionStorage (nur ids, keine Inhalte)
const ablage = new Map();
globalThis.sessionStorage = {
  get length() { return ablage.size; }, key: (i) => [...ablage.keys()][i] ?? null,
  getItem: (key) => (ablage.has(key) ? ablage.get(key) : null), setItem: (key, v) => { ablage.set(key, String(v)); }, removeItem: (key) => { ablage.delete(key); },
};
ablage.set('fremd', 'bleibt');
SP.merkeChatFensterStand('A', s);
assert.equal(SP.leseChatFensterStand('A'), s); assert.equal(SP.leseChatFensterStand('B'), null);
SP.merkeChatFensterTiefe('A', { verlaufAelteste: '7', inboxAelteste: 3, anzeigeAb: 'inbox:3' });
assert.deepEqual(SP.leseChatFensterTiefe('A'), { verlaufAelteste: '7', inboxAelteste: 3, anzeigeAb: 'inbox:3' });
assert.ok(!ablage.get('synapse:chat-fenster-tiefe:A').includes('Text'), 'keine Inhalte in sessionStorage');
ablage.set('synapse:chat-fenster-tiefe:kaputt', '{x');
assert.equal(SP.leseChatFensterTiefe('kaputt'), null);
SP.verwirfChatFensterSitzung();
assert.equal(SP.leseChatFensterStand('A'), null); assert.equal(SP.leseChatFensterTiefe('A'), null);
assert.equal(ablage.get('fremd'), 'bleibt', 'nur eigene Schluessel geleert');
let aelteste = 100;
assert.equal(await SP.ladeBisTiefe('40', () => aelteste, async () => { aelteste -= 25; return true; }), 3); assert.equal(aelteste, 25);
assert.equal(await SP.ladeBisTiefe(null, () => 5, async () => true), 0);
assert.equal(await SP.ladeBisTiefe('1', () => 100, async () => false), 1, 'keine weiteren -> Ende');
assert.equal(await SP.ladeBisTiefe('1', () => 100, async () => true, 4), 4, 'Hoechstzahl');
assert.equal(await SP.ladeBisTiefe('1', () => null, async () => true), 0, 'keine aelteren -> nichts');
console.log('OK G Speicher');

// H Komponente mit Hook-/API-Attrappen
const { default: ts } = await import('typescript');
const quelle = lies('packages/web-ui/src/components/EinheitlicherAgentChat.tsx');
const chatJs = ts.transpileModule(quelle, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
let merkZaehler = 0;
const SPspion = { ...SP, merkeChatFensterStand(id, st) { merkZaehler++; SP.merkeChatFensterStand(id, st); } };
const defer = () => { let res, rej; const promise = new Promise((a, b) => { res = a; rej = b; }); return { promise, resolve: res, reject: rej }; };
function chatProbe() {
  const slots = [], effects = [], timers = new Map(), timeouts = [], verlauf = [], inbox = [];
  let cursor = 0, timerId = 0, karteCb = null;
  const props = { identityId: 'synthetisch-A', name: 'Agent A', project: 'synthetisch', pollMs: 4000 };
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) { const old = slots[i]; effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); }
    },
    useLayoutEffect(fn, deps) { return hooks.useEffect(fn, deps); },
  };
  const api = {
    getAgentVerlauf(id, abfrage) { const d = { ...defer(), abfrage }; verlauf.push(d); return d.promise; },
    getAgentChatInbox(id, o) { const d = { ...defer(), o }; inbox.push(d); return d.promise; },
    sendePlattformAgentChat() { return new Promise(() => {}); },
    abonniereToolKarten(id, cb) { karteCb = cb; return () => { karteCb = null; }; },
  };
  const jsx = (type, p, key) => ({ type, props: p ?? {}, key });
  const modules = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, '../api/agent-runtime': api,
    './ChatEingabefeld': { ChatEingabefeld: 'ChatEingabefeld' }, './Lesefenster': { VerweisFensterProvider: 'Provider', KlartextText: 'KlartextText' },
    '../kios/AgentRenderingSurface': { default: 'AgentRenderingSurface' },
    './ArtefaktBewertung': { ArtefaktBewertung: 'ArtefaktBewertung', useArtefaktBewertungen: () => ({ aktiv: false, je: {}, setze() {} }) },
    // P22-T154: Artefakt-Baustein des Koordinator-Fensters als Attrappe.
    './ArtefaktLiveBlock': { ArtefaktLiveBlock: 'ArtefaktLiveBlock' },
    './artefakt-bewertung-logik': B, './agent-chat-teile': { ToolActivity: 'ToolActivity' }, './agent-chat-logik': L,
    './chat-fenster-logik': F, './chat-fenster-speicher': SPspion,
  };
  const window = {
    setInterval(fn) { timers.set(++timerId, fn); return timerId; }, clearInterval(id) { timers.delete(id); },
    setTimeout(fn) { timeouts.push(fn); return timeouts.length; }, clearTimeout() {},
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', chatJs)((p) => {
    if (p.endsWith('.css')) return {};
    assert.ok(p in modules, 'Unbekannte Abhaengigkeit: ' + p);
    return modules[p];
  }, module, module.exports, window);
  const render = () => { cursor = 0; const tree = module.exports.EinheitlicherAgentChat(props); while (effects.length) effects.shift()(); return tree; };
  return {
    render, verlauf, inbox, timeouts,
    tick() { for (const fn of [...timers.values()]) fn(); },
    karte() { karteCb?.({ id: 'k1' }); },
    get abonniert() { return karteCb !== null; },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
}
const alleKnoten = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const child of [tree?.props?.children].flat(Infinity)) if (child && typeof child === 'object') alleKnoten(child, pred, aus);
  return aus;
};
const wurzel = (tree) => alleKnoten(tree, (n) => n.type === 'section')[0].props;
const ids = (tree) => alleKnoten(tree, (n) => n.props && 'data-nachricht' in n.props).map((n) => n.props['data-nachricht']);
const knopf = (tree, text) => alleKnoten(tree, (n) => n.type === 'button' && [n.props.children].flat().join('').includes(text))[0];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

SP.verwirfChatFensterSitzung();
const p = chatProbe();
let tree = p.render();
assert.deepEqual(p.verlauf[0].abfrage, { limit: 50 }, 'H Erstladen Verlauf: die juengsten 50');
assert.deepEqual(p.inbox[0].o, { limit: 50 }, 'H Erstladen Inbox: die juengsten 50');
p.verlauf[0].resolve(seite(bereich(2, 51), { mehr: true, tool_karten: { aktiv: true } }));
p.inbox[0].resolve({ aktiv: true, nachrichten: [ib(1000, { erstellt_am: zeit(30) })], mehr: false });
await flush(); tree = p.render();
assert.equal(wurzel(tree)['data-eintraege'], 50); assert.equal(wurzel(tree)['data-anzahl'], '50/51', 'H Fenster zeigt die juengsten 50 von 51 (Verlauf + Inbox gemischt)');
assert.equal(wurzel(tree)['data-fenster'], 'gleitend'); assert.ok(knopf(tree, 'Ältere Beiträge anzeigen'), 'H Knopf oben vorhanden');
assert.ok(ids(tree).includes('inbox:1000') && !ids(tree).includes('2'), 'H Inbox eingemischt, aeltester ausserhalb');

// Takt: nur Neues; ohne Neues wird der Stand nicht geschrieben
p.tick();
assert.deepEqual(p.verlauf[1].abfrage, { seit_rev: '51', ab_id: '2' }, 'H Takt fragt nur seit_rev/ab_id');
assert.deepEqual(p.inbox[1].o, { ab_id: 1000, limit: 100 }, 'H Takt fragt Inbox nur ab_id');
const vorher = merkZaehler;
p.verlauf[1].resolve(seite([51], { tool_karten: { aktiv: true } }));
p.inbox[1].resolve({ aktiv: true, nachrichten: [], mehr: false });
await flush();
assert.equal(merkZaehler, vorher, 'H Takt ohne Neues schreibt keinen Stand (kein Komplett-Ersatz)');

// Neuer Eintrag: angehaengt, Fenster gleitet
p.tick();
p.verlauf[2].resolve(seite([52], { tool_karten: { aktiv: true } }));
p.inbox[2].resolve({ aktiv: true, nachrichten: [], mehr: false });
await flush(); tree = p.render();
assert.equal(wurzel(tree)['data-anzahl'], '50/52'); assert.equal(ids(tree).at(-1), '52'); assert.ok(!ids(tree).includes('3'), 'H gleitendes Fenster');
// Geaendert an Ort und Stelle (gleiche id)
p.tick();
p.verlauf[3].resolve({ ...seite([]), eintraege: [e(52, { text: 'geändert', rev: '53' })], max_rev: '53', tool_karten: { aktiv: true } });
p.inbox[3].resolve({ aktiv: true, nachrichten: [], mehr: false });
await flush(); tree = p.render();
assert.equal(wurzel(tree)['data-eintraege'], 51); assert.ok(JSON.stringify(tree).includes('geändert')); assert.equal(ids(tree).at(-1), '52');
// Tool-Karten-SSE: gebuendelt EIN Abgleich, kein Erstladen
assert.ok(p.abonniert, 'H Karten-SSE abonniert'); const vorKarte = p.verlauf.length;
p.karte(); p.karte();
assert.equal(p.timeouts.length, 1, 'H zwei Karten -> ein gebuendelter Abgleich'); p.timeouts[0]();
assert.equal(p.verlauf.length, vorKarte + 1); assert.deepEqual(p.verlauf.at(-1).abfrage, { seit_rev: '53', ab_id: '2' }, 'H Karte -> Abgleich statt Komplett-Laden');
p.verlauf.at(-1).resolve(seite([], { max_rev: '53', tool_karten: { aktiv: true } })); await flush();
p.unmount();
console.log('OK H1 Erstladen, Takt, Gleiten, an Ort und Stelle, Tool-Karte');

// Wiedereroeffnen aus dem Sitzungsspeicher: sofort sichtbar, kein Erstladen
const p2 = chatProbe();
tree = p2.render();
assert.equal(wurzel(tree)['data-eintraege'], 51, 'H Fenster wieder offen: Stand sofort da');
assert.deepEqual(p2.verlauf[0].abfrage, { seit_rev: '53', ab_id: '2' }, 'H wieder offen: nur Abgleich');
assert.deepEqual(p2.inbox[0].o, { ab_id: 1000, limit: 100 });
p2.verlauf[0].resolve(seite([], { max_rev: '53', tool_karten: { aktiv: true } })); p2.inbox[0].resolve({ aktiv: true, nachrichten: [], mehr: false }); await flush();
// Aeltere Beitraege anzeigen: lokal ausgeblendete + vor_id, danach fest
const klick = knopf(p2.render(), 'Ältere Beiträge anzeigen').props.onClick();
await flush();
assert.deepEqual(p2.verlauf[1].abfrage, { limit: 50, vor_id: '2' }, 'H Aeltere per vor_id');
p2.verlauf[1].resolve(seite([1], { mehr: false, max_rev: '53', tool_karten: { aktiv: true } }));
await klick; await flush(); tree = p2.render();
assert.equal(wurzel(tree)['data-fenster'], 'fest'); assert.equal(wurzel(tree)['data-anzahl'], '53/53', 'H alles Nachgeladene sichtbar');
assert.ok(!knopf(tree, 'Ältere Beiträge anzeigen') && knopf(tree, 'Anfang') === undefined && JSON.stringify(tree).includes('Anfang des Verlaufs'));
assert.deepEqual(SP.leseChatFensterTiefe('synthetisch-A'), { verlaufAelteste: '1', inboxAelteste: 1000, anzeigeAb: '1' }, 'H Ladetiefe gemerkt');
p2.tick();
p2.verlauf[2].resolve(seite([60], { max_rev: '60', tool_karten: { aktiv: true } })); p2.inbox[1].resolve({ aktiv: true, nachrichten: [], mehr: false });
await flush(); tree = p2.render();
assert.equal(wurzel(tree)['data-anzahl'], '54/54', 'H nach Aeltere: kein Gleiten mehr');
p2.unmount();
console.log('OK H2 Wiedereroeffnen aus dem Speicher, Aeltere per vor_id, fest');

// F5 (Variante B): Inhalte weg, Ladetiefe bleibt -> Erstladen 50, dann bis zur Tiefe nachladen, fest
const tiefe = ablage.get('synapse:chat-fenster-tiefe:synthetisch-A');
SP.verwirfChatFensterSitzung(); ablage.set('synapse:chat-fenster-tiefe:synthetisch-A', tiefe);
merkZaehler = 0;
const p3 = chatProbe();
p3.render();
assert.deepEqual(p3.verlauf[0].abfrage, { limit: 50 }, 'H F5: Erstladen');
p3.verlauf[0].resolve(seite(bereich(11, 60), { mehr: true })); p3.inbox[0].resolve({ aktiv: true, nachrichten: [], mehr: false });
await flush();
assert.deepEqual(p3.verlauf[1]?.abfrage, { limit: 50, vor_id: '11' }, 'H F5: bis zur Ladetiefe per vor_id');
p3.verlauf[1].resolve(seite(bereich(1, 10), { mehr: false })); await flush(); tree = p3.render();
assert.equal(wurzel(tree)['data-eintraege'], 60); assert.equal(wurzel(tree)['data-fenster'], 'fest', 'H F5: Tiefe wiederhergestellt, fest');
p3.unmount();
// Logout: alles verworfen -> wieder Erstladen, gleitend
SP.verwirfChatFensterSitzung();
const p4 = chatProbe(); tree = p4.render();
assert.deepEqual(p4.verlauf[0].abfrage, { limit: 50 }); assert.equal(wurzel(tree)['data-eintraege'], 0); assert.equal(wurzel(tree)['data-fenster'], 'gleitend');
p4.verlauf[0].resolve(seite(bereich(11, 60), { mehr: true })); p4.inbox[0].resolve({ aktiv: true, nachrichten: [], mehr: false }); await flush();
assert.equal(p4.verlauf.length, 1, 'H nach Logout keine Ladetiefe mehr'); p4.unmount();
assert.ok(!/limit: 60/.test(quelle) && !/limit: 40/.test(quelle) && !/setEintraege\(/.test(quelle), 'H alter Komplett-Abruf entfernt');
console.log('OK H3 F5 stellt Ladetiefe her, Logout leert');

// I Einbau: App leert bei Login-Ansicht, Main nutzt denselben Fensterbaustein
assert.match(lies('packages/web-ui/src/App.tsx'), /if \(authState === 'login'\) verwirfChatFensterSitzung\(\);/);
const main = lies('packages/web-ui/src/components/SynapseWorkspaceMock.tsx');
assert.match(main, /fensterAusschnitt\(alleMessages, \(message\) => String\(message\.id\)/);
assert.match(main, /\{verlauf\.mehr \|\| fenster\.versteckt > 0/);
assert.match(main, /setFensterFest\(true\);\n\s+uebernehmeVerlauf\(r\.eintraege\);/);
console.log('OK I Einbau Main/App');
console.log('P22-T146 Web-UI: alle Pruefungen bestanden');
