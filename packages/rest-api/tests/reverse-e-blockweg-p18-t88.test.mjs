/** P18-T88: Executor-E-Blockweg Ende zu Ende gegen synapse_test (privates Schema), Fake-Container statt Docker.
 *  Schalter reverse_blockuebernahme AN -> Runner liefert JSONL-Manifest -> Übernahme in Blöcken -> Abbruch nach dem ersten Block
 *  -> nächster Claim setzt am Checkpoint fort, OHNE den Runner erneut zu starten -> alle Dateien, Work-Job completed, E-Schicht fertig.
 */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,rm,mkdtemp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs/promises';
import {zieheSpaltenNach} from '../../core/tests/_helfer/privatschema-spalten.mjs';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
Object.assign(process.env,{SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_REVERSE_CONTAINER_PROFIL:'t88-fixture',SYNAPSE_REVERSE_WERKZEUG_VERSION:'t88-v1',
 SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":512,"vram":0,"gpu":false}'});
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
const raw=new Pool({connectionString:url.href,max:8}),schema='p18_t88x_'+randomUUID().replaceAll('-','');
// Fehlerinjektion: der zweite Blockschreibvorgang in reverse_dateien bricht genau einmal ab (wie ein Absturz mitten in der Übernahme).
let stoerung=false,inserts=0;const umhuellt=new WeakSet();
const db={async connect(){const c=await raw.connect();await c.query('SET search_path TO "'+schema+'",public');
  if(!umhuellt.has(c)){umhuellt.add(c);const q=c.query.bind(c);c.query=(...a)=>{const t=typeof a[0]==='string'?a[0]:a[0]?.text??'';
   if(stoerung&&/INSERT INTO reverse_dateien\(eintrag_id,medium_id,pfad,sha256,groesse,art,storage_key,entpackt_mit/.test(t)&&++inserts===2){stoerung=false;return Promise.reject(new Error('fixture_abbruch'));}
   return q(...a);};}
  return c;},
 async query(...args){const c=await this.connect();try{return await c.query(...args);}finally{c.release();}}};
const inDb=fn=>mitLesePool(db,fn),tx=async fn=>{const c=await db.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const root=await mkdtemp(join(tmpdir(),'p18-t88x-'));
const originalChown=fs.chown;
fs.chown=async p=>{assert(String(p).startsWith(root+'/'),'chown-Ersatz nur im Testordner');};
syncBuiltinESMExports();
const ex=await import('../dist/services/reverse-executor.js');
let executor,lc,unhook,abmelden,made=false,checks=0;
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
const ok=(v,msg)=>{assert.ok(v,msg);checks++;};
const N=3000;
try{
 await raw.query('CREATE SCHEMA "'+schema+'"');made=true;
 for(const table of ['asset_upload_sitzungen','asset_files','agent_profil_schalter'])await db.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
 await db.query('CREATE TABLE projects(name text,enabled boolean)');
 await db.query("CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text NOT NULL,service_token_hash text NOT NULL,status text NOT NULL DEFAULT 'ready',gesperrt_vom_user boolean NOT NULL DEFAULT false,letzter_kontakt timestamptz NOT NULL DEFAULT now(),node_kind text DEFAULT 'cpu')");
 for(const sql of [WORK_JOBS_SCHEMA_SQL,ASSET_UPLOAD_SCHEMA_SQL,REVERSE_SCHEMA_SQL,REVERSE_PIPELINE_SCHEMA_SQL,TOOL_AKTIVITAET_SCHEMA_SQL,TOOL_CONTAINER_SCHEMA_SQL])await db.query(sql);
 for(const [table,column]of [['reverse_eintraege','creator_identity_id'],['reverse_auftraege','trigger_identity_id'],['tool_activation','updater_identity_id']])await db.query('ALTER TABLE '+table+' ADD COLUMN IF NOT EXISTS '+column+' TEXT');
 await db.query('ALTER TABLE reverse_auftraege ADD COLUMN IF NOT EXISTS uebernahme JSONB');
 await db.query('CREATE TABLE reverse_einstellungen(ebene text NOT NULL,project text,eintrag_id text,name text NOT NULL,wert numeric,wert_text text,grund text,gesetzt_von text,gesetzt_am timestamptz DEFAULT now())');
 await db.query("INSERT INTO reverse_einstellungen(ebene,name,wert,grund,gesetzt_von) VALUES('global','e_uebernahme_block_zeilen',1000,'T88 Fixture','fixture')");
 // (angepasst P25-T10, Handliste ohne spaetere Spalten, z. B. reverse_auftraege.policy_pin P18-T104): Spalten aus public nachziehen.
 await zieheSpaltenNach(raw,schema);
 await db.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('global',NULL,'reverse_blockuebernahme',true,'T88 Fixture','fixture')");
 const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
 const konfig=ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse:fixture@sha256:'+'c'.repeat(64),
  SYNAPSE_REVERSE_RESOURCE_NEED:process.env.SYNAPSE_REVERSE_RESOURCE_NEED,SYNAPSE_REVERSE_EXECUTOR_LEASE_SECONDS:'30',SYNAPSE_REVERSE_EXECUTOR_TICK_MS:'1000'},root);
 const wer={nodeId:'t88-fixture',bootGeneration:randomUUID(),authHash:'fixture-only'};
 await db.query('INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)',[wer.nodeId,wer.bootGeneration,wer.authHash]);
 const calls=[],mounts=new Map(),aktiv=new Set(),resolve=ex.reverseMountResolver(konfig);
 lc=new ToolLifecycle({pool:db,maxContainers:4,resources:ex.reverseRessourcen,executor:{
  async start(d,ctx){const id='fake-'+ctx.generation;mounts.set(id,(await resolve(d,ctx)).find(m=>m.role==='arbeit').source);aktiv.add(id);return {id,coldstart_ms:1};},
  async observe(id){return {container_id:id,running:aktiv.has(id),start_observed:true,cpu_percent:0,gpu_percent:null,measured_at:new Date().toISOString()};},
  async stop(id){aktiv.delete(id);},
  async cleanup(){},
  async command(id,req,_t,_m,onTerminal){
   calls.push(req);
   // Review B1: Runner ohne sicheres Ende (kein Manifest, keine Endmeldung) fuer Eintrag B.
   if(String(req.eingabe).includes('rev-t88x-b'))throw new Error('fixture_kein_ende');
   // Runner-Vertrag P18-T88: Dateien + JSONL-Manifest im Ausgabeordner, Antwort nur mit Verweis und Hash.
   const aus=join(mounts.get(id),String(req.ausgabe).split('/').pop());
   const zeilen=[];
   for(let i=0;i<N;i++){
    const pfad='ordner'+(i%20)+'/datei'+i+'.dat',inhalt='inhalt '+i;
    await mkdir(dirname(join(aus,pfad)),{recursive:true});await writeFile(join(aus,pfad),inhalt);
    zeilen.push(JSON.stringify({pfad,groesse:String(Buffer.byteLength(inhalt)),sha256:sha(inhalt),art:'binaer'})+'\n');
   }
   const manifest=Buffer.from(zeilen.join(''));await writeFile(join(aus,'.e-manifest.jsonl'),manifest);
   onTerminal?.();
   return {status:'fertig',manifest_datei:{version:1,pfad:'.e-manifest.jsonl',sha256:sha(manifest),bytes:String(manifest.length),zeilen:String(N)}};
  },
 }});
 executor=new ex.ReverseExecutor({pool:db,konfig,lifecycle:()=>lc,identitaet:async()=>wer,uebernahmeOptionen:{konfiguration:cfg},registriereProjekt:async n=>{await db.query('INSERT INTO projects SELECT $1,true WHERE NOT EXISTS(SELECT 1 FROM projects WHERE name=$1)',[n]);}});
 unhook=ex.registriereWorkJobHooks(ex.REVERSE_CAPABILITY,executor.hooks());
 abmelden=core.meldeReverseAusfuehrer({kinds:['reverse-E'],parallel:1,zeitlimits:{'reverse-E':3600}});
 const pipeline=new core.ReversePipelineDienst({pool:db,konfiguration:cfg,ausfuehrbareKinds:['reverse-E']});
 const rid='rev-t88x-a';
 await db.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Fixture','bestaetigt','{\"automatisch\":true,\"bis_schicht\":\"E\"}')",[rid]);
 const mid=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,art,bezeichnung,status,satz_sha256) VALUES($1,0,'iso','CD1','vollstaendig',$2) RETURNING id::text",[rid,sha('t88x')])).rows[0].id;
 const key=rid+'/original/disc/disc.iso';await mkdir(dirname(join(root,key)),{recursive:true});await writeFile(join(root,key),'iso!');
 await db.query("INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES($1,'haupt','disc.iso',$2,4,$3)",[mid,sha('iso!'),key]);
 const q=await inDb(()=>tx(c=>pipeline.analysieren({reverseId:rid,mediumId:mid,dateiId:null,project:'fixture-project',agentId:'fixture',bisSchicht:'E',prioritaet:'interaktiv'},c)));
 const job=(await db.query('SELECT p20_auftrag_id::text j FROM reverse_auftraege WHERE id=$1',[q.auftrag_id])).rows[0].j;
 const drain=()=>inDb(async()=>{await executor.durchlauf();await executor.leerlauf();});
 const anzahl=async()=>Number((await db.query('SELECT count(*)::int n FROM reverse_dateien WHERE eintrag_id=$1',[rid])).rows[0].n);

 // 1) Erster Lauf: Runner liefert das Manifest, der zweite Block bricht ab -> erster Block bleibt, Job wieder freigegeben.
 stoerung=true;await drain();
 eq(calls.length,1,'genau ein Runnerlauf');
 ok(calls[0].blockuebernahme===true&&calls[0].einstellungen?.version===1,'Blockweg: Snapshot geht an den Runner');
 const cp=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1',[q.auftrag_id])).rows[0].uebernahme;
 ok(cp?.artefakt?.sha256&&cp.position==='1000'&&cp.dateien==='1000'&&!cp.fertig,'Checkpoint nach erstem Block: '+JSON.stringify({...cp,einstellungen:undefined}));
 eq(await anzahl(),1000,'bestätigter erster Block bleibt');
 ok(String(cp.letzter_fehler??'').includes('fixture_abbruch'),'Fehler sichtbar am Checkpoint');
 eq((await db.query('SELECT state FROM work_jobs WHERE id=$1',[job])).rows[0].state,'pending','Job zur Fortsetzung freigegeben');

 // 2) Fortsetzung: kein neuer Runnerlauf, Rest aus dem Manifest.
 for(let i=0;i<3&&(await db.query('SELECT state FROM work_jobs WHERE id=$1',[job])).rows[0].state!=='completed';i++)await drain();
 eq(calls.length,1,'Fortsetzung ohne erneutes Entpacken');
 eq(await anzahl(),N,'alle Dateien übernommen, kein Gesamtschnitt');
 eq((await db.query('SELECT state FROM work_jobs WHERE id=$1',[job])).rows[0].state,'completed','Work-Job completed');
 const schicht=(await db.query("SELECT status,funktionen_gesamt,funktionen_fertig FROM reverse_schichten WHERE medium_id=$1 AND schicht='E' AND aktuell",[mid])).rows[0];
 eq([schicht.status,Number(schicht.funktionen_fertig)],['fertig',N],'E-Schicht fertig mit allen Dateien');
 const ende=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE id=$1',[q.auftrag_id])).rows[0].uebernahme;
 ok(ende.fertig===true&&ende.position===String(N),'Checkpoint am Manifestende');

 // 3) Review 028940c6/B1: Versuche vor dem Manifest-Checkpoint zaehlen; Grenze retry_max aus dem Einstellkatalog, danach endgueltig.
 await db.query("INSERT INTO reverse_einstellungen(ebene,name,wert,grund,gesetzt_von) VALUES('global','retry_max',2,'T86 Review B1','fixture')");
 const ridB='rev-t88x-b';
 await db.query("INSERT INTO reverse_eintraege(id,titel,status,analyse_policy) VALUES($1,'Fixture B','bestaetigt','{\"automatisch\":true,\"bis_schicht\":\"E\"}')",[ridB]);
 const midB=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,art,bezeichnung,status,satz_sha256) VALUES($1,0,'iso','CD1','vollstaendig',$2) RETURNING id::text",[ridB,sha('t88x-b')])).rows[0].id;
 const keyB=ridB+'/original/disc/disc.iso';await mkdir(dirname(join(root,keyB)),{recursive:true});await writeFile(join(root,keyB),'iso-b');
 await db.query("INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES($1,'haupt','disc.iso',$2,5,$3)",[midB,sha('iso-b'),keyB]);
 const qB=await inDb(()=>tx(c=>pipeline.analysieren({reverseId:ridB,mediumId:midB,dateiId:null,project:'fixture-project',agentId:'fixture',bisSchicht:'E',prioritaet:'interaktiv'},c)));
 const jobB=(await db.query('SELECT p20_auftrag_id::text j FROM reverse_auftraege WHERE id=$1',[qB.auftrag_id])).rows[0].j;
 const stand=async()=>({cp:(await db.query('SELECT uebernahme,status FROM reverse_auftraege WHERE id=$1',[qB.auftrag_id])).rows[0],
  job:(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[jobB])).rows[0]});
 // Wie der Entstoerer: haengenden Lauf beenden (Container-Neustart schliesst den unklaren Run ab) und die abgelaufene Lease
 // freigeben; nur pending-Auftraege wecken den Container.
 const ablaufen=async()=>{
  await db.query("UPDATE tool_container_runs SET state='done' WHERE job_id=$1 AND state='unknown'",[jobB]);
  await db.query("UPDATE work_jobs SET state='pending',owner_node=NULL,boot_generation=NULL,owner_auth_hash=NULL,claim_token=NULL,lease_until=NULL,staged_output_ref=NULL WHERE id=$1 AND state='leased'",[jobB]);
 };
 const vorher=calls.length;
 await drain();
 let s=await stand();
 eq(calls.length-vorher,1,'B1: erster Entpackversuch');
 eq([s.cp.uebernahme?.fehlversuche,s.job.state],[1,'leased'],'B1: Runner ohne sicheres Ende zaehlt vorab, Lease bleibt bis zum Ablauf');
 await ablaufen();await drain();
 s=await stand();
 eq(calls.length-vorher,2,'B1: zweiter Versuch nach Lease-Ablauf');
 eq(s.cp.uebernahme?.fehlversuche,2,'B1: zweiter Fehlversuch gezaehlt');
 await ablaufen();await drain();
 s=await stand();
 eq(calls.length-vorher,2,'B1: Grenze erreicht, kein dritter Entpacklauf');
 eq([s.job.state,s.cp.status],['failed','fehler'],'B1: endgueltig, Work-Job failed und Fachauftrag fehler');
 ok(String(s.job.error_code).startsWith('werkzeug_fehler'),'B1: Code werkzeug_fehler: '+s.job.error_code);
 eq((await db.query('SELECT status FROM reverse_analyse_cache WHERE p20_auftrag_id=$1',[jobB])).rows.map(r=>r.status),['fehler'],'B1: kein Neueinreihen (Cache fehler)');
 console.log('P18-T88 Executor-E-Blockweg: '+checks+' Pruefungen gruen');
}finally{
 abmelden?.();await executor?.beende();unhook?.();lc?.close();
 fs.chown=originalChown;syncBuiltinESMExports();
 if(made)await raw.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE').catch(()=>undefined);
 await raw.end();await rm(root,{recursive:true,force:true});
 const {closePool}=await import('../../core/dist/db/client.js');await closePool().catch(()=>undefined);
}
