import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fixture,core} from '../../core/tests/reverse-analyse-policy.test.ts';
import {ReverseExecutor} from '../dist/services/reverse-executor.js';
test('pending stale head terminates; healthy successor stays usable; one Reverse row per failure TX',async()=>{
 const f=await fixture(),root=await mkdtemp(path.join(tmpdir(),'synapse-t104-data-'));
 const who={nodeId:'t104-node',bootGeneration:randomUUID(),authHash:'f'.repeat(64)};
 const jobs=core.createWorkJobService({pool:f.pool});
 const executor=new ReverseExecutor({pool:f.pool,jobs,konfig:{reverseRoot:root,arbeitRoot:root,parallel:1,kinds:['reverse-E'],leaseSeconds:60},lifecycle:()=>null,identitaet:async()=>who});
 try{
  await f.setting('1','global',null,'s1_materialisierung_block_zeilen');
  const create=()=>jobs.enqueue({kind:'reverse-E',capability:'reverse_bibliothek',project:'reverse-bibliothek',scope:'reverse',
   inputRef:{scope:'reverse',id:f.rid,revision:f.mid,sha256:f.hash},resourceNeed:{cpu:1,ram:1,vram:0,gpu:false},idempotencyKey:randomUUID()});
  const bad=await create(),good=await create();
  const old=await f.pin({file:null,stage:'E',work:bad.id,status:'wartet'});
  await f.raw.query('UPDATE reverse_auftraege SET policy_pin=NULL WHERE id=$1',[old.id]);
  const healthy=await f.pin({file:null,stage:'E',work:good.id,status:'fertig'});
  // Multiple Fachauftraege demonstrate bounded failure phases, not merely the one-row happy case.
  for(let i=0;i<4;i++)await f.pin({file:null,stage:'E',work:bad.id,status:'fehler'});
  await mkdir(path.join(root,bad.id));await writeFile(path.join(root,bad.id,'retained.bin'),'synthetic retained output');
  await assert.rejects(executor.policyPruefen(bad),/policy_pin_fehlt/);f.resetMetrics();
  executor.altScope=true;await executor.raeumeArbeitAuf();
  assert.equal(await readFile(path.join(root,bad.id,'retained.bin'),'utf8'),'synthetic retained output','legacy null-pin output preserved before halt');
  await executor.policyHalten(bad,who,'policy_pin_fehlt');
  assert.equal(f.maxWrites(),1);assert.equal((await jobs.get(bad.id,'reverse-bibliothek')).state,'failed');
  await executor.policyPruefen(good);assert.equal((await jobs.get(good.id,'reverse-bibliothek')).state,'pending');
  assert.equal((await f.raw.query("SELECT count(*)::int n FROM reverse_auftraege WHERE p20_auftrag_id=$1 AND fehlercode='policy_pin_fehlt'",[bad.id])).rows[0].n,5);
  // no chmod/chown of synthetic output needed: old job scope preserves only the cleanup decision.
  executor.altScope=true;assert.equal(await executor.raeumeArbeitAuf(),0);
  assert.equal(await readFile(path.join(root,bad.id,'retained.bin'),'utf8'),'synthetic retained output');
  await executor.policyHalten(bad,who,'policy_pin_fehlt');
  assert.equal((await f.raw.query("SELECT count(*)::int n FROM work_job_audit WHERE job_id=$1 AND event='failed'",[bad.id])).rows[0].n,1);
 }finally{await f.close();await rm(root,{recursive:true,force:true});}
});
test('held client stays connected; stale policy rejects importer, dispatch and S3 publication',async()=>{
 const f=await fixture();const who={nodeId:'t104-node',bootGeneration:randomUUID(),authHash:'f'.repeat(64)},jobs=core.createWorkJobService({pool:f.pool});
 let imported=0;
 const executor=new ReverseExecutor({pool:f.pool,jobs,konfig:{reverseRoot:'/unused',arbeitRoot:'/unused',parallel:1,kinds:['reverse-E','reverse-S3'],retryMax:2},
  lifecycle:()=>null,identitaet:async()=>who,uebernahme:async()=>{imported++;return {dateien:1,verworfen:0};}});
 try{
  const j=await jobs.enqueue({kind:'reverse-E',capability:'reverse_bibliothek',project:'reverse-bibliothek',scope:'reverse',
   inputRef:{scope:'reverse',id:f.rid,revision:f.mid,sha256:f.hash},resourceNeed:{cpu:1,ram:1,vram:0,gpu:false},idempotencyKey:randomUUID()});
  const a=await f.pin({manual:true,file:null,stage:'E',target:'S3',work:j.id});
  // (angepasst P25-T12, P18-T97 Admission-Cut: fuehreAus prueft zuerst die Fachbindung; ohne Zulassungsbeleg endet der Lauf mit
  // reverse_admission_nicht_belegt, bevor die Policy geprueft wird. Beleg wie in reverse-ein-container-p18-t64.)
  await (await import('../../core/dist/services/reverse-pipeline-halt.js')).belegeReverseAdmission(f.pool,j.id,String(a.id));
  await f.tx(async c=>{c.connect=()=>{throw Error('HELD_CLIENT_RECONNECTED');};await executor.policyPruefen(j,c);});
  await f.setting('E');
  await assert.rejects(executor.uebernimmUnterFence(j,who,{jobId:j.id,reverseId:f.rid,mediumId:f.mid,arbeitsWurzel:'/unused',manifest:[]}),/policy_geaendert/);
  assert.equal(imported,0);
  let dispatched=0;await executor.fuehreAus({execute:async()=>{dispatched++;}},who,j);
  assert.equal(dispatched,0);assert.equal((await jobs.get(j.id,'reverse-bibliothek')).errorCode,'policy_geaendert');
  const s3={...j,kind:'reverse-S3',inputRef:{...j.inputRef,revision:f.did}};
  await assert.rejects(executor.policyPruefen(s3),/policy_geaendert/);
 }finally{await f.close();}
});
