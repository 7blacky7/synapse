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
 const row=async r=>(await db.query('SELECT id::text,status,p20_auftrag_id::text,fingerabdruck,profil_version FROM reverse_auftraege WHERE id=$1',[r.auftrag_id])).rows[0];
 const drain=async()=>inDb(async()=>{await executor.durchlauf();await executor.leerlauf();});
 const flag=async(name,value)=>db.query("INSERT INTO agent_profil_schalter(ebene,funktion,aktiv,grund,gesetzt_von) VALUES('global',$1,$2,'F2 fixture','fixture') ON CONFLICT(ebene,(COALESCE(project,'')),funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv",[name,value]);
 const first=await request(a),off=await row(first);
 eq((await row(await request(a))).p20_auftrag_id,off.p20_auftrag_id,'pending requests deduplicate');
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
 await inDb(()=>pipeline.entdecke());
 const repaired=await row({auftrag_id:orphan.id});assert.notEqual(repaired.p20_auftrag_id,both.p20_auftrag_id);checks++;
 eq((await db.query('SELECT state FROM work_jobs WHERE id=$1',[both.p20_auftrag_id])).rows[0].state,'completed','old work/evidence untouched');
 await drain();eq((await row({auftrag_id:orphan.id})).status,'fertig','orphan finishes via a new fenced import');
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
 eq((await row(await request(a))).p20_auftrag_id,pendingRow.p20_auftrag_id,'feature change cannot detach active E work');
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
 eq((await db.query("SELECT count(*)::int n FROM work_jobs WHERE input_ref->>'id'=$1",[a.rid])).rows[0].n,aCount+1,'return to historical flag combination schedules fresh E');
 await drain();await drain();
 eq([calls.at(-1).optionen.pe_ressourcen,calls.at(-1).optionen.siedler3],[false,false],'OFF/OFF reaches new dispatch');
 eq((await db.query("SELECT id::text,sha256,metadaten->>'e_auftrag' job FROM reverse_dateien WHERE eintrag_id=$1 AND pfad='CD1/gfx.txt'",[a.rid])).rows[0],gfxBefore,'Siedler OFF retains existing derived data');
 assert(ownershipCalls>0);checks++;
 console.log('F2/F3 unprivileged uid='+process.getuid?.()+' ownership_boundary_mock_calls='+ownershipCalls);
 console.log('F2/F3 PASS '+checks+' checks; scheduler/cache -> executor switches -> importer; completed reuse/orphan recovery/scoped E/profile changes; commands='+calls.length);
}finally{
 await pipeline?.beende();await executor?.beende();unhook?.();lc?.close();
 if(made)await raw.query('DROP SCHEMA "'+schema+'" CASCADE');
 await raw.end();await core.closePool();await rm(root,{recursive:true,force:true});
 fs.chown=originalChown;syncBuiltinESMExports();
}
