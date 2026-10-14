/** P18-T59/RV12: Reverse-Executor gegen synapse_test (eigenes Schema, mkdtemp), Fake-Container statt Docker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as pause} from 'node:timers/promises';
const url=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(url.port,'5433','nur Test-Port');assert.equal(url.pathname,'/synapse_test','nur Testdatenbank');
delete process.env.SYNAPSE_DATABASE_URL;delete process.env.SYNAPSE_COMPUTE_POLICY_ENABLED;delete process.env.SYNAPSE_COMPUTE_ADMISSION;
process.env.SYNAPSE_SKIP_EMBEDDINGS='1';
const require=createRequire(new URL('../../core/package.json',import.meta.url));
const {Pool}=require('pg');
const {WORK_JOBS_SCHEMA_SQL}=await import('../../core/dist/db/work-jobs-schema.js');
const {TOOL_CONTAINER_SCHEMA_SQL}=await import('../../core/dist/db/tool-container-schema.js');
const {TOOL_AKTIVITAET_SCHEMA_SQL}=await import('../../core/dist/db/tool-aktivitaet-schema.js');
const {REVERSE_SCHEMA_SQL}=await import('../../core/dist/db/reverse-schema.js');
const {REVERSE_PIPELINE_SCHEMA_SQL}=await import('../../core/dist/db/reverse-pipeline-schema.js');
const {ASSET_UPLOAD_SCHEMA_SQL}=await import('../../core/dist/db/asset-upload-schema.js');
const {ladeAssetKonfiguration}=await import('../../core/dist/config/asset-konfig.js');
const {createWorkJobService}=await import('../../core/dist/services/work-jobs.js');
const {uebernehmeEErgebnis,ReverseEUebernahmeFehler}=await import('../../core/dist/services/reverse-e-uebernahme.js');
const {ToolLifecycle}=await import('../dist/services/tool-lifecycle.js');
const {buildToolContainerOptions}=await import('../dist/services/tool-container-docker.js');
const ex=await import('../dist/services/reverse-executor.js');
const sha=b=>createHash('sha256').update(b).digest('hex');

test('P18-T59 Reverse-Executor: Auftrag, später Abschluss, fremde Identität',async()=>{
 const root=await mkdtemp(join(tmpdir(),'p18-t59-'));const reverseRoot=join(root,'rev');await mkdir(reverseRoot);
 const schema='p18_t59_'+randomUUID().replaceAll('-','');
 const pool=new Pool({connectionString:process.env.DATABASE_URL,max:6});
 const connect=async()=>{const c=await pool.connect();await c.query('SET search_path TO "'+schema+'",public');return c;};
 const db={connect,query:async(...a)=>{const c=await connect();try{return await c.query(...a);}finally{c.release();}}};
 let lc,unhook;
 const vorherigeReverseImage=process.env.SYNAPSE_REVERSE_IMAGE;
 try{
  assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name,'synapse_test');
  await pool.query('CREATE SCHEMA "'+schema+'"');
  await db.query('CREATE TABLE asset_upload_sitzungen (LIKE public.asset_upload_sitzungen INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE asset_files (LIKE public.asset_files INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  await db.query('CREATE TABLE projects(name text,enabled boolean)');
  await db.query("CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text NOT NULL,service_token_hash text NOT NULL,status text NOT NULL DEFAULT 'ready',gesperrt_vom_user boolean NOT NULL DEFAULT false,letzter_kontakt timestamptz NOT NULL DEFAULT now(),node_kind text DEFAULT 'cpu')");
  for(const sql of [WORK_JOBS_SCHEMA_SQL,ASSET_UPLOAD_SCHEMA_SQL,REVERSE_SCHEMA_SQL,REVERSE_PIPELINE_SCHEMA_SQL,TOOL_AKTIVITAET_SCHEMA_SQL,TOOL_CONTAINER_SCHEMA_SQL])await db.query(sql);

  process.env.SYNAPSE_REVERSE_IMAGE='synapse-reverse@sha256:'+'a'.repeat(64);
  const konfig=ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:process.env.SYNAPSE_REVERSE_IMAGE,
   SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":512,"vram":0,"gpu":false}',SYNAPSE_REVERSE_EXECUTOR_LEASE_SECONDS:'30',SYNAPSE_REVERSE_WAV_PREGAP:'1'},reverseRoot);
  konfig.renewMs=3600000; // Erneuerung im Test aus: Lease-Ablauf wird gezielt erzwungen.
  assert.equal(konfig.wavPregap,true,'WAV-Pregap aus der Konfiguration');
  assert.equal(ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse@sha256:'+'a'.repeat(64),SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":512,"vram":0,"gpu":false}'},reverseRoot).wavPregap,false,'WAV-Pregap standardmaessig aus');
  assert.equal(ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'0'},reverseRoot),null,'aus ohne SYNAPSE_REVERSE_ENABLED=1');
  assert.throws(()=>ex.ladeReverseExecutorKonfig({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_IMAGE:'synapse-reverse:latest',SYNAPSE_REVERSE_RESOURCE_NEED:'{"cpu":1,"ram":1,"vram":0,"gpu":false}'},reverseRoot),/SYNAPSE_REVERSE_IMAGE/);
  const cfg=ladeAssetKonfiguration({SYNAPSE_REVERSE_ENABLED:'1',SYNAPSE_REVERSE_ROOT:reverseRoot});

  // Server-Identität und eine fremde, ebenfalls registrierte Identität.
  const wer={nodeId:'srv-t59',bootGeneration:randomUUID(),authHash:'hash-srv-t59'};
  const fremd={nodeId:'fremd-t59',bootGeneration:randomUUID(),authHash:'hash-fremd-t59'};
  for(const w of [wer,fremd])await db.query('INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)',[w.nodeId,w.bootGeneration,w.authHash]);

  // Fake-Container: echte Mount-/Optionsauflösung, Runner-Verhalten simuliert.
  const resolve=ex.reverseMountResolver(konfig),container=new Map(),starts=[];let verzoegerung=0;
  const fake={
   async start(d,ctx){const mounts=await resolve(d,ctx);const o=buildToolContainerOptions(d,ctx,mounts);starts.push(o);
    container.set('fake-'+ctx.generation,mounts.find(m=>m.role==='arbeit').source);return {id:'fake-'+ctx.generation,coldstart_ms:3};},
   async observe(id){return {container_id:id,running:true,cpu_percent:0,gpu_percent:null,measured_at:(await db.query('SELECT clock_timestamp() AS t')).rows[0].t.toISOString()};},
   async stop(){},async cleanup(){},
   async command(id,req,_t,_m,onTerminal){
    assert.equal(req.kommando,'extrahieren');assert.match(req.eingabe,/^\/bib\/rev-t59-/);assert.equal(req.ausgabe,'/arbeit/'+req.auftrag_id);
    assert.deepEqual(req.optionen,{wav_pregap:true},'WAV-Pregap-Option wird an den Runner weitergereicht');
    const out=join(container.get(id),req.auftrag_id);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(out),[],'Ausgabeordner leer vorab angelegt');
    if(verzoegerung)await pause(verzoegerung);
    const dateien=[['DATEN/a.txt','hallo'],['b.bin','\u0001\u0002']];const manifest=[];
    for(const [p,inhalt] of dateien){await mkdir(join(out,p,'..'),{recursive:true});await writeFile(join(out,p),inhalt);manifest.push({pfad:p,groesse:Buffer.byteLength(inhalt),sha256:sha(inhalt)});}
    onTerminal?.();return {status:'fertig',fehlercode:null,manifest};
   },
  };
  lc=new ToolLifecycle({pool:db,executor:fake,resources:ex.reverseRessourcen,maxContainers:16}); // ohne Lifecycle-Tick laufen Fake-Container nicht aus
  let uebernahmen=0;
  const executor=new ex.ReverseExecutor({pool:db,konfig,lifecycle:()=>lc,identitaet:async()=>wer,
   uebernahme:async(...a)=>{uebernahmen++;return uebernehmeEErgebnis(...a);},uebernahmeOptionen:{konfiguration:cfg},
   registriereProjekt:async n=>{await db.query('INSERT INTO projects SELECT $1,true WHERE NOT EXISTS(SELECT 1 FROM projects WHERE name=$1)',[n]);}});
  unhook=ex.registriereWorkJobHooks(ex.REVERSE_CAPABILITY,executor.hooks());
  const jobs=createWorkJobService({pool:db});

  const neuerAuftrag=async(nr,kind='reverse-E')=>{
   const rid='rev-t59-'+nr+'-'+randomUUID().slice(0,6),satz=sha('satz'+nr+rid);
   await db.query("INSERT INTO reverse_eintraege(id,titel,status) VALUES($1,'T59','bestaetigt')",[rid]);
   const m=(await db.query("INSERT INTO reverse_medien(eintrag_id,position,bezeichnung,art,satz_sha256,status) VALUES($1,0,'CD1','iso',$2,'vollstaendig') RETURNING id::text",[rid,satz])).rows[0].id;
   await db.query("INSERT INTO reverse_medien_dateien(medium_id,rolle,original_name,sha256,groesse,storage_key) VALUES($1,'haupt','disc.iso',$2,4,$3)",[m,satz,rid+'/original/dateien/disc.iso']);
   const job=await jobs.enqueue({kind,capability:ex.REVERSE_CAPABILITY,project:ex.REVERSE_PROJEKT,scope:'reverse',
    inputRef:{scope:'reverse',id:rid,revision:m,sha256:satz},resourceNeed:{cpu:1,ram:512,vram:0,gpu:false},priority:'hintergrund',idempotencyKey:'t59:'+rid});
   const a=(await db.query("INSERT INTO reverse_auftraege(eintrag_id,medium_id,schicht,status,p20_auftrag_id,ausfuehrung,fingerabdruck) VALUES($1,$2,'E','wartet',$3,'container',$4) RETURNING id",[rid,m,job.id,sha('fp'+rid)])).rows[0].id;
   await db.query("INSERT INTO reverse_schichten(medium_id,schicht,fingerabdruck,status,auftrag_id) VALUES($1,'E',$2,'wartet',$3)",[m,sha('fp'+rid),a]);
   return {rid,m,job};
  };
  const zustand=async id=>(await db.query('SELECT state,error_code FROM work_jobs WHERE id=$1',[id])).rows[0];

  // 1) Auftrag -> Zeilen reverse_dateien, Dateien unter <rid>/entpackt/m<id>/, Auftrag completed.
  const a1=await neuerAuftrag(1);
  const r1=await executor.durchlauf();await executor.leerlauf();
  assert.equal(r1.gestartet,1,JSON.stringify(r1));
  assert.equal((await zustand(a1.job.id)).state,'completed');
  const zeilen=(await db.query('SELECT pfad,storage_key FROM reverse_dateien WHERE eintrag_id=$1 ORDER BY pfad',[a1.rid])).rows;
  assert.deepEqual(zeilen.map(z=>z.pfad).sort(),['CD1/DATEN/a.txt','CD1/b.bin']);
  assert.equal(await readFile(join(reverseRoot,a1.rid,'entpackt','m'+a1.m,'DATEN','a.txt'),'utf8'),'hallo');
  assert.equal((await db.query("SELECT status FROM reverse_schichten WHERE medium_id=$1 AND schicht='E' AND aktuell",[a1.m])).rows[0].status,'fertig');
  await assert.rejects(()=>stat(join(konfig.arbeitRoot,a1.job.id)),'Arbeitsordner nach Abschluss entfernt');
  const o=starts[0];
  assert.equal(o.HostConfig.NetworkMode,'none');assert.equal(o.HostConfig.ReadonlyRootfs,true);assert.ok(o.HostConfig.Tmpfs['/tmp'].startsWith('size=512m'));
  // P18-T64: ein globaler Container – /arbeit ist der ganze Arbeitsbereich, je Auftrag ein Unterordner.
  assert.deepEqual(o.HostConfig.Binds,[reverseRoot+':/bib:ro',konfig.arbeitRoot+':/arbeit:rw']);
  assert.equal(o.Image,'synapse-reverse@sha256:'+'a'.repeat(64));
  assert.equal((await db.query('SELECT count(*)::int AS n FROM tool_activation WHERE tool_id=$1 AND project=$2 AND enabled',[ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT])).rows[0].n,1,'E1 Aktivierung');
  console.log('PASS 1 Auftrag -> reverse_dateien');

  // 2) Später Abschluss nach Lease-Ablauf wird abgewiesen.
  const a2=await neuerAuftrag(2);
  konfig.leaseSeconds=2;verzoegerung=3000;
  const r2=await executor.durchlauf();await executor.leerlauf();
  assert.equal(r2.gestartet,1,JSON.stringify(r2));
  assert.equal(uebernahmen,1,'keine Übernahme nach Lease-Ablauf');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reverse_dateien WHERE eintrag_id=$1',[a2.rid])).rows[0].n,0);
  assert.notEqual((await zustand(a2.job.id)).state,'completed');
  const lease2=(await db.query('SELECT claim_token FROM work_jobs WHERE id=$1',[a2.job.id])).rows[0].claim_token;
  assert.deepEqual(await jobs.complete(wer,a2.job.id,lease2,a2.job.inputRef),{completed:false},'Abschluss nach Ablauf abgewiesen');
  konfig.leaseSeconds=30;verzoegerung=0;
  await db.query("UPDATE work_jobs SET state='cancelled',lease_until=NULL WHERE id=$1",[a2.job.id]);
  console.log('PASS 2 später Abschluss abgewiesen');

  // 3) Fremde Identität: kein Claim, kein Stage/Complete auf fremder Lease; anderer Kind bleibt liegen.
  const a3=await neuerAuftrag(3),a4=await neuerAuftrag(4,'reverse-S2');
  await lc.wake(ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT,a3.job.id);await lc.wake(ex.REVERSE_TOOL_ID,ex.REVERSE_PROJEKT,a4.job.id);
  assert.deepEqual(await jobs.claim(fremd,{limit:2}),[],'fremde Identität bekommt nichts');
  assert.deepEqual(await jobs.claim({...wer,authHash:'falsch'},{limit:2}),[],'falscher Ausweis bekommt nichts');
  assert.equal(await executor.hooks().authorizeJob({node_id:fremd.nodeId,boot_id:fremd.bootGeneration,service_token_hash:fremd.authHash},a3.job),null);
  assert.equal((await executor.containerStatus(a3.rid)).zustand,'laeuft','containerStatus aus dem Lebenszyklus');
  const [eigen]=await jobs.claim(wer,{limit:2,leaseSeconds:30});
  assert.equal(eigen?.id,a3.job.id,'nur reverse-E, kein reverse-S2');
  assert.equal(await jobs.stage(fremd,a3.job.id,eigen.claimToken,{scope:'reverse',id:a3.job.id,revision:'1',sha256:'c'.repeat(64)}),false);
  assert.deepEqual(await jobs.complete(fremd,a3.job.id,eigen.claimToken,a3.job.inputRef),{completed:false});
  assert.equal(await jobs.release(wer,a3.job.id,eigen.claimToken),true);
  assert.equal((await zustand(a4.job.id)).state,'pending','reverse-S2 nicht geclaimt');
  console.log('PASS 3 fremde Identität abgewiesen');
  await db.query("UPDATE work_jobs SET state='cancelled' WHERE id=ANY($1::uuid[])",[[a3.job.id,a4.job.id]]);

  // 4) W5: fachlicher Übernahmefehler -> failed; sonstiger Fehler -> release, nach Versuchszahl failed.
  const echt=executor.deps.uebernahme;
  const a5=await neuerAuftrag(5);
  executor.deps.uebernahme=async()=>{throw new ReverseEUebernahmeFehler('pfad_gefahr','Fixture');};
  await executor.durchlauf();await executor.leerlauf();
  assert.deepEqual(await zustand(a5.job.id),{state:'failed',error_code:'pfad_gefahr'});
  const a6=await neuerAuftrag(6);
  executor.deps.uebernahme=async()=>{throw new Error('DB weg');};
  await executor.durchlauf();await executor.leerlauf();
  assert.equal((await zustand(a6.job.id)).state,'pending','sonstiger Fehler gibt frei');
  konfig.retryMax=1;
  await executor.durchlauf();await executor.leerlauf();
  assert.deepEqual(await zustand(a6.job.id),{state:'failed',error_code:'werkzeug_fehler'},'Versuchszähler beendet Neuentpacken');
  konfig.retryMax=3;executor.deps.uebernahme=echt;
  console.log('PASS 4 Übernahmefehler failed/release mit Versuchszähler');

  // 5) W3: bei parallel 1 wird nur ein Auftrag geweckt und geclaimt.
  const a7=await neuerAuftrag(7),a8=await neuerAuftrag(8);
  const r5=await executor.durchlauf();
  assert.equal(r5.geweckt,1,JSON.stringify(r5));assert.equal(r5.gestartet,1);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM tool_containers WHERE tool_id=$1 AND state<>'cold'",[ex.REVERSE_TOOL_ID])).rows[0].n,1,'P18-T64: genau ein Reverse-Container');
  await executor.leerlauf();
  assert.equal((await zustand(a7.job.id)).state,'completed');assert.equal((await zustand(a8.job.id)).state,'pending');
  console.log('PASS 5 nur freie Plätze geweckt');
 }finally{
  if(vorherigeReverseImage===undefined)delete process.env.SYNAPSE_REVERSE_IMAGE;
  else process.env.SYNAPSE_REVERSE_IMAGE=vorherigeReverseImage;
  unhook?.();lc?.close();
  await pool.query('DROP SCHEMA IF EXISTS "'+schema+'" CASCADE');await pool.end();
  await rm(root,{recursive:true,force:true});
 }
});
