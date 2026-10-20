/**
 * P22-T71 / P22-T72 / P22-T73: nahtloser Runtime-Wechsel des Main und Warteschlange des Main-Chats (Entwurf thought 34df7d4b).
 * Prueft mit Fake-Daemon (claimt/meldet specialist_jobs wie der Container-Daemon):
 *  - Schema 125: Probe idempotent, Verlauf-Status 'wartet', agent_runtime_auftraege.fortschritt, Spiegel identisch
 *  - T72: Codex-Overrides default_tools_approval_mode="approve" je MCP-Server
 *  - Runtime des Wrappers (Spawn-Ziel vor provider), leseMainLauf je Runtime, Main-Bereich fuer die Runtime des lebenden Wrappers
 *  - beendeMainLauf: 'Prozesstod UNGEPRUEFT' zaehlt nicht als Stop, erzwinge, nachgewiesener Stop, schon aus
 *  - Prozesspruefung: Identitaets-Lauf ohne cwd-Pruefung (Ursache des Befunds), Abweichung wird benannt
 *  - runtime_wechsel: ohne erzwinge rejected mit Ursache, mit erzwinge completed, Fortschritt, completed erst nach Start
 *  - Turn 'nicht verbunden', Start bei Wrapper auf anderer Runtime (erst dort stoppen)
 *  - Warteschlange: Schalter, einreihen, Main starten, Wechsel offen, einzeln, Buendel (Schwelle als Einstellung), Backoff,
 *    Einwurf (Antwort ueber die Zustellung in dieselbe Zeile), Aufraeumen, verwaiste Zeile zurueck in die Warteschlange
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Docker.
 *   node packages/core/tests/hauptagent-wechsel-warteschlange-p22-t71.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS',
 'SYNAPSE_HAUPTAGENT_ANTWORT','SYNAPSE_HAUPTAGENT_BESCHAEFTIGT','SYNAPSE_HAUPTAGENT_OHNE_DAEMON','SYNAPSE_HAUPTAGENT_TURN_MS'])delete process.env[k];
const tmp=await mkdtemp(join(tmpdir(),'p22-t71-'));
Object.assign(process.env,{HOME:tmp,SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t71_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label,detail){checks++;if(!ok){failures.push(label);console.error('FAIL '+label+(detail===undefined?'':' '+mask(JSON.stringify(detail))));}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ergebnis=obj=>({content:[{type:'text',text:JSON.stringify(obj)}]});
const UNGEPRUEFT='Prozesstod UNGEPRUEFT: Kommandozeile, Projekt oder Agent stimmen nicht mit diesem Wrapper überein (cwd)';

/** Fake-Container-Daemon: claimt Jobs seiner Runtime und beantwortet sie mit handler(job). */
function fakeDaemon(C,runtime,handler){
 let aus=false;const id='daemon-synapse-runtime-'+runtime+'-'+process.pid;
 const lauf=(async()=>{while(!aus){
  const job=await C.claimPendingSpecialistJob(C.HAUPTAGENT_PROJEKT,id,undefined,runtime).catch(()=>null);
  if(job){const r=await handler(job);await C.completeSpecialistJob(job.id,r);}else await pause(50);
 }})();
 return {id,stop:async()=>{aus=true;await lauf;}};
}

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema',
  'agent-zustellungen-schema','agent-verbrauch-schema','runtime-ueberwachung-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},HP=C.HAUPTAGENT_PROJEKT;
 const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};

 await section('Schema 125: Probe, Spiegel, idempotent',async()=>{
  await pool.query(C.HAUPTAGENT_VERLAUF_SCHEMA_SQL);
  await pool.query("ALTER TABLE hauptagent_verlauf ALTER COLUMN rev SET DEFAULT nextval('hauptagent_verlauf_rev')");
  const {MAIN_WARTESCHLANGE_SCHEMA_SQL:S125}=await load('packages/core/dist/db/main-warteschlange-schema.js');
  const sql=readFileSync(join(repo,'packages/core/src/db/schema-sql/125_main_warteschlange.sql'),'utf8');
  check(sql.trim()===S125.trim(),'125 SQL-Spiegel identisch');
  // Vorher: Bestandsdaten mit allen alten Status (die Probe darf nichts aendern).
  const M0=(await pool.query("INSERT INTO agent_identitaeten(id,project,agent_id,name,rolle,status) VALUES($1,'p22-t71-probe','probe','probe','spezialist','aktiv') RETURNING id",[randomUUID()]).catch(()=>({rows:[]}))).rows[0]?.id;
  await pool.query(S125);await pool.query(S125);
  const def=(await pool.query("SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conrelid='hauptagent_verlauf'::regclass AND conname='hauptagent_verlauf_status_check'")).rows[0]?.d??'';
  check(['laeuft','fertig','fehler','abgebrochen','wartet'].every(s=>def.includes("'"+s+"'")),'Status-CHECK kennt alle alten Werte und wartet',def);
  const anzahl=(await pool.query("SELECT count(*)::int n FROM pg_constraint WHERE conrelid='hauptagent_verlauf'::regclass AND conname='hauptagent_verlauf_status_check'")).rows[0].n;
  check(anzahl===1,'genau ein Status-CHECK nach zweimaliger Probe');
  const sp=(await pool.query("SELECT data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name='agent_runtime_auftraege' AND column_name='fortschritt'",[schema])).rows[0];
  check(sp?.data_type==='jsonb','agent_runtime_auftraege.fortschritt jsonb',sp);
  const idx=(await pool.query("SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname='idx_hauptagent_verlauf_wartet'",[schema])).rowCount;
  check(idx===1,'Index fuer wartende Zeilen');
  const {SCHEMA_SQL}=await load('packages/core/dist/db/schema.js');
  check(typeof SCHEMA_SQL!=='string'||SCHEMA_SQL.includes('hauptagent_verlauf_status_check'),'125 im ensureSchema-SQL');
  if(M0){
   check(await err(()=>pool.query("INSERT INTO hauptagent_verlauf(identity_id,rolle,richtung,weg,status) VALUES($1,'user','ein','webui','gibtsnicht')",[M0]))!=='kein_fehler','unbekannter Status weiter abgelehnt');
   await pool.query('DELETE FROM agent_identitaeten WHERE id=$1',[M0]).catch(()=>undefined);
  }
 });

 // Runtime-Instanzen + Zugang (Lebenszeichen = auth_tokens.last_used_at), Claude ist Main-Runtime.
 const zugang=async(runtime,frisch=true)=>{
  const h=createHash('sha256').update(runtime+schema).digest('hex');
  await pool.query("INSERT INTO auth_tokens(token_hash,kind,scope,last_used_at) VALUES($1,'service',$2,$3) ON CONFLICT (token_hash) DO UPDATE SET last_used_at=EXCLUDED.last_used_at",
   [h,'runtime-daemon:'+runtime,frisch?new Date():new Date(Date.now()-10*60_000)]);
  await pool.query('INSERT INTO daemon_restore_host_bindings(token_hash,hostname) VALUES($1,$2) ON CONFLICT DO NOTHING',[h,'synapse-runtime-'+runtime]);
 };
 for(const [rt,main] of [['claude',true],['codex',false]]){
  await pool.query("INSERT INTO agent_runtime_instances(runtime,driver,role,root_path,image,container_name,assigned_to_main) VALUES($1,$1,'main','/mnt/z/x','img','synapse-runtime-'||$1,$2)",[rt,main]);
 }
 // Eindeutiger Index auf assigned_to_main: erst alle aus, dann die eine an (wie repository.assignMain).
 const setMain=async rt=>{await pool.query('UPDATE agent_runtime_instances SET assigned_to_main=FALSE WHERE assigned_to_main AND runtime<>$1',[rt]);
  await pool.query('UPDATE agent_runtime_instances SET assigned_to_main=TRUE WHERE runtime=$1',[rt]);};
 await zugang('claude');await zugang('codex');
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test P22-T71 alle'},{system:'user'});
 await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test P22-T71 EIN'});
 const M=await C.stelleMainIdentitaetSicher(USER,{modell:'sonnet',runtime:'claude'});
 const MAIN=M.identity_id;
 const wrapper=async(status,o={})=>{
  await pool.query('DELETE FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[MAIN]);
  if(status)await pool.query(`INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled,provider,wrapper_pid)
    VALUES($1,$2,'hauptagent',$3,$4,$5,false,$6,$7)`,[MAIN,HP,status,!!o.busy,o.alt?new Date(Date.now()-10*60_000):new Date(),o.provider??'anthropic',o.pid??4242]);
 };
 const zeileW=async()=>(await pool.query('SELECT status,wrapper_pid FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[MAIN])).rows[0];
 const jobsWeg=()=>pool.query('DELETE FROM specialist_jobs WHERE target_identity_id=$1',[MAIN]);

 await section('T72: Codex-MCP-Werkzeuge ohne Genehmigung',async()=>{
  const R=await load('packages/agents/dist/codex-runtime.js');
  const m=R.bildeMcpAufCodexAb({mcpServers:{synapse:{type:'http',url:'http://synapse-api:3456/'},zweit:{type:'http',url:'http://y/'}}});
  check(m.overrides.includes('mcp_servers.synapse.default_tools_approval_mode="approve"')&&m.overrides.includes('mcp_servers.zweit.default_tools_approval_mode="approve"'),
   'je MCP-Server default_tools_approval_mode="approve"',m.overrides);
  const a=R.baueCodexArgs({threadId:null,cwd:'/projects/x',modell:null,deaktiviert:[],mcpOverrides:m.overrides});
  check(a.join(' ').includes('-c mcp_servers.synapse.default_tools_approval_mode="approve"'),'Override landet als -c im codex-Aufruf');
  const leer=R.bildeMcpAufCodexAb({mcpServers:{'boese name':{url:'http://x'}}});
  check(leer.overrides.length===0,'ungueltiger Servername -> keine Overrides');
 });

 await section('Runtime des Wrappers, leseMainLauf je Runtime',async()=>{
  check(C.wrapperRuntime('codex','anthropic',null)==='codex'&&C.wrapperRuntime(null,'openai',null)==='codex'&&C.wrapperRuntime(null,'anthropic-api',null)==='claude'
   &&C.wrapperRuntime(null,null,'codex/gpt-5')==='codex'&&C.wrapperRuntime(null,null,'sonnet')==='claude'&&C.wrapperRuntime(null,null,null)===null,'wrapperRuntime: Ziel > provider > Modell');
  await jobsWeg();await setMain('claude');await wrapper('running',{provider:'openai'});
  const a=await C.leseMainLauf(MAIN,'claude');
  check(a.zustand==='aus'&&a.andere_runtime==='codex'&&a.wrapper?.runtime==='codex'&&a.wrapper.wrapper_pid===4242,'Wrapper auf codex -> fuer claude nicht laeuft, andere_runtime codex',a);
  const b=await C.leseMainLauf(MAIN,'codex');
  check(b.zustand==='laeuft'&&b.andere_runtime===null,'fuer codex laeuft');
  check((await C.leseMainLauf(MAIN)).zustand==='laeuft','ohne Runtime wie bisher');
  const sj=await C.enqueueSpecialistJob({project:HP,action:'spawn',args:{name:'hauptagent',identity_id:MAIN,target_runtime:'claude',project_path:'/projects/'+HP}});
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE id=$1",[sj.id]);
  check((await C.leseMainLauf(MAIN,'claude')).zustand==='laeuft','Ziel des letzten Spawn-Jobs geht vor provider');
  await jobsWeg();
  const offen=await C.enqueueSpecialistJob({project:HP,action:'spawn',args:{name:'hauptagent',identity_id:MAIN,target_runtime:'codex',project_path:'/projects/'+HP}});
  await wrapper(null);
  const c=await C.leseMainLauf(MAIN,'claude');
  check(c.zustand==='aus'&&c.spawn_job_id===null,'offener Spawn auf codex zaehlt nicht als Start fuer claude',c);
  check((await C.leseMainLauf(MAIN,'codex')).spawn_job_id===offen.id,'... aber fuer codex');
  await jobsWeg();
 });

 await section('Main-Bereich fuer die Runtime des lebenden Wrappers',async()=>{
  await setMain('claude');await wrapper('running',{provider:'openai'});
  check((await C.projekteDerRuntime([HP],'codex')).includes(HP),'codex (nicht Main-Runtime) sieht synapse-hauptagent, solange der Main dort lebt');
  check((await C.listeRuntimeProjekte('codex')).length===1,'Projektliste des codex-Daemons enthaelt den Main-Bereich');
  check((await C.projekteDerRuntime([HP],'claude')).includes(HP),'Main-Runtime sieht ihn weiter');
  await wrapper('stopped',{provider:'openai'});
  check(!(await C.projekteDerRuntime([HP],'codex')).includes(HP)&&(await C.listeRuntimeProjekte('codex')).length===0,'Wrapper beendet -> codex sieht ihn nicht mehr');
 });

 await section('beendeMainLauf: Stop nur bei nachgewiesenem Prozessende',async()=>{
  await jobsWeg();await setMain('claude');await wrapper('running',{provider:'anthropic',pid:4242});
  let gesehen=null;
  let d=fakeDaemon(C,'claude',async j=>{gesehen=j;return {status:'done',result:ergebnis({success:false,message:UNGEPRUEFT,steps:{prozess_beendet:'ungeprueft'}})};});
  const e1=await C.beendeMainLauf(MAIN,'claude');
  await d.stop();
  check(e1.beendet===false&&e1.weg==='fehlgeschlagen'&&e1.grund?.includes('UNGEPRUEFT')&&e1.grund.includes('(cwd)'),'done + success:false -> NICHT beendet, Ursache sichtbar',e1);
  check(gesehen?.action==='stop'&&gesehen.args.ohne_sicherung===true&&gesehen.args.frist_ms===C.MAIN_STOP_FRIST_MS&&gesehen.args.wrapper_pid===4242&&gesehen.args.target_runtime==='claude',
   'Stop-Job: ohne Speicher-Runde, Frist, erwartete PID, Runtime',gesehen?.args);
  check((await zeileW())?.status==='running','Statuszeile bleibt (kein falsches stopped)');
  const erzw=[];
  d=fakeDaemon(C,'claude',async()=>({status:'done',result:ergebnis({success:false,message:UNGEPRUEFT})}));
  const e2=await C.beendeMainLauf(MAIN,'claude',{erzwinge:async rt=>{erzw.push(rt);}});
  await d.stop();
  check(e2.beendet===true&&e2.weg==='erzwungen'&&erzw.join()==='claude'&&e2.grund?.includes('UNGEPRUEFT'),'Prozess ueberlebt -> erzwinge (Container-Neustart) der alten Runtime',e2);
  check((await zeileW())?.status==='crashed','nach erzwinge Zeile per CAS crashed');
  await wrapper('running',{provider:'anthropic',pid:5151});
  d=fakeDaemon(C,'claude',async()=>{await pool.query("UPDATE agent_identitaet_wrapper_status SET status='stopped' WHERE identity_id=$1",[MAIN]);
   return {status:'done',result:ergebnis({success:true,steps:{prozess_beendet:true}})};});
  const t0=Date.now();
  const e3=await C.beendeMainLauf(MAIN,'claude');
  await d.stop();
  check(e3.beendet===true&&e3.weg==='gestoppt'&&e3.grund===null&&Date.now()-t0<8_000,'nachgewiesener Stop -> gestoppt, ohne Wartefrist',e3);
  const e4=await C.beendeMainLauf(MAIN,'claude');
  check(e4.weg==='schon_aus'&&e4.job_id===null,'schon beendet -> kein Stop-Job');
  await wrapper('running',{provider:'openai'});
  check((await C.beendeMainLauf(MAIN,'claude')).weg==='schon_aus','Wrapper auf anderer Runtime wird hier nicht gestoppt');
  await jobsWeg();
 });

 await section('Prozesspruefung: Identitaets-Lauf ohne cwd-Pruefung',async()=>{
  if(process.platform!=='linux'){check(true,'nur Linux');return;}
  const wrapperJs=join(repo,'packages/agents/dist/wrapper.js');
  const proj=join(tmp,'proj');await mkdir(proj,{recursive:true});
  const id=randomUUID();
  const starte=env=>{const k=spawn(process.execPath,[wrapperJs],{cwd:tmp,detached:true,stdio:'ignore',
   env:{PATH:process.env.PATH,SYNAPSE_AGENT_NAME:'hauptagent',SYNAPSE_PROJECT_NAME:HP,SYNAPSE_PROJECT_PATH:proj,...env}});
   process.kill(k.pid,'SIGSTOP');return k;};
  const k1=starte({SYNAPSE_AGENT_IDENTITY_ID:id});
  try{
   const p1=await C.pruefeWrapperProzess(k1.pid,'hauptagent',HP,proj,id);
   check(p1.zustand==='wrapper','Identitaets-Lauf im cwd des Daemons (nicht im Projektordner) -> als Wrapper erkannt (Ursache Befund 37e3ff9d)',p1);
   const p2=await C.pruefeWrapperProzess(k1.pid,'hauptagent',HP,proj,randomUUID());
   check(p2.zustand==='ungeprueft'&&p2.grund?.includes('identitaet'),'fremde Identitaet -> ungeprueft, Abweichung benannt',p2);
  }finally{try{process.kill(k1.pid,'SIGKILL');}catch{/* Prozess schon beendet */}}
  const k2=starte({});
  try{
   const p3=await C.pruefeWrapperProzess(k2.pid,'hauptagent',HP,proj,null);
   check(p3.zustand==='ungeprueft'&&p3.grund?.includes('cwd'),'Legacy-Lauf behaelt die cwd-Pruefung (Abweichung cwd benannt)',p3);
  }finally{try{process.kill(k2.pid,'SIGKILL');}catch{/* Prozess schon beendet */}}
  // B1: pnpm-Layout des Runtime-Images (core und agents in getrennten .pnpm-Ordnern). Das gestartete Skript liegt dort, wo der Spawn
  // es per require.resolve findet; der Monorepo-relative Pfad von core aus existiert nicht -> frueher JEDER Stop 'UNGEPRUEFT'.
  const pnpmWrapper=join(tmp,'opt','node_modules','.pnpm','@synapse+agents@file+packages+agents_ws@8.20.0','node_modules','@synapse','agents','dist','wrapper.js');
  await mkdir(dirname(pnpmWrapper),{recursive:true});
  await writeFile(pnpmWrapper,'setInterval(()=>{},1000);\n');
  const k4=spawn(process.execPath,[pnpmWrapper],{cwd:tmp,detached:true,stdio:'ignore',
   env:{PATH:process.env.PATH,SYNAPSE_AGENT_NAME:'hauptagent',SYNAPSE_PROJECT_NAME:HP,SYNAPSE_PROJECT_PATH:proj,SYNAPSE_AGENT_IDENTITY_ID:id}});
  try{
   await pause(300);
   C.registriereWrapperSkript(null);
   const p4=await C.pruefeWrapperProzess(k4.pid,'hauptagent',HP,proj,id);
   check(p4.zustand==='ungeprueft'&&p4.grund?.includes('skript'),'ohne Registrierung: Skript im pnpm-Layout nicht erkannt (Befund B1 nachgestellt)',p4);
   C.registriereWrapperSkript(pnpmWrapper);
   check((await C.erwarteteWrapperSkripte()).includes(realpathSync(pnpmWrapper)),'registrierter Spawn-Pfad zaehlt zu den erwarteten Skripten');
   const p5=await C.pruefeWrapperProzess(k4.pid,'hauptagent',HP,proj,id);
   check(p5.zustand==='wrapper','mit registriertem Spawn-Pfad: pnpm-Skript erkannt',p5);
   let gestoppt=null;
   const zugriff={identityId:()=>id,projektpfad:async()=>proj,wrapperPid:async()=>k4.pid,setzeGestoppt:async(n,p,pid)=>{gestoppt=pid;}};
   const st=await C.stoppeLokalenWrapper('hauptagent',proj,HP,zugriff,{signal:'SIGTERM',frist_ms:3000,erwartete_pid:k4.pid});
   check(st.success===true&&st.steps?.prozess_beendet===true&&gestoppt===k4.pid,'Stop im pnpm-Layout: Signal gesendet, Prozesstod nachgewiesen, Zeile per PID gestoppt',st);
  }finally{C.registriereWrapperSkript(null);try{process.kill(k4.pid,'SIGKILL');}catch{/* Prozess schon beendet */}}
  const src=readFileSync(join(repo,'packages/mcp-server/dist/tools/specialists.js'),'utf8');
  check(/cwd:\s*projectPath,\s*detached:\s*true/.test(src),'Spawn startet den Wrapper im Projektordner');
  check(src.includes('registriereWrapperSkript(resolveWrapperPath())'),'mcp-server registriert den Spawn-Pfad beim Laden');
  const w=readFileSync(join(repo,'packages/agents/dist/wrapper.js'),'utf8');
  check(w.includes("process.on('SIGUSR2'")&&w.includes('ohneSicherung'),'Wrapper: SIGUSR2 = Stop ohne Speicher-Runde');
 });

 await section('Runtime-Wechsel: Stop-Fehler, erzwinge, Fortschritt',async()=>{
  await jobsWeg();await setMain('claude');await wrapper('running',{provider:'anthropic',pid:111});
  let zugewiesen='claude';const log=[];let fortschrittBeiZuweisung=null;
  const dienste={weiseMainZu:async r=>{log.push('zuweisen:'+r);zugewiesen=r;await setMain(r);
    fortschrittBeiZuweisung=(await pool.query("SELECT fortschritt FROM agent_runtime_auftraege WHERE art='runtime_wechsel' AND status='accepted'")).rows[0]?.fortschritt??null;},
   zugewiesen:async()=>zugewiesen,standardModell:async r=>r==='codex'?'codex':'sonnet',warte_ms:10_000};
  const dc=fakeDaemon(C,'claude',async j=>{log.push('claude:'+j.action);return {status:'done',result:ergebnis({success:false,message:UNGEPRUEFT})};});
  const dx=fakeDaemon(C,'codex',async j=>{log.push('codex:'+j.action);if(j.action==='spawn'){await wrapper('running',{provider:'openai',pid:222});return {status:'done',result:ergebnis({success:true})};}
   return {status:'failed',error:'x'};});
  const r1=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'codex'},grund:'Test P22-T71 ohne erzwinge'});
  await C.fuehreRuntimeWechselAus(dienste);
  const z1=(await pool.query('SELECT status,letzter_fehler,fortschritt FROM agent_runtime_auftraege WHERE id=$1',[r1.auftrag.auftrag_id])).rows[0];
  check(z1.status==='rejected'&&z1.letzter_fehler?.startsWith('stop_alte_runtime_fehlgeschlagen: Prozesstod UNGEPRUEFT')&&z1.letzter_fehler.includes('(cwd)'),
   'Stop ohne Nachweis -> rejected mit Code UND Ursache (kein stilles completed)',z1);
  check(zugewiesen==='claude'&&!log.includes('codex:spawn'),'Zuweisung unveraendert, kein Start auf codex',log);
  check(z1.fortschritt?.schritt==='stoppt_alt'&&z1.fortschritt.runtime==='claude','Fortschritt im Auftrag: stoppt_alt',z1.fortschritt);
  const liste=await C.listeRuntimeAuftraege(USER);
  check(liste.auftraege.find(a=>a.auftrag_id===r1.auftrag.auftrag_id)?.fortschritt?.schritt==='stoppt_alt','Fortschritt in der Auftragsliste (Chip)');
  log.length=0;
  const r2=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'codex'},grund:'Test P22-T71 mit erzwinge'});
  await C.fuehreRuntimeWechselAus({...dienste,erzwingeStop:async rt=>{log.push('erzwinge:'+rt);}});
  await dc.stop();await dx.stop();
  const z2=(await pool.query('SELECT status,tatsaechlich,letzter_fehler,fortschritt FROM agent_runtime_auftraege WHERE id=$1',[r2.auftrag.auftrag_id])).rows[0];
  check(z2.status==='completed'&&z2.tatsaechlich?.runtime==='codex','mit erzwinge -> completed auf codex',z2);
  check(JSON.stringify(log)===JSON.stringify(['claude:stop','erzwinge:claude','zuweisen:codex','codex:spawn']),'Reihenfolge: stop -> erzwinge -> Zuweisung -> Start',log);
  check(fortschrittBeiZuweisung?.schritt==='alt_gestoppt'&&fortschrittBeiZuweisung.weg==='erzwungen'&&String(fortschrittBeiZuweisung.stop_ergebnis).includes('UNGEPRUEFT'),
   'Stop-Ergebnis im Auftrag sichtbar (alt_gestoppt, erzwungen, Ursache)',fortschrittBeiZuweisung);
  check(z2.fortschritt?.schritt==='laeuft'&&z2.fortschritt.runtime==='codex','letzter Schritt laeuft',z2.fortschritt);
  // completed erst, wenn der Main auf dem Ziel laeuft: Spawn schlaegt fehl -> rejected
  await jobsWeg();
  const dx2=fakeDaemon(C,'codex',async j=>{if(j.action==='stop'){await wrapper('stopped',{provider:'openai'});return {status:'done',result:ergebnis({success:true})};}
   return {status:'done',result:ergebnis({success:false,message:'CLI-Start fehlgeschlagen: x'})};});
  const dc2=fakeDaemon(C,'claude',async j=>({status:'done',result:ergebnis({success:false,message:'CLI-Start fehlgeschlagen: kaputt'})}));
  const r3=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'claude'},grund:'Test P22-T71 Start scheitert'});
  await C.fuehreRuntimeWechselAus(dienste);
  await dx2.stop();await dc2.stop();
  const z3=(await pool.query('SELECT status,letzter_fehler FROM agent_runtime_auftraege WHERE id=$1',[r3.auftrag.auftrag_id])).rows[0];
  check(z3.status==='rejected'&&z3.letzter_fehler?.startsWith('main_start_fehlgeschlagen: CLI-Start fehlgeschlagen'),'Start scheitert -> rejected statt completed',z3);
  await jobsWeg();
 });

 await section('Turn: nicht verbunden; Start bei Wrapper auf anderer Runtime',async()=>{
  await jobsWeg();await setMain('claude');await wrapper('running',{provider:'anthropic',alt:true,pid:333});
  const nv=ergebnis({success:false,message:'Spezialist "hauptagent" ist nicht verbunden. Verwende spawn_specialist um ihn zu starten.'});
  let d=fakeDaemon(C,'claude',async()=>({status:'done',result:nv}));
  check(await err(()=>C.sendeMainTurn({identity_id:MAIN,runtime:'claude',nachricht:'x'}))==='main_nicht_verbunden','nicht verbunden -> main_nicht_verbunden');
  check((await zeileW())?.status==='crashed','ohne Lebenszeichen -> Zeile crashed (naechster Start blockiert nicht)');
  await wrapper('running',{provider:'anthropic',pid:334});
  check(await err(()=>C.sendeMainTurn({identity_id:MAIN,runtime:'claude',nachricht:'x'}))==='main_nicht_verbunden','frischer Wrapper: Code ebenso');
  check((await zeileW())?.status==='running','frisches Lebenszeichen -> Zeile bleibt');
  await d.stop();
  check(C.NICHT_ERREICHT_CODES.includes('main_nicht_verbunden')&&!C.NICHT_ERREICHT_CODES.includes('main_turn_fehlgeschlagen'),'nicht verbunden wird eingereiht, Turn-Fehler nicht');
  await jobsWeg();await wrapper('running',{provider:'openai',pid:444});
  const log=[];
  const dx=fakeDaemon(C,'codex',async j=>{log.push('codex:'+j.action);if(j.action==='stop'){await wrapper('stopped',{provider:'openai'});return {status:'done',result:ergebnis({success:true})};}return {status:'failed',error:'x'};});
  const dc=fakeDaemon(C,'claude',async j=>{log.push('claude:'+j.action);if(j.action==='spawn'){await wrapper('running',{provider:'anthropic',pid:445});return {status:'done',result:ergebnis({success:true})};}return {status:'failed',error:'x'};});
  const s=await C.stelleMainLaufSicher({identity_id:MAIN,runtime:'claude',modell:'sonnet',warte_ms:10_000});
  await dx.stop();await dc.stop();
  check(s.zustand==='laeuft'&&JSON.stringify(log)===JSON.stringify(['codex:stop','claude:spawn']),'Wrapper auf codex -> erst dort stoppen, dann auf claude starten',log);
  await jobsWeg();
 });

 await section('Warteschlange des Main-Chats',async()=>{
  await jobsWeg();await setMain('claude');await wrapper(null);
  check(await C.warteschlangeAktiv()===false,'Standard AUS ("alle" schaltet sie nicht ein)');
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'main_warteschlange',aktiv:true,grund:'Test P22-T71 Warteschlange'},{system:'user'});
  check(await C.warteschlangeAktiv()===true,'Schalter main_warteschlange EIN');
  check(await err(()=>C.setzeWarteschlangeSchalter({art:'identitaet'},{aktiv:true,grund:'x'}))==='recht_fehlt','REST-Schalter nur fuer den User');
  const einst=await C.leseRuntimeUeberwachungEinstellungen();
  check(einst.warteschlange_buendel_sekunden?.wert===120&&einst.warteschlange_buendel_sekunden.quelle==='standard','Schwelle: Einstellung mit Standard 120 und Quelle');
  const zeile=async id=>(await pool.query('SELECT status,text,meta,hinweise FROM hauptagent_verlauf WHERE id=$1',[id])).rows[0];
  const neuerTurn=async(text,alterMs=0,art='warten',inbox=null)=>{
   const t=await C.legeVerlaufTurnAn({identity_id:MAIN,text,session_id:'s-t71',runtime:'claude',modell:'sonnet'});
   assert.ok(t.gespeichert,'Turn gespeichert');
   const w=C.starteVerlaufAntwort(t.antwort_id,{identity_id:MAIN});await w.uebergeben();
   assert.ok(await C.stelleInWarteschlange(t.antwort_id,{art,grund:art==='einwurf'?'beschaeftigt':'runtime_nicht_bereit',inbox_id:inbox}));
   if(alterMs)await pool.query("UPDATE hauptagent_verlauf SET erstellt_am=NOW()-($2::int*interval '1 millisecond') WHERE id=$1::bigint",[t.user_id,alterMs]);
   return t;
  };
  const t1=await neuerTurn('Bist du da?');
  const z1=await zeile(t1.antwort_id);
  check(z1.status==='wartet'&&z1.meta.warteschlange?.art==='warten'&&z1.meta.warteschlange.grund==='runtime_nicht_bereit'&&!!z1.meta.warteschlange.seit,'einreihen: Antwortzeile wartet mit Grund und seit',z1);
  // Kein Main: Takt startet ihn (Daemon angemeldet), Zeile wartet weiter.
  const dienste={standardModell:async r=>r==='codex'?'codex':'sonnet'};
  const k0=await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
  const spawn0=(await pool.query("SELECT args FROM specialist_jobs WHERE target_identity_id=$1 AND action='spawn' AND status='pending'",[MAIN])).rows;
  check(k0.grund==='main_wird_gestartet'&&spawn0.length===1&&spawn0[0].args.target_runtime==='claude','kein Main -> Start ausgeloest, nichts zugestellt',k0);
  check((await zeile(t1.antwort_id)).status==='wartet','Zeile wartet weiter');
  await jobsWeg();
  // Wechsel offen -> warten
  await wrapper('running',{provider:'anthropic'});
  const rw=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'codex'},grund:'Test P22-T71 Wechsel offen'});
  check((await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste})).grund==='wechsel_offen','offener Wechsel -> warten');
  check(await C.mainWechselOffen(MAIN)===true,'mainWechselOffen');
  await C.brecheRuntimeAuftragAb(USER,{auftrag_id:rw.auftrag.auftrag_id,grund:'Test P22-T71 abbrechen'});
  // busy -> warten
  await wrapper('running',{provider:'anthropic',busy:true});
  check((await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste})).grund==='beschaeftigt','Main beschaeftigt -> warten');
  // Einzeln
  await wrapper('running',{provider:'anthropic'});
  const wakes=[];let antwort='Ja, ich bin da.';let modus='ok';
  const d=fakeDaemon(C,'claude',async j=>{
   if(j.action==='wake'){wakes.push(j.args);
    if(modus==='nv')return {status:'done',result:ergebnis({success:false,message:'Spezialist "hauptagent" ist nicht verbunden.'})};
    if(modus==='busy'){const i=(await pool.query("INSERT INTO specialist_inbox(project,from_agent,to_agent,content,to_identity_id) VALUES($1,$2,'hauptagent',$3,$4) RETURNING id",[HP,j.args.absender??'koordinator',j.args.message,MAIN])).rows[0].id;
     return {status:'done',result:ergebnis({success:true,queued:true,inbox_id:i,message:'in Inbox'})};}
    return {status:'done',result:ergebnis({success:true,response:antwort,tokens:{input:12,output:5}})};}
   if(j.action==='zustellen')return {status:'done',result:ergebnis({success:true,zugestellt:true,response:'Antwort auf den Einwurf',tokens:{input:3,output:2}})};
   return {status:'failed',error:'x'};});
  try{
   const k1=await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
   const z=await zeile(t1.antwort_id);
   check(k1.zugestellt===1&&k1.buendel===false&&z.status==='fertig'&&z.text==='Ja, ich bin da.','einzeln zugestellt, Antwort in derselben Zeile',{k1,z});
   check(wakes[0]?.message==='Bist du da?'&&wakes[0].absender==='user'&&wakes[0].target_runtime==='claude','wake mit Originaltext, Absender user, zugewiesene Runtime',wakes[0]);
   check(!!z.meta.warteschlange?.zugestellt_am,'meta.warteschlange bleibt (zugestellt_am)');
   // Kurze Unterbrechung, zwei wartende -> einzeln in Reihenfolge
   wakes.length=0;
   const a=await neuerTurn('erste');const b=await neuerTurn('zweite');
   await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
   check(wakes.length===1&&wakes[0].message==='erste'&&(await zeile(a.antwort_id)).status==='fertig'&&(await zeile(b.antwort_id)).status==='wartet','kurz: nur die aelteste zuerst');
   await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
   check(wakes.length===2&&wakes[1].message==='zweite'&&(await zeile(b.antwort_id)).status==='fertig','danach die naechste');
   // Lange Unterbrechung -> ein Buendel
   wakes.length=0;antwort='Zusammen beantwortet.';
   const c1=await neuerTurn('Nachricht A',10*60_000);const c2=await neuerTurn('Nachricht B',5*60_000);
   const kb=await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
   const za=await zeile(c1.antwort_id),zb=await zeile(c2.antwort_id);
   check(kb.buendel===true&&kb.zugestellt===2&&wakes.length===1,'lang: genau EIN Buendel-Turn',kb);
   check(/^\[2 Nachrichten des Users/.test(wakes[0]?.message??'')&&wakes[0].message.includes('Nachricht A')&&wakes[0].message.includes('Nachricht B')
    &&wakes[0].message.indexOf('Nachricht A')<wakes[0].message.indexOf('Nachricht B')&&/\[\d\d\.\d\d\., \d\d:\d\d\]/.test(wakes[0].message),'Buendel: Kopf, Reihenfolge, Zeitstempel',wakes[0]?.message);
   check(zb.status==='fertig'&&zb.text==='Zusammen beantwortet.'&&zb.meta.warteschlange?.buendel===2,'Antwort an der letzten Nachricht',zb);
   check(za.status==='fertig'&&za.hinweise.some(h=>h.includes('#'+c2.antwort_id))&&za.meta.warteschlange?.buendel_antwort_id===c2.antwort_id,'uebrige verweisen auf die Antwort',za);
   // Schwelle als Einstellung: 0 = immer Buendel
   await C.setzeRuntimeUeberwachungEinstellungen(USER,null,{werte:{warteschlange_buendel_sekunden:0},grund:'Test P22-T71 Schwelle 0'});
   wakes.length=0;
   const e1=await neuerTurn('frisch 1');const e2=await neuerTurn('frisch 2');
   const ks=await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
   check(ks.buendel===true&&wakes.length===1&&(await zeile(e2.antwort_id)).status==='fertig'&&(await zeile(e1.antwort_id)).status==='fertig','Schwelle 0 -> auch frische als Buendel');
   await C.setzeRuntimeUeberwachungEinstellungen(USER,null,{entfernen:['warteschlange_buendel_sekunden'],grund:'Test P22-T71 Schwelle zurueck'});
   // Nicht erreicht -> zurueck mit Backoff, kein Fehler
   modus='nv';wakes.length=0;
   const n1=await neuerTurn('geht gerade nicht');
   const kn=await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
   const zn=await zeile(n1.antwort_id);
   check(kn.grund==='nicht_erreicht: main_nicht_verbunden'&&zn.status==='wartet'&&zn.meta.warteschlange?.versuche===1&&!!zn.meta.warteschlange.naechster_versuch&&zn.meta.warteschlange.grund==='main_nicht_verbunden',
    'nicht erreicht -> wartet weiter mit Versuch und Backoff (kein Fehler)',{kn,zn});
   check((await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste})).grund==='backoff'&&wakes.length===1,'Backoff haelt den naechsten Versuch zurueck');
   modus='ok';antwort='Jetzt geht es.';
   await pool.query("UPDATE hauptagent_verlauf SET meta=jsonb_set(meta,'{warteschlange,naechster_versuch}','null') WHERE id=$1::bigint",[n1.antwort_id]);
   await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
   check((await zeile(n1.antwort_id)).text==='Jetzt geht es.','nach Wiederherstellung: Antwort kommt ohne Neu-Senden');
   // Einwurf: Main beschaeftigt -> Inbox; die Zustellung schreibt die Antwort in dieselbe Zeile
   const opt={aktiv:true,channel_modus:'alle',turn_warte_ms:10_000};
   await C.fuehreZustellungAus({identity_id:MAIN,runtime:'claude',optionen:opt});
   modus='busy';
   const tb=await C.sendeMainTurn({identity_id:MAIN,runtime:'claude',nachricht:'Einwurf bitte',absender:'user'});
   check(tb.art==='zugestellt'&&Number.isInteger(tb.inbox_id),'beschaeftigt -> zugestellt mit inbox_id',tb);
   const absender=(await pool.query('SELECT from_agent FROM specialist_inbox WHERE id=$1',[tb.inbox_id])).rows[0]?.from_agent;
   check(absender==='user','Inbox-Absender user statt koordinator',absender);
   const ew=await neuerTurn('Einwurf bitte',0,'einwurf',tb.inbox_id);
   // B5: Einwurf vor 5 s -> die Antwortzeile zaehlt ihre Dauer ab dem Einwurf (nicht '0.0 s').
   await pool.query("UPDATE hauptagent_verlauf SET meta=jsonb_set(meta,'{warteschlange,seit}',to_jsonb(to_char((NOW()-interval '5 seconds') AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'))) WHERE id=$1::bigint",[ew.antwort_id]);
   check((await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste})).grund==='nur_einwuerfe','Einwurf wartet auf die Zustellung, nicht auf den Takt');
   const zu=await C.fuehreZustellungAus({identity_id:MAIN,runtime:'claude',optionen:opt});
   const ze=await zeile(ew.antwort_id);
   check(zu.zugestellt>=1&&ze.status==='fertig'&&ze.text==='Antwort auf den Einwurf','Einwurf: Antwort in der wartenden Zeile',{zu,ze});
   const zugE=(await pool.query('SELECT zug FROM hauptagent_verlauf WHERE id=$1::bigint',[ew.antwort_id])).rows[0]?.zug;
   check(zugE?.dauer_ms>=4_000,'Einwurf-Antwort: Dauer ab dem Einwurf',zugE);
   const paar=(await pool.query("SELECT count(*)::int n FROM hauptagent_verlauf WHERE identity_id=$1 AND rolle='nachricht'",[MAIN])).rows[0].n;
   check(paar===0,'kein zusaetzliches Nachricht/Antwort-Paar');
   // Einwurf, den der Main anders gelesen hat -> aufgeraeumt statt ewig wartend
   const ib=(await pool.query("INSERT INTO specialist_inbox(project,from_agent,to_agent,content,to_identity_id,processed) VALUES($1,'user','hauptagent','schon gelesen',$2,true) RETURNING id",[HP,MAIN])).rows[0].id;
   const ea=await neuerTurn('schon gelesen',0,'einwurf',ib);
   await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste});
   const zea=await zeile(ea.antwort_id);
   check(zea.status==='fertig'&&zea.hinweise.some(h=>h.includes('Einwurf')),'gelesener Einwurf ohne Zustellung -> abgeschlossen mit Hinweis',zea);
  }finally{await d.stop();}
  // Verwaiste laufende Zeile aus der Warteschlange geht zurueck, andere werden abgebrochen
  const v1=await neuerTurn('verwaist');
  await pool.query("UPDATE hauptagent_verlauf SET status='laeuft', aktualisiert_am=NOW()-interval '5 minutes' WHERE id=$1::bigint",[v1.antwort_id]);
  const v2=await C.legeVerlaufTurnAn({identity_id:MAIN,text:'normal',session_id:'s-t71',runtime:'claude',modell:'sonnet'});
  await pool.query("UPDATE hauptagent_verlauf SET aktualisiert_am=NOW()-interval '5 minutes' WHERE id=$1::bigint",[v2.antwort_id]);
  await C.leseVerlauf();
  check((await zeile(v1.antwort_id)).status==='wartet'&&(await zeile(v2.antwort_id)).status==='abgebrochen','verwaist: Warteschlangen-Zeile zurueck auf wartet, normale abgebrochen');
  const st=await C.warteschlangeStatus(MAIN);
  check(st.wirksam===true&&st.schwelle?.sekunden===120&&st.wartend.some(w=>w.antwort_id===v1.antwort_id&&w.art==='warten'),'Debug-Status: wirksam, Schwelle, wartende Zeilen',st);
  const vs=await C.verlaufStatus();
  check(vs.wartend>=1,'verlaufStatus zaehlt wartende Zeilen',vs.wartend);
  await C.setzeProfilProduktSchalter({ebene:'global',funktion:'main_warteschlange',aktiv:false,grund:'Test P22-T71 AUS'},{system:'user'});
  check((await C.fuehreMainWarteschlangeAus({identity_id:MAIN,runtime:'claude',dienste})).grund==='schalter_aus','Schalter AUS -> Takt tut nichts');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
}finally{
 await core?.closePool?.().catch?.(()=>undefined);
 await pool?.end?.().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end().catch(()=>undefined);
 await rm(tmp,{recursive:true,force:true}).catch(()=>undefined);
}
console.log(`ERGEBNIS P22-T71/T72/T73: ${checks-failures.length}/${checks} gruen${failures.length?' – FEHLER: '+failures.map(mask).join(' | '):''}`);
process.exit(failures.length?1:0);
