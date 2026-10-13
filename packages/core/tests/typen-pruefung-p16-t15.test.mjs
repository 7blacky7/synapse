/** P16-T15: ausschließlich isolierter Test-DB-Bereich; Golden gegen Live-Basis. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const {oeffneGeschuetzteShellTestDb}=await import('../../../scripts/lib/test-db-schutz.mjs');
const guard=await oeffneGeschuetzteShellTestDb();
await guard.query('SELECT current_database()');await guard.end();
const target=new URL(process.env.DATABASE_URL??'http://ungueltig');
assert.equal(target.port,'5433');assert.equal(target.pathname,'/synapse_test');
Object.assign(process.env,{QDRANT_URL:'http://127.0.0.1:9',OLLAMA_URL:'http://127.0.0.1:9',SYNTAX_WORKER_THREADS:'0',
 FEHLERPRUEFUNG_BUDGET_MS:'20000',FEHLERPRUEFUNG_TYPEN_MS:'20000',SYNAPSE_COMMIT_WAIT_SYNC_MAX_SECONDS:'0'});
const hier=dirname(fileURLToPath(import.meta.url)),root=resolve(hier,'../../..');
const dist=process.env.P16_CORE_DIST??resolve(hier,'../dist');
const lade=p=>import(pathToFileURL(join(dist,p)).href);
const db=await lade('db/client.js'),ci=await lade('services/code-intel.js'),ghost=await lade('services/code-intel-schatten.js');
const batch=await lade('services/file-batch.js'),parser=await lade('parser/index.js'),pb=await lade('services/plan-befunde.js');
const pool=db.getPool(),project='test-sol10-p16-'+randomUUID(),agent='sol-10-test-'+randomUUID(),task=randomUUID();
const sha=s=>createHash('sha256').update(s).digest('hex');
const configPath='packages/core/tsconfig.json',fixture='packages/core/src/p16-fixture/';
const config={compilerOptions:{strict:true,target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',skipLibCheck:true,types:['node'],noEmit:true},include:['src/p16-fixture/**/*']};
let ok=0;
const check=(name,fn)=>{fn();ok++;console.log('OK '+name);};
function normal(value){return JSON.parse(JSON.stringify(value,(k,v)=>{
 if(['dauer_ms','schatten_parse_ms'].includes(k))return 0;
 if(['geprueft_am','created_at','updated_at'].includes(k))return '<ZEIT>';
 if(k==='plan_id')return '<PLAN>';
 if(typeof v==='string')return v.replaceAll(project,'<PROJEKT>').replaceAll(agent,'<AGENT>')
  .replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi,'<UUID>').replace(/\(plan \d+/g,'(plan <PLAN>').replace(/ghost:\d+:/g,'ghost:<PLAN>:');
 return v;
}));}
async function seed(file,content,type=file.split('.').at(-1)){
 await pool.query(`INSERT INTO code_files(id,project,file_path,file_name,file_type,file_size,content,content_hash,ignored,parsed_at,parser_version,tsv,tsv_zerlegt)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,false,NOW(),1,to_tsvector('english',$7),to_tsvector('simple',$7))
 ON CONFLICT(project,file_path) DO UPDATE SET content=$7,content_hash=$8,file_size=$6,file_type=$5,parsed_at=NOW(),parser_version=1,tsv=to_tsvector('english',$7),tsv_zerlegt=to_tsvector('simple',$7),deleted_at=NULL`,
 [randomUUID(),project,file,file.split('/').at(-1),type,Buffer.byteLength(content),content,sha(content)]);
}
async function index(){
 for(const t of ['code_references','code_call_edges','code_symbols'])await pool.query('DELETE FROM '+t+' WHERE project=$1',[project]);
 const rows=(await pool.query('SELECT file_path,content FROM code_files WHERE project=$1 AND deleted_at IS NULL ORDER BY file_path',[project])).rows;
 const parsed=[],symbols=[];
 for(const row of rows){
  const p=parser.getParserForFile(row.file_path,row.content);if(!p)continue;
  const result=p.parse(row.content,row.file_path);parsed.push({...row,result});
  for(const s of result.symbols){
   const id=randomUUID();symbols.push({...s,id,file_path:row.file_path});
   await pool.query('INSERT INTO code_symbols(id,project,file_path,symbol_type,name,value,line_start,line_end,params,return_type,is_exported) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id,project,row.file_path,s.symbol_type,s.name,s.value??null,s.line_start,s.line_end??s.line_start,s.params??null,s.return_type??null,s.is_exported]);
  }
 }
 for(const row of parsed){
  for(const ref of row.result.references){
   const candidates=symbols.filter(s=>s.name===ref.symbol_name&&!['import','export','comment','string'].includes(s.symbol_type));
   const local=candidates.filter(s=>s.file_path===row.file_path),s=local.length===1?local[0]:candidates.length===1?candidates[0]:null;
   if(s)await pool.query('INSERT INTO code_references(id,project,symbol_id,file_path,line_number,context) VALUES($1,$2,$3,$4,$5,$6)',
    [randomUUID(),project,s.id,row.file_path,ref.line_number,ref.context??null]);
  }
  for(const call of row.result.callEdges??[]){
   const s=symbols.find(s=>s.name===call.callee_name&&s.is_exported);
   await pool.query('INSERT INTO code_call_edges(project,file_path,callee_name,line_number,call_kind,confidence,target_symbol_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [project,row.file_path,call.callee_name,call.line_number,call.call_kind??'function',call.confidence??1,s?.id??null]);
  }
 }
}
async function storedPlan(ops){
 const hashes=Object.fromEntries(await Promise.all([...new Set(ops.map(o=>o.file_path))].map(async file=>{
  const r=await pool.query('SELECT content_hash FROM code_files WHERE project=$1 AND file_path=$2',[project,file]);return [file,r.rows[0]?.content_hash??sha('')];
 })));
 return (await pool.query(`INSERT INTO file_batch_plans(project,owner_agent_id,ops,expected_hashes,previews,status,expires_at)
 VALUES($1,$2,$3::jsonb,$4::jsonb,'[]','open',NOW()+INTERVAL '1 day') RETURNING id::text`,
 [project,agent,JSON.stringify(ops.map(op=>({...op,agent_id:agent,task_id:task}))),JSON.stringify(hashes)])).rows[0].id;
}
async function bestand(action,a={}){
 switch(action){
 case 'file':{const r=await ci.getFileContent(project,a.file_path);return r?{success:true,...r,project}:{success:false};}
 case 'tree':return {success:true,tree:await ci.getProjectTree(project,a),project};
 case 'functions':return {success:true,functions:await ci.getFunctions(project,a.file_path,a.name,a.exported_only,a.limit),project};
 case 'symbols':return {success:true,symbols:await ci.getSymbols(project,a.symbol_type,a.file_path,a.name,a.limit),project};
 case 'references':return {success:true,...await ci.getReferences(project,a.name,false,0),project};
 case 'search':return {success:true,results:await ci.fullTextSearchCode(project,a.query,undefined,20,a.file_path),project};
 case 'variables':return {success:true,variables:await ci.getVariables(project,a.file_path,undefined,true),project};
 case 'statements':return {success:true,statements:await ci.getStatements(project,a.file_path),project};
 case 'calls':return {success:true,...await ci.getCallEdges(project,a.file_path),project};
 case 'flow':return {success:true,...await ci.getExecutionFlow(project,a.file_path),project};
 case 'entrypoints':return {success:true,entrypoints:await ci.getEntrypoints(project,a.file_path),project};
 default:throw Error(action);
 }
}
const run=(action,a={})=>ghost.mitCodeIntelSchatten(action,{project,agent_id:agent,...a},()=>bestand(action,a));
const collect=r=>r?.typbefunde?.staende?r.typbefunde.staende.flatMap(s=>s.dateien.flatMap(d=>d.befunde)):r?.typbefunde?.dateien?.flatMap(d=>d.befunde)??[];
const typDatei=(file,basis,ergebnis,op_index=0)=>({file_path:file,basis,ergebnis,ops:[{op_index,agent_id:agent,spannen:[[0,ergebnis.split('\n').length]]}]});
const enabledGood='export const enabled: boolean = true;\n',enabledBad="export const enabled: boolean = 'yes';\n";
const poolGood="import {Pool} from 'pg';\nexport const db: Pool = new Pool();\n";
const poolBad="import {Pool,type PoolClient} from 'pg';\nexport const db: PoolClient = new Pool();\n";
const streamGood="declare const stream: NodeJS.ReadWriteStream;\nstream.end();\nexport {};\n",streamBad=streamGood.replace('stream.end()','stream.destroy()');
const reverseGood="declare const row: Record<string,unknown>;\n"+Array.from({length:17},(_,i)=>'export const ref'+i+': string = String(row.ref'+i+');').join('\n')+'\n';
const reverseBad=reverseGood.replace(/String\((row\.ref\d+)\)/g,'$1');
const cases=[['enabled-sync.ts',enabledGood,enabledBad,'TS2322'],['compute-policy.ts',poolGood,poolBad,'TS2740'],['tool-container-docker.ts',streamGood,streamBad,'TS2339'],['reverse-tool.ts',reverseGood,reverseBad,'TS2322']];
async function cleanup(){
 await pool.query('DELETE FROM agent_event_acks WHERE event_id IN(SELECT id FROM agent_events WHERE project=$1)',[project]).catch(()=>{});
 for(const table of ['file_batch_waits','file_batch_plans','file_reservations','file_versions','code_references','code_call_edges','code_statements','code_symbols','code_chunks','code_files','agent_events','plans','projects'])
  await pool.query('DELETE FROM '+table+' WHERE '+(table==='projects'?'name':'project')+'=$1',[project]).catch(()=>{});
}
try{
 await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,false)',[project,'sol-10-tests',root]);
 await pool.query('INSERT INTO plans(id,project,name,kurz_id,tasks) VALUES($1,$2,$3,$4,$5::jsonb)',
  [randomUUID(),project,'P16 testfixture','P16',JSON.stringify([{id:task,kurz_id:'P16-T15',title:'P16 testfixture',status:'in_progress'}])]);
 await seed(configPath,JSON.stringify(config),'json');await seed('package.json','{"name":"p16-fixture","type":"module"}','json');
 await seed('packages/core/package.json','{"name":"p16-core-fixture","type":"module"}','json');
 await seed(fixture+'golden.ts','export function golden(value:number):number { return value; }\n');
 await seed('golden/base.py','def golden_python(value):\n    return value\n','py');await index();
 const pyPlan=await storedPlan([{action:'create',file_path:'golden/ghost.py',content:'def ghost_python(value):\n    return value + 1\n'}]);
 const defaults=[['file',{file_path:fixture+'golden.ts'}],['tree',{path:'golden',show_assets:false}],['functions',{file_path:fixture+'golden.ts'}],['symbols',{symbol_type:'function',file_path:fixture+'golden.ts'}],
  ['references',{name:'golden'}],['search',{query:'golden'}],['variables',{file_path:fixture+'golden.ts'}],['statements',{file_path:fixture+'golden.ts'}],['calls',{file_path:fixture+'golden.ts'}],['flow',{file_path:fixture+'golden.ts'}],['entrypoints',{file_path:fixture+'golden.ts'}]];
 const shadows=[['file',{file_path:'golden/ghost.py'}],['functions',{file_path:'golden/ghost.py'}],['symbols',{file_path:'golden/ghost.py',symbol_type:'function'}],['references',{name:'ghost_python'}],['search',{query:'ghost_python'}],['tree',{path:'golden',show_assets:false}]];
 const golden={defaults:await Promise.all(defaults.map(async([a,v])=>[a,normal(await run(a,v))])),
  schattenNichtTs:await Promise.all(shadows.map(async([a,v])=>[a,normal(await run(a,{...v,schatten:pyPlan}))])),
  befundeNichtTs:normal(await pb.pruefePlanDateien(project,[typDatei('golden/check.py','def ok():\n    return 1\n','def ok():\n    return 2\n')]))};
 if(process.argv.includes('--capture'))console.log('GOLDEN_JSON='+JSON.stringify(golden));
 else if(process.argv.includes('--golden')){
  assert.deepEqual(golden,JSON.parse(readFileSync(join(hier,'fixtures/typen-pruefung-p16-t15.golden.json'),'utf8')));
  console.log('GOLDEN_OK defaults=11 shadowsNonTS=6 befundeNonTS=1');
 }else if(process.argv.includes('--red')){
  let detected=0;
  for(const [file,,bad,code] of cases){
   await seed(fixture+file,bad);await index();
   const r=await run('file',{file_path:fixture+file,typen:true}),found=collect(r).some(b=>b.code===code&&b.severity==='error');
   console.log('RED_CASE '+file+' detected='+found);if(found)detected++;
  }
  assert.equal(detected,4,'P16-T15 baseline erkennt vier W2-Typmuster noch nicht');
 }else{
  const typen=await lade('services/typen-pruefung.js'),engine=await lade('services/typen-pruefung-worker.js');
  assert.deepEqual(golden,JSON.parse(readFileSync(join(hier,'fixtures/typen-pruefung-p16-t15.golden.json'),'utf8')));
  check('Golden 11 Defaults,6 NichtTS-Schatten,alte NichtTS-Prüfbefunde',()=>{});
  for(const [name,good,bad,code] of cases){
   const file=fixture+name;await seed(file,good);await index();
   const r=await typen.pruefePlanTypen(project,[typDatei(file,good,bad)]);
   check(name+' neuer Typfehler am richtigen Op',()=>{
    assert.equal(r.status,'fertig',JSON.stringify(r));assert(r.befunde.some(b=>b.code===code&&b.severity==='error'&&b.op_index===0),JSON.stringify(r));
    if(name==='reverse-tool.ts')assert.equal(r.befunde.filter(b=>b.severity==='error').length,17);
    if(name==='compute-policy.ts')assert.equal(r.vollstaendig,true,JSON.stringify(r.fehlende_module));
   });
   const fixed=await typen.pruefePlanTypen(project,[typDatei(file,good,good)]);
   check(name+' korrigierter Stand sauber',()=>assert.equal(fixed.befunde.filter(b=>b.severity==='error').length,0));
   await seed(file,bad);
   const current=await run('file',{file_path:file,typen:true});
   check(name+' typen:true aktueller PG-Stand',()=>assert(collect(current).some(b=>b.code===code),JSON.stringify(current)));
   const altlast=await typen.pruefePlanTypen(project,[typDatei(file,bad,'// verschoben\n'+bad)]);
   check(name+' verschobene Altlast sperrt nicht',()=>assert.equal(altlast.befunde.filter(b=>b.severity==='error').length,0));await seed(file,good);
  }
  const definition=fixture+'lib.ts',caller=fixture+'caller.ts',good='export function build(value:number):number { return value; }\n',bad='export function build(value:number):string { return String(value); }\n';
  await seed(definition,good);await seed(caller,"import {build} from './lib.js';\nexport const number:number = build(1);\n");await index();
  const shadow=await storedPlan([{action:'search_replace',file_path:definition,search:good,replace:bad}]);
  const before=(await pool.query('SELECT file_path,content,content_hash FROM code_files WHERE project=$1 ORDER BY file_path',[project])).rows;
  const r=await run('file',{file_path:definition,schatten:shadow});
  check('Schatten zeigt Fremddatei-Folgefehler vor commit',()=>{
   assert(r.typbefunde.betroffene_aufrufer.includes(caller),JSON.stringify(r));assert(collect(r).some(b=>b.datei===caller&&b.code==='TS2322'&&b.op_index===0),JSON.stringify(r));
   assert(collect(r).some(b=>b.code==='FOLGEFEHLER_TS2322'&&b.severity==='warning'));
  });
  assert.deepEqual((await pool.query('SELECT file_path,content,content_hash FROM code_files WHERE project=$1 ORDER BY file_path',[project])).rows,before);check('Keine PG-Quellmutation',()=>{});
  assert.equal((await run('file',{file_path:definition,schatten:shadow,typen:false})).typbefunde,undefined);check('typen:false im Schatten',()=>{});
  for(const [action,args] of [['file',{file_path:definition}],['functions',{file_path:definition}],['symbols',{file_path:definition,symbol_type:'function'}],['references',{name:'build'}],['search',{query:'build'}],['tree',{path:fixture.slice(0,-1),show_assets:false}]]){
   const visible=await run(action,{...args,schatten:shadow});
   check(action+' Schatten-Typbefunde am sichtbaren Fremdaufrufer',()=>assert(collect(visible).some(b=>b.datei===caller&&b.code==='TS2322'),JSON.stringify(visible)));
  }
  const enabledFile=fixture+'enabled-sync.ts';await seed(enabledFile,enabledBad);await index();
  for(const [action,args]of [['file',{file_path:enabledFile}],['functions',{file_path:enabledFile}],['symbols',{file_path:enabledFile,symbol_type:'variable'}],['references',{name:'enabled'}],['search',{query:'enabled'}],['tree',{path:fixture.slice(0,-1),show_assets:false}]]){
   const visible=await run(action,{...args,typen:true});
   check(action+' typen:true ohne Plan erkennt PG-Typfehler',()=>assert(collect(visible).some(b=>b.datei===enabledFile&&b.code==='TS2322'),JSON.stringify(visible)));
  }
  await seed(enabledFile,enabledGood);await index();
  const intermediate=await storedPlan([{action:'search_replace',file_path:enabledFile,search:enabledGood,replace:enabledBad},{action:'search_replace',file_path:enabledFile,search:enabledBad,replace:enabledGood}]);
  const first=await run('file',{file_path:enabledFile,schatten:intermediate,stand_nach_op:0});
  check('stand_nach_op:0 Typfehler und Dateianker',()=>{assert.equal(first.content,enabledBad);assert.match(first.content,/enabled: boolean = 'yes'/);assert(collect(first).some(b=>b.code==='TS2322'&&b.op_index===0),JSON.stringify(first));});
  const last=await run('file',{file_path:enabledFile,schatten:intermediate});
  check('korrigierter Endschatten ohne Typfehler am Dateianker',()=>{assert.equal(last.content,enabledGood);assert.equal(collect(last).filter(b=>b.severity==='error').length,0,JSON.stringify(last));});
  const all=await run('file',{file_path:definition,schatten:'alle'});
  check('schatten:alle hält Typbefunde je Plan getrennt',()=>{assert(all.staende.some(s=>s.plan_id===shadow&&collect(s).some(b=>b.datei===caller&&b.code==='TS2322')),JSON.stringify(all));});
  const arity=await typen.pruefePlanTypen(project,[typDatei(definition,good,'export function build(value:number, second:number):number { return value+second; }\n')]);
  check('CodeIntel Parameterzahlwarning plus TS-Aufruferfehler',()=>{assert(arity.befunde.some(b=>b.code==='INTEL_PARAMETERZAHL'),JSON.stringify(arity));assert(arity.befunde.some(b=>b.datei===caller&&b.code==='TS2554'),JSON.stringify(arity));});
  const removed=await typen.pruefePlanTypen(project,[typDatei(definition,good,'export const replacement=1;\n')]);
  check('CodeIntel entfernter Export warning',()=>assert(removed.befunde.some(b=>b.code==='INTEL_EXPORT_ENTFERNT'),JSON.stringify(removed)));
  const p=await batch.planBatch({project,agent_id:agent,task_id:task,ops:[{action:'search_replace',file_path:fixture+'enabled-sync.ts',search:enabledGood,replace:enabledBad}]});
  check('files(plan) Typstufe+Commit-Sperre',()=>{assert.equal(p.pruefung.sperre,true,JSON.stringify(p));assert(p.pruefung.typen);});
  const blocked=await batch.commitBatch({plan_id:p.plan_id,agent_id:agent,task_id:task});
  check('commit Typfehler schreibt nichts',()=>{assert.equal(blocked.error,'pruef_befunde');assert.equal(blocked.geschrieben,false);});
  const befund=(await batch.pruefeGespeichertenPlan(p.plan_id)).pruefung.befunde.find(b=>b.quelle==='typen'&&b.severity==='error');
  const quittiert=await batch.commitBatch({plan_id:p.plan_id,agent_id:agent,task_id:task,befunde_quittieren:[{id:befund.id,grund:'Absichtlich fehlerhafte synthetische Testfixture'}]});
  check('Absichtliche Fixture mit Grund quittierbar',()=>assert.equal(quittiert.success,true,JSON.stringify(quittiert)));
  await seed(fixture+'enabled-sync.ts',enabledGood);await index();
  const q=await batch.planBatch({project,agent_id:agent,task_id:task,ops:[{action:'search_replace',file_path:fixture+'enabled-sync.ts',search:enabledGood,replace:enabledBad}]});
  const update=await batch.replanBatch({project,plan_id:q.plan_id,agent_id:agent,task_id:task,op_index:0,ops:[{action:'search_replace',file_path:fixture+'enabled-sync.ts',search:enabledGood,replace:'export const enabled:boolean = false;\n',task_id:task}]});
  const c=await batch.commitBatch({plan_id:update.plan_id??q.plan_id,agent_id:agent,task_id:task});
  check('plan_update Korrektur löst Typ-Sperre',()=>assert.equal(c.success,true,JSON.stringify(c)));
  const missingFile=fixture+'missing.ts',missingGood='export const missing=1;\n';await seed(missingFile,missingGood);
  const missing=await typen.pruefePlanTypen(project,[typDatei(missingFile,missingGood,"import type {Mystery} from 'p16-does-not-exist';\nexport const missing: Mystery = {};\n")]);
  check('Fehlende Externa vollständig:false ohne daraus erzeugte Sperre',()=>{assert.equal(missing.vollstaendig,false,JSON.stringify(missing));assert(missing.fehlende_module.includes('p16-does-not-exist'));assert.equal(missing.befunde.filter(b=>b.severity==='error').length,0);});
  const jsFile=fixture+'checked.js';await seed(jsFile,"/** @type {number} */\nexport const jsNumber='text';\n",'js');
  assert.equal((await run('file',{file_path:jsFile,schatten:shadow})).typbefunde,undefined);check('JS ohne checkJs unverändert',()=>{});
  await seed(configPath,JSON.stringify({...config,compilerOptions:{...config.compilerOptions,allowJs:true,checkJs:true}}),'json');
  const js=await run('file',{file_path:jsFile,typen:true});check('JS mit checkJs liefert Typfehler',()=>assert(collect(js).some(b=>b.code==='TS2322'),JSON.stringify(js)));
  await seed(configPath,JSON.stringify(config),'json');
  const py=await run('file',{file_path:'golden/base.py',typen:true});check('Nicht unterstützte Sprache expliziter Hinweis',()=>{assert.equal(py.typbefunde,undefined);assert.match(py.typen_hinweis,/py/);});
  assert.equal((await run('file',{file_path:'golden/base.py',typen:true})).typen_hinweis,undefined);check('Hinweis-Deduplikation',()=>{});
  process.env.FEHLERPRUEFUNG_TYPEN_MS='1';
  const limited=await typen.pruefePlanTypen(project,[typDatei(fixture+'enabled-sync.ts',enabledGood,enabledBad)]);
  check('Zeitdeckel ohne Typ-Sperre',()=>{assert.equal(limited.status,'zeitlimit');assert.equal(limited.befunde.filter(b=>b.severity==='error').length,0);});
  process.env.FEHLERPRUEFUNG_TYPEN_MS='20000';process.env.FEHLERPRUEFUNG_TYPEN='0';
  const disabled=await typen.pruefePlanTypen(project,[typDatei(fixture+'enabled-sync.ts',enabledGood,enabledBad)]);
  check('FEHLERPRUEFUNG_TYPEN=0',()=>{assert.equal(disabled.status,'aus');assert.equal(disabled.befunde.filter(b=>b.severity==='error').length,0);});delete process.env.FEHLERPRUEFUNG_TYPEN;
  const sources=(await pool.query('SELECT file_path,content FROM code_files WHERE project=$1 AND deleted_at IS NULL',[project])).rows;
  const causeFile=fixture+'cause.ts',causeGood='export const a:number=1;\nexport const b:number=2;\n',causeBad="export const a:number='bad';\nexport const b:number=3;\n";
  sources.push({file_path:causeFile,content:causeGood});
  const cause=engine.pruefeTypAuftrag({project,root,quellen:sources,ziele:[causeFile],budget_ms:20000,basisvergleich:true,dateien:[{file_path:causeFile,basis:causeGood,ergebnis:causeBad,ops:[{op_index:0,agent_id:agent,spannen:[[0,1]]},{op_index:1,agent_id:'other-test',spannen:[[1,2]]}]}]});
  check('Ursache erste fehlerhafte Op statt letzter sauberer Op',()=>assert(cause.befunde.some(b=>b.code==='TS2322'&&b.op_index===0),JSON.stringify(cause)));
  const measures=[];
  for(let i=0;i<5;i++){await seed(fixture+'enabled-sync.ts',enabledGood);const t=performance.now();const mp=await batch.planBatch({project,agent_id:agent,task_id:task,ops:[{action:'search_replace',file_path:fixture+'enabled-sync.ts',search:enabledGood,replace:'export const enabled:boolean = false;\n'}]});measures.push(performance.now()-t);await batch.cancelBatch(mp.plan_id,agent,'P16 Laufzeitprobe beendet');}
  console.log('MEDIAN_PLAN_MS='+[...measures].sort((a,b)=>a-b)[2].toFixed(2)+' SAMPLES='+JSON.stringify(measures.map(v=>+v.toFixed(2))));
  const {pruefeWorkspaceTransport}=await import('../../rest-api/tests/typen-workspace-p16-t15.mjs');
  await pruefeWorkspaceTransport({project,pool,typen,root,datei:fixture+'enabled-sync.ts',basis:enabledGood,ergebnis:enabledBad,check});
  console.log('TEST_GRUEN P16-T15 checks='+ok);
 }
}finally{await cleanup();await db.closePool();}
