#!/usr/bin/env node
// P20-T14/R2.1: echte PG-Prozesse in eigenem Schema p20_r21_<PID>, nur synapse_test.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
const base = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '');
assert.equal(base.pathname, '/synapse_test');
assert.equal(base.port, '5433');
const mode = process.argv[2] || 'test';
const schema = process.env.P20_R21_SCHEMA || 'p20_r21_' + process.pid;
assert.match(schema, /^p20_r21_[0-9]+$/);
base.searchParams.set('options', '-c search_path=' + schema + ',public');
process.env.DATABASE_URL = base.href;
const req = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { Pool } = req('pg');
const pool = new Pool({ connectionString: base.href, application_name: 'p20_r21_' + process.pid });
const boot = '11111111-1111-4111-8111-111111111111';
const identity = nodeId => ({ nodeId, bootGeneration: boot, authHash: nodeId + '-hash' });
const input = { scope: 'reverse', id: 'synthetic-input', revision: '1', sha256: 'a'.repeat(64) };
const output = { scope: 'reverse', id: 'synthetic-output', revision: '1', sha256: 'b'.repeat(64) };
const resourceNeed = { cpu: 1, ram: 128, vram: 0, gpu: false };
async function dependencies() {
  return {
    pool,
    resourceDomain: () => 'synthetic-host',
    outputIsStaged: async (_job, ref, client) => {
      const r = await client.query('SELECT revision,sha256 FROM test_outputs WHERE id=$1 FOR SHARE',[ref.id]);
      return r.rows[0]?.revision === ref.revision && r.rows[0]?.sha256 === ref.sha256;
    },
    authorizeJob: async (node, job) => job.capability === 'reverse.inspect' ? {
      resourceDomain: 'synthetic-host', maxConcurrent: 4,
      budget: { cpu: 4, ram: 4096, vram: 0, gpu: false },
    } : null,
    inputStillCurrent: async (job, client) => {
      const r = await client.query('SELECT revision,sha256 FROM test_inputs WHERE id=$1 FOR SHARE',
        [job.inputRef.id]);
      return r.rows[0]?.revision === job.inputRef.revision && r.rows[0]?.sha256 === job.inputRef.sha256;
    },
    config: { leaseSeconds: 2, maxLeaseSeconds: 30, agingSeconds: 1,
      interactiveReserve: 0, scanLimit: 100, maxClaimsPerCall: 16 },
  };
}
async function service() {
  const { createWorkJobService } = await import('../packages/core/dist/services/work-jobs.js');
  return createWorkJobService(await dependencies());
}
if (mode === 'child') {
  const jobs = await service();
  process.send({ type: 'ready' });
  process.on('message', async message => {
    try {
      const result = message.action === 'claim'
        ? await jobs.claim(identity(message.node), { limit: 1 })
        : await jobs.complete(identity(message.node), message.id, message.claimToken, input);
      process.send({ result });
    } catch (error) { process.send({ error: error.message }); }
  });
  process.on('disconnect', async () => { await pool.end(); });
} else {
  const core = await import('../packages/core/dist/index.js');
  const legacy = await import('../packages/core/dist/services/embedding-claims.js');
  async function golden() {
    for (const table of ['projects', 'code_files', 'code_chunks', 'embed_prioritaet', 'intern_schalter'])
      await pool.query('CREATE TABLE ' + schema + '.' + table + ' (LIKE public.' + table + ' INCLUDING ALL)');
    await pool.query("INSERT INTO projects(name,hostname,path,enabled) VALUES('p20_r21','synthetic-host','/synthetic',true)");
    await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type) VALUES('r21-file','p20_r21','src/a.ts','a.ts','typescript')");
    await pool.query("INSERT INTO code_chunks(id,project,file_path,chunk_index,content,line_start,line_end) VALUES('r21-chunk','p20_r21','src/a.ts',0,'synthetic content',1,2)");
    const claims = await legacy.claimEmbeddingChunks('r21-node', { limit: 1, maxConcurrent: 1 }, pool);
    assert.equal(claims.length, 1);
    const written = [];
    const completion = await legacy.completeEmbeddingClaim({
      nodeId: 'r21-node', chunkId: claims[0].chunkId, claimToken: claims[0].claimToken,
      contentHash: claims[0].contentHash, vector: [1,0,0,0], expectedDimension: 4,
    }, { pool, ensureCollection: async () => 'project_p20_r21_code',
      writeVector: async (...args) => { written.push(args); } });
    const bad = await legacy.completeEmbeddingClaim({
      nodeId: 'wrong-node', chunkId: claims[0].chunkId, claimToken: claims[0].claimToken,
      contentHash: claims[0].contentHash, vector: [1,0,0,0], expectedDimension: 4,
    }, { pool, ensureCollection: async () => 'project_p20_r21_code',
      writeVector: async (...args) => { written.push(args); } }).then(result => result, error => ({ error: error.message }));
    return { claims: claims.map(c => ({ ...c, claimToken: '<token>', leaseUntil: '<time>' })),
      completion, bad, written: written.map(([collection,vector,payload,pointId]) => ({
        collection, vector, payload: { ...payload, updated_at: '<time>' }, pointId })) };
  }
  const children = [];
  let schemaCreated = false;
  try {
    await pool.query('CREATE SCHEMA ' + schema);
    schemaCreated = true;
    const baseline = await golden();
    if (mode === 'golden-capture') console.log(JSON.stringify({ golden: baseline }));
    else {
      const expected = JSON.parse(await readFile(new URL('./fixtures/p20-r21-embedding-claims.golden.json', import.meta.url)));
      assert.deepEqual(baseline, expected);
      console.log('GOLDEN embedding-claims unverändert');
      const module = await import('../packages/core/dist/services/work-jobs.js');
      const ddl = await import('../packages/core/dist/db/work-jobs-schema.js');
      assert.equal(typeof module.createWorkJobService, 'function');
      await pool.query(ddl.WORK_JOBS_SCHEMA_SQL);
      await pool.query(ddl.WORK_JOBS_SCHEMA_SQL); // idempotent
      assert.equal((await core.getPool().query('SELECT current_database() AS db,current_schema() AS own')).rows[0].db,'synapse_test');
      assert.equal((await core.getPool().query('SELECT current_schema() AS own')).rows[0].own,schema);
      const probe=await core.ensureSchema({nurProbe:true,sperrSchema:schema,koerper:ddl.WORK_JOBS_SCHEMA_SQL,
        versuche:1,lockTimeoutMs:1000,statementTimeoutMs:10000});
      assert.equal(probe.probe,true,'Echter ensureSchema-DDL-Probelauf endet mit Rollback');

      await pool.query('CREATE TABLE embedding_knoten(node_id text PRIMARY KEY,boot_id text NOT NULL,service_token_hash text NOT NULL,status text NOT NULL DEFAULT \'ready\',gesperrt_vom_user boolean NOT NULL DEFAULT false,letzter_kontakt timestamptz NOT NULL DEFAULT NOW())');
      await pool.query('CREATE TABLE test_inputs(id text PRIMARY KEY,revision text NOT NULL,sha256 text NOT NULL)');
      await pool.query('CREATE TABLE test_outputs(id text PRIMARY KEY,revision text NOT NULL,sha256 text NOT NULL)');
      await pool.query('INSERT INTO test_outputs VALUES($1,$2,$3)', [output.id,output.revision,output.sha256]);
      await pool.query('INSERT INTO test_inputs VALUES($1,$2,$3)', [input.id,input.revision,input.sha256]);
      for (const node of ['node-a','node-b']) await pool.query(
        'INSERT INTO embedding_knoten(node_id,boot_id,service_token_hash) VALUES($1,$2,$3)', [node,boot,node+'-hash']);
      const jobs = await service();
      const enqueue = key => jobs.enqueue({ kind: 'reverse-inspect', capability: 'reverse.inspect',
        profileId: null, project: 'p20_r21', scope: 'reverse', inputRef: input,
        resourceNeed, priority: 'hintergrund', idempotencyKey: key });
      const first = await enqueue('r21-first');
      assert.equal((await enqueue('r21-first')).id, first.id);
      await assert.rejects(jobs.enqueue({ kind: 'asset-inspect', capability: 'reverse.inspect',
        profileId: null, project: 'p20_r21', scope: 'reverse', inputRef: input,
        resourceNeed, priority: 'hintergrund', idempotencyKey: 'r21-first' }),
        /idempotency_conflict/);
      await assert.rejects(enqueue(''), /invalid/);
      const denied = module.createWorkJobService({ pool });
      assert.deepEqual(await denied.claim(identity('node-a'), { limit: 1 }), []);
      await pool.query("UPDATE embedding_knoten SET letzter_kontakt=NOW()-INTERVAL '3 minutes' WHERE node_id='node-a'");
      assert.deepEqual(await jobs.claim(identity('node-a'),{limit:1}),[],
        'Registry-Freshness muss das reale Feld letzter_kontakt auswerten');
      await pool.query("UPDATE embedding_knoten SET letzter_kontakt=NOW() WHERE node_id='node-a'");
      // Zwei echte getrennte PG-Prozesse: nur einer bekommt den einzigen Auftrag.
      async function child() {
        const proc = fork(fileURLToPath(import.meta.url), ['child'], {
          env: { ...process.env, P20_R21_SCHEMA: schema, TEST_DATABASE_URL: base.href },
          stdio: ['ignore','ignore','inherit','ipc'] });
        children.push(proc);
        await new Promise(resolve => proc.once('message', resolve));
        return proc;
      }
      const [a,b] = await Promise.all([child(),child()]);
      const call = (proc, message) => new Promise((resolve,reject) => {
        proc.once('message', response => response.error ? reject(Error(response.error)) : resolve(response.result));
        proc.send(message);
      });
      const [ca,cb] = await Promise.all([call(a,{action:'claim',node:'node-a'}),
        call(b,{action:'claim',node:'node-b'})]);
      assert.equal(ca.length + cb.length, 1);
      const owner = ca.length ? 'node-a' : 'node-b';
      const lease = (ca[0] || cb[0]);
      assert.equal(lease.id, first.id);
      assert.equal(await jobs.renew(identity(owner), lease.id, lease.claimToken, 5), true);
      assert.equal(await jobs.stage(identity(owner), lease.id, lease.claimToken, output), true);
      const completions = await Promise.all([call(a,{action:'complete',node:owner,id:lease.id,claimToken:lease.claimToken}),
        call(b,{action:'complete',node:owner,id:lease.id,claimToken:lease.claimToken})]);
      assert.equal(completions.filter(x=>x.completed).length, 1);
      console.log('PG-Prozesskonkurrenz: ein Claim, ein gültiger Abschluss');
      // Reclaim und alter Besitzer/Boot.
      await enqueue('r21-reclaim');
      const [old] = await jobs.claim(identity('node-a'),{limit:1});
      await pool.query("UPDATE work_jobs SET lease_until=NOW()-INTERVAL '1 second' WHERE id=$1",[old.id]);
      assert.equal(await jobs.renew(identity('node-a'),old.id,old.claimToken,5),false);
      await jobs.reclaim();
      const [fresh] = await jobs.claim(identity('node-b'),{limit:1});
      assert.equal(fresh.id,old.id); assert.ok(fresh.attempt>old.attempt);
      assert.equal(fresh.resourceUnconfirmed,true,'Leaseablauf ist kein physisches Ende');
      assert.equal((await jobs.complete(identity('node-a'),old.id,old.claimToken,input)).completed,false);
      await pool.query('UPDATE embedding_knoten SET boot_id=$2 WHERE node_id=$1',
        ['node-b','22222222-2222-4222-8222-222222222222']);
      assert.equal(await jobs.renew(identity('node-b'),fresh.id,fresh.claimToken,5),false);
      assert.equal((await jobs.complete(identity('node-b'),fresh.id,fresh.claimToken,input)).completed,false);
      await pool.query('UPDATE embedding_knoten SET boot_id=$2 WHERE node_id=$1',['node-b',boot]);
      assert.equal(await jobs.release(identity('node-b'),fresh.id,fresh.claimToken),true);
      // Änderung der tatsächlichen Input-Authority verwirft Ausgabe.
      const [changed] = await jobs.claim(identity('node-a'),{limit:1});
      await jobs.stage(identity('node-a'),changed.id,changed.claimToken,output);
      await pool.query('UPDATE test_inputs SET revision=$2 WHERE id=$1',[input.id,'2']);
      assert.equal((await jobs.complete(identity('node-a'),changed.id,changed.claimToken,input)).completed,false);
      await pool.query('UPDATE test_inputs SET revision=$2 WHERE id=$1',[input.id,'1']);
      await jobs.release(identity('node-a'),changed.id,changed.claimToken);
      await pool.query("UPDATE work_jobs SET state='cancelled' WHERE state='pending'");
      // Priorität und Aging: alter Nachzug gewinnt nach zwei Agingfenstern.
      const oldTail = await jobs.enqueue({ kind:'reverse-inspect', capability:'reverse.inspect',profileId:null,
        project:'p20_r21',scope:'reverse',inputRef:input,resourceNeed,priority:'nachzug',idempotencyKey:'r21-tail' });
      await pool.query("UPDATE work_jobs SET created_at=NOW()-INTERVAL '3 seconds' WHERE id=$1",[oldTail.id]);
      await jobs.enqueue({ kind:'reverse-inspect', capability:'reverse.inspect',profileId:null,
        project:'p20_r21',scope:'reverse',inputRef:input,resourceNeed,priority:'interaktiv',idempotencyKey:'r21-interactive' });
      const [aged] = await jobs.claim(identity('node-a'),{limit:1});
      assert.equal(aged.id,oldTail.id);
      await jobs.release(identity('node-a'),aged.id,aged.claimToken);
      // Resource-/Policy-Deny, Reserve und keine Netzwerk-I/O unter Lock.
      const lowBudget = module.createWorkJobService({ ...(await dependencies()),
        authorizeJob: async () => ({resourceDomain:'synthetic-host',maxConcurrent:4,
          budget:{cpu:0,ram:0,vram:0,gpu:false}}) });
      assert.deepEqual(await lowBudget.claim(identity('node-a'),{limit:1}),[]);
      await pool.query("UPDATE work_jobs SET state='cancelled' WHERE state='pending'");
      await enqueue('r21-delayed-completion');
      const [late] = await jobs.claim(identity('node-a'),{limit:1,leaseSeconds:1});
      await jobs.stage(identity('node-a'),late.id,late.claimToken,output);
      const dep = await dependencies();
      const slow = module.createWorkJobService({...dep, outputIsStaged:async(job,ref,client)=>{
        await client.query('SELECT pg_sleep(1.1)');
        return dep.outputIsStaged(job,ref,client);
      }});
      assert.equal((await slow.complete(identity('node-a'),late.id,late.claimToken,input)).completed,
        false,'Während PG-Prüfung abgelaufene Lease darf keine Ausgabe publizieren');
      assert.equal((await jobs.get(late.id,'p20_r21')).outputRef,null);
      await jobs.reclaim();
      await pool.query("UPDATE work_jobs SET state='cancelled' WHERE state='pending'");
      const lockTarget=await enqueue('r21-skip-locked');
      const other=await enqueue('r21-skip-available');
      const held=await pool.connect();
      try {
        await held.query('BEGIN');
        await held.query('SELECT id FROM work_jobs WHERE id=$1 FOR UPDATE',[lockTarget.id]);
        const started=performance.now();
        const [skip]=await jobs.claim(identity('node-a'),{limit:1});
        assert.equal(skip.id,other.id);
        assert.ok(performance.now()-started<1000,'SKIP LOCKED darf nicht auf gesperrten Auftrag warten');
        await jobs.release(identity('node-a'),skip.id,skip.claimToken);
      } finally {await held.query('ROLLBACK');held.release();}
      await pool.query("UPDATE work_jobs SET state='cancelled' WHERE state='pending'");
      for(let i=0;i<3;i++)await enqueue('r21-reserve-'+i);
      const reserved=module.createWorkJobService({...await dependencies(),config:{
        ...(await dependencies()).config,interactiveReserve:2},authorizeJob:async()=>({
          resourceDomain:'synthetic-host',maxConcurrent:2,budget:{cpu:4,ram:4096,vram:0,gpu:false}})});
      assert.deepEqual(await reserved.claim(identity('node-a'),{limit:3}),[],
        'Harte interaktive Reserve darf nicht still auf maxConcurrent-1 abgesenkt werden');
      const one=module.createWorkJobService({...await dependencies(),authorizeJob:async()=>({
        resourceDomain:'synthetic-host',maxConcurrent:1,budget:{cpu:4,ram:4096,vram:0,gpu:false}})});
      const [single]=await one.claim(identity('node-a'),{limit:3});
      assert.ok(single);
      assert.deepEqual(await one.claim(identity('node-b'),{limit:1}),[]);
      assert.equal(await jobs.renew({...identity('node-a'),authHash:'wrong'},single.id,single.claimToken),false);
      assert.equal(await jobs.renew(identity('node-a'),single.id,'99999999-9999-4999-8999-999999999999'),false);
      await jobs.stage(identity('node-a'),single.id,single.claimToken,output);
      await pool.query('UPDATE test_outputs SET revision=$2 WHERE id=$1',[output.id,'2']);
      assert.equal((await jobs.complete(identity('node-a'),single.id,single.claimToken,input)).completed,false);
      await pool.query('UPDATE test_outputs SET revision=$2 WHERE id=$1',[output.id,'1']);
      await jobs.release(identity('node-a'),single.id,single.claimToken);
      await pool.query("UPDATE work_jobs SET state='cancelled' WHERE state='pending'");
      await jobs.enqueue({kind:'reverse-inspect',capability:'reverse.inspect',project:'p20_r21',scope:'reverse',
        inputRef:input,resourceNeed,idempotencyKey:'r21-deadline',deadline:new Date(Date.now()+5000).toISOString()});
      const [deadlineJob]=await jobs.claim(identity('node-a'),{limit:1,leaseSeconds:30});
      assert.ok(Date.parse(deadlineJob.leaseUntil)<=Date.parse(deadlineJob.deadline));
      await pool.query("UPDATE work_jobs SET deadline=NOW()-INTERVAL '1 second' WHERE id=$1",[deadlineJob.id]);
      assert.equal(await jobs.stage(identity('node-a'),deadlineJob.id,deadlineJob.claimToken,output),false);
      await jobs.reclaim();
      assert.equal((await jobs.get(deadlineJob.id,'p20_r21')).state,'expired');
      const countBefore = (await pool.query('SELECT COUNT(*)::int AS n FROM work_jobs')).rows[0].n;
      await jobs.auditEmbedding([{chunkId:'r21-shadow',project:'p20_r21',claimAttempt:1}],'node-a');
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM work_jobs')).rows[0].n,countBefore);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM work_job_audit WHERE event='embedding_shadow'")).rows[0].n,1);
      const sessions = await pool.query("SELECT COUNT(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid() AND application_name LIKE 'p20_r21_%'");
      assert.equal(sessions.rows[0].n,0,'Eigene Transaktionen sauber beendet');
      console.log(JSON.stringify({passed:true,tests:['golden','idempotency','two_processes','reclaim',
        'boot_fence','input_fence','output_fence','auth_fence','final_lease_fence','skip_locked','reserve','max_concurrent','deadline','aging','budget','shadow_only'],otherIdleTransactions:sessions.rows[0].n}));
    }
  } finally {
    for (const child of children) if (child.connected) child.disconnect();
    await Promise.all(children.map(child=>new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve))));
    await core.closePool();
    if (schemaCreated) await pool.query('DROP SCHEMA '+schema+' CASCADE');
    await pool.end();
  }
}
