/** P22-T102: commit provenance regression, private synapse_test schema, no deployment or production writes. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=(...p)=>import(pathToFileURL(join(repo,...p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const requireApi=createRequire(join(repo,'packages/rest-api/package.json'));
const db=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');

for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',SYNAPSE_INTERN_TOOL:'0',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt',
 QDRANT_URL:'http://127.0.0.1:1',OLLAMA_URL:'http://127.0.0.1:1',EMBEDDING_BASE_URL:'http://127.0.0.1:1'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t102_'+process.pid+'_'+randomUUID().slice(0,8),P='p22-t93-browser';
const quote=s=>'"'+s.replaceAll('"','""')+'"';
let C,pool,app,failure,checks=0;const fixtureRoot=await mkdtemp(join(tmpdir(),'synapse-p22-t102-'));

const ok=(value,label)=>{assert(value,label);checks++;console.log('OK '+label);};
try{
 await admin.query('CREATE SCHEMA '+schema);
 for(const {tablename}of(await admin.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows)
  await admin.query('CREATE TABLE '+schema+'.'+quote(tablename)+' (LIKE public.'+quote(tablename)+' INCLUDING ALL)');
 for(const [i,r]of(await admin.query("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=$1 AND column_default LIKE 'nextval(%'",[schema])).rows.entries()){
  const name=schema+'.serial_'+i;await admin.query('CREATE SEQUENCE '+name);
  await admin.query('ALTER TABLE '+schema+'.'+quote(r.table_name)+' ALTER COLUMN '+quote(r.column_name)+" SET DEFAULT nextval('"+name+"'::regclass)");
 }
 db.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=db.href;
 C=await load('packages/core/dist/index.js');pool=C.getPool();
 await pool.query('ALTER TABLE file_batch_plans DROP COLUMN auto_commit');
 ok((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='file_batch_plans' AND column_name='auto_commit'",[schema])).rowCount===0,'unmigrated fixture has no auto_commit column');
 await pool.query('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,$3,true)',[P,fixtureRoot,'t102-commit-fixture']);
 const Fastify=requireApi('fastify');app=(Fastify.default||Fastify)({logger:false});
 const {mcpRoutes}=await load('packages/rest-api/dist/routes/mcp.js');
 await app.register(mcpRoutes);await app.ready();
 for(const name of ['claude-ui','codex-api'])await pool.query(
  "INSERT INTO agent_identitaeten(id,project,name,agent_id,rolle,status,erstellt_von,zuletzt_aktiv) VALUES($1,$2,$3,$3,'subagent','aktiv','test',NOW())",
  ['d102-'+name,P,name]);
 const call=async(args,agent='claude-ui')=>{
  const r=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'files',arguments:{project:P,agent_id:agent,...args}}}});
  assert.equal(r.statusCode,200,r.body);const d=r.json();assert(!d.error,JSON.stringify(d));
  const result=d.result.structuredContent??JSON.parse(d.result.content.find(c=>c.type==='text').text);
  assert.equal(result.success,true,JSON.stringify(result));return result;
 };
 const create=async(file,content,auto=false)=>call({action:'plan',auto_commit:auto,ops:[{action:'create',file_path:file,content}]});
 const text=async file=>(await pool.query('SELECT content FROM code_files WHERE project=$1 AND file_path=$2',[P,file])).rows[0]?.content;
 const provenance=async id=>(await pool.query('SELECT status,auto_commit FROM file_batch_plans WHERE id=$1',[id])).rows[0];
 const old=await create('unmigrated.md','alpha\nbeta\n');await call({action:'commit',plan_id:old.plan_id});
 ok(await text('unmigrated.md')==='alpha\nbeta\n','normal legacy commit works without migration');
 const coedit=async(file,auto)=>{
  const a=await call({action:'plan',ops:[{action:'search_replace',file_path:file,search:'alpha',replace:'ALPHA'}]});
  const waiting=await call({action:'plan',ops:[{action:'search_replace',file_path:file,search:'beta',replace:'BETA'}]},'codex-api');
  ok(waiting.coedit_waits?.some(w=>w.target_plan_id===a.plan_id),'second agent joins through a real open-plan wait');
  await call({action:'coedit_add',plan_id:a.plan_id,ops:[{action:'search_replace',file_path:file,search:'beta',replace:'BETA'}]},'codex-api');
  await call({action:'coedit_ready',plan_id:a.plan_id},'codex-api');
  const row=(await pool.query('SELECT ops FROM file_batch_plans WHERE id=$1',[a.plan_id])).rows[0];
  ok(new Set(row.ops.map(op=>op.agent_id)).size===2,'real shared plan stores two distinct authors');
  // Exercise commitCoeditBatch, selected by the two stored operation authors.
  const result=await C.commitBatch({plan_id:a.plan_id,agent_id:'claude-ui',auto_commit:auto});
  assert.equal(result.success,true,JSON.stringify(result));
  ok(await text(file)==='ALPHA\nBETA\n','real two-author coedit commit writes both changes');
  return a.plan_id;
 };
 await coedit('unmigrated.md',false);
 ok((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='file_batch_plans' AND column_name='auto_commit'",[schema])).rowCount===0,'both normal commit branches succeeded with column still absent');
 const {AGENTENNETZWERK_SCHEMA_SQL}=await load('packages/core/dist/db/agentennetzwerk-schema.js');
 await pool.query(AGENTENNETZWERK_SCHEMA_SQL);await pool.query(AGENTENNETZWERK_SCHEMA_SQL);
 ok((await provenance(old.plan_id)).auto_commit===false,'idempotent migration defaults old normal commits to false');
 const normal=await create('normal.md','normal');await call({action:'commit',plan_id:normal.plan_id,auto_commit:true});
 ok((await provenance(normal.plan_id)).auto_commit===false,'separate MCP commit cannot spoof auto provenance');
 const auto=await create('auto.md','auto',true);
 ok(auto.auto_committed===true&&(await provenance(auto.plan_id)).auto_commit===true,'single-file MCP auto provenance persists');
 const seed=await create('coedit.md','alpha\nbeta\n');await call({action:'commit',plan_id:seed.plan_id});
 const sharedId=await coedit('coedit.md',true);
 ok((await provenance(sharedId)).auto_commit===true,'successful real coedit auto provenance persists');
 const draft=await create('updated.md','before');
 const updated=await call({action:'plan_update',plan_id:draft.plan_id,op_index:0,ops:[{action:'create',file_path:'updated.md',content:'after'}],auto_commit:true});
 ok(updated.auto_committed===true&&await text('updated.md')==='after'&&(await provenance(updated.plan_id)).auto_commit===true,'MCP plan_update auto commit persists provenance and updated content');
 const multi=await call({action:'plan',auto_commit:true,ops:[{action:'create',file_path:'one.md',content:'one'},{action:'create',file_path:'two.md',content:'two'}]});
 ok(multi.mode==='per_file_atomic'&&multi.committed.length===2,'MCP multi-file auto branch commits both independent plans');
 for(const result of multi.committed){
  const id=result.plan_id??result.batch_id;
  ok((await provenance(id)).auto_commit===true,'multi-file child '+id+' stores auto provenance');
 }
 ok(await text('one.md')==='one'&&await text('two.md')==='two','multi-file final contents match');
 console.log('ERGEBNIS '+checks+' checks passed');
}catch(e){failure=e;console.error(e.stack??String(e));}
finally{
 if(app)await app.close();
 if(C)await C.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
 await rm(fixtureRoot,{recursive:true,force:true});
}
process.exit(failure?1:0);
