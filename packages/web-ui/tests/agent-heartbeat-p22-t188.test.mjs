/** P22-T188 AgentHeartbeatRegler + echte Dock/Channel-Koepfe: serielle KI-Browserpruefung mit echter Heartbeat-REST-API auf synapse_test:5433, ohne Live-Daten.
 * Start: node packages/web-ui/tests/agent-heartbeat-p22-t188.test.mjs
 * Erwartet/tatsaechlich in jedem Assert; Screenshots unter ui-screenshots/p22-t188/<Lauf>/.
 */
import assert from 'node:assert/strict';
import { heartbeatApiFixture } from '../../rest-api/tests/agent-heartbeat-api-fixture.mjs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isolierterTab, evaluateWert } from '../../../scripts/lib/ki-browser-isolation.mjs';
import { screenshotAblage } from '../../../scripts/lib/ui-screenshots.mjs';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const requireUi = createRequire(join(repo, 'packages/web-ui/package.json'));
const { createServer } = await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')), 'dist/node/index.js')).href);
const KB = process.env.SYNAPSE_KI_BROWSER_URL || 'http://192.168.50.65:9222';
const HOST = process.env.SYNAPSE_UI_TEST_HOST || '192.168.50.10';
const kb = async (path, body) => {
  const r = await fetch(KB + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const d = await r.json(); assert.equal(d.success, true, JSON.stringify(d)); return d.data;
};
let tab, vite, backend, checks = 0;
const ev = async script => evaluateWert(await kb('/evaluate', { tab_id: tab, script }));
const wait = async (script, label) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { if (await ev('Boolean(' + script + ')')) return; await new Promise(r => setTimeout(r, 150)); }
  throw Error('P22-T188 Timeout ' + label + ' | tatsaechlich: ' + await ev('document.body.innerText'));
};
const ok = (v, label, actual) => { assert.ok(v, 'P22-T188 ' + label + ' | tatsaechlich: ' + JSON.stringify(actual)); checks++; console.log('OK ' + label); };
const click = script => ev(script + '.click()');
const reg = "document.querySelector('.agent-heartbeat-regler')";
const save = reg + ".querySelector('.agent-heartbeat-aktionen button')";
const number = reg + ".querySelector('input[type=number]')";
const input = async value => {
  await ev("(()=>{const n=" + number + ";Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(n," + JSON.stringify(value) + ");n.dispatchEvent(new Event('input',{bubbles:true}));})()");
};
try {
  backend = await heartbeatApiFixture();
  vite = await createServer({ root: join(repo, 'packages/web-ui'), configFile: false, logLevel: 'error', esbuild: { jsx: 'automatic' },
    optimizeDeps: { entries: ['tests/agent-heartbeat.html'] }, server: { host: '0.0.0.0', port: 0, proxy: { '/api': { target: backend.url } } } });
  await vite.listen();
  const base = 'http://' + HOST + ':' + vite.httpServer.address().port + '/tests/agent-heartbeat.html';
  const ablage = await screenshotAblage(repo, 'p22-t188');
  // Eigenes Oeffnen: native details ueber echten summary-Klick, nicht per open-Attribut.
  const page = async query => {
    if (tab) await kb('/tabs/close', { tab_id: tab });
    const q = new URLSearchParams(query);
    await backend.reset({ off: q.get('off') === '1', noRun: q.get('noRun') === '1' });
    tab = (await isolierterTab(kb, { url: base + '?' + query })).tab_id;
  };
  const loaded = async () => {
    await wait(reg + " && " + reg + ".textContent.includes('Ist')", 'Stand geladen');
    await click(reg + ".querySelector(':scope > summary')");
  };
  const shot = async name => {
    const r = await fetch(KB + '/screenshot?tab_id=' + tab); assert.ok(r.ok);
    console.log('SCREENSHOT ' + await ablage.speichere(name + '.png', Buffer.from(await r.arrayBuffer())));
  };
  await page('view=single'); await loaded();
  ok(await ev('window.heartbeatTest.puts.length === 0'), 'Laden schreibt keinen Heartbeat', await ev('window.heartbeatTest.puts'));
  await input('4');
  ok(await ev(save + '.disabled'), 'Intervall unter 5 s sperrt Speichern', await ev(number + '.value'));
  await input('86401');
  ok(await ev(save + '.disabled'), 'Intervall ueber 24 h sperrt Speichern', await ev(number + '.value'));
  await input('30'); await click(reg + ".querySelector('input[type=checkbox]')"); await click(save);
  await wait(reg + ".textContent.includes('Gespeichert.')", 'Speichern AUS');
  ok(await ev("!" + reg + ".querySelector('input[type=checkbox]').checked && " + number + ".value === '30'"),
    'Echter PUT aktualisiert Regler auf AUS/30 s ohne Ruecksprung', await ev(reg + '.innerText'));
  let body = await ev('window.heartbeatTest.puts.at(-1)');
  ok(body.identity_id === 'ko-a' && body.aktiv === false && body.intervall_ms === 30000, 'AUS + 30 s trifft nur ko-a', body);
  await input(''); await click(reg + ".querySelector('input[type=checkbox]')"); await click(save);
  await wait("window.heartbeatTest.puts.length === 2 && !" + save + ".disabled", 'adaptiv gespeichert');
  body = await ev('window.heartbeatTest.puts.at(-1)');
  ok(body.aktiv === true && body.intervall_ms === null, 'Leer = adaptiv, EIN gespeichert', body);
  await shot('01-koordinator-adaptiv');
  await ev('window.heartbeatTest.failPut = true'); await click(save);
  await wait(reg + ".querySelector('[role=alert]')", 'API-Fehler sichtbar');
  ok(await ev(save + '.disabled'), 'API-Ablehnung sichtbar und weitere Writes bis Aktualisierung gesperrt', await ev(reg + '.innerText'));
  await ev('window.heartbeatTest.failPut = false; window.heartbeatTest.failGet = true');
  await click(reg + ".querySelectorAll('.agent-heartbeat-aktionen button')[1]");
  await wait(reg + ".querySelector('[role=alert]')?.textContent.includes('heartbeat_nicht_lesbar')", 'GET-Fehler sichtbar');
  await ev('window.heartbeatTest.failGet = false');
  await click(reg + ".querySelectorAll('.agent-heartbeat-aktionen button')[1]");
  await wait('!' + save + ".disabled", 'GET erholt');

  await page('view=fallback&off=1'); await loaded();
  ok(await ev(save + ".disabled && " + reg + ".innerText.includes(' AUS - Heartbeat hier nicht einstellbar.') && window.heartbeatTest.puts.length === 0"),
    'Channel-Fallback: Schalter AUS erklaert Sperre, kein Write', await ev(reg + '.innerText'));
  const buttonsFit = await ev("Array.from(" + reg + ".querySelectorAll('.agent-heartbeat-aktionen button'),b=>({width:b.getBoundingClientRect().width,scroll:b.scrollWidth,client:b.clientWidth}))");
  ok(buttonsFit.every(b => b.width >= 70 && b.scroll <= b.client), 'Channel-Reglerbuttons zeigen volle Beschriftung', buttonsFit);
  await shot('02-channel-schalter-aus');
  await page('view=fallback&noRun=1'); await loaded();
  ok(await ev(save + ".disabled && " + reg + ".innerText.includes('Kein laufender Wrapper')"),
    'Ohne Wrapper bleibt Unteragent gesperrt', await ev(reg + '.innerText'));
  await page('view=direct'); await loaded();
  ok(await ev("!!document.querySelector('.coordinator-info-window > header > .agent-heartbeat-regler')"),
    'Channels -> Agentname Direktchat hat Regler im Kopf', await ev(reg + '.parentElement.tagName'));
  await input('20'); await click(save);
  await wait(reg + ".textContent.includes('Für diesen Lauf gespeichert')", 'Unteragent speichert');
  body = await ev('window.heartbeatTest.puts.at(-1)');
  ok(body.identity_id === 'agent-a' && body.intervall_ms === 20000, 'Unteragent setzt eigenen Wrapper, Laufdauer sichtbar', body);
  await shot('03-channel-direktchat');

  await page('view=dock');
  await wait("document.querySelectorAll('.coordinator-dock-tab').length === 2", 'zwei Koordinatoren');
  await click("document.querySelectorAll('.coordinator-dock-tab')[0]");
  await wait("document.querySelector('[data-heartbeat-identity=ko-a]')?.textContent.includes('Ist')", 'Dock A');
  await click("document.querySelectorAll('.coordinator-dock-tab')[1]");
  await wait("document.querySelector('[data-heartbeat-identity=ko-b]')?.textContent.includes('Ist')", 'Dock B');
  ok(await ev("document.querySelectorAll('[data-coordinator-window]').length === 2 && document.querySelector('[data-heartbeat-identity=ko-a] > summary').textContent.includes('Wunsch EIN') && document.querySelector('[data-heartbeat-identity=ko-b] > summary').textContent.includes('Wunsch AUS')"),
    'rea1 Mehrfenster erhalten: Wunsch/Ist pro Identitaet getrennt', await ev("Array.from(document.querySelectorAll('.agent-heartbeat-regler > summary'),x=>x.textContent)"));
  await click("document.querySelector('[data-heartbeat-identity=ko-b] > summary')");
  await ev("document.querySelector('[data-heartbeat-identity=ko-b] input[type=checkbox]').click()");
  await click("document.querySelector('[data-heartbeat-identity=ko-b] .agent-heartbeat-aktionen button')");
  await wait('window.heartbeatTest.puts.length === 1', 'Dock B gespeichert');
  ok((await ev('window.heartbeatTest.puts[0]')).identity_id === 'ko-b', 'Write im zweiten Fenster trifft nur B', await ev('window.heartbeatTest.puts'));
  const geometry = await ev("(()=>{const r=document.querySelector('[data-heartbeat-identity=ko-b] section').getBoundingClientRect();return {width:r.width,right:r.right,bottom:r.bottom,vw:innerWidth,vh:innerHeight}})()");
  ok(geometry.width > 250 && geometry.right <= geometry.vw && geometry.bottom <= geometry.vh, 'Regler vollstaendig im Viewport bedienbar', geometry);
  await shot('04-dock-heartbeat-b');
  const pointer = await ev("(()=>{const r=document.querySelector('[data-heartbeat-identity=ko-a]');const w=r.closest('[data-coordinator-window]');const before=w.style.transform;r.querySelector('summary').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,clientX:50,clientY:50}));w.querySelector('header').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:100,clientY:100}));return {before,after:w.style.transform,z:w.style.zIndex,other:document.querySelector('[data-coordinator-window=ko-b]').style.zIndex}})()");
  await wait("Number(document.querySelector('[data-coordinator-window=ko-a]').style.zIndex) > Number(document.querySelector('[data-coordinator-window=ko-b]').style.zIndex)", 'Heartbeat aktiviert A');
  Object.assign(pointer, await ev("(()=>{const a=document.querySelector('[data-coordinator-window=ko-a]');return {after:a.style.transform,z:a.style.zIndex,other:document.querySelector('[data-coordinator-window=ko-b]').style.zIndex}})()"));
  ok(pointer.before === pointer.after && Number(pointer.z) > Number(pointer.other), 'Heartbeat-Bedienung aktiviert Fenster ohne Ziehen', pointer);
  await shot('05-dock-fensteraktivierung');
  ok((await ev('window.heartbeatTest.errors')).length === 0, 'Keine Browserfehler', await ev('window.heartbeatTest.errors'));
  console.log('P22-T188 Browser: ' + checks + ' Pruefungen bestanden');
} finally {
  if (tab) await kb('/tabs/close', { tab_id: tab }).catch(() => {});
  if (vite) await vite.close();
  if (backend) await backend.close();
}
