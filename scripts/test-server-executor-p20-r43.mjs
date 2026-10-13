#!/usr/bin/env node
// P20-T18/R4.3: zwei reale Prozesse, Boot-/Ownerfences und Scope-Proben in eigenem Testschema.
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {mitLesePool} from '../packages/core/dist/db/client.js';
import {CPU_NODES_SCHEMA_SQL} from '../packages/core/dist/db/cpu-nodes-schema.js';
import {SERVER_EXECUTOR_SCHEMA_SQL} from '../packages/core/dist/db/server-executor-schema.js';
import {oeffneGeschuetzteShellTestDb} from './lib/test-db-schutz.mjs';
import {readServerHostProbe,ServerExecutor} from '../packages/rest-api/dist/services/server-executor.js';
const db=await oeffneGeschuetzteShellTestDb();
const schema='p20_r43_'+process.pid;
const actors=[];
let count=0;
function check(label,fn){fn();count++;console.log('PASS '+label);}
async function actor(nodeId,owner,hash){
  const proc=fork(new URL('./lib/p20-r43-executor-child.mjs',import.meta.url),[],{
    env:{...process.env,R43_SCHEMA:schema,R43_TOKEN_HASH:hash,SYNAPSE_SERVER_NODE_ID:nodeId,SYNAPSE_SERVER_EXECUTOR_OWNER:owner},
    stdio:['ignore','pipe','pipe','ipc']});
  actors.push(proc);
  let output='';
  proc.stdout.on('data',x=>{output+=x;});
  proc.stderr.on('data',x=>{output+=x;});
  const ready=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('child_timeout '+output)),15000);
    proc.once('error',reject);
    proc.once('exit',code=>reject(Error('child_exit '+code+' '+output)));
    proc.once('message',m=>{clearTimeout(timeout);resolve(m);});
  });
  assert.equal(ready.ready,true);let next=0;
  const request=op=>new Promise((resolve,reject)=>{
    const id=++next;
    const timeout=setTimeout(()=>{proc.off('message',receive);reject(Error('ipc_timeout'));},10000);
    function receive(m){if(m.id===id){clearTimeout(timeout);proc.off('message',receive);resolve(m);}}
    proc.on('message',receive);proc.send({id,op});
  });
  return {proc,...ready,request};
}
let made=false;
try{
  await db.query('CREATE SCHEMA '+schema);made=true;
  await db.query('SET search_path TO '+schema+',public');
  // Kleiner realer PG-Vertrag der Boot-/Claim-Autorität; kein Zugriff auf Produktionsdaten.
  await db.query(`CREATE TABLE auth_tokens(token_hash text PRIMARY KEY,kind text,scope text,expires_at timestamptz);
    CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text NOT NULL,boot_started_at timestamptz NOT NULL,
      executor_owner text,service_token_hash text,host_resource_domain text,node_kind text DEFAULT 'embedding',
      modell text DEFAULT 'r43-fixture',status text DEFAULT 'ready',gesperrt_vom_user boolean DEFAULT false);
    CREATE TABLE code_chunks(id text PRIMARY KEY,claimed_by text,claim_token text,lease_until timestamptz,embedded_at timestamptz);`);
  for(const [n,h] of [['r43-a','a'],['r43-b','b']])
    await db.query("INSERT INTO auth_tokens VALUES($1,'service',$2,NOW()+INTERVAL '1 hour')",[h.repeat(64),'compute-node:'+n]);
  const a=await actor('r43-a','owner-a','a'.repeat(64));
  const b=await actor('r43-b','owner-b','b'.repeat(64));
  check('zwei Prozesse mit getrennten UUID-Boots',()=>{assert.notEqual(a.pid,b.pid);assert.notEqual(a.identity.bootId,b.identity.bootId);assert.notEqual(a.identity.claimOwner,b.identity.claimOwner);assert.equal(a.released,0);assert.equal(b.released,0);});
  check('aktuelle Generation A/B darf claimen',()=>{});
  assert.equal((await a.request('mayClaim')).value,true);assert.equal((await b.request('mayClaim')).value,true);
  for(const [id,owner] of [['a-old',a.identity.claimOwner],['b-live',b.identity.claimOwner],['legacy','unraid-local']])
    await db.query("INSERT INTO code_chunks VALUES($1,$2,$3,NOW()+INTERVAL '10 minutes',NULL)",[id,owner,id+'-token']);
  assert.equal((await a.request('start')).value,0);
  check('idempotenter Start hebt laufenden Claim nicht auf',()=>{});
  assert.equal((await db.query("SELECT claimed_by FROM code_chunks WHERE id='a-old'")).rows[0].claimed_by,a.identity.claimOwner);
  // A2 startet, während A1 und B noch laufen: typisches Deploy-Überlappungsfenster.
  const a2=await actor('r43-a','owner-a','a'.repeat(64));
  const rows=(await db.query('SELECT * FROM code_chunks ORDER BY id')).rows;
  check('Neustart gibt exakt eigene Altgeneration frei',()=>{
    assert.equal(a2.released,1);
    const old=rows.find(r=>r.id==='a-old');assert.equal(old.claimed_by,null);assert.equal(old.claim_token,null);assert.equal(old.lease_until,null);
    assert.equal(rows.find(r=>r.id==='b-live').claimed_by,b.identity.claimOwner);
    assert.equal(rows.find(r=>r.id==='legacy').claimed_by,'unraid-local');
    assert.notEqual(a2.identity.claimOwner,a.identity.claimOwner);
  });
  assert.equal((await a.request('mayClaim')).value,false);assert.equal((await a2.request('mayClaim')).value,true);
  assert.equal((await b.request('mayClaim')).value,true);assert.equal((await a2.request('wrongClaim')).value,false);
  check('alte Generation gesperrt, neuer Boot und fremder Prozess unverändert zugelassen',()=>{});
  assert.equal((await a.request('start')).error,'server_executor_stale_boot');
  assert.equal((await a2.request('wrongOwner')).error,'server_executor_owner_conflict');
  assert.equal((await a2.request('wrongToken')).error,'server_executor_token_invalid');
  check('staler Start/Ownerwechsel/Tokenwechsel ändern Registry nicht',()=>{});
  assert.equal((await db.query("SELECT boot_id FROM embedding_knoten WHERE node_id='r43-a'")).rows[0].boot_id,a2.identity.bootId);
  await db.query("UPDATE embedding_knoten SET gesperrt_vom_user=true WHERE node_id='r43-a'");
  assert.equal((await a2.request('mayClaim')).value,false);
  await db.query("UPDATE embedding_knoten SET gesperrt_vom_user=false,node_kind='cpu',modell=NULL WHERE node_id='r43-a'");
  assert.equal((await a2.request('mayClaim')).value,false);
  await db.query("UPDATE embedding_knoten SET node_kind='embedding',modell='r43-fixture' WHERE node_id='r43-a'");
  await db.query("UPDATE auth_tokens SET expires_at=NOW()-INTERVAL '1 second' WHERE token_hash=$1",['a'.repeat(64)]);
  assert.equal((await a2.request('mayClaim')).value,false);
  check('Usersperre/CPU-only/abgelaufenes Service-Token sperren Embedding',()=>{});
  process.env.SYNAPSE_API_FEATURES='compute_resources';
  process.env.SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS='60000';
  process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS=JSON.stringify({'r43-probe':{hostResourceDomain:'r43-host',deviceIds:['GPU-r43'],location:'unraid'}});
  delete process.env.SYNAPSE_SERVER_HOST_PROBE_FILE;
  const unknown=await readServerHostProbe('r43-probe');
  check('fehlende Hostprobe bleibt vollständig unknown',()=>{
    assert.equal(unknown.cpu.cores.value,null);assert.equal(unknown.ram.availableMb.value,null);
    assert.equal(unknown.cpu.cores.scope,null);assert.equal(unknown.cpu.cores.freshness,'unknown');
    assert.equal(unknown.gpus[0].freeMb.value,null);assert.equal(unknown.gpus[0].freeMb.quality,'unknown');
  });
  process.env.SYNAPSE_SERVER_HOST_PROBE_FILE=fileURLToPath(new URL('./fixtures/p20-r43-hostprobe.json',import.meta.url));
  const measured=await readServerHostProbe('r43-probe');
  check('Container-RAM bleibt Containerwert; alte Messung wird stale',()=>{
    assert.equal(measured.cpu.cores.value,4);assert.equal(measured.cpu.cores.scope,'container');
    assert.equal(measured.ram.availableMb.value,128);assert.equal(measured.ram.availableMb.scope,'container');
    assert.equal(measured.cpu.cores.quality,'measured');assert.equal(measured.cpu.cores.freshness,'stale');
    assert.ok(measured.cpu.cores.serverReceivedAt);assert.equal(measured.gpus[0].freeMb.scope,'device');
  });
  process.env.SYNAPSE_SERVER_HOST_PROBE_FILE=fileURLToPath(new URL('./lib/p20-r43-executor-child.mjs',import.meta.url));
  const invalid=await readServerHostProbe('r43-probe');
  check('ungültige Probe erzeugt keine erfundene Freiheit',()=>{assert.equal(invalid.ram.availableMb.value,null);assert.equal(invalid.ram.availableMb.quality,'unknown');});
  // Auch den realen REST-Serveradapter prüfen, nicht nur die isolierte Core-Bootautorität.
  await db.query('DROP TABLE '+schema+'.embedding_knoten,'+schema+'.auth_tokens');
  await db.query('CREATE TABLE auth_tokens (LIKE public.auth_tokens INCLUDING ALL); CREATE TABLE embedding_knoten (LIKE public.embedding_knoten INCLUDING ALL)');
  await db.query(await readFile(new URL('../packages/core/src/db/schema-sql/46_compute_ressourcen.sql',import.meta.url),'utf8'));
  await db.query(CPU_NODES_SCHEMA_SQL);await db.query(SERVER_EXECUTOR_SCHEMA_SQL);
  const token='p20-r43-synthetischer-service-token';
  const tokenHash=createHash('sha256').update(token).digest('hex');
  await db.query("INSERT INTO auth_tokens(token_hash,kind,scope,expires_at) VALUES($1,'service','compute-node:r43-adapter',NOW()+INTERVAL '1 hour')",[tokenHash]);
  process.env.SYNAPSE_SERVER_NODE_ID='r43-adapter';
  process.env.SYNAPSE_SERVER_EXECUTOR_OWNER='adapter-owner';
  process.env.SYNAPSE_SERVER_COMPUTE_TOKEN=token;
  process.env.SYNAPSE_NODE_MAX_CLAIMS='2';
  process.env.SYNAPSE_API_FEATURES='compute_resources,compute_cpu_only';
  process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS=JSON.stringify({'r43-adapter':{hostResourceDomain:'r43-host',deviceIds:[],location:'unraid'}});
  process.env.SYNAPSE_SERVER_NODE_REGISTRATION=JSON.stringify({host:'fixture',maxConcurrency:2,
    features:['compute_cpu_only','compute_resources'],capabilities:[{id:'reverse.inspect',
      profileRef:{scope:'test',id:'r43-cpu',revision:'1',sha256:'c'.repeat(64)}}]});
  delete process.env.SYNAPSE_SERVER_HOST_PROBE_FILE;
  const client={query:db.query.bind(db),release(){}};
  const pool={query:db.query.bind(db),connect:async()=>client};
  const adapter=new ServerExecutor();
  await mitLesePool(pool,async()=>{
    assert.equal(await adapter.start(),0);
    assert.equal(await adapter.refresh(),true);
    let row=(await db.query("SELECT * FROM embedding_knoten WHERE node_id='r43-adapter'")).rows[0];
    check('realer CPU-Adapter registriert ohne Modell/VRAM mit Auth+R1.1-DDL',()=>{
      assert.equal(row.node_kind,'cpu');assert.equal(row.modell,null);assert.equal(row.vram_gesamt_mb,null);
      assert.equal(row.executor_owner,'adapter-owner');assert.equal(row.host_resource_domain,'r43-host');
      assert.equal(row.boot_id,adapter.identity.bootId);assert.equal(Number(row.last_sequence),1);
      assert.equal(row.ressourcen.ram.availableMb.value,null);
    });
    await db.query("UPDATE embedding_knoten SET boot_id='22222222-2222-4222-8222-222222222222' WHERE node_id='r43-adapter'");
    assert.equal(await adapter.refresh(),false);
    row=(await db.query("SELECT * FROM embedding_knoten WHERE node_id='r43-adapter'")).rows[0];
    check('alter Adapterheartbeat überschreibt neue Registrygeneration nie',()=>{
      assert.equal(row.boot_id,'22222222-2222-4222-8222-222222222222');assert.equal(Number(row.last_sequence),1);
    });
  });
  console.log('R4.3 '+count+' Szenarien PASS, echte Prozesse und echte synapse_test-TX, kein Skip');
}finally{
  await Promise.all(actors.map(p=>new Promise(resolve=>{if(p.exitCode!==null)return resolve();p.once('exit',resolve);p.kill('SIGTERM');setTimeout(()=>{if(p.exitCode===null)p.kill('SIGKILL');},3000).unref();})));
  if(made)await db.query('DROP SCHEMA '+schema+' CASCADE');
  await db.end();
}
