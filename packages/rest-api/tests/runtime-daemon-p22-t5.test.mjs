/**
 * P22-T5 (W2b) Testphase: Runtime-Daemon-Zugang. Vertrag 462ccb13, Korrekturen ba231de4/24634648.
 *  A Zugang ausstellen/ersetzen/widerrufen (REST-Dienst mit Fake-Container), nur User, Schalter hauptagent, Schreibfehler.
 *  B Bindung je Container (daemon_restore_host_bindings -> container_name), fremde Runtime, kein Eintrag je Projekt.
 *  C Projekte ohne Eintrag: projekteDerRuntime / listeRuntimeProjekte.
 *  D Daemon-Routen (Fastify inject, echte Tokens): Runtime-Zweig, gesperrte PC-Routen, PC-Weg unveraendert.
 *  E User-Routen /api/agent-runtimes/:runtime/daemon-zugang (Guard), F Schreibskript config.json (temp-Datei).
 * Nur synapse_test:5433, eigenes privates Schema, kein Docker/Netz.
 *   node packages/rest-api/tests/runtime-daemon-p22-t5.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const root=process.env.P22_T5_ROOT||repo;
const load=(...p)=>import(pathToFileURL(join(root,...p)).href);
const require=createRequire(join(root,'packages/rest-api/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_HAUPTAGENT','SYNAPSE_RUNTIME_DAEMON_API_URL'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',SYNAPSE_AGENT_BEZUG_MODUS:'beide',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=createRequire(join(root,'packages/core/package.json'))('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t5_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let checks=0,pool;
const mask=s=>String(s).replace(/[a-f0-9]{64}/g,'[TOKEN]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const sha=t=>createHash('sha256').update(t).digest('hex');
const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};

const PC='p22-t5-pc',API='p22-t5-api',AUS='p22-t5-aus',PCHOST='p22t5-pc-host';
const CN='synapse-runtime-claude',XN='synapse-runtime-codex';

try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';
  await admin.query('CREATE TABLE '+schema+'.'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const serials=await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%' ORDER BY table_name,column_name",[schema]);
 for(const [i,r]of serials.rows.entries()){
  const quote=s=>'"'+s.replaceAll('"','""')+'"',sequence=schema+'.private_serial_'+i;
  await admin.query('CREATE SEQUENCE '+sequence);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+sequence+"'::regclass)");
 }
 url.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=url.href;
 const C=await load('packages/core/dist/index.js');pool=C.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','hauptagent-verlauf-schema','main-warteschlange-schema','project-restore-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);
 }
 const auth=await load('packages/rest-api/dist/services/auth.js');
 const Z=await load('packages/rest-api/dist/services/agent-runtime/daemon-zugang.js');
 const {daemonJobsRoutes}=await load('packages/rest-api/dist/routes/daemon-jobs.js');
 const USER={art:'user'};
 for(const t of ['daemon_restore_host_bindings','daemon_heartbeats','projects','agent_runtime_instances'])await pool.query('DELETE FROM '+t);
 await pool.query("DELETE FROM auth_tokens");
 await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES('claude','claude','main','/r/claude','img',$1,true),('codex','codex','main','/r/codex','img',$2,false)",[CN,XN]);
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,'/home/u/p22t5pc',true),($3,'rest-api','/virtual/rest-api',true),($4,$2,'/home/u/aus',false)",[PC,PCHOST,API,AUS]);
 await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test P22-T5 EIN'});

 // Fake-Container: nimmt Schreibauftraege auf, laeuft standardmaessig
 let geschrieben=[],laeuft=true,schreibFehler=false;
 const deps={laeuft:async()=>laeuft,schreibe:async(name,felder)=>{if(schreibFehler)throw Object.assign(Error('container_config_nicht_geschrieben'),{code:'container_config_nicht_geschrieben'});geschrieben.push({name,felder});}};
 const scopeRows=async rt=>(await pool.query("SELECT token_hash FROM auth_tokens WHERE kind='service' AND scope=$1",['runtime-daemon:'+rt])).rows.map(r=>r.token_hash);
 const bindung=async h=>(await pool.query('SELECT hostname FROM daemon_restore_host_bindings WHERE token_hash=$1',[h])).rows[0]?.hostname??null;
 let TOK1,TOK2;

 await section('A Scope-Helfer',async()=>{
  check(C.runtimeDaemonScope('claude')==='runtime-daemon:claude','Scope runtime-daemon:claude');
  check(C.runtimeAusScope('runtime-daemon:codex')==='codex','runtimeAusScope liest Runtime');
  check(C.runtimeAusScope('daemon:pc')===null&&C.runtimeAusScope('daemon')===null&&C.runtimeAusScope(null)===null,'PC-Scope/leer ist kein Runtime-Scope');
  check(C.runtimeProjektPfad(PC)==='/projects/'+PC,'Pfad /projects/<name>');
  check(await err(()=>C.runtimeProjektPfad('../x'))==='project_ungueltig','Pfad ohne ..');
 });

 await section('A Ausstellen (Schalter, Container, Rechte)',async()=>{
  check((await Z.leseRuntimeDaemonZugang('claude')).zugang==='fehlt','vorher: zugang fehlt');
  await C.setzeHauptagentSchalter(USER,{aktiv:false,grund:'Test P22-T5 AUS'});
  check(await err(()=>Z.stelleRuntimeDaemonZugangAus('claude','Test ausstellen',deps))==='funktion_aus','Schalter AUS -> funktion_aus');
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test P22-T5 EIN'});
  laeuft=false;
  check(await err(()=>Z.stelleRuntimeDaemonZugangAus('claude','Test ausstellen',deps))==='container_nicht_bereit','Container aus -> container_nicht_bereit');
  laeuft=true;
  check((await scopeRows('claude')).length===0,'nach Ablehnungen kein Token');
  check(await err(()=>Z.stelleRuntimeDaemonZugangAus('claude','kurz',deps))==='grund_fehlt','grund Pflicht');
  check(await err(()=>C.bindeRuntimeDaemonZugang(null,{runtime:'claude',token_hash:'a'.repeat(64),grund:'Test ohne Akteur'}))==='recht_fehlt','Binden ohne User -> recht_fehlt');
  check(await err(()=>C.bindeRuntimeDaemonZugang({art:'legacy_koordinator',agent_id:'koordinator'},{runtime:'claude',token_hash:'a'.repeat(64),grund:'Test Legacy'}))==='recht_fehlt','Binden Legacy-Koordinator -> recht_fehlt');
  const s=await Z.stelleRuntimeDaemonZugangAus('claude','Test ausstellen 1',deps);
  check(s.zugang==='aktiv'&&s.host===CN,'Status aktiv, host = container_name');
  check(!JSON.stringify(s).match(/[a-f0-9]{64}/),'Status ohne Token/Hash');
  check(geschrieben.length===1&&geschrieben[0].name===CN,'in genau den Container geschrieben');
  TOK1=geschrieben[0].felder.synapse_api_token;
  check(typeof TOK1==='string'&&/^[a-f0-9]{64}$/.test(TOK1),'Klartext nur im Container-Schreibauftrag');
  check(geschrieben[0].felder.synapse_api_url==='http://synapse-api:3456','API-URL Standard proxynet');
  check((await scopeRows('claude')).join()===sha(TOK1),'auth_tokens: genau ein Token (gehasht)');
  check(await bindung(sha(TOK1))===CN,'Bindung je Container: token -> '+CN);
  const b=await C.loeseRuntimeDaemonZugang(sha(TOK1),'runtime-daemon:claude');
  check(b?.runtime==='claude'&&b.host===CN&&b.assigned_to_main===true,'loeseRuntimeDaemonZugang liefert Runtime+Host+Main');
  check(await C.loeseRuntimeDaemonZugang(sha(TOK1),'runtime-daemon:codex')===null,'fremde Runtime im Scope -> null');
  check(await C.loeseRuntimeDaemonZugang(sha(TOK1),'daemon:x')===null,'PC-Scope -> null');
 });

 await section('A Ersetzen und Schreibfehler',async()=>{
  geschrieben=[];
  await Z.stelleRuntimeDaemonZugangAus('claude','Test ausstellen 2',deps);
  TOK2=geschrieben[0].felder.synapse_api_token;
  check(TOK2!==TOK1,'neuer Token');
  check((await scopeRows('claude')).join()===sha(TOK2),'alter Token geloescht, genau einer');
  check(await bindung(sha(TOK1))===null&&await bindung(sha(TOK2))===CN,'alte Bindung weg, neue gebunden');
  check(await auth.validateToken(TOK1)===null,'alter Token ungueltig');
  schreibFehler=true;
  check(await err(()=>Z.stelleRuntimeDaemonZugangAus('claude','Test Schreibfehler',deps))==='container_config_nicht_geschrieben','Schreibfehler wird gemeldet');
  schreibFehler=false;
  check((await scopeRows('claude')).join()===sha(TOK2),'Schreibfehler: alter Zugang bleibt, neuer verworfen');
  check((await auth.validateToken(TOK2))!==null,'Zugang nach Schreibfehler weiter gueltig');
 });

 await section('C Projekte ohne Eintrag je Projekt',async()=>{
  const alle=[PC,API,AUS,'reverse-bibliothek',C.HAUPTAGENT_PROJEKT,'gibt-es-nicht'];
  check(JSON.stringify(await C.projekteDerRuntime(alle,'claude'))===JSON.stringify([PC,API,C.HAUPTAGENT_PROJEKT]),'claude: PC- und API-Projekt + Main, nicht deaktiviert/virtuell/unbekannt');
  check(JSON.stringify(await C.projekteDerRuntime(alle,'codex'))===JSON.stringify([PC,API]),'codex: ohne Main-Bereich');
  check((await C.projekteDerRuntime(alle,'gibtsnicht')).length===0,'unbekannte Runtime -> nichts');
  const l=await C.listeRuntimeProjekte('claude');
  check(l.length===1&&l[0].name===C.HAUPTAGENT_PROJEKT&&l[0].path==='/projects/'+C.HAUPTAGENT_PROJEKT,'Liste claude = nur Main-Bereich');
  check((await C.listeRuntimeProjekte('codex')).length===0,'Liste codex leer');
  check((await pool.query("SELECT 1 FROM projects WHERE hostname LIKE 'synapse-runtime-%'")).rowCount===0,'keine projects-Zeile fuer den Container');
 });

 // ---------------- Routen ----------------
 const fastify=require('fastify');
 const app=fastify();
 await app.register(async f=>daemonJobsRoutes(f));
 await app.ready();
 const PCT=(await auth.issueServiceToken('daemon:p22t5-pc','p22t5-pc')).token;
 await new C.ProjectRestoreService().bindDaemonHost(sha(PCT),PCHOST);
 const SESS=(await auth.issueSessionToken(null,60_000)).token;
 const req=(method,path,tok,payload)=>app.inject({method,url:path,headers:{authorization:'Bearer '+tok},...(payload===undefined?{}:{payload})});
 const RID='daemon-'+CN+'-4711',PID='daemon-'+PCHOST+'-4712';

 await section('D Runtime-Zweig',async()=>{
  let r=await req('GET','/api/daemon/projekte?host='+CN+'&daemon_id='+RID,TOK2);
  check(r.statusCode===200&&r.json().runtime==='claude'&&r.json().projekte.map(p=>p.name).join()===C.HAUPTAGENT_PROJEKT,'GET projekte: nur Main-Bereich');
  r=await req('GET','/api/daemon/projekte?daemon_id=daemon-abc123def-5',TOK2);
  check(r.statusCode===400&&r.json().error==='daemon_id_ungueltig','daemon_id mit OS-Hostname statt container_name -> 400');
  r=await req('GET','/api/daemon/projekte?host=anderer&daemon_id='+RID,TOK2);
  check(r.statusCode===403&&r.json().error==='host_verboten','fremder host -> host_verboten');
  r=await req('POST','/api/daemon/heartbeat',TOK2,{host:CN,daemon_id:RID,aktion:'melden',projekte:[PC,C.HAUPTAGENT_PROJEKT]});
  check(r.statusCode===200&&r.json().projekte.join()===[PC,C.HAUPTAGENT_PROJEKT].join(),'heartbeat melden ok');
  check((await pool.query('SELECT 1 FROM daemon_heartbeats')).rowCount===0,'Container schreibt kein daemon_heartbeats');
  r=await req('POST','/api/daemon/specialist/daten',TOK2,{host:CN,daemon_id:RID,aktion:'projektpfad',project:PC});
  check(r.statusCode===200&&r.json().pfad==='/projects/'+PC,'projektpfad Container = /projects/<name>, nicht PC-Pfad');
  r=await req('POST','/api/daemon/specialist/daten',TOK2,{host:CN,daemon_id:RID,aktion:'projektpfad',project:AUS});
  check(r.statusCode===200&&r.json().pfad===null,'deaktiviertes Projekt -> pfad null');
  r=await req('POST','/api/daemon/specialist/daten',TOK2,{host:CN,daemon_id:RID,aktion:'channel_beitreten',project:'gibt-es-nicht',agent:'x',channel:'c'});
  check(r.statusCode===409&&r.json().error==='projekt_nicht_auf_diesem_host','unbekanntes Projekt -> 409');
  r=await req('POST','/api/daemon/specialist/daten',TOK2,{host:CN,daemon_id:RID,aktion:'modelle'});
  check(r.statusCode===200,'modelle fuer Runtime-Daemon');
 });

 await section('D gesperrte Routen fuer den Runtime-Daemon',async()=>{
  for(const [m,p,b] of [['GET','/api/daemon/shell/jobs?host='+CN+'&daemon_id='+RID],['POST','/api/daemon/shell/abschluss',{host:CN,daemon_id:RID,id:'x',abschluss:{status:'done'}}],
    ['POST','/api/daemon/shell/wartung',{host:CN,daemon_id:RID,aktion:'reap'}],['GET','/api/daemon/shell/kontext?host='+CN+'&daemon_id='+RID+'&id=x'],
    ['POST','/api/daemon/sync',{host:CN,daemon_id:RID,aktion:'ignore_regeln',project:PC}],['POST','/api/daemon/project-init',{host:CN,daemon_id:RID,aktion:'expire'}]]){
   const r=await req(m,p,TOK2,b);
   check(r.statusCode===403&&r.json().error==='daemon_token_erforderlich',m+' '+p.split('?')[0]+' -> 403 daemon_token_erforderlich');
  }
  await C.setzeHauptagentSchalter(USER,{aktiv:false,grund:'Test P22-T5 AUS Route'});
  const r=await req('GET','/api/daemon/projekte?host='+CN+'&daemon_id='+RID,TOK2);
  check(r.statusCode===403&&r.json().error==='funktion_aus','Schalter AUS -> Runtime-Daemon 403 funktion_aus');
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test P22-T5 EIN Route'});
  await pool.query('DELETE FROM daemon_restore_host_bindings WHERE token_hash=$1',[sha(TOK2)]);
  const g=await req('GET','/api/daemon/projekte?host='+CN+'&daemon_id='+RID,TOK2);
  check(g.statusCode===403&&g.json().error==='runtime_daemon_nicht_gebunden','ohne Bindung -> runtime_daemon_nicht_gebunden');
  await pool.query('INSERT INTO daemon_restore_host_bindings(token_hash,hostname) VALUES($1,$2)',[sha(TOK2),XN]);
  const f=await req('GET','/api/daemon/projekte?host='+XN+'&daemon_id=daemon-'+XN+'-1',TOK2);
  check(f.statusCode===403&&f.json().error==='runtime_daemon_nicht_gebunden','Bindung an fremden Container -> abgelehnt');
  await pool.query('UPDATE daemon_restore_host_bindings SET hostname=$2 WHERE token_hash=$1',[sha(TOK2),CN]);
 });

 await section('D PC-Weg unveraendert',async()=>{
  let r=await req('GET','/api/daemon/projekte?host='+PCHOST+'&daemon_id='+PID,PCT);
  const n=r.json().projekte?.map(p=>p.name)??[];
  check(r.statusCode===200&&r.json().runtime===undefined&&n.includes(PC)&&n.includes(AUS)&&!n.includes(API),'PC: Projekte seines Hosts (aus projects.hostname)');
  check(r.json().projekte.find(p=>p.name===PC)?.path==='/home/u/p22t5pc','PC: Pfad aus projects.path');
  r=await req('POST','/api/daemon/heartbeat',PCT,{host:PCHOST,daemon_id:PID,aktion:'melden',projekte:[PC,API]});
  check(r.statusCode===200&&r.json().projekte.join()===PC,'PC heartbeat: nur Host-Projekte');
  check((await pool.query('SELECT hostname FROM daemon_heartbeats WHERE project=$1',[PC])).rows[0]?.hostname===PCHOST,'PC schreibt daemon_heartbeats wie bisher');
  r=await req('POST','/api/daemon/specialist/daten',PCT,{host:PCHOST,daemon_id:PID,aktion:'projektpfad',project:PC});
  check(r.statusCode===200&&r.json().pfad==='/home/u/p22t5pc','PC projektpfad = lokaler Pfad');
  r=await req('POST','/api/daemon/specialist/daten',PCT,{host:PCHOST,daemon_id:PID,aktion:'channel_beitreten',project:API,agent:'x',channel:'c'});
  check(r.statusCode===409,'PC: API-Projekt ohne Hostzeile -> 409 (unveraendert)');
  r=await req('GET','/api/daemon/projekte?host='+CN+'&daemon_id='+PID,PCT);
  check(r.statusCode===403&&r.json().error==='host_verboten','PC: fremder Host (Container-Name) -> host_verboten');
  r=await req('GET','/api/daemon/projekte?host='+PCHOST+'&daemon_id=daemon-'+CN+'-1',PCT);
  check(r.statusCode===400&&r.json().error==='daemon_id_ungueltig','PC: daemon_id eines anderen Hosts -> daemon_id_ungueltig');
  r=await req('GET','/api/daemon/projekte?host='+PCHOST+'&daemon_id='+PID,SESS);
  check(r.statusCode===403&&r.json().error==='daemon_token_erforderlich','Session-Token -> daemon_token_erforderlich');
  r=await req('GET','/api/daemon/projekte?host='+PCHOST+'&daemon_id='+PID,'falsch');
  check(r.statusCode===401,'unbekannter Token -> 401');
 });

 await section('E User-Routen daemon-zugang (Guard)',async()=>{
  let app2;
  try{
   const {agentRuntimeRoutes}=await load('packages/rest-api/dist/routes/agent-runtimes.js');
   app2=fastify();await app2.register(async f=>agentRuntimeRoutes(f));await app2.ready();
  }catch(e){check(false,'agentRuntimeRoutes registrierbar: '+mask(e.message));return;}
  const q=(method,path,tok)=>app2.inject({method,url:path,headers:{authorization:'Bearer '+tok}});
  let r=await q('GET','/api/agent-runtimes/claude/daemon-zugang',SESS);
  check(r.statusCode===200&&r.json().zugang?.zugang==='aktiv'&&!r.body.match(/[a-f0-9]{64}/),'Session-User liest Status, ohne Token');
  r=await q('GET','/api/agent-runtimes/claude/daemon-zugang',TOK2);
  check(r.statusCode===403,'Runtime-Daemon-Token an User-Route -> 403');
  r=await q('GET','/api/agent-runtimes/claude/daemon-zugang',PCT);
  check(r.statusCode===403,'Tray-Token an User-Route -> 403');
  r=await q('GET','/api/agent-runtimes/free-pool/daemon-zugang',SESS);
  check(r.statusCode>=400&&r.json().error?.code==='runtime_ungueltig','free-pool -> runtime_ungueltig');
  r=await q('GET','/api/agent-runtimes/claude/projekte',SESS);
  check(r.statusCode===200&&r.json().projekte.length===1,'GET projekte (User) = Main-Bereich');
  r=await q('PUT','/api/agent-runtimes/claude/projekte',SESS);
  check(r.statusCode===404,'PUT projekte entfernt (404)');
  await app2.close();
 });

 await section('A Widerruf',async()=>{
  geschrieben=[];
  const w=await Z.widerrufeRuntimeDaemonZugangKomplett('claude','Test Widerruf',deps);
  check(w.zugang==='fehlt'&&w.container_bereinigt===true,'Widerruf: zugang fehlt, Container bereinigt');
  check(geschrieben.length===1&&geschrieben[0].felder.synapse_api_token===null,'Container: synapse_api_token entfernt');
  check((await scopeRows('claude')).length===0&&await bindung(sha(TOK2))===null,'Token und Bindung geloescht');
  const r=await req('GET','/api/daemon/projekte?host='+CN+'&daemon_id='+RID,TOK2);
  check(r.statusCode===401,'widerrufener Token -> 401');
  check(await err(()=>Z.widerrufeRuntimeDaemonZugangKomplett('claude','Test Widerruf 2',deps))==='zugang_fehlt','zweiter Widerruf -> zugang_fehlt');
  check((await auth.validateToken(PCT))!==null,'Tray-Token unberuehrt');
 });
 await app.close();

 await section('F Schreibskript config.json',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'p22t5-cfg-')),p=join(dir,'fw','config.json');
  const run=input=>spawnSync(process.execPath,['-e',Z.CONFIG_SCHREIB_SKRIPT,p],{input:JSON.stringify(input),encoding:'utf8'});
  try{
   let r=run({synapse_api_url:'http://a',synapse_api_token:'t1'});
   check(r.status===0&&JSON.parse(readFileSync(p,'utf8')).synapse_api_token==='t1','neue Datei angelegt');
   check((statSync(p).mode&0o777)===0o600,'Rechte 0600');
   writeFileSync(p,JSON.stringify({fremd:{x:1},synapse_api_token:'t1',port:7878}));
   r=run({synapse_api_token:'t2'});
   const j=JSON.parse(readFileSync(p,'utf8'));
   check(r.status===0&&j.synapse_api_token==='t2'&&j.fremd?.x===1&&j.port===7878,'Fremdfelder bleiben');
   r=run({synapse_api_token:null});
   check(r.status===0&&!('synapse_api_token' in JSON.parse(readFileSync(p,'utf8'))),'null entfernt Feld');
   writeFileSync(p,'{kaputt');
   r=run({synapse_api_token:'t3'});
   check(r.status===3&&readFileSync(p,'utf8')==='{kaputt','kaputte Datei -> Exit 3, unveraendert');
   check(!r.stdout.includes('t3')&&!r.stderr.includes('t3'),'Token nicht in Ausgabe');
   check(!existsSync(p+'.tmp'),'keine tmp-Datei liegen geblieben');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
}catch(e){failures.push('Setup: '+mask(e.message));console.error(mask(e.stack));}
finally{
 await pool?.end().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end();
}
console.log(`ERGEBNIS p22-t5: ${checks-failures.length}/${checks} gruen, ${failures.length} rot`);
if(failures.length){console.log(failures.map(f=>' - '+f).join('\n'));process.exit(1);}
