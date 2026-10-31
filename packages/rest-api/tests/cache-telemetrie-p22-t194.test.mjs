/**
 * P22-T194 / 29298,29325,29336: cache_waechter PG/Tray-REST/Chatstatus + optionaler KI-Browser.
 * Echte Migration167, eigenes Schema NUR synapse_test:5433, echte REST/Auth-Lesewege.
 * Tray-Auth und Ausweispruefer gezielte Eingangsattrappen; Cache-Dienst/SQL/Host-Ableitung echt.
 * Keine Runtime-Aktion/Modellkosten. --browser: eigene Tabs, eigene Server, Cleanup.
 */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {isolierterTab,evaluateWert} from '../../../scripts/lib/ki-browser-isolation.mjs';
import {screenshotAblage} from '../../../scripts/lib/ui-screenshots.mjs';
const url=new URL(process.env.SYNAPSE_DATABASE_URL||process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'1'});
const req=createRequire(new URL('../package.json',import.meta.url)),coreReq=createRequire(new URL('../../core/package.json',import.meta.url)),{Pool}=coreReq('pg'),Fastify=req('fastify'),ts=coreReq('typescript');
const admin=new Pool({connectionString:url.href}),schema='p22_t194tele_'+randomUUID().replaceAll('-','');
const id=randomUUID(),id2=randomUUID(),sid=randomUUID(),lauf=randomUUID(),P='p22-t194tele',ausweis='sai_fixture194';
const host='test-tray',daemon='daemon-test-tray-194',now=Date.now();
let C,pool,app,vite,tab,checks=0,outage=false;
const ok=(v,label,ist=v)=>{assert.ok(v,'P22-T194 '+label+' | erwartet=true | ist='+JSON.stringify(ist));checks++;console.log('OK '+label);};
const messung=(extra={})=>({modell:'haiku',request_id:'msg-test',messung_ms:now,request_beginn_ms:now-301000,nutzungsmessung_ms:now-300000,input:2,output:4,gelesen:10414,geschrieben:62,kontext_tokens:10478,ttl_klassen:['5m'],ttl_quelle:'transcript',cli_version:'2.1.310',mod_version:'0.3.0',...extra});
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const t of ['agent_identitaeten','agent_identitaet_laeufe','agent_profil_schalter','intern_schalter','auth_tokens','agent_identitaet_wrapper_status']){
  await admin.query('CREATE TABLE '+schema+'.'+t+' (LIKE public.'+t+' INCLUDING ALL)');
 }
 const seqs=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema]);
 for(const [i,r]of seqs.rows.entries()){const s='seq'+i;await admin.query('CREATE SEQUENCE '+schema+'.'+s);await admin.query('ALTER TABLE '+schema+'.'+r.table_name+' ALTER COLUMN '+r.column_name+" SET DEFAULT nextval('"+schema+'.'+s+"'::regclass)");}
 url.searchParams.set('options','-c search_path='+schema);process.env.DATABASE_URL=url.href;
 C=await import('../../core/dist/index.js');pool=C.getPool();await pool.query(C.CACHE_WAECHTER_SCHEMA_SQL);
 await pool.query("INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,erstellt_von) VALUES($1,$3,'Telemetrie A','Telemetrie A','koordinator','P22-T194 Test'),($2,$3,'Telemetrie B','Telemetrie B','koordinator','P22-T194 Test')",[id,id2,P]);
 await pool.query("INSERT INTO agent_identitaet_laeufe(id,identity_id,context_epoch,status) VALUES($1,$2,1,'aktiv')",[lauf,id]);
 const origin={weg:'tray_daemon',host,daemon_id:daemon,runtime:'claude',lauf_art:'cli'};
 const melden=m=>C.meldeCacheWaechter({identity_id:id,lauf_id:lauf,sitzung:sid,herkunft:origin,messung:m});
 const set=async aktiv=>{await pool.query("DELETE FROM agent_profil_schalter WHERE funktion='cache_waechter'");await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'cache_waechter',$2,'Test','user')",[P,aktiv]);};
 ok(!(await C.cacheWaechterSchalter(P)).aktiv,'cache-waechter.ts Standard AUS');
 ok(!(await melden(messung())).angenommen,'AUS keine Speicherung');
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',null,'alle',true,'Test','user')");
 ok(!(await C.cacheWaechterSchalter(P)).aktiv,'alle gibt Cachewaechter nicht frei');
 await set(true);ok((await melden(messung())).angenommen,'Tray-Quelle gespeichert');
 let s=await C.leseCacheWaechterStand(id);
 ok(s.stand.status==='zeit_schaetzung_abgelaufen'&&s.stand.letzte_messung.status==='cache_genutzt','1943060d abgelaufene Uhr ist kein Kalt-Beleg',s.stand);
 ok(s.stand.kosten.kalt_usd===null&&s.stand.automatischer_neustart===false&&s.stand.naechste_zustellung==='unveraendert','kein fingierter Kostentarif oder Neustart');
 const zeit=C.cacheZeitStand;
 ok(zeit(messung({ttl_klassen:[]})).wahrscheinlich_teuer_ab===null,'TTL unbekannt bleibt unbekannt');
 ok(zeit(messung({ttl_klassen:['5m','1h']})).grund==='gemischte_ttl','gemischte TTL kein erfundener Countdown');
 ok(zeit(messung({request_beginn_ms:now+100000})).grund==='client_uhr_voraus','Client-Uhr voraus kein Countdown');
 ok(zeit(messung({gelesen:0,geschrieben:12000})).letzte_messung.status==='kalt_gemessen','Kalt-Beleg nur gemessene read0/creation>0');
 ok(zeit(messung({gelesen:null,geschrieben:null})).letzte_messung.status==='unbekannt','fehlende Usage nicht null Tokens');
 await assert.rejects(()=>melden(messung({gelesen:-1})),e=>e.code==='cache_messung_ungueltig');checks++;
 await assert.rejects(()=>C.meldeCacheWaechter({identity_id:id,lauf_id:lauf,sitzung:sid,herkunft:{...origin,host:''},messung:messung()}),e=>e.code==='cache_herkunft_fehlt');checks++;
 const I=await import('../../core/dist/services/intern-schalter.js');
 await set(false);await I.setzeSchalter('cache_waechter',{aktiv:true,modus:'freigegeben',dauer_min:1,grund:'Test'});
 ok((await C.cacheWaechterSchalter(P)).quelle==='intern','befristeter Override wirksam');
 await pool.query("UPDATE intern_schalter SET bis=NOW()-interval '1 second' WHERE name='cache_waechter'");
 ok(!(await C.cacheWaechterSchalter(P)).aktiv,'Ablauf -> Produkt AUS');
 await pool.query("DELETE FROM intern_schalter");await set(true);
 // Native REST-Handler mit realem Fachcode. Nur vorhandene Auth-Grenze ist injiziert.
 app=Fastify({logger:false});
 const sm={exports:{}};
 const src=readFileSync(new URL('../src/routes/daemon-sync.ts',import.meta.url),'utf8');
 new Function('require','module','exports',ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(n=>{
  if(n==='@synapse/core')return {...C,pruefeAgentToken:async t=>{if(t!==ausweis)throw Error('ungueltig');return {identitaet:{id,project:P}};}};
  throw Error('unerwarteter Import '+n);
 },sm,sm.exports);
 await sm.exports.daemonSyncRoutes(app,async(r,reply)=>{
  if(r.headers.authorization!=='Bearer fixture-tray'){reply.code(403).send({success:false,error:'fixture_auth'});return null;}
  return {host,daemonId:daemon};
 });
 const {agentRuntimeRoutes}=await import('../dist/routes/agent-runtimes.js');await app.register(agentRuntimeRoutes);
 app.addHook('onRequest',async(r,reply)=>{if(outage&&r.url.startsWith('/api/agent-runtimes/cache-waechter'))return reply.code(503).send({success:false,error:'echter_testausfall'});});
 const auth=await import('../dist/services/auth.js'),session=(await auth.issueSessionToken(null,600000)).token;
 const body={host:'gefaelscht',daemon_id:'gefaelscht',ausweis,lauf_id:lauf,sitzung:sid,messung:messung({messung_ms:now+1})};
 const post=b=>app.inject({method:'POST',url:'/api/daemon/cache-waechter',headers:{authorization:'Bearer fixture-tray'},payload:b});
 let http=await post(body);ok(http.statusCode===200&&http.json().angenommen,'daemon-sync.ts echter Handler nimmt Metadaten an',http.body);
 s=await C.leseCacheWaechterStand(id);ok(s.stand.herkunft.host===host&&s.stand.herkunft.daemon_id===daemon&&s.stand.herkunft.weg==='tray_daemon','API Herkunft aus geprueftem Daemon-Kontext statt Body',s.stand.herkunft);
 ok((await post({...body,ausweis:'fremd'})).statusCode===403,'ungueltiger Ausweis kein Write');
 ok((await app.inject({method:'POST',url:'/api/daemon/cache-waechter',payload:body})).statusCode===403,'ohne Daemon-Auth kein Write');
 const endpoint='/api/agent-runtimes/cache-waechter?identity_id='+id;
 ok((await app.inject({url:endpoint})).statusCode===401,'Chat-Status ohne User-Auth verweigert');
 http=await app.inject({url:endpoint,headers:{authorization:'Bearer '+session}});
 ok(http.statusCode===200&&http.json().stand.herkunft.host===host,'echter authentifizierter Chat-Status liest dieselbe PG-Messung',http.body);
 const getAlt=await app.inject({url:'/api/agent-runtimes/cache-waechter?identity_id=kaputt',headers:{authorization:'Bearer '+session}});
 ok(getAlt.statusCode===400,'ungueltige Chat-Identitaet abgewiesen');
 if(process.argv.includes('--browser')){
  await app.listen({host:'127.0.0.1',port:0});
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),uiReq=createRequire(join(repo,'packages/web-ui/package.json'));
  const {createServer}=await import(pathToFileURL(join(dirname(uiReq.resolve('vite/package.json')),'dist/node/index.js')).href);
  vite=await createServer({root:join(repo,'packages/web-ui'),configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},optimizeDeps:{entries:['tests/cache-waechter.html']},server:{host:'0.0.0.0',port:0,proxy:{'/api':{target:'http://127.0.0.1:'+app.server.address().port,headers:{authorization:'Bearer '+session}}}}});
  await vite.listen();
  const KB=process.env.SYNAPSE_KI_BROWSER_URL||'http://192.168.50.65:9222';
  const kb=async(p,b)=>{const r=await fetch(KB+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(20000)}),j=await r.json();assert.equal(j.success,true,JSON.stringify(j));return j.data;};
  const ev=async script=>evaluateWert(await kb('/evaluate',{tab_id:tab,script}));
  const wait=async(script,label)=>{const end=Date.now()+15000;while(Date.now()<end){if(await ev('Boolean('+script+')'))return;await new Promise(r=>setTimeout(r,100));}throw Error('P22-T194 Browser '+label+' erwartet=true ist='+await ev('document.body.innerText'));};
  const shots=await screenshotAblage(repo,'p22-t194-telemetrie'),shot=async name=>{const r=await fetch(KB+'/screenshot?tab_id='+tab);console.log('SCREENSHOT '+await shots.speichere(name+'.png',Buffer.from(await r.arrayBuffer())));};
  tab=(await isolierterTab(kb,{url:'http://'+(process.env.SYNAPSE_UI_TEST_HOST||'192.168.50.10')+':'+vite.httpServer.address().port+'/tests/cache-waechter.html?id='+id+'&andere='+id2})).tab_id;
  await wait("document.querySelector('.cache-waechter-status')?.innerText.includes('Zeit-Schätzung abgelaufen')",'abgelaufene Schaetzung sichtbar');
  ok(await ev("document.querySelector('.cache-waechter-status').innerText.includes('Zuletzt gemessen: Cache genutzt') && document.querySelector('.cache-waechter-status').innerText.includes('Tray test-tray')"),'Browser: Uhr abgelaufen und zuletzt Cache genutzt samt Herkunft zugleich');
  await ev("document.querySelector('.cache-waechter-status summary').click()");
  ok(await ev("getComputedStyle(document.querySelector('.cache-waechter-status')).color !== 'rgb(0, 0, 0)'"),'Browser: Statusfarbe sichtbar auf dunklem Grund');
  await shot('01-schaetzung-kein-kaltbeleg');
  // Fehler darf Entwurf/Messung nicht entfernen; Erholung stammt wieder aus demselben PG-Datensatz.
  await ev("const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'T194 Entwurf bleibt');e.dispatchEvent(new Event('input',{bubbles:true}));");
  outage=true;await wait("document.querySelector('.cache-waechter-status [role=alert]')",'Statusausfall sichtbar');
  ok(await ev("document.querySelector('textarea').value==='T194 Entwurf bleibt'&&document.querySelector('.cache-waechter-status').innerText.includes('Zuletzt gemessen: Cache genutzt')"),'Browser: Ausfall bewahrt Entwurf und letzte Messung');
  await shot('02-fehler-entwurf-bleibt');outage=false;await wait("!document.querySelector('.cache-waechter-status [role=alert]')",'Erholung');
  const next=now+100;
  await melden(messung({messung_ms:next,request_id:'msg-kalt',nutzungsmessung_ms:now,gelesen:0,geschrieben:12000,kontext_tokens:12002,request_beginn_ms:now,ttl_klassen:['1h']}));
  await wait("document.querySelector('.cache-waechter-status')?.innerText.includes('kalt gemessen')",'echter naechster Turn belegt kalt');
  ok(await ev("document.querySelector('textarea').value==='T194 Entwurf bleibt'&&document.querySelector('.cache-waechter-status').innerText.includes('Wahrscheinlich teuer ab')"),'Browser: neuer echter Nutzungsbeleg + Entwurf nach Erholung');
  await shot('03-zuletzt-kalt-gemessen');
  await set(false);await wait("!document.querySelector('.cache-waechter-status')",'Produkt AUS blendet Telemetrie aus');
  ok(await ev("document.querySelector('textarea').value==='T194 Entwurf bleibt'"),'Browser: AUS entfernt keinen Chatentwurf');
  await set(true);await ev("document.querySelector('#andere').click()");
  await wait("document.querySelector('.cache-waechter-status')?.innerText.includes('noch keine vollständige Nutzungsmessung')",'Identitaetswechsel');
  ok(!(await ev("document.querySelector('.cache-waechter-status').innerText")).includes(host),'Browser: fremde Identitaet zeigt keine alte Herkunft');
  await shot('04-andere-identitaet');console.log('P22-T194 BROWSER gruen, bestehende CacheWaechterStatus-Komponente gegen reale PG/REST-Daten.');
 }
 console.log('BESTANDEN '+checks+' P22-T194 lokale PG/REST/UI-Vertraege');
}finally{
 if(tab){try{await fetch((process.env.SYNAPSE_KI_BROWSER_URL||'http://192.168.50.65:9222')+'/tabs/close',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tab_id:tab})});}catch(error){console.error("P22-T194 Tab-Cleanup fehlgeschlagen",error);}}
 await vite?.close();await app?.close();await pool?.end();await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
