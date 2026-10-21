/**
 * P22-T93: isolierte API-/SSE-/Browserabnahme. Nur synapse_test:5433, privates Schema.
 * Nach mise run build:core, build:api und pnpm --filter @synapse/web-ui build:
 * node packages/rest-api/tests/agentennetzwerk-p22-t93.test.mjs
 * Browser optional: P22_PLAYWRIGHT_MODULE=/absoluter/pfad/playwright/index.mjs
 * Artefakte: ui-screenshots/p22-t93/ (Testdaten klar gekennzeichnet).
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const requireUi=createRequire(join(repo,'packages/web-ui/package.json'));
const db=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t93_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t93-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,vite,browser,checks=0;
const ok=(value,label)=>{assert(value,label);checks++;console.log('OK '+label);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const eventually=async(fn,label)=>{for(let i=0;i<100;i++){const x=await fn();if(x)return x;await sleep(30);}throw Error(label);};
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 const seq=(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows;
 for(const [i,r]of seq.entries()){
  const name=schema+'.serial_'+i;await admin.query('CREATE SEQUENCE '+name);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+name+"'::regclass)");
 }
 db.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=db.href;
 C=await load('packages/core/dist/index.js');pool=C.getPool();
 const {AGENTENNETZWERK_SCHEMA_SQL}=await load('packages/core/dist/db/agentennetzwerk-schema.js');
 await pool.query(AGENTENNETZWERK_SCHEMA_SQL);await pool.query(AGENTENNETZWERK_SCHEMA_SQL);
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 const {specialistRoutes}=await load('packages/rest-api/dist/routes/specialists.js');
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 const {registerAgentProfilRoutes}=await load('packages/rest-api/dist/routes/agent-profil.js');
 await app.register(specialistRoutes);await app.register(mcpRoutes);
 await registerAgentProfilRoutes(app,{validateToken:async t=>t==='p22-user'?{kind:'session',scope:null}:null});
 await app.ready();
 const snapshot=async()=>{const r=await app.inject({method:'GET',url:'/api/projects/'+P+'/agentennetzwerk'});assert.equal(r.statusCode,200,r.body);return r.json();};
 const ident=async(id,name,rolle='subagent',project=P,status='aktiv')=>pool.query(
  "INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von,zuletzt_aktiv) VALUES($1,$2,$3,$3,$4,$5,'test',NOW())",
  [id,project,name,rolle,status]);
 await ident('p93-main',C.HAUPTAGENT_AGENT_ID,'main',C.HAUPTAGENT_PROJEKT);
 await ident('p93-koord','koordinator-p93','koordinator');
 await ident('p93-koord-b','koordinator-p93-b','koordinator');
 await ident('p93-a','agent-a');await ident('p93-b','agent-b');await ident('p93-c','agent-c');
 await pool.query("INSERT INTO specialist_jobs(id,project,action,args,status,actor_identity_id,target_identity_id,completed_at) VALUES($1,$2,'spawn',$3::jsonb,'done','p93-koord','p93-a',NOW())",[randomUUID(),P,JSON.stringify({name:'agent-a',identity_id:'p93-a'})]);
 await pool.query("UPDATE agent_identitaeten SET modell_selbstauskunft=CASE id WHEN 'p93-a' THEN 'gpt-test' ELSE 'claude-test' END WHERE id IN ('p93-a','p93-main','p93-koord-b')");
 await ident('p93-arch','archiv-20261020-alt','subagent',P,'deaktiviert');
 await ident('p93-fremd','anderes-projekt','subagent','p93-fremd');
 let s=await snapshot();ok(!s.schalter.aktiv&&!s.ereignisse.length,'Standard AUS: keine neue Ereignisprojektion');
 ok((await C.fuehreNetzwerkAdminAus({project:P},null)).error==='recht_fehlt','kein unberechtigtes Einstellen');
 const principal={art:'identitaet',principal:{project:P,identity_id:'p93-a',rolle:'subagent'}};
 ok((await C.fuehreNetzwerkAdminAus({project:P},principal)).error==='recht_fehlt','Arbeitsagent darf Einstellungen nicht verwalten');
 let r=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',payload:{netzwerk_werte:{inaktiv_sekunden:60},grund:'Test Einstellungen'}});
 ok(r.statusCode===401,'REST-Schreibweg verlangt authentifizierten Verwalter');
 r=await app.inject({method:'PUT',url:'/api/projects/'+P+'/agent-profile/agentennetzwerk',headers:{authorization:'Bearer p22-user'},
  payload:{netzwerk_werte:{abgleich_sekunden:3,animation_ms:3000},grund:'Test T93 Einstellungen'}});
 ok(r.statusCode===200&&r.json().werte.animation_ms===3000,'User kann Einstellungen ueber denselben API-Vertrag setzen');
 ok((await C.leseNetzwerkKonfiguration(P)).einstellungen.animation_ms.quelle==='einstellung','Einstellung dauerhaft in PG mit Quelle');
 r=await C.fuehreNetzwerkAdminAus({project:P,netzwerk_modus:'einstellen',netzwerk_werte:{animation_ms:5},grund:'Grenztest T93'},{art:'user'});
 ok(!r.success,'ungueltige Einstellwerte abgelehnt');
 const koord={art:'identitaet',principal:{project:P,identity_id:'p93-koord',rolle:'koordinator'}};
 ok((await C.fuehreNetzwerkAdminAus({project:P},koord)).success,'Projektkoordinator darf Diagnose lesen');
 const schalte=aktiv=>C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'agentennetzwerk',aktiv,grund:'Test P22 T93 Freigabe'},{system:'user'});
 // Intern darf nur befristet und nur im internen Startmodus uebersteuern.
 await C.setzeSchalter('agentennetzwerk',{aktiv:true,modus:'freigegeben',dauer_min:1,grund:'Test befristet'});
 ok(!(await C.leseNetzwerkKonfiguration(P)).schalter.aktiv,'Produktionsmodus ignoriert intern-Freigabe');
 const internStand=()=>JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',
  "const C=await import("+JSON.stringify(pathToFileURL(join(repo,'packages/core/dist/index.js')).href)+");console.log(JSON.stringify((await C.leseNetzwerkKonfiguration("+JSON.stringify(P)+")).schalter));await C.getPool().end();"],
  {env:{...process.env,SYNAPSE_INTERN_TOOL:'1'},encoding:'utf8',timeout:30000}).trim().split('\n').at(-1));
 ok(internStand().quelle==='intern','befristete intern-Freigabe greift nur im Testmodus');
 await pool.query("UPDATE intern_schalter SET bis=NOW()-INTERVAL '1 second' WHERE name='agentennetzwerk'");
 ok(!internStand().aktiv,'abgelaufener Override faellt auf Standard AUS');
 process.env.SYNAPSE_INTERN_TOOL='0';
 await schalte(true);s=await snapshot();ok(s.schalter.aktiv&&s.schalter.quelle==='produkt-schalter','persistenter Produkt-Schalter gibt Netzwerk frei');
 ok(!s.agenten.some(a=>a.agent.startsWith('archiv-'))&&s.agenten.filter(a=>a.rolle==='main').length===1,'Archiv ausgeblendet und genau ein Hauptagent');
 ok(s.agenten.find(a=>a.id==='p93-a').modell==='gpt-test'&&s.agenten.find(a=>a.rolle==='main').modell==='claude-test','Agenten- und Main-Metadaten aus agenten-team sicher projiziert');
 ok(s.werte.aktivitaet_sekunden===60&&s.einstellungen.aktivitaet_sekunden.quelle==='standard','Aktivitaetsfenster 60 Sekunden mit PG-Vertrag');
 ok(s.agenten.filter(a=>a.rolle==='koordinator').length===2,'beide realen Projektkoordinatoren im API-Vertrag');
 ok(s.agenten.find(a=>a.id==='p93-a').koordination?.koordinator_id==='p93-koord'&&s.agenten.find(a=>a.id==='p93-a').koordination?.quelle==='specialist_jobs.spawn','Arbeitsagent A aus abgeschlossenem Startauftrag zugeordnet');
 ok(s.agenten.find(a=>a.id==='p93-c').koordination===null,'ohne Beleg bleibt Arbeitsagent beim Projekt');
 const channelName='netz-test';
 const call=async(tool,args,agent='agent-a')=>{
  const res=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:{project:P,agent_id:agent,...args}}}});
  assert.equal(res.statusCode,200);
  const rr=res.json();assert(!rr.error,JSON.stringify(rr.error));
  const result=rr.result.structuredContent??JSON.parse(rr.result.content.find(c=>c.type==='text').text);
  assert.notEqual(result.success,false,JSON.stringify(result));return result;
 };
 await call('chat',{action:'send',recipient_id:'agent-b',sender_id:'koordinator-p93-b',content:'Koordination Test P22 T93'},'koordinator-p93-b');
 await call('channel',{action:'create',name:channelName,description:'Testdaten P22 T93',created_by:'agent-a'});
 await call('channel',{action:'join',channel_name:channelName,agent_name:'agent-b'},'agent-b');
 await call('channel',{action:'post',channel_name:channelName,sender:'agent-a',content:'VERTRAULICH-P93 nur im Test'});
 await call('channel',{action:'feed',channel_name:channelName},'agent-b');
 for(const name of ['code-review','koordination']){
  await call('channel',{action:'create',name,description:'P22 T93 Test',created_by:'agent-b'},'agent-b');
  await call('channel',{action:'post',channel_name:name,sender:'agent-b',content:'Testimpuls'},'agent-b');
 }
 await call('chat',{action:'send',recipient_id:'agent-b',sender_id:'agent-a',content:'VERTRAULICH-P93 '+('x'.repeat(900))});
 s=await eventually(async()=>{const x=await snapshot();return x.ereignisse.some(e=>e.tool==='chat'&&e.action==='send'&&e.agent==='agent-a')&&x;},'Audit-Eintraege fehlen');
 const dm=s.ereignisse.find(e=>e.tool==='chat'&&e.action==='send'&&e.agent==='agent-a');
 const b=(await snapshot()).agenten.find(a=>a.id==='p93-b');
 ok(b.koordination?.koordinator_id==='p93-koord-b'&&b.koordination?.quelle==='tool_calls.chat','Arbeitsagent B ersatzweise aus echter direkter Kommunikation zugeordnet');
 ok(dm.empfaenger[0]==='agent-b'&&dm.routing==='vorhanden','echter MCP-Chat-Aufruf: gerichtete Empfaenger-Metadaten trotz langer Nachricht');
 ok(s.ereignisse.some(e=>e.channel===channelName&&e.interaktion==='lesen'),'echte Channel-Leseaktion fuer Leserreaktion');
 ok(!JSON.stringify(s).includes('VERTRAULICH-P93')&&!JSON.stringify(s).includes('args_preview'),'keine Nachrichteninhalte oder Rohargumente im Netzwerk');
 const audit=(await pool.query('SELECT tool_name,action FROM tool_calls WHERE id=$1',[dm.id])).rows[0];
 ok(audit.tool_name==='chat'&&audit.action==='send','Netzereignis-ID entspricht echtem tool_calls-Datensatz');
 const fake=C.netzwerkEreignis({...{id:'9',ts:new Date().toISOString(),agent_id:'agent-a',tool_name:'chat',action:'send',ok:true},args_preview:JSON.stringify({content:'"recipient_id":"falsch"'})});
 ok(!fake.empfaenger.length,'Empfaenger nie aus Nachrichteninhalt geraten');
 // SSE-Vertrag: echter Post-Commit-Hinweis, gebuendelt und ohne Inhalte.
 await app.listen({host:'127.0.0.1',port:0});
 const api='http://127.0.0.1:'+app.server.address().port;
 const abbruch=new AbortController();
 const response=await fetch(api+'/api/projects/'+P+'/events?netzwerk=1',{signal:abbruch.signal});
 const reader=response.body.getReader();let stream='';
 const notify=(async()=>{for(;;){const x=await reader.read();if(x.done)break;stream+=new TextDecoder().decode(x.value);if(stream.includes('synapse_tool_activity'))return;}})();
 await call('chat',{action:'send',recipient_id:'agent-b',sender_id:'agent-a',content:'STREAM-GEHEIM-P93'});
 await Promise.race([notify,sleep(5000).then(()=>{throw Error('kein SSE-Hinweis');})]);
 abbruch.abort();await reader.cancel().catch(()=>{});
 ok(stream.includes('synapse_tool_activity')&&!stream.includes('STREAM-GEHEIM-P93'),'SSE liefert echten gebuendelten Metadaten-Hinweis');
 // Browser-Abnahme der neuen Darstellung (Nervensystem, WebGL2): packages/rest-api/tests/agentennetzwerk-darstellung-p22-t93.test.mjs
 console.log('PASS P22-T93: '+checks+' Pruefungen; '+schema+' wird entfernt');
}finally{
 await browser?.close();await vite?.close();await app?.close();await pool?.end();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
