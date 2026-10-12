/** P10-T60: echte REST/stdio-Transporte, eigene Test-DB und privates Schema, kein Jev-Netzaufruf. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const db=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(db.port,'5433');assert.equal(db.pathname,'/synapse_test');
const schema='t60_'+randomUUID().replaceAll('-',''),project='t60-'+randomUUID(),agent='sol-3-test-'+randomUUID();
db.searchParams.set('options','-c search_path='+schema+',public -c statement_timeout=60000 -c lock_timeout=10000');
Object.assign(process.env,{DATABASE_URL:db.toString(),SYNAPSE_DATABASE_URL:db.toString(),JEV_OPENROUTER_API_KEY:'',CHANNEL_SKILL_MIN_SCORE:'1.1',OLLAMA_URL:'http://127.0.0.1:9',QDRANT_URL:'http://127.0.0.1:9'});
const {getPool,closePool}=await import('../dist/db/client.js'),pool=getPool();
const old=process.argv.includes('--old');
let app,client,created=false;
function unpack(r){let x=r.structuredContent??r;while(x?.content?.[0]?.text){x=JSON.parse(x.content[0].text);}return x;}
try{
 await pool.query('CREATE SCHEMA "'+schema+'"');created=true;
 for(const {tablename}of(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 const tasks=Array.from({length:30},(_,i)=>({id:randomUUID(),title:'Task '+i,status:'todo',priority:'medium',description:'Ausführliche Beschreibung. '.repeat(120),kurz_id:'P1-T'+(i+1)}));
 await pool.query('INSERT INTO plans(id,project,name,tasks,kurz_id,aktiv) VALUES($1,$2,$3,$4::jsonb,$5,true)',[randomUUID(),project,'Testplan',JSON.stringify(tasks),'P1']);
 for(let i=0;i<30;i++)await pool.query("INSERT INTO jev_entscheidungstopf(kennung,kategorie,antwort_wortlaut,frage_de,status,herkunft) VALUES($1,'variante',$2,$3,'roh','tool')",['test-name-'+i,'Antwort. '.repeat(150),'Frage '+i]);
 for(let i=0;i<3;i++)await pool.query("INSERT INTO tool_calls(project,agent_id,tool_name,action,ok) VALUES($1,$2,'t60fixture','probe',true)",[project,agent]);
 const requireRest=createRequire(new URL('../../rest-api/package.json',import.meta.url));
 app=requireRest('fastify')({logger:false});await app.register((await import('../../rest-api/dist/routes/mcp.js')).mcpRoutes);await app.ready();
 const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 const server=fileURLToPath(new URL('../../mcp-server/dist/server.js',import.meta.url)),transport=fileURLToPath(new URL('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url));
 const env={...process.env};delete env.SYNAPSE_AGENT_NAME;
 client=new Client({name:'t60-test',version:'1'});
 const stdio=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval','const {createServer}=await import('+JSON.stringify(server)+');const {StdioServerTransport}=await import('+JSON.stringify(transport)+');await createServer().connect(new StdioServerTransport());'],env,stderr:'pipe'});
 stdio.stderr?.resume();await client.connect(stdio);
 const restRpc=async(method,params)=>(await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method,params}})).json().result;
 const definitions={rest:await restRpc('tools/list',{}),stdio:await client.listTools()};
 for(const mode of ['rest','stdio']){
  const call=async(name,args)=>{const input={name,arguments:{project,agent_id:agent,...args}};return unpack(mode==='rest'?await restRpc('tools/call',input):await client.callTool(input));};
  const normal=await call('plan',{action:'get',plan_id:'P1'});
  const full=await call('plan',{action:'get',plan_id:'P1',compact:false});
  const one=await call('plan',{action:'get',plan_id:'P1',task_id:'P1-T1'});
  const pot=await call('jev',{action:'topf'});
  const activity=await call('shell',{action:'activity',tools:['t60fixture'],limit:1});
  console.log(JSON.stringify({mode,plan:JSON.stringify(normal).length,plan_full:JSON.stringify(full).length,topf:JSON.stringify(pot).length,activity:JSON.stringify(activity).length}));
  if(!old || mode==='rest')assert.equal((full.tasks??full.plan?.tasks).length,30);
  assert.equal((one.tasks??one.plan?.tasks)[0].description,tasks[0].description);
  if(!old){
   assert.equal(JSON.stringify(normal).includes(tasks[0].description),false,'kein versteckter Volltext im Standardplan');
   assert.equal((normal.tasks??normal.plan?.tasks).length,30);
   assert.equal(pot.anzahl,30);assert.equal(pot.namen.length,30);assert.equal('eintraege'in pot,false);
   const detail=await call('jev',{action:'topf',name:'test-name-0'});assert.equal(detail.eintraege[0].kennung,'test-name-0');
   const explanations=await call('jev',{action:'topf',topf:'erklaerung'});assert.deepEqual(explanations.namen,[]);
   const preview=await call('jev',{action:'topf_namen_nachtragen'});assert.equal(preview.vorschau,true);assert.equal(preview.anzahl,0);
   const noName=await call('thought',{action:'add',source:agent,content:'Nicht speichern',tags:['entscheidung','user']});
   assert.equal(noName.success,false);assert.ok(JSON.stringify(noName).includes('name'));
   assert.equal(Number((await pool.query('SELECT count(*) FROM thoughts WHERE project=$1',[project])).rows[0].count),0);
   const missingExplanation=await call('code_check',{action:'erklaerung_ablegen',fall_id:'999999'});
   assert.equal(missingExplanation.error,'name_fehlt');
   assert.ok(definitions[mode].tools.find(t=>t.name==='jev').inputSchema.properties.name);
   assert.ok(definitions[mode].tools.find(t=>t.name==='code_check').inputSchema.properties.name);
   assert.ok(definitions[mode].tools.find(t=>t.name==='thought').inputSchema.required.includes('project'));
   assert.ok(definitions[mode].tools.find(t=>t.name==='specialist').inputSchema.allOf.some(x=>x.if.properties.action.const==='status'&&x.then.required.includes('project')));
   const shell=definitions[mode].tools.find(t=>t.name==='shell');assert.ok(shell.inputSchema.properties.limit.description.includes('activity'));
  }
  assert.equal(activity.count,1);assert.equal(activity.activity.length,1,'activity limit exakt');
  assert.ok(JSON.stringify(activity).includes('t60fixture'),'Activity-Positivkontrolle');
 }
 console.log(old?'PASS ALT P10-T60 erfasst':'PASS P10-T60 REST/stdio Vertrag');
}finally{
 await client?.close();await app?.close();
 if(created)await pool.query('DROP SCHEMA "'+schema+'" CASCADE');
 await closePool();
}
