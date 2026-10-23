/** F2/F3: real scheduler -> fake container -> real E importer, only private synapse_test schema/temp. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs/promises';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_REVERSE_CONTAINER_PROFIL:'f2-f3-fixture',SYNAPSE_REVERSE_WERKZEUG_VERSION:'f2-f3-v1',
 SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":512,"vram":0,"gpu":false}',SYNAPSE_REVERSE_RETRY_MAX:'2'});
const {Pool}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const core=await import('../../core/dist/index.js');
const {mitLesePool}=await import('../../core/dist/db/client.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../../core/dist/db/work-jobs-schema.js');
const {TOOL_CONTAINER_SCHEMA_SQL}=await import('../../core/dist/db/tool-container-schema.js');
const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../../core/dist/db/tool-aktivitaet-schema.js');
const {REVERSE_SCHEMA_SQL}=await import('../../core/dist/db/reverse-schema.js');
const {REVERSE_PIPELINE_SCHEMA_SQL}=await import('../../core/dist/db/reverse-pipeline-schema.js');
const {ASSET_UPLOAD_SCHEMA_SQL}=await import('../../core/dist/db/asset-upload-schema.js');
const {ToolLifecycle}=await import('../dist/services/tool-lifecycle.js');
const sha=v=>createHash('sha256').update(v).digest('hex');
const raw=new Pool({connectionString:url.href,max:8}),schema='rea4_f2f3_'+randomUUID().replaceAll('-','');
const db={async connect(){const c=await raw.connect();await c.query('SET search_path TO "'+schema+'",public');return c;},
 async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}}};
const inDb=fn=>mitLesePool(db,fn),tx=async fn=>{const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const root=await mkdtemp(join(tmpdir(),'rea4-f2-f3-'));
// Fake container has no uid65532. Mock only its ownership boundary, never weaken the real executor guard.
const originalChown=fs.chown;let ownershipCalls=0;
fs.chown=async(p,uid,gid)=>{assert(String(p).startsWith(root+'/'),'ownership mock only touches our temp fixtures');eqOwnership(uid,gid);ownershipCalls++;};
function eqOwnership(uid,gid){assert.equal(uid,0);assert.equal(gid,65532);}
syncBuiltinESMExports();
const ex=await import('../dist/services/reverse-executor.js');
let pipeline,executor,lc,unhook,made=false,checks=0;
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
try{
 await raw.query('CREATE SCHEMA "'+schema+'"');made=true;
 for(const table of ['asset_upload_sitzungen','asset_files','agent_profil_schalter'])await db.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
 await db.query('CREATE TABLE projects(name text,enabled boolean)');
 await db.query("CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text NOT NULL,service_token_hash text NOT NULL,status text NOT NULL DEFAULT 'ready',gesperrt_vom_user boolean NOT NULL DEFAULT false,letzter_kontakt timestamptz NOT NULL DEFAULT now(),node_kind text DEFAULT 'cpu')");
 for(const sql of [WORK_JOBS_SCHEMA_SQL,ASSET_UPLOAD_SCHEMA_SQL,REVERSE_SCHEMA_SQL,REVERSE_PIPELINE_SCHEMA_SQL,TOOL_AKTIVITAET_SCHEMA_SQL,TOOL_CONTAINER_SCHEMA_SQL])await db.query(sql);
 await db.query((await import('../../core/dist/db/reverse-analyse-policy-schema.js')).REVERSE_ANALYSE_POLICY_SCHEMA_SQL);await db.query('ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS uebernahme JSONB');
 for(const [table,column]of [['reverse_eintraege','creator_identity_id'],['reverse_auftraege','trigger_identity_id'],['tool_activation','updater_identity_id']])await db.query('ALTER TABLE '+table+' ADD COLUMN IF NOT EXISTS '+column+' TEXT');
 const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
 const konfig=ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse:fixture@sha256:'+'b'.repeat(64),
  SYNAPSE_REVERSE_RESOURCE_NEED:process.env.SYNAPSE_REVERSE_RESOURCE_NEED,SYNAPSE_REVERSE_EXECUTOR_LEASE_SECONDS:'30'},root);
 const wer={nodeId:'rea4-fixture',bootGeneration:randomUUID(),authHash:'fixture-only'};
 await db.query('INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)',[wer.nodeId,wer.bootGeneration,wer.authHash]);
 const calls=[],mounts=new Map(),resolve=ex.reverseMountResolver(konfig);
 lc=new ToolLifecycle({pool:db,maxContainers:4,resources:ex.reverseRessourcen,executor:{
  async start(d,ctx){const id='fake-'+ctx.generation;mounts.set(id,(await resolve(d,ctx)).find(m=>m.role==='arbeit').source);return {id,coldstart_ms:1};},
  async observe(id){return {container_id:id,running:true,start_observed:true,cpu_percent:0,gpu_percent:null,measured_at:new Date().toISOString()};},
  async stop(){},async cleanup(){},
  async command(id,req,_t,_m,onTerminal){
   calls.push(req);const names=['base.txt',...(req.optionen.pe_ressourcen?['pe.txt']:[]),...(req.optionen.siedler3?['gfx.txt']:[])],manifest=[];
   for(const name of names){await writeFile(join(mounts.get(id),req.auftrag_id,name),name);manifest.push({pfad:name,groesse:Buffer.byteLength(name),sha256:sha(name)});}
   onTerminal?.();return {status:'fertig',manifest};
  },
 }});
 executor=new ex.ReverseExecutor({pool:db,konfig,lifecycle:()=>lc,identitaet:async()=>wer,uebernahmeOptionen:{konfiguration:cfg},registriereProjekt:async n=>{await db.query('INSERT INTO projects SELECT $1,true WHERE NOT EXISTS(SELECT 1 FROM projects WHERE name=$1)',[n]);}});
 unhook=ex.registriereWorkJobHooks(ex.REVERSE_CAPABILITY,executor.hooks());
 pipeline=new core.ReversePipelineDienst({pool:db,konfiguration:cfg,ausfuehrbareKinds:['reverse-E']});
 const medium=async suffix=>{
  const rid='rev-f2-f3-'+suffix;
  await db.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Fixture','bestaetigt','{\"automatisch\":true,\"bis_schicht\":\"E\"}')",[rid]);
  const mid=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,art,bezeichnung,status,satz_sha256) VALUES($1,0,'iso','CD1','vollstaendig',$2) RETURNING id::text",[rid,sha('same-medium')])).rows[0].id;
  const key=rid+'/original/disc/disc.iso';await mkdir(dirname(join(root,key)),{recursive:true});await writeFile(join(root,key),'iso!');
  await db.query("INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES($1,'haupt','disc.iso',$2,4,$3)",[mid,sha('iso!'),key]);
  return {rid,mid};
 };
 const a=await medium('a');
 const request=m=>inDb(()=>tx(c=>pipeline.analysieren({reverseId:m.rid,mediumId:m.mid,dateiId:null,project:'fixture-project',agentId:'fixture',bisSchicht:'E',prioritaet:'interaktiv'},c)));
 const repeat=m=>inDb(()=>tx(c=>pipeline.queue(c,{reverseId:m.rid,mediumId:m.mid,dateiId:null,project:'fixture-project',agentId:'reverse-pipeline',bisSchicht:'E',prioritaet:'hintergrund'})));
 const row=async r=>(await db.query('SELECT id::text,status,p20_auftrag_id::text,fingerabdruck,profil_version FROM reverse_auftraege WHERE id=$1',[r.auftrag_id])).rows[0];
 const drain=async()=>inDb(async()=>{await executor.durchlauf();await executor.leerlauf();});
 const flag=async(name,value)=>db.query("INSERT INTO agent_profil_schalter(ebene,funktion,aktiv,grund,gesetzt_von) VALUES('global',$1,$2,'F2 fixture','fixture') ON CONFLICT(ebene,(COALESCE(project,'')),funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv",[name,value]);
 // P18-T97 A-R1: gültige Katalogwerte 1/2; spätere Belegfehler müssen den kompletten Fach-TX zurückrollen.
 const {pruefeReverseFachbindung:checkBinding}=await import('../../core/dist/services/reverse-pipeline-halt.js');
 const counts=async()=>JSON.stringify((await db.query(`SELECT
  (SELECT count(*) FROM work_jobs)::text AS jobs,(SELECT count(*) FROM reverse_auftraege)::text AS fach,
  (SELECT count(*) FROM reverse_schichten)::text AS schichten,
  (SELECT coalesce(jsonb_agg(jsonb_build_array(fingerabdruck,p20_auftrag_id,quell_auftrag_id,versuche) ORDER BY fingerabdruck),'[]') FROM reverse_analyse_cache) AS cache`)).rows[0]);
 const admissionRequest=async(m,budget,failAt)=>{
  return inDb(()=>tx(async c=>{
   const proxy={query:async(q,values)=>{
    const text=typeof q==='string'?q:q.text,result=await c.query(q,values);
    if(text.includes('SELECT ebene,project,eintrag_id,name,')&&text.includes('FROM reverse_einstellungen')){
     result.rows=result.rows.filter(z=>!['e_uebernahme_block_zeilen',...(failAt==='budget'?['materialisierung_tx_bytes']:[])].includes(z.name));
     result.rows.push({ebene:'global',project:null,eintrag_id:null,name:'e_uebernahme_block_zeilen',wert:String(budget)});
     if(failAt==='budget')result.rows.push({ebene:'global',project:null,eintrag_id:null,name:'materialisierung_tx_bytes',
      wert:String(core.REVERSE_EINSTELLKATALOG.materialisierung_tx_bytes.min??core.REVERSE_EINSTELLKATALOG.materialisierung_tx_bytes.standard)});
    }
    if(text.includes('SELECT r.*,w.kind')&&text.includes('JOIN work_jobs')){
     if(failAt==='bindung')return {...result,rows:[]};
     if(failAt==='budget'&&result.rows[0]){
      const min=Number(core.REVERSE_EINSTELLKATALOG.materialisierung_tx_bytes.min??core.REVERSE_EINSTELLKATALOG.materialisierung_tx_bytes.standard);
      result.rows[0]={...result.rows[0],uebernahme:{...(result.rows[0].uebernahme??{}),rohbeleg:'x'.repeat(min+1)}};
     }
    }
    return result;
   }};
   return pipeline.analysieren({reverseId:m.rid,mediumId:m.mid,dateiId:null,project:'fixture-project',agentId:'fixture',bisSchicht:'E',prioritaet:'interaktiv'},proxy);
  }));
 };
 for(const budget of [1,2]){
  for(const failAt of ['bindung','budget']){
   const m=await medium('rollback-'+budget+'-'+failAt),before=await counts();
   await assert.rejects(()=>admissionRequest(m,budget,failAt),new RegExp(failAt==='budget'?'reverse_admission_budget':'reverse_fachbindung_ungueltig'));
   eq(await counts(),before,'später '+failAt+'-Fehler hinterlässt keinen Job/Link/Cachepointer');
   await db.query("UPDATE reverse_eintraege SET status='archiviert' WHERE id=$1",[m.rid]);
  }
  const m=await medium('budget-'+budget),r=await admissionRequest(m,budget),f=await row(r);
  const j=await core.createWorkJobService({pool:db}).get(f.p20_auftrag_id,'reverse-bibliothek');
  eq(await checkBinding(db,j),null,'Budget '+budget+' ist gültig; kein eigener Mindestwert3');
  await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=$1",[j.id]);
  await db.query("UPDATE reverse_auftraege SET status='abgebrochen' WHERE id=$1",[f.id]);
 }
 for(const terminal of ['failed','expired','cancelled']){
  const m=await medium('retry-'+terminal),r=await request(m),old=await row(r);
  await db.query("UPDATE reverse_auftraege SET uebernahme=uebernahme||$2::jsonb WHERE id=$1",[old.id,JSON.stringify({retention:true,rohbeleg:'behalten'})]);
  const original=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1',[old.id])).rows[0].uebernahme;
  await db.query('UPDATE work_jobs SET state=$2 WHERE id=$1',[old.p20_auftrag_id,terminal]);
  const next=await inDb(()=>tx(c=>pipeline.queue(c,{reverseId:m.rid,mediumId:m.mid,dateiId:null,project:'fixture-project',agentId:'reverse-pipeline',bisSchicht:'E',prioritaet:'hintergrund'})));
  const fresh=await row(next);
  assert.notEqual(fresh.id,old.id,'Retry besitzt neue Fachgeneration');assert.notEqual(fresh.p20_auftrag_id,old.p20_auftrag_id);
  eq((await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1',[old.id])).rows[0].uebernahme,original,'alter Beleg und Rückhalt unverändert');
  const job=await core.createWorkJobService({pool:db}).get(fresh.p20_auftrag_id,'reverse-bibliothek');
  eq(await checkBinding(db,job),null,'neuer atomarer Job/Fach/Beleg-Kontext');
  await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=$1",[job.id]);
  await db.query("UPDATE reverse_auftraege SET status='abgebrochen' WHERE id=$1",[fresh.id]);
 }
 // P18-T97 A-R3: endgültiger Fachfehler darf bei gleichem Fingerabdruck nicht neu anlaufen.
 for(const fachFehler of [true,false]){
  const m=await medium('endgueltig-'+fachFehler),initial=await request(m),f=await row(initial);
  await db.query("UPDATE work_jobs SET state='failed',error_code='format_nicht_unterstuetzt' WHERE id=$1",[f.p20_auftrag_id]);
  await db.query("UPDATE reverse_auftraege SET status=$2,fehlercode=CASE WHEN $2='fehler' THEN 'format_nicht_unterstuetzt' ELSE NULL END WHERE id=$1",[f.id,fachFehler?'fehler':'wartet']);
  const before=(await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n;
  const result=await inDb(()=>tx(c=>pipeline.queue(c,{reverseId:m.rid,mediumId:m.mid,dateiId:null,project:'fixture-project',agentId:'reverse-pipeline',bisSchicht:'E',prioritaet:'hintergrund'})));
  eq(result.fehlercode,'format_nicht_unterstuetzt','T64/T66-Code bleibt erhalten');
  eq((await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n,before,'endgültig: kein neuer Job');
  eq((await row({auftrag_id:f.id})).p20_auftrag_id,f.p20_auftrag_id,'endgültig: kein neuer Link');
  eq((await db.query("SELECT count(*)::int n FROM reverse_auftraege WHERE eintrag_id=$1",[m.rid])).rows[0].n,1,'endgültig: keine neue Fachgeneration');
  // Expliziter manueller Neuversuch bleibt erlaubt.
  const manual=await request(m),manualRow=await row(manual);
  assert.notEqual(manualRow.id,f.id);assert.notEqual(manualRow.p20_auftrag_id,f.p20_auftrag_id);
  eq(await checkBinding(db,await core.createWorkJobService({pool:db}).get(manualRow.p20_auftrag_id,'reverse-bibliothek')),null);
  await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=$1",[manualRow.p20_auftrag_id]);
  await db.query("UPDATE reverse_auftraege SET status='abgebrochen' WHERE id=$1",[manualRow.id]);
 }
 const transientMedium=await medium('transient'),tr=await request(transientMedium),oldTransient=await row(tr);
 await db.query("UPDATE work_jobs SET state='failed',error_code='werkzeug_fehler' WHERE id=$1",[oldTransient.p20_auftrag_id]);
 const retry=await inDb(()=>tx(c=>pipeline.queue(c,{reverseId:transientMedium.rid,mediumId:transientMedium.mid,dateiId:null,project:'fixture-project',agentId:'reverse-pipeline',bisSchicht:'E',prioritaet:'hintergrund'})));
 const retryRow=await row(retry);assert.notEqual(retryRow.id,oldTransient.id);
 eq(await checkBinding(db,await core.createWorkJobService({pool:db}).get(retryRow.p20_auftrag_id,'reverse-bibliothek')),null,'transient: neuer konsistenter Kontext');
 await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=$1",[retryRow.p20_auftrag_id]);
 await db.query("UPDATE reverse_auftraege SET status='abgebrochen' WHERE id=$1",[retryRow.id]);
 // R4-Gegenprobe: echte Fehler zählen weiter bis retryMax; kein Erfolgsreset bei failed.
 const failedMedium=await medium('r4-fehlerbudget');let failedResult=await request(failedMedium),failedRow=await row(failedResult);
 const retryMax=Number(pipeline.retry);
 for(let versuch=1;versuch<=retryMax;versuch++){
  await db.query("UPDATE work_jobs SET state='failed',error_code='werkzeug_fehler' WHERE id=$1",[failedRow.p20_auftrag_id]);
  const n=(await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n;
  const result=await repeat(failedMedium);
  if(versuch<retryMax){failedRow=await row(result);eq((await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n,n+1,'erster echter Fehler erlaubt genau einen Retry');}
  else{eq((await row(result)).status,'fehler','retryMax erreicht');eq((await db.query('SELECT fehlercode FROM reverse_auftraege WHERE id=$1',[result.auftrag_id])).rows[0].fehlercode,'werkzeug_fehler');eq((await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n,n,'nach zwei echten Fehlern kein dritter Job');}
 }
 eq((await db.query('SELECT versuche FROM reverse_analyse_cache WHERE fingerabdruck=$1',[failedRow.fingerabdruck])).rows[0].versuche,retryMax,'Fehlversuchsbudget bleibt erhalten');
 await db.query("UPDATE reverse_eintraege SET status='archiviert' WHERE id=$1",[failedMedium.rid]);
 // R4-Nachtrag: completed allein ist kein fachlicher Erfolg (T93-Altbestand).
 const partialMedium=await medium('r4-completed-teilweise'),partialStart=await request(partialMedium),partialRow=await row(partialStart);
 const partialCount=Number((await db.query('SELECT versuche FROM reverse_analyse_cache WHERE fingerabdruck=$1',[partialRow.fingerabdruck])).rows[0].versuche);
 await db.query("UPDATE work_jobs SET state='completed',output_ref=input_ref WHERE id=$1",[partialRow.p20_auftrag_id]);
 await db.query("UPDATE reverse_auftraege SET status='teilweise',fehlercode='werkzeug_fehler' WHERE id=$1",[partialRow.id]);
 eq(await checkBinding(db,await core.createWorkJobService({pool:db}).get(partialRow.p20_auftrag_id,'reverse-bibliothek')),null,'Altbestand hat gültige Admission');
 const partialNext=await request(partialMedium),partialNew=await row(partialNext);
 eq(Number((await db.query('SELECT versuche FROM reverse_analyse_cache WHERE fingerabdruck=$1',[partialRow.fingerabdruck])).rows[0].versuche),partialCount+1,'completed+teilweise setzt Fehlerbudget NICHT zurück');
 await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=$1",[partialNew.p20_auftrag_id]);
 await db.query("UPDATE reverse_auftraege SET status='abgebrochen' WHERE id=$1",[partialNew.id]);
 await db.query("UPDATE reverse_eintraege SET status='archiviert' WHERE id=$1",[partialMedium.rid]);
 const first=await request(a),off=await row(first);
 // P18-T97: belegte Alt-Pending drainen bei Halt EIN; generische IDs bleiben unangetastet.
 const halt=await import('../../core/dist/services/reverse-pipeline-halt.js');
 executor.wer=wer;
 const bound=await core.createWorkJobService({pool:db}).get(off.p20_auftrag_id,'reverse-bibliothek');
 eq(await halt.pruefeReverseFachbindung(db,bound),null,'Pipeline legt Beleg atomar an');
 await inDb(()=>halt.setzeReversePipelineHalt(db,true,'T97 Test-Cut','fixture',null));
 await assert.rejects(()=>request(a),/reverse_pipeline_gehalten/,'neue manuelle Zulassung gestoppt');
 const countBefore=(await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n;
 await inDb(()=>pipeline.entdecke());
 eq((await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n,countBefore,'Discovery erzeugt unter Halt keine Ersatzjobs');
 const claimClient=await db.connect();let queryCount=0;
 const heldClient={query:async(...args)=>{queryCount++;return claimClient.query(...args);},release(){throw Error('B1: fremder Client nicht freigeben');}};
 const node=(await db.query('SELECT *,clock_timestamp() AS work_now FROM embedding_knoten WHERE node_id=$1',[wer.nodeId])).rows[0];
 eq(!!await executor.hooks().authorizeJob(node,bound,heldClient),true,'dritter Claim-Client lässt Alt-Pending drainen');
 assert(queryCount>0);checks++;
 const naked=await core.createWorkJobService({pool:db}).enqueue({kind:'reverse-E',capability:'reverse_bibliothek',project:'reverse-bibliothek',scope:'reverse',
  inputRef:bound.inputRef,resourceNeed:bound.resourceNeed,profileId:bound.profileId,idempotencyKey:'t97:naked:'+randomUUID()});
 eq(await executor.hooks().authorizeJob(node,naked,heldClient),null,'generische Route liefert keinen ausführbaren Job');
 claimClient.release();
 const stateBefore=(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[naked.id])).rows[0];
 let sent=0;await executor.fuehreAus({execute:async()=>{sent++;throw Error('unerlaubter Versand');}},wer,naked);
 eq(sent,0,'ungebundener Job vor Dispatch abgewiesen');
 eq((await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[naked.id])).rows[0],stateBefore,'keine fachfremde Terminalisierung');
 eq((await halt.reverseAdmissionDiagnose(db,a.rid,10,0)).drain_fertig,false,'nacktes Pending hält Drain-Tor rot');
 await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=$1",[naked.id]);
 await inDb(()=>halt.setzeReversePipelineHalt(db,false,'T97 Test-Cut beendet','fixture',null));

 // Tatsächliche lc.execute-Callbacks: jeweils NACH Vorbereitung und VOR Sendung den Beleg manipulieren.
 for(const weg of ['E-AUS','E-Block','S3']){
  const m=await medium('send-'+weg),r=await request(m),f=await row(r);
  const token=randomUUID();
  await db.query("UPDATE work_jobs SET state='leased',attempt=1,claim_token=$2,owner_node=$3,boot_generation=$4,owner_auth_hash=$5,resource_domain='reverse:fixture',lease_until=clock_timestamp()+interval '2 minutes' WHERE id=$1",
   [f.p20_auftrag_id,token,wer.nodeId,wer.bootGeneration,wer.authHash]);
  let job=await core.createWorkJobService({pool:db}).get(f.p20_auftrag_id,'reverse-bibliothek');
  const quelle={reverseId:m.rid,mediumId:m.mid,storageKey:m.rid+'/original/disc/disc.iso',dateien:[{storageKey:m.rid+'/original/disc/disc.iso',rolle:'haupt',name:'disc.iso'}]};
  const originalS3Quelle=executor.s3Quelle;
  if(weg==='S3'){
   const datei=(await db.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,art,groesse,sha256,storage_key) VALUES($1,$2,'probe.exe','binaer',4,$3,$4) RETURNING id::text",[m.rid,m.mid,job.inputRef.sha256,quelle.storageKey])).rows[0].id;
   const ref={...job.inputRef,revision:datei};
   await db.query("UPDATE work_jobs SET kind='reverse-S3',input_ref=$2 WHERE id=$1",[job.id,ref]);
   await db.query("UPDATE reverse_auftraege SET schicht='S3',datei_id=$2,uebernahme='{}' WHERE id=$1",[f.id,datei]);
   job={...job,inputRef:ref};
   // S3-Pfad wird direkt aufgerufen; sein eigener Request bleibt an dieselbe Testquelle gebunden.
   job={...job,kind:'reverse-S3'};
   await halt.belegeReverseAdmission(db,job.id,f.id);
   executor.s3Quelle=async()=>quelle;
  }
  eq(await halt.pruefeReverseFachbindung(db,job),null,weg+' vor Sendecallback gültig');
  let callbacks=0,sends=0;
  const guardLifecycle={execute:async(...args)=>{
   callbacks++;
   await db.query("UPDATE reverse_auftraege SET uebernahme=uebernahme #- '{admission}' WHERE id=$1",[f.id]);
   await args[5]();sends++;throw Error('manipulierter Beleg erreichte Sendung');
  },neustart:async()=>({neu_gestartet:false})};
  const state=(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[job.id])).rows[0];
  try{
   if(weg==='E-Block')await assert.rejects(()=>inDb(()=>executor.fuehreEBlockAus(guardLifecycle,wer,job,quelle)),/reverse_admission_nicht_belegt/);
   else if(weg==='S3')await assert.rejects(()=>inDb(()=>executor.fuehreS3Aus(guardLifecycle,wer,job)),/reverse_admission_nicht_belegt/);
   else await inDb(()=>executor.fuehreAus(guardLifecycle,wer,job));
  }finally{executor.s3Quelle=originalS3Quelle;}
  eq(callbacks,1,weg+' echten späten Callback erreicht');eq(sends,0,weg+' kein Versand nach Manipulation');
  eq((await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[job.id])).rows[0],state,weg+' keine Terminalisierung fremder Bindung');
  await db.query("UPDATE work_jobs SET state='cancelled',lease_until=NULL WHERE id=$1",[job.id]);
  await db.query("UPDATE reverse_auftraege SET status='abgebrochen' WHERE id=$1",[f.id]);
  await db.query("UPDATE reverse_eintraege SET status='archiviert' WHERE id=$1",[m.rid]);
 }

 eq((await row(await repeat(a))).p20_auftrag_id,off.p20_auftrag_id,'pending requests deduplicate');
 await drain();eq((await row(first)).status,'fertig');
 eq([calls.at(-1).optionen.pe_ressourcen,calls.at(-1).optionen.siedler3],[false,false],'default OFF reaches command');
 await flag('reverse_pe_ressourcen',true);
 const second=await request(a),pe=await row(second);
 assert.notEqual(pe.fingerabdruck,off.fingerabdruck);assert.notEqual(pe.p20_auftrag_id,off.p20_auftrag_id);checks+=2;
 await drain();eq((await row(second)).status,'fertig');
 eq([calls.at(-1).optionen.pe_ressourcen,calls.at(-1).optionen.siedler3],[true,false],'global PE ON reaches command');
 eq(calls.at(-1).optionen.pe_ressourcen_stand.quelle,'produkt-schalter');
 await flag('reverse_siedler3',true);
 const third=await request(a),both=await row(third);assert.notEqual(both.fingerabdruck,pe.fingerabdruck);checks++;
 await drain();eq((await row(third)).status,'fertig');
 eq([calls.at(-1).optionen.pe_ressourcen,calls.at(-1).optionen.siedler3],[true,true],'both global switches reach fresh command');
 eq(Number((await db.query("SELECT count(*)::int n FROM reverse_dateien WHERE eintrag_id=$1 AND metadaten->>'e_auftrag'=$2",[a.rid,both.p20_auftrag_id])).rows[0].n),3,'fresh feature outputs imported by same E path');
 let count=(await db.query("SELECT count(*)::int n FROM work_jobs")).rows[0].n;
 await inDb(()=>pipeline.entdecke());eq((await db.query("SELECT count(*)::int n FROM work_jobs")).rows[0].n,count,'completed current profile has no discovery loop');
 // Reproduce live F3 exactly: a later Fachauftrag points at a work job that had already completed.
 const orphan=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,medium_id,schicht,status,p20_auftrag_id,ausfuehrung,fingerabdruck,profil_version,werkzeug,werkzeug_version,ziel_schicht,projekt) VALUES($1,$2,'E','wartet',$3,'container',$4,$5,'reverse-E','f2-f3-v1','E','fixture-project') RETURNING id::text",[a.rid,a.mid,both.p20_auftrag_id,both.fingerabdruck,both.profil_version])).rows[0];
 const oldPin=await (await import('../../core/dist/services/reverse-analyse-policy.js')).bereiteReversePolicyPin(db,{id:orphan.id,reverseId:a.rid,dateiId:null,mediumId:a.mid,angefragt:'E'});
 const oldRawKey=a.rid+'/.intern/rueckhalt/'+orphan.id+'/roh.bin',oldRaw=Buffer.from('R1 alter Rueckhalt unveraendert');
 await mkdir(dirname(join(root,oldRawKey)),{recursive:true});await writeFile(join(root,oldRawKey),oldRaw);
 await db.query('UPDATE reverse_auftraege SET policy_pin=$2,uebernahme=$3 WHERE id=$1',[orphan.id,oldPin,{retention:true,rueckhalt:{storage_key:oldRawKey,sha256:sha(oldRaw)},admission:{historisch:'nicht-adoptieren'}}]);
 const oldProof=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1',[orphan.id])).rows[0].uebernahme;
 const generations=(await db.query('SELECT count(*)::int n FROM reverse_auftraege WHERE eintrag_id=$1',[a.rid])).rows[0].n;
 await inDb(()=>pipeline.entdecke());
 const oldAfter=(await db.query('SELECT status,fehlercode,uebernahme FROM reverse_auftraege WHERE id=$1',[orphan.id])).rows[0];
 eq(oldAfter,{status:'fehler',fehlercode:'reverse_generation_abgeloest',uebernahme:oldProof},'R1: Altstatus abgelöst, alter Beleg/Rückhalt unverändert');
 eq((await db.query('SELECT count(*)::int n FROM reverse_auftraege WHERE eintrag_id=$1',[a.rid])).rows[0].n,generations+1,'genau eine neue Fachgeneration');
 const repaired=(await db.query("SELECT id::text,p20_auftrag_id::text FROM reverse_auftraege WHERE eintrag_id=$1 AND id<>$2 ORDER BY created_at DESC,id DESC LIMIT 1",[a.rid,orphan.id])).rows[0];
 assert.notEqual(repaired.p20_auftrag_id,both.p20_auftrag_id);checks++;
 eq(await checkBinding(db,await core.createWorkJobService({pool:db}).get(repaired.p20_auftrag_id,'reverse-bibliothek')),null,'neue Generation konsistent belegt');
 eq((await db.query('SELECT state FROM work_jobs WHERE id=$1',[both.p20_auftrag_id])).rows[0].state,'completed','old work/evidence untouched');
 eq(sha(await fs.readFile(join(root,oldRawKey))),sha(oldRaw),'alte Rueckhaltbytes unverändert');
 await drain();eq((await row({auftrag_id:repaired.id})).status,'fertig','orphan finishes via a new fenced import');
 // Successful fresh manual requests do not consume the failure retry budget.
 for(let i=0;i<3;i++){const next=await request(a);await drain();eq((await row(next)).status,'fertig');}
 const b=await medium('b'),qb=await request(b),rb=await row(qb);
 assert.notEqual(rb.fingerabdruck,both.fingerabdruck);checks++;
 eq((await db.query("SELECT input_ref->>'id' rid FROM work_jobs WHERE id=$1",[rb.p20_auftrag_id])).rows[0].rid,b.rid,'same bytes in another entry have independent E publication');
 await drain();eq((await row(qb)).status,'fertig');
 // A feature change while pending keeps the active work/import binding. Executor reads fresh flags.
 const pending=await request(a),pendingRow=await row(pending);
 const peBefore=(await db.query("SELECT id::text,sha256,metadaten->>'e_auftrag' job FROM reverse_dateien WHERE eintrag_id=$1 AND pfad='CD1/pe.txt'",[a.rid])).rows[0];
 await flag('reverse_pe_ressourcen',false);
 eq((await row(await repeat(a))).p20_auftrag_id,pendingRow.p20_auftrag_id,'feature change cannot detach active E work');
 await drain();eq(calls.at(-1).optionen.pe_ressourcen,false,'dispatch re-reads effective switch');
 await inDb(()=>pipeline.entdecke());await drain();
 await inDb(()=>pipeline.entdecke());await drain();
 count=(await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n;
 await inDb(()=>pipeline.entdecke());eq((await db.query('SELECT count(*)::int n FROM work_jobs')).rows[0].n,count,'feature change settles without infinite re-extraction');
 eq((await db.query("SELECT count(*)::int n FROM reverse_auftraege r JOIN work_jobs w ON w.id=r.p20_auftrag_id WHERE r.schicht='E' AND r.status IN ('offen','wartet','laeuft') AND w.state='completed'")).rows[0].n,0,'no completed-work orphan remains');
 eq((await db.query("SELECT id::text,sha256,metadaten->>'e_auftrag' job FROM reverse_dateien WHERE eintrag_id=$1 AND pfad='CD1/pe.txt'",[a.rid])).rows[0],peBefore,'OFF retains prior derived file unchanged; no new PE output');
 // Return to the original OFF/OFF combination: historical matching jobs cannot hide the current different layer.
 const gfxBefore=(await db.query("SELECT id::text,sha256,metadaten->>'e_auftrag' job FROM reverse_dateien WHERE eintrag_id=$1 AND pfad='CD1/gfx.txt'",[a.rid])).rows[0];
 const aCount=(await db.query("SELECT count(*)::int n FROM work_jobs WHERE input_ref->>'id'=$1",[a.rid])).rows[0].n;
 await flag('reverse_siedler3',false);await inDb(()=>pipeline.entdecke());
 eq((await db.query("SELECT count(*)::int n FROM work_jobs WHERE input_ref->>'id'=$1",[a.rid])).rows[0].n,aCount+1,'return to historical flag combination schedules fresh E '+JSON.stringify((await db.query("SELECT id::text,status,fehlercode,versuch,p20_auftrag_id::text,fingerabdruck,policy_pin FROM reverse_auftraege WHERE eintrag_id=$1 ORDER BY created_at",[a.rid])).rows));
 await drain();await drain();
 eq([calls.at(-1).optionen.pe_ressourcen,calls.at(-1).optionen.siedler3],[false,false],'OFF/OFF reaches new dispatch');
 eq((await db.query("SELECT id::text,sha256,metadaten->>'e_auftrag' job FROM reverse_dateien WHERE eintrag_id=$1 AND pfad='CD1/gfx.txt'",[a.rid])).rows[0],gfxBefore,'Siedler OFF retains existing derived data');

 // R5 isoliert: älterer Fehler, neuere fertige Generation, Profilwechsel -> genau ein neuer Nachzug.
 const r5medium=await medium('r5-generation'),r5old=await request(r5medium);await drain();
 const r5oldRow=await row(r5old);
 await db.query("UPDATE reverse_auftraege SET status='fehler',fehlercode='werkzeug_fehler' WHERE id=$1",[r5oldRow.id]);
 const r5done=await request(r5medium);await drain();eq((await row(r5done)).status,'fertig','R5 neuere erfolgreiche Generation');
 const r5alt=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1',[r5oldRow.id])).rows[0].uebernahme;
 await flag('reverse_pe_ressourcen',true);
 const r5before=(await db.query("SELECT count(*)::int n FROM work_jobs WHERE input_ref->>'id'=$1",[r5medium.rid])).rows[0].n;
 const r5next=await repeat(r5medium),r5nextRow=await row(r5next);
 eq((await db.query("SELECT count(*)::int n FROM work_jobs WHERE input_ref->>'id'=$1",[r5medium.rid])).rows[0].n,r5before+1,'R5 genau ein Nachzug');
 assert.notEqual(r5nextRow.id,r5oldRow.id);assert.notEqual(r5nextRow.id,r5done.auftrag_id);
 eq(await checkBinding(db,await core.createWorkJobService({pool:db}).get(r5nextRow.p20_auftrag_id,'reverse-bibliothek')),null,'R5 neue Generation gültig belegt');
 eq((await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1',[r5oldRow.id])).rows[0].uebernahme,r5alt,'R5 alter Rohbeleg bleibt');
 await drain();eq((await row(r5next)).status,'fertig','R5 neuer Nachzug fertig');

 assert(ownershipCalls>0);checks++;
 console.log('F2/F3 unprivileged uid='+process.getuid?.()+' ownership_boundary_mock_calls='+ownershipCalls);
 console.log('F2/F3 PASS '+checks+' checks; scheduler/cache -> executor switches -> importer; completed reuse/orphan recovery/scoped E/profile changes; commands='+calls.length);
}finally{
 await pipeline?.beende();await executor?.beende();unhook?.();lc?.close();
 if(made)await raw.query('DROP SCHEMA "'+schema+'" CASCADE');
 await raw.end();await core.closePool();await rm(root,{recursive:true,force:true});
 fs.chown=originalChown;syncBuiltinESMExports();
}
