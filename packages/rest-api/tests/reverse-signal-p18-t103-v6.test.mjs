/** Offline-only V6 evidence validator. Does not start/stop any process/container. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const SHA=/^[a-f0-9]{64}$/;
export function pruefeSignalBeleg(b){
 assert.equal(b.version,1);
 assert.equal(b.pid1,true);
 assert.equal(b.uid,65532);
 assert.match(b.image_digest,/^sha256:[a-f0-9]{64}$/);
 assert.match(b.runtime_sha256,SHA);
 for(const key of ['container_id','instance_id','generation','signalquelle'])assert.equal(typeof b[key],'string');
 assert.equal(b.signal,15);
 assert.equal(b.exit_code,143);
 assert.equal(b.oom_killed,false);
 assert.equal(b.running,false);
 assert.equal(b.physisches_ende,true);
 assert.equal(b.ressourcen_frei,true);
 assert.equal(b.folgejob_ok,true);
 const start=Date.parse(b.signal_at),end=Date.parse(b.finished_at);
 assert.ok(Number.isFinite(start)&&Number.isFinite(end)&&end>=start);
 assert.ok(Number.isSafeInteger(b.stopbudget_ms)&&b.stopbudget_ms>0&&end-start<=b.stopbudget_ms);
 assert.ok(['idle','e_vor_fsync','e_nach_fsync','leser_laufend','leser_endmarker'].includes(b.fall));
 assert.equal(b.p20_bytegleich,true);
 if(b.fall.startsWith('e_')){
  assert.equal(b.original_unveraendert,true);
  assert.equal(b.keine_unbestaetigten_member_publiziert,true);
  assert.equal(b.journal_konsistent,true);
  assert.equal(b.kein_auto_release,true);
  assert.match(b.checkpoint_sha256,SHA);
 }
 if(b.fall.startsWith('leser_')){
  assert.equal(b.kein_synthetischer_endmarker,true);
  assert.equal(b.keine_aktive_generation_ersetzt,true);
  assert.equal(b.kindursache_erhalten,true);
 }
 return true;
}
const phase=process.env.SYNAPSE_TEST_PHASE==='P18-T103';
test('real V6 signal evidence is complete and shares one final image/runtime pin',{
 skip:!phase||!process.env.REVERSE_SIGNAL_BELEG_JSON,
},async()=>{
 const index=JSON.parse(await readFile(process.env.REVERSE_SIGNAL_BELEG_JSON,'utf8'));
 assert.equal(index.version,1);
 assert.equal(index.endimage_nach_legacy_abbau,true);
 assert.equal(index.belege.length,5);
 const cases=new Set();
 for(const b of index.belege){
  pruefeSignalBeleg(b);cases.add(b.fall);
  assert.equal(b.image_digest,index.image_digest);
  assert.equal(b.runtime_sha256,index.runtime_sha256);
 }
 assert.equal(cases.size,5);
});
test('validator refuses SIGKILL and an unconfirmed physical end',{skip:!phase},()=>{
 const b={version:1,pid1:true,uid:65532,image_digest:'sha256:'+'a'.repeat(64),
 runtime_sha256:'b'.repeat(64),container_id:'c',instance_id:'i',generation:'g',signalquelle:'koordinator',
 signal:15,exit_code:143,oom_killed:false,running:false,physisches_ende:true,ressourcen_frei:true,
 folgejob_ok:true,signal_at:'2026-10-23T00:00:00Z',finished_at:'2026-10-23T00:00:01Z',
 stopbudget_ms:30000,fall:'idle',p20_bytegleich:true};
 assert.equal(pruefeSignalBeleg(b),true);
 for(const patch of [{exit_code:137},{physisches_ende:false},{running:true},{pid1:false},{oom_killed:true}]){
  assert.throws(()=>pruefeSignalBeleg({...b,...patch}));
 }
});
