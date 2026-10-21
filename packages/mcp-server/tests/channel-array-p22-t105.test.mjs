/** P22-T105 N1: real REST/stdio handlers, private synapse_test schema, no production calls. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const load=p=>import(pathToFileURL(join(repo,p)).href);
const require=createRequire(join(repo,'packages/core/package.json'));
const db=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
for(const k of ['SYNAPSE_DATABASE_URL','SYNAPSE_AGENT_TOKEN','SYNAPSE_AGENT_IDENTITY_ID','SYNAPSE_AUTH_DISABLED'])delete process.env[k];
Object.assign(process.env,{SYNAPSE_SHELL_JOB:'1',SYNAPSE_SKIP_EMBEDDINGS:'1',PARSER_LOOP_DISABLED:'1',
 SYNAPSE_TOKEN_IDENTITAET:'0',SYNAPSE_W1B_DURCHSETZUNG:'0',SYNAPSE_AGENT_BEZUG_MODUS:'alt'});
const {Pool}=require('pg'),admin=new Pool({connectionString:db.href});
const schema='p22_t105_n1_'+process.pid+'_'+randomUUID().slice(0,8);
let C,failure,checks=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);checks++;console.log('OK '+label+': '+JSON.stringify(actual));};
try{
 await admin.query('CREATE SCHEMA '+schema);
 await admin.query('CREATE TABLE '+schema+'.specialist_channels (LIKE public.specialist_channels INCLUDING ALL)');
 db.searchParams.set('options','-c search_path='+schema+',public');process.env.DATABASE_URL=db.href;
 C=await load('packages/core/dist/index.js');
 const {channelTool}=await load('packages/mcp-server/dist/tools/consolidated/channel.js');
 const {handleToolCall}=await load('packages/rest-api/dist/routes/mcp.js');
 const args={project:'p22-t105-n1',agent_name:'n1-agent'};
 const stdio=async a=>JSON.parse((await channelTool.handler({...args,...a})).content[0].text);
 const rest=a=>handleToolCall('channel',{...args,...a});
 for(const [name,call]of [['stdio',stdio],['REST',rest]]){
  check(await call({action:'leave',channel_name:['x']}),{success:true,results:[{channel:'x',status:'abgewiesen',grund:'nicht_mitglied'}],action:'leave'},name+' leave singleton preserves array reply');
  check((await call({action:'leave',channel_name:['x','y']})).results.length,2,name+' leave multiple still returns both entries');
  for(const action of ['leave','join']){
   let message;
   try{await call({action,channel_name:[]});}catch(e){message=e.message;}
   check(message,'channel_name darf nicht leer sein',name+' '+action+' empty array error');
  }
  check(Array.isArray((await call({action:'join',channel_name:['x']})).results),true,name+' join singleton uses array handler');
  check('results' in await call({action:'leave',channel_name:'x'}),false,name+' string leave retains single handler');
 }
 console.log('P22-T105 N1: '+checks+' checks passed; synapse_test:5433');
}catch(e){failure=e;console.error(e.stack??String(e));}
finally{
 if(C)await C.closePool();
 await admin.query('DROP SCHEMA IF EXISTS '+schema+' CASCADE');await admin.end();
}
process.exit(failure?1:0);
