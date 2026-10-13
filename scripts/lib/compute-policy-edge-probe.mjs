import assert from 'node:assert/strict';
import {oeffneGeschuetzteShellTestDb} from './test-db-schutz.mjs';
export async function runComputePolicyEdges(db,policy,node,project,request) {
  const input={nodeId:node,project,capability:'embedding',profileCompatible:true,resourcesAvailable:true};
  const decide=(extra={})=>policy.pruefeComputeZuteilung({...input,...extra},db);
  await policy.setzeComputeProjektPolicy(project,{pc_gpu_ausgeschlossen:false},db);
  await policy.setzeComputePolicy(node,{ausfuehrungsfreigabe:true,modus:'automatik',usersperre:{embedding:false},faehigkeit_schalter:{embedding:true}},db);
  assert.equal((await decide()).allowed,true);
  assert.equal((await decide({profileCompatible:false})).reason,'Profil nicht kompatibel');
  assert.equal((await decide({resourcesAvailable:false})).reason,'Ressourcen nicht verfügbar');
  assert.equal((await decide({capability:'unobserved'})).reason,'Fähigkeit nicht beobachtet');
  await db.query("UPDATE embedding_knoten SET letzter_kontakt=clock_timestamp()-interval '10 minutes' WHERE node_id=$1",[node]);
  assert.equal((await decide()).reason,'Knoten nicht frisch');
  await db.query('UPDATE embedding_knoten SET letzter_kontakt=clock_timestamp(),gesperrt_vom_user=true WHERE node_id=$1',[node]);
  assert.equal((await decide()).reason,'Knoten vom Nutzer gesperrt');
  await db.query('UPDATE embedding_knoten SET gesperrt_vom_user=false WHERE node_id=$1',[node]);
  process.env.SYNAPSE_COMPUTE_PC_HELP_NEEDED='0';
  assert.equal((await decide()).allowed,false);
  await policy.setzeComputePolicy(node,{modus:'manuell'},db);
  const manual=await decide();
  assert.equal(manual.allowed,true);assert.equal(manual.recommendation.empfohlen,false);
  assert.equal((await decide({resourcesAvailable:false})).allowed,false,'Manuell ersetzt keinen tatsächlichen Ressourcengrant');
  delete process.env.SYNAPSE_COMPUTE_PC_HELP_NEEDED;
  await policy.setzeComputePolicy(node,{modus:'automatik'},db);
  process.env.SYNAPSE_COMPUTE_MAX_CPU_LOAD_PERCENT='70';
  process.env.SYNAPSE_COMPUTE_MAX_GPU_LOAD_PERCENT='70';
  process.env.SYNAPSE_COMPUTE_TELEMETRY_MAX_AGE_MS='120000';
  assert.equal((await decide()).allowed,false,'Unbekannte Last hat keine positive Automatikempfehlung');
  async function telemetry(cpu,gpu,age=0) {
    const now=(await db.query('SELECT clock_timestamp() AS t')).rows[0].t;
    const m=(value,scope='host')=>({value,scope,quality:'measured',measuredAt:new Date(now.getTime()-age).toISOString(),serverReceivedAt:now.toISOString(),freshness:'fresh'});
    const resources={cpu:{cores:m(8),loadPercent:m(cpu)},ram:{totalMb:m(16000),availableMb:m(8000)},gpus:[{deviceId:'GPU-p20-fixture',origin:null,totalMb:m(1000,'device'),freeMb:m(0,'device'),residentOwnModelMb:m(500,'device'),utilizationPercent:m(gpu,'device')}]};
    await db.query('UPDATE embedding_knoten SET ressourcen=$2::jsonb WHERE node_id=$1',[node,JSON.stringify(resources)]);
  }
  await telemetry(70,70);assert.equal((await decide()).allowed,true,'Inklusive Lastgrenze');
  await telemetry(71,20);assert.equal((await decide()).recommendation.grund,'Eigene CPU-Last hoch oder unbekannt');
  await telemetry(20,71);assert.equal((await decide()).recommendation.grund,'Eigene GPU-Last hoch oder unbekannt');
  await telemetry(20,20,300000);assert.equal((await decide()).allowed,false,'Gespeichert fresh wird erneut geprüft');
  delete process.env.SYNAPSE_COMPUTE_MAX_CPU_LOAD_PERCENT;delete process.env.SYNAPSE_COMPUTE_MAX_GPU_LOAD_PERCENT;
  // Standortmeldung darf den PC nicht zur internen Unraid-Ausnahme machen.
  await db.query("UPDATE embedding_knoten SET location='unraid' WHERE node_id=$1",[node]);
  await policy.setzeComputePolicy(node,{ausfuehrungsfreigabe:false},db);
  assert.equal((await decide()).allowed,false);
  await policy.setzeComputePolicy(node,{ausfuehrungsfreigabe:true},db);
  await db.query("UPDATE embedding_knoten SET location='pc' WHERE node_id=$1",[node]);
  // Mehrere Hostzeilen desselben logischen Projekts teilen exakt eine Policy.
  await db.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'second-host','/fixture/second',true)",[project]);
  await policy.setzeComputeProjektPolicy(project,{pc_gpu_ausgeschlossen:true},db);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM compute_project_policy WHERE project=$1',[project])).rows[0].n,'1');
  assert.equal((await decide()).reason,'Projekt ausgeschlossen');
  // Zwei echte geprüfte Verbindungen: Claim-Snapshot sperrt Userpolicy bis Commit.
  const left=await oeffneGeschuetzteShellTestDb(),right=await oeffneGeschuetzteShellTestDb();
  try {
    await left.query('SET search_path=p20_r12,public');await right.query('SET search_path=p20_r12,public');
    const leftPid=(await left.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const rightPid=(await right.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    async function proveBlocked(write) {
      await left.query('BEGIN');await policy.ladeComputePolicySnapshot(node,left);
      const pending=write();
      try {
        let blocked=false;
        for(let attempt=0;attempt<200&&!blocked;attempt++) {
          blocked=(await db.query('SELECT $1=ANY(pg_blocking_pids($2)) AS blocked',[leftPid,rightPid])).rows[0].blocked;
        }
        assert.equal(blocked,true,'Policywriter wartet auf echten Claim-Snapshotlock');
      } finally {await left.query('COMMIT');await pending;}
    }
    await proveBlocked(()=>policy.setzeComputePolicy(node,{modus:'manuell'},right));
    await proveBlocked(()=>policy.setzeComputeProjektPolicy(project,{pc_gpu_ausgeschlossen:false},right));
    const current=await policy.leseComputePolicy(node,db);
    const race=await Promise.allSettled([policy.setzeComputePolicy(node,{policyRevision:current.policyRevision,modus:'manuell'},left),policy.setzeComputePolicy(node,{policyRevision:current.policyRevision,modus:'automatik'},right)]);
    assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(race.find(r=>r.status==='rejected').reason.code,'policy_revision_conflict');
    assert.equal((await policy.leseComputePolicy(node,db)).policyRevision,current.policyRevision+1);
  } finally {await left.query('ROLLBACK');await left.end();await right.end();}
  await assert.rejects(policy.setzeComputePolicy(node,{policyRevision:Number.MAX_SAFE_INTEGER+1},db),e=>e.code==='invalid_policy_revision');
  const revision=(await policy.leseComputePolicy(node,db)).policyRevision;
  await db.query('UPDATE compute_node_policy SET policy_revision=$2 WHERE node_id=$1',[node,String(Number.MAX_SAFE_INTEGER)]);
  await assert.rejects(policy.setzeComputePolicy(node,{modus:'automatik'},db),e=>e.code==='policy_revision_exhausted');
  await db.query('UPDATE compute_node_policy SET policy_revision=$2 WHERE node_id=$1',[node,revision]);
  const {CPU_NODES_SCHEMA_SQL}=await import('../../packages/core/dist/db/cpu-nodes-schema.js');
  const {registerCpuNode}=await import('../../packages/rest-api/dist/services/cpu-nodes.js');
  await db.query(CPU_NODES_SCHEMA_SQL);
  const capability={id:'fixture.cpu',profileRef:{scope:'p20',id:'cpu',revision:'1',sha256:'c'.repeat(64)}};
  const cpuId='p20-r12-cpu';
  process.env.SYNAPSE_API_FEATURES='compute_resources,compute_cpu_only';
  const bindings=JSON.parse(process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS);
  bindings[cpuId]={hostResourceDomain:'p20-cpu',deviceIds:[],location:'pc'};
  process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS=JSON.stringify(bindings);
  await registerCpuNode({nodeId:cpuId,host:'fixture-cpu',bootId:'22222222-2222-4222-8222-222222222222',
    bootStartedAt:'2026-01-01T00:00:00Z',maxConcurrency:2,contractVersion:1,
    features:['compute_cpu_only','compute_resources'],resources:{cpu:{},ram:{},gpus:[]},capabilities:[capability]},
    'p20-r12-cpu-hash','1',db);
  const cpu=await request('GET','/api/embedding-nodes/'+cpuId+'/policy',null,'daemon');
  assert.equal(cpu.statusCode,200);assert.equal(cpu.json().registered,true);assert.equal(cpu.json().observedCapabilities[0].id,'fixture.cpu');
  const prereg='p20-r12-prereg';
  await db.query("INSERT INTO auth_tokens(token_hash,kind,scope) VALUES('p20-prereg-hash','service',$1)",['compute-node:'+prereg]);
  assert.equal((await request('PATCH','/api/embedding-nodes/'+prereg+'/policy',{ausfuehrungsfreigabe:true},'daemon')).statusCode,200);
  const status=await request('GET','/api/embedding-nodes/'+prereg+'/policy',null,'daemon');
  assert.equal(status.statusCode,200);assert.equal(status.json().registered,false);
  assert.equal(status.json().policy.ausfuehrungsfreigabe,true);assert.equal(typeof status.json().policy.policyRevision,'number');
  assert.equal(status.json().recommendations.embedding.empfohlen,false);
  console.log('R1.2/T9 Grenzfälle grün: Frische/CPU/GPU/Unraidbedarf/Manuell, Ressourcen/Profile, Standortspoof, Mehrhostprojekt, zwei PG-Verbindungen Locks/CAS, Overflow, CPU-only/Vorregistry-API');
}
