/**
 * P22-T278 KI-Browser: Laufwahl -> Anbieter "DeepSeek direkt" -> ds-flash -> Start -> sichtbarer Anbieterfehler 401 -> Stop.
 * Herkunft: thought 40f496c6 (User 08.11.2026: ohne Key bauen, 401-Weg sichtbar pruefen; bezahlter Mini-Turn erst spaeter durch den User).
 * Reale REST-Vertraege (agentRuntimeRoutes) gegen das private synapse_test-Schema, ECHTER Transport rufeApiTransport mit ungueltigem Key;
 * Ziel = echter DeepSeek-Endpunkt (echt:true) oder der lokale 401-Fake des Aufrufers. Kein gueltiger Key, keine Kosten.
 * Eigener isolierter Tab, Cleanup im finally. Aufruf aus api-deepseek-direkt-p22-t278.test.mjs --browser [--echt-401].
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isolierterTab,evaluateWert} from '../../../scripts/lib/ki-browser-isolation.mjs';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const repo=resolve(new URL('../../../',import.meta.url).pathname);
export async function pruefeDeepseekBrowser({C,pool,B,K,P,fetcher,key,echt}){
 const KB='http://192.168.50.65:9222',req=createRequire(new URL('../package.json',import.meta.url)),uiReq=createRequire(new URL('../../web-ui/package.json',import.meta.url));
 let app,vite,tab,v,basisVorher=null;const bilder=[];let checks=0;const zaehler={n:0};
 const kb=async(path,body)=>{const r=await fetcher(KB+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();assert(d.success,JSON.stringify(d));return d.data;};
 const ev=async script=>evaluateWert(await kb('/evaluate',{tab_id:tab,script}));
 const wait=async(fn,label,ms=30000)=>{const ende=Date.now()+ms;while(Date.now()<ende){if(await fn())return;await new Promise(r=>setTimeout(r,250));}throw Error('P22-T278 Browser Timeout '+label);};
 const ok=(x,label,actual)=>{checks++;assert.ok(x,'P22-T278 ApiAgentLaufwahl.tsx '+label+' | erwartet wahr / tatsächlich '+JSON.stringify(actual??x));};
 const click=async(text,scope='document')=>ev("(()=>{const b=[...("+scope+").querySelectorAll('button')].find(b=>b.textContent.trim()==="+JSON.stringify(text)+");if(!b)return 'fehlt';if(b.disabled)return 'gesperrt';b.click();return 'ok'})()");
 const shot=async(name)=>{const a=await screenshotAblage(repo,'p22-t278');const r=await fetcher(KB+'/screenshot?tab_id='+tab);assert(r.ok);const p=await a.speichere(name+'.png',Buffer.from(await r.arrayBuffer()));bilder.push(p);console.log('SCREENSHOT '+p);};
 const sel=(i,wert)=>ev("(()=>{const s=document.querySelectorAll('[role=dialog] select')["+i+"];if(!s||![...s.options].some(o=>o.value==="+JSON.stringify(wert)+"))return false;"
  +"Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s,"+JSON.stringify(wert)+");s.dispatchEvent(new Event('change',{bubbles:true}));return true})()");
 const worker="document.querySelector('[data-test-agent=worker]')";
 const status=async()=>(await pool.query('SELECT status FROM api_agent_laeufe WHERE identity_id=$1',[B.identity_id])).rows[0]?.status;
 try{
  process.env.SYNAPSE_AUTH_DISABLED='1';process.env.DOCKER_SOCKET='/nicht/vorhanden/docker.sock';
  if(echt){basisVorher=process.env.SYNAPSE_DEEPSEEK_BASE_URL??null;delete process.env.SYNAPSE_DEEPSEEK_BASE_URL;}
  await pool.query("UPDATE api_agent_laeufe SET status='gestoppt',lease_token=NULL,lease_bis=NULL");
  await pool.query('UPDATE api_agent_eingang SET erledigt_am=NOW() WHERE erledigt_am IS NULL');
  const {agentRuntimeRoutes}=await import('../dist/routes/agent-runtimes.js');
  app=req('fastify')({logger:false});await app.register(agentRuntimeRoutes);await app.listen({host:'127.0.0.1',port:0});
  const T=await import('../dist/services/api-agent-transport.js');
  const {LaufVerwaltung}=await import('../dist/services/api-agent-lauf.js');
  v=new LaufVerwaltung({db:pool,liste:async()=>[],ausweis:async()=>B.token,
   aufruf:async()=>({content:[{type:'text',text:'T278 Browser Anmeldung Testprofil'}]}),
   transport:a=>{zaehler.n++;return T.rufeApiTransport({...a,holen:fetcher});}});
  v.starte();
  const {createServer}=await import(pathToFileURL(join(dirname(uiReq.resolve('vite/package.json')),'dist/node/index.js')).href);
  vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},
   optimizeDeps:{entries:['tests/api-agent-auswahl.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:'http://127.0.0.1:'+app.server.address().port}}}});
  await vite.listen();
  const url='http://192.168.50.10:'+vite.httpServer.address().port+'/tests/api-agent-auswahl.html?project='+P+'&worker='+B.identity_id+'&koord='+K.identity_id;
  tab=(await isolierterTab(kb,{url})).tab_id;
  await wait(()=>ev("!!"+worker+"?.querySelector('.api-agent-laufwahl button')"),'Laufwahl geladen');
  await ev("(()=>{const b=[..."+worker+".querySelectorAll('button')].find(b=>b.textContent.startsWith('Laufart / Modell'));b.click();return true})()");
  await wait(()=>ev("!!document.querySelector('[role=dialog]')"),'Dialog');
  await wait(()=>sel(0,'api'),'Laufart API');
  await wait(()=>ev("document.querySelectorAll('[role=dialog] select').length===3"),'Anbieter und Modell');
  await wait(()=>sel(1,'deepseek-api'),'Anbieter DeepSeek direkt');
  await wait(()=>ev("document.querySelector('[role=dialog]').innerText.includes('api_deepseek_direkt: EIN')"),'Schalter EIN sichtbar');
  ok(await ev("document.querySelector('[role=dialog]').innerText.includes('SYNAPSE_DEEPSEEK_API_KEY')"),'Key-Status mit Quelle sichtbar');
  await wait(()=>sel(2,'ds-flash'),'Modell ds-flash');
  await ev("(()=>{const e=document.querySelector('[role=dialog] textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Browser-T278 Originalauftrag (Key ungueltig)');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()");
  await ev("(()=>{const e=[...document.querySelectorAll('[role=dialog] input')].find(x=>x.type!=='checkbox');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'T278 User prueft den 401-Weg '+Date.now());e.dispatchEvent(new Event('input',{bubbles:true}));for(const c of document.querySelectorAll('[role=dialog] input[type=checkbox]'))if(!c.checked)c.click();return true})()");
  await click('Status neu abfragen',"document.querySelector('[role=dialog]')");
  await wait(()=>ev("[...document.querySelectorAll('[role=dialog] button')].some(b=>b.textContent==='API-Agent starten'&&!b.disabled)"),'Start bereit');
  ok(!(await ev('document.body.innerHTML.includes('+JSON.stringify(key)+')')),'Key-Wert nie im DOM');
  await shot('01-deepseek-auswahl');
  ok(await click('API-Agent starten')==='ok','Start DeepSeek direkt');
  await wait(()=>ev("!document.querySelector('[role=dialog]')"),'Start eingereiht');
  await wait(async()=>(await status())==='fehler','Lauf Status fehler nach 401',60000);
  await click('Status neu abfragen',worker);
  await wait(()=>ev(worker+".innerText.includes('api_zugang_ungueltig')"),'Anbieterfehler in der Laufanzeige');
  const text=await ev(worker+'.innerText');
  ok(text.includes('HTTP 401')&&text.includes('DeepSeek hat den API-Key abgelehnt')&&text.includes('fehler'),'Anbietermeldung HTTP 401 und Status sichtbar',text.slice(0,900));
  await ev("(()=>{"+worker+".scrollIntoView({block:'start',behavior:'instant'});return true})()");
  await shot('02-401-sichtbar');
  const n=zaehler.n;await new Promise(r=>setTimeout(r,6000));
  ok(n===1&&zaehler.n===1,'kein Wiederholungssturm (genau ein Anbieteraufruf in 6 s)',{vorher:n,nachher:zaehler.n});
  ok(await click('Stop',worker)==='ok','Stop geklickt');
  await wait(async()=>(await status())==='gestoppt','Stop des Laufs');
  await click('Status neu abfragen',worker);
  await wait(()=>ev(worker+".innerText.includes('gestoppt')"),'gestoppt sichtbar');
  await shot('03-gestoppt');
  ok((await pool.query("SELECT count(*)::int n FROM specialist_jobs WHERE action IN ('spawn','spawn_batch')")).rows[0].n===0,'API-Stop startet keine CLI');
  const r=(await pool.query("SELECT status,usd::float8 AS usd,fehler FROM api_agent_reservierungen WHERE identity_id=$1 ORDER BY erstellt_am DESC LIMIT 1",[B.identity_id])).rows[0];
  ok(r?.status==='freigegeben'&&r.usd===0&&String(r.fehler).startsWith('HTTP 401'),'nichts berechnet (Reservierung freigegeben)',r);
  ok((await ev('window.__fehler')).length===0,'keine Browserfehler',await ev('window.__fehler'));
  console.log('P22-T278 BROWSER Anbieterziel: '+(echt?'https://api.deepseek.com (echt)':'lokaler 401-Fake')+'; Laufanzeige: '+text.replace(/\s+/g,' ').slice(0,400));
  return {checks,bilder,text};
 }finally{
  if(tab)await kb('/tabs/close',{tab_id:tab}).catch(()=>{});
  await v?.beende();await vite?.close();await app?.close();
  if(echt&&basisVorher!==null)process.env.SYNAPSE_DEEPSEEK_BASE_URL=basisVorher;
 }
}
