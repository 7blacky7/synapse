/**
 * P22-T170: Herkunft des Lesefensters steuert Pin/Zitat - Web-UI ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/lesefenster-herkunft-p22-t170.test.mjs
 * A reine Logik (Herkunft aus dem Entwurfs-Schluessel, Pin-Kaertchen, Empfaenger-Filter/Auswahl, Speicher behaelt pin);
 * B useZitatAnhaenge: Herkunft je Chat (agent/main/channel), pinAnfuegen legt das Kaertchen in DIESEN Entwurf, Senden enthaelt es;
 * C useUserEntscheidung: nachAnpinnen nur mit Herkunft, Meldung mit Zusatz;
 * D useZitatEmpfaengerAuswahl: Schalter, Knopf, Liste, Filter behaelt Auswahl, genau 3 sichtbar, Senden an 2 Empfaenger, Fehler
 *   (angepasst P22-T171: Eingabefeld mit Vorschlagsliste statt Checkboxen, hoechstens 3 sichtbar; Details in pin-empfaenger-p22-t171);
 * E Einbau (Lesefenster, Main-Dashboard und Channel-Projektflaeche ohne Herkunft, Channel-Fenster mit Zitaten, Artefakttafel unveraendert).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const ZL = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/zitat-logik.ts')).href);
const { default: ts } = await import('typescript');
let n = 0;
const ok = (wert, label, info) => { assert.ok(wert, label + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 600) : '')); n++; };
const gleich = (ist, soll, label) => { assert.deepStrictEqual(ist, soll, label); n++; };

const transpile = (p) => ts.transpileModule(lies(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const alle = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const c of [tree?.props?.children].flat(Infinity)) if (c && typeof c === 'object') alle(c, pred, aus);
  return aus;
};
const text = (t) => (Array.isArray(t) ? t.map(text).join('') : t === null || t === undefined || typeof t === 'boolean' ? ''
  : typeof t === 'object' ? text(t.props?.children) : String(t));
const knopf = (tree, t) => alle(tree, (x) => x.type === 'button' && text(x).startsWith(t))[0];
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function reactAttrappe() {
  const slots = [], effects = [];
  let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { wert: fn(), deps }; return slots[i].wert; },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) { const alt = slots[i]; slots[i] = { deps }; effects.push(() => { alt?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); }
    },
  };
  return { react, start: () => { cursor = 0; }, effekte: () => { while (effects.length) effects.shift()(); } };
}

function lade(js, modules, globals = {}) {
  const module = { exports: {} };
  const namen = Object.keys(globals);
  new Function('require', 'module', 'exports', ...namen, js)((x) => {
    if (x.endsWith('.css')) return {};
    assert.ok(x in modules, 'Unbekannte Abhaengigkeit: ' + x);
    return modules[x];
  }, module, module.exports, ...namen.map((k) => globals[k]));
  return module.exports;
}

const ablage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, m };
};
const G = ZL.ZITAT_GRENZEN_STANDARD;
const THOUGHT = 'abcdef12-0000-4000-8000-000000000001';

// ---------------------------------------------------------------- A reine Logik
{
  gleich(['main', 'agent:1234', 'channel:p:team', 'x'].map(ZL.herkunftAusChat), ['main', 'agent', 'channel', 'agent'], 'A Herkunft aus dem Entwurfs-Schluessel');
  const v = ZL.pinVorlage({ thoughtId: THOUGHT, projekt: 'p', kopf: 'Task P1-T2', titel: 'Zweite Aufgabe', text: 'x'.repeat(700) }, 600);
  // (angepasst P22-T171 Punkt 5: pin = Bezug, Titel = Titel des Bezugs; der Block nennt 'Angepinnte User-Entscheidung an <Bezug>')
  ok(v.art === 'thought' && v.id === THOUGHT && v.pin === 'Task P1-T2' && v.projekt === 'p', 'A Pin = Zitat art thought mit thought-ID', v);
  ok(v.titel === 'Zweite Aufgabe' && ZL.zitatKopf(v) === 'Angepinnte User-Entscheidung an Task P1-T2', 'A Pin-Kopf nennt Task, Titel des Bezugs', [v.titel, ZL.zitatKopf(v)]);
  ok(v.ausschnitt.length === 600 && v.ausschnitt.endsWith('…'), 'A Wortlaut als Ausschnitt, auf ausschnitt_max gekuerzt');
  const r = ZL.fuegeZitatHinzu([], v, '', 10, 'k1', '2026-10-25T21:00:00Z');
  gleich(ZL.zuSendeZitaten(r.liste), [{ art: 'thought', id: THOUGHT, projekt: 'p', titel: v.titel, ausschnitt: v.ausschnitt, anmerkung: '', pin: 'Task P1-T2' }], 'A Pin geht beim Senden wie jedes Zitat (P22-T171: mit pin-Feld)');
  const a = ablage();
  ZL.merkeZitatEntwurf(a, 'channel:p:team', r.liste);
  ok(ZL.leseZitatEntwurf(a, 'channel:p:team')[0]?.pin === 'Task P1-T2', 'A Entwurf im Speicher behaelt das Pin-Kennzeichen (F5)');
  ok(a.m.has(ZL.ZITAT_ENTWURF_PRAEFIX + 'channel:p:team'), 'A Channel-Entwurf unter dem gemeinsamen Praefix (Logout verwirft ihn mit)');
  const liste = [
    { identity_id: 'm', agent_id: 'main', name: 'main', rolle: 'main', project: 'synapse-hauptagent' },
    { identity_id: 'k', agent_id: 'koordinator', name: 'koordinator', rolle: 'koordinator', project: 'p' },
    { identity_id: 'a', agent_id: 'claude-t50', name: 'claude-t50', rolle: 'subagent', project: 'p' },
    { identity_id: 'b', agent_id: 'rea4', name: 'rea4', rolle: 'subagent', project: 'p' },
  ];
  gleich(ZL.filtereZitatEmpfaenger(liste, '').map((e) => e.identity_id), ['m', 'k', 'a', 'b'], 'A ohne Filter alle');
  gleich(ZL.filtereZitatEmpfaenger(liste, ' REA ').map((e) => e.identity_id), ['b'], 'A Filter nach Name, Gross/klein egal');
  gleich(ZL.filtereZitatEmpfaenger(liste, 'koord').map((e) => e.identity_id), ['k'], 'A Filter trifft auch die Rolle');
  gleich(ZL.schalteZitatEmpfaenger(ZL.schalteZitatEmpfaenger(['a'], 'b'), 'a'), ['b'], 'A Auswahl an/aus');
  ok(ZL.zitatEmpfaengerName(liste[0]) === 'Hauptagent' && ZL.zitatEmpfaengerName(liste[3]) === 'rea4', 'A Anzeige: Main als Hauptagent');
  ok(ZL.EMPFAENGER_SICHTBAR === 3, 'A genau 3 Zeilen sichtbar (User 82b61246)');
}

// ---------------------------------------------------------------- B useZitatAnhaenge: Herkunft und Pin
const zaJs = transpile('packages/web-ui/src/components/ZitatAnhaenge.tsx');
function zitatProbe(chat, { aktiv = true, max = G.max_anzahl } = {}) {
  const r = reactAttrappe();
  const a = ablage();
  const debug = [];
  const ZA = lade(zaJs, {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-dom': { createPortal: (k) => ({ type: 'portal', props: { children: k } }) },
    '../api/chat-zitate': { leseChatZitateStand: async () => ({ aktiv, quelle: 'intern', grenzen: { ...G, max_anzahl: max } }) },
    '../api/verweise': { bekannteTreffer: () => undefined },
    './Lesefenster': { findeKandidaten: () => [], useVerweisFenster: () => null },
    './zitat-logik': ZL,
  }, {
    window: { innerWidth: 1200, innerHeight: 800, getSelection: () => null }, document: { querySelector: () => null, body: 'body', addEventListener() {}, removeEventListener() {} },
    localStorage: a, navigator: {}, console: { debug: (...x) => debug.push(x), log: console.log },
  });
  let props = { chat, empfaenger: chat === 'main' ? 'Hauptagent' : chat.startsWith('channel:') ? '#team' : 'koordinator', project: 'p' };
  const render = () => { r.start(); const s = ZA.useZitatAnhaenge(props); r.effekte(); return s; };
  return { render, a, debug };
}
for (const [chat, soll] of [['agent:11111111-0000-4000-8000-000000000001', 'agent'], ['main', 'main'], ['channel:p:team', 'channel']]) {
  const h = zitatProbe(chat);
  let s = h.render(); await flush(); s = h.render();
  ok(s.anbieter?.herkunft === soll && s.debug['data-zitat-herkunft'] === soll, 'B Herkunft ' + soll + ' fuer ' + chat, s.debug);
  const pin = { thoughtId: THOUGHT, projekt: 'p', kopf: 'Task P1-T2', titel: 'Zweite Aufgabe', text: 'Erst pruefen.' };
  ok(s.anbieter.pinAnfuegen(pin) === true, 'B ' + soll + ': pinAnfuegen ok');
  s = h.render();
  ok(s.entwuerfe.length === 1 && s.entwuerfe[0].pin && s.sendeZitate[0].art === 'thought' && s.sendeZitate[0].id === THOUGHT, 'B ' + soll + ': Pin als Kaertchen im Entwurf und im Sendefeld', s.sendeZitate);
  const karte = alle(s.karten, (x) => x.props?.['data-zitat-pin'] !== undefined)[0];
  ok(karte && karte.props['data-zitat-pin'] === THOUGHT && /ist-pin/.test(karte.props.className) && /User-Entscheidung/.test(text(karte)) && /an Task P1-T2/.test(text(karte)), 'B ' + soll + ': Kaertchen als User-Entscheidung gekennzeichnet', text(karte));
  ok(JSON.parse(h.a.getItem(ZL.ZITAT_ENTWURF_PRAEFIX + chat))[0].id === THOUGHT, 'B ' + soll + ': Entwurf genau dieses Chats gespeichert');
  ok(h.debug.some((d) => d[1]?.ergebnis === 'pin_angefuegt' && d[1]?.herkunft === soll), 'B ' + soll + ': Debug pin_angefuegt mit Herkunft');
}
{
  const h = zitatProbe('agent:x', { max: 1 });
  let s = h.render(); await flush(); s = h.render();
  const pin = { thoughtId: THOUGHT, projekt: 'p', kopf: 'Task P1-T2', text: 'a' };
  ok(s.anbieter.pinAnfuegen(pin) === true && s.anbieter.pinAnfuegen({ ...pin, thoughtId: 'zweiter' }) === false, 'B Entwurf voll (max_anzahl): zweiter Pin abgelehnt');
  s = h.render();
  ok(s.entwuerfe.length === 1, 'B voller Entwurf bleibt unveraendert');
}
{
  const h = zitatProbe('agent:x', { aktiv: false });
  let s = h.render(); await flush(); s = h.render();
  ok(s.anbieter === null && s.sendeZitate.length === 0, 'B Schalter AUS: kein Anbieter (keine Herkunft fuer Pins)');
}

// ---------------------------------------------------------------- C useUserEntscheidung: nachAnpinnen
const ueJs = transpile('packages/web-ui/src/components/UserEntscheidung.tsx');
function entscheidungProbe() {
  const r = reactAttrappe();
  const UE = lade(ueJs, {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '../api/chat-zitate': { leseChatZitateStand: async () => ({ aktiv: true, quelle: 'intern', grenzen: G }) },
    '../api/user-entscheidung': {
      leseUserEntscheidungen: async () => ({ aktiv: true, eintraege: [], fehler: null }),
      pinneUserEntscheidung: async (e) => ({ ok: true, thought_id: THOUGHT, task_id: e.id, empfaenger: [] }),
    },
    '../api/verweise': { ART_LABEL: { task: 'Task', plan: 'Plan' } },
  }, { console: { debug() {}, log: console.log } });
  let props = { project: 'p', art: 'task', id: 'P1-T2', anzeigeId: 'P1-T2', titel: 'Zweite Aufgabe', anpinnen: 0 };
  const render = (aenderung = {}) => { props = { ...props, ...aenderung }; r.start(); const s = UE.useUserEntscheidung(props); r.effekte(); return s; };
  return { render };
}
const editorVon = (s) => alle(s.bereich, (x) => x.props?.['data-user-entscheidung-editor'] === '')[0];
for (const mitHerkunft of [true, false]) {
  const h = entscheidungProbe();
  const pins = [];
  const extra = mitHerkunft ? { nachAnpinnen: (p) => { pins.push(p); return 'Als Kärtchen im Entwurf an koordinator.'; } } : {};
  let s = h.render(extra); await flush(); s = h.render(extra);
  ok(/Kärtchen/.test(s.knopf.props.title) === mitHerkunft && /nur speichern/.test(s.knopf.props.title) === !mitHerkunft, 'C Knopf-Titel nennt den Weg (' + (mitHerkunft ? 'mit' : 'ohne') + ' Herkunft)', s.knopf.props.title);
  s.knopf.props.onClick(); s = h.render(extra);
  alle(editorVon(s), (x) => x.type === 'textarea')[0].props.onChange({ target: { value: '  Erst pruefen.  ' } }); s = h.render(extra);
  knopf(editorVon(s), 'Speichern').props.onClick(); await flush(); s = h.render(extra);
  if (mitHerkunft) {
    gleich(pins, [{ thoughtId: THOUGHT, projekt: 'p', kopf: 'Task P1-T2', titel: 'Zweite Aufgabe', text: 'Erst pruefen.' }], 'C mit Herkunft: nachAnpinnen mit thought-ID, Kopf, Titel und Wortlaut');
    ok(/Angepinnt an Task P1-T2\. Als Kärtchen im Entwurf an koordinator\./.test(text(s.bereich)), 'C Meldung nennt das Kaertchen', text(s.bereich));
  } else {
    ok(pins.length === 0 && /Angepinnt an Task P1-T2\.$/.test(text(alle(s.bereich, (x) => x.props?.role === 'status')[0])), 'C ohne Herkunft: nur gespeichert, kein Kaertchen');
  }
}

// ---------------------------------------------------------------- D useZitatEmpfaengerAuswahl
const zeJs = transpile('packages/web-ui/src/components/ZitatEmpfaenger.tsx');
const EMPF = [
  { identity_id: 'm', agent_id: 'main', name: 'main', rolle: 'main', project: 'synapse-hauptagent' },
  { identity_id: 'k', agent_id: 'koordinator', name: 'koordinator', rolle: 'koordinator', project: 'p' },
  { identity_id: 'a', agent_id: 'claude-t50', name: 'claude-t50', rolle: 'subagent', project: 'p' },
  { identity_id: 'b', agent_id: 'rea4', name: 'rea4', rolle: 'subagent', project: 'p' },
];
function auswahlProbe({ aktiv = true, senden } = {}) {
  const r = reactAttrappe();
  const aufrufe = { stand: [], liste: [], senden: [] };
  const ZE = lade(zeJs, {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '../api/chat-zitate': { leseChatZitateStand: async (p) => { aufrufe.stand.push(p); return { aktiv, quelle: 'intern', grenzen: G }; } },
    '../api/zitat-empfaenger': {
      leseZitatEmpfaenger: async (p) => { aufrufe.liste.push(p); return { aktiv: true, empfaenger: EMPF, fehler: null }; },
      sendeZitatInbox: async (e) => { aufrufe.senden.push(e); return senden ? senden(e) : { ok: true, empfaenger: e.empfaenger.map((id) => ({ identity_id: id, agent_id: EMPF.find((x) => x.identity_id === id).agent_id, rolle: 'x', inbox_id: 1, fehler: null })) }; },
    },
    './zitat-logik': ZL,
  }, { console: { debug() {}, log: console.log } });
  let props = { project: 'p', aktiv: true, vorlage: { art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Zweite Aufgabe' } };
  const render = (aenderung = {}) => { props = { ...props, ...aenderung }; r.start(); const s = ZE.useZitatEmpfaengerAuswahl(props); r.effekte(); return s; };
  return { render, aufrufe };
}
const auswahlVon = (s) => alle(s.bereich, (x) => x.props?.['data-zitat-empfaenger-auswahl'] !== undefined)[0];
const zeilen = (s) => alle(auswahlVon(s), (x) => x.type === 'li' && x.props['data-empfaenger']);
// (angepasst P22-T171: Eingabefeld statt Checkboxen - 'box' ist der Vorschlag selbst: Klick = an/aus, aria-selected = gewaehlt;
// die Vorschlaege erscheinen erst nach Klick ins Feld)
const box = (s, agent) => { const z = zeilen(s).find((x) => x.props['data-empfaenger'] === agent); return z && { props: { onChange: () => z.props.onClick(), checked: z.props['aria-selected'] } }; };
const feldAuf = (s) => alle(auswahlVon(s), (x) => x.props?.className === 'zitat-empfaenger-eingabe')[0].props.onClick();
const filterVon = (s) => alle(auswahlVon(s), (x) => x.type === 'input' && x.props.role === 'combobox')[0];
{
  const h = auswahlProbe({ aktiv: false });
  let s = h.render(); await flush(); s = h.render();
  ok(s.knopf === null && h.aufrufe.stand[0] === 'p', 'D Schalter AUS: kein Knopf (Schalter im Projekt des Lesefensters)');
}
{
  const h = auswahlProbe();
  let s = h.render({ aktiv: false }); await flush(); s = h.render();
  ok(s.knopf === null && h.aufrufe.stand.length === 0, 'D mit Chat-Herkunft (aktiv false): keine Auswahl, keine Abfrage');
}
{
  const h = auswahlProbe();
  let s = h.render(); await flush(); s = h.render();
  ok(s.knopf && text(s.knopf) === 'Zitat anfügen' && s.knopf.props['data-zitat-ohne-herkunft'] === '' && s.bereich === null, 'D ohne Herkunft: Knopf Zitat anfügen, Bereich zu');
  s.knopf.props.onClick(); s = h.render(); feldAuf(s); s = h.render(); await flush(); s = h.render();
  ok(h.aufrufe.liste[0] === 'p' && zeilen(s).length === 4, 'D Liste der Agenten des Projekts geladen (inkl. Main und Koordinator)', zeilen(s).map((z) => z.props['data-empfaenger']));
  ok(auswahlVon(s).props['data-zitat-empfaenger-sichtbar'] === 3, 'D Debug: 3 sichtbare Zeilen');
  ok(/Hauptagent/.test(text(auswahlVon(s))) && /koordinator/.test(text(auswahlVon(s))), 'D Main als Hauptagent, Koordinator in der Liste');
  ok(knopf(auswahlVon(s), 'Senden').props.disabled === true, 'D Senden ohne Auswahl gesperrt');
  box(s, 'rea4').props.onChange(); s = h.render();
  filterVon(s).props.onChange({ target: { value: 'koord' } }); s = h.render();
  ok(zeilen(s).length === 1 && zeilen(s)[0].props['data-empfaenger'] === 'koordinator', 'D Filter zeigt nur Treffer');
  box(s, 'koordinator').props.onChange(); s = h.render();
  filterVon(s).props.onChange({ target: { value: '' } }); s = h.render();
  ok(box(s, 'rea4').props.checked === true && box(s, 'koordinator').props.checked === true && box(s, 'main').props.checked === false, 'D Auswahl bleibt beim Filtern erhalten');
  ok(auswahlVon(s).props['data-zitat-empfaenger-auswahl'] === 2 && /2 gewählt: rea4, koordinator/.test(text(auswahlVon(s))), 'D Fusszeile nennt die Gewaehlten', text(auswahlVon(s)));
  alle(auswahlVon(s), (x) => x.type === 'textarea')[0].props.onChange({ target: { value: ' Bitte lesen. ' } }); s = h.render();
  knopf(auswahlVon(s), 'Senden').props.onClick(); await flush(); s = h.render();
  gleich(h.aufrufe.senden, [{ project: 'p', empfaenger: ['b', 'k'], zitate: [{ art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Zweite Aufgabe', anmerkung: 'Bitte lesen.' }] }], 'D Senden: genau die 2 Gewaehlten, ein Zitat mit Anmerkung');
  ok(!auswahlVon(s) && /Zitat gesendet an rea4, koordinator\./.test(text(s.bereich)), 'D Meldung nach dem Senden, Auswahl zu', text(s.bereich));
}
{
  const h = auswahlProbe({ senden: () => ({ ok: false, code: 'funktion_aus', message: 'Zitat-Anhänge sind aus (chat_zitate)' }) });
  let s = h.render(); await flush(); s = h.render();
  s.knopf.props.onClick(); s = h.render(); feldAuf(s); s = h.render(); await flush(); s = h.render();
  box(s, 'main').props.onChange(); s = h.render();
  knopf(auswahlVon(s), 'Senden').props.onClick(); await flush(); s = h.render();
  ok(auswahlVon(s) && /Zitat-Anhänge sind aus/.test(text(auswahlVon(s))) && box(s, 'main').props.checked === true, 'D Fehler bleibt sichtbar, Auswahl bleibt', text(auswahlVon(s)));
}
{
  const css = lies('packages/web-ui/src/chat-zitate.css');
  // (angepasst P22-T171: 'bis zu 3 Optionen' -> max-height statt fester Hoehe)
  ok(/\.zitat-empfaenger-liste\{[^}]*max-height:calc\(var\(--zitat-zeile\) \* 3 \+ 2px\);overflow-y:auto/.test(css) && /\.zitat-empfaenger-liste li\{height:var\(--zitat-zeile\);box-sizing:border-box/.test(css), 'D CSS: hoechstens 3 Zeilen sichtbar, Rest scrollt');
}

// ---------------------------------------------------------------- E Einbau
{
  const lese = lies('packages/web-ui/src/components/Lesefenster.tsx');
  ok(/const zitat = fenster\.ohneHerkunft \? null : anbieter;/.test(lese), 'E Lesefenster: Herkunft ohne -> kein Ziel-Chat');
  ok(/export function LesefensterOhneHerkunft/.test(lese) && /oben\.oeffne\(\{ \.\.\.ziel, ohneHerkunft: true \}\), zitat: null/.test(lese), 'E LesefensterOhneHerkunft oeffnet ohne Herkunft, ohne Zitat-Ziel');
  ok(/fenster\.ohneHerkunft \? <LesefensterOhneHerkunft>\{koerper\}<\/LesefensterOhneHerkunft> : koerper/.test(lese), 'E Verweise in einem Fenster ohne Herkunft bleiben ohne Herkunft');
  ok(/ohneHerkunft: !!ziel\.ohneHerkunft/.test(lese), 'E erneutes Oeffnen setzt die Herkunft neu');
  ok(/data-lesefenster-herkunft=\{herkunft\} data-lesefenster-ziel=/.test(lese), 'E Debug: Herkunft und Ziel am Lesefenster');
  ok(/zitat\?\.pinAnfuegen \? \{\s*nachAnpinnen/.test(lese) && /useZitatEmpfaengerAuswahl\(\{\s*project: fenster\.project, aktiv: !zitat,/.test(lese), 'E Pin-Kaertchen nur mit Herkunft, Empfaengerauswahl nur ohne');
  const main = lies('packages/web-ui/src/views/hauptagent/MainAgentView.tsx');
  const channel = lies('packages/web-ui/src/views/channels/ChannelsView.tsx');
  const nachricht = lies('packages/web-ui/src/views/channels/ChannelMessageContent.tsx');
  const workspace = lies('packages/web-ui/src/components/workspace/SynapseWorkspace.tsx');
  ok(/\{showDashboard && <LesefensterOhneHerkunft><MainAgentDashboard /.test(main), 'E Main-Dashboard/Top-Artefakte: Herkunft ohne (Pin nur speichern)');
  ok(/<VerweisFensterProvider zitat=\{zitat\.anbieter\}>/.test(main), 'E Main-Chat bleibt Herkunft main (Provider mit Zitat-Anbieter)');
  ok(/useZitatAnhaenge\(\{ chat: 'channel:' \+ project \+ ':' \+ selectedChannel, empfaenger: '#'/.test(channel) && /<VerweisFensterProvider zitat=\{channelZitat\.anbieter\}>/.test(channel), 'E Channel-Fenster ist Herkunft (eigener Entwurf je Projekt/Channel)');
  ok(/await onSend\(message, zitate\.length \? zitate : undefined\)/.test(channel) && /sendChannelMessage\(selectedProject, selectedChannel, content, undefined, zitate\)/.test(workspace), 'E Channel: Zitate/Pins gehen mit dem Post');
  ok(/\{channelZitat\.karten\}/.test(channel) && /\{channelZitat\.oberflaeche\}/.test(channel) && /<ZitatKarten zitate=\{zitatTeil\.zitate\}/.test(nachricht), 'E Channel: Kaertchen im Entwurf und Zitate in Nachrichten');
  ok(/<LesefensterOhneHerkunft><ChannelProjectSurface /.test(channel) && /<LesefensterOhneHerkunft><RuntimeAgentenPanel /.test(channel), 'E Projektflaeche/Runtime-Panel im Channel ohne Herkunft');
  const client = lies('packages/web-ui/src/api/synapse-client.ts');
  ok(/JSON\.stringify\(zitate\?\.length \? \{ content, zitate \} : \{ content \}\)/.test(client), 'E user-post: zitate nur wenn vorhanden (sonst Bestand)');
  for (const p of ['packages/web-ui/src/kios/AgentRenderingSurface.tsx', 'packages/web-ui/src/components/TopArtefakte.tsx']) {
    let quelle = '';
    try { quelle = lies(p); } catch { quelle = ''; }
    ok(quelle && !/LesefensterOhneHerkunft|ZitatEmpfaenger|pinAnfuegen|useZitatEmpfaengerAuswahl/.test(quelle), 'E unveraendert (kein neues Menue): ' + p);
  }
}

console.log('PASS P22-T170 Web-UI Lesefenster-Herkunft ' + n + ' Pruefungen');
