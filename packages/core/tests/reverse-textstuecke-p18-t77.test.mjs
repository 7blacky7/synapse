/** REA1/RV14: real importer + reverse dispatcher. Only private schema in synapse_test:5433. */
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';process.env.SYNAPSE_REVERSE_BIS_SCHICHT='S3';
const temp=await mkdtemp(join(tmpdir(),'p18-t77-')),root=join(temp,'reverse');
Object.assign(process.env,{SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
await mkdir(join(root,'_arbeit'),{recursive:true});
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:3});
const schema='p18_t77_'+process.pid+'_'+randomUUID().slice(0,8),project='p18_t77',agent='p18_t77-agent',rid='rev-p18-t77';
const pool={async connect(){const c=await raw.connect();await c.query('SET search_path TO '+schema+',public');return c;},
 async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const sha=v=>createHash('sha256').update(v).digest('hex');
let checks=0,made=false;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;},ok=(v,m)=>{assert.ok(v,m);checks++;};
let pipeline;
try{
 await raw.query('CREATE SCHEMA '+schema);made=true;
 for(const table of ['projects','agent_sessions','tool_aktivitaet','code_files'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 const scoped=new URL(url);scoped.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=scoped.href;
 const core=await import('../dist/index.js');
 const {mitLesePool}=await import('../dist/db/client.js');
 const inDb=fn=>mitLesePool(pool,fn);
 const {REVERSE_VERKNUEPFUNGEN_SCHEMA_SQL}=await import('../dist/db/reverse-verknuepfungen-schema.js');
 for(const table of ['agent_profil_schalter','intern_schalter'])await pool.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 const {leseReverseEinstellungen,fuehreReverseAdminAus}=await import('../dist/services/reverse-einstellungen.js');
 const admin=args=>inDb(()=>fuehreReverseAdminAus({project,...args},{art:'user'}));
 const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
 const {REVERSE_PIPELINE_SCHEMA_SQL}=await import('../dist/db/reverse-pipeline-schema.js');
 await pool.query(REVERSE_SCHEMA_SQL);
 // P18-T86: Einstellungsschema erst nach reverse_eintraege, sonst zeigt der Eintrags-FK auf public.reverse_eintraege.
 await pool.query(REVERSE_VERKNUEPFUNGEN_SCHEMA_SQL);
 // P18-T84: current schema for origin filters; no production migration from this fixture.
 await pool.query((await import('../dist/db/hex-formate-schema.js')).HEX_FORMATE_SCHEMA_SQL);
 await pool.query((await import('../dist/db/reverse-erkenntnisse-schema.js')).REVERSE_ERKENNTNISSE_SCHEMA_SQL);await pool.query(REVERSE_PIPELINE_SCHEMA_SQL);
 await pool.query((await import('../dist/db/reverse-einstellwerte-schema.js')).REVERSE_EINSTELLWERTE_SCHEMA_SQL);
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_t77',true)",[project]);
 await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active')",[agent,project]);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T77 fixture','bestaetigt')",[rid]);
 const mid=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status) VALUES($1,0,'image','vollstaendig') RETURNING id::text id",[rid])).rows[0].id;
 await pool.query("UPDATE reverse_eintraege SET analyse_policy=$2::jsonb WHERE id=$1",[rid,JSON.stringify({automatisch:false})]);
 const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
 pipeline=new core.ReversePipelineDienst({pool,konfiguration:cfg,ausfuehrbareKinds:[]});
 const service=core.createReverseToolService({pool,runtime:{containerStatus:async()=>({zustand:'ruht',kaltstart_s:null}),analysieren:(a,db)=>pipeline.analysieren(a,db)}});
 const binding=await service.ausfuehren({action:'binden',project,agent_id:agent,reverse_id:rid});ok(binding.success,'binding');
 const call=(action,args={})=>inDb(()=>service.ausfuehren({action,project,agent_id:agent,reverse_id:rid,...args}));
 const prepare=async(name,text,maxPgBytes,sidecars)=>{
  const did=(await pool.query("INSERT INTO reverse_dateien(eintrag_id,medium_id,pfad,sha256,groesse,art,status,format,arch,bits) VALUES($1,$2,$3,$4,1,'binaer','fertig','pe','x86',32) RETURNING id::text id",[rid,mid,name,sha(name)])).rows[0].id;
  const job=randomUUID(),fp=sha(name+job),work=join(root,'_arbeit',job);
  await pool.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,prioritaet,status,ausloeser,ausfuehrung,fingerabdruck,ziel_schicht,projekt,werkzeug,werkzeug_version,profil_version) VALUES($1,$2,$3,'S3','interaktiv','wartet','fixture','container',$4,'S3',$5,'reverse-S3','fixture','fixture')",[job,rid,did,fp,project]);
  await mkdir(work);await writeFile(join(work,'functions.jsonl'),text);
  const e={jobId:job,reverseId:rid,dateiId:did,arbeitsWurzel:work,manifest:[{pfad:'functions.jsonl',sha256:sha(text),groesse:Buffer.byteLength(text)}]};
  if(sidecars){
   await pool.query("INSERT INTO reverse_schichten(datei_id,schicht,fingerabdruck,aktuell,status,werkzeug) VALUES($1,'S1',$2,true,'fertig','fixture')",[did,sha('s1:'+name)]);
   for(const [p,content]of Object.entries(sidecars)){
    await writeFile(join(work,p),content);e.manifest.push({pfad:p,sha256:sha(content),groesse:Buffer.byteLength(content)});
   }
  }
  const result=await inDb(()=>tx(db=>core.uebernehmeS3Ergebnis(db,e,maxPgBytes===undefined?{}:{maxPgBytes})));
  return {did,e,result,name};
 };
 const row=(name,address,decompiled,extra={})=>({name,address_offset:address,size:16,prototype:'void '+name+'()',decompile_status:'ok',decompiled,...extra});
 const lines=['void Large() {','Firstanchor();',...Array.from({length:8000},(_,i)=>'value_'+i+' = padding_value + padding_other_value;'),'LateNeedle();','}'];
 const huge=row('Large',4096,lines.join('\n'),{callees:[{name:'Small',address_offset:8192}],references:[{name:'asset_string',address_offset:30000,from_offset:5000,kind:'string',value:'gfx/late.png'}]});
 const f=await prepare('large.exe',[huge,row('Small',8192,'void Small() {}')].map(x=>JSON.stringify(x)).join('\n')+'\n');
 eq(f.result.status,'fertig','large function fully stored');
 eq([f.result.gespeichert,f.result.verworfen],[2,0],'no dropped function');
 const parts=(await pool.query("SELECT file_path,logischer_pfad,teil_nr,zeilen_offset,content,file_size FROM reverse_code_dateien WHERE datei_id=$1 AND file_type='c' ORDER BY file_path",[f.did])).rows;
 ok(parts.length>2,'large function has several physical pieces');
 ok(parts.every(p=>Buffer.byteLength(p.content)<=262144),'every physical piece fits FTS budget');
 const logical=parts[0].file_path,largeParts=parts.filter(p=>p.logischer_pfad===logical);
 eq(largeParts.map(p=>p.teil_nr),largeParts.map((_,i)=>i),'piece order');
 const full=largeParts.map(p=>p.content).join(''),boundary=largeParts[1].zeilen_offset+1;
 const view=await call('file',{file_path:logical,from_line:boundary-1,to_line:boundary+1});
 ok(view.success,JSON.stringify(view));eq(view.content,full.split('\n').slice(boundary-2,boundary+1).join('\n'),'logical line window across physical boundary');
 const search=await call('search',{query:'LateNeedle',file_path:'large.exe@S3'});
 ok(search.success,JSON.stringify(search));eq(search.results.length,1,'search continuation once');
 eq(search.results[0].file_path,logical,'search logical path');
 ok(JSON.stringify(search.results[0]).includes(String(lines.length)),'search reports global line');
 const both=await call('search',{query:'Firstanchor LateNeedle',file_path:'large.exe@S3'});eq(both.results.length,1,'AND terms cross pieces without giant tsvector');
 const firstHit=(await pool.query("SELECT content ILIKE '%LateNeedle%' hit FROM reverse_code_dateien WHERE file_path=$1 AND eintrag_id=$2",[logical,rid])).rows[0].hit;
 eq(firstHit,false,'search marker absent from first physical piece');
 ok(largeParts.slice(1).some(p=>p.content.includes('LateNeedle')),'search marker only in a continuation');
 // Shared reader also preserves global lines of already indexed references/literals in a continuation.
 await pool.query("INSERT INTO reverse_code_symbole(id,eintrag_id,file_path,symbol_type,name,value,line_start,line_end,datei_id,schicht,fingerabdruck) SELECT $1,eintrag_id,$2,'string','LateNeedle','LateNeedle',$3,$3,datei_id,schicht,fingerabdruck FROM reverse_code_dateien WHERE eintrag_id=$4 AND file_path=$2",[sha('late-literal'),logical,lines.length,rid]);
 const refs=await call('references',{name:'LateNeedle',file_path:'large.exe@S3'});ok(refs.success&&JSON.stringify(refs).includes(logical),'references see second piece');eq(refs.string_occurrences[0].line_number,lines.length,'reference global line in continuation');
 const calls=await call('calls',{file_path:'large.exe@S3'});ok(calls.success&&calls.calls[0].target_symbol_id,'call graph remains resolved');
 eq(calls.calls[0].file_path,logical,'source header uses logical file');
 const tree=await call('tree',{file_path:'large.exe@S3'});
 ok(!tree.baum.includes(largeParts[1].file_path.split('/').at(-1)),'tree hides continuation pieces');
 const unicode='界'.repeat(120000);
 const u=await prepare('unicode.exe',JSON.stringify(row('Unicode',12288,'void Unicode() { char *x="'+unicode+'"; UtfEnd(); }'))+'\n');
 eq(u.result.status,'fertig','giant Unicode line accepted');
 const up=(await pool.query("SELECT content FROM reverse_code_dateien WHERE datei_id=$1 AND file_type='c' ORDER BY teil_nr",[u.did])).rows;
 ok(up.length>=2&&!up.some(p=>p.content.includes('\ufffd')),'UTF-8 boundaries intact');
 ok(up.map(p=>p.content).join('').includes(unicode),'giant single line exact');
 const asm='00004000 MOV EAX,EBX\n'.repeat(60000);
 const a=await prepare('asm.exe',JSON.stringify(row('Assembly',16384,'',{decompile_status:'forced error',assembly:asm}))+'\n');
 eq(a.result.status,'teilweise','assembly fallback is honestly partial decompilation');
 const ap=(await pool.query("SELECT file_path,logischer_pfad,content FROM reverse_code_dateien WHERE datei_id=$1 AND file_type='asm' ORDER BY teil_nr",[a.did])).rows;
 ok(ap.length>4,'assembly over 1MB split');eq(ap.map(p=>p.content).join(''),asm,'assembly exact');
 const av=await call('file',{file_path:ap[0].file_path,from_line:59999,to_line:60000});ok(av.success&&av.content.includes('MOV EAX,EBX'),'assembly logical paging');
 const budgetRows=Array.from({length:3},(_,i)=>row('Missing'+i,20000+i*16,'void Missing'+i+'(){ '+('v = 1; '.repeat(1000))+'}'));
 const b=await prepare('budget.exe',budgetRows.map(x=>JSON.stringify(x)).join('\n')+'\n',1);
 eq(b.result.gespeichert,0,'small budget stores no orphan graph');
 const status1=await call('status',{datei:'budget.exe',limit:1});ok(status1.success,JSON.stringify(status1));
 eq(status1.s3_speicher.fehlende_funktionen.map(x=>x.name),['Missing0'],'exact missing list');
 eq([status1.s3_speicher.fehlend_datei_gesamt,status1.s3_speicher.naechster_offset],[3,1],'missing page count and cursor');
 const status2=await call('status',{datei:'budget.exe',limit:2,offset:1});eq(status2.s3_speicher.fehlende_funktionen.map(x=>x.name),['Missing1','Missing2'],'missing list completes');
 ok(status1.s3_speicher.verbrauch_bytes>0&&status1.s3_speicher.artefakt_vorhanden,'entry consumption and retained artifact visible');
 const denied=await call('analysieren',{datei:'budget.exe',bis_schicht:'S3'});eq(denied.fehlercode,'kein_ausfuehrer','product OFF prevents resume');
 await pool.query("INSERT INTO agent_profil_schalter(ebene,project,funktion,aktiv,grund,gesetzt_von) VALUES('projekt',$1,'reverse_s3',true,'T77 fixture','fixture')",[project]);
 let settings=await inDb(()=>leseReverseEinstellungen(project));eq(settings.werte.s3_pg_budget_bytes.wert,1073741824,'default 1GiB');
 // P18-T86: s3_pg_budget_bytes ist ein Eintragswert (GE), kein Projektwert mehr.
 {const a=await admin({modus:'setzen',ebene:'eintrag',reverse_id:rid,reverse_werte:{s3_pg_budget_bytes:1500000000},grund:'T77 budget increase'});ok(a.success,'budget writable through admin '+JSON.stringify(a).slice(0,600));}
 settings=await inDb(()=>leseReverseEinstellungen(project,undefined,rid));eq(settings.werte.s3_pg_budget_bytes.quelle,'eintrag','budget source visible');
 const queued=await call('analysieren',{datei:'budget.exe',bis_schicht:'S3'});ok(queued.success&&queued.nachzug,JSON.stringify(queued));
 const duplicate=await call('analysieren',{datei:'budget.exe',bis_schicht:'S3'});eq(duplicate.auftrag_id,queued.auftrag_id,'active resume deduplicated');
 const job=await inDb(()=>pipeline.claim());eq(job.id,queued.auftrag_id,'normal API worker claims resume');
 await inDb(()=>pipeline.bearbeite(null,job));
 const state=(await pool.query("SELECT status,p20_auftrag_id,werkzeug FROM reverse_auftraege WHERE id=$1",[job.id])).rows[0];
 eq([state.status,state.p20_auftrag_id,state.werkzeug],['fertig',null,'reverse-S3-nachzug'],'resume completes without runner/P20');
 const after=await call('status',{datei:'budget.exe'});eq([after.status,after.s3_speicher.fehlend_datei_gesamt],['fertig',0],'same retained artifact completes all functions');
 eq((await pool.query("SELECT count(*)::int n FROM reverse_code_symbole WHERE datei_id=$1 AND symbol_type='function' AND schicht='S3'",[b.did])).rows[0].n,3,'all missing functions restored');
 const audit=await admin({modus:'status'});ok(audit.success&&audit.verbrauch.verbrauch_bytes>0,'admin consumption');
 const changed=await prepare('changed.exe',JSON.stringify({...huge,decompiled:huge.decompiled.replace('LateNeedle();','ChangedInContinuation();')})+'\n');
 const largeId=(await pool.query("SELECT id FROM reverse_code_symbole WHERE datei_id=$1 AND name='Large' AND symbol_type='function'",[f.did])).rows[0].id;
 const diff=await call('vergleichen',{datei_a:'large.exe',datei_b:'changed.exe',funktion:largeId});
 ok(diff.success,JSON.stringify(diff));ok(diff.diff.some(x=>x.text.includes('LateNeedle'))&&diff.diff.some(x=>x.text.includes('ChangedInContinuation')),'comparison reads actual continuation difference');
 const stale=await prepare('stale.exe',JSON.stringify(row('Stale',25000,'void Stale(){}'))+'\n',1);
 await pool.query("UPDATE reverse_dateien SET metadaten=jsonb_set(metadaten,'{s3_artefakt,sha256}',to_jsonb($2::text)) WHERE id=$1",[stale.did,'0'.repeat(64)]);
 const staleReply=await call('analysieren',{datei:'stale.exe',bis_schicht:'S3'});ok(!staleReply.nachzug,'stale artifact falls through to normal pipeline');
 ok(!(await pool.query("SELECT metadaten ? 's3_artefakt' kept FROM reverse_dateien WHERE id=$1",[stale.did])).rows[0].kept,'stale artifact unbound');
 await pool.query("UPDATE reverse_auftraege SET status='abgebrochen' WHERE datei_id=$1 AND status='wartet'",[stale.did]);
 const missing=await prepare('missing.exe',JSON.stringify(row('MissingArtifact',26000,'void MissingArtifact(){}'))+'\n',1);
 await rm(missing.e.arbeitsWurzel,{recursive:true,force:true});
 const missingReply=await call('analysieren',{datei:'missing.exe',bis_schicht:'S3'});ok(missingReply.nachzug,'filesystem checked by worker outside tool transaction');
 const missingJob=await inDb(()=>pipeline.claim());eq(missingJob.id,missingReply.auftrag_id,'missing artifact claim');
 await inDb(()=>pipeline.bearbeite(null,missingJob));
 ok(!(await pool.query("SELECT metadaten ? 's3_artefakt' kept FROM reverse_dateien WHERE id=$1",[missing.did])).rows[0].kept,'missing artifact unbound by worker');
 const retry=await call('analysieren',{datei:'missing.exe',bis_schicht:'S3'});ok(!retry.nachzug&&retry.auftrag_id!==missingJob.id,'missing artifact allows fresh normal request');
 eq((await pool.query("SELECT status FROM reverse_auftraege WHERE id=$1",[missingJob.id])).rows[0].status,'fehler','failed resume not resurrected');
 if(process.env.P18_T77_REAL_JSONL){
  const input=process.env.P18_T77_REAL_JSONL,sidecars={};
  for(const name of ['s1-rz-strings.json','s1-rz-imports.json','s1-rz-symbols.json','normalisierer-status.json'])sidecars[name]=await readFile(join(dirname(input),name),'utf8');
  const started=Date.now(),real=await prepare('s3.ex_',await readFile(input,'utf8'),undefined,sidecars);
  eq([real.result.status,real.result.funktionen,real.result.dekompiliert,real.result.gespeichert,real.result.verworfen],['fertig',20680,20680,20680,0],'real s3.ex_ all functions');
  for(const name of ['FUN_004e9670','FUN_00524fa0']){
   const symbol=(await pool.query("SELECT file_path,line_start,line_end FROM reverse_code_symbole WHERE datei_id=$1 AND name=$2",[real.did,name])).rows[0];ok(symbol,'real oversized symbol '+name);
   const tail=await call('file',{file_path:symbol.file_path,from_line:symbol.line_end-1,to_line:symbol.line_end});ok(tail.success&&tail.content.length>0,'real oversized tail '+name);
  }
  console.log('T77_REAL '+JSON.stringify({result:real.result,ms:Date.now()-started}));
 }
 console.log('T77 PASS '+checks+' checks: chunking, logical paging, search/references, UTF8, ASM, settings, exact missing pages and worker resume without Ghidra');
}finally{
 await pipeline?.beende();
 if(made)await raw.query('DROP SCHEMA '+schema+' CASCADE');
 await raw.end();await rm(temp,{recursive:true,force:true});
}
