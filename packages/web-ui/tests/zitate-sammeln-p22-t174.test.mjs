/**
 * P22-T174: Mehrere Zitate sammeln sich am Eingabefeld - Web-UI ohne DB und Netz.
 *   node --experimental-strip-types packages/web-ui/tests/zitate-sammeln-p22-t174.test.mjs
 * WARUM (User inbox 1275, 26.10.2026 01:14): "wenn ich zitate hinzufüge wird das vorige verworfen". Ursache: ein weiteres Zitat (Menue,
 * Knopf im Lesefenster, Markierung, Klick auf ein anderes Kaertchen) ersetzte den offenen Anmerkungs-Editor (setEditor) und verwarf damit
 * ein noch nicht gespeichertes Zitat. Soll: Zitate sammeln sich als Kaertchen, jedes einzeln entfernbar, alle gehen mit der naechsten
 * Nachricht an den einen Empfaenger des Chatfensters.
 * Geprueft:
 *   A zitat-logik.ts uebernimmZitatEditor / zitatEditorHinweis (rein: neu, bearbeiten, Grenzen anmerkung_max / max_anzahl).
 *   B ZitatAnhaenge.tsx useZitatAnhaenge (React-Attrappe): zwei und drei Zitate nacheinander bei offenem Editor ueber Menue,
 *     anfuegen (Knopf im Lesefenster), Markierung und Kaertchen-Klick; Reihenfolge, localStorage, sendeZitate; Abbrechen/Escape
 *     verwerfen nur das offene; x entfernt genau eines; Grenze haelt den Editor offen; Pin bei offenem Editor; Debug data-zitat-editor.
 *   C Regression-Belege der Quelle (kein setEditor(null) mehr vor einem weiteren Zitat).
 * Schalter: chat_zitate (Attrappe der Status-Route, EIN). Kein KI-Browser (dafuer rest-api/tests/zitate-sammeln-browser-p22-t174.test.mjs).
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
// Herkunft im Label; bei Fehlschlag Debugzeile mit erwartet/tatsaechlich (regel-tests-mit-herkunft-kommentieren).
const ok = (wert, label, info) => {
  if (!wert) console.error('DEBUG ' + label + (info !== undefined ? ' | tatsaechlich: ' + JSON.stringify(info).slice(0, 600) : ''));
  assert.ok(wert, label); n++;
};
const gleich = (ist, soll, label) => {
  try { assert.deepStrictEqual(ist, soll); } catch (e) { console.error('DEBUG ' + label + ' | erwartet: ' + JSON.stringify(soll).slice(0, 400) + ' | tatsaechlich: ' + JSON.stringify(ist).slice(0, 400)); throw e; }
  n++;
};

class Ablage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

const G = { ...ZL.ZITAT_GRENZEN_STANDARD };
const t1 = { art: 'task', id: 'P1-T1', projekt: 'p', titel: 'Erste Aufgabe' };
const t2 = { art: 'task', id: 'P1-T2', projekt: 'p', titel: 'Zweite Aufgabe' };
const t3 = { art: 'memory', id: 'regel-x', projekt: 'p', titel: 'Regel X' };

// ---------------------------------------------------------------- A reine Logik (zitat-logik.ts)
{
  let r = ZL.uebernimmZitatEditor([], { vorlage: t1, schluessel: null, anmerkung: '  erstes  ' }, G, 's1', '2026-10-26T01:00:00Z');
  ok(r.fehler === null && r.liste.length === 1 && r.liste[0].schluessel === 's1' && r.liste[0].anmerkung === 'erstes' && r.zitat === r.liste[0],
    'P22-T174 zitat-logik.ts uebernimmZitatEditor: neues Zitat ans Ende (Anmerkung getrimmt)', r);
  const eins = r.liste;
  r = ZL.uebernimmZitatEditor(eins, { vorlage: t2, schluessel: null, anmerkung: '' }, G, 's2');
  gleich(r.liste.map((z) => z.schluessel), ['s1', 's2'], 'P22-T174 zitat-logik.ts uebernimmZitatEditor: zweites Zitat haengt an, erstes bleibt');
  ok(eins.length === 1, 'P22-T174 zitat-logik.ts uebernimmZitatEditor: Eingabeliste unveraendert (rein)', eins);
  r = ZL.uebernimmZitatEditor(r.liste, { vorlage: r.liste[0], schluessel: 's1', anmerkung: 'neu' }, G);
  ok(r.fehler === null && r.liste.length === 2 && r.liste[0].anmerkung === 'neu' && !r.zitat, 'P22-T174 zitat-logik.ts uebernimmZitatEditor: Bearbeiten ersetzt nur die Anmerkung', r);
  const lang = ZL.uebernimmZitatEditor(r.liste, { vorlage: t3, schluessel: null, anmerkung: 'x'.repeat(6) }, { max_anzahl: 10, anmerkung_max: 5 });
  ok(lang.fehler === 'anmerkung_zu_lang' && lang.liste.length === 2, 'P22-T174 zitat-logik.ts uebernimmZitatEditor: Anmerkung zu lang -> fehler, Liste unveraendert', lang);
  const voll = ZL.uebernimmZitatEditor(r.liste, { vorlage: t3, schluessel: null, anmerkung: '' }, { max_anzahl: 2, anmerkung_max: 5 });
  ok(voll.fehler === 'voll' && voll.liste.length === 2, 'P22-T174 zitat-logik.ts uebernimmZitatEditor: Entwurf voll -> fehler voll', voll);
  ok(ZL.zitatEditorHinweis('voll', { max_anzahl: 2, anmerkung_max: 5 }) === 'Höchstens 2 Zitate je Nachricht.'
    && ZL.zitatEditorHinweis('anmerkung_zu_lang', { max_anzahl: 2, anmerkung_max: 5 }) === 'Höchstens 5 Zeichen.', 'P22-T174 zitat-logik.ts zitatEditorHinweis: Texte wie bisher beim Speichern');
}
console.log('OK A Logik');

// ---------------------------------------------------------------- B Hook useZitatAnhaenge (ZitatAnhaenge.tsx) mit Attrappen
const zaJs = ts.transpileModule(lies('packages/web-ui/src/components/ZitatAnhaenge.tsx'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const alle = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const c of [tree?.props?.children].flat(Infinity)) if (c && typeof c === 'object') alle(c, pred, aus);
  return aus;
};
const text = (t) => (Array.isArray(t) ? t.map(text).join('') : t === null || t === undefined || typeof t === 'boolean' ? ''
  : typeof t === 'object' ? text(t.props?.children) : String(t));
const knopf = (tree, t) => alle(tree, (x) => x.type === 'button' && text(x).startsWith(t))[0];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

function hookProbe({ chat = 'agent:A', g = G, ablage, auswahl = null }) {
  const slots = [], effects = [], debug = [];
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
  const modules = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, 'react-dom': { createPortal: (kinder) => ({ type: 'portal', props: { children: kinder } }) },
    '../api/chat-zitate': { leseChatZitateStand: async () => ({ aktiv: true, quelle: 'intern', grenzen: g }) },
    '../api/verweise': { bekannteTreffer: () => undefined },
    './Lesefenster': { findeKandidaten: () => [], useVerweisFenster: () => null },
    './zitat-logik': ZL,
  };
  const fenster = { innerWidth: 1200, innerHeight: 800, getSelection: () => auswahl };
  const doc = { querySelector: () => null, body: 'body', addEventListener() {}, removeEventListener() {} };
  const konsole = { ...console, debug: (_k, info) => debug.push(info) };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', 'document', 'localStorage', 'navigator', 'console', zaJs)((x) => {
    if (x.endsWith('.css')) return {};
    assert.ok(x in modules, 'Unbekannte Abhaengigkeit: ' + x);
    return modules[x];
  }, module, module.exports, fenster, doc, ablage, { clipboard: { writeText: async () => undefined } }, konsole);
  const props = { chat, empfaenger: 'Agent ' + chat, project: 'p' };
  const render = () => { cursor = 0; const s = module.exports.useZitatAnhaenge(props); while (effects.length) effects.shift()(); return s; };
  return { render, debug };
}
const editorVon = (s) => alle(s.oberflaeche, (x) => x.props?.['data-zitat-editor'] === '')[0];
const textareaVon = (s) => alle(editorVon(s), (x) => x.type === 'textarea')[0];
const tippe = (s, wert) => textareaVon(s).props.onChange({ target: { value: wert } });
const karten = (s) => alle(s.karten, (x) => x.props?.className?.startsWith?.('zitat-karte') && x.type === 'article').map((k) => text(k));
const ids = (s) => s.entwuerfe.map((z) => z.id ?? z.art);

{
  // B1 Kernfall des Users: zwei Zitate nacheinander, das erste NICHT gespeichert (Editor noch offen) -> beide als Kaertchen.
  const ablage = new Ablage();
  const h = hookProbe({ ablage });
  let s = h.render(); await flush(); s = h.render();
  s.anbieter.menue({ x: 10, y: 20 }, [t1]); s = h.render();
  knopf(s.oberflaeche, 'Zitat anfügen').props.onClick(); s = h.render();
  tippe(s, 'Bitte zuerst'); s = h.render();
  ok(s.debug['data-zitat-editor'] === 'neu' && s.entwuerfe.length === 0, 'P22-T174 ZitatAnhaenge.tsx debug data-zitat-editor: neu bei offenem Editor, noch kein Kaertchen', s.debug);
  // zweites Zitat per Rechtsklick-Menue: vorher verwarf menue() den Editor (setEditor(null))
  s.anbieter.menue({ x: 30, y: 40 }, [t2]); s = h.render();
  ok(s.entwuerfe.length === 1 && s.entwuerfe[0].id === 'P1-T1' && s.entwuerfe[0].anmerkung === 'Bitte zuerst',
    'P22-T174 ZitatAnhaenge.tsx anbieter.menue: offener Editor (Zitat 1 mit Anmerkung) wird uebernommen statt verworfen', s.entwuerfe);
  ok(!editorVon(s) && knopf(s.oberflaeche, 'Zitat anfügen'), 'P22-T174 ZitatAnhaenge.tsx anbieter.menue: danach Menue fuer Zitat 2, Editor zu');
  knopf(s.oberflaeche, 'Zitat anfügen').props.onClick(); s = h.render();
  knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  gleich(ids(s), ['P1-T1', 'P1-T2'], 'P22-T174 ZitatAnhaenge.tsx: zwei Zitate nacheinander -> zwei Kaertchen in Reihenfolge');
  ok(karten(s).length === 2 && /Task P1-T1/.test(karten(s)[0]) && /Bitte zuerst/.test(karten(s)[0]) && /Task P1-T2/.test(karten(s)[1]),
    'P22-T174 ZitatAnhaenge.tsx karten: beide Kaertchen sichtbar (Art, ID, Anmerkung)', karten(s));
  gleich(ZL.leseZitatEntwurf(ablage, 'agent:A').map((z) => z.id), ['P1-T1', 'P1-T2'], 'P22-T174 ZitatAnhaenge.tsx setze: localStorage-Entwurf haelt beide');

  // B2 drittes Zitat ueber den Knopf im Lesefenster (anbieter.anfuegen), wieder ohne zu speichern, dann ein viertes per Markierung
  s.anbieter.anfuegen(t3, { x: 5, y: 5 }); s = h.render();
  tippe(s, 'drittes'); s = h.render();
  s.anbieter.anfuegen(t1, { x: 5, y: 5 }); s = h.render();
  gleich(ids(s), ['P1-T1', 'P1-T2', 'regel-x'], 'P22-T174 ZitatAnhaenge.tsx anbieter.anfuegen (Knopf im Lesefenster): offener Editor uebernommen, drei Kaertchen');
  ok(editorVon(s) && /Task P1-T1/.test(text(editorVon(s))) && textareaVon(s).props.value === '', 'P22-T174 ZitatAnhaenge.tsx anbieter.anfuegen: neuer leerer Editor fuer das naechste Zitat');
  // Senden nimmt den offenen Editor mit (Koordinator 26.10.2026): das offene vierte Zitat (leere Anmerkung) geht ohne Anmerkung mit.
  gleich(s.sendeZitate.map((z) => [z.art, z.id, z.anmerkung]), [['task', 'P1-T1', 'Bitte zuerst'], ['task', 'P1-T2', ''], ['memory', 'regel-x', 'drittes'], ['task', 'P1-T1', '']],
    'P22-T174 ZitatAnhaenge.tsx sendeZitate: drei Kaertchen + offenes viertes (leere Anmerkung) gehen mit der naechsten Nachricht');
  ok(s.entwuerfe.length === 3 && s.debug['data-zitate-versand'] === 4 && s.debug['data-zitate-entwurf'] === 3, 'P22-T174 ZitatAnhaenge.tsx debug: Entwurf 3 Kaertchen, Versand 4 (mit offenem Editor)', s.debug);

  // B3 Abbrechen verwirft NUR das offene, die drei bleiben
  knopf(s.oberflaeche, 'Abbrechen').props.onClick(); s = h.render();
  ok(s.sendeZitate.length === 3, 'P22-T174 ZitatAnhaenge.tsx sendeZitate: nach Abbrechen geht das verworfene nicht mehr mit', s.sendeZitate.length);
  ok(s.entwuerfe.length === 3 && !editorVon(s) && s.debug['data-zitat-editor'] === 'zu', 'P22-T174 ZitatAnhaenge.tsx Abbrechen: nur das offene Zitat verworfen, drei bleiben', ids(s));
  s.anbieter.anfuegen(t1); s = h.render();
  textareaVon(s).props.onKeyDown({ key: 'Escape', preventDefault() {} }); s = h.render();
  ok(s.entwuerfe.length === 3 && !editorVon(s), 'P22-T174 ZitatAnhaenge.tsx Escape: verwirft nur das offene', ids(s));

  // B4 x entfernt genau eines (das mittlere)
  alle(s.karten, (x) => x.props?.className === 'zitat-karte-weg')[1].props.onClick(); s = h.render();
  gleich(ids(s), ['P1-T1', 'regel-x'], 'P22-T174 ZitatAnhaenge.tsx x: entfernt genau das mittlere Zitat');
  gleich(ZL.leseZitatEntwurf(ablage, 'agent:A').map((z) => z.id), ['P1-T1', 'regel-x'], 'P22-T174 ZitatAnhaenge.tsx x: localStorage nachgezogen');

  // B5 Kaertchen-Klick bei offenem neuen Zitat: das neue wird uebernommen, dann Bearbeiten des Kaertchens mit frischem Stand
  s.anbieter.anfuegen(t2); s = h.render();
  tippe(s, 'wieder da'); s = h.render();
  alle(s.karten, (x) => x.props?.className === 'zitat-karte-inhalt')[0].props.onClick({ clientX: 100, clientY: 500 }); s = h.render();
  gleich(ids(s), ['P1-T1', 'regel-x', 'P1-T2'], 'P22-T174 ZitatAnhaenge.tsx Kaertchen-Klick: offenes neues Zitat zuerst uebernommen');
  ok(s.debug['data-zitat-editor'] === 'bearbeiten' && textareaVon(s).props.value === 'Bitte zuerst', 'P22-T174 ZitatAnhaenge.tsx Kaertchen-Klick: Editor bearbeitet Kaertchen 1', s.debug);
  // B6 Bearbeiten offen, Klick auf ein anderes Kaertchen: die Aenderung bleibt (vorher verworfen)
  tippe(s, 'geaendert'); s = h.render();
  alle(s.karten, (x) => x.props?.className === 'zitat-karte-inhalt')[1].props.onClick({ clientX: 100, clientY: 500 }); s = h.render();
  ok(s.entwuerfe[0].anmerkung === 'geaendert' && textareaVon(s).props.value === 'drittes' && s.entwuerfe.length === 3,
    'P22-T174 ZitatAnhaenge.tsx Kaertchen-Klick: offene Bearbeitung uebernommen, Editor zeigt Kaertchen 2', s.entwuerfe.map((z) => z.anmerkung));
  // derselbe Kaertchen-Klick erneut zeigt den frischen Stand (nicht den Stand vom letzten Rendern)
  tippe(s, 'drittes neu'); s = h.render();
  alle(s.karten, (x) => x.props?.className === 'zitat-karte-inhalt')[1].props.onClick({ clientX: 100, clientY: 500 }); s = h.render();
  ok(textareaVon(s).props.value === 'drittes neu', 'P22-T174 ZitatAnhaenge.tsx Kaertchen-Klick auf dasselbe Kaertchen: frischer Stand', textareaVon(s).props.value);
  // x auf das gerade bearbeitete Kaertchen schliesst den Editor
  alle(s.karten, (x) => x.props?.className === 'zitat-karte-weg')[1].props.onClick(); s = h.render();
  ok(!editorVon(s) && s.entwuerfe.length === 2 && !s.entwuerfe.some((z) => z.id === 'regel-x'), 'P22-T174 ZitatAnhaenge.tsx x auf bearbeitetes Kaertchen: Editor zu, Zitat weg', ids(s));
  s.leeren(); s = h.render();
  ok(s.entwuerfe.length === 0 && ZL.leseZitatEntwurf(ablage, 'agent:A').length === 0, 'P22-T174 ZitatAnhaenge.tsx leeren (nach dem Senden): Entwurf und Speicher leer');
  ok(h.debug.some((d) => d?.ergebnis === 'angefuegt' && d.anlass === 'menue') && h.debug.some((d) => d?.ergebnis === 'angefuegt' && d.anlass === 'anfuegen')
    && h.debug.some((d) => d?.ergebnis === 'bearbeitet' && d.anlass === 'karte'), 'P22-T174 ZitatAnhaenge.tsx console.debug [chat-zitat]: angefuegt/bearbeitet mit anlass',
  h.debug.filter((d) => d?.anlass).map((d) => d.ergebnis + ':' + d.anlass));
}
{
  // B7 Markierung (beiKontextmenue) bei offenem Editor: uebernommen, dann Menue fuer den Ausschnitt
  const auswahl = { isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ commonAncestorContainer: 'knoten' }), toString: () => 'markierter Satz' };
  const h = hookProbe({ ablage: new Ablage(), auswahl });
  let s = h.render(); await flush(); s = h.render();
  s.anbieter.anfuegen(t1); s = h.render();
  const ev = { shiftKey: false, defaultPrevented: false, clientX: 5, clientY: 6, nativeEvent: {}, currentTarget: { contains: (k) => k === 'knoten' }, preventDefault() { this.defaultPrevented = true; } };
  s.beiKontextmenue(ev, 'inbox:9', 'p'); s = h.render();
  ok(s.entwuerfe.length === 1 && s.entwuerfe[0].id === 'P1-T1' && knopf(s.oberflaeche, 'Kopieren'), 'P22-T174 ZitatAnhaenge.tsx beiKontextmenue: offener Editor uebernommen, Menue fuer die Markierung', ids(s));
  knopf(s.oberflaeche, 'Zitat anfügen').props.onClick(); s = h.render();
  knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  gleich(s.sendeZitate.map((z) => z.art), ['task', 'ausschnitt'], 'P22-T174 ZitatAnhaenge.tsx: Verweis + Ausschnitt nacheinander -> beide im Versand');
}
{
  // B8 Grenze: Anmerkung zu lang -> Editor bleibt mit Hinweis offen, das weitere Zitat wartet (kein Menue), nichts geht verloren
  const h = hookProbe({ ablage: new Ablage(), g: { ...G, anmerkung_max: 5 } });
  let s = h.render(); await flush(); s = h.render();
  s.anbieter.anfuegen(t1); s = h.render();
  tippe(s, 'viel zu lang'); s = h.render();
  s.anbieter.menue({ x: 1, y: 1 }, [t2]); s = h.render();
  ok(editorVon(s) && /Höchstens 5 Zeichen/.test(text(editorVon(s))) && !knopf(s.oberflaeche, 'Zitat anfügen') && s.entwuerfe.length === 0 && textareaVon(s).props.value === 'viel zu lang',
    'P22-T174 ZitatAnhaenge.tsx anbieter.menue bei zu langer Anmerkung: Editor bleibt mit Hinweis und Text, kein Menue', text(editorVon(s)));
  ok(h.debug.some((d) => d?.ergebnis === 'editor_haelt' && d.fehler === 'anmerkung_zu_lang'), 'P22-T174 ZitatAnhaenge.tsx console.debug editor_haelt bei verletzter Grenze');
  // Grenze max_anzahl: zweites offen, voll -> Hinweis 'Höchstens 1 Zitate'
  const h2 = hookProbe({ ablage: new Ablage(), g: { ...G, max_anzahl: 1 } });
  s = h2.render(); await flush(); s = h2.render();
  s.anbieter.anfuegen(t1); s = h2.render();
  s.anbieter.anfuegen(t2); s = h2.render();
  s.anbieter.anfuegen(t3); s = h2.render();
  ok(s.entwuerfe.length === 1 && /Task P1-T2/.test(text(editorVon(s))) && /Höchstens 1 Zitate je Nachricht/.test(text(editorVon(s))),
    'P22-T174 ZitatAnhaenge.tsx anfuegen bei vollem Entwurf: Editor (Zitat 2) bleibt mit Hinweis, Zitat 3 wartet', text(editorVon(s)));
}
{
  // B9 Pin (P22-T170) bei offenem Editor: beides landet im Entwurf
  const h = hookProbe({ ablage: new Ablage(), chat: 'main' });
  let s = h.render(); await flush(); s = h.render();
  s.anbieter.anfuegen(t1); s = h.render();
  ok(s.anbieter.pinAnfuegen({ thoughtId: 'th-1', projekt: 'p', kopf: 'Task P1-T2', titel: 'Zweite Aufgabe', text: 'So machen.' }) === true, 'P22-T174 ZitatAnhaenge.tsx pinAnfuegen bei offenem Editor: ok');
  s = h.render();
  knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  gleich(s.sendeZitate.map((z) => z.pin ? 'pin:' + z.id : z.id), ['pin:th-1', 'P1-T1'], 'P22-T174 ZitatAnhaenge.tsx: Pin + offenes Zitat -> beide im Versand (Main)');
}
{
  // B10 Senden mit offenem Editor (Koordinator 26.10.2026: 'Senden soll einen offenen Zitat-Editor genauso uebernehmen wie Speichern';
  //     leere Anmerkung -> ohne Anmerkung). Die Aufrufer senden sendeZitate/anzeige und rufen danach leeren.
  const ablage = new Ablage();
  const h = hookProbe({ ablage, g: { ...G, anmerkung_max: 20 } });
  let s = h.render(); await flush(); s = h.render();
  s.anbieter.anfuegen(t1); s = h.render(); knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  s.anbieter.anfuegen(t2); s = h.render(); tippe(s, 'beim Senden offen'); s = h.render();
  gleich(s.sendeZitate.map((z) => [z.id, z.anmerkung]), [['P1-T1', ''], ['P1-T2', 'beim Senden offen']],
    'P22-T174 ZitatAnhaenge.tsx sendeZitate: Senden mit offenem Editor nimmt das Zitat mit Anmerkung mit');
  gleich(s.anzeige.map((z) => z.id), ['P1-T1', 'P1-T2'], 'P22-T174 ZitatAnhaenge.tsx anzeige: gesendete Nachricht zeigt auch das Zitat des offenen Editors');
  ok(s.entwuerfe.length === 1 && editorVon(s), 'P22-T174 ZitatAnhaenge.tsx: sendeZitate aendert den Entwurf nicht (Vorschau, Editor bleibt bis leeren)');
  s.leeren(); s = h.render();
  ok(!editorVon(s) && s.entwuerfe.length === 0 && s.sendeZitate.length === 0 && ZL.leseZitatEntwurf(ablage, 'agent:A').length === 0,
    'P22-T174 ZitatAnhaenge.tsx leeren (nach dem Senden): Editor geschlossen, Entwurf und Speicher leer', s.debug);
  // nur ein offener Editor mit leerer Anmerkung -> genau dieses Zitat ohne Anmerkung (Senden ist damit frei: sendeZitate.length 1)
  s.anbieter.anfuegen(t3); s = h.render();
  gleich(s.sendeZitate, [{ art: 'memory', id: 'regel-x', projekt: 'p', titel: 'Regel X', anmerkung: '' }], 'P22-T174 ZitatAnhaenge.tsx sendeZitate: nur offener Editor, leere Anmerkung -> Zitat ohne Anmerkung');
  s.leeren(); s = h.render();
  // Bearbeitung offen: die geaenderte Anmerkung geht mit
  s.anbieter.anfuegen(t1); s = h.render(); tippe(s, 'alt'); s = h.render(); knopf(s.oberflaeche, 'Speichern').props.onClick(); s = h.render();
  alle(s.karten, (x) => x.props?.className === 'zitat-karte-inhalt')[0].props.onClick({ clientX: 1, clientY: 400 }); s = h.render();
  tippe(s, 'neu beim Senden'); s = h.render();
  gleich(s.sendeZitate.map((z) => z.anmerkung), ['neu beim Senden'], 'P22-T174 ZitatAnhaenge.tsx sendeZitate: offene Bearbeitung geht mit der geaenderten Anmerkung mit');
  // Grenze verletzt: zu lange Anmerkung geht nicht mit, der Editor bleibt offen (nichts verloren)
  s.leeren(); s = h.render();
  s.anbieter.anfuegen(t2); s = h.render(); tippe(s, 'x'.repeat(25)); s = h.render();
  ok(s.sendeZitate.length === 0 && editorVon(s), 'P22-T174 ZitatAnhaenge.tsx sendeZitate: Anmerkung ueber anmerkung_max geht nicht mit, Editor bleibt offen', s.sendeZitate);
}
console.log('OK B Hook');

// ---------------------------------------------------------------- C Quelle: kein Verwerfen mehr vor einem weiteren Zitat
{
  const q = lies('packages/web-ui/src/components/ZitatAnhaenge.tsx');
  ok(!/setEditor\(null\)/.test(q), 'P22-T174 ZitatAnhaenge.tsx: kein direktes setEditor(null) mehr (Schliessen nur ueber zeigeEditor/uebernimmEditor)');
  ok((q.match(/uebernimmEditor\('(menue|anfuegen|markierung|karte|speichern)'\)/g) ?? []).length === 5, 'P22-T174 ZitatAnhaenge.tsx: Menue, Knopf, Markierung, Kaertchen und Speichern uebernehmen den offenen Editor');
  // Senden: die drei Aufrufer schicken sendeZitate und rufen danach leeren (das den Editor schliesst) - kein eigener Weg je Fenster.
  const e = lies('packages/web-ui/src/components/EinheitlicherAgentChat.tsx'), m = lies('packages/web-ui/src/components/SynapseWorkspaceMock.tsx');
  ok(/const zitate = zitat\.sendeZitate;/.test(e) && /zitat\.leeren\(\);/.test(e) && /const zitate = zitat\.sendeZitate;/.test(m) && /zitat\.leeren\(\);/.test(m)
    && /const zitate = channelZitat\.sendeZitate;/.test(m) && /channelZitat\.leeren\(\);/.test(m), 'P22-T174 Aufrufer (EinheitlicherAgentChat, Main, Channel): senden sendeZitate und rufen leeren');
  ok(/const leeren = useCallback\(\(\) => \{ zeigeEditor\(null\); setze\(\[\]\); \}/.test(q), 'P22-T174 ZitatAnhaenge.tsx leeren schliesst den Editor');
  // Koordinator 26.10.2026: das Anmerkungsfeld darf die Nachrichtenzeile und ihre Verweise nicht verdecken -> Editor als Portal in den
  // Platz im Eingabebereich (karten), nur ohne Platz schwebend; das Menue bleibt an der Klickstelle.
  ok(/\}\)\(\), editorPlatz \?\? portalZiel\(\)\)\}/.test(q) && /<div className="zitat-editor-platz" ref=\{setEditorPlatz\} \/>/.test(q)
    && /style=\{editorPlatz \? undefined : \{ left: p\.x, top: p\.y \}\}/.test(q), 'P22-T174 ZitatAnhaenge.tsx: Editor im Platz des Eingabebereichs (Portal editorPlatz), ohne Platz schwebend');
  const css = lies('packages/web-ui/src/chat-zitate.css');
  ok(/\.zitat-editor-platz > \.zitat-editor\{position:static;/.test(css), 'P22-T174 chat-zitate.css: Editor im Platz nicht schwebend (position:static)');
}
console.log('OK C Quelle');
console.log('PASS P22-T174 Web-UI Zitate sammeln ' + n + ' Pruefungen');
