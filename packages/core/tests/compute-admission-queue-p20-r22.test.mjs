/** R2.2: öffentliche Queue + echtes Ollama-HTTP; PC-Modus verbietet jede PG-Abfrage. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
const pending=[],starts=[];let aborted=0,active=0,maxActive=0,auto=false;
const server=createServer(async(req,res)=>{
 if(req.url==='/api/tags'){res.end(JSON.stringify({models:[{name:'r22-fixture'}]}));return;}
 assert.equal(req.url,'/api/embed');
 let text='';for await(const data of req)text+=data;const body=JSON.parse(text);
 starts.push({input:body.input,time:Date.now()});active++;maxActive=Math.max(maxActive,active);
 res.on('close',()=>{active--;if(!res.writableEnded)aborted++;});
 if(auto)res.end(JSON.stringify({embeddings:body.input.map(()=>[1,0,0,0])}));
 else pending.push({body,res});
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
Object.assign(process.env,{SYNAPSE_COMPUTE_NODE:'1',SYNAPSE_COMPUTE_ADMISSION:'1',SYNAPSE_NODE_MAX_CONCURRENCY:'2',
 EMBED_MAX_CONCURRENT:'20',EMBED_MIN_GAP_MS:'0',EMBEDDING_PROVIDER:'ollama',
 OLLAMA_MODEL:'r22-fixture',OLLAMA_URL:'http://127.0.0.1:'+server.address().port,
 EMBEDDING_QUERY_PREFIX:'',EMBEDDING_DOC_PREFIX:'',EMBEDDING_NUM_CTX:'512',EMBEDDING_MAX_CHARS:'2048',
 EMBEDDING_TARGET_DIM:'4',QDRANT_URL:'http://127.0.0.1:9',EMBED_OLLAMA_BATCH:'2'});
const emb=await import('../dist/embeddings/index.js'),gate=await import('../dist/services/compute-admission.js');
const {mitLesePool}=await import('../dist/db/client.js');
const trap={query(){throw Error('PC-PG forbidden');},connect(){throw Error('PC-PG forbidden');}};
const acquisitions=[],finishes=[];let waitRelease,shouldWait=false;
gate.configureRemoteComputeAdmission({async acquire(model,context){
 acquisitions.push({model,...context});if(shouldWait){shouldWait=false;await new Promise(r=>{waitRelease=r;});}
 return {id:randomUUID(),token:randomUUID(),domain:'synthetic',state:'running'};
},async finish(lease,confirmed){finishes.push({lease,confirmed});}});
const waitFor=async fn=>{const deadline=Date.now()+5000;while(!fn()){if(Date.now()>deadline)throw Error('queue_timeout');await new Promise(r=>setTimeout(r,5));}};
const complete=p=>p.res.end(JSON.stringify({embeddings:p.body.input.map(()=>[1,0,0,0])}));
test('Aktive Admission: öffentlicher BG-Aufruf läuft trotz Interaktivem ohne Abort weiter',async()=>{
 try{
 await mitLesePool(trap,async()=>{
  const bg=emb.embed('BG',{priority:'background',admissionSource:'parser-worker',strictOllama:true});
  await waitFor(()=>starts.length===1);
  const interactive=emb.embed('INTER',{strictOllama:true});
  await waitFor(()=>starts.length===2);
  assert.deepEqual(starts.map(s=>s.input),[['BG'],['INTER']]);assert.equal(aborted,0);
  assert.equal(emb.getEmbeddingQueueStats().maxConcurrent,2,'PC-eigenes Limit bleibt trotz Serverflag aktiv');
  assert.equal(emb.getEmbeddingQueueStats().preemptedBackground,0);
  pending.splice(0).forEach(complete);await bg;await interactive;
  assert.deepEqual(acquisitions.slice(0,2).map(c=>[c.source,c.priority]),[['parser-worker','hintergrund'],['core-interactive','interaktiv']]);
  assert.equal(finishes.length,2);assert(finishes.every(f=>f.confirmed));
  auto=true;
  const result=await emb.embedBatch(['a','b','c','d','e'],{priority:'background',admissionSource:'wissen-nachzug',strictOllama:true});
  assert.equal(result.length,5);
  assert.equal(acquisitions.filter(c=>c.source==='wissen-nachzug').length,3,'5 Chunks ->3 tatsächliche HTTP-Stapel');
  assert.equal(maxActive<=2,true);
  // Tatsächliche PG-Wartezeit wird simuliert, bleibt aber innerhalb der öffentlichen Queue.
  shouldWait=true;
  const waiting=emb.embed('WAIT',{priority:'background',admissionSource:'media-code',strictOllama:true});
  await waitFor(()=>!!waitRelease);
  assert.equal(emb.getEmbeddingQueueStats().active.background,0,'Warten belegt keinen lokalen Slot');
  const quick=emb.embed('QUICK',{strictOllama:true});await quick;
  waitRelease();await waiting;
  const stats=emb.getEmbeddingQueueStats();assert.equal(stats.active.background+stats.active.interactive,0);
  assert.equal(stats.preemptedBackground,0);assert.equal(aborted,0);
  assert.equal(finishes.length,7);assert(finishes.every(f=>f.confirmed));
 });
 }finally{
  gate.configureRemoteComputeAdmission(null);pending.splice(0).forEach(complete);server.closeAllConnections();await new Promise(r=>server.close(r));
 }
});
