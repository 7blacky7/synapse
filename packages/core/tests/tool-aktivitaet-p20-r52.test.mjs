/** R5.2: nur synapse_test, eigener Bereich p20_r52. Golden vor Produktion erfasst. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
// Baseline consumes the identical immutable golden expectations, never writes its worktree.
const basis=process.env.SYNAPSE_R52_BASIS;
if(basis)assert.equal(basis,'/tmp/synapse-basis-7cd5ddb');
const dist=basis?'file://'+basis+'/packages/core/dist/':'../dist/';
const {getPool,closePool}=await import(dist+'db/client.js');
const {logToolCall,queryToolCalls}=await import(dist+'services/tool-call-log.js');
const pool=getPool(),P='p20_r52_'+randomUUID(),S='p20_r52_'+randomUUID().replaceAll('-','');
const normal=rows=>rows.map(({id,ts,...row})=>row);
try {
 await logToolCall({project:P,agentId:'sol-7-test',tool:'reverse',action:'inspect',argsPreview:'{"fixture":true}',ok:true,durationMs:7,result:'{"success":true}'});
 const base={project:P,agent_id:'sol-7-test',source:null,tool_name:'reverse',action:'inspect',args_preview:'{"fixture":true}',ok:true,error:null,duration_ms:7,is_mutation:false};
 assert.deepEqual(normal(await queryToolCalls({project:P})),[base]);
 assert.deepEqual(normal(await queryToolCalls({project:P,detail:'summary'})),[{...base,result_bytes:16,result_truncated:false,result_preview:'{"success":true}'}]);
 assert.deepEqual(normal(await queryToolCalls({project:P,detail:'full'})),[{...base,result_bytes:16,result_truncated:false,result:'{"success":true}'}]);
 assert.deepEqual(await queryToolCalls({project:P,status:'error'}),[]);
 console.log('GOLDEN tool_calls meta/summary/full/filter unchanged');
 if(process.argv.includes('--golden'))process.exitCode=0;
 else {
  const m=await import('../dist/services/tool-aktivitaet.js');
  const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../dist/db/tool-aktivitaet-schema.js');
  const c=await pool.connect();
  try {
   await c.query('CREATE SCHEMA '+S);
   await c.query('SET search_path TO '+S);
   await c.query(TOOL_AKTIVITAET_SCHEMA_SQL);await c.query(TOOL_AKTIVITAET_SCHEMA_SQL);
   const descriptor={toolId:'reverse-fixture',tool:'reverse',aktivitaetsAktionen:['inspect','status','heartbeat']};
   const ctx={descriptor,gebundenesProjekt:P,berechtigt:true};
   const entry={project:P,tool:'reverse',aktion:'inspect',agentId:'sol-7-test',containerId:'container-fixture',jobId:'job-fixture',akzeptiert:true,zaehltAlsAktivitaet:true};
   const accepted=await m.erfasseToolAktivitaet(entry,ctx,c);
   assert.equal(accepted.zaehlt_als_aktivitaet,true);
   assert(accepted.zeit instanceof Date);
   for(const [patch,context] of [
    [{akzeptiert:false},ctx],[{}, {...ctx,berechtigt:false}],[{project:'foreign'},ctx],
    [{tool:'admin'},ctx],[{aktion:'status'},ctx],[{aktion:'heartbeat'},ctx],
    [{aktion:'unknown'},ctx],[{zaehltAlsAktivitaet:false},ctx]
   ]) assert.equal((await m.erfasseToolAktivitaet({...entry,...patch},context,c)).zaehlt_als_aktivitaet,false);
   const query={project:P,toolId:descriptor.toolId,tool:'reverse',fensterSekunden:60};
   assert.deepEqual((await m.letzteToolAktivitaet(query,c)).map(x=>x.id),[accepted.id]);
   assert.deepEqual(await m.letzteToolAktivitaet({...query,project:'foreign'},c),[]);
   assert.deepEqual(await m.letzteToolAktivitaet({...query,containerId:'foreign'},c),[]);
   assert.deepEqual(await m.letzteToolAktivitaet({...query,toolId:'foreign'},c),[]);
   // Mehrere gleichzeitige Calls: numerische Sequenz gewinnt auch bei gleicher PG-Zeit.
   await c.query('BEGIN');
   const tie1=await m.erfasseToolAktivitaet(entry,ctx,c);
   const tie2=await m.erfasseToolAktivitaet(entry,ctx,c);
   assert.equal(+tie1.zeit,+tie2.zeit);
   assert.deepEqual((await m.letzteToolAktivitaet(query,c)).map(x=>x.id),[tie2.id]);
   await c.query('ROLLBACK');
   // Client-Zeit ist kein Eingabevertrag und kann die PG-Zeit nicht manipulieren.
   const pgBefore=(await c.query('SELECT clock_timestamp() AS t')).rows[0].t;
   const timed=await m.erfasseToolAktivitaet({...entry,zeit:'1900-01-01'},ctx,c);
   const pgAfter=(await c.query('SELECT clock_timestamp() AS t')).rows[0].t;
   assert(+timed.zeit>=+pgBefore && +timed.zeit<=+pgAfter);
   await c.query('DELETE FROM tool_aktivitaet WHERE id=$1',[timed.id]);
   await assert.rejects(()=>c.query("INSERT INTO tool_aktivitaet(projekt,tool,aktion,tool_id,akzeptiert,berechtigt,projekt_gebunden,zaehlt_als_aktivitaet) VALUES ('fixture','reverse','inspect','reverse-fixture',false,true,true,true)"),e=>e.code==='23514');
   await assert.rejects(()=>m.letzteToolAktivitaet(query,{query:async()=>{throw Error('fixture read unavailable');}}),/fixture read unavailable/);
   await c.query("UPDATE tool_aktivitaet SET zeit=now()-interval '2 minutes' WHERE id=$1",[accepted.id]);
   assert.deepEqual(await m.letzteToolAktivitaet(query,c),[]);
   assert.equal((await m.letzteToolAktivitaet({...query,fensterSekunden:180},c)).length,1);
   await assert.rejects(()=>m.letzteToolAktivitaet({...query,fensterSekunden:0},c));
   await assert.rejects(()=>m.letzteToolAktivitaet({...query,fensterSekunden:Infinity},c));
   await assert.rejects(()=>m.letzteToolAktivitaet({...query,fensterSekunden:91*86400},c));
   await c.query('BEGIN');
   const rolled=await m.erfasseToolAktivitaet(entry,ctx,c);
   await c.query('ROLLBACK');
   assert.equal((await c.query('SELECT count(*)::int AS n FROM tool_aktivitaet WHERE id=$1',[rolled.id])).rows[0].n,0);
   await assert.rejects(()=>m.erfasseToolAktivitaet(entry,ctx,{query:async()=>{throw Error('fixture db unavailable');}}),/fixture db unavailable/);
   await c.query("UPDATE tool_aktivitaet SET zeit=now()-interval '100 days'");
   assert.equal(await m.bereinigeToolAktivitaet(c),9);
   assert.deepEqual(await m.letzteToolAktivitaet(query,c),[]);
   process.env.SYNAPSE_TOOL_AKTIVITAET_RETENTION_DAYS='2';
   assert.equal(m.toolAktivitaetRetentionTage(),2);
   await assert.rejects(()=>m.letzteToolAktivitaet({...query,fensterSekunden:3*86400},c));
   process.env.SYNAPSE_TOOL_AKTIVITAET_RETENTION_DAYS='invalid';
   assert.throws(()=>m.toolAktivitaetRetentionTage());
   delete process.env.SYNAPSE_TOOL_AKTIVITAET_RETENTION_DAYS;
   console.log('PASS p20_r52 acceptance, binding, polls, descriptor, PG window, durability, transaction, retention, idempotent DDL');
  } finally {await c.query('SET search_path TO public');await c.query('DROP SCHEMA IF EXISTS '+S+' CASCADE');c.release();}
 }
} finally {await pool.query('DELETE FROM tool_calls WHERE project=$1',[P]);await closePool();}
