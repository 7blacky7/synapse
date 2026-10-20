/**
 * P22-T81 + P22-T82 Stufe S1 (Entwurf 696ca614): Verlauf jeder Identitaet in PG, Startpaket je neuem Lauf, Spawn im
 * Runtime-Container (Schalter, Kontingent, Identitaet, Job mit target_runtime), Container-Daemon holt Jobs fremder Projekte,
 * Bearer agent:identitaet:<id> nur mit eigenem Ausweis.
 * Mit Fake-Container-Daemon (claimt specialist_jobs wie der Daemon im Container). Nur synapse_test:5433, eigenes privates
 * Schema, keine Modelle/Netz/Docker.
 *   node packages/core/tests/agent-container-verlauf-p22-t81-t82.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t82_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ergebnis=obj=>({content:[{type:'text',text:JSON.stringify(obj)}]});

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
 core=await load('packages/core/dist/index.js');pool=core.getPool();
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-zustellungen-schema','hauptagent-verlauf-schema','main-warteschlange-schema','agent-startkontext-schema','agent-container-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},P='p82-'+randomUUID().slice(0,6),LK={art:'legacy_koordinator',agent_id:'koordinator'};
 const alsUser=fn=>C.mitUserHerkunft('web-ui-chat',fn);
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test P22-T82 alle'},{system:'user'});
 await pool.query("INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,'pc-host',true)",[P,'/home/test/'+P]);

 await section('Schema 127: Spiegel identisch, idempotent, in ensureSchema',async()=>{
  const sql=readFileSync(join(repo,'packages/core/src/db/schema-sql/127_agent_container.sql'),'utf8');
  check(sql.trim()===C.AGENT_CONTAINER_SCHEMA_SQL.trim(),'127 SQL-Spiegel identisch');
  await pool.query(C.AGENT_CONTAINER_SCHEMA_SQL);
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('CREATE TABLE IF NOT EXISTS projekt_agenten_kontingent'),'127 im ensureSchema-SQL');
 });

 await section('Schalter-Standard',async()=>{
  check((await C.leseProfilProduktSchalter('agent_verlauf_alle',null)).aktiv===true,'agent_verlauf_alle Standard EIN');
  check((await C.leseProfilProduktSchalter('spezialisten_container',P)).aktiv===false,'spezialisten_container Standard AUS (alle schaltet ihn nicht)');
 });

 // Identitaet eines Spezialisten (wie agent_vorbereiten durch den User).
 const vb=await alsUser(()=>C.fuehreW1bAdminAus('agent_vorbereiten',{project:P,agent_name:'spez-a',grund:'Test T81'},{akteur:USER}));
 const A=vb.identity_id;const TOKEN_A=vb.token;
 check(!!A&&typeof TOKEN_A==='string','Identitaet spez-a vorbereitet',vb);

 await section('T81: Verlauf jeder aktiven Identitaet in PG',async()=>{
  const ez=[{ref:'u1:0',art:'eingabe',inhalt:'Bitte lies Thought XYZ'},
   {ref:'a1:0',art:'werkzeug_aufruf',name:'mcp__synapse__thought',inhalt:{action:'get',id:'XYZ'},werkzeug_id:'t1'},
   {ref:'u2:0',art:'werkzeug_ergebnis',inhalt:'Inhalt von XYZ',werkzeug_id:'t1'},
   {ref:'a1:1',art:'text',inhalt:'Fertig: XYZ gelesen'}];
  const r=await C.importiereSitzungsEintraege(A,ez,{runtime:'claude'});
  check(r.aufgenommen===4&&r.grund===null,'4 Eintraege einer Nicht-Main-Identitaet aufgenommen',r);
  check((await C.importiereSitzungsEintraege(A,ez,{runtime:'claude'})).aufgenommen===0,'idempotent je ref');
  check((await C.importiereSitzungsEintraege(null,ez)).grund==='nicht_main','ohne Identitaet -> nicht_main');
  check((await C.importiereSitzungsEintraege(randomUUID(),ez)).grund==='nicht_main','unbekannte Identitaet -> nicht_main');
  const v=await C.leseVerlaufFuer(A,{limit:10});
  check(v.verfuegbar===true&&v.identity_id===A&&v.eintraege.length===4,'leseVerlaufFuer liefert die 4 Eintraege',v.eintraege.length);
  check(v.eintraege.map(e=>e.text).join('|').includes('Fertig: XYZ gelesen')&&v.eintraege.every(e=>e.hauptagent_weg===null),'Inhalt voll, kein Main-Weg markiert');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agent_verlauf_alle',aktiv:false,grund:'Test AUS'},{system:'user'});
  check((await C.importiereSitzungsEintraege(A,[{ref:'u9:0',art:'eingabe',inhalt:'x'}])).grund==='nicht_main','Schalter AUS -> Bestand nicht_main');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'agent_verlauf_alle',aktiv:true,grund:'Test EIN'},{system:'user'});
 });

 await section('T81: Startpaket (Regeln, Verlauf, Hinweise) je neuem Lauf',async()=>{
  await pool.query("INSERT INTO memories(id,project,name,category,content,tags) VALUES($1,$2,'regel-test-t81','rules','REGELTEXT T81 Pflicht',ARRAY['pflicht'])",[randomUUID(),P]);
  const job=await C.enqueueSpecialistJob({project:P,action:'spawn',args:{name:'spez-a',identity_id:A,model:'sonnet',expertise:'Pruefer',task:'Aufgabe T81 erledigen',
   project:P,project_path:'/projects/'+P,target_runtime:'claude'}});
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE id=$1",[job.id]);
  const sk=await C.baueStartkontext(A);
  check(!!sk&&sk.text.includes('GEDAECHTNIS'),'Startkontext gebaut (gemeinsamer Baustein agent-verlauf)',sk);
  check(!!sk&&sk.text.includes('REGELTEXT T81 Pflicht')&&sk.text.includes('## Regeln deiner Rolle'),'Pflichtregel im Volltext');
  check(!!sk&&sk.text.includes('KEIN User anwesend'),'Autonomie-Hinweis (gemeinsam mit T78) fuer Nicht-Main');
  check(!!sk&&sk.text.includes('Bitte lies Thought XYZ')&&sk.text.includes('Fertig: XYZ gelesen')&&sk.text.includes('[Werkzeug mcp__synapse__thought]'),'eigene letzte Zuege voll (Eingabe, Werkzeug, Antwort)');
  check(!!sk&&sk.text.includes('Aufgabe T81 erledigen')&&sk.text.includes('Runtime-Container claude'),'Hinweise: Aufgabe und Ort Container');
  const n=await pool.query('SELECT startkontext_offen FROM agent_identitaeten WHERE id=$1',[A]);
  check(!!n.rows[0]?.startkontext_offen&&n.rows[0].startkontext_offen.zuege>=1,'Nachweis startkontext_offen fuer den naechsten Lauf',n.rows);
  const route=await C.startkontextFuer(P,'spez-a');
  check(!!route&&route.text.includes('Fertig: XYZ gelesen'),'Prompt-Route: Spezialist mit Identitaet bekommt den Startkontext');
  check((await C.startkontextFuer(P,'legacy-ohne-ausweis'))===null,'Legacy ohne Identitaet: kein Anhang (byte-gleich)');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'startkontext',aktiv:false,grund:'Test AUS'},{system:'user'});
  check((await C.baueStartkontext(A))===null,'Schalter startkontext AUS -> kein Startkontext');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'startkontext',aktiv:true,grund:'Test EIN'},{system:'user'});
  check((await C.baueStartkontext(randomUUID()))===null,'unbekannte Identitaet -> null');
 });

 await section('T82: Spawn im Container - Schalter, Rechte, Kontingent, Daemon',async()=>{
  const e={project:P,name:'spez-c',model:'sonnet',expertise:'Pruefer',task:'Container-Aufgabe'};
  check((await alsUser(()=>C.spawneImContainer(e))).error==='spezialisten_container_aus','Schalter AUS -> spezialisten_container_aus');
  await C.setzeProfilProduktSchalter({ebene:'projekt',project:P,funktion:'spezialisten_container',aktiv:true,grund:'Test EIN'},{system:'user'});
  check((await C.spawneImContainer(e)).error==='recht_fehlt','ohne User/Koordinator -> recht_fehlt');
  const k0=await alsUser(()=>C.spawneImContainer(e));
  check(k0.error==='kontingent_erreicht'&&k0.details?.container_agenten_max===0&&!!k0.details?.freigabe_weg,'Kontingent Standard 0 -> kontingent_erreicht mit Freigabe-Weg',k0);
  check((await C.fuehreContainerAdminAus('container_kontingent',{project:P,kontingent_modus:'setzen',container_agenten_max:2,grund:'x'},LK)).error==='recht_fehlt','Koordinator setzt nicht');
  const st=await C.fuehreContainerAdminAus('container_kontingent',{project:P},LK);
  check(st.success===true&&st.kontingent.container_agenten_max===0&&st.schalter.aktiv===true,'status fuer Koordinator',st);
  const s1=await C.fuehreContainerAdminAus('container_kontingent',{project:P,kontingent_modus:'setzen',container_agenten_max:1,grund:'Test User'},USER);
  check(s1.success===true&&s1.kontingent.container_agenten_max===1&&s1.kontingent.quelle==='gesetzt','User setzt Kontingent 1',s1);
  check((await alsUser(()=>C.spawneImContainer({...e,model:'gemini-pro'}))).error==='runtime_unbekannt','Modell ohne Container-Runtime -> runtime_unbekannt');
  check((await alsUser(()=>C.spawneImContainer(e))).error==='runtime_daemon_nicht_angemeldet','ohne Container-Daemon -> runtime_daemon_nicht_angemeldet');
  check((await C.spawneImContainer({...e,ort:'x'})).success===false,'Eingabe ohne Akteur bleibt abgelehnt');
  let fehler=null;try{C.leseSpawnOrt('mond');}catch(x){fehler=x.code;}
  check(fehler==='ort_ungueltig'&&C.leseSpawnOrt(undefined)===null&&C.leseSpawnOrt('container')==='container','leseSpawnOrt');
 });

 await section('T82: Spawn im Container ueber Fake-Daemon (Job, Identitaet, Projekte der Runtime)',async()=>{
  for(const [rt,main] of [['claude',true],['codex',false]]){
   await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES($1,$1,'main','/mnt/z/x','img','synapse-runtime-'||$1,$2)",[rt,main]);
  }
  const h=createHash('sha256').update('claude'+schema).digest('hex');
  await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,last_used_at) VALUES($1,'service','runtime-daemon:claude',NOW())",[h]);
  await pool.query('INSERT INTO daemon_restore_host_bindings(token_hash,hostname) VALUES($1,$2)',[h,'synapse-runtime-claude']);
  check(await C.runtimeDaemonAngemeldet('claude')===true,'Fake-Daemon angemeldet');
  // Fake-Container-Daemon: fragt NUR nach synapse-hauptagent (wie im Container) und bekommt den Job aus P trotzdem.
  let aus=false,gesehen=null;
  const lauf=(async()=>{while(!aus){
   const jobs=await C.holeSpecialistJobsFuerDaemon({daemonId:'daemon-synapse-runtime-claude-1',host:'synapse-runtime-claude',projekte:[C.HAUPTAGENT_PROJEKT],
    warteMs:0,istGeschlossen:()=>false,runtime:'claude'}).catch(()=>[]);
   for(const j of jobs){
    gesehen=j;
    await pool.query("INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled,model) VALUES($1,$2,$3,'running',false,NOW(),true,'sonnet') ON CONFLICT DO NOTHING",
     [j.target_identity_id,j.project,j.args.name]);
    await C.completeSpecialistJob(j.id,{status:'done',result:ergebnis({success:true,message:'Spezialist gestartet'})});
   }
   if(!jobs.length)await pause(50);
  }})();
  const r=await alsUser(()=>C.spawneImContainer({project:P,name:'spez-c',model:'sonnet',expertise:'Pruefer',task:'Container-Aufgabe'}));
  check(r.success===true&&r.ort==='container'&&r.runtime==='claude'&&r.identitaet_neu===true&&r.message==='Spezialist gestartet','Spawn im Container erfolgreich',r);
  check(!!gesehen&&gesehen.project===P&&gesehen.lokaler_projektpfad==='/projects/'+P,'Container-Daemon bekam den Job aus fremdem Projekt mit /projects-Pfad',gesehen&&{p:gesehen.project,pfad:gesehen.lokaler_projektpfad});
  check(gesehen?.args?.target_runtime==='claude'&&gesehen?.args?.identity_id===r.identity_id&&gesehen?.args?.keep_alive===true&&gesehen?.target_identity_id===r.identity_id,'Job-Args: target_runtime, identity_id, keep_alive',gesehen?.args);
  check(!JSON.stringify(gesehen?.args??{}).includes('sai_'),'kein Ausweis in den Job-Args');
  const i=await pool.query('SELECT agent_id,rolle,status FROM agent_identitaeten WHERE id=$1',[r.identity_id]);
  check(i.rows[0]?.agent_id==='spez-c'&&i.rows[0]?.status==='aktiv','Identitaet spez-c angelegt',i.rows);
  const voll=await alsUser(()=>C.spawneImContainer({project:P,name:'spez-d',model:'sonnet',expertise:'x',task:'y'}));
  check(voll.error==='kontingent_erreicht'&&voll.details?.belegt===1,'zweiter Agent bei Kontingent 1 -> kontingent_erreicht',voll);
  const re=await alsUser(()=>C.spawneImContainer({project:P,name:'spez-c',model:'sonnet',expertise:'Pruefer',task:'Container-Aufgabe'}));
  check(re.success===true&&re.identitaet_neu===false&&re.identity_id===r.identity_id,'Respawn derselben Identitaet zaehlt nicht doppelt',re);
  const proj=(await C.listeRuntimeProjekte('claude')).map(x=>x.name);
  check(proj.includes(P),'listeRuntimeProjekte(claude) nennt das Projekt mit Container-Agent',proj);
  check(!(await C.listeRuntimeProjekte('codex')).some(x=>x.name===P),'codex sieht das Projekt nicht');
  const b=await C.belegteContainerAgenten(P);
  check(b.length===1&&b[0].runtime==='claude','belegteContainerAgenten',b);
  const stop=await C.enqueueSpecialistJob({project:P,action:'stop',args:{name:'spez-c'}});
  const sj=(await pool.query('SELECT args,target_identity_id FROM specialist_jobs WHERE id=$1',[stop.id])).rows[0];
  check(sj.args.target_runtime==='claude'&&sj.args.project_path==='/projects/'+P&&sj.target_identity_id===r.identity_id,'stop per Name geht an den Container (kein PC-Zielhost)',sj);
  aus=true;await lauf;
 });

 await section('T82: Bearer agent:identitaet:<id> nur mit eigenem Ausweis (REST)',async()=>{
  const M=await load('packages/rest-api/dist/services/agent-runtime/main-tool-profile.js');
  const scope=M.agentIdentitaetScope(A);
  check(M.mainScopePasst(scope,'POST','/',{'x-synapse-agent-token':TOKEN_A})===true,'MCP-Weg mit Ausweis-Header erlaubt');
  check(M.mainScopePasst(scope,'GET','/api/projects',{'x-synapse-agent-token':TOKEN_A})===false,'andere Routen gesperrt');
  check(M.mainScopePasst(scope,'POST','/',{})===false,'ohne Ausweis-Header gesperrt');
  check(await M.agentScopeAusweisPasst(scope,{'x-synapse-agent-token':TOKEN_A})===true,'eigener Ausweis passt');
  check(await M.agentScopeAusweisPasst(scope,{'x-synapse-agent-token':'sai_falsch'})===false,'fremder Ausweis passt nicht');
  check(await M.agentScopeAusweisPasst(M.agentIdentitaetScope(randomUUID()),{'x-synapse-agent-token':TOKEN_A})===false,'Ausweis einer anderen Identitaet passt nicht');
  check(await M.agentScopeAusweisPasst('daemon:tray',{})===true,'andere Scopes unberuehrt');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
}finally{
 await core?.closePool?.().catch?.(()=>undefined);
 await pool?.end?.().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end().catch(()=>undefined);
}
console.log(`ERGEBNIS P22-T81/T82 S1: ${checks-failures.length}/${checks} gruen${failures.length?' – FEHLER: '+failures.map(mask).join(' | '):''}`);
process.exit(failures.length?1:0);
