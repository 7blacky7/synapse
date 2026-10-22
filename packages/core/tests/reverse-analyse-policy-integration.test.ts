import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {fixture,core,policy} from './reverse-analyse-policy.test.ts';
import {mitLesePool} from '../dist/db/client.js';
import {materialisiereS1InBloecken,veroeffentlicheS1Generation} from '../dist/services/reverse-s1-bloecke.js';
import {parserTransaktion,veroeffentlicheParserGeneration} from '../dist/services/reverse-parser-store.js';
import {uebernehmeS3Ergebnis} from '../dist/services/reverse-s3-uebernahme.js';
test('real PG: depth, manual root, replacement, foreign entry, revision and lock fence',async()=>{
 const f=await fixture();try{
  const old=await f.pin({manual:true,file:null,target:'E',stage:'E'});
  const child=await f.pin();assert.equal(child.p.wirksam_bis,'E');
  await assert.rejects(f.tx(c=>policy.pruefeReversePolicyAuftrag(c,child.id,f.rid,'S0')),/policy_grenze/);
  const narrow=await f.pin({manual:true,target:'S3'});assert.equal(narrow.p.wirksam_bis,'E','file cannot widen medium root');
  const replacement=await f.pin({manual:true,file:null,target:'S3',stage:'E'});
  await assert.rejects(f.tx(c=>policy.pruefeReversePolicyAuftrag(c,old.id,f.rid,'E')),/policy_geaendert/);
  const latest=await f.pin({manual:true,target:'S1'});assert.equal(latest.p.wirksam_bis,'S1');
  await f.tx(c=>policy.pruefeReversePolicyAuftrag(c,latest.id,f.rid,'S1'));
  await assert.rejects(f.tx(c=>policy.pruefeReversePolicyAuftrag(c,latest.id,'rev-other','E')),/policy_pin_fehlt/);
  await f.setting('1','global',null,'pipeline_parallel');
  await f.tx(c=>policy.pruefeReversePolicyAuftrag(c,latest.id,f.rid,'S1'));
  await f.setting('E');
  await assert.rejects(f.tx(c=>policy.pruefeReversePolicyAuftrag(c,latest.id,f.rid,'E')),/policy_geaendert/);
  await f.setting('S3');
  const c=await f.pool.connect(),other=await f.raw.connect();
  try{
   await c.query('BEGIN');await policy.pruefeReversePolicyAuftrag(c,latest.id,f.rid,'S1');
   await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='100ms'");
   await assert.rejects(other.query("SELECT pg_advisory_xact_lock(hashtext('reverse-einstellungen'))"),e=>e.code==='55P03');
  }finally{await c.query('ROLLBACK');c.release();await other.query('ROLLBACK');other.release();}
  await f.raw.query("UPDATE reverse_dateien SET sha256=$2 WHERE id=$1",[f.did,'c'.repeat(64)]);
  await assert.rejects(f.tx(c=>policy.pruefeReversePolicyAuftrag(c,latest.id,f.rid,'S1')),/policy_geaendert/);
 }finally{await f.close();}
});
test('real pipeline: E setting overrides stale JSON and explicit E remains sticky',async()=>{
 const f=await fixture();const cfg=core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/unused-t104'});
 const service=new core.ReversePipelineDienst({pool:f.pool,konfiguration:cfg,ausfuehrbareKinds:[]});
 try{
  await f.setting('E');
  const request={reverseId:f.rid,project:'fixture',agentId:'t104',dateiId:f.did,mediumId:f.mid,bisSchicht:'S3',prioritaet:'hintergrund'};
  const auto=await f.tx(c=>service.queue(c,request));assert.equal(auto.schicht,'E');
  assert.equal((await f.raw.query('SELECT count(*)::int n FROM reverse_auftraege')).rows[0].n,0);
  await f.setting('S3');
  await f.pin({manual:true,file:null,target:'E',stage:'E'});
  await f.tx(c=>service.queue(c,request));
  assert.equal((await f.raw.query("SELECT count(*)::int n FROM reverse_auftraege WHERE schicht<>'E'")).rows[0].n,0);
  // Separate new explicit root is the only way to replace the sticky E request.
  await f.pin({manual:true,file:null,target:'S3',stage:'E'});
  const r=await mitLesePool(f.pool,()=>f.tx(c=>service.analysieren({...request,bisSchicht:'S0'},c)));
  assert.equal(r.status,'wartet');const j=(await f.raw.query('SELECT * FROM reverse_auftraege WHERE id=$1',[r.auftrag_id])).rows[0];
  assert.equal(j.policy_pin.wirksam_bis,'S0');
  const r2=await mitLesePool(f.pool,()=>f.tx(c=>service.analysieren({...request,bisSchicht:'S0'},c)));
  const r3=await mitLesePool(f.pool,()=>f.tx(c=>service.analysieren({...request,bisSchicht:'S0'},c)));
  assert.notEqual(r2.auftrag_id,r3.auftrag_id);assert.equal((await f.raw.query("SELECT count(*)::int n FROM reverse_auftraege WHERE status='wartet'")).rows[0].n,1);
  await f.setting('E');const claim=await service.claim();assert.equal(claim,undefined);
  assert.equal((await f.raw.query('SELECT fehlercode FROM reverse_auftraege WHERE id=$1',[r.auftrag_id])).rows[0].fehlercode,'policy_geaendert');
 }finally{await service.beende();await f.close();}
});
test('all publication/resume boundaries reject stale policy before data, cache or byte reads',async()=>{
 const f=await fixture();try{
  const j=await f.pin({manual:true,target:'S3'}),token=randomUUID();
  await f.raw.query("UPDATE reverse_auftraege SET status='laeuft',lease_token=$2,lease_bis=now()+interval '1 hour' WHERE id=$1",[j.id,token]);
  const a={auftragId:j.id,leaseToken:token,leaseMs:60000,reverseId:f.rid,dateiId:f.did,pfad:'a.v6',fingerabdruck:'b'.repeat(64),importe:[],
   einstellungen:await core.leseReverseEinstellwerte({eintrag_id:f.rid},f.pool)};
  await f.setting('E');f.resetMetrics();
  let read=0,called=0;
  await assert.rejects(materialisiereS1InBloecken(f.pool,{size:18,readRange:async()=>{read++;return Buffer.alloc(18);}},a),/policy_geaendert/);
  await assert.rejects(f.tx(c=>veroeffentlicheS1Generation(c,{...a,ordnungAb:0})),/policy_geaendert/);
  await assert.rejects(parserTransaktion(f.pool,a,async()=>{called++;}),/policy_geaendert/);
  await assert.rejects(f.tx(c=>veroeffentlicheParserGeneration(c,a)),/policy_geaendert/);
  await assert.rejects(f.tx(c=>uebernehmeS3Ergebnis(c,{jobId:j.id,reverseId:f.rid,dateiId:f.did,arbeitsWurzel:'/unused',manifest:[]})),/policy_geaendert/);
  const service=new core.ReversePipelineDienst({pool:f.pool,konfiguration:core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/unused-t104'})});
  try{await assert.rejects(f.tx(c=>service.materialisiere(c,{id:j.id,eintrag_id:f.rid,datei_id:f.did,schicht:'S1'},{})),/policy_geaendert/);}
  finally{await service.beende();}
  assert.equal(read,0);assert.equal(called,0);assert.equal(f.writes.length,0);
 }finally{await f.close();}
});
test('S2-only cannot schedule a combined S3 backend; legacy requests held visibly',async()=>{
 const f=await fixture();const service=new core.ReversePipelineDienst({pool:f.pool,konfiguration:core.ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:'/unused-t104'})});
 try{
  await f.setting('S2');service.naechste=async()=> 'S2';
  const a={reverseId:f.rid,project:'fixture',agentId:'t104',dateiId:f.did,mediumId:f.mid,bisSchicht:'S2',prioritaet:'hintergrund'};
  const r=await f.tx(c=>service.analysieren(a,c));assert.equal(r.fehlercode,'policy_grenze');
  assert.equal((await f.raw.query('SELECT count(*)::int n FROM reverse_auftraege')).rows[0].n,0);
  const id=randomUUID();await f.raw.query("INSERT INTO reverse_auftraege(id,eintrag_id,datei_id,schicht,status,ausloeser) VALUES($1,$2,$3,'S1','wartet','agent:legacy')",[id,f.rid,f.did]);
  const hold=await f.tx(c=>service.queue(c,a));assert.equal(hold.fehlercode,'policy_pin_fehlt');
  const row=(await f.raw.query('SELECT status,fehlercode,policy_pin FROM reverse_auftraege WHERE id=$1',[id])).rows[0];
  assert.deepEqual(row,{status:'fehler',fehlercode:'policy_pin_fehlt',policy_pin:null});
 }finally{await service.beende();await f.close();}
});
