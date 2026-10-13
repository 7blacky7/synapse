// P20-T18: echter Executor-Kindprozess, ausschließlich eigene guarded Test-DB.
import {oeffneGeschuetzteShellTestDb} from './test-db-schutz.mjs';
import {createServerExecutorIdentity,startServerExecutor,serverExecutorMayClaim} from '../../packages/core/dist/services/server-executor.js';
const schema=process.env.R43_SCHEMA;
if(!/^p20_r43_[0-9]+$/.test(schema??''))throw Error('test_schema_invalid');
const db=await oeffneGeschuetzteShellTestDb();
await db.query('SET search_path TO '+schema+',public');
const identity=createServerExecutorIdentity();
const fence={...identity,nodeId:identity.nodeId,tokenHash:process.env.R43_TOKEN_HASH};
const client={query:db.query.bind(db),release(){}};
const pool={connect:async()=>client};
async function start(){
  return startServerExecutor(fence,async c=>{
    const r=await c.query(`INSERT INTO embedding_knoten(node_id,boot_id,boot_started_at,service_token_hash,host_resource_domain)
      VALUES($1,$2,$3,$4,'r43-host') ON CONFLICT(node_id) DO UPDATE SET
      boot_id=EXCLUDED.boot_id,boot_started_at=EXCLUDED.boot_started_at RETURNING node_id`,
      [fence.nodeId,fence.bootId,fence.bootStartedAt,fence.tokenHash]);
    return r.rows[0]??null;
  },pool);
}
const released=await start();
process.send({ready:true,identity,released,pid:process.pid});
let chain=Promise.resolve();
process.on('message',message=>{
  chain=chain.then(async()=>{
    try{
      const value=message.op==='start'?await start():
        message.op==='mayClaim'?await serverExecutorMayClaim(client,fence,identity.claimOwner):
        message.op==='wrongClaim'?await serverExecutorMayClaim(client,fence,'wrong-owner'):
        message.op==='wrongOwner'?await startServerExecutor({...fence,executorOwner:'foreign'},async()=>({}),pool):
        message.op==='wrongToken'?await startServerExecutor({...fence,tokenHash:'d'.repeat(64)},async()=>({}),pool):
        (()=>{throw Error('unknown_op');})();
      process.send({id:message.id,value});
    }catch(e){process.send({id:message.id,error:e.message});}
  });
});
process.on('SIGTERM',()=>{void chain.finally(async()=>{await db.end();process.exit(0);});});
