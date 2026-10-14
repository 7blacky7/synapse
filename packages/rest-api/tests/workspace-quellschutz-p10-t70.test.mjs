/** P10-T70: echte Test-DB, echte Docker-Execs, ReadonlyRootfs und frische eigene Volumes. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {createHash,randomUUID} from 'node:crypto';
import Docker from 'dockerode';
import tar from 'tar-stream';
import {WorkspaceOrchestrator} from '../dist/services/workspace-orchestrator.js';
import {mitLesePool} from '../../core/dist/db/client.js';
import {oeffneGeschuetzteShellTestDb} from '../../../scripts/lib/test-db-schutz.mjs';
const docker=new Docker({socketPath:'/var/run/docker.sock'});
const fixture="import{rename,unlink,writeFile}from'node:fs/promises';const a=process.argv[2];if(a==='rename')await rename('/workspace/control.txt','/workspace/renamed.txt');if(['rm','replace','error','timeout'].includes(a))await unlink('/workspace/control.txt');if(a==='replace')await writeFile('/workspace/control.txt','changed');if(a==='error')throw Error('expected test failure');if(a==='timeout'){await new Promise(r=>setTimeout(r,5000));await writeFile('/workspace/control.txt','late');}";
const file='packages/core/tests/recover.test.mjs';
test('T70: native Testdatei-Execs restaurieren aktuelle PG-Quellen, Install bleibt möglich',async t=>{
 const client=await oeffneGeschuetzteShellTestDb();const schema='p10_t70_'+process.pid;
 const q=client.query.bind(client);let created=false;
 const pool={query:q,connect:async()=>({query:q,release(){},on(){},once(){}})};
 try{
  assert.equal((await client.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  await q('CREATE SCHEMA '+schema);created=true;
  for(const {tablename}of(await q("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows){
   assert.match(tablename,/^[a-zA-Z0-9_]+$/);
   await q('CREATE TABLE '+schema+'."'+tablename+'" (LIKE public."'+tablename+'" INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)');
  }
  await q('CREATE SEQUENCE '+schema+'.fixture_seq START 1000000');
  for(const {table_name,column_name}of(await q("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND column_default LIKE 'nextval(%'")).rows)
   await q('ALTER TABLE '+schema+'."'+table_name+'" ALTER COLUMN "'+column_name+'" SET DEFAULT nextval(\''+schema+'.fixture_seq\')');
  await q('SET search_path TO '+schema+',public');
  await mitLesePool(pool,async()=>{
   for(const monorepo of [false,true])await t.test(monorepo?'Monorepo':'Fremdprojekt ohne node_modules',async t=>{
    const project=schema+(monorepo?'_mono':'_foreign');
    await q('INSERT INTO projects(name,path,hostname,enabled) VALUES($1,$2,$3,true)',[project,'/workspace','t70-fixture']);
    await docker.getImage('synapse-workspace:latest').inspect();
    const c=await docker.createContainer({Image:'synapse-workspace:latest',Cmd:['sleep','180'],User:'1000:1000',WorkingDir:'/workspace',
     Env:['HOME=/home/synapse','CI=true'],Labels:{'synapse-test':'p10-t70-recovery','synapse-test-owner':'sol-2'},
     HostConfig:{NetworkMode:'none',ReadonlyRootfs:true,Memory:512*1024*1024,PidsLimit:64,
      Mounts:[{Type:'volume',Target:'/workspace',VolumeOptions:{NoCopy:true}}],
      Tmpfs:{'/tmp':'rw,exec,size=67108864,uid=1000,gid=1000','/home/synapse':'rw,size=67108864,uid=1000,gid=1000'}}});
    const run=async(command,user='1000:1000')=>{
     const ex=await c.exec({Cmd:['/bin/sh','-ec',command],User:user,AttachStdout:true,AttachStderr:true});
     const stream=await ex.start({hijack:true,stdin:false}),out=new PassThrough(),err=new PassThrough();const chunks=[];
     out.on('data',b=>chunks.push(Buffer.from(b)));err.on('data',b=>chunks.push(Buffer.from(b)));
     docker.modem.demuxStream(stream,out,err);
     await new Promise((resolve,reject)=>{stream.once('end',resolve);stream.once('error',reject);});
     return{exit:(await ex.inspect()).ExitCode,output:Buffer.concat(chunks).toString('utf8')};
    };
    try{
     await c.start();assert.equal((await c.inspect()).HostConfig.ReadonlyRootfs,true);
     assert.equal((await c.inspect()).Mounts.find(m=>m.Destination==='/workspace').Type,'volume');
     assert.equal((await run('chown 1000:1000 /workspace','0')).exit,0);
     const rootPackage={name:project,private:true,version:'1.0.0',scripts:{build:'node scripts/build.cjs'},...(monorepo?{dependencies:{'t70-fixture-dep':'workspace:*'}}:{})};
     const rows=[{file_path:'package.json',content:JSON.stringify(rootPackage)},{file_path:'control.txt',content:'source'},{file_path:file,content:fixture},{file_path:'scripts/build.cjs',content:"require('node:fs').writeFileSync('dist/result','built');"}];
     if(monorepo)rows.push({file_path:'pnpm-workspace.yaml',content:"packages:\n  - 'packages/*'\n"},
      {file_path:'packages/dep/package.json',content:JSON.stringify({name:'t70-fixture-dep',version:'1.0.0'})},
      {file_path:'packages/dep/index.js',content:'module.exports = 42;'});
     const pack=tar.pack(),put=c.putArchive(pack,{path:'/workspace'});
     for(const row of rows)await new Promise((resolve,reject)=>pack.entry({name:row.file_path,mode:0o644,uid:1000,gid:1000},row.content,e=>e?reject(e):resolve()));
     pack.finalize();await put;
     const lock=await run('pnpm install --lockfile-only --offline --ignore-scripts');assert.equal(lock.exit,0,lock.output);
     const archive=await c.getArchive({path:'/workspace/pnpm-lock.yaml'}),extract=tar.extract();let lockText='';
     const readLock=new Promise((resolve,reject)=>{extract.on('entry',(h,s,next)=>{s.on('data',b=>{lockText+=b.toString();});s.on('end',next);});extract.on('finish',resolve);extract.on('error',reject);});
     archive.pipe(extract);await readLock;rows.push({file_path:'pnpm-lock.yaml',content:lockText});
     for(const row of rows)await q('INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(),project,row.file_path,row.file_path.split('/').at(-1),'mjs',row.content,createHash('sha256').update(row.content).digest('hex')]);
     // Ignorierte Nutzerdaten gehören weder in den Vergleich noch in die Reparaturliste.
     await q('INSERT INTO code_files(id,project,file_path,file_name,file_type,content) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(),project,'node_modules/owned.txt','owned.txt','txt','PG ignored data']);
     const w=new WorkspaceOrchestrator();w.docker=Object.create(docker);w.docker.getContainer=()=>c;w.dockerAvailable=true;
     w.ensureProjectRunning=async()=>c.id;w.anyActiveContainerId=async()=>c.id;w.recordActivity=async()=>{};w.appendToLog=async()=>{};
     await w.materialize(project);
     assert.equal((await run('rm -rf /workspace/node_modules /workspace/packages/dep/node_modules','0')).exit,0);
     const exec=(mode,opts={})=>w.exec(project,'node '+file+' '+mode,{agent_id:'sol-2',...opts});
     const source=async()=>assert.equal((await run('cat /workspace/control.txt')).output,'source');
     await t.test('Frischer frozen install mit installierbarer t86-Wurzel',async()=>{
      assert.equal((await run('test ! -e /workspace/node_modules')).exit,0);
      const r=await w.exec(project,'pnpm install --frozen-lockfile --offline --ignore-scripts',{agent_id:'sol-2'});
      assert.equal(r.exitCode,0,r.stderr);assert.equal(r.quellen_wiederhergestellt,undefined);
      assert.equal((await run("stat -c '%u:%g:%a' /workspace")).output.trim(),'1000:1000:755');
      if(monorepo)assert.equal((await run('test -L node_modules/t70-fixture-dep')).exit,0);
      const build=await w.exec(project,'pnpm run build',{agent_id:'sol-2'});assert.equal(build.exitCode,0,build.stderr);
     });
     await t.test('Unverändert: keine falsche Liste; write/chmod bleiben vom OS abgewiesen',async()=>{
      for(const cmd of ['printf changed > /workspace/control.txt','chmod 0600 /workspace/control.txt'])assert.notEqual((await run(cmd)).exit,0);
      const r=await exec('noop');assert.equal(r.exitCode,0,r.stderr);assert.equal(r.quellen_wiederhergestellt,undefined);await source();
     });
     for(const mode of ['rename','rm','replace','error','timeout'])await t.test(mode+' wird nach echtem nativem Exec repariert und gemeldet',async()=>{
      const r=await exec(mode,{timeoutMs:mode==='timeout'?250:10000});
      assert.equal(r.exitCode,mode==='error'?1:mode==='timeout'?124:0,r.stderr);
      assert.equal(r.timedOut,mode==='timeout');assert.deepEqual(r.quellen_wiederhergestellt,['control.txt']);
      await source();assert.equal((await run("stat -c '%u:%g:%a' /workspace/control.txt")).output.trim(),'0:0:444');
      assert.equal((await run('cat /workspace/dist/result')).output,'built','Buildartefakt bleibt unverändert');
      const persisted=(await q('SELECT sicherung FROM shell_jobs WHERE id=$1',[r.id])).rows[0].sicherung;
      assert.deepEqual(persisted.quellen_wiederhergestellt,['control.txt']);
     });
     await t.test('Neuere PG-Revision und Re-Materialize bleiben maßgeblich',async()=>{
      await q('UPDATE code_files SET content=$1,content_hash=$2 WHERE project=$3 AND file_path=$4',['new PG revision',createHash('sha256').update('new PG revision').digest('hex'),project,'control.txt']);
      const r=await exec('rm');assert.equal(r.exitCode,0,r.stderr);assert.deepEqual(r.quellen_wiederhergestellt,['control.txt']);
      assert.equal((await run('cat /workspace/control.txt')).output,'new PG revision');
      await w.materialize(project);const installed=await w.exec(project,'pnpm install --frozen-lockfile --offline --ignore-scripts',{agent_id:'sol-2'});
      assert.equal(installed.exitCode,0,installed.stderr);
     });
     await t.test('Recovery wartet auf konkurrierende PG-Revision und restauriert den neuesten Stand',async()=>{
      const writer=await oeffneGeschuetzteShellTestDb();let committed=false;
      try{
       await writer.query('SET search_path TO '+schema+',public');await writer.query('BEGIN');
       await writer.query('UPDATE code_files SET content=$1,content_hash=$2 WHERE project=$3 AND file_path=$4',['concurrent PG revision',createHash('sha256').update('concurrent PG revision').digest('hex'),project,'control.txt']);
       const pending=exec('rm');const observed=pending.catch(error=>{throw error;});
       await new Promise(resolve=>setTimeout(resolve,500));await writer.query('COMMIT');committed=true;
       const r=await observed;assert.equal(r.exitCode,0,r.stderr);assert.deepEqual(r.quellen_wiederhergestellt,['control.txt']);
       assert.equal((await run('cat /workspace/control.txt')).output,'concurrent PG revision');
      }finally{if(!committed)await writer.query('ROLLBACK');await writer.end();}
     });
     await t.test('Restorefehler behauptet keinen Erfolg',async()=>{
      const saved=c.putArchive;c.putArchive=async()=>{throw Error('t70_restore_failed');};
      try{await assert.rejects(()=>exec('rm'),/t70_restore_failed/);}finally{c.putArchive=saved;}
      assert.deepEqual(await w.stelleWorkspaceQuellenWiederHer(project,c),['control.txt']);
     });
     console.log('T70_ERKENNEN_WIEDERHERSTELLEN_UND_FROZEN_INSTALL_OK '+(monorepo?'monorepo':'foreign'));
    }finally{await c.remove({force:true,v:true});}
   });
  });
 }finally{if(created)await q('DROP SCHEMA '+schema+' CASCADE');await client.end();}
});
