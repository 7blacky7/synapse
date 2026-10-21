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
const temp=await mkdtemp(join(tmpdir(),'p18-rea1-')),root=join(temp,'reverse');
Object.assign(process.env,{SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:root});
await mkdir(join(root,'_arbeit'),{recursive:true});
const {Pool}=createRequire(new URL('../package.json',import.meta.url))('pg');
const raw=new Pool({connectionString:url.href,max:3});
const schema='p18_rea1_'+process.pid+'_'+randomUUID().slice(0,8),project='p18_rea1',agent='p18_rea1-agent',rid='rev-p18-rea1';
const pool={async connect(){const c=await raw.connect();await c.query('SET search_path TO '+schema+',public');return c;},
 async query(...a){const c=await this.connect();try{return await c.query(...a);}finally{c.release();}}};
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
const sha=v=>createHash('sha256').update(v).digest('hex');
let checks=0,made=false;
const eq=(a,b,m)=>{assert.deepEqual(a,b,m);checks++;},ok=(v,m)=>{assert.ok(v,m);checks++;};
const secret='SyntheticSecret987654321';
try{
 await raw.query('CREATE SCHEMA '+schema);made=true;
 for(const table of ['projects','agent_sessions','tool_aktivitaet','code_files'])await pool.query('CREATE TABLE '+schema+'.'+table+' (LIKE public.'+table+' INCLUDING DEFAULTS INCLUDING INDEXES)');
 const core=await import('../dist/index.js');
 const {mitLesePool}=await import('../dist/db/client.js');
 const {REVERSE_SCHEMA_SQL}=await import('../dist/db/reverse-schema.js');
 const {REVERSE_PIPELINE_SCHEMA_SQL}=await import('../dist/db/reverse-pipeline-schema.js');
 await pool.query(REVERSE_SCHEMA_SQL);
 // P18-T84: current schema for origin filters; no production migration from this fixture.
 await pool.query((await import('../dist/db/hex-formate-schema.js')).HEX_FORMATE_SCHEMA_SQL);
 await pool.query((await import('../dist/db/reverse-erkenntnisse-schema.js')).REVERSE_ERKENNTNISSE_SCHEMA_SQL);await pool.query(REVERSE_PIPELINE_SCHEMA_SQL);
 for(const [t,c]of [['reverse_eintraege','creator_identity_id'],['reverse_eintraege','confirmer_identity_id'],['reverse_bindungen','binder_identity_id'],['reverse_auftraege','trigger_identity_id']])await pool.query('ALTER TABLE '+t+' ADD COLUMN IF NOT EXISTS '+c+' TEXT');
 await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'fixture','/synthetic/p18_rea1',true)",[project]);
 await pool.query("INSERT INTO agent_sessions(id,project,status) VALUES($1,$2,'active')",[agent,project]);
 await pool.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'REA fixture','bestaetigt')",[rid]);
 const mid=(await pool.query("INSERT INTO reverse_medien(eintrag_id,position,art,status) VALUES($1,0,'image','vollstaendig') RETURNING id::text id",[rid])).rows[0].id;
 const service=core.createReverseToolService({pool,runtime:{containerStatus:async()=>({zustand:'ruht',kaltstart_s:null}),analysieren:async()=>({status:'wartet',auftrag_id:randomUUID()})}});
 const binding=await service.ausfuehren({action:'binden',project,agent_id:agent,reverse_id:rid});ok(binding.success,'binding');
 const call=(action,args={})=>service.ausfuehren({action,project,agent_id:agent,reverse_id:rid,...args});
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
  const result=await mitLesePool(pool,()=>tx(db=>core.uebernehmeS3Ergebnis(db,e,maxPgBytes===undefined?{}:{maxPgBytes})));
  return {did,e,result,name};
 };
 const rows=[
  {name:'entry',address_offset:4096,size:32,prototype:'int entry(void)',decompiled:'int entry(void) {\n return Worker();\n}',decompile_status:'ok',
   callees:[{name:'Worker',address_offset:8192},{name:'Broken',address_offset:12288},{name:'MessageBoxA',address_offset:12288,external:true}],
   references:[{name:'s_return_png',address_offset:24576,from_offset:4100,kind:'string',value:'return.png\r\nnext'},
    {name:'s_config_ini',address_offset:24592,from_offset:4104,kind:'string',value:'config.ini'},
    {name:'s_secret',address_offset:24608,from_offset:4108,kind:'string',value:'password = "'+secret+'"'},
    {name:'MessageBoxA',address_offset:16384,from_offset:4112,kind:'import',value:'USER32.dll!MessageBoxA'}]},
  {name:'Worker',address_offset:8192,size:16,prototype:'int Worker(void)',decompiled:'int Worker(void) {\n return 7;\n}',decompile_status:'ok'},
  {name:'Broken',address_offset:12288,size:8,prototype:'int Broken(void)',decompiled:'',decompile_status:'forced fixture error',assembly:'00003000  PUSH EBP\n00003001  MOV EBP,ESP\n00003003  RET\n',
   callees:[{name:'Worker',address_offset:8192}],references:[]},
 ];
 const f=await prepare('fixture.exe',rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 eq([f.result.status,f.result.funktionen,f.result.dekompiliert],['teilweise',3,2],'partial decompiler');
 let calls=await call('calls',{file_path:'fixture.exe@S3'});ok(calls.success,JSON.stringify(calls));eq(calls.total,4,'all graph edges');
 ok(calls.calls.some(c=>c.caller_scope==='entry'&&c.callee_name==='Worker'&&c.target_symbol_id),'resolved call');
 ok(calls.calls.some(c=>c.callee_name==='MessageBoxA'&&c.target_symbol_id===null&&c.callee_receiver==='EXTERNAL:0x00003000'&&c.call_kind==='import'),'EXTERNAL offset never links to S2 fallback function at same numeric address');
 ok(calls.calls.some(c=>c.callee_name==='Broken'&&c.target_symbol_id),'fallback target resolved to S2');
 const page=await call('calls',{file_path:'fixture.exe@S3',limit:1});eq([page.calls.length,page.gekappt,page.naechster_offset],[1,true,1],'paging');
 const page2=await call('calls',{file_path:'fixture.exe@S3',limit:1,offset:1});eq(page2.calls.length,1,'second page');
 const refs=await call('references',{file_path:'fixture.exe@S3',name:'s_return_png'});ok(refs.success,JSON.stringify(refs));eq(refs.total_references,1,'actual reference');
 ok(refs.references[0].context.includes('return.png\r\nnext'),'context preserves masked value');
 const defs=(await pool.query("SELECT name,line_start,value FROM reverse_code_symbole WHERE datei_id=$1 AND symbol_type='string' ORDER BY adresse",[f.did])).rows;
 eq(defs.slice(0,2).map(s=>[s.name,s.line_start]),[['s_return_png',1],['s_config_ini',2]],'two references have distinct real lines');
 const refFile=(await pool.query("SELECT content FROM reverse_code_dateien WHERE datei_id=$1 AND file_path LIKE '%/referenzen-%'",[f.did])).rows[0].content;
 ok(refFile.includes('return.png next\n')&&refFile.includes('config.ini\n'),'r/n are unchanged; CRLF flattened once');
 const asm=(await pool.query("SELECT file_path,content FROM reverse_code_dateien WHERE datei_id=$1 AND file_type='asm'",[f.did])).rows[0];
 ok(asm.file_path.includes('@S2/')&&asm.content.includes('PUSH EBP'),'fallback assembler');
 const asmView=await call('file',{file_path:asm.file_path});ok(asmView.success&&asmView.content.includes('PUSH EBP'),'S2 via dispatcher');
 eq((await pool.query("SELECT schicht FROM reverse_code_symbole WHERE datei_id=$1 AND name='Broken' AND symbol_type='function'",[f.did])).rows.map(x=>x.schicht),['S2'],'no duplicate fallback function');
 const dump=JSON.stringify((await pool.query("SELECT content FROM reverse_code_dateien WHERE datei_id=$1 UNION ALL SELECT value FROM reverse_code_symbole WHERE datei_id=$1 UNION ALL SELECT context FROM reverse_code_verweise WHERE datei_id=$1",[f.did])).rows);
 ok(!dump.includes(secret),'all PG text masked');ok(Number((await pool.query("SELECT metadaten->>'maskiert_anzahl' n FROM reverse_dateien WHERE id=$1",[f.did])).rows[0].n)>0,'mask counter');
 await mitLesePool(pool,()=>tx(db=>core.uebernehmeS3Ergebnis(db,f.e)));
 eq((await call('calls',{file_path:'fixture.exe@S3'})).total,4,'idempotent edges');
 eq((await pool.query("SELECT count(*)::int n FROM reverse_code_verweise WHERE datei_id=$1",[f.did])).rows[0].n,4,'idempotent refs');
 const bad={...f.e,jobId:randomUUID()};await assert.rejects(()=>tx(db=>core.uebernehmeS3Ergebnis(db,bad)),x=>x.code==='nicht_gefunden');checks++;
 const b=await prepare('budget.exe',JSON.stringify(rows[0])+'\n',1);eq(b.result.status,'teilweise','budget partial');eq(b.result.gespeichert,0,'no graph orphan when over budget');
 eq((await pool.query("SELECT count(*)::int n FROM reverse_code_kanten WHERE datei_id=$1",[b.did])).rows[0].n,0,'budget applies to graph too');
 const {normalisiereRzBin}=await import('../dist/services/reverse-normalisierer/rz-bin.js');
 const {normalisiereWasmObjdump}=await import('../dist/services/reverse-normalisierer/wasm-objdump.js');
 const {normalisiereJavap}=await import('../dist/services/reverse-normalisierer/javap.js');
 const {uebernehmeNormalisiert}=await import('../dist/services/reverse-normalisierer/s1.js');
 const budget={maxBytes:1048576,maxEintraege:1000};
 const rz=normalisiereRzBin({strings:JSON.stringify([{vaddr:123,string:'assets/game.dat'},{vaddr:124,string:'password = "'+secret+'"'}]),imports:[{name:'GetModuleHandleA',vaddr:256}],symbols:[{name:'Exported',vaddr:512,size:16}]},budget);
 eq(rz.dateiKandidaten,['assets/game.dat'],'RV30 candidates');ok(rz.maskiert>0&&!JSON.stringify(rz).includes(secret),'rz mask count');
 await tx(db=>uebernehmeNormalisiert(db,{reverseId:rid,dateiId:f.did,pfad:f.name,fingerabdruck:sha('S1')},rz));
 const wasm=normalisiereWasmObjdump('Import[1]:\n - func[0] sig=0 <env.print> <- env.print\n000010 func[1] <main>:\n 000011: 10 00 | call 0 <env.print>\n',budget);
 eq(wasm.dateien[0].kanten.map(k=>[k.caller,k.callee]),[['main','env.print']],'wasm calls');
 const javap=normalisiereJavap('public class Demo {\n  public static void main(java.lang.String[]);\n    Code:\n       0: invokestatic #1 // Method Helper.run:()V\n       3: return\n}\n',budget);
 const unnamed=normalisiereWasmObjdump('Export[1]:\n - func[2] -> "start"\n000010 func[2]:\n 000011: 10 03 | call 3\n',budget);
 eq(unnamed.dateien[0].symbole.filter(s=>s.art==='export').map(s=>s.name),['start'],'wasm -x export');
 eq(unnamed.dateien[0].symbole.filter(s=>s.art==='function').map(s=>s.name),['func_2'],'unnamed WASM function');
 eq(unnamed.dateien[0].kanten.map(k=>k.callee),['func_3'],'unnamed WASM call');
 const sidecars={'s1-rz-strings.json':JSON.stringify([{vaddr:16384,string:'assets/return.png'}]),'s1-rz-imports.json':JSON.stringify([{name:'RawImport',vaddr:16385}]),'s1-rz-symbols.json':JSON.stringify([{name:'RawExport',vaddr:16386,size:4}]),'normalisierer-status.json':JSON.stringify({status:'fertig'})};
 const native=await prepare('raw-native.exe',JSON.stringify(rows[1])+'\n',undefined,sidecars);
 eq((await pool.query("SELECT name FROM reverse_code_symbole WHERE datei_id=$1 AND schicht='S1' AND symbol_type='import'",[native.did])).rows.map(x=>x.name),['RawImport'],'manifest -> rz-bin -> PG production consumer');
 ok((await pool.query("SELECT target FROM reverse_verweise WHERE datei_id=$1 AND kind='string_datei'",[native.did])).rows.some(x=>x.target==='assets/return.png'),'raw RV30 candidates persisted');
 eq((await pool.query("SELECT metadaten->'normalisierer'->>'status' status FROM reverse_dateien WHERE id=$1",[native.did])).rows[0].status,'fertig','normalization diagnostic');
 const wasmInput='Export[1]:\n - func[2] -> "start"\n000010 func[2]:\n 000011: 10 03 | call 3\n';
 const wasmJob=await prepare('raw-wasm.wasm',JSON.stringify(rows[1])+'\n',undefined,{'s1-wasm.txt':wasmInput});
 ok((await pool.query("SELECT name FROM reverse_code_symbole WHERE datei_id=$1 AND name='start'",[wasmJob.did])).rows.length===1,'manifest -> wasm export -> PG');
 const javaJob=await prepare('raw-java.class',JSON.stringify(rows[1])+'\n',undefined,{'s1-javap.txt':'public class Demo {\n  public static void main(java.lang.String[]);\n    Code:\n       0: invokestatic #1 // Method Helper.run:()V\n}\n'});
 ok((await pool.query("SELECT callee_name FROM reverse_code_kanten WHERE datei_id=$1 AND callee_name='Helper.run'",[javaJob.did])).rows.length===1,'manifest -> javap -> PG call');
 eq(javap.dateien[0].kanten.map(k=>[k.caller,k.callee]),[['main','Helper.run']],'javap calls');
 ok(normalisiereJavap('x'.repeat(2000),{maxBytes:10,maxEintraege:1}).gekappt,'normalizer byte budget');
 for(const [label,input]of [['normal',process.env.P18_REA_NORMAL_JSONL],['fallback',process.env.P18_REA_FALLBACK_JSONL]]){
  if(!input)continue;
  const sidecars={};
  for(const name of ['s1-rz-strings.json','s1-rz-imports.json','s1-rz-symbols.json','normalisierer-status.json']){
   try{sidecars[name]=await readFile(join(dirname(input),name),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const real=await prepare('AUTORUN-'+label+'.EXE',await readFile(input,'utf8'),undefined,Object.keys(sidecars).length?sidecars:undefined);
  const c=await call('calls',{file_path:real.name+'@S3',limit:5});ok(c.success&&c.total>0,'real AUTORUN calls');
  const target=(await pool.query("SELECT name FROM reverse_code_symbole WHERE datei_id=$1 AND symbol_type='string' ORDER BY CASE WHEN value='MutexSiedler3' THEN 0 ELSE 1 END,adresse LIMIT 1",[real.did])).rows[0];
  ok(target,'real string definition');
  const r=await call('references',{name:target.name,file_path:real.name+'@S3',limit:3});ok(r.success&&r.total_references>0,'real AUTORUN refs');
  if(label==='fallback')ok((await pool.query("SELECT file_path FROM reverse_code_dateien WHERE datei_id=$1 AND file_type='asm'",[real.did])).rows.length>0,'real forced Ghidra fallback');
  const allCalls=await call('calls',{file_path:real.name+'@S3',limit:500});
  const entryCalls=allCalls.calls.filter(x=>x.caller_scope==='entry');ok(entryCalls.length>0,'real entry calls');
  const graphCounts=(await pool.query("SELECT (SELECT count(*)::int FROM reverse_code_kanten WHERE datei_id=$1) calls,(SELECT count(*)::int FROM reverse_code_verweise WHERE datei_id=$1) refs,(SELECT count(*)::int FROM reverse_code_symbole WHERE datei_id=$1 AND schicht='S1') s1_symbole",[real.did])).rows[0];
  if(Object.keys(sidecars).length){ok(graphCounts.s1_symbole>0,'real rz-bin S1 symbols');ok((await pool.query("SELECT target FROM reverse_verweise WHERE datei_id=$1 AND kind='string_datei'",[real.did])).rows.length>0,'real rz-bin filename candidates');}
  const asmReal=(await pool.query("SELECT file_path,content FROM reverse_code_dateien WHERE datei_id=$1 AND file_type='asm' LIMIT 1",[real.did])).rows[0];
  console.log('REAL_AUTORUN_'+label.toUpperCase()+' '+JSON.stringify({import:real.result,entry_calls:entryCalls,counts:graphCounts,references:r.references,ref_total:r.total_references,assembly:asmReal?{file_path:asmReal.file_path,lines:asmReal.content.split('\n').slice(0,5)}:null}));
 }
 console.log('REA1_SAMPLE '+JSON.stringify({calls:calls.calls,references:refs.references,assembly:asm.content}));
 console.log('REA1 PASS '+checks+' checks: graph, references, line mapping, masking, idempotency, budget, S2 fallback, rz-bin/wasm/javap');
}finally{
 if(made)await raw.query('DROP SCHEMA '+schema+' CASCADE');
 await raw.end();await rm(temp,{recursive:true,force:true});
}
