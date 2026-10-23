#!/usr/bin/env node
/**
 * P18-T97 F3 tranche 1. Coordinator maintenance after review + full backup.
 * Default dry-run: READ ONLY, streaming canonical JSONL manifest, no cache/share work.
 * --eintrag rev-die-siedler-3-229a52 [--manifest <NEW local audit-data.jsonl>]
 * Apply: --ausfuehren --manifest <sealed audit-data.jsonl>
 * --manifest-sha256 <sha256> --backup-beleg <verified backup identifier>
 * Apply optional --vollsentinel-alle-batches N (default 0, bounded by actual batch count).
 * Optional --sentinel-timeout-ms is bounded by the PG catalog and pinned in manifest/journal.
 * DATABASE_URL comes from the authorised SERVER maintenance environment.
 * Schema145 is deployed normally; this script NEVER creates schema/tables.
 * Import has no I/O side effect. Tests run only when the coordinator opens test phase.
 */
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {leseReverseEinstellwerte,reverseZahl,REVERSE_EINSTELLKATALOG} from '@synapse/core';
import {leseReversePipelineHalt} from '../../core/dist/services/reverse-pipeline-halt.js';

export const ENTRY='rev-die-siedler-3-229a52';
export const FORMATS=['png','gif','wav','jpeg','avi','ico','zip'];
export function canon(x){return JSON.stringify(order(x));}
function order(x){return Array.isArray(x)?x.map(order):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,order(x[k])])):x;}
export const sha=x=>createHash('sha256').update(x).digest('hex');
const hash=x=>sha(canon(x)),size=x=>Buffer.byteLength(canon(x));
const stop=code=>{throw Error(code);};
const same=(a,b,code)=>{if(canon(a)!==canon(b))stop(code);};
const ident=x=>'"'+String(x).replaceAll('"','""')+'"';
const validHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const validName=x=>typeof x==='string'&&(/^(?:strings(?:-[0-9]+)?[.]txt)$/.test(x)||x==='imports.txt');

const contexts=new AsyncLocalStorage(),failures=new WeakMap();
const F3_CODES=new Set(["f3_abhaengigkeit_stop","f3_belegpfad_verboten","f3_bereinigung_laeuft","f3_dateiname","f3_datenbank_fehlt","f3_einstellungen_geaendert","f3_eintrag_nicht_freigegeben","f3_einzelzeile_ueber_budget","f3_fk_unbekannt","f3_halt_erforderlich","f3_journal_daten_widerspruch","f3_katalog_geaendert","f3_journal_konflikt","f3_journal_nebenwirkung","f3_loeschmenge_geaendert","f3_manifest_batch_geaendert","f3_manifest_budget","f3_manifest_fehlt","f3_manifest_fragment","f3_manifest_geaendert","f3_manifest_hash","f3_manifest_header","f3_manifest_json","f3_manifest_nicht_kanonisch","f3_manifest_metadaten","f3_manifest_metadaten_geaendert","f3_manifest_nicht_versiegelt","f3_manifest_op","f3_manifest_quellkonflikt","f3_manifest_record_zu_gross","f3_manifest_reihenfolge","f3_nicht_ruhig","f3_parameter","f3_projektbestand_geaendert","f3_projekttabelle_unzugeordnet","f3_projektzeile_unzugeordnet","f3_quelle_geaendert","f3_relation_unbekannt","f3_schema145_abweichend","f3_schema145_fehlt","f3_sentinel_budget","f3_sentinel_im_manifest_gepinnt","f3_sicherungsbeleg_fehlt","f3_symbol_geaendert","f3_trigger_unbekannt","f3_tx_budget","f3_werkzeug_fehler","f3_zwischen_budget"]);
const PHASES=new Set(['initialisieren','audit_open','db_connect','db_begin','einstellungen','timeouts','fk_katalog','ruhe','journal','sentinel_katalog','sentinel_ownership','sentinel_count','sentinel_hash','sentinel_restore','kandidaten','symbole','abhaengigkeiten','manifest_header','manifest_metadaten','manifest_records','manifest_sync','manifest_pruefen','endbilanz','apply','commit','abschluss']);
const TABLES=new Set(['asset_aenderungen','asset_aenderungsstaende','asset_files','asset_host_checkpoints','asset_inspektions_auftraege','asset_inspektions_projekte','asset_konflikt_eingaenge','asset_konflikt_loesungen','asset_konflikte','asset_manifest_eintraege','asset_manifest_sitzungen','asset_mutationen','asset_objects','asset_projekt_optionen','asset_references','asset_retention_referenzen','asset_revisionen','asset_scan_checkpoints','asset_upload_sitzungen','asset_upload_teile','code_call_edges','code_chunks','code_files','code_references','code_statements','code_symbols','file_versions']);
const FS_CODES=new Set(['EACCES','EPERM','ENOENT','EEXIST','ENOSPC','EROFS','EIO','ELOOP','EMFILE','ENFILE','EISDIR','ENOTDIR']);
function phase(name,table){const c=contexts.getStore();if(c){c.phase=PHASES.has(name)?name:'initialisieren';c.table=TABLES.has(table)?table:undefined;}}
function capture(e,source){
 const c=contexts.getStore();if(!c||c.first)return;
 c.error=e;c.first={code:F3_CODES.has(e?.message)?e.message:'f3_werkzeug_fehler',phase:c.phase??'initialisieren',
  ...(c.table?{tabelle:c.table}:{}),...(source==='pg'&&/^[0-9A-Z]{5}$/.test(e?.code)?{pg_code:e.code}:{}),
  ...(FS_CODES.has(e?.code)?{fs_code:e.code}:{})};
}
async function diagnosed(fn){
 if(contexts.getStore())return fn();
 return contexts.run({phase:'initialisieren'},async()=>{try{return await fn();}catch(e){capture(e);if(e&&typeof e==='object')failures.set(e,{...contexts.getStore().first,committed_batches:contexts.getStore().error?.committed_batches??0,resumed_batches:contexts.getStore().error?.resumed_batches??0,...(contexts.getStore().error?.alarm===true?{alarm:true}:{})});throw e;}});
}
function observed(db){
 return {query:async(...args)=>{try{return await db.query(...args);}catch(e){capture(e,'pg');throw e;}},
  ...(db.connect?{connect:async()=>{try{return observed(await db.connect());}catch(e){capture(e,'pg');throw e;}}}:{}),
  ...(db.release?{release:(...args)=>db.release(...args)}:{}),...(db.end?{end:()=>db.end()}:{} )};
}
export function failureDiagnostic(e){const d=failures.get(e);return {status:'gestoppt',...(d??{code:F3_CODES.has(e?.message)?e.message:'f3_werkzeug_fehler',phase:'initialisieren'}),
 committed_batches:d?.committed_batches??e?.committed_batches??0,resumed_batches:d?.resumed_batches??e?.resumed_batches??0};}
export function sentinelPolicy(settings,override){
 const max=Number(REVERSE_EINSTELLKATALOG.leser_statement_timeout_ms.max);
 const timeout=override??settings.statement;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>max)stop('f3_sentinel_budget');
 return {timeout_ms:timeout,quelle:override===undefined?'pg':'cli'};
}

const eligible=[
 "c.eintrag_id=$1 AND c.schicht='S1' AND c.parser_generation_id IS NULL AND c.deleted_at IS NULL",
 "AND d.format=ANY($2::text[]) AND d.sha256 IS NOT NULL AND d.storage_key IS NOT NULL",
 "AND NOT (COALESCE(d.metadaten#>>'{code_klassifikation,ist_code}','false')='true' AND d.metadaten#>>'{code_klassifikation,sha256}'=d.sha256)",
 "AND (c.file_name ~ '^strings(-[0-9]+)?[.]txt$' OR (c.file_name='imports.txt' AND COALESCE(c.content,'')=''))"
].join(' ');
const cols="c.id,c.file_path,c.file_name,c.datei_id::text AS source_id,d.sha256 AS source_sha,to_jsonb(c)::text AS raw,to_jsonb(d)::text AS source_raw";
const FK=new Set([
 'reverse_code_symbole>reverse_code_dateien:FOREIGN KEY (eintrag_id, file_path) REFERENCES reverse_code_dateien(eintrag_id, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_symbole>reverse_code_symbole:FOREIGN KEY (parent_symbol) REFERENCES reverse_code_symbole(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_verweise>reverse_code_dateien:FOREIGN KEY (eintrag_id, file_path) REFERENCES reverse_code_dateien(eintrag_id, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_verweise>reverse_code_symbole:FOREIGN KEY (symbol_id) REFERENCES reverse_code_symbole(id) ON DELETE CASCADE',
 'reverse_code_statements>reverse_code_dateien:FOREIGN KEY (eintrag_id, file_path) REFERENCES reverse_code_dateien(eintrag_id, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_kanten>reverse_code_dateien:FOREIGN KEY (eintrag_id, file_path) REFERENCES reverse_code_dateien(eintrag_id, file_path) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED',
 'reverse_code_kanten>reverse_code_symbole:FOREIGN KEY (target_symbol_id) REFERENCES reverse_code_symbole(id) ON DELETE SET NULL'
]);
const CODE_TABLES=['reverse_code_dateien','reverse_code_symbole','reverse_code_verweise','reverse_code_statements','reverse_code_kanten'];
export async function schemaGuard(db){
 phase('fk_katalog');
 // Resolve the SAME exact schema/OIDs used by our locks and dependency queries.
 const relations=(await db.query("SELECT c.relname AS name,c.oid::text AS oid,n.nspname AS schema,to_regclass(quote_ident(c.relname))::oid::text AS visible_oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[]) AND c.relkind='r'",[CODE_TABLES])).rows;
 if(relations.length!==CODE_TABLES.length||relations.some(r=>r.oid!==r.visible_oid))stop('f3_relation_unbekannt');
 const by=new Map(relations.map(r=>[r.name,r])),targets=['reverse_code_dateien','reverse_code_symbole'].map(n=>by.get(n).oid);
 // Do NOT filter child schemas: every incoming FK from the entire DB is inspected.
 const r=await db.query("SELECT k.oid::text AS constraint_oid,k.convalidated,k.conrelid::text AS child_oid,k.confrelid::text AS parent_oid,c.relname AS t,p.relname AS target,cn.nspname AS child_schema,pn.nspname AS parent_schema,pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace WHERE k.contype='f' AND k.confrelid=ANY($1::oid[])",[targets]);
 for(const f of r.rows){
  const child=by.get(f.t),parent=by.get(f.target);
  if(!child||!parent||f.child_oid!==child.oid||f.parent_oid!==parent.oid||
     f.child_schema!==child.schema||f.parent_schema!==parent.schema||
     !FK.has(f.t+'>'+f.target+':'+f.def))stop('f3_fk_unbekannt');
 }
 const allRelations=relations.map(r=>r.oid);
 const triggers=await db.query("SELECT oid::text AS trigger_oid,tgrelid::text AS relation_oid,tgname,tgenabled,tgisinternal,tgfoid::text AS function_oid,tgconstraint::text AS constraint_oid,tgtype,tgattr::text AS attributes,encode(tgargs,'hex') AS args,pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgrelid=ANY($1::oid[])",[allRelations]);
 if(triggers.rows.some(t=>!t.tgisinternal&&targets.includes(t.relation_oid)))stop('f3_trigger_unbekannt');
 return hash({relations:[...relations].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0),
  foreign_keys:[...r.rows].sort((a,b)=>a.constraint_oid<b.constraint_oid?-1:a.constraint_oid>b.constraint_oid?1:0),
  triggers:[...triggers.rows].sort((a,b)=>a.trigger_oid<b.trigger_oid?-1:a.trigger_oid>b.trigger_oid?1:0)});
}
async function checkCatalog(db,h){
 same(await schemaGuard(db),h.katalog_sha256,'f3_katalog_geaendert');
}
async function settings(db){
 phase('einstellungen');
 const s=await leseReverseEinstellwerte({eintrag_id:ENTRY},db);
 if(s.letzter_fehler)stop(s.letzter_fehler);
 return {revision:s.revision,rows:reverseZahl(s,'e_uebernahme_block_zeilen'),maxBytes:reverseZahl(s,'materialisierung_tx_bytes'),
  recordBytes:reverseZahl(s,'manifest_record_bytes'),statement:reverseZahl(s,'leser_statement_timeout_ms'),lock:reverseZahl(s,'leser_lock_timeout_ms')};
}
const TERMINAL_JOBS=['completed','failed','cancelled','expired'];
async function quiet(db){
 phase('ruhe');
 const h=await leseReversePipelineHalt(db);if(!h.aktiv||h.letzter_fehler)stop('f3_halt_erforderlich');
 if((await db.query("SELECT 1 FROM reverse_auftraege WHERE status IN('offen','wartet','laeuft') OR lease_bis>clock_timestamp() LIMIT 1")).rows.length)stop('f3_nicht_ruhig');
 // Terminal historical P20 flags alone are NOT evidence of a living resource.
 // Any non-terminal job, live lease or non-done run (including older attempts)
 // remains a hard stop, independently of resource_unconfirmed.
 if((await db.query("SELECT 1 FROM work_jobs w WHERE w.scope='reverse' AND (w.state IS NULL OR NOT (w.state=ANY($1::text[])) OR w.lease_until>clock_timestamp()) LIMIT 1",[TERMINAL_JOBS])).rows.length)stop('f3_nicht_ruhig');
 if((await db.query("SELECT 1 FROM tool_container_runs r JOIN work_jobs w ON w.id=r.job_id WHERE w.scope='reverse' AND r.state IS DISTINCT FROM 'done' LIMIT 1")).rows.length)stop('f3_nicht_ruhig');
 const stale=(await db.query("SELECT id::text AS job_id,state,attempt FROM work_jobs WHERE scope='reverse' AND state=ANY($1::text[]) AND resource_unconfirmed ORDER BY id",[TERMINAL_JOBS])).rows;
 return stale.map(r=>({code:'f3_terminaler_altmarker',job_id:r.job_id,state:r.state,attempt:r.attempt}));
}
const indirect={
 asset_revisionen:{owner:"a.project",join:"JOIN asset_files a ON a.id=t.asset_id",valid:"EXISTS(SELECT 1 FROM asset_files a WHERE a.id=t.asset_id)"},
 asset_konflikte:{owner:"a.project",join:"JOIN asset_files a ON a.id=t.asset_id",valid:"EXISTS(SELECT 1 FROM asset_files a WHERE a.id=t.asset_id)"},
 asset_retention_referenzen:{owner:"a.project",join:"JOIN asset_files a ON a.id=t.asset_id",valid:"EXISTS(SELECT 1 FROM asset_files a WHERE a.id=t.asset_id)"},
 asset_manifest_eintraege:{owner:"m.project",join:"JOIN asset_manifest_sitzungen m ON m.id=t.manifest_id",valid:"EXISTS(SELECT 1 FROM asset_manifest_sitzungen m JOIN asset_files a ON a.id=t.asset_id AND a.project=m.project WHERE m.id=t.manifest_id)"},
 // Root-key protocol is defined by share-scanner.ts:89; include every checkpoint
 // conservatively (also Reverse roots), rather than lose an unassignable owner.
 asset_scan_checkpoints:{owner:"'root:'||t.root_key",join:"",valid:"t.root_key LIKE 'projekt:%' OR t.root_key LIKE 'reverse:%'"},
 asset_upload_sitzungen:{owner:"CASE WHEN t.bereich='projekt' THEN t.ziel_ref ELSE '@reverse-transport:'||t.ziel_ref END",join:"",valid:"t.bereich IN('projekt','reverse') AND t.ziel_ref IS NOT NULL"},
 asset_upload_teile:{owner:"CASE WHEN u.bereich='projekt' THEN u.ziel_ref ELSE '@reverse-transport:'||u.ziel_ref END",join:"JOIN asset_upload_sitzungen u ON u.id=t.upload_id",valid:"EXISTS(SELECT 1 FROM asset_upload_sitzungen u WHERE u.id=t.upload_id AND u.bereich IN('projekt','reverse') AND u.ziel_ref IS NOT NULL)"}
};
/** Counts AND SHA256 of complete canonical records (IDs/revisions/content included).
 * Fresh READ COMMITTED statement per table; no stale snapshot in a write transaction.
 * All projects and indirect owners; an unknown/unassignable table is a STOP.
 */
export async function projectSentinel(db,policy){
 phase('sentinel_katalog');
 const old=policy?(await db.query("SELECT current_setting('statement_timeout') AS v")).rows[0].v:null;
 if(policy)await db.query("SELECT set_config('statement_timeout',$1,false)",[String(policy.timeout_ms)]);
 let primary=false;
 try{
 const schema=(await db.query('SELECT current_schema() AS s')).rows[0].s;
 const names=(await db.query("SELECT t.table_name,EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema=t.table_schema AND c.table_name=t.table_name AND c.column_name='project') AS direct FROM information_schema.tables t WHERE t.table_schema=$1 AND t.table_type='BASE TABLE' AND (t.table_name LIKE 'asset\\_%' ESCAPE '\\' OR t.table_name LIKE 'code\\_%' ESCAPE '\\' OR t.table_name='file_versions') ORDER BY t.table_name",[schema])).rows;
 const out={};
 for(const {table_name:t,direct} of names){
  phase('sentinel_ownership',t);
  const spec=direct?{owner:'t.project',join:'',valid:'t.project IS NOT NULL'}:indirect[t];
  if(!spec)stop('f3_projekttabelle_unzugeordnet');
  const table=ident(schema)+'.'+ident(t);
  phase('sentinel_ownership',t);
  if((await db.query('SELECT 1 FROM '+table+' t WHERE ('+spec.valid+') IS NOT TRUE LIMIT 1')).rows.length)stop('f3_projektzeile_unzugeordnet');
  phase('sentinel_count',t);
  const counts=(await db.query('SELECT '+spec.owner+'::text AS owner,count(*)::text AS n FROM '+table+' t '+spec.join+' GROUP BY '+spec.owner+' ORDER BY owner')).rows;
  phase('sentinel_hash',t);
  // Digest is a sorted multiset of record-SHA256, avoiding one enormous value/content dump.
  out[t]=(await db.query("SELECT owner,count(*)::text AS n,encode(sha256(convert_to(string_agg(h,'' ORDER BY h),'UTF8')),'hex') AS sha256 FROM (SELECT "+spec.owner+"::text AS owner,encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS h FROM "+table+" t "+spec.join+") q GROUP BY owner ORDER BY owner")).rows;
  same(out[t].map(({owner,n})=>({owner,n})),counts,'f3_projektbestand_geaendert');
 }
 return out;
 }catch(e){primary=true;capture(e,'pg');throw e;}finally{if(policy){phase('sentinel_restore');try{await db.query("SELECT set_config('statement_timeout',$1,false)",[old]);}catch(e){capture(e,'pg');if(!primary)throw e;}}}
}
const checkProjects=async(db,h)=>same(await projectSentinel(db,h.sentinel),h.projects,'f3_projektbestand_geaendert');
const file=r=>({id:r.id,path:r.file_path,name:r.file_name,source_id:r.source_id,source_sha:r.source_sha,
 code_hash:sha(r.raw),source_hash:sha(r.source_raw),row_bytes:Buffer.byteLength(r.raw)});
async function deadlines(db,s){phase('timeouts');await db.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",[String(s.statement),String(s.lock)]);}

async function* plannedOperations(db,s){
 let cursor='';
 for(;;){
  phase('kandidaten');
  const rows=(await db.query('SELECT '+cols+' FROM reverse_code_dateien c JOIN reverse_dateien d ON d.id=c.datei_id AND d.eintrag_id=c.eintrag_id WHERE '+eligible+' AND c.id>$3 ORDER BY c.id LIMIT $4',[ENTRY,FORMATS,cursor,s.rows])).rows;
  if(!rows.length)break;
  for(const r of rows){
   const f=file(r);if(!validName(f.name))stop('f3_dateiname');
   let after='',pending=0;
   for(;;){
    phase('symbole');
    const ss=(await db.query("SELECT id,to_jsonb(s)::text AS raw FROM reverse_code_symbole s WHERE eintrag_id=$1 AND file_path=$2 AND id>$3 ORDER BY id LIMIT $4",[ENTRY,f.path,after,s.rows])).rows;
    if(!ss.length)break;
    const ops=ss.map(v=>{
     const raw=JSON.parse(v.raw);
     if(String(raw.datei_id)!==f.source_id||raw.schicht!=='S1'||raw.parser_generation_id!==null)stop('f3_symbol_geaendert');
     return {kind:'symbol',id:v.id,file:f,hash:sha(v.raw),row_bytes:Buffer.byteLength(v.raw)};
    });
    await dependencyGuard(db,'symbol',ops);pending+=ops.length;
    yield* ops;after=ss.at(-1).id;
   }
   await dependencyGuard(db,'file',[{file:f}],pending);
   yield {kind:'file',id:f.id,file:f,hash:f.code_hash,row_bytes:f.row_bytes};
  }
  cursor=rows.at(-1).id;
 }
}

export function encodeRecord(value,limit){
 const raw=canon(value)+'\n';
 if(Buffer.byteLength(raw)>limit)stop('f3_manifest_record_zu_gross');
 return raw;
}
export function* metadataRecords(projects,hinweise){
 for(const table of Object.keys(projects).sort()){
  yield {kind:'project_table',table,owners:projects[table].length};
  for(const row of projects[table])yield {kind:'project_owner',table,owner:row.owner,n:row.n,sha256:row.sha256};
 }
 for(const hinweis of hinweise)yield {kind:'hinweis',hinweis};
}
export function manifestHeader(settings,sentinel,projects,hinweise,katalog_sha256){
 return {kind:'header',version:4,scope:'p18-t97-f3-tranche1',entry:ENTRY,settings,sentinel,katalog_sha256,
  metadaten:{project_tables:Object.keys(projects).length,project_owners:Object.values(projects).reduce((n,a)=>n+a.length,0),
   hinweise:hinweise.length,projects_sha256:hash(projects),hinweise_sha256:hash(hinweise)}};
}
function validHinweis(x){
 return x?.code==='f3_terminaler_altmarker'&&typeof x.job_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(x.job_id)&&TERMINAL_JOBS.includes(x.state)&&Number.isSafeInteger(x.attempt)&&x.attempt>=0;
}
/** Metadata is reconstructed only for the reviewed table/owner sentinels, never
 * for all candidate IDs. Empty tables get explicit table records.
 */
async function* operationStream(lines,onHeader,onRaw){
 let header,remaining=0,currentTable='',lastTable='',tables=0,owners=0,hints=false,ready=false;
 const ownerSeen=new Set(),hintSeen=new Set();
 const finish=()=>{
  if(ready)return;
  if(!header||remaining!==0||tables!==header.metadaten.project_tables||owners!==header.metadaten.project_owners||header.hinweise.length!==header.metadaten.hinweise)stop('f3_manifest_metadaten');
  if(hash(header.projects)!==header.metadaten.projects_sha256||hash(header.hinweise)!==header.metadaten.hinweise_sha256)stop('f3_manifest_metadaten');
  ready=true;onHeader(header);
 };
 for await(const raw of lines()){
  onRaw?.(raw);let x;try{x=JSON.parse(raw);}catch{stop('f3_manifest_json');}
  if(canon(x)+'\n'!==raw)stop('f3_manifest_nicht_kanonisch');
  if(!header){
   validateHeader(x);encodeRecord(x,x.settings.recordBytes);
   header={...x,projects:Object.create(null),hinweise:[]};continue;
  }
  encodeRecord(x,header.settings.recordBytes);
  if(['project_table','project_owner','hinweis'].includes(x.kind)){
   if(ready)stop('f3_manifest_metadaten');
   if(x.kind==='project_table'){
    if(hints||remaining!==0||typeof x.table!=='string'||!/^[a-z_][a-z0-9_]*$/.test(x.table)||x.table<=lastTable||!Number.isSafeInteger(x.owners)||x.owners<0||tables>=header.metadaten.project_tables)stop('f3_manifest_metadaten');
    lastTable=currentTable=x.table;remaining=x.owners;ownerSeen.clear();tables++;header.projects[x.table]=[];
   }else if(x.kind==='project_owner'){
    if(hints||!currentTable||x.table!==currentTable||remaining<1||typeof x.owner!=='string'||ownerSeen.has(x.owner)||typeof x.n!=='string'||!/^[1-9][0-9]*$/.test(x.n)||!validHash(x.sha256)||owners>=header.metadaten.project_owners)stop('f3_manifest_metadaten');
    ownerSeen.add(x.owner);header.projects[currentTable].push({owner:x.owner,n:x.n,sha256:x.sha256});remaining--;owners++;
   }else{
    if(remaining!==0||tables!==header.metadaten.project_tables||owners!==header.metadaten.project_owners||!validHinweis(x.hinweis)||hintSeen.has(x.hinweis.job_id)||header.hinweise.length>=header.metadaten.hinweise)stop('f3_manifest_metadaten');
    hints=true;hintSeen.add(x.hinweis.job_id);header.hinweise.push(x.hinweis);
   }
   continue;
  }
  finish();validateOp(x);yield x;
 }
 finish();
}

export async function createManifest(pool,emit,{sentinelTimeoutMs}={}){
 return diagnosed(async()=>{
 phase('db_connect');
 const db=await observed(pool).connect(),digest=createHash('sha256');let files=0,symbols=0,s,broken=false;
 const send=async x=>{const raw=encodeRecord(x,s.recordBytes);digest.update(raw);await emit?.(raw);};
 try{
  phase('db_begin');await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  s=await settings(db);await deadlines(db,s);const katalog=await schemaGuard(db);await journalGuard(db);const hinweise=await quiet(db);
  const sentinel=sentinelPolicy(s,sentinelTimeoutMs),projects=await projectSentinel(db,sentinel);
  const header=manifestHeader(s,sentinel,projects,hinweise,katalog);
  // Validate EVERY record before output, using the same record budget as the writer.
  phase('manifest_header');encodeRecord(header,s.recordBytes);
  phase('manifest_metadaten');for(const row of metadataRecords(projects,hinweise))encodeRecord(row,s.recordBytes);
  // Full read-only guard pass BEFORE the first header. Same stable snapshot as output.
  for await(const op of plannedOperations(db,s)){validateOp(op);phase('manifest_records');encodeRecord(op,s.recordBytes);}
  phase('manifest_header');await send(header);
  phase('manifest_metadaten');for(const row of metadataRecords(projects,hinweise))await send(row);
  for await(const op of plannedOperations(db,s)){
   phase('manifest_records');await send(op);if(op.kind==='file')files++;else symbols++;
  }
  phase('abschluss');await db.query('ROLLBACK');return {sha256:digest.digest('hex'),files,symbols,sentinel,hinweise_anzahl:hinweise.length,metadaten:header.metadaten};
 }catch(e){capture(e);await db.query('ROLLBACK').catch(()=>{broken=true;});throw e;}finally{db.release(broken);}
 });
}

export function validateHeader(h){
 if(h?.kind!=='header'||h.version!==4||h.scope!=='p18-t97-f3-tranche1'||h.entry!==ENTRY||
    Object.hasOwn(h,'projects')||Object.hasOwn(h,'hinweise')||!h.settings||!validHash(h.settings.revision)||!validHash(h.katalog_sha256))stop('f3_manifest_header');
 const m=h.metadaten;
 if(!m||!validHash(m.projects_sha256)||!validHash(m.hinweise_sha256))stop('f3_manifest_header');
 for(const k of ['project_tables','project_owners','hinweise'])if(!Number.isSafeInteger(m[k])||m[k]<0)stop('f3_manifest_header');
 if(!h.sentinel||!['pg','cli'].includes(h.sentinel.quelle))stop('f3_manifest_header');
 same(h.sentinel,sentinelPolicy(h.settings,h.sentinel.quelle==='cli'?h.sentinel.timeout_ms:undefined),'f3_manifest_header');
 for(const k of ['rows','maxBytes','recordBytes','statement','lock'])
  if(!Number.isSafeInteger(h.settings[k])||h.settings[k]<1)stop('f3_manifest_budget');
}
function validateOp(x){
 const f=x?.file;
 if(!['symbol','file'].includes(x?.kind)||typeof x.id!=='string'||!x.id||!validHash(x.hash)||
    !Number.isSafeInteger(x.row_bytes)||x.row_bytes<1||!f||typeof f.id!=='string'||
    typeof f.path!=='string'||!validName(f.name)||f.path.split('/').at(-1)!==f.name||
    !/^[1-9][0-9]*$/.test(f.source_id)||!validHash(f.source_sha)||!validHash(f.source_hash)||!validHash(f.code_hash)||
    !Number.isSafeInteger(f.row_bytes)||f.row_bytes<1||
    (x.kind==='file'&&(x.id!==f.id||x.hash!==f.code_hash||x.row_bytes!==f.row_bytes)))stop('f3_manifest_op');
}
export async function verifyManifest(lines,expected,backup=''){
 if(!validHash(expected))stop('f3_manifest_hash');
 const digest=createHash('sha256');let header,previousFile='',previousSymbol='',current=null,closed=true,n=0,approved=[],cost;
 const proofs=[];
 for await(const x of operationStream(lines,h=>{header=h;cost=batchBase({...h,backup});},raw=>digest.update(raw))){
  if(current?.id!==x.file.id){
   if(!closed||x.file.id<=previousFile)stop('f3_manifest_reihenfolge');
   current=x.file;previousFile=x.file.id;previousSymbol='';closed=false;
  }else same(current,x.file,'f3_manifest_quellkonflikt');
  if(closed)stop('f3_manifest_reihenfolge');
  if(x.kind==='symbol'){
   if(x.id<=previousSymbol)stop('f3_manifest_reihenfolge');previousSymbol=x.id;
  }else closed=true;
  let proposed=addCost(cost,x);
  if(approved.length&&(proposed.rows>header.settings.rows||proposed.bytes>header.settings.maxBytes)){
   proofs.push(hash(approved));approved=[];cost=batchBase({...header,backup});proposed=addCost(cost,x);
  }
  if(proposed.rows>header.settings.rows||proposed.bytes>header.settings.maxBytes)stop('f3_einzelzeile_ueber_budget');
  approved.push(x);cost=proposed;n++;
 }
 if(approved.length)proofs.push(hash(approved));
 if(!header||!closed||digest.digest('hex')!==expected)stop('f3_manifest_hash');
 return {header,operations:n,proofs};
}
function payload(h,pin,n,ops,backup,zwischen=0){
 return {eintrag_id:ENTRY,manifest_sha256:pin,batch_nr:String(n),batch_sha256:hash(ops),ops,
  delta:{files:ops.filter(x=>x.kind==='file').length,symbols:ops.filter(x=>x.kind==='symbol').length,sentinel:h.sentinel,pruefungen:{vollsentinel_alle_batches:zwischen},katalog_sha256:h.katalog_sha256},
  backup_beleg:backup,projekt_sentinel_sha256:h.metadaten.projects_sha256,einstellungen_revision:h.settings.revision};
}
/** Linear accounting: candidate count never enlarges a record/header.
 * Charge explicit deletes + journal row, complete row bytes and conservative wire cost.
 * Metadata digest is computed ONCE, never rehash the full sentinel set per candidate.
 */
function batchBase(h){
 return {rows:1,bytes:8+size({entry:ENTRY,pin:'0'.repeat(64),batch:'9223372036854775807',backup:h.backup,
  settings:h.settings.revision,sentinel:h.sentinel,projects:h.metadaten.projects_sha256,katalog:h.katalog_sha256,vollsentinel_alle_batches:Number.MAX_SAFE_INTEGER})};
}
const addCost=(c,x)=>({rows:c.rows+1,bytes:c.bytes+x.row_bytes+4*size(x)+4});
export function batchCost(h,ops){return ops.reduce(addCost,batchBase(h));}
export async function* batches(lines,h,backup){
 let ops=[],cost=batchBase({...h,backup});
 for await(const x of operationStream(lines,actual=>same(actual,h,'f3_manifest_metadaten_geaendert'))){
  let next=addCost(cost,x);
  if(ops.length&&(next.rows>h.settings.rows||next.bytes>h.settings.maxBytes)){
   yield ops;ops=[];cost=batchBase({...h,backup});next=addCost(cost,x);
  }
  if(next.rows>h.settings.rows||next.bytes>h.settings.maxBytes)stop('f3_einzelzeile_ueber_budget');
  ops.push(x);cost=next;
 }
 if(ops.length)yield ops;
}
async function journalGuard(db){
 phase('journal');
 const name=(await db.query("SELECT to_regclass(format('%I.reverse_f3_bereinigungs_batches',current_schema())) AS t")).rows[0].t;
 if(!name)stop('f3_schema145_fehlt');
 const columns=(await db.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='reverse_f3_bereinigungs_batches' ORDER BY ordinal_position")).rows;
 same(columns.map(x=>[x.column_name,x.data_type]),[
  ['eintrag_id','text'],['manifest_sha256','text'],['batch_nr','bigint'],['batch_sha256','text'],
  ['ops','jsonb'],['delta','jsonb'],['backup_beleg','text'],['projekt_sentinel_sha256','text'],
  ['einstellungen_revision','text'],['abgeschlossen_am','timestamp with time zone']
 ],'f3_schema145_abweichend');
 const constraints=(await db.query("SELECT contype,pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='reverse_f3_bereinigungs_batches'::regclass AND contype IN('p','f') ORDER BY contype")).rows;
 same(constraints,[
  {contype:'f',def:'FOREIGN KEY (eintrag_id) REFERENCES reverse_eintraege(id) ON DELETE RESTRICT'},
  {contype:'p',def:'PRIMARY KEY (eintrag_id, manifest_sha256, batch_nr)'}
 ],'f3_schema145_abweichend');
 const unsafe=(await db.query("SELECT tgname FROM pg_trigger WHERE tgrelid='reverse_f3_bereinigungs_batches'::regclass AND NOT tgisinternal UNION ALL SELECT conname FROM pg_constraint WHERE contype='f' AND confrelid='reverse_f3_bereinigungs_batches'::regclass")).rows;
 if(unsafe.length)stop('f3_journal_nebenwirkung');
}
async function dependencyGuard(db,kind,ops,projectedSymbols=null){
 phase('abhaengigkeiten');
 if(!ops.length)return;
 if(kind==='symbol'){
  const ids=ops.map(x=>x.id);
  if((await db.query("SELECT 1 FROM reverse_code_symbole WHERE parent_symbol=ANY($1::text[]) UNION ALL SELECT 1 FROM reverse_code_verweise WHERE symbol_id=ANY($1::text[]) UNION ALL SELECT 1 FROM reverse_code_kanten WHERE target_symbol_id=ANY($1::text[]) LIMIT 1",[ids])).rows.length)stop('f3_abhaengigkeit_stop');
 }else{
  const paths=ops.map(x=>x.file.path);
  if(projectedSymbols===null){
   if((await db.query("SELECT 1 FROM reverse_code_symbole WHERE eintrag_id=$1 AND file_path=ANY($2::text[]) LIMIT 1",[ENTRY,paths])).rows.length)stop('f3_abhaengigkeit_stop');
  }else{
   if(ops.length!==1)stop('f3_abhaengigkeit_stop');
   const n=(await db.query("SELECT count(*)::text AS n FROM reverse_code_symbole WHERE eintrag_id=$1 AND file_path=$2",[ENTRY,paths[0]])).rows[0].n;
   if(BigInt(n)!==BigInt(projectedSymbols))stop('f3_abhaengigkeit_stop');
  }
  if((await db.query("SELECT 1 FROM reverse_code_verweise WHERE eintrag_id=$1 AND file_path=ANY($2::text[]) UNION ALL SELECT 1 FROM reverse_code_statements WHERE eintrag_id=$1 AND file_path=ANY($2::text[]) UNION ALL SELECT 1 FROM reverse_code_kanten WHERE eintrag_id=$1 AND file_path=ANY($2::text[]) LIMIT 1",[ENTRY,paths])).rows.length)stop('f3_abhaengigkeit_stop');
 }
}
async function absent(db,ops){
 for(const kind of ['symbol','file']){
  const own=ops.filter(x=>x.kind===kind);if(!own.length)continue;
  const table=kind==='symbol'?'reverse_code_symbole':'reverse_code_dateien';
  if((await db.query('SELECT 1 FROM '+table+' WHERE eintrag_id=$1 AND id=ANY($2::text[]) LIMIT 1',[ENTRY,own.map(x=>x.id)])).rows.length)stop('f3_journal_daten_widerspruch');
 }
}
async function deleteBatch(db,ops,{beforeDelete}={}){
 const fs=new Map(ops.map(x=>[x.file.id,x.file]));
 const rows=(await db.query('SELECT '+cols+' FROM reverse_code_dateien c JOIN reverse_dateien d ON d.id=c.datei_id AND d.eintrag_id=c.eintrag_id WHERE '+eligible+' AND c.id=ANY($3::text[]) ORDER BY c.id FOR UPDATE OF c,d',[ENTRY,FORMATS,[...fs.keys()]])).rows;
 if(rows.length!==fs.size)stop('f3_quelle_geaendert');
 for(const r of rows)same(file(r),fs.get(r.id),'f3_quelle_geaendert');
 for(const kind of ['symbol','file']){
  const own=ops.filter(x=>x.kind===kind);if(!own.length)continue;
  const table=kind==='symbol'?'reverse_code_symbole':'reverse_code_dateien';
  if(kind==='symbol'){
   const rows=(await db.query("SELECT id,file_path,datei_id::text,schicht,parser_generation_id,to_jsonb(s)::text AS raw FROM reverse_code_symbole s WHERE eintrag_id=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE",[ENTRY,own.map(x=>x.id)])).rows;
   const by=new Map(rows.map(x=>[x.id,x]));
   for(const x of own){
    const r=by.get(x.id);
    if(!r||r.file_path!==x.file.path||r.datei_id!==x.file.source_id||r.schicht!=='S1'||r.parser_generation_id!==null||sha(r.raw)!==x.hash||Buffer.byteLength(r.raw)!==x.row_bytes)stop('f3_symbol_geaendert');
   }
  }
  await dependencyGuard(db,kind,own);
  await beforeDelete?.({db,kind,ops:own});
  const targets=own.map(x=>({id:x.id,path:x.file.path,source:x.file.source_id}));
  const result=await db.query('DELETE FROM '+table+" s USING jsonb_to_recordset($2::jsonb) x(id text,path text,source bigint) WHERE s.eintrag_id=$1 AND s.id=x.id AND s.file_path=x.path AND s.datei_id=x.source AND s.schicht='S1' AND s.parser_generation_id IS NULL RETURNING s.id",[ENTRY,JSON.stringify(targets)]);
  same(result.rows.map(x=>x.id).sort(),own.map(x=>x.id).sort(),'f3_loeschmenge_geaendert');
 }
}
/** lines() must reopen the same reviewed immutable stream. CLI pins its open FD.
 * Fault hooks are library-only, not exposed as command-line mutation controls.
 */

export function pruefeZwischenIntervall(n,batches){
 if(!Number.isSafeInteger(n)||n<0||n>batches)stop('f3_zwischen_budget');
 return n;
}
export async function applyManifest(pool,{lines,expected,backup,beforeDelete,afterDelete,afterCommit,onBatch,zwischenSentinelBatches=0}){
 return diagnosed(async()=>{
 pool=observed(pool);phase('manifest_pruefen');
 if(typeof backup!=='string'||backup.trim().length<8)stop('f3_sicherungsbeleg_fehlt');
 const {header:h,proofs}=await verifyManifest(lines,expected,backup);
 const zwischen=pruefeZwischenIntervall(zwischenSentinelBatches,proofs.length);
 const lock=await pool.connect();let held=false,committed=0,resumed=0,number=0;
 const intermediate=async(db,index)=>{
  if(zwischen>0&&(index+1)%zwischen===0&&index+1<proofs.length)await checkProjects(db,h);
 };
 try{
  held=(await lock.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok',['p18-t97-f3:'+ENTRY])).rows[0].ok;
  if(!held)stop('f3_bereinigung_laeuft');
  await journalGuard(lock);await quiet(lock);same(await settings(lock),h.settings,'f3_einstellungen_geaendert');
  await checkCatalog(lock,h);
  await checkProjects(lock,h); // FULL gate 1: once before any batch, including resume.
  for await(const ops of batches(lines,h,backup)){
   if(hash(ops)!==proofs[number])stop('f3_manifest_batch_geaendert');
   const evidence=payload(h,expected,number,ops,backup,zwischen),c=await pool.connect();let done=false;
   try{
    await c.query('BEGIN ISOLATION LEVEL READ COMMITTED');await deadlines(c,h.settings);
    await c.query("SELECT pg_advisory_xact_lock_shared(hashtext('reverse-pipeline-halt'))");
    await quiet(c);same(await settings(c),h.settings,'f3_einstellungen_geaendert');await journalGuard(c);
    // Reverse-only writer barriers cover both catalog checks and all explicit deletes.
    const schema=(await c.query('SELECT current_schema() AS s')).rows[0].s;
    await c.query('LOCK TABLE '+CODE_TABLES.map(t=>ident(schema)+'.'+ident(t)).join(',')+' IN SHARE ROW EXCLUSIVE MODE');
    await checkCatalog(c,h);
    const old=(await c.query("SELECT eintrag_id,manifest_sha256,batch_nr::text,batch_sha256,ops,delta,backup_beleg,projekt_sentinel_sha256,einstellungen_revision FROM reverse_f3_bereinigungs_batches WHERE eintrag_id=$1 AND manifest_sha256=$2 AND batch_nr=$3 FOR UPDATE",[ENTRY,expected,String(number)])).rows[0];
    if(old){
     same(old,evidence,'f3_journal_konflikt');await absent(c,ops);
     await c.query('ROLLBACK');resumed++;await intermediate(c,number);number++;continue;
    }
    await deleteBatch(c,ops,{beforeDelete});await afterDelete?.({db:c,batch:number,ops});
    await quiet(c);same(await settings(c),h.settings,'f3_einstellungen_geaendert');
    const cost=batchCost({...h,backup},ops);
    if(cost.rows>h.settings.rows||cost.bytes>h.settings.maxBytes)stop('f3_tx_budget');
    await c.query("INSERT INTO reverse_f3_bereinigungs_batches(eintrag_id,manifest_sha256,batch_nr,batch_sha256,ops,delta,backup_beleg,projekt_sentinel_sha256,einstellungen_revision) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)",
     [ENTRY,expected,String(number),evidence.batch_sha256,JSON.stringify(ops),JSON.stringify(evidence.delta),backup,evidence.projekt_sentinel_sha256,h.settings.revision]);
    await checkCatalog(c,h); // Cheap OID/FK/trigger gate; no full project scan here.
    phase('commit');await c.query('COMMIT');done=true;committed++;
    await afterCommit?.({batch:number});
    await intermediate(c,number);
    await onBatch?.({batch:number,manifest:expected,delta:evidence.delta,cost});
    number++;
   }catch(e){
    capture(e);if(!done)await c.query('ROLLBACK').catch(()=>{});
    e.committed_batches=committed;e.resumed_batches=resumed;throw e;
   }finally{c.release();}
  }
  const count=(await lock.query('SELECT count(*)::text AS n FROM reverse_f3_bereinigungs_batches WHERE eintrag_id=$1 AND manifest_sha256=$2',[ENTRY,expected])).rows[0].n;
  if(number!==proofs.length||BigInt(count)!==BigInt(number))stop('f3_journal_konflikt');
  await checkCatalog(lock,h);
  // FULL gate 2: after the LAST COMMIT. A mismatch is an explicit alarm, never success.
  try{
   const final=await projectSentinel(lock,h.sentinel);phase('endbilanz');
   same(final,h.projects,'f3_projektbestand_geaendert');
  }catch(e){e.alarm=true;e.committed_batches=committed;e.resumed_batches=resumed;throw e;}
  return {status:'fertig',manifest:expected,committed_batches:committed,resumed_batches:resumed,projekte_unveraendert:true,
   pruefungen:{vollsentinel_alle_batches:zwischen,regulaere_vollpruefungen:2},katalog_sha256:h.katalog_sha256};
 }catch(e){e.committed_batches??=committed;e.resumed_batches??=resumed;capture(e);throw e;}finally{
  try{if(held)await lock.query('SELECT pg_advisory_unlock(hashtext($1))',['p18-t97-f3:'+ENTRY]);}finally{lock.release();}
 }
});
}
/** Bounded JSONL reader: never collect all symbol IDs or unbounded lines in RAM. */
export async function* fileLines(handle,max){
 let offset=0,rest=Buffer.alloc(0);
 for(;;){
  const block=Buffer.alloc(Math.min(max+1,65536)),r=await handle.read(block,0,block.length,offset);
  if(!r.bytesRead)break;offset+=r.bytesRead;rest=Buffer.concat([rest,block.subarray(0,r.bytesRead)]);
  for(;;){const i=rest.indexOf(10);if(i<0)break;if(i+1>max)stop('f3_manifest_record_zu_gross');
   yield rest.subarray(0,i+1).toString('utf8');rest=rest.subarray(i+1);}
  if(rest.length>max)stop('f3_manifest_record_zu_gross');
 }
 if(rest.length)stop('f3_manifest_fragment');
}
async function auditPath(filename,forbidden){
 const dir=await realpath(path.dirname(path.resolve(filename)));
 for(const root of forbidden.filter(Boolean)){
  const r=path.resolve(root);let real=r;try{real=await realpath(r);}catch(e){if(e.code!=='ENOENT')throw e;}
  if([r,real].some(x=>dir===x||dir.startsWith(x+path.sep)))stop('f3_belegpfad_verboten');
 }
 return {dir,file:path.join(dir,path.basename(filename))};
}
export async function main(argv=process.argv.slice(2)){
 return diagnosed(async()=>{
 const a={};for(let i=0;i<argv.length;i++){
  const k=argv[i];if(!['--eintrag','--manifest','--manifest-sha256','--backup-beleg','--ausfuehren','--sentinel-timeout-ms','--vollsentinel-alle-batches'].includes(k)||Object.hasOwn(a,k))stop('f3_parameter');
  a[k]=k==='--ausfuehren'?true:argv[++i];if(a[k]===undefined||a[k]==='')stop('f3_parameter');
 }
 if(a['--eintrag']!==ENTRY)stop('f3_eintrag_nicht_freigegeben');
 const {getAssetKonfiguration}=await import('@synapse/core'),cfg=getAssetKonfiguration();
 const forbidden=[cfg.speicher.root,cfg.speicher.reverseRoot,fileURLToPath(new URL('../../..',import.meta.url))];
 const {Pool}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
 if(!process.env.DATABASE_URL)stop('f3_datenbank_fehlt');
 if(a['--vollsentinel-alle-batches']!==undefined&&(!a['--ausfuehren']||!/^(0|[1-9][0-9]*)$/.test(a['--vollsentinel-alle-batches'])))stop('f3_zwischen_budget');
 const zwischenSentinelBatches=Number(a['--vollsentinel-alle-batches']??0);
 const pool=observed(new Pool({connectionString:process.env.DATABASE_URL}));
 if(a['--sentinel-timeout-ms']!==undefined&&!/^[1-9][0-9]*$/.test(a['--sentinel-timeout-ms']))stop('f3_sentinel_budget');
 const sentinelTimeoutMs=a['--sentinel-timeout-ms']===undefined?undefined:Number(a['--sentinel-timeout-ms']);
 if(sentinelTimeoutMs!==undefined)sentinelPolicy({statement:sentinelTimeoutMs},sentinelTimeoutMs);
 if(a['--ausfuehren']&&sentinelTimeoutMs!==undefined)stop('f3_sentinel_im_manifest_gepinnt');
 try{
  if(!a['--ausfuehren']){
   let out;
   try{
    if(a['--manifest']){
     phase('audit_open');const p=await auditPath(a['--manifest'],forbidden);
     out=await open(p.file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    }
    const result=await createManifest(pool,async raw=>{if(out)await out.writeFile(raw);},{sentinelTimeoutMs});
    phase('manifest_sync');if(out){await out.chmod(0o444);await out.sync();}
    console.log(JSON.stringify({status:'dry-run',...result}));return;
   }catch(e){capture(e);throw e;}finally{await out?.close();}
  }
  if(!a['--manifest'])stop('f3_manifest_fehlt');
  const p=await auditPath(a['--manifest'],forbidden),input=await open(p.file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const stat=await input.stat({bigint:true});
   if(!stat.isFile()||stat.nlink!==1n||(Number(stat.mode)&0o222)!==0)stop('f3_manifest_nicht_versiegelt');
   const s=await settings(pool),fingerprint=st=>[String(st.ino),String(st.dev),String(st.size),String(st.mtimeNs),String(st.ctimeNs)];
   const lines=async function*(){
    same(fingerprint(await input.stat({bigint:true})),fingerprint(stat),'f3_manifest_geaendert');
    yield* fileLines(input,s.recordBytes);
    same(fingerprint(await input.stat({bigint:true})),fingerprint(stat),'f3_manifest_geaendert');
   };
   console.log(JSON.stringify(await applyManifest(pool,{lines,expected:a['--manifest-sha256'],backup:a['--backup-beleg'],zwischenSentinelBatches,
    onBatch:row=>console.log(JSON.stringify({status:'batch_committed',...row}))})));
  }catch(e){capture(e);throw e;}finally{await input.close();}
 }catch(e){capture(e);throw e;}finally{await pool.end();}
 });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(e=>{console.error(JSON.stringify(failureDiagnostic(e)));process.exitCode=1;});
}
