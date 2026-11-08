/**
 * P22-T278 KI-Browser-Sichtpruefung (Auftrag team-lead nach thought 20df2a71): Verbrauchsanzeige mit DeepSeek als Chatpartner (Laufanzeige
 * der Laufwahl: Cache-Treffer/-Fehlschuss/Ausgabe, Cache-Quote %, Kosten, Tarif), Panel API-Laeufe (Hintergrundlauf) und sichtbarer
 * Rueckfall "Tageslimit erreicht" -> haiku im Chat. Werte = echte usage aus dem Mini-Turn D (api-deepseek-direkt-p22-t278.test.mjs
 * --echt-turn --browser-verbrauch). Rueckfall mit Fake-Transport (budget_erschoepft) und Fake-Spawn (haiku startet), kein Container.
 * Reale REST-Vertraege (agentRuntimeRoutes) gegen das private synapse_test-Schema, eigener isolierter Tab, Cleanup im finally.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolierterTab,evaluateWert} from '../../../scripts/lib/ki-browser-isolation.mjs';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(new URL('../../../',import.meta.url).pathname);
export async function pruefeVerbrauchBrowser({C,A,L,pool,P,E,K,USER,vor,fetcher,erwartet}){
 const KB='http://192.168.50.65:9222',req=createRequire(new URL('../package.json',import.meta.url)),uiReq=createRequire(new URL('../../web-ui/package.json',import.meta.url));
 let app,vite,tab;const bilder=[];const texte={};let checks=0;
 const kb=async(path,body)=>{const r=await fetcher(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert(d.success,JSON.stringify(d));return d.data;};
 const ev=async script=>evaluateWert(await kb('/evaluate',{tab_id:tab,script}));
 const wait=async(fn,label,ms=30000)=>{const ende=Date.now()+ms;while(Date.now()<ende){if(await fn())return;await new Promise(r=>setTimeout(r,250));}throw Error('P22-T278 Browser Timeout '+label);};
 const ok=(x,label,actual)=>{checks++;assert.ok(x,'P22-T278 Verbrauch/Rueckfall '+label+' | erwartet wahr / tatsaechlich '+JSON.stringify(actual??x));};
 const click=async(text,scope='document')=>ev("(()=>{const b=[...("+scope+").querySelectorAll('button')].find(b=>b.textContent.trim()==="+JSON.stringify(text)+");if(!b)return 'fehlt';if(b.disabled)return 'gesperrt';b.click();return 'ok'})()");
 const shot=async(name)=>{const a=await screenshotAblage(repo,'p22-t278');const r=await fetcher(KB+'/screenshot?tab_id='+tab);assert(r.ok);const p=await a.speichere(name+'.png',Buffer.from(await r.arrayBuffer()));bilder.push(p);console.log('SCREENSHOT '+p);};
 const worker="document.querySelector('[data-test-agent=worker]')",koord="document.querySelector('[data-test-agent=koord]')";
 try{
  process.env.SYNAPSE_AUTH_DISABLED='1';process.env.DOCKER_SOCKET='/nicht/vorhanden/docker.sock';
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'plattform_agent_chat',aktiv:true,grund:'T278 Browser bestehendes Chatfenster'},{system:'user'});
  // Rueckfall-Lauf: DeepSeek-Arbeitsagent H, Tageslimit erreicht (Fake), Rueckfall startet haiku (Fake-Spawn).
  const H=await vor('t278-rueckfall','subagent');
  await C.setzeApiFreigabe(USER,{identity_id:H.identity_id,modelle:['ds-flash'],grenze_usd:0.05,grund:'T278 Browser Rueckfall-Agent'});
  await A.starteApiAuswahl({identity_id:H.identity_id,modell:'ds-flash',auftrag:'T278 Rueckfall-Auftrag fuer die Sichtpruefung.',grund:'T278 Browser Rueckfall',
   kosten_bestaetigt:true,wechsel_bestaetigt:true,idempotenz_schluessel:randomUUID()},USER);
  const spawns=[];
  const vr=new L.LaufVerwaltung({db:pool,liste:async()=>[],ausweis:async()=>H.token,aufruf:async()=>({content:[{type:'text',text:'T278 Rueckfall Anmeldung'}]}),
   transport:async()=>{throw Object.assign(Error('Budget erschoepft'),{code:'budget_erschoepft'});},
   rueckfall:async a=>{spawns.push(a.model);return {success:true,runtime:'claude'};}});
  try{await vr.takt();await vr.warteAufTurns();}finally{await vr.beende();}
  ok(spawns[0]==='haiku','Rueckfall startet haiku (erstes Modell der Kette)',spawns);
  const {agentRuntimeRoutes}=await import('../dist/routes/agent-runtimes.js');
  app=req('fastify')({logger:false});await app.register(agentRuntimeRoutes);await app.listen({host:'127.0.0.1',port:0});
  const {createServer}=await import(pathToFileURL(join(dirname(uiReq.resolve('vite/package.json')),'dist/node/index.js')).href);
  vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},
   optimizeDeps:{entries:['tests/api-agent-auswahl.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:'http://127.0.0.1:'+app.server.address().port}}}});
  await vite.listen();
  const basis='http://192.168.50.10:'+vite.httpServer.address().port+'/tests/api-agent-auswahl.html?project='+P;
  tab=(await isolierterTab(kb,{url:basis+'&worker='+E.identity_id+'&koord='+H.identity_id})).tab_id;
  // 1) Laufanzeige mit DeepSeek als Chatpartner (echte Werte aus D).
  await wait(()=>ev("!!"+worker+"?.querySelector('.api-agent-laufwahl button')"),'Laufwahl geladen');
  await click('Status neu abfragen',worker);await click('Status neu abfragen',koord);
  await wait(()=>ev(worker+".innerText.includes('Cache-Quote')"),'Verbrauch in der Laufanzeige');
  await wait(()=>ev("document.querySelector('[data-test-chat]').innerText.includes('T278-ECHT-2')"),'Antworten im Chat');
  texte.laufanzeige=await ev(worker+".querySelector('[data-verbrauch]').innerText");
  texte.laufzeile=await ev(worker+".querySelector('[role=status]')?.innerText??''");
  const quote=Math.round(erwartet.hits/(erwartet.hits+erwartet.miss)*100);
  ok(texte.laufanzeige.includes('heute: Cache-Treffer '+erwartet.hits.toLocaleString('de-DE'))&&texte.laufanzeige.includes('Fehlschuss '+erwartet.miss.toLocaleString('de-DE'))
   &&texte.laufanzeige.includes('Cache-Quote '+quote+' %')&&/Tarif jetzt: (Nebenzeit|Spitzenzeit)/.test(texte.laufanzeige),'Laufanzeige: Treffer/Fehlschuss/Quote/Tarif = echte Werte',texte.laufanzeige);
  // Nach dem Rueckfall ist die API-Wahl frei: die Laufwahl zeigt keinen API-Lauf mehr (gewollt); der Lauf steht im Panel API-Laeufe.
  texte.koord=await ev(koord+'.innerText');
  ok(!texte.koord.includes('API · deepseek-api'),'Rueckfall-Agent: Laufwahl zeigt keinen API-Lauf mehr (Wahl frei)',texte.koord.slice(0,300));
  await ev("(()=>{"+worker+".scrollIntoView({block:'start',behavior:'instant'});return true})()");
  await shot('04-verbrauch-laufanzeige');
  // 2) Panel API-Laeufe (Einstellungen > API-Agenten), Hintergrundlaeufe.
  await ev("(()=>{window.dispatchEvent(new CustomEvent('synapse:ausweis-oeffnen',{detail:{project:"+JSON.stringify(P)+",agentId:'',bereich:'api'}}));return true})()");
  await wait(()=>ev("!!document.querySelector('[data-test-settings] section[aria-label=\"API-Läufe\"] [data-verbrauch]')"),'API-Laeufe-Panel mit Verbrauch');
  texte.panel=await ev("[...document.querySelectorAll('[data-test-settings] section[aria-label=\"API-Läufe\"] article')].map(a=>a.innerText).join('\\n---\\n')");
  ok(texte.panel.includes('t278-echt')&&texte.panel.includes('Cache-Quote '+quote+' %'),'Panel API-Laeufe: Hintergrundlauf mit Verbrauch und Cache-Quote',texte.panel.slice(0,900));
  const rk=texte.panel.split('---').find(t=>t.includes('t278-rueckfall'))??'';
  ok(rk.includes('gestoppt')&&rk.includes('Tageslimit erreicht')&&rk.includes('weiter im CLI-Abo mit haiku')&&!rk.includes('rueckfall_container'),'e: Panel zeigt den Rueckfall als Klartext mit haiku',rk.slice(0,600));
  const rm=texte.panel.split('---').find(t=>t.includes('hauptagent'))??'';
  ok(rm.includes('weiter im CLI-Abo mit haiku')&&!rm.includes('rueckfall_container'),'c: Main-Rueckfall nennt haiku',rm.slice(0,600));
  texte.titel=await ev("document.querySelector('[data-test-settings] h3')?.innerText??''");
  ok(texte.titel.includes('DeepSeek'),'b: Panel-Titel nennt DeepSeek',texte.titel);
  texte.rueckfall_feld=await ev("document.querySelector('[data-test-settings] [data-api-rueckfall]')?.innerText??''");
  ok(texte.rueckfall_feld.includes('haiku'),'Panel: Rueckfall-Kette sichtbar',texte.rueckfall_feld);
  // Fuer das Bild nur den Einstellungsbereich zeigen (die Seite scrollt im KI-Browser nicht zuverlaessig bis ganz unten).
  await ev("(()=>{for(const e of document.querySelectorAll('[data-test-agent],[data-test-chat],main>h1'))e.style.display='none';window.scrollTo(0,0);return true})()");
  await ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await shot('05-api-laeufe-panel');
  // 3) Rueckfall im Chat des Rueckfall-Agenten.
  await kb('/navigate',{tab_id:tab,url:basis+'&worker='+H.identity_id+'&koord='+K.identity_id});
  await wait(()=>ev("!!document.querySelector('[data-test-chat]')&&document.querySelector('[data-test-chat]').innerText.includes('Tageslimit erreicht')"),'Rueckfall im Chat');
  texte.chat=await ev("[...document.querySelectorAll('[data-test-chat] article')].map(a=>a.innerText).filter(t=>t.includes('Tageslimit')).join(' | ')");
  ok(texte.chat.includes('weiter mit haiku'),'Chat: Tageslimit erreicht -> weiter mit haiku',texte.chat);
  const uhr=d=>d.toLocaleString('de-DE',{timeZone:'Europe/Berlin',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  const jetzt=new Date(),erlaubt=[0,1,2].map(m=>uhr(new Date(jetzt.getTime()-m*60_000)));
  texte.browser_zeitzone=await ev("JSON.stringify({tz:Intl.DateTimeFormat().resolvedOptions().timeZone,offset:new Date().getTimezoneOffset()})");
  ok(erlaubt.some(z=>texte.chat.includes(z)),'d: Chat-Uhrzeit in Ortszeit Europe/Berlin trotz Browser-Zeitzone',{chat:texte.chat,erlaubt,browser:texte.browser_zeitzone});
  await ev("(()=>{const a=[...document.querySelectorAll('[data-test-chat] article')].find(a=>a.innerText.includes('Tageslimit'));a?.scrollIntoView({block:'center',behavior:'instant'});return true})()");
  await ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await shot('06-rueckfall-haiku-chat');
  ok((await ev('window.__fehler')).length===0,'keine Browserfehler',await ev('window.__fehler'));
  return {checks,bilder,texte};
 }finally{
  if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
  await vite?.close();await app?.close();
 }
}
