/**
 * P22-T195 Folge t215: Schema166 real anwenden; Quellen-GET und fertig geladenes Lesefenster ohne Anmerkungs-Alert pruefen.
 * P22-T192: echte MeineInbox im KI-Browser gegen echte REST/Auth/PG-Fixture (synapse_test:5433).
 * Geprueft: Standard AUS, globaler Badge/Projektwechsel, Filter/Lesestatus/Antwortziel, Zitat/Verweis klickbar, Fehler sichtbar.
 * Inbox-Inhalte werden NICHT gemockt. Screenshots ui-screenshots/p22-t192. Nicht waehrend Browser-Sperre starten.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { userInboxFixture } from '../../rest-api/tests/user-inbox-fixture.mjs';
import { isolierterTab,evaluateWert } from '../../../scripts/lib/ki-browser-isolation.mjs';
import { screenshotAblage } from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'), requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const {createServer}=await import(pathToFileURL(join(dirname(requireUi.resolve('vite/package.json')),'dist/node/index.js')).href);
const KB=process.env.SYNAPSE_KI_BROWSER_URL||'http://192.168.50.65:9222', HOST=process.env.SYNAPSE_UI_TEST_HOST||'192.168.50.10';
const kb=async(path,body)=>{const r=await fetch(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const d=await r.json();assert.equal(d.success,true,JSON.stringify(d));return d.data;};
let tab,vite,f,checks=0;
const ev=async script=>evaluateWert(await kb('/evaluate',{tab_id:tab,script}));
const wait=async(script,label)=>{const end=Date.now()+20000;while(Date.now()<end){if(await ev('Boolean('+script+')') === true)return;await new Promise(r=>setTimeout(r,150));}throw Error('P22-T192 '+label+' | erwartet=true | ist='+await ev('document.body.innerText'));};
const ok=(v,label,actual)=>{assert.equal(v,true,'P22-T192 MeineInbox.tsx / user-inbox.ts '+label+' | erwartet=true | ist='+JSON.stringify(actual??v));checks++;console.log('OK P22-T192 '+label);};
const click=script=>ev(script+'.click()');
const panel="document.querySelector('.meine-inbox-fenster')";
const byText=(selector,text)=>"Array.from("+selector+").find(e=>e.textContent.includes("+JSON.stringify(text)+"))";
const input=async(selector,value)=>ev("(()=>{const e="+selector+";Object.getOwnPropertyDescriptor("+(selector.includes('textarea')?'HTMLTextAreaElement':'HTMLInputElement')+".prototype,'value').set.call(e,"+JSON.stringify(value)+");e.dispatchEvent(new Event('input',{bubbles:true}));})()");
try {
  f=await userInboxFixture({quellenanmerkungen:true});
  // P22-T195 Folge t215: Migration166 ist live vorhanden; der Test muss denselben Speicher liefern, keine Antwort-Attrappe.
  const quellAntwort=await f.app.inject({method:'GET',url:'/api/agent-runtimes/anmerkungen/'+encodeURIComponent(f.P)+'/quelle/thought/'+f.T,
    headers:{authorization:'Bearer '+f.tokens.session}});
  const quellStand=quellAntwort.json();
  assert.equal(quellAntwort.statusCode,200,'P22-T195 Folge t215 quellenanmerkungen.ts/Schema166: Quellen-GET erwartet=200 ist='+quellAntwort.statusCode+' body='+quellAntwort.body);
  assert.equal(quellStand.quelle?.text,'P22-T192 Zitat-Beleg aus echter Testdatenbank','P22-T195 Folge t215: Quellen-GET liefert echten PG-Wortlaut');
  assert.deepEqual(quellStand.eintraege,[],'P22-T195 Folge t215: neue Quelle hat null Anmerkungen, keinen Ladefehler');
  console.log('P22_T195_SCHEMA166_BELEG '+JSON.stringify({status:quellAntwort.statusCode,project:f.P,art:'thought',id:f.T,text:quellStand.quelle.text,anmerkungen:quellStand.eintraege.length}));
  vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},
    optimizeDeps:{entries:['tests/user-inbox.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:f.url,headers:{authorization:'Bearer '+f.tokens.session}}}}});
  await vite.listen();
  const ablage=await screenshotAblage(repo,'p22-t192');
  const shot=async(name)=>{const r=await fetch(KB+'/screenshot?tab_id='+tab);assert.ok(r.ok);console.log('SCREENSHOT '+await ablage.speichere(name+'.png',Buffer.from(await r.arrayBuffer())));};
  tab=(await isolierterTab(kb,{url:'http://'+HOST+':'+vite.httpServer.address().port+'/tests/user-inbox.html'})).tab_id;
  await wait("document.querySelector('.meine-inbox-knopf')",'Button sichtbar');
  await click("document.querySelector('.meine-inbox-knopf')");
  await wait(panel+"?.innerText.includes('ausgeschaltet')",'Standard AUS');
  ok((await f.pool.query('SELECT count(*)::int n FROM specialist_inbox WHERE processed=false AND to_agent=$1',['user'])).rows[0].n===2,'Oeffnen bei AUS schreibt nichts');
  await shot('01-inbox-aus');
  await click(panel+".querySelector('footer input[type=checkbox]')");
  await wait("document.querySelectorAll('.meine-inbox-nachricht').length===3",'Inbox einschalten');
  ok(await ev("document.querySelector('.meine-inbox-knopf').textContent.includes('2')"),'globaler Ungelesen-Badge2',await ev(panel+'.innerText'));
  const ids=await ev("Array.from(document.querySelectorAll('.meine-inbox-nachricht'),n=>n.dataset.inboxId)");
  ok(ids.join()===[f.ids.c,f.ids.b,f.ids.a].join(),'alle Projekte neueste zuerst',ids);
  await click("document.querySelector('#projektwechsel')");
  ok(await ev("document.body.innerText.includes('Projekt Beta') && document.querySelectorAll('.meine-inbox-nachricht').length===3"),'Inbox bleibt bei Projektwechsel global');
  await shot('02-alle-projekte');
  const select=panel+".querySelector('select')";
  await ev(select+".value="+JSON.stringify(f.P)+";"+select+".dispatchEvent(new Event('change',{bubbles:true}))");
  await wait("document.querySelectorAll('.meine-inbox-nachricht').length===2",'Projektfilter Alfa');
  ok(!(await ev(panel+'.innerText')).includes('Antwort Beta aus anderem Projekt.'),'Filter trennt gleichnamige Agenten');
  const a="document.querySelector('[data-inbox-id="+JSON.stringify(f.ids.a)+"]')";
  await click(byText(a+".querySelectorAll('button')",'Als gelesen'));
  await wait("document.querySelector('.meine-inbox-knopf').textContent.includes('1')",'Badge nach gelesen');
  ok((await f.pool.query('SELECT processed FROM specialist_inbox WHERE id=$1',[f.ids.a])).rows[0].processed,'echter PUT macht genau A gelesen');
  await click(byText(a+".querySelectorAll('button')",'Als ungelesen'));
  await wait("document.querySelector('.meine-inbox-knopf').textContent.includes('2')",'Badge nach ungelesen');
  await click(byText(a+".querySelectorAll('button')",'Antworten'));
  await input(a+".querySelector('textarea')",'P22-T192 Browser-Antwort nur Alfa');
  await click(byText(a+".querySelectorAll('button')",'Antwort senden'));
  await wait(a+"?.innerText.includes('Gesendet an')",'Antwort bestaetigt');
  const antwort=(await f.pool.query("SELECT project,to_agent,to_identity_id,content FROM specialist_inbox WHERE from_agent='user' ORDER BY id DESC LIMIT 1")).rows[0];
  ok(antwort?.project===f.P && antwort.to_identity_id===f.A && antwort.content==='P22-T192 Browser-Antwort nur Alfa','echte Antwort trifft gespeicherten Absender',antwort);
  await wait(a+"?.querySelector('.zitat-karte-nachricht .verweis-link')",'Zitatkarte klickbar');
  await click(a+".querySelector('.zitat-karte-nachricht .verweis-link')");
  await wait("document.querySelector('.verweis-fenster')?.innerText.includes('Zitat-Beleg aus echter Testdatenbank')",'Zitat oeffnet echten PG-Beleg');
  ok(await ev("document.querySelector('.verweis-fenster').getBoundingClientRect().width>200"),'Lesefenster sichtbar ueber Inbox');
  await wait("document.querySelector('.verweis-inhalt')?.innerText.includes('P22-T192 Zitat-Beleg aus echter Testdatenbank') && !document.querySelector('.verweis-inhalt')?.innerText.includes('Lädt')",'Zitatinhalt fertig');
  // P22-T195 Folge t215: alter Test sah nur den Quelltext und uebersah den Fehler des nachgeladenen Anmerkungsbereichs.
  await wait("document.querySelector('.verweis-inhalt .quellen-anmerkungen-liste') && !document.querySelector('.verweis-inhalt [role=alert]')",'P22-T195 Folge t215 QuellenAnmerkungen mit Schema166 fertig, ohne Alert');
  ok(await ev("document.querySelector('.verweis-inhalt .quellen-anmerkungen-liste summary').textContent.includes('0 offene Anmerkungen') && !document.querySelector('.verweis-inhalt').innerText.includes('Anmerkungen konnten nicht geladen werden')"),
    'P22-T195 Folge t215 Lesefenster/QuellenAnmerkungen: echte leere PG-Liste sichtbar, kein Anmerkungsfehler',await ev("document.querySelector('.verweis-inhalt').innerText"));
  console.log('VERWEIS_WORTLAUT '+await ev("document.querySelector('.verweis-inhalt').innerText"));
  await new Promise(resolve=>setTimeout(resolve,400)); // DOM und Screenshot muessen denselben fertig gezeichneten Inhalt zeigen.
  await shot('03-antwort-und-zitat');
  await click("document.querySelector('.verweis-fenster button[aria-label=\"Fenster schließen\"]')");
  await wait(a+"?.querySelector('.meine-inbox-text .verweis-link')",'Textverweis erkannt');
  await click(a+".querySelector('.meine-inbox-text .verweis-link')");
  await wait("document.querySelector('.verweis-fenster')?.innerText.includes('Zitat-Beleg aus echter Testdatenbank')",'Textverweis oeffnet echten Beleg');
  ok(true,'Zitat und Textverweis wirklich angeklickt');
  await click("document.querySelector('.verweis-fenster button[aria-label=\"Fenster schließen\"]')");
  const original=(await f.pool.query('SELECT content FROM specialist_inbox WHERE id=$1',[f.ids.a])).rows[0].content;
  ok(original.startsWith('Antwort Alfa. Beleg thought '),'Antwort im Screenshot zusaetzlich direkt aus PG belegt',original);
  console.log('ANTWORT_WORTLAUT '+JSON.stringify(original));
  await ev(select+".value="+JSON.stringify(f.Q)+";"+select+".dispatchEvent(new Event('change',{bubbles:true}));const agent="+panel+".querySelectorAll('select')[1];agent.value='legacy-helfer';agent.dispatchEvent(new Event('change',{bubbles:true}));");
  await wait(panel+"?.innerText.includes('Keine Nachrichten')",'Leere Filterauswahl');
  ok(await ev(panel+".innerText.includes('Keine Nachrichten')"),'Leerzustand sichtbar');
  await shot('04-leerzustand');
  // Fehler provozieren, ohne Antwortinhalt zu simulieren: Backend wirklich schliessen, anschliessender GET muss fehlschlagen.
  await f.app.close();
  await click(byText(panel+".querySelectorAll('button')",'Aktualisieren'));
  await wait(panel+"?.querySelector('[role=alert]')",'API-Ausfall sichtbar');
  ok(await ev("document.querySelector('.meine-inbox-knopf').textContent.includes('?')"),'Ausfall zeigt keinen falschen Null-Zaehler');
  await shot('05-api-fehler');
  console.log('BESTANDEN '+checks+' P22-T192 Browser-Pruefungen; echte REST/PG, kein Inbox-Mock.');
} finally {if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});await vite?.close();await f?.close();}
