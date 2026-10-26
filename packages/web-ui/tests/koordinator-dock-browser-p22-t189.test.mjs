/**
 * P22-T189/T187 ProjectCoordinatorDock.tsx: Browser-Regressionspruefung fuer koordinator_mehrfenster (AUS/EIN),
 * Identitaets-/Entwurfs-/Sendeisolation, Position/z-Order/Schliessen, plattform_agent_chat AUS und Status-Refresh.
 * Echte UI + API-Attrappe aus koordinator-dock-fixture.tsx. Keine DB, kein Produktionszugriff.
 * Seriell starten: node packages/web-ui/tests/koordinator-dock-browser-p22-t189.test.mjs
 * Jeder Fehler nennt Herkunft, Erwartung, Ist und Screenshot-Pfad. KI-Browser 192.168.50.65:9222.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { screenshotAblage } from '../../../scripts/lib/ui-screenshots.mjs';
import { isolierterTab, evaluateWert } from '../../../scripts/lib/ki-browser-isolation.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const requireUi = createRequire(join(repo, 'packages/web-ui/package.json'));
const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
const KB = 'http://192.168.50.65:9222';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const ablage = await screenshotAblage(repo, 'p22-t189');
let vite, tab, checks = 0;
const kb = async (path, body) => {
  const r = await fetch(KB + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json(); assert.equal(d.success, true, JSON.stringify(d)); return d.data;
};
const ev = async script => evaluateWert(await kb('/evaluate', { tab_id: tab, script }));
const wait = async (script, label) => {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { if (await ev(script)) return; await new Promise(r => setTimeout(r, 150)); }
  throw Error('P22-T189/T187 ProjectCoordinatorDock.tsx erwartet=' + label + ' ist=' + JSON.stringify(await ev('document.body.innerText')).slice(0, 1200));
};
const ok = (value, label, actual) => { assert(value, 'P22-T189/T187 ProjectCoordinatorDock.tsx erwartet=' + label + ' ist=' + JSON.stringify(actual)); checks++; console.log('OK P22-T189/T187 ProjectCoordinatorDock.tsx ' + label); };
const win = id => 'document.querySelector('+JSON.stringify('[data-coordinator-window="'+id+'"]')+')';
const clickRail = index => ev('document.querySelectorAll(".coordinator-dock-tab")[' + index + '].click()');
const count = n => wait('document.querySelectorAll("[data-coordinator-window]").length === '+n, n+' Fenster');
const type = (id, value) => ev('(()=>{const el='+win(id)+'.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));})()');
const shot = async name => {
  const r = await fetch(KB + '/screenshot?tab_id=' + tab + '&raw=true');
  assert(r.ok, 'Screenshot HTTP ' + r.status);
  const bytes = Buffer.from(await r.arrayBuffer()); assert(bytes.length > 1000, 'Screenshot leer');
  const path = await ablage.speichere(name + '.png', bytes); console.log('SCREENSHOT ' + path); return path;
};
try {
  vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error',
    esbuild: { jsx: 'automatic' }, optimizeDeps: { entries: ['tests/koordinator-dock.html'] }, server: { host: '0.0.0.0', port: 0 } });
  await vite.listen();
  const url = 'http://192.168.50.10:' + vite.httpServer.address().port + '/tests/koordinator-dock.html';
  tab = (await isolierterTab(kb, { url })).tab_id;
  await wait('document.querySelectorAll(".coordinator-dock-tab").length===2', '2 Koordinatoren');
  // User verlangt Standard AUS = Einzelfenster.
  await clickRail(0); await count(1); await clickRail(1); await count(1);
  ok(await ev('!!'+win(B)+' && !'+win(A)), 'Schalter AUS ersetzt A durch B');
  await ev(win(B)+'.querySelector("header > button").click()'); await count(0);
  await clickRail(0); await count(1); await clickRail(0); await count(0);
  ok(true, 'Schalter AUS erhaelt Leisten-Toggle');
  // User verlangt mehrere beschreibbare Fenster, eigene Positionen und z-Order.
  await ev('window.__dockTest.mehrfenster=true'); await clickRail(0); await count(1); await clickRail(1); await count(2);
  await wait('!!'+win(A)+'.querySelector("textarea") && !!'+win(B)+'.querySelector("textarea")', '2 Eingaben');
  await type(A, 'Entwurf nur an A'); await type(B, 'Entwurf nur an B');
  await ev(win(A)+'.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerId:9}))');
  let state = await ev('JSON.stringify(['+win(A)+','+win(B)+'].map(f=>({value:f.querySelector("textarea").value,pos:f.style.transform,z:Number(f.style.zIndex)})))');
  ok(state[0].value==='Entwurf nur an A' && state[1].value==='Entwurf nur an B', 'beide Entwuerfe unabhaengig', state);
  ok(state[0].pos!==state[1].pos && state[0].z>state[1].z, 'versetzte Position und angeklicktes Fenster vorn', state);
  const oldB=state[1].pos;
  await ev('(()=>{const h='+win(A)+'.querySelector("header");h.setPointerCapture=()=>{};h.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,pointerId:3,clientX:120,clientY:70}));h.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,pointerId:3,clientX:650,clientY:110}));h.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,pointerId:3}));})()');
  state=await ev('JSON.stringify(['+win(A)+','+win(B)+'].map(f=>f.style.transform))');
  ok(state[1]===oldB && state[0]!==state[1], 'Verschieben von A laesst B stehen', state);
  await shot('01-zwei-entwuerfe');
  // Senden trifft genau den Empfaenger des jeweiligen Fensters (nur Attrappe).
  await ev(win(A)+'.querySelector("form").requestSubmit()');
  await wait('window.__dockTest.posts.length===1', 'erste Zustellung');
  ok(await ev(win(B)+'.querySelector("textarea").value==="Entwurf nur an B"'), 'Senden A erhaelt Entwurf B');
  await ev(win(B)+'.querySelector("form").requestSubmit()');
  await wait('window.__dockTest.posts.length===2', 'zweite Zustellung');
  const posts=await ev('JSON.stringify(window.__dockTest.posts)');
  ok(posts[0].identity_id===A && posts[0].text==='Entwurf nur an A' && posts[1].identity_id===B && posts[1].text==='Entwurf nur an B', 'Senden je Fenster an richtige Identitaet', posts);
  await shot('02-zwei-zustellungen');
  // ac1f8247 Punkt 2: Entwuerfe muessen AUS, Lesefehler und Erholung ohne Remount ueberleben.
  await type(A, 'A bleibt bei Statusfehler'); await type(B, 'B bleibt bei Statusfehler');
  // P22-T187: ohne Neuoeffnen nach Schalterwechsel, Fokus und manueller Abfrage.
  await ev('window.__dockTest.chat['+JSON.stringify(A)+']=false;window.dispatchEvent(new Event("focus"))');
  await wait(win(A)+'.querySelector(".coordinator-chat-hinweis")?.innerText.includes("plattform_agent_chat")', 'sichtbarer AUS-Hinweis mit Schaltername');
  ok(await ev('!!'+win(B)+'.querySelector("textarea")'), 'A AUS laesst B aktiv');
  ok(await ev(win(A)+'.querySelector("textarea").value==="A bleibt bei Statusfehler"'), 'Entwurf A uebersteht ausdrueckliches AUS');
  await ev(win(A)+'.querySelector("form").requestSubmit()');
  ok(await ev('window.__dockTest.posts.length===2'), 'AUS sperrt auch direkten Submit');
  await shot('03-aus-hinweis');
  await ev('window.__dockTest.chat['+JSON.stringify(A)+']=true;'+win(A)+'.querySelector(".coordinator-chat-hinweis button").click()');
  await wait(win(A)+'.dataset.chatAktiv==="true"', 'manueller Refresh aktiviert A');
  ok(await ev(win(A)+'.querySelector("textarea").value==="A bleibt bei Statusfehler"'), 'Entwurf A uebersteht AUS und Erholung');
  await ev('window.__dockTest.fehler=true;window.dispatchEvent(new Event("focus"))');
  await wait(win(A)+'.querySelector(".coordinator-chat-hinweis")?.innerText.includes("nicht abrufbar")', 'sichtbarer Lesefehler');
  let drafts = await ev('JSON.stringify(['+win(A)+','+win(B)+'].map(f=>({text:f.querySelector("textarea").value,disabled:f.querySelector("button[type=submit]").disabled})))');
  ok(drafts[0].text==='A bleibt bei Statusfehler' && drafts[1].text==='B bleibt bei Statusfehler' && drafts.every(d=>d.disabled), 'Statusfehler erhaelt beide Entwuerfe und sperrt Senden', drafts);
  await ev(win(A)+'.querySelector("form").requestSubmit();'+win(B)+'.querySelector("form").requestSubmit()');
  ok(await ev('window.__dockTest.posts.length===2'), 'Statusfehler sperrt beide direkten Submits');
  await shot('04-fehler-mit-entwuerfen');
  await ev('window.__dockTest.fehler=false;window.dispatchEvent(new Event("focus"))');
  await wait(win(A)+'.dataset.chatAktiv==="true" && '+win(B)+'.dataset.chatAktiv==="true"', 'Fokus-Refresh erholt beide');
  drafts = await ev('JSON.stringify(['+win(A)+','+win(B)+'].map(f=>f.querySelector("textarea").value))');
  ok(drafts[0]==='A bleibt bei Statusfehler' && drafts[1]==='B bleibt bei Statusfehler', 'Erholung erhaelt beide Entwuerfe', drafts);
  await shot('05-erholung-mit-entwuerfen');
  // B bei unbekanntem Mehrfensterstatus oeffnen darf das bestehende A nicht entfernen.
  await ev(win(B)+'.querySelector("header > button").click()'); await count(1);
  await ev('window.__dockTest.fehler=true'); await clickRail(1); await count(2);
  ok(await ev(win(A)+'.querySelector("textarea").value==="A bleibt bei Statusfehler"'), 'B bei Statusfehler laesst Fenster und Entwurf A stehen');
  await ev('window.__dockTest.fehler=false;window.dispatchEvent(new Event("focus"))');
  await wait(win(A)+'.dataset.chatAktiv==="true"', 'Erholung nach unbekanntem Mehrfensterstatus');
  await shot('06-oeffnen-bei-statusfehler');
  await ev(win(A)+'.querySelector("header > button").click()'); await count(1);
  ok(await ev('!!'+win(B)), 'An Seite schliesst nur A');
  console.log('BESTANDEN '+checks+' gezielte Browserpruefungen; Screenshot-Ordner '+ablage.ordner);
} catch(error) {
  const path=tab ? await shot('99-fehler').catch(()=>ablage.ordner) : ablage.ordner;
  console.error('DEBUG P22-T189/T187 ProjectCoordinatorDock.tsx erwartet=Browserpruefungen gruen ist='+error.message+' screenshot='+path);
  process.exitCode=1;
} finally {
  if(tab) await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
  if(vite) await vite.close();
}
