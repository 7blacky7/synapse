/**
 * P22-T6 (W2c): dauerhafter Hauptagent im Runtime-Container.
 * Prueft mit Fake-Daemon (claimt/meldet specialist_jobs wie der Container-Daemon) und Fake-Wrapper (Unix-Socket JSON-RPC):
 *  - Claim-Filter args.target_runtime (PC nie, Container nur eigene Runtime, Pfad /projects/<name>)
 *  - Erstkontakt: genau ein Spawn-Job, laufender Wrapper -> kein Spawn, Modell passend zur Runtime, kein Ausweis in Job-args
 *  - Chat-Turn = wake-Job (Antwort, Inbox-Rueckfall, O2 'fehler', Fehlerfall)
 *  - Runtime-Auftraege: Claim/ACK mit claim_revision-Fence, Lease-Ablauf/versoehnen, modell_bestaetigt, Status-Ausfuehrung
 *  - Wiederanbindung nach Daemon-Neustart (bindeWrapperAn: Identitaets-Laeufe unter ~/.synapse/agent-runs/<id>)
 *  - Runtime-Wechsel Claude <-> Codex (fuehreRuntimeWechselAus) inkl. fehlendem Ziel-Daemon
 *  - Heartbeat beim Spawn (Main Standard AUS)
 *  - Codex-Runtime im Wrapper-Modus gegen eine Fake-codex-CLI (exec --json, resume derselben Thread-ID, keine Geheimnisse in argv)
 * Nur synapse_test:5433, eigenes privates Schema, keine Modelle/Netz/Docker.
 *   node packages/core/tests/hauptagent-lauf-p22-t6.test.mjs
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AUTH_DISABLED','SYNAPSE_MAIN_SYNAPSE','SYNAPSE_HAUPTAGENT','SYNAPSE_AGENTEN_AUSWEIS',
 'SYNAPSE_HAUPTAGENT_ANTWORT','SYNAPSE_HAUPTAGENT_BESCHAEFTIGT','SYNAPSE_HAUPTAGENT_OHNE_DAEMON','SYNAPSE_HAUPTAGENT_TURN_MS'])delete process.env[k];
const tmp=await mkdtemp(join(tmpdir(),'p22-t6-'));
Object.assign(process.env,{HOME:tmp,SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_AGENT_BEZUG_MODUS:'beide',SYNAPSE_W1B_GATE_TTL_MS:'0',SYNAPSE_ONBOARDING_RUHE_MIN:'0',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
let network=0;
globalThis.fetch=async()=>{network++;throw Error('Testnetz gesperrt');};
const {Pool}=require('pg'),admin=new Pool({connectionString:url.href});
const schema='p22_t6_'+process.pid+'_'+randomUUID().slice(0,8);
const failures=[];let core,pool,checks=0;
const mask=s=>String(s).replace(/sai_[a-z0-9]{1,64}/g,'[AUSWEIS]').replace(/postgres(?:ql)?:\/\/[^\s]+/g,'[DB]');
function check(ok,label){checks++;if(!ok){failures.push(label);console.error('FAIL '+label);}}
async function section(name,fn){try{await fn();console.log('ABSCHNITT '+name+' durchlaufen');}catch(e){failures.push(name+': '+mask(e.message));console.error('FAIL Abschnitt '+name+': '+mask(e.stack));}}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const ergebnis=obj=>({content:[{type:'text',text:JSON.stringify(obj)}]});

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
 for(const file of ['agent-identitaet-schema','agent-bezug-schema','agent-profil-schema','agent-ausweis-schema','agent-ausweis-nr-schema','agent-runtime-auftraege-schema','agent-zustellungen-schema']){
  const module=await load('packages/core/dist/db/'+file+'.js');
  const sql=Object.values(module).find(v=>typeof v==='string');await pool.query(sql);await pool.query(sql);
 }
 await pool.query("CREATE SEQUENCE IF NOT EXISTS agent_ausweis_nr");
 const C=core,USER={art:'user'},HP=C.HAUPTAGENT_PROJEKT;
 const err=async f=>{try{await f();return 'kein_fehler';}catch(e){return e.code??e.message;}};

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
 await C.setzeProfilProduktSchalter({ebene:'global',funktion:'alle',aktiv:true,grund:'Test P22-T6 alle'},{system:'user'});
 await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test P22-T6 EIN'});
 const M=await C.stelleMainIdentitaetSicher(USER,{modell:'opus',runtime:'claude'});
 const MAIN=M.identity_id;
 const wrapper=async(status,busy=false)=>{
  await pool.query('DELETE FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[MAIN]);
  if(status)await pool.query("INSERT INTO agent_identitaet_wrapper_status(identity_id,project,agent_name,status,busy,last_activity,heartbeat_enabled) VALUES($1,$2,'hauptagent',$3,$4,NOW(),true)",[MAIN,HP,status,busy]);
 };

 await section('Claim-Filter target_runtime',async()=>{
  const ohne=await C.enqueueSpecialistJob({project:HP,action:'status',args:{project_path:'/x'}});
  const claude=await C.enqueueSpecialistJob({project:HP,action:'status',args:{project_path:'/x',target_runtime:'claude'}});
  const codex=await C.enqueueSpecialistJob({project:HP,action:'status',args:{project_path:'/x',target_runtime:'codex'}});
  check(await err(()=>C.enqueueSpecialistJob({project:HP,action:'status',args:{target_runtime:'gemini'}}))==='specialist_ziel_runtime_ungueltig','unbekannte target_runtime abgelehnt');
  const pc=await C.claimPendingSpecialistJob(HP,'daemon-pc-1','pc-host');
  check(pc?.id===ohne.id,'PC-Daemon claimt nur den Job ohne target_runtime');
  check((await C.claimPendingSpecialistJob(HP,'daemon-pc-1','pc-host'))===null,'PC-Daemon claimt nie target_runtime-Jobs');
  const jobs=await C.holeSpecialistJobsFuerDaemon({daemonId:'daemon-synapse-runtime-claude-1',host:'synapse-runtime-claude',projekte:[HP],warteMs:0,istGeschlossen:()=>false,runtime:'claude'});
  check(jobs.length===1&&jobs[0].id===claude.id,'Claude-Container bekommt nur seinen Job');
  check(jobs[0]?.lokaler_projektpfad==='/projects/'+HP,'Projektpfad im Container /projects/<name>');
  const cx=await C.claimPendingSpecialistJob(HP,'daemon-synapse-runtime-codex-1',undefined,'codex');
  check(cx?.id===codex.id,'Codex-Container bekommt nur seinen Job');
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE project=$1",[HP]);
  const stop=await C.enqueueSpecialistJob({project:HP,action:'stop',args:{name:'hauptagent',identity_id:MAIN,project_path:'/projects/'+HP,target_runtime:'claude'}});
  check(!!stop.id,'stop mit target_runtime braucht keinen PC-Zielhost');
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE id=$1",[stop.id]);
 });

 await section('Daemon angemeldet (Lebenszeichen)',async()=>{
  check(await C.runtimeDaemonAngemeldet('claude')===false,'ohne Zugang nicht angemeldet');
  await zugang('claude',false);
  check(await C.runtimeDaemonAngemeldet('claude')===false,'altes Lebenszeichen -> nicht angemeldet');
  await zugang('claude',true);
  check(await C.runtimeDaemonAngemeldet('claude')===true,'frisches Lebenszeichen -> angemeldet');
 });

 await section('Erstkontakt: genau ein Spawn',async()=>{
  await wrapper(null);
  const [a,b]=await Promise.all([C.stelleMainLaufSicher({identity_id:MAIN,runtime:'claude',modell:'sonnet',warte_ms:0}),C.stelleMainLaufSicher({identity_id:MAIN,runtime:'claude',modell:'sonnet',warte_ms:0})]);
  const spawns=(await pool.query("SELECT args FROM specialist_jobs WHERE target_identity_id=$1 AND action='spawn' AND status='pending'",[MAIN])).rows;
  check(spawns.length===1&&a.spawn_job_id===b.spawn_job_id&&[a.neu,b.neu].filter(Boolean).length===1,'paralleler Erstkontakt -> genau ein Spawn-Job');
  const args=spawns[0]?.args??{};
  check(args.target_runtime==='claude'&&args.project_path==='/projects/'+HP&&args.keep_alive===true&&args.name==='hauptagent','Spawn-Args: Runtime, Pfad, keep_alive');
  check(args.model==='opus','Spawn nutzt das konfigurierte Profil-Modell (modell_bestaetigt) vor dem Runtime-Standard');
  check(!/sai_[a-z0-9]/.test(JSON.stringify(args)),'kein Ausweis in Job-args');
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE target_identity_id=$1",[MAIN]);
  await wrapper('running');
  const c=await C.stelleMainLaufSicher({identity_id:MAIN,runtime:'claude',modell:'sonnet',warte_ms:0});
  check(c.zustand==='laeuft'&&c.spawn_job_id===null,'laufender Wrapper -> kein neuer Spawn');
  check(C.modellPasstZuRuntime('opus','claude')&&!C.modellPasstZuRuntime('opus','codex')&&C.modellPasstZuRuntime('codex','codex')&&!C.modellPasstZuRuntime('codex','claude'),'modellPasstZuRuntime');
  await wrapper(null);
  await C.stelleMainLaufSicher({identity_id:MAIN,runtime:'codex',modell:'codex',warte_ms:0});
  const cs=(await pool.query("SELECT args FROM specialist_jobs WHERE target_identity_id=$1 AND action='spawn' AND status='pending'",[MAIN])).rows;
  check(cs[0]?.args.model==='codex'&&cs[0]?.args.target_runtime==='codex','Codex-Spawn: Claude-Profilmodell wird nicht uebernommen');
  await pool.query("UPDATE specialist_jobs SET status='done' WHERE target_identity_id=$1",[MAIN]);
  // Start mit Fake-Daemon bis 'laeuft'
  const d=fakeDaemon(C,'claude',async j=>{if(j.action==='spawn'){await wrapper('running');return {status:'done',result:ergebnis({success:true})};}return {status:'failed',error:'x'};});
  await wrapper(null);
  const s=await C.stelleMainLaufSicher({identity_id:MAIN,runtime:'claude',modell:'sonnet',warte_ms:10_000});
  await d.stop();
  check(s.zustand==='laeuft'&&s.neu===true,'Spawn ueber Fake-Daemon -> laeuft');
 });

 await section('Chat-Turn ueber wake',async()=>{
  await wrapper('running');
  const opt={antwort:'fertig',beschaeftigt:'inbox',ohne_daemon:'altweg',turn_warte_ms:10_000};
  let seen=null;
  const d=fakeDaemon(C,'claude',async j=>{seen=j;
   if(j.args.message==='busy')return {status:'done',result:ergebnis({success:true,queued:true,message:'in Inbox'})};
   if(j.args.message==='kaputt')return {status:'failed',error:'specialist_exception',message:'nicht verbunden'};
   return {status:'done',result:ergebnis({success:true,response:'Hallo User',tokens:{input:11,output:4}})};});
  const r=await C.sendeMainTurn({identity_id:MAIN,runtime:'claude',nachricht:'Hallo',optionen:opt});
  check(r.art==='antwort'&&r.text==='Hallo User'&&r.usage.inputTokens===11&&r.usage.outputTokens===4,'wake -> fertige Antwort + usage');
  check(seen?.action==='wake'&&seen.args.target_runtime==='claude'&&seen.target_identity_id===MAIN,'wake-Job an die Main-Identitaet mit target_runtime');
  const q=await C.sendeMainTurn({identity_id:MAIN,runtime:'claude',nachricht:'busy',optionen:opt});
  check(q.art==='zugestellt','beschaeftigt (Vorlage) -> zugestellt (Inbox)');
  check(await err(()=>C.sendeMainTurn({identity_id:MAIN,runtime:'claude',nachricht:'kaputt',optionen:opt}))==='main_turn_fehlgeschlagen','Fehler des Daemons -> main_turn_fehlgeschlagen');
  await d.stop();
  await wrapper('running',true);
  check(await err(()=>C.sendeMainTurn({identity_id:MAIN,runtime:'claude',nachricht:'x',optionen:{...opt,beschaeftigt:'fehler'}}))==='main_beschaeftigt','O2 fehler: busy -> main_beschaeftigt ohne Job');
  await wrapper(null);
  check(await err(()=>C.sendeMainTurn({identity_id:MAIN,runtime:'claude',nachricht:'x',optionen:opt}))==='main_laeuft_nicht','kein Lauf -> main_laeuft_nicht');
  const o=C.leseMainLaufOptionen({SYNAPSE_HAUPTAGENT_BESCHAEFTIGT:'fehler',SYNAPSE_HAUPTAGENT_OHNE_DAEMON:'quatsch',SYNAPSE_HAUPTAGENT_TURN_MS:'1000'});
  check(o.beschaeftigt==='fehler'&&o.ohne_daemon==='altweg'&&o.antwort==='fertig'&&o.turn_warte_ms===600_000,'O1-O3 per Env umschaltbar, ungueltig -> Standard');
 });

 await section('Runtime-Auftraege: Claim/ACK/Fence',async()=>{
  const n=await C.legeRuntimeAuftragAn(USER,{art:'neustart',grund:'Test P22-T6 neustart'});
  check(n.auftrag.ausfuehrung==='wartet_auf_runtime_daemon','Status: neustart wartet auf Runtime-Daemon');
  const u=await C.legeRuntimeAuftragAn(USER,{art:'update',grund:'Test P22-T6 update'});
  check(u.auftrag.ausfuehrung==='ausstehend_kein_executor','Status: update weiter ohne Ausfuehrer');
  check((await C.claimeRuntimeAuftraege({projekte:['fremd']})).length===0,'fremdes Projekt claimt nichts');
  const [a]=await C.claimeRuntimeAuftraege({projekte:[HP]});
  check(a?.art==='neustart'&&a.status==='claimed'&&a.claim_revision===1&&a.modell_konfiguriert==='opus'&&a.versoehnen===false,'Claim: neustart rev 1, Modell mitgeliefert');
  check((await C.claimeRuntimeAuftraege({projekte:[HP]})).length===0,'zweiter Claim leer (update nie, neustart vergeben)');
  check((await C.listeRuntimeAuftraege(USER)).auftraege.find(x=>x.auftrag_id===a.auftrag_id)?.ausfuehrung==='in_ausfuehrung','Status: in_ausfuehrung');
  const fence={projekte:[HP],auftrag_id:a.auftrag_id};
  check(await err(()=>C.meldeRuntimeAuftrag({...fence,claim_revision:2,meldung:{schritt:'accepted'}}))==='auftrag_nicht_eigen','falsche Revision -> auftrag_nicht_eigen');
  check(await err(()=>C.meldeRuntimeAuftrag({...fence,projekte:['fremd'],claim_revision:1,meldung:{schritt:'accepted'}}))==='auftrag_nicht_eigen','fremde Projekte -> auftrag_nicht_eigen');
  await C.meldeRuntimeAuftrag({...fence,claim_revision:1,meldung:{schritt:'accepted'}});
  // Lease abgelaufen: Neu-Claim versoehnen, alte Revision abgeloest
  await pool.query("UPDATE agent_runtime_auftraege SET lease_bis=NOW()-interval '1 minute' WHERE id=$1",[a.auftrag_id]);
  const [b]=await C.claimeRuntimeAuftraege({projekte:[HP]});
  check(b?.auftrag_id===a.auftrag_id&&b.claim_revision===2&&b.versoehnen===true&&b.status==='accepted','abgelaufene Lease: versoehnen, rev 2');
  check(await err(()=>C.meldeRuntimeAuftrag({...fence,claim_revision:1,meldung:{schritt:'completed',tatsaechlich:{modell:'opus',runtime:'claude'}}}))==='auftrag_nicht_eigen','abgeloester Ausfuehrer kann nicht melden');
  check(await err(()=>C.meldeRuntimeAuftrag({...fence,claim_revision:2,meldung:{schritt:'rejected',fehler:'sai_abcdef123'}}))==='inhalt_enthaelt_ausweis','Ausweis im Fehlertext abgelehnt');
  const c=await C.meldeRuntimeAuftrag({...fence,claim_revision:2,meldung:{schritt:'completed',tatsaechlich:{modell:'opus',runtime:'claude'}}});
  check(c.status==='completed'&&c.tatsaechlich.modell==='opus','completed mit tatsaechlich');
  const st=await C.hauptagentStatus(USER);
  check(st.identitaet.modell_tatsaechlich==='opus'&&st.identitaet.runtime_tatsaechlich==='claude','Status: tatsaechlich aus ACK');
  await C.brecheRuntimeAuftragAb(USER,{auftrag_id:u.auftrag.auftrag_id,grund:'Test P22-T6 abbrechen'});
  // modellwechsel -> modell_bestaetigt
  await C.setzeHauptagentSchalter(USER,{aktiv:true,grund:'Test P22-T6 erneut'});
  await pool.query("UPDATE agent_identitaeten SET startrezept=jsonb_set(startrezept,'{erlaubte_modelle}','[\"opus\",\"sonnet\"]') WHERE id=$1",[MAIN]);
  const mw=await C.legeRuntimeAuftragAn(USER,{art:'modellwechsel',gewuenscht:{modell:'sonnet'},grund:'Test P22-T6 modellwechsel'});
  const [m]=await C.claimeRuntimeAuftraege({projekte:[HP]});
  check(m?.auftrag_id===mw.auftrag.auftrag_id&&m.gewuenscht.modell==='sonnet','modellwechsel geclaimt mit gewuenscht');
  await C.meldeRuntimeAuftrag({projekte:[HP],auftrag_id:m.auftrag_id,claim_revision:m.claim_revision,meldung:{schritt:'completed',tatsaechlich:{modell:'sonnet',runtime:'claude'}}});
  check((await pool.query('SELECT modell_bestaetigt FROM agent_identitaeten WHERE id=$1',[MAIN])).rows[0].modell_bestaetigt==='sonnet','completed modellwechsel -> modell_bestaetigt');
  const rw=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'codex'},grund:'Test P22-T6 rw nicht fuer Daemon'});
  check((await C.claimeRuntimeAuftraege({projekte:[HP]})).length===0,'runtime_wechsel nie vom Container-Daemon geclaimt');
  check(rw.auftrag.ausfuehrung==='wartet_auf_runtime_daemon','runtime_wechsel hat einen Ausfuehrer (API)');
  await C.brecheRuntimeAuftragAb(USER,{auftrag_id:rw.auftrag.auftrag_id,grund:'Test P22-T6 rw abbrechen'});
 });

 await section('Runtime-Wechsel Claude <-> Codex',async()=>{
  let zugewiesen='claude';const log=[];
  const dienste={weiseMainZu:async r=>{log.push('zuweisen:'+r);zugewiesen=r;await pool.query('UPDATE agent_runtime_instances SET assigned_to_main=FALSE WHERE assigned_to_main');await pool.query('UPDATE agent_runtime_instances SET assigned_to_main=TRUE WHERE runtime=$1',[r]);},
   zugewiesen:async()=>zugewiesen,standardModell:async r=>r==='codex'?'codex':'sonnet',warte_ms:10_000};
  // Ziel-Daemon fehlt -> rejected
  await wrapper('running');
  const r0=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'codex'},grund:'Test P22-T6 ohne Ziel'});
  check(await C.fuehreRuntimeWechselAus(dienste)===1,'API claimt runtime_wechsel');
  const z0=(await pool.query('SELECT status,letzter_fehler FROM agent_runtime_auftraege WHERE id=$1',[r0.auftrag.auftrag_id])).rows[0];
  check(z0.status==='rejected'&&z0.letzter_fehler==='runtime_daemon_fehlt'&&zugewiesen==='claude','Ziel-Daemon fehlt -> rejected, Zuweisung unveraendert');
  // Mit beiden Daemons
  await zugang('codex',true);
  const dc=fakeDaemon(C,'claude',async j=>{log.push('claude:'+j.action);if(j.action==='stop'){await wrapper('stopped');return {status:'done',result:ergebnis({success:true})};}return {status:'failed',error:'x'};});
  const dx=fakeDaemon(C,'codex',async j=>{log.push('codex:'+j.action+':'+j.args.model);if(j.action==='spawn'){await wrapper('running');return {status:'done',result:ergebnis({success:true})};}return {status:'failed',error:'x'};});
  const r1=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'codex'},grund:'Test P22-T6 nach codex'});
  await C.fuehreRuntimeWechselAus(dienste);
  const z1=(await pool.query('SELECT status,tatsaechlich FROM agent_runtime_auftraege WHERE id=$1',[r1.auftrag.auftrag_id])).rows[0];
  check(JSON.stringify(log)===JSON.stringify(['claude:stop','zuweisen:codex','codex:spawn:codex']),'Reihenfolge: stop alt -> Zuweisung -> spawn neu ('+log.join(',')+')');
  check(z1.status==='completed'&&z1.tatsaechlich.runtime==='codex'&&z1.tatsaechlich.modell==='codex','completed: tatsaechlich codex/codex');
  const i1=(await pool.query('SELECT modell_bestaetigt,startrezept FROM agent_identitaeten WHERE id=$1',[MAIN])).rows[0];
  check(i1.modell_bestaetigt==='codex'&&i1.startrezept.runtime==='codex','Identitaet: Modell + startrezept.runtime nachgezogen');
  const ausweis=(await pool.query('SELECT count(*)::int n FROM agent_identitaet_tokens WHERE identity_id=$1 AND widerrufen_am IS NULL',[MAIN])).rows[0].n;
  check(ausweis===1,'Ausweis unveraendert (ein wirksamer)');
  // zurueck nach Claude
  log.length=0;
  const r2=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'claude'},grund:'Test P22-T6 zurueck'});
  const dc2=fakeDaemon(C,'claude',async j=>{log.push('claude:'+j.action+':'+(j.args.model??''));if(j.action==='spawn'){await wrapper('running');return {status:'done',result:ergebnis({success:true})};}return {status:'failed',error:'x'};});
  await dc.stop();
  const dx2=fakeDaemon(C,'codex',async j=>{log.push('codex:'+j.action);if(j.action==='stop'){await wrapper('stopped');return {status:'done',result:ergebnis({success:true})};}return {status:'failed',error:'x'};});
  await dx.stop();
  await C.fuehreRuntimeWechselAus(dienste);
  const z2=(await pool.query('SELECT status,tatsaechlich,letzter_fehler FROM agent_runtime_auftraege WHERE id=$1',[r2.auftrag.auftrag_id])).rows[0];
  check(JSON.stringify(log)===JSON.stringify(['codex:stop','zuweisen:claude','claude:spawn:sonnet']),'zurueck: stop codex -> Zuweisung -> spawn claude mit Claude-Modell ('+log.join(',')+')');
  check(z2.status==='completed'&&z2.tatsaechlich?.runtime==='claude','zurueck: completed ('+z2.status+' '+(z2.letzter_fehler??'')+')');
  await dc2.stop();await dx2.stop();
 });

 await section('Failover-Wechsel (P22-T58)',async()=>{
  let zugewiesen=(await pool.query('SELECT runtime FROM agent_runtime_instances WHERE assigned_to_main')).rows[0].runtime;const log=[];
  const dienste={weiseMainZu:async r=>{log.push('zuweisen:'+r);zugewiesen=r;await pool.query('UPDATE agent_runtime_instances SET assigned_to_main=FALSE WHERE assigned_to_main');await pool.query('UPDATE agent_runtime_instances SET assigned_to_main=TRUE WHERE runtime=$1',[r]);},
   zugewiesen:async()=>zugewiesen,standardModell:async r=>r==='codex'?'codex':'sonnet',warte_ms:10_000};
  check(await err(()=>C.legeRuntimeAuftragAn(USER,{art:'neustart',gewuenscht:{failover:true},grund:'Test P22-T6 failover falsch'}))==='gewuenscht_ungueltig','failover nur bei runtime_wechsel');
  check(await err(()=>C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:'codex',failover:'ja'},grund:'Test P22-T6 failover typ'}))==='gewuenscht_ungueltig','failover nur als true');
  const MA={art:'identitaet',principal:{art:'identity',project:HP,agent_id:'hauptagent',identity_id:MAIN,rolle:'main',modell:null,context_epoch:1,lauf_id:null}};
  await pool.query("UPDATE agent_identitaeten SET startrezept=jsonb_set(startrezept,'{erlaubte_runtimes}','[\"claude\",\"codex\"]') WHERE id=$1",[MAIN]);
  check(await err(()=>C.legeRuntimeAuftragAn(MA,{art:'runtime_wechsel',gewuenscht:{runtime:'codex',failover:true},hands_off:{arbeitsstand:'x'},grund:'Test P22-T6 failover selbst'}))==='recht_fehlt','Main darf kein failover anlegen');
  await wrapper('running');
  const ziel=zugewiesen==='claude'?'codex':'claude';
  const altSieht=[];
  const alt=fakeDaemon(C,zugewiesen,async j=>{altSieht.push(j.action);return {status:'failed',error:'alter Container ist gestoppt'};});
  const neu=fakeDaemon(C,ziel,async j=>{log.push(ziel+':'+j.action);if(j.action==='spawn'){await wrapper('running');return {status:'done',result:ergebnis({success:true})};}return {status:'failed',error:'x'};});
  const f=await C.legeRuntimeAuftragAn(USER,{art:'runtime_wechsel',gewuenscht:{runtime:ziel,failover:true},grund:'Test P22-T6 failover'});
  check(f.auftrag.gewuenscht.failover==='ja','failover im Auftrag gespeichert');
  await C.fuehreRuntimeWechselAus(dienste);
  await alt.stop();await neu.stop();
  const z=(await pool.query('SELECT status,tatsaechlich,letzter_fehler FROM agent_runtime_auftraege WHERE id=$1',[f.auftrag.auftrag_id])).rows[0];
  check(altSieht.length===0,'Failover: kein Job an die alte (gestoppte) Runtime');
  check(JSON.stringify(log)===JSON.stringify(['zuweisen:'+ziel,ziel+':spawn']),'Failover: Zuweisung -> Spawn auf der neuen Runtime ('+log.join(',')+')');
  check(z.status==='completed'&&z.tatsaechlich?.runtime===ziel,'Failover: completed ('+z.status+' '+(z.letzter_fehler??'')+')');
 });

 await section('Nachrichten-Zustellung ueber den Daemon',async()=>{
  const T=await load('packages/file-watcher-daemon-ts/dist/zustell-text.js');
  const rt=(await pool.query('SELECT runtime FROM agent_runtime_instances WHERE assigned_to_main')).rows[0].runtime;
  const opt={aktiv:true,channel_modus:'alle',turn_warte_ms:10_000};
  await wrapper('running');
  await pool.query('UPDATE agent_identitaet_wrapper_status SET heartbeat_enabled=false WHERE identity_id=$1',[MAIN]);
  // Altbestand vor dem ersten Lauf wird nicht zugestellt (Wasserstand = hoechste ID).
  await pool.query("INSERT INTO specialist_inbox(project,from_agent,to_agent,content,to_identity_id) VALUES($1,'alt','hauptagent','ALTBESTAND',$2)",[HP,MAIN]);
  const leer=await C.fuehreZustellungAus({identity_id:MAIN,runtime:rt,optionen:opt});
  check(leer.gesammelt===0,'erster Lauf: Wasserstand gesetzt, keine Historie');
  const ch=(await pool.query("INSERT INTO specialist_channels(name,project,created_by) VALUES('kanal-t6',$1,'koord') RETURNING id",[HP])).rows[0].id;
  await pool.query("INSERT INTO agent_identitaet_channel_mitglieder(channel_id,agent_name,identity_id) VALUES($1,'hauptagent',$2)",[ch,MAIN]);
  await C.fuehreZustellungAus({identity_id:MAIN,runtime:rt,optionen:opt});
  const inb=(await pool.query("INSERT INTO specialist_inbox(project,from_agent,to_agent,content,to_identity_id) VALUES($1,'koord','hauptagent','INBOX-TEXT',$2) RETURNING id",[HP,MAIN])).rows[0].id;
  const dm=(await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content,timestamp,recipient_identity_id) VALUES($1,'koord','hauptagent','DM-TEXT',NOW(),$2) RETURNING id",[HP,MAIN])).rows[0].id;
  const ev=(await pool.query("INSERT INTO agent_events(project,event_type,priority,scope,source_id,payload,target_identity_id) VALUES($1,'pruefen','high',$2,'koord','EVENT-TEXT',$3) RETURNING id",[HP,'identity:'+MAIN,MAIN])).rows[0].id;
  const cm=(await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES($1,'koord','CHANNEL-TEXT') RETURNING id",[ch])).rows[0].id;
  await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content,sender_identity_id) VALUES($1,'hauptagent','EIGENE',$2)",[ch,MAIN]);
  const erhalten=[];let busy=1;
  const d=fakeDaemon(C,rt,async j=>{
   if(j.action!=='zustellen')return {status:'failed',error:'x'};
   if(busy-->0)return {status:'done',result:ergebnis({success:true,zugestellt:false,grund:'beschaeftigt'})};
   erhalten.push({z:j.args.zustellung,text:T.baueZustellText(j.args.zustellung)});
   return {status:'done',result:ergebnis({success:true,zugestellt:true})};});
  const inboxVorher=(await pool.query('SELECT count(*)::int n FROM specialist_inbox')).rows[0].n;
  for(let i=0;i<6&&erhalten.length<4;i++){
   await C.fuehreZustellungAus({identity_id:MAIN,runtime:rt,optionen:opt});
   await pool.query("UPDATE agent_zustellungen SET naechster_versuch=NOW() WHERE status='pending'");
  }
  await d.stop();
  const wege=erhalten.map(e=>e.z.weg+':'+e.z.message_id).sort();
  check(JSON.stringify(wege)===JSON.stringify(['channel:'+cm,'chat:'+dm,'event:'+ev,'inbox:'+inb].sort()),'je Weg genau eine Zustellung, eigene Channel-Nachricht nicht ('+wege.join(',')+')');
  const zc=erhalten.find(e=>e.z.weg==='channel')?.z,ze=erhalten.find(e=>e.z.weg==='event')?.z;
  check(zc?.channel==='kanal-t6'&&zc.absender.agent_id==='koord'&&zc.empfaenger.identity_id===MAIN&&zc.inhalt==='CHANNEL-TEXT','Felder Channel: Name, Absender, Empfaenger, Inhalt');
  check(ze?.event_typ==='pruefen'&&ze.prioritaet==='high'&&ze.inhalt==='EVENT-TEXT','Felder Event: Typ, Prioritaet, Inhalt');
  const tx=erhalten.find(e=>e.z.weg==='channel')?.text??'';
  check(tx.startsWith('[Synapse-Nachricht]')&&tx.includes('Weg: Channel #kanal-t6')&&tx.includes('Von: koord')&&tx.includes('ID: channel:'+cm)&&tx.includes('CHANNEL-TEXT'),'Turn-Text im Daemon: Kopf + Inhalt');
  check(tx.includes('channel(action:"feed", channel_name:"kanal-t6", before_id:'+cm+', limit:5)')&&!tx.includes('EIGENE'),'Channel kompakt: nur die neue Nachricht + Hinweis auf aeltere (before_id, limit 5)');
  const vorher=await C.getChannelMessages(HP,'kanal-t6',{beforeId:cm+2,limit:5});
  check(vorher.length>=1&&vorher.every(m=>m.id<cm+2),'channel feed blaettert rueckwaerts (before_id, limit)');
  check(!(erhalten.find(e=>e.z.weg==='inbox')?.text??'').includes('before_id'),'Hinweis nur bei Channel');
  const led=(await pool.query('SELECT weg,status,versuche FROM agent_zustellungen WHERE identity_id=$1',[MAIN])).rows;
  check(led.length===4&&led.every(r=>r.status==='zugestellt'),'Ledger: alle zugestellt');
  check(led.some(r=>r.versuche===1),'beschaeftigt -> spaeter erneut zugestellt');
  check((await pool.query('SELECT count(*)::int n FROM specialist_inbox')).rows[0].n===inboxVorher,'kein Inbox-Rueckfall (keine Schleife)');
  check((await pool.query('SELECT processed FROM specialist_inbox WHERE id=$1',[inb])).rows[0].processed===true,'Inbox nach Zustellung quittiert');
  check((await pool.query('SELECT 1 FROM agent_identitaet_event_acks WHERE event_id=$1 AND identity_id=$2',[ev,MAIN])).rowCount===1,'Event nach Zustellung quittiert (ACK der Identitaet)');
  check((await pool.query("SELECT processed FROM specialist_inbox WHERE content='ALTBESTAND'")).rows[0].processed===false,'Altbestand nicht angefasst');
  check(await C.sammleZustellungen(MAIN,opt)===0,'Idempotenz: erneutes Sammeln nimmt nichts doppelt auf');
  // Modus erwaehnung: nur @hauptagent, Wasserstand rueckt trotzdem ueber beide
  await pool.query("INSERT INTO specialist_channel_messages(channel_id,sender,content) VALUES($1,'koord','ohne Erwaehnung'),($1,'koord','hallo @hauptagent')",[ch]);
  check(await C.sammleZustellungen(MAIN,{...opt,channel_modus:'erwaehnung'})===1,'Modus erwaehnung: nur die Nachricht mit @hauptagent');
  check(await C.sammleZustellungen(MAIN,{...opt,channel_modus:'alle'})===0,'Wasserstand ist ueber die nicht erwaehnende Nachricht vorgerueckt');
  // Wrapper laeuft nicht: sammeln ja, zustellen nein
  await wrapper(null);
  await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content,timestamp,recipient_identity_id) VALUES($1,'koord','hauptagent','SPAETER',NOW(),$2)",[HP,MAIN]);
  const ohne=await C.fuehreZustellungAus({identity_id:MAIN,runtime:rt,optionen:opt});
  check(ohne.gesammelt===1&&ohne.zugestellt===0,'Wrapper laeuft nicht: gesammelt, bleibt pending');
  check((await C.fuehreZustellungAus({identity_id:MAIN,runtime:rt,optionen:{...opt,aktiv:false}})).gesammelt===0,'Zustellung aus -> nichts');
  check(C.leseZustellOptionen({SYNAPSE_HAUPTAGENT_ZUSTELLUNG:'aus',SYNAPSE_HAUPTAGENT_ZUSTELL_CHANNELS:'erwaehnung'}).aktiv===false&&C.leseZustellOptionen({SYNAPSE_HAUPTAGENT_ZUSTELL_CHANNELS:'erwaehnung'}).channel_modus==='erwaehnung','Einstellungen per Env');
  const wsrc=await readFile(join(repo,'packages/agents/dist/wrapper.js'),'utf8'),psrc=await readFile(join(repo,'packages/agents/dist/process.js'),'utf8');
  check(wsrc.includes('SYNAPSE_ZUSTELLUNG_DAEMON')&&psrc.includes('disableAllHooks')&&psrc.includes('SYNAPSE_KEINE_HOOKS'),'Wrapper ueberspringt Daemon-Zustellungen, Hooks im Container aus (Quelltext)');
 });

 await section('Heartbeat beim Spawn',async()=>{
  await wrapper('running');
  await C.heartbeatBeimSpawnFuerZiel(HP,{art:'identity',project:HP,agent_id:'hauptagent',identity_id:MAIN});
  check((await pool.query('SELECT heartbeat_enabled FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[MAIN])).rows[0].heartbeat_enabled===false,'Main ohne Einstellung -> Heartbeat AUS');
  await pool.query("UPDATE agent_identitaeten SET startrezept=jsonb_set(startrezept,'{heartbeat}','{\"aktiv\":true,\"intervall_ms\":60000}') WHERE id=$1",[MAIN]);
  await C.heartbeatBeimSpawnFuerZiel(HP,{art:'identity',project:HP,agent_id:'hauptagent',identity_id:MAIN});
  const h=(await pool.query('SELECT heartbeat_enabled,heartbeat_interval_ms FROM agent_identitaet_wrapper_status WHERE identity_id=$1',[MAIN])).rows[0];
  check(h.heartbeat_enabled===true&&Number(h.heartbeat_interval_ms)===60000,'Main mit Einstellung -> an, Takt aus Startrezept');
 });

 await section('Wiederanbindung nach Daemon-Neustart (Fake-Wrapper)',async()=>{
  const A=await load('packages/agents/dist/index.js');
  const D=await load('packages/file-watcher-daemon-ts/dist/runtime-agentensteuerung.js');
  const id=randomUUID(),tot=randomUUID();
  const sock=join(tmp,'w-'+id.slice(0,8)+'.sock');
  const server=createServer(s=>{createInterface({input:s}).on('line',l=>{const m=JSON.parse(l);
   s.write(JSON.stringify({jsonrpc:'2.0',result:{content:'pong:'+m.params?.message,inputTokens:1,outputTokens:2},id:m.id})+'\n');});});
  await new Promise(r=>server.listen(sock,r));
  for(const [k,pid] of [[id,process.pid],[tot,2147480000]]){
   await mkdir(join(tmp,'.synapse','agent-runs',k),{recursive:true});
   await writeFile(join(tmp,'.synapse','agent-runs',k,'status.json'),JSON.stringify({maxSpecialists:7,lastUpdate:new Date().toISOString(),
    specialists:{['identity:'+k]:{name:'hauptagent',wrapperPid:pid,socket:k===id?sock:join(tmp,'weg.sock'),status:'running'}}}));
  }
  const vorher=await A.mitAgentLaufUmgebung('hauptagent',HP,{SYNAPSE_AGENT_IDENTITY_ID:id},()=>A.heartbeatController.isConnected('hauptagent'));
  check(vorher===false,'vor der Wiederanbindung nicht verbunden (Daemon neu)');
  await D.bindeWrapperAn([]);
  const r=await A.mitAgentLaufUmgebung('hauptagent',HP,{SYNAPSE_AGENT_IDENTITY_ID:id},async()=>({
   verbunden:A.heartbeatController.isConnected('hauptagent'),antwort:await A.heartbeatController.sendWake('hauptagent','ping')}));
  check(r.verbunden===true&&r.antwort.content==='pong:ping','nach bindeWrapperAn: verbunden, wake erreicht den laufenden Wrapper');
  const totStatus=JSON.parse(await readFile(join(tmp,'.synapse','agent-runs',tot,'status.json'),'utf8'));
  check(Object.keys(totStatus.specialists).length===0,'toter Wrapper aus status.json aufgeraeumt');
  await A.mitAgentLaufUmgebung('hauptagent',HP,{SYNAPSE_AGENT_IDENTITY_ID:id},()=>A.heartbeatController.disconnectFromWrapper('hauptagent'));
  await new Promise(r=>server.close(r));
 });

 await section('Codex-Runtime im Wrapper-Modus (Fake-CLI)',async()=>{
  const R=await load('packages/agents/dist/codex-runtime.js');
  const m=R.bildeMcpAufCodexAb({mcpServers:{synapse:{type:'http',url:'http://synapse-api:3456/',headers:{Authorization:'Bearer GEHEIM123','x-synapse-agent-token':'${SYNAPSE_AGENT_TOKEN}','X-Synapse-Werkzeugprofil':'main-synapse'}}}});
  check(!m.overrides.join(' ').includes('GEHEIM123')&&m.env.SYNAPSE_CODEX_MCP_BEARER_SYNAPSE==='GEHEIM123','Bearer nur als Env, nie in Overrides');
  check(m.overrides.includes('mcp_servers.synapse.env_http_headers={"x-synapse-agent-token"="SYNAPSE_AGENT_TOKEN"}'),'Ausweis-Header als env_http_headers');
  check(m.overrides.includes('mcp_servers.synapse.http_headers={"X-Synapse-Werkzeugprofil"="main-synapse"}'),'Literal-Header als http_headers');
  const a1=R.baueCodexArgs({threadId:null,cwd:'/projects/x',modell:null,deaktiviert:['shell_tool'],mcpOverrides:['a=1']});
  const a2=R.baueCodexArgs({threadId:'th-1',cwd:'/projects/x',modell:'gpt-x',deaktiviert:[],mcpOverrides:[]});
  check(a1.at(-1)==='-'&&!a1.includes('resume')&&a1.includes('--ignore-user-config')&&a1.join(' ').includes('--sandbox read-only')&&a1.join(' ').includes('--disable shell_tool'),'Args erster Turn');
  check(a2.slice(-3).join(' ')==='resume th-1 -'&&a2.join(' ').includes('-m gpt-x'),'Args Folgeturn: resume derselben Thread-ID');
  check(R.leseCodexZeile('{"type":"thread.started","thread_id":"t9"}').threadId==='t9'&&R.leseCodexZeile('{"type":"turn.failed","error":{"message":"x"}}').fehler==='x','Zeilen-Parser');
  // Fake-codex-CLI
  const bin=join(tmp,'bin');await mkdir(bin,{recursive:true});
  const flog=join(tmp,'codex-args.log'),fin=join(tmp,'codex-stdin.log');
  await writeFile(join(bin,'codex'),'#!/bin/sh\necho "$*" >> "'+flog+'"\ncat >> "'+fin+'"\necho "----" >> "'+fin+'"\ncase "$*" in *resume*) ;; *) echo \'{"type":"thread.started","thread_id":"th-123"}\';; esac\necho \'{"type":"item.completed","item":{"type":"agent_message","text":"antwort"}}\'\necho \'{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":7,"cached_input_tokens":40}}\'\n');
  await chmod(join(bin,'codex'),0o755);
  const prompt=join(tmp,'prompt.txt');await writeFile(prompt,'SYSTEMPROMPT-HAUPTAGENT');
  const mcpFile=join(tmp,'mcp.json');await writeFile(mcpFile,JSON.stringify({mcpServers:{synapse:{type:'http',url:'http://synapse-api:3456/',headers:{Authorization:'Bearer GEHEIM123','x-synapse-agent-token':'${SYNAPSE_AGENT_TOKEN}'}}}}));
  const proc=spawn(process.execPath,[join(repo,'packages/agents/dist/codex-runtime.js')],{env:{...process.env,PATH:bin+':'+process.env.PATH,SYNAPSE_WRAPPER_MODE:'1',
   SYNAPSE_AGENT_NAME:'hauptagent',SYNAPSE_AGENT_MODEL:'codex',SYNAPSE_PROJECT_PATH:join(tmp,'proj'),SYNAPSE_SESSION_ID:'sess-1',
   SYNAPSE_SYSTEM_PROMPT_FILE:prompt,SYNAPSE_MCP_CONFIG_FILE:mcpFile,SYNAPSE_AGENT_TOKEN:'sai_testausweis1',DATABASE_URL:''},stdio:['pipe','pipe','pipe']});
  const events=[];const rl=createInterface({input:proc.stdout});
  const fertig=new Promise(res=>rl.on('line',l=>{const e=JSON.parse(l);events.push(e);if(events.filter(x=>x.type==='result').length===2)res();}));
  const msg=t=>JSON.stringify({type:'user',message:{role:'user',content:[{type:'text',text:t}]}})+'\n';
  proc.stdin.write(msg('Erste Frage'));proc.stdin.write(msg('Zweite Frage'));
  await Promise.race([fertig,pause(15_000)]);proc.stdin.end();proc.kill();
  const results=events.filter(e=>e.type==='result');
  check(events[0]?.type==='system'&&events[0].subtype==='init','init-Event');
  check(results.length===2&&results.every(r=>r.result==='antwort'&&r.usage.input_tokens===100&&r.is_error===false),'zwei Turns -> zwei result-Events mit usage');
  const zeilen=(await readFile(flog,'utf8')).trim().split('\n');
  check(zeilen.length===2&&!zeilen[0].includes('resume')&&/resume th-123 -$/.test(zeilen[1]),'zweiter Turn resume derselben Thread-ID');
  check(zeilen.every(z=>z.includes('--disable shell_tool')&&z.includes('--ignore-user-config')),'Werkzeugprofil: shell_tool aus, keine User-Config');
  check(!zeilen.join(' ').includes('GEHEIM123')&&!zeilen.join(' ').includes('sai_'),'keine Geheimnisse (Bearer/Ausweis) in argv');
  const stdin=(await readFile(fin,'utf8')).split('----');
  check(stdin[0].includes('SYSTEMPROMPT-HAUPTAGENT')&&stdin[0].includes('Erste Frage')&&!stdin[1].includes('SYSTEMPROMPT'),'System-Prompt nur vor der ersten Nachricht des Threads');
  const jsonlDir=join(tmp,'.claude','projects');const jd=(await readdir(jsonlDir))[0];
  const jl=(await readFile(join(jsonlDir,jd,'sess-1.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));
  const A=await load('packages/agents/dist/index.js');
  const v=A.verbrauchAusZeilen?A.verbrauchAusZeilen(jl.map(x=>JSON.stringify(x))):null;
  check(jl.length===2&&jl[0].message.id==='sess-1:1'&&jl[1].message.id==='sess-1:2','JSONL je Turn mit message.id (Verbrauchsbuchung)');
  check(!v||v.length===2,'verbrauchAusZeilen erkennt beide Turns');
 });

 check(network===0,'keine echten Netzwerk-/Modellaufrufe');
}finally{
 await core?.closePool?.().catch?.(()=>undefined);
 await pool?.end?.().catch(()=>undefined);
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE').catch(()=>undefined);
 await admin.end().catch(()=>undefined);
 await rm(tmp,{recursive:true,force:true}).catch(()=>undefined);
}
console.log(`ERGEBNIS P22-T6: ${checks-failures.length}/${checks} gruen${failures.length?' – FEHLER: '+failures.map(mask).join(' | '):''}`);
process.exit(failures.length?1:0);
