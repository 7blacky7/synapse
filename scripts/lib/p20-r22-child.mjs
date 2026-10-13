/** R2.2: zweiter realer Prozess, guarded PG und echtes Ollama-HTTP-Blatt. */
import {r22Pool} from './p20-r22-db.mjs';
const pool=await r22Pool(process.env.R22_SCHEMA);
const core=await import('../../packages/core/dist/services/compute-admission.js');
const {mitLesePool}=await import('../../packages/core/dist/db/client.js');
const {OllamaEmbeddingProvider}=await import('../../packages/core/dist/embeddings/ollama.js');
const service=core.createComputeAdmission(pool),provider=new OllamaEmbeddingProvider();
process.send({ready:true,pid:process.pid});
process.on('message',async m=>{
 try{
  let value;
  if(m.action==='attempt')value=await service.attempt(m.input);
  else if(m.action==='finish')value=await service.finish(m.identity,m.lease,m.confirmed);
  else if(m.action==='embed'){
   core.configureLocalComputeAdmission(m.identity);
   value=await mitLesePool(pool,()=>core.mitComputeAdmissionKontext({source:m.source,priority:m.priority},()=>provider.embedRaw([m.text])));
  }else throw Error('unknown_child_action');
  process.send({id:m.id,value});
 }catch(e){process.send({id:m.id,error:e.code??e.message});}
});
process.on('disconnect',async()=>{await pool.end();process.exitCode=0;});
