/** P18-T87: harte Frist und Storno laufender Containerarbeit, Teilergebnis mit Code, kein Neueinreihen/Neuversuch.
 * Echter Scheduler/Executor/Lebenszyklus gegen synapse_test (privates Schema), Fake-Container statt Docker:
 *  A haengender Lauf -> diagnose ueber_zeitlimit -> Executor beendet nach zeitlimit+Puffer -> failed/zeitlimit, entdecke reiht nicht neu ein
 *  B haengender Lauf -> reverse abbrechen (Storno-Wunsch) -> cancelled/abgebrochen vor der Frist, kein Neueinreihen, analysieren geht
 *  C Runner meldet teilweise/zu_gross mit Manifest -> Teilergebnis uebernommen, Auftrag/E-Schicht teilweise zu_gross, kein Neueinreihen
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs/promises';
import {zieheSpaltenNach} from '../../core/tests/_helfer/privatschema-spalten.mjs';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_REVERSE_CONTAINER_PROFIL:'t87-fixture',SYNAPSE_REVERSE_WERKZEUG_VERSION:'t87-v1',
 SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":512,"vram":0,"gpu":false}',SYNAPSE_REVERSE_RETRY_MAX:'2'});
const {Pool}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const core=await import('../../core/dist/index.js');
const {mitLesePool}=await import('../../core/dist/db/client.js');
const {diagnoseReverse}=await import('../../core/dist/services/reverse-entstoerer.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../../core/dist/db/work-jobs-schema.js');
const {TOOL_CONTAINER_SCHEMA_SQL}=await import('../../core/dist/db/tool-container-schema.js');
const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../../core/dist/db/tool-aktivitaet-schema.js');
const {REVERSE_SCHEMA_SQL}=await import('../../core/dist/db/reverse-schema.js');
const {REVERSE_PIPELINE_SCHEMA_SQL}=await import('../../core/dist/db/reverse-pipeline-schema.js');
const {ASSET_UPLOAD_SCHEMA_SQL}=await import('../../core/dist/db/asset-upload-schema.js');
const {ToolLifecycle}=await import('../dist/services/tool-lifecycle.js');
const sha=v=>createHash('sha256').update(v).digest('hex');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const raw=new Pool({connectionString:url.href,max:8}),schema='p18_t87_'+randomUUID().replaceAll('-','');
const db={async connect(){const c=await raw.connect();await c.query('SET search_path TO "'+schema+'",public');return c;},
 async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}}};
const inDb=fn=>mitLesePool(db,fn),tx=async fn=>{const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const root=await mkdtemp(join(tmpdir(),'p18-t87-'));
// Fake-Container ohne uid 65532: nur die Eigentuemer-Grenze wird ersetzt (wie F2/F3), nie die Executor-Pruefung selbst.
const originalChown=fs.chown;
fs.chown=async p=>{assert(String(p).startsWith(root+'/'),'chown-Ersatz nur im Testordner');};
syncBuiltinESMExports();
const ex=await import('../dist/services/reverse-executor.js');
let pipeline,executor,lc,unhook,abmelden,made=false,checks=0;
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
const ok=(v,msg)=>{assert.ok(v,msg);checks++;};
try{
 await raw.query('CREATE SCHEMA "'+schema+'"');made=true;
 for(const table of ['asset_upload_sitzungen','asset_files','agent_profil_schalter'])await db.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
 await db.query('CREATE TABLE projects(name text,enabled boolean)');
 await db.query("CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text NOT NULL,service_token_hash text NOT NULL,status text NOT NULL DEFAULT 'ready',gesperrt_vom_user boolean NOT NULL DEFAULT false,letzter_kontakt timestamptz NOT NULL DEFAULT now(),node_kind text DEFAULT 'cpu')");
 for(const sql of [WORK_JOBS_SCHEMA_SQL,ASSET_UPLOAD_SCHEMA_SQL,REVERSE_SCHEMA_SQL,REVERSE_PIPELINE_SCHEMA_SQL,TOOL_AKTIVITAET_SCHEMA_SQL,TOOL_CONTAINER_SCHEMA_SQL])await db.query(sql);
 for(const [table,column]of [['reverse_eintraege','creator_identity_id'],['reverse_auftraege','trigger_identity_id'],['tool_activation','updater_identity_id']])await db.query('ALTER TABLE '+table+' ADD COLUMN IF NOT EXISTS '+column+' TEXT');
 // P18-T88 (Migration 139): Checkpoint der Blockuebernahme; der Executor fragt ihn je Auftrag ab.
 await db.query('ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS uebernahme JSONB');
 // (angepasst P25-T10, Handliste ohne spaetere Spalten, z. B. reverse_auftraege.policy_pin P18-T104): Spalten aus public nachziehen.
 await zieheSpaltenNach(raw,schema);
 const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
 const konfig=ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse:fixture@sha256:'+'c'.repeat(64),
  SYNAPSE_REVERSE_RESOURCE_NEED:process.env.SYNAPSE_REVERSE_RESOURCE_NEED,SYNAPSE_REVERSE_EXECUTOR_LEASE_SECONDS:'30',
  SYNAPSE_REVERSE_ZEITLIMIT_S:'3',SYNAPSE_REVERSE_HART_PUFFER_S:'1',SYNAPSE_REVERSE_EXECUTOR_TICK_MS:'1000'},root);
 // Puffer/Nachlauf sind Einstellwerte (reverse_einstellungen), keine Env: die Env oben bleibt wirkungslos.
 await db.query('CREATE TABLE reverse_einstellungen(ebene text NOT NULL,project text,eintrag_id text,name text NOT NULL,wert numeric,wert_text text,grund text,gesetzt_von text,gesetzt_am timestamptz DEFAULT now())');
 let einst=await inDb(()=>core.leseReverseAufsicht());
 eq([einst.hart_puffer_s,einst.nachlauf_s],[{wert:30,quelle:'standard'},{wert:300,quelle:'standard'}],'Code-Standard (reverse-einstellungen.ts)');
 await db.query("INSERT INTO reverse_einstellungen(ebene,name,wert,grund,gesetzt_von) VALUES('global','hart_puffer_s',1,'Fixture kurze Frist','fixture'),('global','nachlauf_s',1,'Fixture','fixture')");
 einst=await inDb(()=>core.leseReverseAufsicht());
 eq([einst.hart_puffer_s,ex.reverseHarteFrist(konfig,'reverse-E',einst.hart_puffer_s.wert)],[{wert:1,quelle:'global'},4],'harte Frist = zeitlimit + Einstellwert');
 eq(core.reverseFehlerDeterministisch('zeitlimit'),true,'zeitlimit wird nicht automatisch wiederholt');
 const wer={nodeId:'t87-fixture',bootGeneration:randomUUID(),authHash:'fixture-only'};
 await db.query('INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)',[wer.nodeId,wer.bootGeneration,wer.authHash]);
 const calls=[],mounts=new Map(),aktiv=new Set(),offen=new Map(),modi=new Map(),resolve=ex.reverseMountResolver(konfig);
 lc=new ToolLifecycle({pool:db,maxContainers:4,resources:ex.reverseRessourcen,executor:{
  async start(d,ctx){const id='fake-'+ctx.generation;mounts.set(id,(await resolve(d,ctx)).find(m=>m.role==='arbeit').source);aktiv.add(id);return {id,coldstart_ms:1};},
  async observe(id){return {container_id:id,running:aktiv.has(id),start_observed:true,cpu_percent:0,gpu_percent:null,measured_at:new Date().toISOString()};},
  async stop(id){aktiv.delete(id);const weg=offen.get(id);offen.delete(id);weg?.(Error('tool_runner_disconnected'));},
  async cleanup(){},
  async command(id,req,_t,_m,onTerminal){
   calls.push(req);
   const modus=[...modi].find(([rid])=>String(req.eingabe).includes('/'+rid+'/'))?.[1];
   if(modus==='teilweise'){
    const manifest=[];
    for(const name of ['z1.zip','z1.zip~inhalt/x1.txt']){await mkdir(dirname(join(mounts.get(id),req.auftrag_id,name)),{recursive:true});await writeFile(join(mounts.get(id),req.auftrag_id,name),name);manifest.push({pfad:name,groesse:Buffer.byteLength(name),sha256:sha(name)});}
    onTerminal?.();
    return {status:'teilweise',fehlercode:'zu_gross',manifest,abbruch:{grund:'grenze',fehlercode:'zu_gross',phase:'verschachtelt',pfad:'z2.zip',offen:4,meldung:'Fixture: max_dateien erreicht'}};
   }
   // Haengender Runner: endet nur, wenn der Lebenszyklus den Container stoppt.
   return new Promise((_,reject)=>{offen.set(id,reject);});
  },
 }});
 executor=new ex.ReverseExecutor({pool:db,konfig,lifecycle:()=>lc,identitaet:async()=>wer,uebernahmeOptionen:{konfiguration:cfg},registriereProjekt:async n=>{await db.query('INSERT INTO projects SELECT $1,true WHERE NOT EXISTS(SELECT 1 FROM projects WHERE name=$1)',[n]);}});
 unhook=ex.registriereWorkJobHooks(ex.REVERSE_CAPABILITY,executor.hooks());
 // diagnose kennt die Fristen nur ueber die Ausfuehrer-Registry (Produktion: starteReverseExecutor); hier mit kurzer Frist.
 // diagnose: Frist = Zeitlimit 0 + Puffer 1 -> jeder Lauf ueber 1 s ist ueber_zeitlimit.
 abmelden=core.meldeReverseAusfuehrer({kinds:['reverse-E'],parallel:1,zeitlimits:{'reverse-E':0}});
 pipeline=new core.ReversePipelineDienst({pool:db,konfiguration:cfg,ausfuehrbareKinds:['reverse-E']});
 const medium=async(suffix,modus)=>{
  const rid='rev-t87-'+suffix;modi.set(rid,modus);
  await db.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Fixture','bestaetigt','{\"automatisch\":true,\"bis_schicht\":\"E\"}')",[rid]);
  const mid=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,art,bezeichnung,status,satz_sha256) VALUES($1,0,'iso','CD1','vollstaendig',$2) RETURNING id::text",[rid,sha('t87-'+suffix)])).rows[0].id;
  const key=rid+'/original/disc/disc.iso';await mkdir(dirname(join(root,key)),{recursive:true});await writeFile(join(root,key),'iso!');
  await db.query("INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES($1,'haupt','disc.iso',$2,4,$3)",[mid,sha('iso!'),key]);
  return {rid,mid};
 };
 const request=m=>inDb(()=>tx(c=>pipeline.analysieren({reverseId:m.rid,mediumId:m.mid,dateiId:null,project:'fixture-project',agentId:'fixture',bisSchicht:'E',prioritaet:'interaktiv'},c)));
 const auftrag=async id=>(await db.query('SELECT id::text,status,fehlercode,p20_auftrag_id::text FROM reverse_auftraege WHERE id=$1',[id])).rows[0];
 const work=async id=>(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[id])).rows[0];
 const jobsVon=async rid=>Number((await db.query("SELECT count(*)::int n FROM work_jobs WHERE input_ref->>'id'=$1",[rid])).rows[0].n);
 // (angepasst P25-T13, P18-T93: ein E-Lauf endet nach Eingriff ueber eHalten (Rueckhalt vor failed/cancelled). Das Audit ist dann
 // 'failed'/'cancelled' mit detail.grund/fehlercode; 'reverse_lauf_beendet' schreibt nur noch der S3-Pfad (eingriffBeenden).)
 const beendet=async(id,grund)=>(await db.query("SELECT event,detail FROM work_job_audit WHERE job_id=$1 AND event IN ('reverse_lauf_beendet','failed','cancelled')",[id])).rows
  .some(r=>r.event==='reverse_lauf_beendet'?r.detail.grund===grund:r.detail.grund===grund||r.detail.fehlercode===grund);
 const drain=()=>inDb(async()=>{await executor.durchlauf();await executor.leerlauf();});
 const bisAufruf=async rid=>{for(let i=0;i<100&&!calls.some(c=>String(c.eingabe).includes('/'+rid+'/'));i++)await pause(50);};

 // A) haengender Lauf: diagnose zeigt ueber_zeitlimit, der Executor beendet ihn nach zeitlimit+Puffer selbst.
 const a=await medium('a','haengt'),qa=await request(a),ra=await auftrag(qa.auftrag_id);
 const t0=Date.now(),laufA=drain();
 await bisAufruf(a.rid);await pause(2500);
 const dA=(await inDb(()=>diagnoseReverse({reverseId:a.rid,pool:db}))).auftraege.find(e=>e.p20_auftrag_id===ra.p20_auftrag_id);
 eq([dA.ursache,dA.frist_s],['ueber_zeitlimit',1],JSON.stringify(dA));ok(dA.lauf_s>1,'Laufzeit sichtbar');
 const aufsichtA=(await inDb(()=>diagnoseReverse({reverseId:a.rid,pool:db}))).aufsicht;
 eq([aufsichtA.hart_puffer_s,aufsichtA.nachlauf_s],[{wert:1,quelle:'global'},{wert:1,quelle:'global'}],'diagnose nennt Wert und Quelle der Einstellwerte');
 eq(calls.find(c=>String(c.eingabe).includes('/'+a.rid+'/')).grenzen.nachlauf_s,1,'Nachlauf aus der Einstellung erreicht den Runner');
 await laufA;const dauerA=Date.now()-t0;
 ok(dauerA>=3500&&dauerA<15000,'harte Frist greift nach ~4 s: '+dauerA+' ms');
 eq(await work(ra.p20_auftrag_id),{state:'failed',error_code:'zeitlimit'});
 eq(await auftrag(qa.auftrag_id).then(r=>[r.status,r.fehlercode]),['fehler','zeitlimit'],'endgueltig, kein stiller Neuversuch');
 ok(await beendet(ra.p20_auftrag_id,'zeitlimit'),'Audit Laufende/zeitlimit');
 let n=await jobsVon(a.rid);await inDb(()=>pipeline.entdecke());await inDb(()=>pipeline.entdecke());
 eq(await jobsVon(a.rid),n,'nach zeitlimit kein automatischer Neuversuch (sonst dreimal je Zeitlimit)');

 // B) Storno eines laufenden Jobs: abbrechen hinterlegt den Wunsch, der Executor beendet vor der Frist.
 const b=await medium('b','haengt'),qb=await request(b),rb=await auftrag(qb.auftrag_id);
 const t1=Date.now(),laufB=drain();
 await bisAufruf(b.rid);
 eq((await work(rb.p20_auftrag_id)).state,'leased','laufende Containerarbeit');
 const job=(await db.query('SELECT * FROM reverse_auftraege WHERE id=$1',[qb.auftrag_id])).rows[0];
 const zusatz=await inDb(()=>tx(c=>pipeline.abbrechen(job,'fixture-koordinator',c)));
 eq(zusatz.storno,'angefordert','abbrechen wirft nicht mehr, sondern meldet den Storno-Wunsch');
 await db.query("UPDATE reverse_auftraege SET status='abgebrochen',updated_at=NOW() WHERE id=$1",[qb.auftrag_id]); // wie reverse(abbrechen)
 eq(await inDb(()=>tx(c=>core.reverseStornoAnfordern(c,rb.p20_auftrag_id,{nochmal:true}))),false,'Storno-Wunsch idempotent');
 const dB=(await inDb(()=>diagnoseReverse({reverseId:b.rid,pool:db}))).auftraege.find(e=>e.p20_auftrag_id===rb.p20_auftrag_id);
 ok(dB?.storno_angefordert_at,'diagnose zeigt den Storno-Wunsch: '+JSON.stringify(dB));
 await laufB;const dauerB=Date.now()-t1;
 ok(dauerB<3500,'Storno beendet vor der harten Frist: '+dauerB+' ms');
 eq(await work(rb.p20_auftrag_id),{state:'cancelled',error_code:'abgebrochen'});
 eq((await auftrag(qb.auftrag_id)).status,'abgebrochen');
 ok(await beendet(rb.p20_auftrag_id,'storno'),'Audit reverse_lauf_beendet/storno');
 n=await jobsVon(b.rid);await inDb(()=>pipeline.entdecke());await inDb(()=>pipeline.entdecke());
 eq(await jobsVon(b.rid),n,'nach Storno reiht die Automatik nichts neu ein');
 eq(Number((await db.query("SELECT count(*)::int n FROM reverse_auftraege WHERE eintrag_id=$1 AND status IN ('offen','wartet','laeuft')",[b.rid])).rows[0].n),0,'kein neuer offener Auftrag');
 const neu=await request(b);
 eq(await jobsVon(b.rid),n+1,'ausdrueckliches analysieren legt einen neuen Lauf an');
 ok(neu.auftrag_id&&neu.auftrag_id!==qb.auftrag_id,'neuer Fachauftrag');
 await db.query("UPDATE work_jobs SET state='cancelled' WHERE input_ref->>'id'=$1 AND state='pending'",[b.rid]); // nicht weiter ausfuehren

 // C) Runner endet teilweise/zu_gross: das bis dahin Entpackte wird uebernommen, Status und Code bleiben sichtbar.
 // (angepasst P25-T13, P18-T93 Fallmatrix J: ein Teilergebnis ist kein bestaetigter Vollabschluss. Rueckhalt zuerst, Fachauftrag
 // gehalten (fehler) mit dem spezifischen Code, kein stage/complete; bereits uebernommene Dateien bleiben. Vorher: teilweise + completed.)
 const c=await medium('c','teilweise'),qc=await request(c),rc=await auftrag(qc.auftrag_id);
 await drain();
 const standC={fach:await auftrag(qc.auftrag_id).then(r=>[r.status,r.fehlercode]),
  schicht:(await db.query("SELECT status,fehlercode FROM reverse_schichten WHERE medium_id=$1 AND schicht='E' AND aktuell",[c.mid])).rows[0],
  dateien:Number((await db.query('SELECT count(*)::int n FROM reverse_dateien WHERE eintrag_id=$1',[c.rid])).rows[0].n),work:await work(rc.p20_auftrag_id)};
 eq(standC.fach,['fehler','zu_gross'],'Fachauftrag gehalten mit Code: '+JSON.stringify(standC));
 eq(standC.dateien,2,'Teilergebnis uebernommen');
 ok(standC.work.state!=='completed','kein completed ohne Vollabschluss: '+JSON.stringify(standC));
 n=await jobsVon(c.rid);await inDb(()=>pipeline.entdecke());
 eq(await jobsVon(c.rid),n,'zu_gross ist deterministisch, kein automatischer Neuversuch');
 console.log('P18-T87 BEISPIEL diagnose',JSON.stringify({ursache:dA.ursache,frist_s:dA.frist_s,lauf_s:dA.lauf_s,ursache_text:dA.ursache_text}));
 console.log('P18-T87 PASS '+checks+' checks: harte Frist '+dauerA+' ms, Storno '+dauerB+' ms, Teilergebnis zu_gross, kein Neueinreihen/Neuversuch');
}finally{
 abmelden?.();await pipeline?.beende();await executor?.beende();unhook?.();lc?.close();
 if(made)await raw.query('DROP SCHEMA "'+schema+'" CASCADE');
 await raw.end();await core.closePool();await rm(root,{recursive:true,force:true});
 fs.chown=originalChown;syncBuiltinESMExports();
}
