/**
 * P22-T171: Pin ohne Chat-Herkunft optional an Agenten + Empfaengerauswahl als Eingabefeld - Web-UI ohne DB und Netz.
 *   pnpm -C packages/core build   (Golden-Rundweg Block core <-> web-ui)
 *   node --experimental-strip-types packages/web-ui/tests/pin-empfaenger-p22-t171.test.mjs
 * Sichert ab (Task P22-T171, User inbox 1258 und Entscheidung 83b5014f Punkte 4/5):
 *   A zitat-logik.ts: pinVorlage/pinSendeZitat/zitatKopf (Pin = 'Angepinnte User-Entscheidung an <Art> <ID>'), Entwurf-Speicher (T170-Pins),
 *     zerlegeZitatBlock gegen core chat-zitate.ts baueZitatBlock (Thought/Wortlaut, leere Anmerkung entfaellt), Verlauf-Anhang mit pin,
 *     naechsteMarkierung.
 *   B ZitatEmpfaenger.tsx useEmpfaengerFeld (Punkt 2): Klick oeffnet, Tippen filtert, hoechstens 3 sichtbar (CSS), Auswahl per Klick und
 *     Pfeil+Enter, Marken mit x, Rueckschritt, Escape/Klick daneben schliesst, Liste erst beim Oeffnen geladen.
 *   C ZitatEmpfaenger.tsx useZitatEmpfaengerAuswahl: Zitat ohne Herkunft ueber das Eingabefeld an 2 Empfaenger.
 *   D ZitatEmpfaenger.tsx usePinEmpfaenger + UserEntscheidung.tsx (Punkt 1): ohne Auswahl nur speichern (0 Sendungen), mit 2 Gewaehlten
 *     speichern + 1 Sendung an genau diese 2 mit Pin-Zitat, Fehler beim Senden laesst den Pin bestehen, Abbrechen leert die Auswahl.
 *   E UserEntscheidung.tsx (Punkt 4): Anpinnen fuer jede Verweis-Art (memory), Liste/Speichern mit art und Titel.
 *   P22-T195 Nachzug (Version 192887): feste Pin-Artenliste enthaelt jetzt auch artefakt; ungueltige Arten bleiben abgelehnt.
 *   F ZitatAnhaenge.tsx: Pin-Kaertchen mit Herkunft heisst 'Angepinnte User-Entscheidung', Sendefeld traegt pin.
 *   G Einbau Lesefenster.tsx; Artefakttafel/Top-Artefakte unveraendert.
 * Bei Fehlschlag: Zeile 'DEBUG <Herkunft> | erwartet ... | tatsaechlich ...' auf stderr.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const ZL = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/zitat-logik.ts')).href);
const CZ = await import(pathToFileURL(join(repo, 'packages/core/dist/services/chat-zitate.js')).href);
const { default: ts } = await import('typescript');
let n = 0;
const kurz = (v) => { try { return JSON.stringify(v).slice(0, 600); } catch { return String(v).slice(0, 600); } };
// Regel regel-tests-mit-herkunft-kommentieren: jede Pruefung traegt Task + Einheit + Quelldatei im Label, Fehlschlag gibt eine DEBUG-Zeile aus.
const ok = (wert, label, info) => { n++; if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + kurz(info) : '')); assert.ok(wert, label); };
const gleich = (ist, soll, label) => {
  n++;
  try { assert.deepStrictEqual(ist, soll); } catch { console.error('DEBUG ' + label + ' | erwartet: ' + kurz(soll) + ' | tatsaechlich: ' + kurz(ist)); throw new Error('FAIL ' + label); }
};

const transpile = (p) => ts.transpileModule(lies(p), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const alle = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const c of [tree?.props?.children].flat(Infinity)) if (c && typeof c === 'object') alle(c, pred, aus);
  return aus;
};
const text = (t) => (Array.isArray(t) ? t.map(text).join('') : t === null || t === undefined || typeof t === 'boolean' ? ''
  : typeof t === 'object' ? text(t.props?.children) : String(t));
const knopf = (tree, t) => alle(tree, (x) => x.type === 'button' && text(x).trim().startsWith(t))[0];
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
/** Ereignis-Attrappe: merkt preventDefault/stopPropagation. */
const ereignis = (extra = {}) => { const e = { pd: false, sp: false, preventDefault() { e.pd = true; }, stopPropagation() { e.sp = true; }, ...extra }; return e; };

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

const G = ZL.ZITAT_GRENZEN_STANDARD;
const THOUGHT = 'abcdef12-0000-4000-8000-000000000171';
const EMPF = [
  { identity_id: 'm', agent_id: 'main', name: 'main', rolle: 'main', project: 'synapse-hauptagent' },
  { identity_id: 'k', agent_id: 'koordinator', name: 'koordinator', rolle: 'koordinator', project: 'p' },
  { identity_id: 'a', agent_id: 'claude-t50', name: 'claude-t50', rolle: 'subagent', project: 'p' },
  { identity_id: 'b', agent_id: 'rea4', name: 'rea4', rolle: 'subagent', project: 'p' },
];
const PIN = { thoughtId: THOUGHT, projekt: 'p', kopf: 'Task P1-T2', titel: 'Zweite Aufgabe', text: 'Erst pruefen.' };

// ---------------------------------------------------------------- A zitat-logik.ts (Punkte 2/5)
{
  // User 83b5014f Punkt 5: Pin im Block/Kaertchen als 'Angepinnte User-Entscheidung an <Art> <ID>', nicht 'Thought <id>'.
  const v = ZL.pinVorlage(PIN, 600);
  gleich({ art: v.art, id: v.id, pin: v.pin, titel: v.titel, ausschnitt: v.ausschnitt }, { art: 'thought', id: THOUGHT, pin: 'Task P1-T2', titel: 'Zweite Aufgabe', ausschnitt: 'Erst pruefen.' },
    'P22-T171 zitat-logik.ts pinVorlage: pin = Bezug, titel = Titel des Bezugs, Wortlaut als Ausschnitt');
  ok(ZL.zitatKopf(v) === 'Angepinnte User-Entscheidung an Task P1-T2' && ZL.zitatKopf({ art: 'task', id: 'P1-T2' }) === 'Task P1-T2',
    'P22-T171 zitat-logik.ts zitatKopf: Pin-Kopf, normales Zitat unveraendert', [ZL.zitatKopf(v), ZL.zitatKopf({ art: 'task', id: 'P1-T2' })]);
  gleich(ZL.pinSendeZitat(PIN, 600), { art: 'thought', id: THOUGHT, projekt: 'p', titel: 'Zweite Aufgabe', ausschnitt: 'Erst pruefen.', anmerkung: '', pin: 'Task P1-T2' },
    'P22-T171 zitat-logik.ts pinSendeZitat: sendefertiges Pin-Zitat mit pin-Feld');
  ok(ZL.pinSendeZitat({ ...PIN, text: 'x'.repeat(700) }, 600).ausschnitt.length === 600, 'P22-T171 zitat-logik.ts pinSendeZitat: Wortlaut auf ausschnitt_max gekuerzt');
  // Entwurf-Speicher: T170-Entwuerfe (pin true, Bezug im Titel) bleiben Pins.
  const m = new Map();
  const ablage = { getItem: (k) => m.get(k) ?? null, setItem: (k, w) => m.set(k, w), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: () => null };
  ablage.setItem(ZL.ZITAT_ENTWURF_PRAEFIX + 'agent:x', JSON.stringify([
    { art: 'thought', id: THOUGHT, projekt: 'p', titel: 'User-Entscheidung an Task P1-T2 · Zweite Aufgabe', schluessel: 'k1', anmerkung: '', pin: true },
    { art: 'task', id: 'P1-T2', projekt: 'p', titel: 'T', schluessel: 'k2', anmerkung: '', pin: 'Task P1-T2' },
    { art: 'thought', id: THOUGHT, projekt: 'p', titel: '', schluessel: 'k3', anmerkung: '', pin: 'Plan P1' },
  ]));
  const e = ZL.leseZitatEntwurf(ablage, 'agent:x');
  gleich(e.map((z) => z.pin ?? null), ['Task P1-T2', null, 'Plan P1'], 'P22-T171 zitat-logik.ts leseZitatEntwurf: T170-Pin (true) -> Bezug aus Titel; pin nur bei art thought');
  // Rundweg Block: core baueZitatBlock -> web-ui zerlegeZitatBlock (gleiche Felder, eine Wahrheit).
  const p = CZ.pruefeZitate([ZL.pinSendeZitat(PIN, 600), { art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Zweite Aufgabe', anmerkung: '' }], G);
  ok(p.ok && p.zitate[0].pin === 'Task P1-T2' && p.zitate[1].pin === null, 'P22-T171 core chat-zitate.ts pruefeZitate: pin bei thought uebernommen, sonst null', p);
  const inhalt = CZ.textMitZitaten('Hallo', p.zitate);
  ok(inhalt.includes('1) Angepinnte User-Entscheidung an Task P1-T2\n   Thought: ' + THOUGHT + '\n   Projekt: p\n   Titel: Zweite Aufgabe\n   Wortlaut: Erst pruefen.\n2) Task P1-T2'),
    'P22-T171 core chat-zitate.ts baueZitatBlock: Pin-Eintrag mit Thought/Wortlaut', inhalt);
  ok(!inhalt.includes('Thought ' + THOUGHT) && !/^\s+Anmerkung:\s*$/m.test(inhalt), 'P22-T171 core chat-zitate.ts baueZitatBlock: kein "Thought <id>"-Eintrag, keine leere Anmerkung-Zeile', inhalt);
  const z = ZL.zerlegeZitatBlock(inhalt);
  gleich({ text: z.text, zitate: z.zitate }, {
    text: 'Hallo', zitate: [
      { art: 'thought', id: THOUGHT, projekt: 'p', titel: 'Zweite Aufgabe', anmerkung: '', pin: 'Task P1-T2', ausschnitt: 'Erst pruefen.' },
      { art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Zweite Aufgabe', anmerkung: '' },
    ],
  }, 'P22-T171 zitat-logik.ts zerlegeZitatBlock: Pin und Zitat ohne Anmerkung-Zeile zurueck');
  const mit = CZ.textMitZitaten('', CZ.pruefeZitate([{ ...ZL.pinSendeZitat(PIN, 600), anmerkung: 'Bitte so.\nZweite Zeile' }], G).zitate);
  ok(/   Wortlaut: Erst pruefen\.\n   Anmerkung: Bitte so\.\n     Zweite Zeile\n\[\/Synapse-Zitate\]/.test(mit) && ZL.zerlegeZitatBlock(mit).zitate[0].anmerkung === 'Bitte so.\nZweite Zeile',
    'P22-T171 core/web-ui Block: Anmerkung am Pin bleibt (mehrzeilig)', mit);
  const falsch = CZ.pruefeZitate([{ art: 'task', id: 'P1-T2', projekt: 'p', pin: 'Task P1-T2' }], G);
  ok(!falsch.ok && falsch.code === 'zitat_pin_ungueltig', 'P22-T171 core chat-zitate.ts pruefeZitate: pin an art task abgelehnt', falsch);
  // Main-Verlauf: Zitate als anhaenge (core zitatAlsVerlaufAnhang) -> web-ui anzeigeAusAnhaengen behaelt pin.
  const anh = CZ.zitatAlsVerlaufAnhang(p.zitate[0]);
  ok(anh.pin === 'Task P1-T2' && CZ.verlaufZitatAnhang(anh).pin === 'Task P1-T2' && CZ.verlaufZitatAnhang({ ...anh, verweis_art: 'task' }).pin === null,
    'P22-T171 core chat-zitate.ts Verlauf-Anhang: pin bleibt, nur bei thought', anh);
  ok(ZL.anzeigeAusAnhaengen([anh])[0].pin === 'Task P1-T2' && CZ.mainTurnText('x', [anh]).includes('1) Angepinnte User-Entscheidung an Task P1-T2'),
    'P22-T171 zitat-logik.ts anzeigeAusAnhaengen + core mainTurnText: Pin im Main-Turn gekennzeichnet');
  gleich([ZL.naechsteMarkierung(-1, 4, 1), ZL.naechsteMarkierung(3, 4, 1), ZL.naechsteMarkierung(-1, 4, -1), ZL.naechsteMarkierung(0, 4, -1), ZL.naechsteMarkierung(0, 0, 1)], [0, 0, 3, 3, -1],
    'P22-T171 zitat-logik.ts naechsteMarkierung: Pfeiltasten rundum');
  ok(ZL.EMPFAENGER_SICHTBAR === 3, 'P22-T171 zitat-logik.ts EMPFAENGER_SICHTBAR: hoechstens 3 sichtbar (User inbox 1258)');
}

// ---------------------------------------------------------------- Attrappen fuer ZitatEmpfaenger.tsx
const zeJs = transpile('packages/web-ui/src/components/ZitatEmpfaenger.tsx');
function zeModule(r, aufrufe, { aktiv = true, senden } = {}) {
  return lade(zeJs, {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '../api/chat-zitate': { leseChatZitateStand: async (p) => { aufrufe.stand.push(p); return { aktiv, quelle: 'intern', grenzen: G }; } },
    '../api/zitat-empfaenger': {
      leseZitatEmpfaenger: async (p) => { aufrufe.liste.push(p); return { aktiv: true, empfaenger: EMPF, fehler: null }; },
      sendeZitatInbox: async (e) => {
        aufrufe.senden.push(e);
        return senden ? senden(e) : { ok: true, empfaenger: e.empfaenger.map((id) => ({ identity_id: id, agent_id: EMPF.find((x) => x.identity_id === id).agent_id, inbox_id: 1, fehler: null })) };
      },
    },
    './zitat-logik': ZL,
  }, { console: { debug() {}, log: console.log } });
}
const feldVon = (tree) => alle(tree, (x) => x.props?.className === 'zitat-empfaenger-feld')[0];
const wrapperVon = (tree) => alle(tree, (x) => x.props?.className === 'zitat-empfaenger-eingabe')[0];
const eingabeVon = (tree) => alle(tree, (x) => x.type === 'input' && x.props?.role === 'combobox')[0];
const optionen = (tree) => alle(tree, (x) => x.type === 'li' && x.props?.role === 'option');
const option = (tree, agent) => optionen(tree).find((o) => o.props['data-empfaenger'] === agent);
const marken = (tree) => alle(tree, (x) => x.props?.className === 'zitat-empfaenger-marke').map((m) => m.props['data-marke']);

// ---------------------------------------------------------------- B useEmpfaengerFeld (Punkt 2)
{
  const r = reactAttrappe();
  const aufrufe = { stand: [], liste: [], senden: [] };
  const ZE = zeModule(r, aufrufe);
  let props = { project: 'p', aktiv: true, label: 'Agenten' };
  const render = (aenderung = {}) => { props = { ...props, ...aenderung }; r.start(); const s = ZE.useEmpfaengerFeld(props); r.effekte(); return s; };
  let s = render(); await flush(); s = render();
  const H = 'P22-T171 ZitatEmpfaenger.tsx useEmpfaengerFeld';
  // User inbox 1258: statt sichtbarer Checkbox-Liste ein Eingabefeld - Liste erst nach Klick/Tippen.
  ok(feldVon(s.feld).props['data-empfaenger-offen'] === '0' && optionen(s.feld).length === 0 && aufrufe.liste.length === 0 && eingabeVon(s.feld),
    H + ': anfangs nur das Eingabefeld (keine Liste, nichts geladen)', { offen: feldVon(s.feld).props['data-empfaenger-offen'], liste: aufrufe.liste });
  ok(alle(s.feld, (x) => x.type === 'input' && x.props?.type === 'checkbox').length === 0, H + ': keine Checkboxen mehr');
  wrapperVon(s.feld).props.onClick(); s = render();
  ok(feldVon(s.feld).props['data-empfaenger-offen'] === '1' && /Lädt/.test(text(s.feld)), H + ': Klick ins Feld oeffnet die Vorschlaege (laedt)', text(s.feld));
  await flush(); s = render();
  gleich(optionen(s.feld).map((o) => o.props['data-empfaenger']), ['main', 'koordinator', 'claude-t50', 'rea4'], H + ': Vorschlaege = Agenten des Projekts inkl. Main und Koordinator');
  ok(aufrufe.liste.length === 1 && aufrufe.liste[0] === 'p' && feldVon(s.feld).props['data-zitat-empfaenger-sichtbar'] === 3, H + ': Liste einmal geladen, Debug 3 sichtbar', aufrufe.liste);
  eingabeVon(s.feld).props.onChange({ target: { value: 'REA' } }); s = render();
  gleich(optionen(s.feld).map((o) => o.props['data-empfaenger']), ['rea4'], H + ': Tippen filtert (Gross/klein egal)');
  const md = ereignis();
  option(s.feld, 'rea4').props.onMouseDown(md);
  ok(md.pd, H + ': mousedown auf einem Vorschlag haelt den Fokus im Feld (preventDefault)');
  option(s.feld, 'rea4').props.onClick(); s = render();
  ok(marken(s.feld).join() === 'rea4' && eingabeVon(s.feld).props.value === '' && feldVon(s.feld).props['data-empfaenger-offen'] === '1' && optionen(s.feld).length === 4,
    H + ': Klick waehlt -> Marke, Filter leer, Liste bleibt offen', { marken: marken(s.feld), wert: eingabeVon(s.feld).props.value });
  ok(option(s.feld, 'rea4').props['aria-selected'] === true && /gewaehlt/.test(option(s.feld, 'rea4').props.className), H + ': gewaehlter Vorschlag markiert');
  let ev = ereignis({ key: 'ArrowDown' }); eingabeVon(s.feld).props.onKeyDown(ev); s = render();
  ev = ereignis({ key: 'ArrowDown' }); eingabeVon(s.feld).props.onKeyDown(ev); s = render();
  ok(/markiert/.test(option(s.feld, 'koordinator').props.className) && ev.pd, H + ': Pfeil runter markiert den zweiten Vorschlag', option(s.feld, 'koordinator').props.className);
  ev = ereignis({ key: 'Enter' }); eingabeVon(s.feld).props.onKeyDown(ev); s = render();
  gleich(s.auswahl, ['b', 'k'], H + ': Enter waehlt den markierten (mehrere moeglich, Klick-Reihenfolge)');
  ev = ereignis({ key: 'Escape' }); eingabeVon(s.feld).props.onKeyDown(ev); s = render();
  ok(ev.sp && ev.pd && feldVon(s.feld).props['data-empfaenger-offen'] === '0' && optionen(s.feld).length === 0, H + ': Escape schliesst nur die Liste (stopPropagation)', ev);
  ev = ereignis({ key: 'Escape' }); eingabeVon(s.feld).props.onKeyDown(ev);
  ok(!ev.sp, H + ': Escape bei geschlossener Liste geht an den Editor weiter');
  eingabeVon(s.feld).props.onChange({ target: { value: 'k' } }); s = render();
  ok(feldVon(s.feld).props['data-empfaenger-offen'] === '1', H + ': Tippen oeffnet die Liste');
  feldVon(s.feld).props.onBlur({ relatedTarget: 'innen', currentTarget: { contains: (x) => x === 'innen' } }); s = render();
  ok(feldVon(s.feld).props['data-empfaenger-offen'] === '1', H + ': Fokus wechselt innerhalb des Feldes -> bleibt offen');
  feldVon(s.feld).props.onBlur({ relatedTarget: null, currentTarget: { contains: () => false } }); s = render();
  ok(feldVon(s.feld).props['data-empfaenger-offen'] === '0', H + ': Klick daneben (Fokus verlaesst das Feld) schliesst');
  const weg = alle(s.feld, (x) => x.type === 'button' && /rea4 entfernen/.test(x.props['aria-label'] ?? ''))[0];
  ev = ereignis(); weg.props.onClick(ev); s = render();
  ok(ev.sp && marken(s.feld).join() === 'koordinator' && feldVon(s.feld).props['data-zitat-empfaenger-auswahl'] === 1, H + ': x an der Marke entfernt (ohne die Liste zu oeffnen)', marken(s.feld));
  eingabeVon(s.feld).props.onChange({ target: { value: '' } }); s = render();
  eingabeVon(s.feld).props.onKeyDown(ereignis({ key: 'Backspace' })); s = render();
  ok(marken(s.feld).length === 0 && s.auswahl.length === 0, H + ': Rueckschritt im leeren Feld entfernt die letzte Marke', s.auswahl);
  s.zuruecksetzen(); s = render();
  ok(feldVon(s.feld).props['data-empfaenger-offen'] === '0' && s.auswahl.length === 0, H + ': zuruecksetzen schliesst und leert');
  // Feld inaktiv (z. B. Schalter AUS): Oeffnen laedt nichts.
  const r2 = reactAttrappe(); const auf2 = { stand: [], liste: [], senden: [] }; const ZE2 = zeModule(r2, auf2);
  const render2 = () => { r2.start(); const x = ZE2.useEmpfaengerFeld({ project: 'p', aktiv: false, label: 'L' }); r2.effekte(); return x; };
  let s2 = render2(); wrapperVon(s2.feld).props.onClick(); s2 = render2(); await flush(); s2 = render2();
  ok(auf2.liste.length === 0, H + ': aktiv false -> keine Abfrage der Empfaenger', auf2.liste);
  const css = lies('packages/web-ui/src/chat-zitate.css');
  ok(/\.zitat-empfaenger-liste\{[^}]*max-height:calc\(var\(--zitat-zeile\) \* 3 \+ 2px\);overflow-y:auto/.test(css) && /\.zitat-empfaenger-liste li\{height:var\(--zitat-zeile\);box-sizing:border-box/.test(css)
    && /\.zitat-empfaenger-feld\{--zitat-zeile:26px/.test(css), 'P22-T171 chat-zitate.css: hoechstens 3 Zeilen sichtbar (max-height), Rest scrollt');
}

// ---------------------------------------------------------------- C useZitatEmpfaengerAuswahl mit Eingabefeld
{
  const r = reactAttrappe();
  const aufrufe = { stand: [], liste: [], senden: [] };
  const ZE = zeModule(r, aufrufe);
  const props = { project: 'p', aktiv: true, vorlage: { art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Zweite Aufgabe' } };
  const render = () => { r.start(); const s = ZE.useZitatEmpfaengerAuswahl(props); r.effekte(); return s; };
  const H = 'P22-T171 ZitatEmpfaenger.tsx useZitatEmpfaengerAuswahl';
  let s = render(); await flush(); s = render();
  s.knopf.props.onClick(); s = render();
  ok(feldVon(s.bereich) && optionen(s.bereich).length === 0 && aufrufe.liste.length === 0, H + ': Zitat-Bereich zeigt das Eingabefeld, Liste noch zu');
  wrapperVon(s.bereich).props.onClick(); s = render(); await flush(); s = render();
  option(s.bereich, 'rea4').props.onClick(); s = render();
  eingabeVon(s.bereich).props.onChange({ target: { value: 'koord' } }); s = render();
  option(s.bereich, 'koordinator').props.onClick(); s = render();
  ok(/2 gewählt: rea4, koordinator/.test(text(s.bereich)) && marken(s.bereich).join() === 'rea4,koordinator', H + ': Fusszeile und Marken nennen die Gewaehlten', text(s.bereich));
  alle(s.bereich, (x) => x.type === 'textarea')[0].props.onChange({ target: { value: ' Bitte lesen. ' } }); s = render();
  knopf(s.bereich, 'Senden').props.onClick(); await flush(); s = render();
  gleich(aufrufe.senden, [{ project: 'p', empfaenger: ['b', 'k'], zitate: [{ art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Zweite Aufgabe', anmerkung: 'Bitte lesen.' }] }],
    H + ': Senden an genau die 2 Gewaehlten (gleicher Weg wie T170)');
  ok(/Zitat gesendet an rea4, koordinator\./.test(text(s.bereich)) && !feldVon(s.bereich), H + ': Meldung, Bereich zu', text(s.bereich));
}

// ---------------------------------------------------------------- D usePinEmpfaenger + useUserEntscheidung (Punkt 1)
const ueJs = transpile('packages/web-ui/src/components/UserEntscheidung.tsx');
function pinProbe({ mitAuswahl = true, senden, art = 'task', id = 'P1-T2', anzeigeId = 'P1-T2', titel = 'Zweite Aufgabe' } = {}) {
  const r = reactAttrappe();
  const aufrufe = { stand: [], liste: [], senden: [], pinne: [], lese: [] };
  const ZE = zeModule(r, aufrufe, { senden });
  const UE = lade(ueJs, {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
    '../api/chat-zitate': { leseChatZitateStand: async (p) => { aufrufe.stand.push(p); return { aktiv: true, quelle: 'intern', grenzen: G }; } },
    '../api/user-entscheidung': {
      leseUserEntscheidungen: async (...x) => { aufrufe.lese.push(x); return { aktiv: true, eintraege: [], fehler: null }; },
      pinneUserEntscheidung: async (e) => { aufrufe.pinne.push(e); return { ok: true, thought_id: THOUGHT, task_id: e.art === 'task' ? e.id : null, empfaenger: [] }; },
    },
    '../api/verweise': { ART_LABEL: { task: 'Task', plan: 'Plan', memory: 'Memory', thought: 'Thought', asset: 'Bild' } },
  }, { console: { debug() {}, log: console.log } });
  const render = () => {
    r.start();
    const pe = ZE.usePinEmpfaenger({ project: 'p', aktiv: mitAuswahl });
    const s = UE.useUserEntscheidung({ project: 'p', art, id, anzeigeId, titel, anpinnen: 0, ...(mitAuswahl ? { empfaenger: pe } : {}) });
    r.effekte();
    return s;
  };
  return { render, aufrufe, UE };
}
const editorVon = (s) => alle(s.bereich, (x) => x.props?.['data-user-entscheidung-editor'] === '')[0];
const meldungVon = (s) => text(alle(s.bereich, (x) => x.props?.role === 'status')[0]);
const tippePin = (s, wert) => alle(editorVon(s), (x) => x.type === 'textarea')[0].props.onChange({ target: { value: wert } });
{
  const H = 'P22-T171 UserEntscheidung.tsx+ZitatEmpfaenger.tsx usePinEmpfaenger';
  // Punkt 1 (User inbox 1258): ohne Auswahl = wie heute nur speichern.
  const h = pinProbe();
  let s = h.render(); await flush(); s = h.render();
  ok(/optional an gewählte Agenten/.test(s.knopf.props.title), H + ': Knopf-Titel nennt die optionale Auswahl', s.knopf.props.title);
  s.knopf.props.onClick(); s = h.render();
  ok(feldVon(editorVon(s)) && alle(editorVon(s), (x) => x.props?.['data-pin-empfaenger'] === 0).length === 1 && /ohne Auswahl nur speichern/.test(text(editorVon(s))),
    H + ': Editor ohne Herkunft zeigt das Empfaenger-Feld (0 gewaehlt)', text(editorVon(s)));
  tippePin(s, ' Erst pruefen. '); s = h.render();
  ok(text(knopf(editorVon(s), 'Speichern')) === 'Speichern', H + ': ohne Auswahl heisst der Knopf Speichern');
  knopf(editorVon(s), 'Speichern').props.onClick(); await flush(); s = h.render();
  ok(h.aufrufe.pinne.length === 1 && h.aufrufe.senden.length === 0 && h.aufrufe.liste.length === 0 && meldungVon(s) === 'Angepinnt an Task P1-T2.',
    H + ': ohne Auswahl nur gespeichert, 0 Sendungen', { pinne: h.aufrufe.pinne, senden: h.aufrufe.senden, meldung: meldungVon(s) });
  gleich(h.aufrufe.pinne[0], { project: 'p', art: 'task', id: 'P1-T2', text: 'Erst pruefen.', titel: 'Zweite Aufgabe' }, H + ': Speichern mit Titel des Bezugs');
}
{
  const H = 'P22-T171 UserEntscheidung.tsx+ZitatEmpfaenger.tsx usePinEmpfaenger';
  // Punkt 1: mit Auswahl = speichern UND Pin als Block an die Inbox jedes Gewaehlten (gleicher Weg wie die Zitate).
  const h = pinProbe();
  let s = h.render(); await flush(); s = h.render();
  s.knopf.props.onClick(); s = h.render();
  tippePin(s, 'Erst pruefen.'); s = h.render();
  wrapperVon(editorVon(s)).props.onClick(); s = h.render(); await flush(); s = h.render();
  option(editorVon(s), 'rea4').props.onClick(); s = h.render();
  option(editorVon(s), 'koordinator').props.onClick(); s = h.render();
  ok(marken(editorVon(s)).join() === 'rea4,koordinator' && text(knopf(editorVon(s), 'Speichern')) === 'Speichern und senden', H + ': 2 Marken, Knopf "Speichern und senden"', marken(editorVon(s)));
  knopf(editorVon(s), 'Speichern').props.onClick(); await flush(); s = h.render();
  ok(h.aufrufe.pinne.length === 1, H + ': Pin gespeichert (1x)', h.aufrufe.pinne);
  gleich(h.aufrufe.senden, [{ project: 'p', empfaenger: ['b', 'k'], zitate: [{ art: 'thought', id: THOUGHT, projekt: 'p', titel: 'Zweite Aufgabe', ausschnitt: 'Erst pruefen.', anmerkung: '', pin: 'Task P1-T2' }] }],
    H + ': genau 1 Sendung an die 2 Gewaehlten mit Pin-Zitat (thought-ID, Bezug, Wortlaut)');
  ok(meldungVon(s) === 'Angepinnt an Task P1-T2. Gesendet an rea4, koordinator.' && !editorVon(s), H + ': Meldung nennt die Empfaenger, Editor zu', meldungVon(s));
  s.knopf.props.onClick(); s = h.render();
  ok(marken(editorVon(s)).length === 0, H + ': nach dem Senden ist die Auswahl leer');
  wrapperVon(editorVon(s)).props.onClick(); s = h.render(); await flush(); s = h.render();
  option(editorVon(s), 'main').props.onClick(); s = h.render();
  knopf(editorVon(s), 'Abbrechen').props.onClick(); s = h.render();
  s.knopf.props.onClick(); s = h.render();
  ok(marken(editorVon(s)).length === 0, H + ': Abbrechen leert die Auswahl');
}
{
  const H = 'P22-T171 UserEntscheidung.tsx+ZitatEmpfaenger.tsx usePinEmpfaenger';
  const h = pinProbe({ senden: () => ({ ok: false, code: 'funktion_aus', message: 'Zitat-Anhänge sind aus (chat_zitate)' }) });
  let s = h.render(); await flush(); s = h.render();
  s.knopf.props.onClick(); s = h.render();
  tippePin(s, 'Erst pruefen.'); s = h.render();
  wrapperVon(editorVon(s)).props.onClick(); s = h.render(); await flush(); s = h.render();
  option(editorVon(s), 'rea4').props.onClick(); s = h.render();
  knopf(editorVon(s), 'Speichern').props.onClick(); await flush(); s = h.render();
  ok(h.aufrufe.pinne.length === 1 && /^Angepinnt an Task P1-T2\. Senden an Agenten fehlgeschlagen: Zitat-Anhänge sind aus/.test(meldungVon(s)),
    H + ': Fehler beim Senden -> Pin bleibt gespeichert, Meldung nennt den Fehler', meldungVon(s));
}
{
  // Mit Herkunft (T170) bekommt der Editor KEIN Empfaenger-Feld (Lesefenster reicht empfaenger nur ohne Herkunft).
  const h = pinProbe({ mitAuswahl: false });
  let s = h.render(); await flush(); s = h.render();
  s.knopf.props.onClick(); s = h.render();
  ok(!feldVon(editorVon(s)) && /nur speichern/.test(s.knopf.props.title), 'P22-T171 UserEntscheidung.tsx: ohne empfaenger-Prop kein Feld (Bestand T170)');
}

// ---------------------------------------------------------------- E Anpinnen fuer jede Verweis-Art (Punkt 4)
{
  const H = 'P22-T171 UserEntscheidung.tsx kannAnpinnen/useUserEntscheidung';
  const h = pinProbe({ mitAuswahl: false, art: 'memory', id: 'regel-x', anzeigeId: 'regel-x', titel: 'Regel X' });
  ok(['task', 'plan', 'thought', 'memory', 'doc', 'event', 'nachricht', 'chat', 'asset', 'artefakt'].every((a) => h.UE.kannAnpinnen(a)) && !h.UE.kannAnpinnen('ausschnitt') && !h.UE.kannAnpinnen('quatsch'),
    H + ': jede Verweis-Art des Lesefensters einschliesslich artefakt (P22-T195, Version 192887; User 83b5014f Punkt 4)');
  let s = h.render(); await flush(); s = h.render();
  ok(s.aktiv && s.knopf && h.aufrufe.lese[0]?.join() === 'p,memory,regel-x' && s.bereich.props['data-user-entscheidung-art'] === 'memory', H + ': Memory: Knopf und Liste der Pins', h.aufrufe.lese);
  s.knopf.props.onClick(); s = h.render();
  ok(/User-Entscheidung an/.test(text(editorVon(s))) && /Memory regel-x/.test(text(editorVon(s))), H + ': Editor-Kopf Memory regel-x', text(editorVon(s)));
  tippePin(s, 'Gilt ab sofort.'); s = h.render();
  knopf(editorVon(s), 'Speichern').props.onClick(); await flush(); s = h.render();
  gleich(h.aufrufe.pinne[0], { project: 'p', art: 'memory', id: 'regel-x', text: 'Gilt ab sofort.', titel: 'Regel X' }, H + ': Speichern mit art memory');
  ok(meldungVon(s) === 'Angepinnt an Memory regel-x.', H + ': Meldung nennt die Memory', meldungVon(s));
}

// ---------------------------------------------------------------- F Pin-Kaertchen mit Herkunft (Punkt 5)
{
  const r = reactAttrappe();
  const m = new Map();
  const ablage = { getItem: (k) => m.get(k) ?? null, setItem: (k, w) => m.set(k, w), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: () => null };
  const ZA = lade(transpile('packages/web-ui/src/components/ZitatAnhaenge.tsx'), {
    react: r.react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-dom': { createPortal: (k) => ({ type: 'portal', props: { children: k } }) },
    '../api/chat-zitate': { leseChatZitateStand: async () => ({ aktiv: true, quelle: 'intern', grenzen: G }) },
    '../api/verweise': { bekannteTreffer: () => undefined },
    './Lesefenster': { findeKandidaten: () => [], useVerweisFenster: () => null },
    './zitat-logik': ZL,
  }, {
    window: { innerWidth: 1200, innerHeight: 800, getSelection: () => null }, document: { querySelector: () => null, body: 'body', addEventListener() {}, removeEventListener() {} },
    localStorage: ablage, navigator: {}, console: { debug() {}, log: console.log },
  });
  const render = () => { r.start(); const s = ZA.useZitatAnhaenge({ chat: 'agent:x', empfaenger: 'koordinator', project: 'p' }); r.effekte(); return s; };
  let s = render(); await flush(); s = render();
  s.anbieter.pinAnfuegen(PIN); s = render();
  const karte = alle(s.karten, (x) => x.props?.['data-zitat-pin'] !== undefined)[0];
  ok(karte && /^Angepinnte User-Entscheidungan Task P1-T2 · Zweite Aufgabe„Erst pruefen\.“×$/.test(text(karte)), 'P22-T171 ZitatAnhaenge.tsx Kaertchen: "Angepinnte User-Entscheidung" + "an Task P1-T2 · Titel"', text(karte));
  ok(s.sendeZitate[0].pin === 'Task P1-T2' && s.sendeZitate[0].titel === 'Zweite Aufgabe', 'P22-T171 ZitatAnhaenge.tsx sendeZitate: Pin geht mit pin-Feld (Block-Kennzeichnung)', s.sendeZitate[0]);
}

// ---------------------------------------------------------------- G Einbau
{
  const lese = lies('packages/web-ui/src/components/Lesefenster.tsx');
  ok(/const pinEmpfaenger = usePinEmpfaenger\(\{ project: fenster\.project, aktiv: !zitat \}\);/.test(lese) && /\.\.\.\(!zitat \? \{ empfaenger: pinEmpfaenger \} : \{\}\)/.test(lese),
    'P22-T171 Lesefenster.tsx: Pin-Empfaenger nur ohne Chat-/Channel-Herkunft');
  ok(/zitat\?\.pinAnfuegen \? \{\s*nachAnpinnen/.test(lese), 'P22-T171 Lesefenster.tsx: mit Herkunft bleibt das Kaertchen (T170 unveraendert)');
  ok(/id: fenster\.art === 'task' \|\| fenster\.art === 'plan' \? fenster\.id : inhalt\?\.id \?\? ''/.test(lese), 'P22-T171 Lesefenster.tsx: andere Arten mit der ID des aufgeloesten Inhalts');
  ok(/useZitatEmpfaengerAuswahl\(\{\s*project: fenster\.project, aktiv: !zitat,/.test(lese), 'P22-T171 Lesefenster.tsx: Zitat-Empfaengerauswahl weiter nur ohne Herkunft');
  const ze = lies('packages/web-ui/src/components/ZitatEmpfaenger.tsx');
  ok(!/type="checkbox"/.test(ze) && /role="combobox"/.test(ze), 'P22-T171 ZitatEmpfaenger.tsx: Eingabefeld (combobox) statt Checkboxen');
  for (const p of ['packages/web-ui/src/kios/AgentRenderingSurface.tsx', 'packages/web-ui/src/components/TopArtefakte.tsx']) {
    let quelle = '';
    try { quelle = lies(p); } catch { quelle = ''; }
    ok(quelle && !/usePinEmpfaenger|useEmpfaengerFeld|PinEmpfaenger/.test(quelle), 'P22-T171 Artefakttafel unveraendert: ' + p);
  }
}

console.log('PASS P22-T171 Web-UI Pin-Empfaenger/Eingabefeld ' + n + ' Pruefungen');
