import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {runComputePolicyEdges} from './compute-policy-edge-probe.mjs';
export async function runComputePolicyProbe(db,mode) {
const pool={query:db.query,connect:async()=>({query:db.query,release(){}})};
await db.query('CREATE SCHEMA IF NOT EXISTS p20_r12');
const A='p20_t9_a', B='p20_t9_b', NODE='p20-r12-pc';
Object.assign(process.env,{SYNAPSE_COMPUTE_POLICY_ENABLED:'0',OLLAMA_MODEL:'p20-r12-model',
  SYNAPSE_OLLAMA_MODEL_DIGEST:'a'.repeat(64),SYNAPSE_OLLAMA_NATIVE_DIMENSION:'8',
  EMBEDDING_TARGET_DIM:'4',EMBEDDING_NUM_CTX:'512',SYNAPSE_GPU_REQUIRED_TOTAL_MB:'100',
  SYNAPSE_GPU_REQUIRED_FREE_MB:'50',EMBEDDING_QUERY_PREFIX:'q: ',EMBEDDING_DOC_PREFIX:'d: ',
  SYNAPSE_NODE_MAX_CLAIMS:'8',OLLAMA_URL:'http://127.0.0.1:9',SYNAPSE_API_FEATURES:'compute_resources'});
process.env.SYNAPSE_COMPUTE_RESOURCE_BINDINGS=JSON.stringify({[NODE]:{
  hostResourceDomain:'p20-fixture-pc',deviceIds:['GPU-p20-fixture'],location:'pc'}});
globalThis.fetch=async()=>{throw new Error('kein externes IO');};
const base=process.env.P20_COMPUTE_DIST_BASE?pathToFileURL(process.env.P20_COMPUTE_DIST_BASE+'/'):new URL('../../',import.meta.url);
const core=await import(new URL('packages/core/dist/index.js',base));
const corePool=core.getPool();
corePool.query=db.query;
corePool.connect=pool.connect;
const claims=await import(new URL('packages/core/dist/services/embedding-claims.js',base));
const tables=['projects','code_files','code_chunks','embed_prioritaet','auth_tokens','embedding_knoten','work_jobs','work_job_audit'];
const boot='11111111-1111-4111-8111-111111111111';
const authHash='p20-r12-auth';
async function seed(projects=[A]) {
  for(const p of projects) {
    await db.query("INSERT INTO projects(name,hostname,path,enabled) VALUES($1,'test',$2,true)",[p,'/fixture/'+p]);
    await db.query("INSERT INTO code_files(id,project,file_path,file_name,file_type) VALUES($1,$2,'src/a.ts','a.ts','ts')",[p+'-file',p]);
    await db.query("INSERT INTO embed_prioritaet(project,stufe,gesetzt_von) VALUES($1,1,'sol-5')",[p]);
    for(const [n,prio] of [[1,1],[2,null],[3,-1]]) await db.query(
      "INSERT INTO code_chunks(id,project,file_path,chunk_index,content,line_start,line_end,prio) VALUES($1,$2,'src/a.ts',$3,$4,1,1,$5)",
      [p+'-'+n,p,n,'fixture '+n,prio]);
  }
}
const reset=()=>db.query('UPDATE code_chunks SET claimed_by=NULL,claim_token=NULL,lease_until=NULL,claim_attempt=0,embedded_at=NULL');
const claim=(node=NODE,options={})=>claims.claimEmbeddingChunks(node,{limit:8,maxConcurrent:100,...options},pool);
const serverClaims=async()=>[...await claim('p20-r12-server',{internalServer:true}),...await claim('p20-r12-server',{internalServer:true})];
const normalized=cs=>cs.map(({claimToken,leaseUntil,...c})=>({...c,claimToken:'<token>',leaseUntil:'<zeit>'}));
let app;
try {
  for(const name of tables) await db.query('CREATE TABLE p20_r12.'+name+' (LIKE public.'+name+' INCLUDING DEFAULTS INCLUDING CONSTRAINTS)');
  await db.query('CREATE UNIQUE INDEX ON embedding_knoten(node_id)');
  await db.query('CREATE UNIQUE INDEX ON work_jobs(idempotency_key)');
  await db.query('CREATE UNIQUE INDEX ON code_chunks(id)');
  await seed();
  const old=normalized(await claim());
  assert.equal(old.length,3);
  if(mode==='record') {
    assert.equal(JSON.stringify(old),JSON.stringify(JSON.parse(readFileSync(new URL('../fixtures/p20-r12-claims.golden.json',import.meta.url),'utf8'))));
    console.log('GOLDEN unverändert gegen '+(process.env.P20_COMPUTE_DIST_BASE??'W2'));
  }
  else {
    assert.equal(JSON.stringify(old),JSON.stringify(JSON.parse(readFileSync(new URL('../fixtures/p20-r12-claims.golden.json',import.meta.url),'utf8'))));
    const policy=await import('../../packages/core/dist/services/compute-policy.js');
    if(mode==='red') assert.equal(typeof policy.pruefeComputeZuteilung,'function');
    else {
      const {COMPUTE_POLICY_SCHEMA_SQL}=await import('../../packages/core/dist/db/compute-policy-schema.js');
      await db.query(COMPUTE_POLICY_SCHEMA_SQL);await db.query(COMPUTE_POLICY_SCHEMA_SQL);
      await db.query("INSERT INTO auth_tokens(token_hash,kind,scope) VALUES($1,'service',$2)",[authHash,'compute-node:'+NODE]);
      // Policy darf vor Registry bestehen, erzeugt aber keine gesunde Knoten-Zeile.
      const pre=await policy.setzeComputePolicy(NODE,{ausfuehrungsfreigabe:true},db);
      assert.equal(pre.policyRevision,1);
      assert.equal((await db.query('SELECT COUNT(*) AS n FROM embedding_knoten')).rows[0].n,'0');
      const ref={model:process.env.OLLAMA_MODEL,modelDigest:'a'.repeat(64),nativeDimension:8,targetDimension:4,numCtx:512};
      const {registerEmbeddingNode}=await import('../../packages/rest-api/dist/services/embedding-nodes.js');
      await registerEmbeddingNode(authHash,{...ref,nodeId:NODE,host:'fixture',ollamaUrl:'http://127.0.0.1:9',
        vramTotalMb:1000,vramFreeMb:0,maxConcurrency:8,bootId:boot,bootStartedAt:'2026-01-01T00:00:00Z'},db);
      if (mode !== 'policy') {
      process.env.SYNAPSE_COMPUTE_POLICY_ENABLED='1';
      await reset();assert.equal((await claim()).length,3,'Standardprojekt an nach Consent');
      await reset();await policy.setzeComputeProjektPolicy(A,{pc_gpu_ausgeschlossen:true},db);
      assert.equal((await claim()).length,0,'Opt-out in allen drei Priozweigen');
      await seed([B]); // zwei eigene Testprojekte, A bleibt gesperrt
      assert.ok((await claim()).every(c=>c.project===B),'Normale Auswahl überspringt gesperrtes Projekt');
      await reset();const held=await claim();assert.equal(held.length,3);
      await policy.setzeComputeProjektPolicy(B,{pc_gpu_ausgeschlossen:true},db);
      assert.equal((await claim()).length,0);
      assert.equal((await db.query('SELECT COUNT(*) AS n FROM code_chunks WHERE claimed_by=$1 AND lease_until>NOW()',[NODE])).rows[0].n,'3','laufende Leases bleiben');
      // Regulärer Abschluss weiterhin zulässig nach Opt-out, ohne neue Zuteilung.
      const done=await claims.completeEmbeddingClaim({nodeId:NODE,chunkId:held[0].chunkId,claimToken:held[0].claimToken,
        contentHash:held[0].contentHash,vector:[1,0,0,0],expectedDimension:4},
        {pool,ensureCollection:async()=> 'p20_t9',writeVector:async()=>{}});
      assert.equal(done.completed,true);
      await reset();assert.equal((await serverClaims()).length,6,'Unraid übernimmt Opt-out');
      await reset();await policy.setzeComputeProjektPolicy(A,{pc_gpu_ausgeschlossen:false},db);
      await policy.setzeComputePolicy(NODE,{usersperre:{embedding:true}},db);
      const decision=await policy.pruefeComputeZuteilung({nodeId:NODE,project:A,capability:'embedding',
        profileCompatible:true,resourcesAvailable:true},db);
      assert.equal(decision.allowed,false);assert.equal(decision.reason,'Fähigkeit vom Nutzer gesperrt');
      assert.equal((await claim()).length,0,'Usersperre gewinnt gegen Automatik');
      await policy.setzeComputePolicy(NODE,{modus:'automatik'},db);
      assert.equal((await claim()).length,0,'Modus/Empfehlung hebt Usersperre nicht auf');
      await policy.setzeComputePolicy(NODE,{usersperre:{embedding:false},modus:'manuell',faehigkeit_schalter:{embedding:false}},db);
      assert.equal((await claim()).length,0,'Manuelles Häkchen erforderlich');
      const active=await policy.setzeComputePolicy(NODE,{faehigkeit_schalter:{embedding:true}},db);
      assert.ok(BigInt(active.policyRevision)>1n);assert.equal((await claim()).length,3);
      await reset();await policy.setzeComputePolicy(NODE,{ausfuehrungsfreigabe:false},db);
      assert.equal((await claim()).length,0,'Trayfreigabe aus verhindert PC-Arbeit');
      assert.equal((await serverClaims()).length,6);
      await reset();
      // Work-Jobs nutzen dieselbe Policy und den Opt-out nach realem Grantbudget.
      await policy.setzeComputePolicy(NODE,{ausfuehrungsfreigabe:true},db);
      const {createWorkJobService}=await import('../../packages/core/dist/services/work-jobs.js');
      const work=createWorkJobService({pool,config:{interactiveReserve:0,maxClaimsPerCall:4},
        resourceDomain:()=> 'p20-fixture-pc',inputStillCurrent:async()=>true,outputIsStaged:async()=>true,
        authorizeJob:async()=>({resourceDomain:'p20-fixture-pc',maxConcurrent:4,budget:{cpu:8,ram:1000,vram:1000,gpu:true}})});
      const who={nodeId:NODE,bootGeneration:boot,authHash};
      const jobs=[];
      for(const project of [A,B]) jobs.push(await work.enqueue({kind:'fixture.embedding',capability:'embedding',
        project,scope:'p20',inputRef:{scope:'p20',id:project+'-input',revision:'1',sha256:'b'.repeat(64)},
        resourceNeed:{cpu:1,ram:1,vram:1,gpu:true},idempotencyKey:project+'-work'}));
      await policy.setzeComputeProjektPolicy(A,{pc_gpu_ausgeschlossen:true},db);
      assert.equal((await work.claim(who,{limit:4})).length,0,'Workjobs Optout beider Projekte');
      await policy.setzeComputeProjektPolicy(A,{pc_gpu_ausgeschlossen:false},db);
      const granted=await work.claim(who,{limit:4});
      assert.equal(granted.length,1);assert.equal(granted[0].project,A);
      await policy.setzeComputeProjektPolicy(A,{pc_gpu_ausgeschlossen:true},db);
      assert.equal((await work.claim(who,{limit:4})).length,0,'Workjobs keine neue nach Optout');
      assert.equal((await work.get(granted[0].id,A)).state,'leased','laufender Job bleibt leased');
      assert.equal(await work.release(who,granted[0].id,granted[0].claimToken),true);
      assert.equal((await db.query('SELECT COUNT(*) AS n FROM compute_project_policy WHERE project=$1',[A])).rows[0].n,'1');
      }
      const req=createRequire(new URL('../../packages/rest-api/package.json',import.meta.url));
      const {registerComputePolicyRoutes}=await import('../../packages/rest-api/dist/routes/compute-policy.js');
      app=req('fastify')();
      const identities={compute:{kind:'service',scope:'compute-node:'+NODE,token_hash:authHash},
        daemon:{kind:'service',scope:'daemon:p20-fixture',token_hash:'daemon-hash'},
        session:{kind:'session',scope:null,token_hash:'session-hash'}};
      await registerComputePolicyRoutes(app,{db,validateToken:async t=>identities[t]??null});
      const request=(method,path,payload,t='compute')=>app.inject({method,url:path,headers:{authorization:'Bearer '+t},
        ...(payload?{payload}:{})});
      assert.equal((await request('PATCH','/api/embedding-nodes/'+NODE+'/policy',{ausfuehrungsfreigabe:true})).statusCode,403);
      assert.equal((await request('PATCH','/api/projects/'+A+'/compute-policy',{pc_gpu_ausgeschlossen:true})).statusCode,403);
      assert.equal((await request('PATCH','/api/embedding-nodes/'+NODE+'/policy',{ausfuehrungsfreigabe:true},'daemon')).statusCode,200);
      const conflict=await request('PATCH','/api/embedding-nodes/'+NODE+'/policy',{ausfuehrungsfreigabe:false,policyRevision:0},'daemon');
      assert.equal(conflict.statusCode,409,'Veraltete Userpolicy wird nicht geschrieben');
      const self=await request('GET','/api/embedding-nodes/'+NODE+'/policy');
      assert.equal(self.statusCode,200);assert.ok(self.json().recommendations.embedding.grund);
      assert.ok(self.json().recommendations.embedding.zeit);
      assert.equal((await request('GET','/api/embedding-nodes/fremd/policy')).statusCode,403);
      assert.equal((await request('PATCH','/api/embedding-nodes/'+NODE+'/policy',{lan_bevorzugen:true},'daemon')).statusCode,400);
      assert.equal((await request('PATCH','/api/projects/'+A+'/compute-policy',{pc_gpu_ausgeschlossen:true},'session')).statusCode,200);
      assert.equal((await request('GET','/api/projects/'+A+'/compute-policy',null,'session')).json().policy.pc_gpu_ausgeschlossen,true);
      if(mode==='verify') await runComputePolicyEdges(db,policy,NODE,A,request);
      console.log(mode==='policy'?'R1.2 Teilmodus grün: Legacybytegolden, Vorregistry, API-Autorisierung/CAS/Empfehlung; Claim-Gates nicht geprüft':'R1.2/T9 Vollprüfung grün: Legacybytegolden, Vorregistry, Consent/Usersperren/Manuell, Projektoptout3Zweige+Unraid+Workjobs, regulärer Abschluss, API-Autorisierung/CAS/Revision/Empfehlung');
    }
  }
} finally {
  await app?.close();
  for(const name of ['compute_node_policy','compute_project_policy',...tables].reverse()) await db.query('DROP TABLE IF EXISTS p20_r12.'+name);
  await core.closePool();
}

}
