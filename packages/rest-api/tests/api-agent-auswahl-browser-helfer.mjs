/**
 * P22-T202 KI-Browser: reale REST-Vertraege gegen privates synapse_test-Schema, Anbieter als Fake.
 * Herkunft 90467652. Keine Live-Runtime, kein echter Key/Kostenaufruf. Eigener isolierter Tab, Cleanup im finally.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolierterTab,evaluateWert} from '../../../scripts/lib/ki-browser-isolation.mjs';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(new URL('../../../',import.meta.url).pathname);
export async function pruefeLaufwahlBrowser({C,pool,W,K,P,fetcher}){
 const KB='http://192.168.50.65:9222',req=createRequire(new URL('../package.json',import.meta.url)),uiReq=createRequire(new URL('../../web-ui/package.json',import.meta.url));
 let app,vite,tab,v;const bilder=[];let checks=0;
 const kb=async(path,body)=>{const r=await fetcher(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert(d.success,JSON.stringify(d));return d.data;};
 const ev=async script=>evaluateWert(await kb('/evaluate',{tab_id:tab,script}));
 const wait=async(fn,label)=>{const ende=Date.now()+25000;while(Date.now()<ende){if(await fn())return;await new Promise(r=>setTimeout(r,200));}throw Error('P22-T202 Browser Timeout '+label);};
 const ok=(x,label,actual)=>{checks++;assert.ok(x,'P22-T202 ApiAgentLaufwahl.tsx '+label+' | erwartet wahr / tatsächlich '+JSON.stringify(actual??x));};
 const click=async(text,scope='document')=>ev("(()=>{const b=[...("+scope+").querySelectorAll('button')].find(b=>b.textContent.trim()==="+JSON.stringify(text)+");if(!b)return 'fehlt';if(b.disabled)return 'gesperrt';b.click();return 'ok'})()");
 const set=async(sel,value,proto='HTMLInputElement',event='input')=>ev("(()=>{const e=document.querySelector("+JSON.stringify(sel)+");Object.getOwnPropertyDescriptor("+proto+".prototype,'value').set.call(e,"+JSON.stringify(value)+");e.dispatchEvent(new Event("+JSON.stringify(event)+",{bubbles:true}));return true})()");
 const shot=async(name)=>{const a=await screenshotAblage(repo,'p22-t202');const r=await fetcher(KB+'/screenshot?tab_id='+tab);assert(r.ok);const p=await a.speichere(name+'.png',Buffer.from(await r.arrayBuffer()));bilder.push(p);console.log('SCREENSHOT '+p);};
 try{
  process.env.SYNAPSE_AUTH_DISABLED='1';process.env.DOCKER_SOCKET='/nicht/vorhanden/docker.sock';
  await pool.query("UPDATE api_agent_laeufe SET status='gestoppt',lease_token=NULL,lease_bis=NULL");
  await pool.query('UPDATE api_agent_eingang SET erledigt_am=NOW()');
  for(const alias of ['api-haiku','api-sonnet'])await pool.query(`INSERT INTO model_registry(alias,full_id,provider,context_window,output_limit,corridor_min,corridor_max,pricing_input_usd_per_mtok,pricing_output_usd_per_mtok)
    VALUES($1,$1,'anthropic-api',200000,1000,70,88,1,5)`,[alias]);
  await C.entferneApiBudget({art:'user'},{grund:'T202 Browser zeigt fehlendes Budget'});
  await C.setzeApiFreigabe({art:'user'},{identity_id:K.identity_id,modelle:['or-deepseek-chat'],grenze_usd:0.05,grund:'T202 Browser Koordinator explizit'});
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'plattform_agent_chat',aktiv:true,grund:'T202 Browser bestehendes Chatfenster'},{system:'user'});
  const {agentRuntimeRoutes}=await import('../dist/routes/agent-runtimes.js');
  app=req('fastify')({logger:false});await app.register(agentRuntimeRoutes);await app.listen({host:'127.0.0.1',port:0});
  // CLI-Katalog nicht benutzt: API-Wahl muss ohne CLI-Login erreichbar bleiben.
  const {LaufVerwaltung}=await import('../dist/services/api-agent-lauf.js');
  v=new LaufVerwaltung({db:pool,liste:async()=>[],ausweis:async()=>W.token,
   aufruf:async()=>({content:[{type:'text',text:'T202 Browser Anmeldung Testprofil'}]}),
   transport:async a=>({anbieter:'openrouter-api',antwort:{inhalt:[{typ:'text',text:'BROWSER-T202-ANTWORT: Auftrag beantwortet.'}],stop:'ende',stop_roh:null,
    nutzung:{input:100,output:8,cache_read:0,cache_creation:0},kosten_usd:0.001},kosten:{usd:0.001,usd_quelle:'antwort'},rest_usd:0.099,kontext_tokens:100})});
  v.starte();
  const {createServer}=await import(pathToFileURL(join(dirname(uiReq.resolve('vite/package.json')),'dist/node/index.js')).href);
  vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},
   optimizeDeps:{entries:['tests/api-agent-auswahl.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:'http://127.0.0.1:'+app.server.address().port}}}});
  await vite.listen();
  const url='http://192.168.50.10:'+vite.httpServer.address().port+'/tests/api-agent-auswahl.html?project='+P+'&worker='+W.identity_id+'&koord='+K.identity_id;
  tab=(await isolierterTab(kb,{url})).tab_id;
  await wait(()=>ev("!!document.querySelector('[data-test-agent=worker] .api-agent-laufwahl button')"),'Laufwahl geladen');
  const open=async(role)=>{await ev("(()=>{const b=[...document.querySelector('[data-test-agent="+role+"]').querySelectorAll('button')].find(b=>b.textContent.startsWith('Laufart / Modell'));b.click();return true})()");await wait(()=>ev("!!document.querySelector('[role=dialog]')"),'Dialog '+role);};
  await open('worker');
  await set('[role=dialog] select:nth-of-type(1)','api','HTMLSelectElement','change');
  await set('[role=dialog] label:nth-of-type(3) select','or-deepseek-chat','HTMLSelectElement','change');
  await wait(()=>ev("document.querySelector('[role=dialog]').innerText.includes('Kein API-Budget')"),'Budgethinweis');
  ok((await click('API-Agent starten'))==='gesperrt','ohne Budget kein Start');
  await shot('01-budget-fehlt');
  await click('Einstellungen > API-Agenten');
  await wait(()=>ev("!!document.querySelector('[data-test-settings]')"),'Einstellungen-Link');
  // Das reale Budgetformular setzt nur auf ausdruecklichen Klick ein kleines Testbudget.
  await wait(()=>ev("!!document.querySelector('[data-test-settings] [data-api-budget=fehlt]')"),'Budgetformular');
  await set('[data-test-settings] .cp-setting-field.wide input','T202 Browser ausdrückliches Kleinbudget');
  await ev("(()=>{const b=[...document.querySelectorAll('[data-test-settings] label')].find(l=>l.innerText.includes('Grenze (USD)')).querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(b,'0.1');b.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
  await ev("(()=>{for(const l of document.querySelectorAll('[data-test-settings] label.cp-haken')){const e=l.querySelector('input');if(e.checked!==l.innerText.includes('or-deepseek-chat'))e.click();}return true})()");
  await click('Budget setzen',"document.querySelector('[data-test-settings]')");
  await wait(()=>ev("!!document.querySelector('[data-test-settings] [data-api-budget=gesetzt]')"),'kleines Budget gesetzt');
  const start=async(role)=>{
    await open(role);
    const selects=await ev("[...document.querySelectorAll('[role=dialog] select')].map(x=>x.outerHTML)");
    await ev("(()=>{const s=document.querySelector('[role=dialog] select');s.value='api';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
    await wait(()=>ev("document.querySelectorAll('[role=dialog] select').length===3"),'API-Anbieter/Modell');
    await ev("(()=>{const s=document.querySelectorAll('[role=dialog] select')[2];s.value='or-deepseek-chat';s.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
    await set('[role=dialog] textarea','Browser-T202 '+role+' Originalauftrag','HTMLTextAreaElement');
    await ev("(()=>{const e=[...document.querySelectorAll('[role=dialog] input')].find(x=>x.type!=='checkbox');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'T202 User beauftragt '+Date.now());e.dispatchEvent(new Event('input',{bubbles:true}));for(const c of document.querySelectorAll('[role=dialog] input[type=checkbox]'))if(!c.checked)c.click();return true})()");
    await click('Status neu abfragen',"document.querySelector('[role=dialog]')");
    await wait(()=>ev("[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent==='API-Agent starten'&&!b.disabled)"),'bezahlter Start bereit '+role);
    await shot('02-freigabe-'+role);
    ok(await click('API-Agent starten')==='ok','expliziter Start '+role);
    await wait(()=>ev("!document.querySelector('[role=dialog]')"),'Start eingereiht '+role);
  };
  for(const role of ['worker','koord','main'])await start(role);
  await wait(()=>ev("document.querySelector('[data-test-chat]').innerText.includes('BROWSER-T202-ANTWORT')"),'Antwort im vorhandenen Chat sichtbar');
  const neu=await ev("[...document.querySelectorAll('[data-test-chat] button')].find(b=>/neue Antworten/.test(b.textContent))?.textContent??''");
  if(neu)await click(neu,"document.querySelector('[data-test-chat]')");
  await ev("(()=>{const a=[...document.querySelectorAll('[data-test-chat] article')].find(a=>a.innerText.includes('BROWSER-T202-ANTWORT'));a?.scrollIntoView({block:'center',behavior:'instant'});return !!a})()");
  await wait(()=>ev("(()=>{const a=[...document.querySelectorAll('[data-test-chat] article')].find(a=>a.innerText.includes('BROWSER-T202-ANTWORT'));const r=a?.getBoundingClientRect();return !!r&&r.top>=0&&r.bottom<=innerHeight})()"),'Antwort im sichtbaren Bild');
  await ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  await shot('03-antwort-sichtbar');
  const antwort=await ev("document.querySelector('[data-test-chat]').innerText");
  const imBild=await ev("(()=>{const a=[...document.querySelectorAll('[data-test-chat] article')].find(a=>a.innerText.includes('BROWSER-T202-ANTWORT'));const r=a?.getBoundingClientRect();return !!r&&r.top>=0&&r.bottom<=innerHeight})()");
  ok(imBild&&antwort.includes('BROWSER-T202-ANTWORT: Auftrag beantwortet.'),'Antwort wirklich im sichtbaren Bild',antwort.slice(-500));
  const belege=(await pool.query("SELECT identity_id,text FROM hauptagent_verlauf WHERE meta->>'quelle'='api' AND text LIKE 'BROWSER-T202-ANTWORT%'")).rows;
  ok(belege.some(z=>z.identity_id===W.identity_id)&&belege.some(z=>z.identity_id===K.identity_id),'Antworten maschinell in PG belegt',belege);
  await click('Stop',"document.querySelector('[data-test-agent=worker]')");
  await wait(async()=>((await pool.query('SELECT status FROM api_agent_laeufe WHERE identity_id=$1',[W.identity_id])).rows[0]?.status)==='gestoppt','Stop des API-Laufs');
  ok((await pool.query("SELECT count(*)::int n FROM specialist_jobs WHERE action IN ('spawn','spawn_batch')")).rows[0].n===0,'API-Stop startet keine CLI');
  ok((await C.leseApiBudget()).grenze_usd===0.1,'Budget unveraendert klein');
  ok((await ev('window.__fehler')).length===0,'keine Browserfehler',await ev('window.__fehler'));
  console.log('P22-T202 BROWSER '+checks+' grün; Antwort wörtlich: BROWSER-T202-ANTWORT: Auftrag beantwortet.; Fake-Anbieter, keine echten Kosten.');
  return {checks,bilder};
 }finally{
  if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
  await v?.beende();await vite?.close();await app?.close();
 }
}
