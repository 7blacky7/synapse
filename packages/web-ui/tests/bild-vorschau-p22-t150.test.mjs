/**
 * P22-T150: Bilder in allen Chats - Erkennung (bild-logik), Grossansicht-Logik, Baustein (NachrichtBilder, BildLeiste, BildKachel,
 * BildGrossansicht) als Probe mit Hook-/API-Attrappen, Verweis-Cache ohne Doppelabfrage und Einbau in die Fenster. Keine DB, kein Netz.
 *   node --experimental-strip-types packages/web-ui/tests/bild-vorschau-p22-t150.test.mjs
 * A Erkennung; B Zoom/Verschieben/Einpassen/1:1/Blaettern; C NachrichtBilder; D BildLeiste + Kachel (lazy, feste Box);
 * E Grossansicht (Tasten, Zoom, Blaettern, Esc, Klick daneben, Unterschrift); F Verweis-Cache; G Einbau.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const lies = (p) => readFileSync(join(repo, p), 'utf8');
const BL = await import(pathToFileURL(join(repo, 'packages/web-ui/src/components/bild-logik.ts')).href);
const { default: ts } = await import('typescript');

// A Erkennung
const texte = (t) => BL.findeBildVerweise(t).map((f) => f.text);
const ABS = '/home/blacky/dev/synapse/ui-screenshots/p22-t149/13-hell-kopf.png';
assert.deepEqual(texte('Screenshot: ' + ABS + '.'), [ABS], 'absoluter Pfad, Satzpunkt gehoert nicht dazu');
assert.deepEqual(texte('siehe ui-screenshots/a.png, ./bilder/b.JPG und `x/y.webp`'), ['ui-screenshots/a.png', './bilder/b.JPG', 'x/y.webp'], 'relativ, ./ und in Backticks');
assert.deepEqual(texte('![Kopf](ui-screenshots/k.png) <img src="bilder/c.gif"> <img src=bilder/d.avif>'), ['ui-screenshots/k.png', 'bilder/c.gif', 'bilder/d.avif'], 'Markdown-Bild und HTML-img');
assert.deepEqual(texte('asset_id: 42 und asset_id=7, Asset-ID #9'), ['42', '7', '9'], 'asset_id-Formen');
assert.deepEqual(texte('https://example.com/a/x.png datei.png a/b.txt a/b.png5 foo/bar.pngx'), [], 'URL, Pfad ohne Ordner, Nicht-Bild, falsche Endung');
const f = BL.findeBildVerweise('A ' + ABS);
assert.equal('A ' + ABS.slice(0, 0), 'A ');
assert.deepEqual([f[0].start, f[0].ende], [2, 2 + ABS.length], 'Position des Fundes');
assert.deepEqual(BL.bildVerweisTexte('a/b.png a/b.png c/d.png ' + ABS), ['a/b.png', 'c/d.png', ABS], 'ohne Doppelte, in Textreihenfolge');
assert.equal(BL.bildVerweisTexte(Array.from({ length: 40 }, (_, i) => 'x/' + i + '.png').join(' ')).length, 24, 'hoechstens 24 je Nachricht');
console.log('OK A Erkennung');

// B Grossansicht-Logik
const bild = { breite: 2000, hoehe: 1000 };
const buehne = { breite: 1000, hoehe: 800 };
assert.equal(BL.passendZoom(bild, buehne), 0.5, 'Einpassen: Breite begrenzt');
assert.equal(BL.passendZoom({ breite: 100, hoehe: 50 }, buehne), 1, 'kleine Bilder nicht ueber 1:1');
assert.equal(BL.passendZoom({ breite: 0, hoehe: 0 }, buehne), 1, 'ungueltige Masse');
assert.deepEqual(BL.einpassen(bild, buehne), { zoom: 0.5, x: 0, y: 0 });
assert.deepEqual(BL.begrenze({ zoom: 100, x: 0, y: 0 }, bild, buehne).zoom, BL.ZOOM_MAX, 'Zoom-Obergrenze');
assert.equal(BL.begrenze({ zoom: 0.01, x: 0, y: 0 }, bild, buehne).zoom, 0.25, 'Zoom-Untergrenze = halbe Einpassung');
assert.deepEqual(BL.begrenze({ zoom: 0.5, x: 300, y: -200 }, bild, buehne), { zoom: 0.5, x: 0, y: 0 }, 'passt ganz hinein -> mittig');
const eins = BL.einsZuEins(bild, buehne);
assert.deepEqual(eins, { zoom: 1, x: 0, y: 0 });
assert.deepEqual(BL.verschiebe(eins, 10000, 10000, bild, buehne), { zoom: 1, x: 500, y: 100 }, 'Verschieben bis zur Kante, nicht darueber');
assert.deepEqual(BL.verschiebe(eins, -120, 40, bild, buehne), { zoom: 1, x: -120, y: 40 });
// Zoom um einen Punkt: der Bildpunkt unter dem Zeiger bleibt unter dem Zeiger.
const bildpunkt = (a, p) => ({ x: (p.x - a.x) / a.zoom, y: (p.y - a.y) / a.zoom });
const p = { x: 200, y: -100 };
const z2 = BL.zoomeUm(eins, 2, p, bild, buehne);
assert.equal(z2.zoom, 2);
assert.deepEqual(bildpunkt(z2, p), bildpunkt(eins, p), 'Punkt bleibt stehen');
assert.equal(BL.zoomeUm(eins, 1000, p, bild, buehne).zoom, BL.ZOOM_MAX);
assert.ok(BL.radFaktor(-100) > 1 && BL.radFaktor(100) < 1, 'Rad nach oben vergroessert');
assert.ok(Math.abs(BL.radFaktor(-3, 1) - BL.radFaktor(-48)) < 1e-12, 'Zeilenmodus = 16 px je Zeile');
assert.equal(BL.radFaktor(-100000), BL.radFaktor(-200), 'Ausreisser gekappt');
assert.deepEqual(BL.umschalten(BL.einpassen(bild, buehne), { x: 0, y: 0 }, bild, buehne).zoom, 1, 'Doppelklick eingepasst -> 1:1');
assert.deepEqual(BL.umschalten(z2, p, bild, buehne), BL.einpassen(bild, buehne), 'Doppelklick sonst -> Einpassen');
assert.equal(BL.umschalten({ zoom: 1, x: 0, y: 0 }, { x: 0, y: 0 }, { breite: 100, hoehe: 50 }, buehne).zoom, 2, 'kleines Bild: doppelt');
assert.deepEqual([BL.blaettere(0, 3, 1), BL.blaettere(2, 3, 1), BL.blaettere(0, 3, -1), BL.blaettere(0, 0, 1)], [1, 0, 2, 0], 'Blaettern im Kreis');
assert.equal(BL.abstand({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
console.log('OK B Logik');

// Probe-Werkzeug: TSX transpilieren, Abhaengigkeiten ersetzen, Hooks je Probe.
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
let aktuell = null;
function hookSatz() {
  const slots = [], effects = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useMemo(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { wert: fn(), deps }; return slots[i].wert; },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || !same(slots[i].deps, deps)) { const old = slots[i]; effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); }
    },
    useLayoutEffect(fn, deps) { return hooks.useEffect(fn, deps); },
  };
  return {
    hooks,
    render(fn, props, vorEffekten) { aktuell = hooks; cursor = 0; const t = fn(props); vorEffekten?.(t); while (effects.length) effects.shift()(); return t; },
    unmount() { for (const s of slots) s?.cleanup?.(); },
  };
}
const react = Object.fromEntries(['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useLayoutEffect'].map((n) => [n, (...a) => aktuell[n](...a)]));
function ladeTsx(pfad, modules) {
  const js = ts.transpileModule(lies(pfad), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const alle = { react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' }, ...modules };
  new Function('require', 'module', 'exports', js)((q) => {
    if (q.endsWith('.css')) return {};
    assert.ok(q in alle, 'Unbekannte Abhaengigkeit in ' + pfad + ': ' + q);
    return alle[q];
  }, module, module.exports);
  return module.exports;
}
const alleKnoten = (tree, pred, aus = []) => {
  if (tree && typeof tree === 'object' && !Array.isArray(tree) && pred(tree)) aus.push(tree);
  for (const child of [tree?.props?.children].flat(Infinity)) if (child && typeof child === 'object') alleKnoten(child, pred, aus);
  return aus;
};
const textVon = (n) => [n?.props?.children].flat(Infinity).map((c) => (c && typeof c === 'object' ? textVon(c) : c ?? '')).join('');
const defer = () => { let res, rej; const promise = new Promise((a, b) => { res = a; rej = b; }); return { promise, resolve: res, reject: rej }; };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// C NachrichtBilder
const treffer = new Map();
const fragen = [];
const gelBild = [];
const TB = ladeTsx('packages/web-ui/src/components/ToolBild.tsx', {
  '../api/verweise': {
    bekannteTreffer: (_project, k) => { assert.equal(k.hinweis, 'asset'); return treffer.get(k.text); },
    loeseVerweiseAuf: (project, kandidaten) => { const d = defer(); fragen.push({ project, kandidaten, d }); return d.promise; },
  },
  './BildGrossansicht': {
    BildGrossansicht: 'BildGrossansicht', bildSchluessel: (b) => b.file_path, bildUnterschrift: (b, g) => b.file_path + (g ? ' · ' + g.breite + '×' + g.hoehe : ''),
    bildMasse: (_b, g) => (g ? g.breite + '×' + g.hoehe : ''),
    useGeladenesBild: (b, aktiv) => { gelBild.push({ pfad: b.file_path, aktiv }); return aktiv ? { art: 'bereit', bild: { url: 'blob:' + b.file_path, breite: 4, hoehe: 3 } } : { art: 'laedt' }; },
  },
  './bild-logik': BL,
});
const hc = hookSatz();
const text = 'Hier ' + ABS + ' und ui-screenshots/p22-t149/13-hell-kopf.png (gleiches Bild), ui-screenshots/b.png, fremd/c.png';
let t = hc.render(TB.NachrichtBilder, { project: 'synthetisch', text });
assert.equal(fragen.length, 1, 'eine gebuendelte Anfrage');
assert.deepEqual(fragen[0].kandidaten, [ABS, 'ui-screenshots/p22-t149/13-hell-kopf.png', 'ui-screenshots/b.png', 'fremd/c.png'].map((v) => ({ text: v, hinweis: 'asset' })));
assert.equal(t.type, TB.BildLeiste);
assert.deepEqual(t.props.bilder, []);
assert.equal(t.props.platzhalter, 4, 'Platzhalter halten den Platz bis zur Antwort');
const a = { art: 'asset', id: 'ui-screenshots/p22-t149/13-hell-kopf.png', titel: '13-hell-kopf.png' };
treffer.set(ABS, [a]); treffer.set(a.id, [a]);
treffer.set('ui-screenshots/b.png', [{ art: 'asset', id: 'ui-screenshots/b.png', titel: 'b.png' }]);
treffer.set('fremd/c.png', []);
fragen[0].d.resolve(true);
await flush();
t = hc.render(TB.NachrichtBilder, { project: 'synthetisch', text });
assert.equal(fragen.length, 1, 'kein zweiter Abruf');
assert.deepEqual(t.props.bilder, [{ mime_type: 'image/*', bytes: 0, project: 'synthetisch', file_path: a.id }, { mime_type: 'image/*', bytes: 0, project: 'synthetisch', file_path: 'ui-screenshots/b.png' }],
  'absolut und relativ = ein Bild; nicht erreichbar -> kein Bild');
assert.equal(t.props.platzhalter, 0);
// Fehler der Aufloesung: Platzhalter verschwinden, nichts Kaputtes.
const hf = hookSatz();
t = hf.render(TB.NachrichtBilder, { project: 'synthetisch', text: 'neu/x.png' });
assert.equal(t.props.platzhalter, 1);
fragen.at(-1).d.reject(new Error('Netz weg'));
await flush();
t = hf.render(TB.NachrichtBilder, { project: 'synthetisch', text: 'neu/x.png' });
assert.deepEqual([t.props.bilder.length, t.props.platzhalter], [0, 0], 'Fehler -> weder Bild noch Platzhalter');
const vorher = fragen.length;
assert.equal(hookSatz().render(TB.NachrichtBilder, { project: 'synthetisch', text: 'kein Bild hier, nur P22-T150' }), null);
assert.equal(hookSatz().render(TB.NachrichtBilder, { project: '', text: 'a/b.png' }), null, 'ohne Projekt nichts');
assert.equal(fragen.length, vorher, 'ohne Bildverweis keine Anfrage');
console.log('OK C NachrichtBilder');

// D BildLeiste und Kachel
const b = (i) => ({ mime_type: 'image/png', bytes: 1, project: 'synthetisch', file_path: 'bilder/' + i + '.png' });
const hl = hookSatz();
let leiste = hl.render(TB.BildLeiste, { bilder: Array.from({ length: 10 }, (_, i) => b(i)) });
const kacheln = alleKnoten(leiste, (n) => typeof n.type === 'function' && n.type.name === 'BildKachel');
assert.equal(kacheln.length, 8, 'hoechstens 8 Vorschaubilder');
const mehr = alleKnoten(leiste, (n) => n.props?.className === 'tool-bild-mehr')[0];
assert.equal(textVon(mehr), '+2');
assert.equal(alleKnoten(leiste, (n) => n.type === 'BildGrossansicht').length, 0, 'Grossansicht erst nach Klick');
kacheln[3].props.onOeffne();
leiste = hl.render(TB.BildLeiste, { bilder: Array.from({ length: 10 }, (_, i) => b(i)) });
const gross = alleKnoten(leiste, (n) => n.type === 'BildGrossansicht')[0];
assert.equal(gross.props.start, 3); assert.equal(gross.props.bilder.length, 10, 'Grossansicht blaettert ueber alle Bilder der Leiste');
gross.props.onSchliessen();
leiste = hl.render(TB.BildLeiste, { bilder: Array.from({ length: 10 }, (_, i) => b(i)) });
assert.equal(alleKnoten(leiste, (n) => n.type === 'BildGrossansicht').length, 0);
leiste = hookSatz().render(TB.BildLeiste, { bilder: [b(1)], platzhalter: 2 });
assert.equal(alleKnoten(leiste, (n) => n.props?.['aria-hidden'] === 'true').length, 2, 'Platzhalter in gleicher Box');
assert.equal(hookSatz().render(TB.BildLeiste, { bilder: [] }), null);
assert.equal(hookSatz().render(TB.ToolBilder, { bilder: [] }), null);
assert.equal(hookSatz().render(TB.ToolBilder, { bilder: [b(1)] }).type, TB.BildLeiste, 'T67-Toolbilder nutzen dieselbe Leiste');
// Kachel: laedt erst bei Sichtbarkeit.
const kachel = kacheln[0].type;
let ioCallback = null, beobachtet = null;
globalThis.IntersectionObserver = class { constructor(cb, o) { ioCallback = cb; this.o = o; } observe(el) { beobachtet = el; } disconnect() { ioCallback = null; } };
const hk = hookSatz();
gelBild.length = 0;
let k = hk.render(kachel, { bild: b(0), onOeffne() {} }, (tree) => { tree.props.ref.current = { el: 1 }; });
assert.deepEqual(gelBild.at(-1), { pfad: 'bilder/0.png', aktiv: false }, 'unsichtbar -> nicht laden');
assert.deepEqual(beobachtet, { el: 1 });
assert.equal(alleKnoten(k, (n) => n.props?.className === 'tool-bild-box').length, 1, 'feste Box');
assert.equal(textVon(alleKnoten(k, (n) => String(n.props?.className).startsWith('tool-bild-platz'))[0]), '', 'Platzhalter ohne Text vor dem Laden');
ioCallback([{ isIntersecting: true }]);
k = hk.render(kachel, { bild: b(0), onOeffne() {} });
assert.deepEqual(gelBild.at(-1), { pfad: 'bilder/0.png', aktiv: true }, 'sichtbar -> laden');
const knopf = alleKnoten(k, (n) => n.props?.className === 'tool-bild-knopf')[0];
assert.ok(knopf && alleKnoten(knopf, (n) => n.type === 'img')[0].props.src === 'blob:bilder/0.png');
const cap = alleKnoten(k, (n) => n.type === 'figcaption')[0];
assert.equal(textVon(cap), 'bilder/0.png · 4×3', 'Unterschrift Pfad + Masse');
assert.equal(textVon(alleKnoten(cap, (n) => n.props?.className === 'tool-bild-masse')[0]), ' · 4×3', 'Masse in eigenem Teil (wird nie abgeschnitten)');
assert.equal(cap.props.title, 'bilder/0.png · 4×3');
delete globalThis.IntersectionObserver;
console.log('OK D Leiste und Kachel');

// E Grossansicht
const handler = {};
globalThis.window = { innerWidth: 1000, innerHeight: 800, addEventListener(typ, fn) { handler[typ] = fn; }, removeEventListener(typ, fn) { if (handler[typ] === fn) delete handler[typ]; } };
globalThis.document = { querySelector: (s) => (s === '.synapse-control' ? 'WURZEL' : null), body: 'BODY' };
const portale = [];
const ladeAufrufe = [];
const GA = ladeTsx('packages/web-ui/src/components/BildGrossansicht.tsx', {
  'react-dom': { createPortal: (node, ziel) => { portale.push(ziel); return node; } },
  '../api/agent-runtime': { ladeToolBild: (bb) => { ladeAufrufe.push(bb.file_path); return Promise.resolve({ url: 'blob:' + bb.file_path, aktuell: false, revision: '3', breite: 2000, hoehe: 1000 }); } },
  './bild-logik': BL,
});
let zu = 0;
const props = { bilder: [b(0), b(1), b(2)], start: 1, onSchliessen: () => { zu += 1; } };
const hg = hookSatz();
let g = hg.render(GA.BildGrossansicht, props);
assert.equal(portale.at(-1), 'WURZEL', 'Portal an .synapse-control');
assert.equal(g.props['data-index'], 1); assert.equal(g.props['data-anzahl'], 3); assert.equal(g.props.role, 'dialog');
await flush();
g = hg.render(GA.BildGrossansicht, props);
assert.equal(g.props['data-stand'], 'bereit');
let img = alleKnoten(g, (n) => n.type === 'img')[0];
assert.equal(img.props.src, 'blob:bilder/1.png');
assert.equal(img.props.style.visibility, 'hidden', 'vor dem Laden unsichtbar (keine falsche Groesse)');
img.props.onLoad({ currentTarget: { naturalWidth: 2000, naturalHeight: 1000 } });
g = hg.render(GA.BildGrossansicht, props);
assert.equal(g.props['data-zoom'], 50, 'eingepasst');
img = alleKnoten(g, (n) => n.type === 'img')[0];
assert.equal(img.props.style.width, 2000);
assert.match(img.props.style.transform, /scale\(0\.5\)/);
const taste = (key) => { let verhindert = false; handler.keydown({ key, preventDefault() { verhindert = true; }, stopPropagation() {} }); g = hg.render(GA.BildGrossansicht, props); return verhindert; };
assert.equal(taste('+'), true); assert.equal(g.props['data-zoom'], 63, '+ vergroessert');
taste('-'); assert.equal(g.props['data-zoom'], 50);
taste('1'); assert.equal(g.props['data-zoom'], 100, '1 = 1:1');
taste('0'); assert.equal(g.props['data-zoom'], 50, '0 = Einpassen');
assert.equal(taste('x'), false, 'fremde Tasten bleiben frei');
assert.match(textVon(alleKnoten(g, (n) => n.props?.className === 'bild-gross-unterschrift')[0]), /^bilder\/1\.png · 2000×1000$/, 'Unterschrift mit Massen der Ansicht-Route');
assert.equal(textVon(alleKnoten(g, (n) => n.props?.className === 'bild-gross-zahl')[0]), '2 / 3');
// Knoepfe
const knopfMit = (titel) => alleKnoten(g, (n) => n.type === 'button' && String(n.props.title ?? '').startsWith(titel))[0];
knopfMit('Vergrößern').props.onClick(); g = hg.render(GA.BildGrossansicht, props);
assert.equal(g.props['data-zoom'], 63, 'Knopf +');
knopfMit('Einpassen').props.onClick(); g = hg.render(GA.BildGrossansicht, props);
assert.equal(g.props['data-zoom'], 50, 'Knopf Einpassen');
// Blaettern
taste('ArrowRight'); assert.equal(g.props['data-index'], 2);
assert.equal(g.props['data-zoom'], '', 'neues Bild: Masse neu');
taste('ArrowRight'); assert.equal(g.props['data-index'], 0, 'im Kreis');
taste('ArrowLeft'); assert.equal(g.props['data-index'], 2);
await flush(); g = hg.render(GA.BildGrossansicht, props);
assert.equal(alleKnoten(g, (n) => n.type === 'img')[0].props.src, 'blob:bilder/2.png');
// Schliessen: Esc, Klick daneben, nicht nach Ziehen
taste('Escape'); assert.equal(zu, 1, 'Esc schliesst');
const buehneKnoten = alleKnoten(g, (n) => n.props?.className === 'bild-gross-buehne')[0];
const ziel = {};
buehneKnoten.props.onClick({ target: ziel, currentTarget: ziel });
assert.equal(zu, 2, 'Klick neben das Bild schliesst');
buehneKnoten.props.onClick({ target: {}, currentTarget: ziel });
assert.equal(zu, 2, 'Klick auf das Bild schliesst nicht');
const evt = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, button: 0, pointerType: 'mouse', currentTarget: { setPointerCapture() {} } });
alleKnoten(g, (n) => n.type === 'img')[0].props.onLoad({ currentTarget: { naturalWidth: 2000, naturalHeight: 1000 } });
g = hg.render(GA.BildGrossansicht, props);
taste('1');
const bh = () => alleKnoten(g, (n) => n.props?.className === 'bild-gross-buehne')[0].props;
bh().onPointerDown(evt(1, 100, 100)); bh().onPointerMove(evt(1, 60, 120)); bh().onPointerUp(evt(1, 60, 120));
g = hg.render(GA.BildGrossansicht, props);
assert.match(alleKnoten(g, (n) => n.type === 'img')[0].props.style.transform, /translate\(calc\(-50% \+ -40px\), calc\(-50% \+ 20px\)\)/, 'Ziehen verschiebt');
bh().onClick({ target: ziel, currentTarget: ziel });
assert.equal(zu, 2, 'Klick nach dem Ziehen schliesst nicht');
// Pinch: zwei Zeiger auseinander -> groesser
const vorPinch = g.props['data-zoom'];
bh().onPointerDown(evt(5, 400, 400)); bh().onPointerDown(evt(6, 600, 400)); bh().onPointerMove(evt(6, 800, 400));
g = hg.render(GA.BildGrossansicht, props);
assert.ok(g.props['data-zoom'] > vorPinch, 'Pinch vergroessert (' + vorPinch + ' -> ' + g.props['data-zoom'] + ')');
hg.unmount();
assert.equal(handler.keydown, undefined, 'Tasten nach dem Schliessen wieder frei');
assert.equal(GA.bildUnterschrift({ file_path: 'a/b.png', breite: 10, hoehe: 5, revision: '2' }), 'a/b.png · 10×5 · Revision 2');
// Ohne Verweis: Hinweis statt Bild
const hn = hookSatz();
g = hn.render(GA.BildGrossansicht, { bilder: [{ mime_type: 'image/png', bytes: 1 }], onSchliessen() {} });
assert.equal(g.props['data-stand'], 'fehler');
assert.equal(alleKnoten(g, (n) => n.type === 'img').length, 0, 'kein kaputtes Bild');
console.log('OK E Grossansicht');

// F Verweis-Cache: gleiche Kandidaten gleichzeitig -> ein Abruf
const abrufe = [];
const VJ = ts.transpileModule(lies('packages/web-ui/src/api/verweise.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const vm = { exports: {} };
const antwort = defer();
new Function('require', 'module', 'exports', VJ)((q) => {
  assert.equal(q, './auth');
  return { apiFetch: (url, init) => { abrufe.push(JSON.parse(init.body)); return antwort.promise; } };
}, vm, vm.exports);
const V = vm.exports;
const k1 = { text: 'ui-screenshots/a.png', hinweis: 'asset' };
const e1 = V.loeseVerweiseAuf('synthetisch', [k1, k1]);
const e2 = V.loeseVerweiseAuf('synthetisch', [k1]);
assert.equal(abrufe.length, 1, 'laufende Anfrage wird geteilt');
assert.deepEqual(abrufe[0].kandidaten, [k1], 'Doppelte im selben Aufruf nur einmal');
antwort.resolve({ ok: true, json: async () => ({ ergebnisse: [{ text: k1.text, treffer: [{ art: 'asset', id: k1.text, titel: 'a.png' }] }] }) });
assert.deepEqual(await Promise.all([e1, e2]), [true, true], 'beide zeichnen neu');
assert.deepEqual(V.bekannteTreffer('synthetisch', k1), [{ art: 'asset', id: k1.text, titel: 'a.png' }]);
assert.equal(await V.loeseVerweiseAuf('synthetisch', [k1]), false, 'bekannt -> kein Abruf');
assert.equal(abrufe.length, 1);
console.log('OK F Verweis-Cache');

// G Einbau
const lese = lies('packages/web-ui/src/components/Lesefenster.tsx');
assert.match(lese, /\.\.\.BILD_MUSTER\.map\(\(m\) => \(\{ \.\.\.m, hinweis: 'asset' as const \}\)\)/, 'Pfad-Links nutzen dieselbe Erkennung');
assert.match(lese, /treffer\.length === 1 && treffer\[0\]\.art === 'asset'[\s\S]{0,400}<BildGrossansicht bilder=\{\[\{ mime_type: 'image\/\*', bytes: 0, project, file_path: t\.id \}\]\}/, 'Bildpfad-Link -> Grossansicht');
assert.match(lese, /export \{ NachrichtBilder \} from '\.\/ToolBild';/);
const ein = lies('packages/web-ui/src/components/EinheitlicherAgentChat.tsx');
assert.match(ein, /\{!m\.laeuft && !!m\.text\.trim\(\) && <NachrichtBilder project=\{project\} text=\{m\.text\} \/>\}/, 'Koordinator-Fenster: Verlauf und Inbox');
assert.match(ein, /<NachrichtBilder project=\{project\} text=\{g\.text\} \/>/, 'Koordinator-Fenster: gesendete');
const main = lies('packages/web-ui/src/components/SynapseWorkspaceMock.tsx');
assert.match(main, /message\.kind === 'text' && !message\.laeuft && !!message\.text\.trim\(\) && <NachrichtBilder project=\{project\} text=\{message\.text\} \/>/, 'Main-Chat');
assert.match(main, /\{parsed\.text && <NachrichtBilder project=\{project\} text=\{parsed\.text\} \/>\}/, 'Channel-Beitrag');
assert.match(lies('packages/web-ui/src/components/ChannelAgentChatWindow.tsx'), /<NachrichtBilder project=\{project\} text=\{message\.content\} \/>/, 'Channel-Agentenfenster');
assert.match(lies('packages/web-ui/src/components/agent-chat-teile.tsx'), /<ToolBilder bilder=\{call\.bilder\} \/>/, 'T67-Toolbilder bleiben eingebaut');
const css = lies('packages/web-ui/src/tool-bild.css');
assert.match(css, /\.tool-bild-box \{[^}]*height: 150px/, 'feste Box');
assert.match(css, /\.tool-bild figcaption \{[^}]*height: 15px[^}]*white-space: nowrap/, 'Unterschrift einzeilig');
assert.match(css, /\.tool-bild-masse \{ flex: none;/, 'Masse werden nicht gekuerzt');
assert.match(css, /\.bild-gross \{[^}]*position: fixed[^}]*var\(--bg/, 'Grossansicht folgt dem Theme');
assert.doesNotMatch(css, /tool-bild-gross/, 'altes Overlay entfernt');
assert.match(lies('packages/web-ui/src/api/agent-runtime.ts'), /breite: zahl\('X-Bild-Breite'\), hoehe: zahl\('X-Bild-Hoehe'\)/);
console.log('OK G Einbau');
console.log('P22-T150 web-ui: alle Pruefungen gruen');
