/**
 * P3-T15: Core + REST + echtes stdio; private Schema in synapse_test, HTTP-Doubles für Qdrant/Ollama.
 * cwd: Repo-Root; node packages/core/tests/plan-search-p3-t15.test.mjs
 * Basis-Rotkontrolle: P3_T15_ROOT=/tmp/<gebauter-t98-Checkout> node <diese-Testdatei>
 * Keine Live-Registry, kein echter Daemon, keine echte Embedding-/Qdrant-Instanz.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {pruefeTestDbUrl} from '../../../scripts/lib/test-db-schutz.mjs';
pruefeTestDbUrl('P3-T15');
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.port, '5433'); assert.equal(url.pathname, '/synapse_test');
const schema = 'p3t15_' + randomUUID().replaceAll('-', '');
const project = 'p3-t15-' + randomUUID();
url.searchParams.set('options', '-c search_path=' + schema + ',public');
const repo = process.env.P3_T15_ROOT ? pathToFileURL(process.env.P3_T15_ROOT.replace(/\/$/, '') + '/') : new URL('../../../', import.meta.url);
const load = p => import(new URL(p, repo).href);
const points = new Map(), embedTexts = [], requests = [];
const probeTitle='P3-T15 ONLY TASK TEXT';
let contentProbe=false, failUpsert = false, duringEmbed, app, client, pool, db;
const matches = (p, f) => {
 if (!f) return true;
 const clause = c => c.has_id ? c.has_id.map(String).includes(String(p.id))
   : c.key ? (c.match?.any ? c.match.any.includes(c.key.split('.').reduce((v,k)=>v?.[k],p.payload))
       : c.key.split('.').reduce((v,k)=>v?.[k],p.payload) === c.match?.value) : matches(p,c);
 return (f.must??[]).every(clause) && !(f.must_not??[]).some(clause)
   && (!(f.should??[]).length || f.should.some(clause));
};
const server = http.createServer((req, res) => {
 let raw=''; req.on('data', d => raw += d); req.on('end', async () => {
  try {
   const path = new URL(req.url,'http://localhost').pathname, body = raw ? JSON.parse(raw) : {};
   requests.push({path,body});
   const reply = result => {res.setHeader('content-type','application/json'); res.end(JSON.stringify({result,status:'ok',time:0}));};
   if (path==='/') return res.end(JSON.stringify({title:'test',version:'1.15.0'}));
   if (path==='/api/tags') return res.end(JSON.stringify({models:[{name:'p3-t15-fake',digest:'a'.repeat(64)}]}));
   if (path==='/api/embed') {
    const texts=Array.isArray(body.input)?body.input:[body.input]; embedTexts.push(...texts);
    if (duringEmbed) {const fn=duringEmbed; duringEmbed=undefined; await fn();}
    res.setHeader('content-type','application/json'); return res.end(JSON.stringify({embeddings:texts.map(t=>contentProbe&&t.includes(probeTitle)?[0,1,0,0]:[1,0,0,0])}));
   }
   if (path==='/collections') return reply({collections:[...points.keys()].map(name=>({name}))});
   const col=decodeURIComponent(path.split('/')[2]??'');
   if (!points.has(col)) points.set(col,new Map());
   const data=points.get(col);
   if (path.endsWith('/points/search')) {
    const hits=[...data.values()].filter(p=>matches(p,body.filter)).map(p=>({id:p.id,payload:p.payload,score:contentProbe?p.vector.reduce((n,v,i)=>n+v*(body.vector[i]??0),0):(p.score??0.9),version:0})).sort((a,b)=>b.score-a.score);
    return reply(hits.slice(body.offset??0,(body.offset??0)+body.limit));
   }
   if (path.endsWith('/points/delete')) {
    for (const [id,p] of data) if (body.points?.map(String).includes(String(id)) || (body.filter&&matches(p,body.filter))) data.delete(id);
    return reply({status:'completed',operation_id:1});
   }
   if (req.method==='PUT' && path.endsWith('/points')) {
    if (failUpsert) {res.statusCode=500;return res.end(JSON.stringify({status:{error:'geplanter Ausfall'}}));}
    for (const p of body.points) data.set(String(p.id),p);
    return reply({status:'completed',operation_id:1});
   }
   if (path.endsWith('/points/count')) return reply({count:data.size});
   if (path.endsWith('/points/scroll')) return reply({points:[...data.values()],next_page_offset:null});
   if (path.endsWith('/points')) return reply([...data.values()].filter(p=>body.ids?.map(String).includes(String(p.id))));
   return reply({config:{params:{vectors:{size:4,distance:'Cosine'}}},points_count:data.size});
  } catch (e) {res.statusCode=500;res.end(JSON.stringify({error:String(e)}));}
 });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const fake='http://127.0.0.1:'+server.address().port;
Object.assign(process.env,{
 DATABASE_URL:url.toString(), SYNAPSE_DATABASE_URL:url.toString(), SYNAPSE_SCHEMA:'aus',
 EMBEDDING_PROVIDER:'ollama', OLLAMA_URL:fake, OLLAMA_MODEL:'p3-t15-fake', QDRANT_URL:fake,
 SKILL_QDRANT_URL:fake, EMBEDDING_TARGET_DIM:'4', EMBEDDING_PRAEFIXE:'aus',
 EMBED_MIN_GAP_MS:'0', EMBEDDING_MAX_INPUT_CHARS:'100000', SYNAPSE_OLLAMA_MODEL_DIGEST:'a'.repeat(64),
 SCORE_SCHWELLE_TASKS:'0.8', JEV_OPENROUTER_API_KEY:'', SYNAPSE_COMPUTE_ADMISSION:'0',
});
const unpack = r => {let x=r?.structuredContent??r;while(x?.content?.[0]?.text)x=JSON.parse(x.content[0].text);return x;};
try {
 const core=await load('packages/core/dist/index.js');

 db=await load('packages/core/dist/db/client.js');pool=db.getPool();
 await pool.query('CREATE SCHEMA "'+schema+'"');
 for (const {tablename} of (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows) {
  const q='"'+tablename.replaceAll('"','""')+'"';
  await pool.query('CREATE TABLE "'+schema+'".'+q+' (LIKE public.'+q+' INCLUDING ALL)');
 }
 await pool.query('ALTER TABLE chat_lesestand ADD COLUMN IF NOT EXISTS letzte_hinweis_id INTEGER NOT NULL DEFAULT 0');
 // Inhaltliche Positivkontrolle: alter Planindex bettet ausschließlich Plantext ein.
 // Echte Embedding-/Qdrant-Wege, Double trennt Taskmarker-Vektor und unpassenden Plantext.
 if (typeof core.searchTasks==='function') await pool.query((await load('packages/core/dist/db/plan-task-schema.js')).PLAN_TASK_SCHEMA_SQL);
 const probePlans=await load('packages/core/dist/services/plans.js');
 contentProbe=true;
 const probePlan=await probePlans.createPlan(project,'Unrelated plan','Unrelated plan text',[]);
 await probePlans.addTask(project,probeTitle,'Beschreibung nur in der Task','high',probePlan.id);
 let probeResults;
 if(typeof core.searchTasks==='function') probeResults=(await core.searchTasks(probeTitle,project)).results;
 else {
  const E=await load('packages/core/dist/embeddings/index.js'),Q=await load('packages/core/dist/qdrant/index.js');
  const legacy=await Q.searchVectors('project_'+project+'_plans',await E.embed(probeTitle,{art:'query'}),10,{must:[{key:'project',match:{value:project}}]});
  probeResults=legacy.filter(h=>h.score>=Number(process.env.SCORE_SCHWELLE_TASKS)).flatMap(h=>h.payload.tasks??[]);
 }
 assert.equal(probeResults.some(t=>t.title===probeTitle),true,'RED t98: Task-Text wird im semantischen Index nicht gefunden');
 contentProbe=false;
 await probePlans.deletePlan(project,probePlan.id);
 for(const col of points.keys())if(col.startsWith('project_'+project+'_'))points.delete(col);
 console.log('PASS inhaltliche Positivkontrolle: Tasktext über Einzelvektor gefunden');
 const {PLAN_TASK_SCHEMA_SQL}=await load('packages/core/dist/db/plan-task-schema.js');
 const P=await load('packages/core/dist/services/plans.js'), S=await load('packages/core/dist/services/plan-suche.js');
 const originalPlanIndex=P.planIndex.sync;P.planIndex.sync=async()=>{};
 const bootTaskSync=S.taskIndex.sync;S.taskIndex.sync=async()=>{};
 const schalter=await load('packages/core/dist/services/intern-schalter.js');
 await schalter.setzeSchalter('embedding',{aktiv:false,agent:'p3t15-fixture'});
 assert.equal((await core.searchTasks('leerer Bestand',project)).count,0);
 assert.equal((await core.searchPlans('leerer Bestand',project)).count,0);
 const p1=await P.createPlan(project,'Embedding','Nachzug und Index',[]), p2=await P.createPlan(project,'Werkzeuge','Semantische Suche',[],{prioritaet:'hoch'});
 // Bestand vor Migration: danach einmalige Projektion und Marker bei Wiederholung erhalten.
 await pool.query('DROP TRIGGER IF EXISTS trg_plan_tasks_sync ON plans');
 const existing={id:randomUUID(),kurz_id:'P1-T1',title:'Bestand',description:'bestehende Aufgabe',status:'todo',priority:'high',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z'};
 await pool.query('UPDATE plans SET tasks=$1::jsonb, naechste_task_nr=2 WHERE id=$2',[JSON.stringify([existing]),p1.id]);
 await pool.query(PLAN_TASK_SCHEMA_SQL);
 assert.equal((await pool.query('SELECT count(*)::int n FROM plan_tasks WHERE project=$1',[project])).rows[0].n,1);
 S.taskIndex.sync=bootTaskSync;
 await S.taskIndex.sync(await P.getPlan(project,p1.id));
 assert.ok((await pool.query('SELECT embedded_at FROM plan_tasks WHERE id=$1',[existing.id])).rows[0].embedded_at);
 const marker=(await pool.query('SELECT embedded_at FROM plan_tasks WHERE id=$1',[existing.id])).rows[0].embedded_at;
 await pool.query(PLAN_TASK_SCHEMA_SQL);
 assert.deepEqual((await pool.query('SELECT embedded_at FROM plan_tasks WHERE id=$1',[existing.id])).rows[0].embedded_at,marker,'Bestandsnachzug idempotent');
 const a=await P.addTask(project,'Taskindex','Titel und Beschreibung', 'high',p1.id);
 assert.equal(a.aehnlich[0].id,existing.id,'kalibrierter Hinweis, Speicherung nicht blockiert');
 assert.equal(points.get('project_'+project+'_tasks').get(a.id).payload.plan_id,p1.id);
 assert.equal(points.get('project_'+project+'_tasks').get(a.id).payload.kurz_id,a.kurz_id);
 assert.ok(embedTexts.includes('Taskindex\nTitel und Beschreibung'),'Dokumenttext Titel+Beschreibung');
 const batch=await P.addTasksBatch(project,[{title:'Suche A',description:'finden'},{title:'Suche B',description:'auch finden'}],p1.id);
 assert.equal(batch.tasks.length,2);assert.equal(batch.aehnlich.length,2);
 assert.ok(batch.tasks.every(t=>t.aehnlich.length>0),'Batch hat je Task Hinweise');
 assert.ok(batch.tasks[0].aehnlich.some(x=>x.id===batch.tasks[1].id),'Dubletten innerhalb desselben Batches');
 assert.ok(batch.tasks.every(t=>!t.aehnlich.some(x=>x.id===t.id)),'Keine Selbsttreffer');
 // PG ist autoritativ, selbst bei falscher Payload. Orphans werden gezählt.
 const taskCol=points.get('project_'+project+'_tasks'),ghost=randomUUID();
 taskCol.set(ghost,{id:ghost,payload:{project},score:0.99});
 Object.assign(taskCol.get(a.id).payload,{title:'ALT',status:'done',plan_id:p2.id});taskCol.get(a.id).score=0.96;
 let r=await core.searchTasks('Taskindex',project,{status:'todo',priority:'high',plan_id:'P1',mit_verknuepfungen:true});
 assert.equal(r.verworfen_ohne_pg,1);assert.ok(r.results.some(t=>t.id===a.id&&t.title==='Taskindex'&&t.plan.id===p1.id&&t.status==='todo'));
 await P.updateTask(project,a.id,{status:'in_progress',title:'Taskindex neu'});
 await P.aendereTasks(project,p1.id,tasks=>({tasks:tasks.map(t=>t.id===a.id?{...t,zugewiesen_an:'test-agent'}:t),ergebnis:null}));
 r=await core.searchTasks('Taskindex',project,{status:'in_progress',priority:'high'});
 assert.equal(r.results[0].title,'Taskindex neu');assert.equal(r.results[0].zugewiesen_an,'test-agent');
 const nz=await load('packages/core/dist/services/embed-nachzug.js');
 const current=(await S.taskNachzug.lese([S.taskIndexKey(project,a.id)]))[0];
 assert.ok(current.stand.startsWith((await P.getPlan(project,p1.id)).tasks.find(t=>t.id===a.id).updatedAt));
 // Geänderte Payload bei unverändertem updatedAt darf keine alte Einbettung quittieren.
 await P.aendereTasks(project,p1.id,tasks=>({tasks:tasks.map(t=>t.id===a.id?{...t,zugewiesen_an:'anderer-agent'}:t),ergebnis:null}));
 assert.equal(await nz.markiereEingebettet(S.taskNachzug,[current]),0,'CAS bindet Timestamp UND Payload');
 const thoughtA=randomUUID(),thoughtB=randomUUID();
 await pool.query('INSERT INTO thoughts(id,project,source,content,tags,task_id,timestamp) VALUES($1,$2,\'fixture\',\'Report A\',$3,$4,\'2026-01-01\'),($5,$2,\'fixture\',\'Report B\',$3,$6,\'2026-02-01\')',[thoughtA,project,[],a.kurz_id,thoughtB,batch.tasks[0].id]);
 const versions=await pool.query('INSERT INTO file_versions(project,file_path,content,content_hash,task_id,created_at) VALUES($1,\'a.ts\',\'\',\'h\',$2,\'2026-01-01\'),($1,\'b.ts\',\'\',\'h\',$3,\'2026-02-01\') RETURNING id::text',[project,a.id,batch.tasks[0].id]);
 r=await core.searchTasks('Taskindex',project,{status:'in_progress',mit_verknuepfungen:true});
 assert.deepEqual(r.results[0].pins,{thoughts:1,dateiversionen:1,thought_ids:[thoughtA],dateiversion_ids:[versions.rows[0].id]});
 P.planIndex.sync=originalPlanIndex;await P.planIndex.sync(await P.getPlan(project,p1.id));await P.planIndex.sync(await P.getPlan(project,p2.id));P.planIndex.sync=async()=>{};
 r=await core.searchPlans('Embedding',project,{plan_id:'P1',mit_verknuepfungen:true});
 assert.equal(r.results[0].pins.thoughts,2);assert.equal(r.results[0].pins.dateiversionen,2);
 assert.deepEqual(r.results[0].pins.thought_ids,[thoughtB,thoughtA],'Plan-Pins global jüngste IDs');
 assert.deepEqual(r.results[0].pins.dateiversion_ids,[versions.rows[1].id,versions.rows[0].id]);
 // Schlafende Tasks und Pläne, über alle Status sichtbar mit alle:true.
 await P.zurueckstelleTask(project,p1.id,batch.tasks[0].id,{tage:2});
 assert.ok(!(await core.searchTasks('Suche',project)).results.some(t=>t.id===batch.tasks[0].id));
 assert.ok((await core.searchTasks('Suche',project,{alle:true})).results.some(t=>t.id===batch.tasks[0].id&&t.zurueckgestellt));
 await P.zurueckstellePlan(project,p2.id,{tage:2});
 assert.equal((await core.searchPlans('Werkzeuge',project,{plan_id:'P2'})).count,0);
 assert.equal((await core.searchPlans('Werkzeuge',project,{plan_id:'P2',alle:true,priority:'hoch'})).count,1);
 // Verschieben aktualisiert eigene Vektorpayload/Projektion, alte Kurz-ID bleibt verwendbar.
 const oldAlias=a.kurz_id;const moved=await P.verschiebeTasks(project,a.id,'P2');assert.equal(moved.success,true);
 assert.equal((await pool.query('SELECT plan_id FROM plan_tasks WHERE id=$1',[a.id])).rows[0].plan_id,p2.id);
 assert.equal(taskCol.get(a.id).payload.plan_id,p2.id);assert.equal(await S.thoughtTaskFilter(project,oldAlias),a.id);
 const T=await load('packages/core/dist/services/thoughts.js');
 await nz.betteStapelEin(T.thoughtNachzug,[thoughtA,thoughtB],{priority:'interactive'});
 assert.deepEqual((await T.searchThoughts('Report',project,10,oldAlias)).map(t=>t.id),[thoughtA]);
 assert.deepEqual((await T.searchThoughts('Report',project,10,a.id)).map(t=>t.id),[thoughtA]);
 assert.equal((await core.searchTasks('Taskindex',project,{alle:true,status:'in_progress',mit_verknuepfungen:true})).results[0].pins.thoughts,1,'Pins erkennen rohe alte Kurz-ID nach Verschieben');
 // Plan-Index-Ausfall darf Task-Index nicht verhindern.
 P.planIndex.sync=async()=>{throw new Error('geplanter Plan-Index-Ausfall');};
 const independent=await P.updateTask(project,batch.tasks[1].id,{title:'Unabhängiger Taskindex'});
 assert.match(independent.warning,/Qdrant-Write/);assert.equal(taskCol.get(batch.tasks[1].id).payload.updatedAt,independent.updatedAt);
 P.planIndex.sync=async()=>{};
 await assert.rejects(P.addTask(project,'Ungültig','Priorität','hoch',p1.id),/Task-Priorität/);
 await assert.rejects(P.updateTask(project,existing.id,{priority:'hoch'}),/Task-Priorität/);
 // PG bleibt gespeichert bei Qdrant-Ausfall, Marker NULL; gedrosselter Nachzug repariert.
 failUpsert=true;const failed=await P.addTask(project,'Ausfall','Nachholen', 'medium',p1.id);
 assert.match(failed.warning,/Task/);assert.equal((await pool.query('SELECT embedded_at FROM plan_tasks WHERE id=$1',[failed.id])).rows[0].embedded_at,null);
 failUpsert=false;const backlog=await load('packages/core/dist/services/embed-backlog.js');
 const recovered=await backlog.embeddeOffeneEintraege(200,project,'plan_tasks');assert.ok(recovered.nachgetragen>0);
 assert.ok(taskCol.has(failed.id));assert.ok((await pool.query('SELECT embedded_at FROM plan_tasks WHERE id=$1',[failed.id])).rows[0].embedded_at);
 // Rennen im Embed: neue Beschreibung nach Lesen -> alter Marker darf nicht gewinnen.
 await pool.query('UPDATE plan_tasks SET embedded_at=NULL WHERE id=$1',[failed.id]);
 duringEmbed=()=>P.updateTask(project,failed.id,{description:'neuer Stand nach Lesen'});
 // Task-Sync im Rennen unterdrücken, damit der Versuch und der nächste Nachzug getrennt sichtbar sind.
 const realTaskSync=S.taskIndex.sync;S.taskIndex.sync=async()=>{};
 await nz.betteEinzelnEin(S.taskNachzug,S.taskIndexKey(project,failed.id),{priority:'interactive'});
 assert.equal((await pool.query('SELECT embedded_at FROM plan_tasks WHERE id=$1',[failed.id])).rows[0].embedded_at,null);
 S.taskIndex.sync=realTaskSync;await backlog.embeddeOffeneEintraege(200,project,'plan_tasks');
 assert.ok((await pool.query('SELECT embedded_at FROM plan_tasks WHERE id=$1',[failed.id])).rows[0].embedded_at);
 // Zweck kalibrierbar und ohne Wert kein stiller Ersatz.
 const {modellprofilKalibrieren}=await load('packages/core/dist/services/intern-modellprofil.js');
 const calibrated=await modellprofilKalibrieren({zweck:'tasks',passend:[{query:'Taskindex',erwartet:'Taskindex'}],rauschen:['unpassend'],project,schreiben:false});
 assert.ok(calibrated,'tasks ist kalibrierbarer Zweck');
 delete process.env.SCORE_SCHWELLE_TASKS;
 const noProfile=await P.addTask(project,'Ohne Schwelle','Hinweis', 'medium',p1.id);
 assert.deepEqual(noProfile.aehnlich,[]);assert.match(noProfile.aehnlich_hinweis,/kalibriert|Profil|profil/);
 process.env.SCORE_SCHWELLE_TASKS='0.8';
 // Beide tatsächlichen Tool-Strecken, Definitionen + Filter + Pin-Details.
 const req=createRequire(new URL('packages/rest-api/package.json',repo));app=req('fastify')({logger:false});
 await app.register((await load('packages/rest-api/dist/routes/mcp.js')).mcpRoutes);await app.ready();
 const {Client}=await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StdioClientTransport}=await load('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
 client=new Client({name:'p3t15-test',version:'1'});
 const env={...process.env};delete env.SYNAPSE_AGENT_NAME;
 const prelude='const P=await import('+JSON.stringify(new URL('packages/core/dist/services/plans.js',repo).href)+');P.planIndex.sync=async()=>{};'+
  'const {createServer}=await import('+JSON.stringify(new URL('packages/mcp-server/dist/server.js',repo).href)+');'+
  'const {StdioServerTransport}=await import('+JSON.stringify(new URL('packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js',repo).href)+');await createServer().connect(new StdioServerTransport());';
 const transport=new StdioClientTransport({command:process.execPath,args:['--input-type=module','--eval',prelude],env,stderr:'pipe'});transport.stderr?.resume();await client.connect(transport);
 for (const mode of ['rest','stdio']) {
  const call=async(name,args)=> {
   const input={name,arguments:{project,agent_id:'p3t15-agent',...args}};
   if(mode==='stdio')return unpack(await client.callTool(input));
   const answer=(await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:input}})).json();
   assert.ok(!answer.error,JSON.stringify(answer));return unpack(answer.result);
  };
  const listed=mode==='stdio'?await client.listTools():(await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}})).json().result;
  const searchDef=listed.tools.find(t=>t.name==='search'),planDef=listed.tools.find(t=>t.name==='plan');
  assert.ok(searchDef.inputSchema.properties.action.enum.includes('tasks'));assert.ok(searchDef.inputSchema.properties.action.enum.includes('plans'));
  assert.ok(planDef.inputSchema.properties.action.enum.includes('search'));assert.ok(searchDef.inputSchema.properties.task_id);
  assert.ok(searchDef.inputSchema.properties.mit_verknuepfungen);assert.ok(planDef.inputSchema.properties.art);
  const args={query:'Taskindex',status:'in_progress',plan_id:'P2',priority:'high',alle:true,mit_verknuepfungen:true};
  const direct=await call('search',{action:'tasks',...args}),viaPlan=await call('plan',{action:'search',...args});
  assert.equal(direct.count,1,mode+' Task-Suche');assert.equal(direct.results[0].id,a.id);
  assert.deepEqual(viaPlan.results,direct.results);assert.equal(direct.results[0].pins.thoughts,1);
  const plans=await call('search',{action:'plans',query:'Werkzeuge',plan_id:'P2',priority:'hoch',alle:true});
  assert.equal(plans.count,1);assert.equal((await call('plan',{action:'search',art:'plans',query:'Werkzeuge',plan_id:'P2',priority:'hoch',alle:true})).count,1);
  const thoughts=await call('search',{action:'thoughts',query:'Report',task_id:oldAlias});
  assert.ok(JSON.stringify(thoughts).includes(thoughtA));assert.ok(!JSON.stringify(thoughts).includes(thoughtB));
  const added=await call('plan',{action:'add_task',plan_id:'P1',title:'Transport '+mode,description:'Dublettenhinweis'});
  assert.ok((added.aehnlich??added.task?.aehnlich)?.length>0,mode+' add_task liefert Hinweis');
  const addedBatch=await call('plan',{action:'add_tasks_batch',plan_id:'P1',tasks:[{title:'Batch '+mode,description:'Hinweis'}]});
  assert.ok(addedBatch.aehnlich?.length>0,mode+' Batch-Hinweise');
  console.log('PASS '+mode+': search(tasks/plans), plan(search), Filter, Pins, Alias-Thoughts, Dubletten');
 }

 // Review HOCH: doppelte IDs im Altbestand blockieren Plan-Schreibaktionen nicht.
 const duplicatePlan=await P.createPlan(project,'Duplikate','Legacy-Array',[]);
 const doubleId=randomUUID(),doubleTask={...existing,id:doubleId,kurz_id:duplicatePlan.kurz_id+'-T1',title:'Erste Position'};
 const notices=[];const notice=n=>notices.push(n.message);
 const noticeClient=await pool.connect();noticeClient.on('notice',notice);
 try {
  await noticeClient.query('UPDATE plans SET tasks=$1::jsonb WHERE id=$2',[JSON.stringify([doubleTask,{...doubleTask,title:'Letzte Position'}]),duplicatePlan.id]);
 } finally {noticeClient.off('notice',notice);noticeClient.release();}
 const editedDouble=await P.updateTask(project,doubleId,{title:'Schreibaktion funktioniert'},duplicatePlan.id);
 assert.equal(editedDouble.title,'Schreibaktion funktioniert');
 const duplicateRows=(await pool.query('SELECT task FROM plan_tasks WHERE project=$1 AND id=$2',[project,doubleId])).rows;
 assert.equal(duplicateRows.length,1);assert.equal(duplicateRows[0].task.title,'Letzte Position','Letzte Position gewinnt deterministisch');
 assert.ok(notices.some(n=>n.includes('doppelte Task-ID')),'NOTICE statt Plan-Abbruch');
 await pool.query('DELETE FROM plan_tasks WHERE project=$1 AND id=$2',[project,doubleId]);
 await pool.query(PLAN_TASK_SCHEMA_SQL);
 assert.equal((await pool.query('SELECT task FROM plan_tasks WHERE project=$1 AND id=$2',[project,doubleId])).rows[0].task.title,'Letzte Position','Auch Bestandsübernahme dedupliziert');
 // Review MITTEL: dieselbe Task-UUID in zwei Projekten, getrennte Marker und Collections.
 const otherProject=project+'-copy',otherPlan=await P.createPlan(otherProject,'Kopie','Anderes Projekt',[]);
 const otherTask={...(await P.getPlan(project,'P2')).tasks.find(t=>t.id===a.id),title:'Kopie in anderem Projekt',kurz_id:otherPlan.kurz_id+'-T1'};
 await pool.query('UPDATE plans SET tasks=$1::jsonb WHERE id=$2',[JSON.stringify([otherTask]),otherPlan.id]);
 await S.taskIndex.sync(await P.getPlan(otherProject,otherPlan.id));
 const sameIdRows=(await pool.query('SELECT project,key,task FROM plan_tasks WHERE id=$1 ORDER BY project',[a.id])).rows;
 assert.equal(sameIdRows.length,2);assert.notEqual(sameIdRows[0].key,sameIdRows[1].key);
 const pair=await S.taskNachzug.lese([S.taskIndexKey(project,a.id),S.taskIndexKey(otherProject,a.id)]);
 assert.equal(pair.length,2);assert.ok(pair.every(p=>p.payload.task_id===a.id));
 assert.equal((await core.searchTasks('Kopie',otherProject)).results[0].title,'Kopie in anderem Projekt');
 assert.ok((await core.searchTasks('Original',project,{alle:true})).results.some(t=>t.id===a.id&&t.title==='Taskindex neu'));
 await pool.query('UPDATE plan_tasks SET embedded_at=NULL WHERE id=$1',[a.id]);
 const originalPoint=pair.find(p=>p.project===project);
 assert.equal(await nz.markiereEingebettet(S.taskNachzug,[originalPoint]),1,'Quittierung nur eines Projekt-Schlüssels');
 assert.equal((await pool.query('SELECT embedded_at FROM plan_tasks WHERE project=$1 AND id=$2',[otherProject,a.id])).rows[0].embedded_at,null);
 await S.embeddeTaskNach(otherProject,a.id);
 assert.equal(points.get('project_'+otherProject+'_tasks').get(a.id).payload.project,otherProject);
 await P.deletePlan(otherProject,otherPlan.id);
 assert.equal((await pool.query('SELECT count(*)::int n FROM plan_tasks WHERE project=$1 AND id=$2',[project,a.id])).rows[0].n,1,'Löschen in Kopie erhält Original');
 assert.ok(taskCol.has(a.id),'Collection des Originals bleibt erhalten');
 // Review NIEDRIG: ein Write embedddet nur seine Änderung, nicht den offenen Bestand.
 const oldPlan=await P.createPlan(project,'Backfill','Viele alte Tasks',[]);
 const oldTasks=Array.from({length:3},(_,i)=>({...existing,id:randomUUID(),kurz_id:oldPlan.kurz_id+'-T'+(i+1),title:'Alter Bestand '+i}));
 await pool.query('UPDATE plans SET tasks=$1::jsonb WHERE id=$2',[JSON.stringify(oldTasks),oldPlan.id]);
 const inputsBefore=embedTexts.length;
 await P.updateTask(project,oldTasks[0].id,{title:'Eine Änderung'},oldPlan.id);
 assert.deepEqual(embedTexts.slice(inputsBefore),['Eine Änderung\n'+oldTasks[0].description],'Nur geänderte Task synchron eingebettet');
 assert.equal((await pool.query('SELECT count(*)::int n FROM plan_tasks WHERE project=$1 AND plan_id=$2 AND embedded_at IS NULL',[project,oldPlan.id])).rows[0].n,2);
 await backlog.embeddeOffeneEintraege(200,project,'plan_tasks');
 assert.equal((await pool.query('SELECT count(*)::int n FROM plan_tasks WHERE project=$1 AND plan_id=$2 AND embedded_at IS NULL',[project,oldPlan.id])).rows[0].n,0,'Bestand wird vom Backlog eingebettet');
 console.log('PASS Review P3-T15: doppelte IDs/NOTICE, Projektkopie/Marker/Delete, nur geänderte Tasks synchron');

 await P.deleteTasks(project,[a.id]);assert.ok(!taskCol.has(a.id));assert.equal((await pool.query('SELECT count(*)::int n FROM plan_tasks WHERE id=$1',[a.id])).rows[0].n,0);
 await P.deletePlan(project,p1.id);assert.equal((await pool.query('SELECT count(*)::int n FROM plan_tasks WHERE plan_id=$1',[p1.id])).rows[0].n,0);
 assert.ok([...taskCol.values()].every(x=>x.payload.plan_id!==p1.id||x.id===ghost));
 assert.ok(requests.filter(x=>x.path.includes(project)&&x.path.endsWith('/points/search')).every(x=>x.body.filter?.must?.some(f=>f.key==='project'&&x.path.includes('/project_'+f.match?.value+'_'))),'Projektfilter nie vergessen');
 const {baueOnboardingRegelwerk}=await load('packages/core/dist/services/agent-rollen.js');
 const rules=baueOnboardingRegelwerk([{name:'regel-erst-suchen-dann-widersprechen',content:'Regeltext',category:'rules',tags:['pflicht']}],project,'koordinator');
 assert.match(rules.rules[0].content,/search\(tasks\)/);
 console.log('PASS P3-T15: Bestand, CAS, PG-Text, Orphans, Pins, Schlaf/Alias, Ausfall/Nachzug, Kalibrierung, REST+stdio, Löschen');
} finally {
 await client?.close();await app?.close();
 if(pool)await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');
 await db?.closePool();server.closeAllConnections();await new Promise(r=>server.close(r));
}
