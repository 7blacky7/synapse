/** P3-T11: aktive Auswahl ist kein Abschluss. Nur privates Schema in synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const schema='t11_'+randomUUID().replaceAll('-',''),project='t11-'+randomUUID();
url.searchParams.set('options','-c search_path='+schema+',public');
Object.assign(process.env,{DATABASE_URL:url.toString(),SYNAPSE_DATABASE_URL:url.toString(),JEV_OPENROUTER_API_KEY:'',OLLAMA_URL:'http://127.0.0.1:9',QDRANT_URL:'http://127.0.0.1:9'});
const {getPool,closePool}=await import('../dist/db/client.js'),pool=getPool();
let app,client;
const unpack=r=>{let x=r.structuredContent??r;while(x?.content?.[0]?.text)x=JSON.parse(x.content[0].text);return x;};
try{
 await pool.query('CREATE SCHEMA "'+schema+'"');
 for(const {tablename}of(await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows){
  const q='"'+tablename.replaceAll('"','""')+'"';await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 await pool.query('ALTER TABLE chat_lesestand ADD COLUMN IF NOT EXISTS letzte_hinweis_id INTEGER NOT NULL DEFAULT 0');
 const P=await import('../dist/services/plans.js');P.planIndex.sync=async()=>{};
 const {setzeSchalter}=await import('../dist/services/intern-schalter.js');await setzeSchalter('embedding',{aktiv:true,modus:'alle',dauer_min:10,agent:'fixture'});
 const task=status=>({id:randomUUID(),title:status,description:'',status,priority:'medium',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
 for(const [nr,aktiv,tasks]of[[1,true,[task('todo')]],[2,false,[task('done'),task('in_progress')]],[3,false,[task('done')]],[4,false,[]]]){
  await pool.query('INSERT INTO plans(id,project,name,description,goals,architecture,tasks,kurz_id,aktiv) VALUES($1,$2,$3,\'vorher\',$4,\'alt\',$5::jsonb,$3,$6)',[randomUUID(),project,'P'+nr,[],JSON.stringify(tasks),aktiv]);
 }
 const changed=await P.updatePlan(project,{name:'Offen',description:'neu',goals:['Ziel'],architecture:'Architektur',prioritaet:'hoch'},'P2');
 assert.equal(changed.description,'neu','RED: inaktiver offener Plan aktualisierbar');assert.equal(changed.name,'Offen');assert.deepEqual(changed.goals,['Ziel']);assert.equal(changed.architecture,'Architektur');assert.equal(changed.prioritaet,'hoch');assert.equal(changed.aktiv,false);
 assert.equal((await P.updatePlan(project,{description:'Entwurf'},'P4')).description,'Entwurf');
 assert.equal((await P.updatePlan(project,{description:'aktiver Standard'})).kurz_id,'P1');
 const snapshot=async()=> (await pool.query("SELECT * FROM plans WHERE project=$1 AND kurz_id='P3'",[project])).rows[0];
 for(const update of [{description:'verboten'},{prioritaet:'hoch'},{name:'verboten',prioritaet:'niedrig'}]){
  const before=await snapshot();await assert.rejects(P.updatePlan(project,update,'P3'),/abgeschlossen \(alle 1 Tasks erledigt\)/);assert.deepEqual(await snapshot(),before);
 }
 // Auch aktivierte fertige Plaene bleiben abgeschlossen.
 await P.aktivierePlan(project,'P3');await assert.rejects(P.updatePlan(project,{description:'verboten'}),/abgeschlossen/);await P.aktivierePlan(project,'P1');
 // Ein Rennen mit der letzten Task muss beim optimistischen Neuversuch erneut sperren.
 const original=pool.query.bind(pool);let raced=false;
 pool.query=async(...args)=>{if(!raced&&typeof args[0]==='string'&&args[0].startsWith('UPDATE plans SET name =')){
  raced=true;await original("UPDATE plans SET tasks=$1::jsonb WHERE project=$2 AND kurz_id='P2'",[JSON.stringify([task('done')]),project]);}
  return original(...args);};
 try{await assert.rejects(P.updatePlan(project,{description:'Rennen',prioritaet:'niedrig'},'P2'),/abgeschlossen/);}finally{pool.query=original;}
 assert.equal(raced,true);const after=await P.getPlan(project,'P2');assert.equal(after.description,'neu');assert.equal(after.prioritaet,'hoch');
 await pool.query("UPDATE plans SET tasks=$1::jsonb WHERE project=$2 AND kurz_id='P2'",[JSON.stringify([task('todo')]),project]);
 const req=createRequire(new URL('../../rest-api/package.json',import.meta.url));app=req('fastify')({logger:false});
 await app.register((await import('../../rest-api/dist/routes/mcp.js')).mcpRoutes);await app.ready();
 const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 const server=fileURLToPath(new URL('../../mcp-server/dist/server.js',import.meta.url)),transport=fileURLToPath(new URL('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',import.meta.url)),plans=fileURLToPath(new URL('../dist/services/plans.js',import.meta.url));
 client=new Client({name:'t11-test',version:'1'});const env={...process.env};delete env.SYNAPSE_AGENT_NAME;
 const stdio=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval','const {planIndex}=await import('+JSON.stringify(plans)+');planIndex.sync=async()=>{};const {createServer}=await import('+JSON.stringify(server)+');const {StdioServerTransport}=await import('+JSON.stringify(transport)+');await createServer().connect(new StdioServerTransport());'],env,stderr:'pipe'});stdio.stderr?.resume();await client.connect(stdio);
 for(const mode of ['rest','stdio']){
  const call=async args=>{const input={name:'plan',arguments:{project,agent_id:'t11-agent',action:'update',...args}};
   return unpack(mode==='rest'?(await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:input}})).json().result:await client.callTool(input));};
  const result=await call({plan_id:'P2',description:mode,name:'Offen '+mode,goals:['Transport'],architecture:'Architektur '+mode,plan_prioritaet:'mittel'});
  assert.ok(result.success!==false,JSON.stringify(result));const saved=await P.getPlan(project,'P2');assert.equal(saved.description,mode);assert.equal(saved.architecture,'Architektur '+mode);assert.equal(saved.name,'Offen '+mode);assert.deepEqual(saved.goals,['Transport']);assert.equal(saved.prioritaet,'mittel');
  await call({description:'default '+mode});assert.equal((await P.getPlan(project,'P1')).description,'default '+mode);
  const before=await snapshot(),denied=await call({plan_id:'P3',description:'verboten',plan_prioritaet:'hoch'});
  assert.match(JSON.stringify(denied),/abgeschlossen/);assert.deepEqual(await snapshot(),before);
  console.log('PASS '+mode+': offen/inaktiv, aktiverDefault, fertigerPlan unverändert');
 }
 console.log('PASS P3-T11: leer/mixed/offen/done, alle Metadaten, Priorität, CAS-Rennen, REST+stdio');
}finally{await client?.close();await app?.close();await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await closePool();}
