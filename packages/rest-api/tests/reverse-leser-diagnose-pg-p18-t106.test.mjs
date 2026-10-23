/** P18-T106: echter Fehlerabschluss in synapse_test, Docker/P20-Transport als Attrappe. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as pause} from 'node:timers/promises';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
delete process.env.SYNAPSE_DATABASE_URL;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
const {Pool}=createRequire(new URL('../../core/package.json',import.meta.url))('pg');
const core=await import('../../core/dist/index.js');
const {mitLesePool}=await import('../../core/dist/db/client.js');
const {fuehreReverseLeserAus}=await import('../../core/dist/services/reverse-leser-tool.js');
const {WORK_JOBS_SCHEMA_SQL}=await import('../../core/dist/db/work-jobs-schema.js');
const {TOOL_CONTAINER_SCHEMA_SQL}=await import('../../core/dist/db/tool-container-schema.js');
const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../../core/dist/db/tool-aktivitaet-schema.js');
const {ReverseLeserExecutor}=await import('../dist/services/reverse-leser-executor.js');
const secret='NUTZDATEN_GEHEIM/private/file';
const project='reverse-bibliothek';

async function fixture(){
 const schema='t106_'+randomUUID().replaceAll('-',''),admin=new Pool({connectionString:process.env.DATABASE_URL});
 await admin.query('CREATE SCHEMA "'+schema+'"');
 const db=new Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+schema+',public',max:5});
 const root=await mkdtemp(join(tmpdir(),'t106-pg-data-'));
 const close=async()=>{await db.end();await admin.query('DROP SCHEMA "'+schema+'" CASCADE');await admin.end();await rm(root,{recursive:true,force:true});};
 try{
 await db.query("CREATE TABLE projects(name text,enabled boolean); INSERT INTO projects VALUES('reverse-bibliothek',true)");
 await db.query("CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text,service_token_hash text,status text DEFAULT 'ready',gesperrt_vom_user boolean DEFAULT false,letzter_kontakt timestamptz DEFAULT now(),node_kind text DEFAULT 'cpu')");
 for(const sql of [WORK_JOBS_SCHEMA_SQL,TOOL_CONTAINER_SCHEMA_SQL,TOOL_AKTIVITAET_SCHEMA_SQL])await db.query(sql);
 await db.query("ALTER TABLE tool_activation ADD updater_identity_id uuid");
 await db.query("CREATE TABLE reverse_einstellungen(ebene text,project text,eintrag_id text,name text,wert bigint,wert_text text)");
 await db.query("INSERT INTO reverse_einstellungen(ebene,name,wert) VALUES('global','e_uebernahme_block_zeilen',1)");
 await db.query("CREATE TABLE reverse_bindungen(project text,eintrag_id text,geloest_at timestamptz)");
 await db.query("INSERT INTO reverse_bindungen VALUES('t106-project','rev-t106',NULL)");
 await db.query("CREATE TABLE reverse_leser_laeufe(id uuid PRIMARY KEY,work_job_id uuid,eintrag_id text,datei_id bigint,quell_sha256 text,leser_id text,generation uuid,status text DEFAULT 'laeuft',host_validiert boolean DEFAULT false,diagnose jsonb DEFAULT '{}',position bigint DEFAULT 0,ausgabe_anzahl bigint DEFAULT 0,ausgabe_bytes bigint DEFAULT 0,offen bigint DEFAULT 0,abgewiesen bigint DEFAULT 0,fehlercode text,manifest_key text,manifest_sha256 text,cursor_key text,einstellungen_revision text,runtime_sha256 text,runtime_image_digest text,created_at timestamptz DEFAULT now(),beendet_at timestamptz)");
 const who={nodeId:'t106',bootGeneration:randomUUID(),authHash:'t106-auth'};
 await db.query('INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)',[who.nodeId,who.bootGeneration,who.authHash]);
 const jobs=core.createWorkJobService({pool:db});
 const job=await jobs.enqueue({kind:'reverse-leser',capability:'reverse_leser',project,scope:'reverse',
  inputRef:{scope:'reverse',id:'rev-t106',revision:'1',sha256:'a'.repeat(64)},
  resourceNeed:{cpu:1,ram:32,vram:0,gpu:false},priority:'hintergrund',idempotencyKey:randomUUID()});
 await db.query("UPDATE work_jobs SET state='leased',attempt=1,owner_node=$2,boot_generation=$3,owner_auth_hash=$4,claim_token=$5,lease_until=now()+interval '10 minutes',resource_domain='t106-test',claimed_at=now() WHERE id=$1",
  [job.id,who.nodeId,who.bootGeneration,who.authHash,randomUUID()]);
 const claimed=await jobs.get(job.id,project),s=await core.leseReverseEinstellwerte({eintrag_id:'rev-t106'},db);
 assert.equal(s.letzter_fehler,null);assert.equal(s.werte.e_uebernahme_block_zeilen.wert,'1');
 const l={id:randomUUID(),eintrag_id:'rev-t106',datei_id:'1',quell_sha256:'a'.repeat(64),
  generation:randomUUID(),groesse:'1',testmodus:true,host_validiert:false,leser_id:'b'.repeat(64),einstellungen_revision:s.revision};
 await db.query("INSERT INTO reverse_leser_laeufe(id,work_job_id,eintrag_id,datei_id,quell_sha256,generation,leser_id,einstellungen_revision) VALUES($1,$2,$3,1,$4,$5,$6,$7)",
  [l.id,job.id,l.eintrag_id,l.quell_sha256,l.generation,l.leser_id,s.revision]);
 const transactions=[];
 const observed={query:db.query.bind(db),connect:async()=>{
  const c=await db.connect();let writes=0,bytes=0;
  return {query:async(sql,params)=>{
   const text=typeof sql==='string'?sql:sql.text,values=params??sql.values??[];
   const result=await c.query(sql,params);
   if(/^\s*(UPDATE|INSERT|DELETE)\b/i.test(text)&&/\b(reverse_leser_laeufe|work_jobs)\b/i.test(text)){writes+=result.rowCount;bytes+=Buffer.byteLength(JSON.stringify(values));}
   if(text==='COMMIT'){transactions.push({writes,bytes});assert.ok(writes<=1,'mehr als eine Zeile in Reverse-TX');}
   return result;
  },release:()=>c.release()};
 }};
 const lc={neustart:async()=>{},status:async()=>({status:'cold',container_id:null})};
 const reader=new ReverseLeserExecutor({pool:observed,reverseRoot:root,image:'synapse-reverse:fixture',
  digest:'sha256:'+'b'.repeat(64),hostRoot:async()=>root,lifecycle:()=>lc,identitaet:async()=>who});
 reader.s=s;reader.lauf=async()=>l;
 const manifest={ausgabetypen:['struktur'],entrypoint:'reader.py'};
 reader.vorbereitet.set(job.id,{s,lauf:l,r:{manifest,id:'b'.repeat(64),code_sha256:'c'.repeat(64)},ausgabe:root,key:'fixture-output'});
 let staged=0,completed=0;
 reader.jobs={renew:async()=>true,stage:async()=>{staged++;return true;},complete:async()=>{completed++;return {completed:true};}};
 await writeFile(join(root,'retained.data'),'must remain');
 return {db,observed,root,job:claimed,l,s,reader,lc,who,jobs,transactions,
  counts:()=>({staged,completed}),run:async()=> (await db.query('SELECT * FROM reverse_leser_laeufe WHERE id=$1',[l.id])).rows[0],
  close};
 }catch(e){await close();throw e;}
}

for(const code of ['leser_pfad_symlink','leser_hardlink','leser_protokoll_limit','leser_ende_unvollstaendig']){
 test('T106 PG Abschluss + gebundene API-Sicht / '+code,async()=>{
  const f=await fixture();
  try{
   const answer={status:'fehler',fehlercode:code,leser_exit:0};
   await assert.rejects(f.reader.ausfuehren({...f.lc,execute:async()=>answer},f.who,f.job),new RegExp('^Error: '+code+'$'));
   const run=await f.run(),job=await f.jobs.get(f.job.id,project);
   assert.equal(run.fehlercode,code);assert.equal(job.errorCode,code);assert.equal(job.state,'failed');
   assert.equal(run.diagnose.physisches_ende,true);assert.equal(run.diagnose.abweisung.code,code);
   assert.deepEqual(f.counts(),{staged:0,completed:0});
   assert.deepEqual(f.transactions.map(x=>x.writes),[1,1]);
   assert.equal(await readFile(join(f.root,'retained.data'),'utf8'),'must remain');
   const api=await mitLesePool(f.db,()=>fuehreReverseLeserAus(f.db,{action:'leser_get',project:'t106-project',reverse_id:f.l.eintrag_id,leser_lauf_id:f.l.id}));
   assert.equal(api.lauf.fehlercode,code);assert.equal(api.lauf.diagnose.abweisung.code,code);
   await assert.rejects(mitLesePool(f.db,()=>fuehreReverseLeserAus(f.db,{action:'leser_get',project:'fremd',reverse_id:f.l.eintrag_id,leser_lauf_id:f.l.id})),/nicht_gebunden/);
  }finally{await f.close();}
 });
}

test('T106 kleine Bytegrenze lässt Pflichtcode bestehen; Crash zwischen zwei TX ist fortsetzbar',async()=>{
 const f=await fixture();
 try{
  const diagnosis={physisches_ende:true,abweisung:{version:1,quelle:'adapter',phase:'ausfuehrung',code:'leser_hardlink',exit_code:null,signal:null,cleanup_code:null}};
  const mandatory=[f.job.id,f.job.inputRef.id,f.job.inputRef.revision,f.job.inputRef.sha256,f.job.attempt,'leser_hardlink',
   {physisches_ende:true,abschluss_versuch:f.job.attempt},null,f.l.id,true];
  const bound=Buffer.byteLength(core.reverseLeserKanonisch(mandatory));
  f.s.werte.materialisierung_tx_bytes.wert=String(bound);
  const resume=f.reader.fehlerFortsetzen.bind(f.reader);
  f.reader.fehlerFortsetzen=async()=>{throw Error('simulierter Crash nach Lauf-TX');};
  await assert.rejects(f.reader.fehlerAbschliessen(f.job,f.l.id,f.s,'leser_hardlink',diagnosis,null,f.who),/simulierter Crash/);
  assert.equal((await f.run()).fehlercode,'leser_hardlink');
  assert.equal((await f.run()).diagnose.abweisung,undefined);
  assert.equal((await f.jobs.get(f.job.id,project)).state,'leased');
  await resume(f.job.id,f.s);await resume(f.job.id,f.s);
  const job=await f.jobs.get(f.job.id,project);
  assert.equal(job.state,'failed');assert.equal(job.errorCode,'leser_hardlink');assert.equal(job.attempt,1);
  assert.ok(f.transactions.every(tx=>tx.writes<=1&&tx.bytes<=bound));
 }finally{await f.close();}
});

test('T106 eigener harter Timer erklärt Transportfehler; Stopfehler fälscht keinen Endbeleg',async()=>{
 for(const physical of [true,false]){
  const f=await fixture();
  try{
   f.s.werte.hart_puffer_s.wert='0';
   f.reader.vorbereitet.get(f.job.id).r.manifest.budgetwuensche={zeit_ms:'20'};
   const lc={...f.lc,execute:async()=>{await pause(70);throw Error(secret);}};
   if(!physical)lc.neustart=async()=>{throw Error(secret);};
   await assert.rejects(f.reader.ausfuehren(lc,f.who,f.job),/leser_harte_frist/);
   const run=await f.run();
   assert.equal(run.fehlercode,'leser_harte_frist');assert.equal(run.diagnose.physisches_ende,physical);
   assert.equal((await f.jobs.get(f.job.id,project)).resourceUnconfirmed,!physical);
   assert.ok(!JSON.stringify(run).includes(secret));
  }finally{await f.close();}
 }
});

for(const source of ['exception','json'])test('T106 Fehler- und Loggrenze ohne Nutzbytes / '+source,async()=>{
 const f=await fixture(),logs=[];
 const original=console.error;
 try{
  f.reader.aktiv=async()=>true;
  f.reader.jobs.claim=async()=>[f.job];
  console.error=(...args)=>logs.push(args);
  f.lc.execute=async()=>{
   if(source==='exception')throw Error('leser_'+secret+'\n');
   const protocol='{INVALID_JSON_'+secret+'}\n';
   await writeFile(join(f.root,'.leser-protokoll.jsonl'),protocol);
   return {status:'fertig',leser_exit:0,leser_protokoll:{pfad:'.leser-protokoll.jsonl',
    sha256:createHash('sha256').update(protocol).digest('hex'),bytes:String(Buffer.byteLength(protocol)),zeilen:'1'}};
  };
  await mitLesePool(f.db,()=>f.reader.durchlauf());
  await Promise.all([...f.reader.laufend.values()]);
  assert.equal((await f.run()).fehlercode,'leser_ausfuehrung_fehlgeschlagen');
  assert.equal((await f.jobs.get(f.job.id,project)).errorCode,'leser_ausfuehrung_fehlgeschlagen');
  assert.ok(logs.some(args=>args[0]==='[reverse-leser]'&&args[1]===f.job.id));
  assert.ok(!JSON.stringify(logs).includes(secret));
  assert.ok(!JSON.stringify(await f.run()).includes(secret));
  assert.deepEqual(f.counts(),{staged:0,completed:0});
 }finally{console.error=original;await f.close();}
});

test('T106 Leaseerneuerung und Stop-Fence behalten getrennte Hauptgründe',async()=>{
 for(const mode of ['renew','stop-fence']){
  const f=await fixture();
  try{
   const lc={...f.lc};
   if(mode==='renew'){
    f.s.werte.executor_lease_s.wert='1';f.s.werte.executor_renew_min_ms.wert='1';
    f.reader.jobs.renew=async()=>false;
    lc.execute=async()=>{await pause(450);return {status:'fertig',leser_exit:0};};
   }else{
    lc.execute=async()=>({status:'fehler',fehlercode:'leser_hardlink',leser_exit:0});
    lc.status=async()=>({status:'stopping',container_id:'fixture'});
   }
   const code=mode==='renew'?'leser_lease_verloren':'leser_stop_unbestaetigt';
   await assert.rejects(f.reader.ausfuehren(lc,f.who,f.job),new RegExp('^Error: '+code+'$'));
   const r=await f.run();assert.equal(r.fehlercode,code);
   assert.equal(r.diagnose.physisches_ende,mode==='renew');
   assert.equal((await f.jobs.get(f.job.id,project)).errorCode,code);
   assert.deepEqual(f.counts(),{staged:0,completed:0});
  }finally{await f.close();}
 }
});
