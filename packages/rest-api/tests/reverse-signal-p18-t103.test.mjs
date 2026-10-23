/** P18-T103: host contract tests. No live signals/containers; test phase only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {pruefeLeserProzess,normalisiereLeserFehler} from '../dist/services/reverse-leser-executor.js';
const enabled=process.env.SYNAPSE_TEST_PHASE==='P18-T103';
const run=(name,fn)=>test(name,{skip:!enabled},fn);
const response=(code='leser_runner_sigterm',kind=null,cleanup=null)=>({
 status:'fehler',fehlercode:code,leser_exit:kind,
 leser_diagnose:{version:1,quelle:'adapter',phase:'ausfuehrung',code,
  exit_code:kind!==null&&kind>=0?kind:null,signal:kind!==null&&kind<0?-kind:null,cleanup_code:cleanup},
});
run('Parent SIGTERM survives normalization without fabricating child signal',()=>{
 for(const kind of [null,0,-15,-9,7]){
  const r=response('leser_runner_sigterm',kind);
  assert.throws(()=>pruefeLeserProzess(r),e=>{
   assert.equal(e.message,'leser_runner_sigterm');
   assert.equal(e.diagnose.signal,kind!==null&&kind<0?-kind:null);
   assert.equal(normalisiereLeserFehler(e),e);return true;
  });
 }
});
run('Cleanup cannot overwrite parent or original child cause',()=>{
 for(const [code,kind] of [['leser_runner_sigterm',null],['leser_prozess_signal',-15],['leser_zeitlimit',null]]){
  assert.throws(()=>pruefeLeserProzess(response(code,kind,'leser_prozess_cleanup_fehler')),e=>{
   assert.equal(e.message,code);assert.equal(e.diagnose.cleanup_code,'leser_prozess_cleanup_fehler');return true;
  });
 }
});
run('No parent stop is a success, even with child Exit0',()=>{
 const r=response('leser_runner_sigterm',0);r.status='fertig';
 assert.throws(()=>pruefeLeserProzess(r));
});
run('Strict phase/fields/child signal binding remains fail closed',()=>{
 for(const mutate of [
  r=>{r.leser_diagnose.phase=['ausfuehrung'];},
  r=>{r.leser_diagnose.path='/private/input';},
  r=>{r.leser_diagnose.signal=15;},
  r=>{r.fehlercode='leser_runner_sigterm:/private/input';},
 ]){
  const r=response();mutate(r);
  assert.throws(()=>pruefeLeserProzess(r),e=>e.message==='leser_prozess_nicht_erfolgreich');
 }
});
run('Legacy optional diagnosis still accepts a real successful child',()=>{
 assert.doesNotThrow(()=>pruefeLeserProzess({status:'fertig',leser_exit:0}));
 assert.throws(()=>pruefeLeserProzess({status:'fertig',leser_exit:null}));
});


run('R1: real fenced S3 retention survives several cleanup ticks, unrelated work does not',async()=>{
 const {createRequire}=await import('node:module');
 const {randomUUID,createHash}=await import('node:crypto');
 const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
 const {ReverseExecutor}=await import('../dist/services/reverse-executor.js');
 const {Pool}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
 const url=new URL(process.env.DATABASE_URL??'http://invalid');
 assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
 const schema='t103_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:url.href});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new Pool({connectionString:url.href,options:'-c search_path='+schema+',public'});
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'t103-retention-data-'));
 try{
  await db.query("CREATE TABLE reverse_einstellungen(ebene text,project text,eintrag_id text,name text,wert bigint,wert_text text)");
  await db.query("CREATE TABLE work_jobs(id uuid PRIMARY KEY,state text,error_code text,lease_until timestamptz,staged_output_ref jsonb,updated_at timestamptz,claim_token uuid,owner_node text,boot_generation uuid,owner_auth_hash text,deadline timestamptz)");
  await db.query("CREATE TABLE reverse_auftraege(id uuid PRIMARY KEY,p20_auftrag_id uuid,eintrag_id text,datei_id bigint,schicht text,uebernahme jsonb,status text,fehlercode text,updated_at timestamptz,lease_token uuid,lease_bis timestamptz,policy_pin jsonb)");
  await db.query("CREATE TABLE reverse_dateien(metadaten jsonb)");
  await db.query("CREATE TABLE reverse_schichten(auftrag_id uuid,aktuell boolean,status text,fehlercode text)");
  await db.query("CREATE TABLE reverse_analyse_cache(p20_auftrag_id uuid,status text,fehlercode text)");
  await db.query("CREATE TABLE work_job_audit(id uuid,job_id uuid,event text,detail jsonb)");
  const who={nodeId:'t103',bootGeneration:randomUUID(),authHash:'fixture'};
  const job={id:randomUUID(),attempt:1,claimToken:randomUUID(),kind:'reverse-S3',
   inputRef:{id:'rev-t103',revision:'7',sha256:'a'.repeat(64)}};
  const raw=Buffer.from('own S3 raw fixture\0not yet in manifest');
  const hash=b=>createHash('sha256').update(b).digest('hex');
  const dir=path.join(root,'_arbeit',job.id);
  await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'raw.bin'),raw);
  await db.query("INSERT INTO work_jobs(id,state,lease_until,claim_token,owner_node,boot_generation,owner_auth_hash) VALUES($1,'leased',now()+interval '1 minute',$2,$3,$4,$5)",[job.id,job.claimToken,who.nodeId,who.bootGeneration,who.authHash]);
  await db.query("INSERT INTO reverse_auftraege(id,p20_auftrag_id,eintrag_id,datei_id,schicht,status,policy_pin) VALUES($1,$2,'rev-t103',7,'S3','laeuft','{}')",[randomUUID(),job.id]);
  const ex=Object.create(ReverseExecutor.prototype);
  ex.pool=db;ex.k={reverseRoot:root,arbeitRoot:path.join(root,'_arbeit')};ex.laufend=new Map();
  // Filesystem UID ownership is a separate sandbox concern; this test uses the legacy root shape.
  ex.altScope=true;ex.policyPruefen=async()=>{};
  // The real leaseLebt query and both real retention/terminal transactions execute.
  await ex.halteS3Signal(job,who);
  const state=(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[job.id])).rows[0];
  assert.deepEqual(state,{state:'failed',error_code:'signal_sigterm'});
  const saved=(await db.query('SELECT uebernahme FROM reverse_auftraege WHERE p20_auftrag_id=$1',[job.id])).rows[0].uebernahme;
  assert.equal(saved.retention,true);assert.equal(saved.fortsetzung_gesperrt,true);
  assert.equal(saved.signal_rueckhalt.job_id,job.id);
  assert.equal(saved.signal_rueckhalt.quell_sha256,job.inputRef.sha256);
  const unrelated=randomUUID();await fs.mkdir(path.join(root,'_arbeit',unrelated));
  await db.query("INSERT INTO work_jobs(id,state) VALUES($1,'failed')",[unrelated]);
  await db.query("INSERT INTO reverse_auftraege(id,p20_auftrag_id,eintrag_id,datei_id,schicht,status,policy_pin) VALUES($1,$2,'rev-other',8,'S3','fehler','{}')",[randomUUID(),unrelated]);
  await fs.writeFile(path.join(root,'_arbeit',unrelated,'ordinary.bin'),'own expendable data');
  assert.equal(await ex.raeumeArbeitAuf(),1);
  for(let i=0;i<3;i++){
   assert.equal(await ex.raeumeArbeitAuf(),0);
   assert.equal(hash(await fs.readFile(path.join(dir,'raw.bin'))),hash(raw));
  }
  // Lost lease must not publish a marker or terminal status.
  const stale={...job,id:randomUUID()};
  await db.query("INSERT INTO work_jobs(id,state,lease_until,claim_token,owner_node,boot_generation,owner_auth_hash) VALUES($1,'leased',now()-interval '1 second',$2,$3,$4,$5)",[stale.id,job.claimToken,who.nodeId,who.bootGeneration,who.authHash]);
  await db.query("INSERT INTO reverse_auftraege(id,p20_auftrag_id,eintrag_id,datei_id,schicht,status,policy_pin) VALUES($1,$2,'rev-t103',7,'S3','laeuft','{}')",[randomUUID(),stale.id]);
  await ex.halteS3Signal(stale,who);
  assert.equal((await db.query('SELECT uebernahme FROM reverse_auftraege WHERE p20_auftrag_id=$1',[stale.id])).rows[0].uebernahme,null);
  assert.equal((await db.query('SELECT state FROM work_jobs WHERE id=$1',[stale.id])).rows[0].state,'leased');
 }finally{
  await db.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();
  await fs.rm(root,{recursive:true,force:true});
 }
});
