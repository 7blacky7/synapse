/**
 * P22-T150: Browserabnahme im KI-Browser (192.168.50.65:9222) mit der Fixture-Seite tests/bild-vorschau.html. Echte Bausteine;
 * die zwei API-Antworten liefert diese Testseite: Verweis-Aufloesung ueber die echte Server-Funktion loeseAssetVerweis (Attrappe
 * nur fuer DB-Zeilen und Projektwurzel), Ansicht-Route mit echten PNGs aus ui-screenshots/p22-t149. Keine DB, keine Produktionsdaten.
 *   pnpm -C packages/rest-api build && node packages/web-ui/tests/bild-vorschau-browser-p22-t150.test.mjs
 * Screenshots: ui-screenshots/p22-t150/<lauf-id>/ (P25-T7). Die Fixture-PNGs aus ui-screenshots/p22-t149/*.png sind Altbestand und bleiben.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { screenshotAblage } from '../../../scripts/lib/ui-screenshots.mjs';
import { isolierterTab } from '../../../scripts/lib/ki-browser-isolation.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const requireUi = createRequire(join(repo, 'packages/web-ui/package.json'));
const { loeseAssetVerweis } = await import(pathToFileURL(join(repo, 'packages/rest-api/dist/services/verweise.js')).href);
const KB = 'http://192.168.50.65:9222';
const P = 'p22-t150-fixture';
const A = 'ui-screenshots/p22-t149/01-dunkel-stern-trabanten-nebel.png';
const B = 'ui-screenshots/p22-t149/07-hell-stern-trabanten-nebel.png';
const C = 'ui-screenshots/p22-t149/09-hell-commit-flug.png';
const D = 'ui-screenshots/p22-t149/10-hell-projektreaktion.png';
const BILDER = new Set([A, B, C, D]);
const IDS = new Map([['4711', C]]);
const dienste = {
  frage: async (sql, params) => {
    const pfad = /id = \$2::bigint/.test(sql) ? IDS.get(params[1]) : params[1];
    return pfad && BILDER.has(pfad) ? [{ file_path: pfad, file_name: pfad.split('/').pop() }] : [];
  },
  wurzeln: async () => ['/home/blacky/dev/synapse'],
};
const zaehler = { aufloesen: 0, kandidaten: [], bild: new Map() };
const lesen = (req) => new Promise((ok, fehler) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => ok(s)); req.on('error', fehler); });
const api = {
  name: 'p22-t150-api',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, 'http://fixture');
      const json = (status, daten) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(daten)); };
      try {
        if (req.method === 'POST' && url.pathname === '/api/projects/' + P + '/verweise/aufloesen') {
          const { kandidaten } = JSON.parse(await lesen(req));
          zaehler.aufloesen += 1;
          zaehler.kandidaten.push(...kandidaten);
          const ergebnisse = await Promise.all(kandidaten.map(async (k) => ({ text: k.text, treffer: k.hinweis === 'asset' ? await loeseAssetVerweis(P, k.text, dienste) : [] })));
          return json(200, { success: true, ergebnisse });
        }
        if (req.method === 'GET' && url.pathname === '/api/main-agent/tool-bild') {
          const pfad = url.searchParams.get('file_path') ?? '';
          zaehler.bild.set(pfad, (zaehler.bild.get(pfad) ?? 0) + 1);
          if (url.searchParams.get('project') !== P || !BILDER.has(pfad)) return json(404, { success: false, error: { code: 'kein_asset', message: 'Kein Asset unter ' + pfad } });
          const png = await readFile(join(repo, pfad));
          res.setHeader('content-type', 'image/png');
          res.setHeader('X-Bild-Breite', String(png.readUInt32BE(16)));
          res.setHeader('X-Bild-Hoehe', String(png.readUInt32BE(20)));
          res.setHeader('X-Bild-Revision', '1');
          res.setHeader('X-Bild-Aktuell', '0');
          return res.end(png);
        }
        if (url.pathname.startsWith('/api/')) return json(404, { success: false });
      } catch (error) { return json(500, { success: false, error: { message: String(error) } }); }
      next();
    });
  },
};

let vite, tab, checks = 0;
const kb = async (path, body) => { const r = await fetch(KB + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); const d = await r.json(); assert.equal(d.success, true, JSON.stringify(d)); return d.data; };
const evaluate = async (script) => (await kb('/evaluate', { tab_id: tab, script })).result.result;
const wert = async (script) => { const r = await evaluate(script); return r && typeof r === 'object' && 'value' in r ? r.value : r; };
const wait = async (fn, label, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); } throw Error('Timeout: ' + label); };
const ok = (v, label) => { assert(v, label); checks += 1; console.log('OK ' + label); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// P25-T7 scripts/lib/ui-screenshots.mjs: Ordner je Lauf ui-screenshots/p22-t150/<lauf-id>/ (TESTLAUF_ID vom Laeufer, sonst Zeitstempel), nie ueberschreiben.
const ablage = await screenshotAblage(repo, 'p22-t150');
const folder = ablage.ordner;
const shot = async (name) => { const r = await fetch(KB + '/screenshot?tab_id=' + tab); assert(r.ok); console.log('SCREENSHOT ' + await ablage.speichere(name, Buffer.from(await r.arrayBuffer()))); };
const gross = () => wert("(()=>{const g=document.querySelector('.bild-gross');if(!g)return null;const i=g.querySelector('.bild-gross-buehne img');const t=g.querySelector('.bild-gross-buehne').getBoundingClientRect();"
  + "return {zoom:g.dataset.zoom,index:Number(g.dataset.index),anzahl:Number(g.dataset.anzahl),stand:g.dataset.stand,imParent:g.parentElement.id,imFenster:!!g.closest('.fixture-fenster'),"
  + "nw:i?.naturalWidth||0,nh:i?.naturalHeight||0,tw:t.width,th:t.height,transform:i?.style.transform||'',text:g.querySelector('.bild-gross-unterschrift').textContent,"
  + "bg:getComputedStyle(g).backgroundColor,akzent:getComputedStyle(g.querySelector('.bild-gross-zoom')).color}})()");
const taste = (key) => evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'" + key + "',bubbles:true,cancelable:true}));true");
// rgb(a) 0..255 oder color(srgb ...) 0..1 (color-mix liefert die zweite Form).
const hell = (farbe) => { const z = String(farbe).match(/[\d.]+/g).map(Number); const skala = String(farbe).startsWith('color(') ? 1 : 255; return (0.2126 * z[0] + 0.7152 * z[1] + 0.0722 * z[2]) / skala; };

try {
  const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
  vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error', plugins: [api], esbuild: { jsx: 'automatic' }, server: { host: '0.0.0.0', port: 0 } });
  await vite.listen();
  const ui = 'http://192.168.50.10:' + vite.httpServer.address().port;
  await mkdir(folder, { recursive: true });
  tab = (await isolierterTab(kb, { url: ui + '/tests/bild-vorschau.html' })).tab_id;
  await wait(async () => (await wert("document.querySelectorAll('[data-fixture-nachricht=\"1\"] .tool-bild[data-bild=bereit]').length")) === 2, 'Bildleiste der ersten Nachricht geladen');
  await wait(async () => (await wert("document.querySelectorAll('[data-fixture-nachricht=\"2\"] .tool-bild[data-bild=bereit]').length")) === 1, 'asset_id-Bild geladen');

  // 1 Erkennung und Leiste
  const n1 = await wert("(()=>{const n=document.querySelector('[data-fixture-nachricht=\"1\"]');return {links:[...n.querySelectorAll('.verweis-link')].map(b=>b.textContent),kacheln:[...n.querySelectorAll('.tool-bild figcaption')].map(f=>f.textContent),platz:n.querySelectorAll('.tool-bild [aria-hidden]').length}})()");
  ok(n1.links.includes('/home/blacky/dev/synapse/' + A) && n1.links.includes(B), 'absoluter und relativer Pfad sind Links: ' + JSON.stringify(n1.links));
  ok(n1.kacheln.length === 2 && /^ui-screenshots\/p22-t149\/01-dunkel-stern-trabanten-nebel\.png · \d+×\d+$/.test(n1.kacheln[0]) && n1.kacheln[1].startsWith(B), 'Leiste: absolut und relativ dasselbe Bild = 1 Kachel, Unterschrift Pfad + Masse: ' + JSON.stringify(n1.kacheln));
  const n2 = await wert("(()=>{const n=document.querySelector('[data-fixture-nachricht=\"2\"]');return {links:[...n.querySelectorAll('.verweis-link')].map(b=>b.textContent),kacheln:[...n.querySelectorAll('.tool-bild figcaption')].map(f=>f.textContent),text:n.textContent,kaputt:[...document.querySelectorAll('.tool-bilder img')].filter(i=>i.complete&&!i.naturalWidth).length}})()");
  ok(n2.text.includes('ui-screenshots/gibt-es-nicht.png') && !n2.links.includes('ui-screenshots/gibt-es-nicht.png'), 'nicht erreichbarer Pfad bleibt Text');
  ok(n2.links.includes('4711') && n2.kacheln.length === 1 && n2.kacheln[0].startsWith(C), 'asset_id 4711 -> Link und Vorschaubild');
  ok(n2.kaputt === 0, 'kein kaputtes Bild');
  const schluessel = zaehler.kandidaten.filter((k) => k.hinweis === 'asset').map((k) => k.text);
  ok(new Set(schluessel).size === schluessel.length, 'jeder Bildverweis nur einmal beim Server angefragt (' + zaehler.aufloesen + ' Abrufe, ' + schluessel.length + ' Kandidaten)');
  const box = await wert("[...document.querySelectorAll('.tool-bild')].map(f=>Math.round(f.getBoundingClientRect().height))");
  ok(box.every((h) => h === box[0]), 'alle Vorschauboxen gleich hoch: ' + JSON.stringify(box));
  await sleep(1500); // Einblend-Animation der Seite abwarten, sonst wirkt der Screenshot abgedunkelt
  await shot('01-dunkel-koordinator-bildleiste.png');

  // 2 Lazy: die untere Nachricht laedt erst beim Scrollen, ohne Hoehensprung
  ok(!zaehler.bild.get(D), 'unten ausserhalb des Fensters: noch nicht geladen');
  const vorher = await wert("(()=>{const f=document.querySelector('[data-fixture-nachricht=unten] .tool-bild');return f?{h:Math.round(f.getBoundingClientRect().height),s:f.dataset.bild||'platz'}:null})()");
  ok(vorher && vorher.s !== 'bereit', 'untere Kachel steht als Platzhalter: ' + JSON.stringify(vorher));
  const hoeheVorher = await wert("document.querySelector('.fixture-fenster').scrollHeight");
  await evaluate("document.querySelector('.fixture-fenster').scrollTop=1e6;true");
  await wait(async () => (await wert("document.querySelector('[data-fixture-nachricht=unten] .tool-bild')?.dataset.bild")) === 'bereit', 'untere Kachel geladen');
  const nachher = await wert("Math.round(document.querySelector('[data-fixture-nachricht=unten] .tool-bild').getBoundingClientRect().height)");
  ok(zaehler.bild.get(D) === 1 && nachher === vorher.h, 'beim Scrollen geladen, Hoehe gleich (' + vorher.h + ' -> ' + nachher + ')');
  ok((await wert("document.querySelector('.fixture-fenster').scrollHeight")) === hoeheVorher, 'Fensterinhalt springt nicht');
  await evaluate("document.querySelector('.fixture-fenster').scrollTop=0;true");

  // 3 Grossansicht aus der Leiste: Portal, Einpassen, Zoom, Verschieben, Blaettern, Esc
  const bildAbrufeA = zaehler.bild.get(A);
  await evaluate("document.querySelector('[data-fixture-nachricht=\"1\"] .tool-bild-knopf').click();true");
  await wait(async () => Number((await gross())?.zoom) > 0, 'Grossansicht eingepasst');
  let g = await gross();
  ok(g.imParent === 'root' && !g.imFenster, 'Grossansicht als Portal an .synapse-control, nicht im Fenster mit transform');
  const passend = Math.round(Math.min(1, g.tw / g.nw, g.th / g.nh) * 100);
  ok(Number(g.zoom) === passend, 'Einpassen: ' + g.zoom + ' % (Bild ' + g.nw + '×' + g.nh + ', Buehne ' + Math.round(g.tw) + '×' + Math.round(g.th) + ')');
  ok(g.anzahl === 2 && g.index === 0 && /\d+×\d+/.test(g.text), 'Blaetterverbund der Nachricht (2 Bilder), Unterschrift mit Massen: ' + g.text);
  ok(zaehler.bild.get(A) === bildAbrufeA, 'Grossansicht nutzt das schon geladene Bild (kein zweiter Abruf)');
  ok(hell(g.bg) < 0.2, 'dunkles Theme: dunkler Hintergrund ' + g.bg);
  await shot('02-dunkel-grossansicht-eingepasst.png');
  await evaluate("(()=>{const s=document.querySelector('.bild-gross-buehne');const r=s.getBoundingClientRect();s.dispatchEvent(new WheelEvent('wheel',{deltaY:-200,clientX:r.left+r.width*0.3,clientY:r.top+r.height*0.4,bubbles:true,cancelable:true}));return true})()");
  await sleep(150);
  const nachRad = await gross();
  ok(Number(nachRad.zoom) > Number(g.zoom), 'Mausrad vergroessert (' + g.zoom + ' -> ' + nachRad.zoom + ')');
  await taste('+'); await sleep(100);
  const nachPlus = await gross();
  ok(Number(nachPlus.zoom) > Number(nachRad.zoom), 'Taste + vergroessert (' + nachPlus.zoom + ')');
  await evaluate("(()=>{const s=document.querySelector('.bild-gross-buehne');const e=(t,x,y)=>s.dispatchEvent(new PointerEvent(t,{pointerId:7,clientX:x,clientY:y,button:0,pointerType:'mouse',bubbles:true}));e('pointerdown',500,400);e('pointermove',440,360);e('pointermove',400,330);e('pointerup',400,330);return true})()");
  await sleep(100);
  const nachZiehen = await gross();
  ok(nachZiehen.transform !== nachPlus.transform, 'Ziehen verschiebt: ' + nachZiehen.transform);
  await shot('03-dunkel-grossansicht-zoom.png');
  await taste('1'); await sleep(100);
  ok(Number((await gross()).zoom) === 100, 'Taste 1 = 1:1');
  await taste('0'); await sleep(100);
  ok(Number((await gross()).zoom) === passend, 'Taste 0 = Einpassen');
  await taste('ArrowRight');
  await wait(async () => { const x = await gross(); return x.index === 1 && x.stand === 'bereit' && Number(x.zoom) > 0; }, 'naechstes Bild');
  ok((await gross()).text.startsWith(B), 'Pfeil rechts blaettert zum zweiten Bild');
  await taste('Escape'); await sleep(100);
  ok((await gross()) === null, 'Esc schliesst');

  // 4 Pfad-Link oeffnet direkt die Grossansicht; Klick daneben schliesst
  await evaluate("[...document.querySelectorAll('[data-fixture-nachricht=\"1\"] .verweis-link')].find(b=>b.textContent.startsWith('/home/')).click();true");
  await wait(async () => Number((await gross())?.zoom) > 0, 'Grossansicht ueber den Pfad-Link');
  ok((await gross()).anzahl === 1 && !(await wert("!!document.querySelector('.verweis-fenster')")), 'Pfad-Link -> Grossansicht, kein Lesefenster');
  await evaluate("(()=>{const s=document.querySelector('.bild-gross-buehne');s.dispatchEvent(new MouseEvent('click',{bubbles:true}));return true})()");
  await sleep(100);
  ok((await gross()) === null, 'Klick neben das Bild schliesst');

  // 5 Tool-Bild (T67) mit derselben Grossansicht (liegt unter dem sichtbaren Teil des Fensters: erst hinscrollen)
  await evaluate("document.querySelector('[data-fixture-nachricht=tool]').scrollIntoView({block:'center'});true");
  await wait(async () => (await wert("document.querySelector('[data-fixture-nachricht=tool] .tool-bild')?.dataset.bild")) === 'bereit', 'Tool-Bild geladen');
  await evaluate("document.querySelector('[data-fixture-nachricht=tool] .tool-bild-knopf').click();true");
  await wait(async () => Number((await gross())?.zoom) > 0, 'Grossansicht Tool-Bild');
  ok((await gross()).text.startsWith(C), 'T67-Tool-Bild oeffnet dieselbe Grossansicht');
  await taste('Escape'); await sleep(100);

  // 6 Hell und Akzent aus den Einstellungen
  await evaluate("(()=>{const r=document.getElementById('root');r.dataset.theme='light';r.style.setProperty('--accent','#22c55e');return true})()");
  await evaluate("document.querySelector('.fixture-fenster').scrollTop=0;true");
  await sleep(800);
  await shot('04-hell-koordinator-bildleiste.png');
  await evaluate("document.querySelector('[data-fixture-nachricht=\"2\"] .tool-bild-knopf').click();true");
  await wait(async () => Number((await gross())?.zoom) > 0, 'Grossansicht hell');
  g = await gross();
  ok(hell(g.bg) > 0.7, 'helles Theme: heller Hintergrund ' + g.bg);
  ok(g.akzent === 'rgb(34, 197, 94)', 'Akzentfarbe aus den Einstellungen: ' + g.akzent);
  await shot('05-hell-grossansicht.png');
  await taste('Escape');
  console.log('P22-T150 Browserabnahme: ' + checks + ' Pruefungen bestanden; Abrufe Aufloesung ' + zaehler.aufloesen + ', Bilder ' + JSON.stringify(Object.fromEntries(zaehler.bild)));
} catch (error) {
  // Diagnose bei Fehlschlag: Seitenzustand und Abrufe der Testseite.
  if (tab) {
    const lage = await wert("JSON.stringify({text:document.body.innerText.slice(0,800),kacheln:[...document.querySelectorAll('.tool-bild')].map(f=>f.dataset.bild||'platz'),links:[...document.querySelectorAll('.verweis-link')].map(b=>b.textContent),fehler:window.__fehler||[]})").catch((e) => 'Diagnose fehlgeschlagen: ' + e);
    console.log('DIAGNOSE ' + JSON.stringify(lage));
  }
  console.log('DIAGNOSE Abrufe ' + JSON.stringify({ aufloesen: zaehler.aufloesen, kandidaten: zaehler.kandidaten, bild: Object.fromEntries(zaehler.bild) }));
  throw error;
} finally {
  if (tab) await fetch(KB + '/tabs/close', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tab_id: tab }) }).catch(() => undefined);
  await vite?.close();
}
