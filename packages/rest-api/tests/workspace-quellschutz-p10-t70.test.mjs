/** P10-T70: echter lokaler Wegwerfcontainer, kein Hostmount/Netz/Live-DB. Kein Skip bei Dockerfehler. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import Docker from 'dockerode';
import {schuetzeWorkspaceWurzel} from '../dist/services/workspace-quellschutz.js';
import {WorkspaceOrchestrator} from '../dist/services/workspace-orchestrator.js';
import {mitLesePool} from '../../core/dist/db/client.js';
const docker=new Docker({socketPath:'/var/run/docker.sock'});
test('Echte Docker-Ownership sperrt Source-rename/rm auch bei anfangs synapse-eigenem Workspace',async()=>{
 const image=process.env.P10_T70_DOCKER_IMAGE??'busybox:latest';
 await docker.getImage(image).inspect(); // Keine Images nachladen, vorhandenen lokalen Bestand verwenden.
 const c=await docker.createContainer({Image:image,Cmd:['sleep','120'],User:'1000:1000',Labels:{'synapse-test':'p10-t70','synapse-test-owner':'sol-2'},
  HostConfig:{NetworkMode:'none',ReadonlyRootfs:false,Memory:32*1024*1024,PidsLimit:32,CapDrop:['ALL'],CapAdd:['CHOWN','FOWNER','DAC_OVERRIDE'],
   Tmpfs:{'/workspace':'rw,nosuid,size=1048576,uid=1000,gid=1000,mode=0755'}}});
 const run=async(command,user='1000:1000')=>{
  const exec=await c.exec({Cmd:['/bin/sh','-c',command],User:user,AttachStdout:true,AttachStderr:true,Tty:false});
  const stream=await exec.start({hijack:true,stdin:false});const chunks=[];
  for await(const chunk of stream)chunks.push(Buffer.from(chunk));
  const result=await exec.inspect();
  return {exit:result.ExitCode,output:Buffer.concat(chunks).toString('utf8')};
 };
 try{
  await c.start();
  assert.equal((await run("printf source > /workspace/control.txt; chown 0:0 /workspace/control.txt; chmod 0444 /workspace/control.txt",'0')).exit,0);
  const ownerBefore=await run("stat -c '%u:%g:%a' /workspace");
  assert.equal(ownerBefore.exit,0);assert.ok(ownerBefore.output.includes('1000:1000:755'));
  // Positivkontrolle: 0444 allein schützt nicht vor Umbenennen über ein eigenes Elternverzeichnis.
  assert.equal((await run('mv /workspace/control.txt /workspace/moved.txt && mv /workspace/moved.txt /workspace/control.txt')).exit,0);
  await schuetzeWorkspaceWurzel(c);
  const ownerAfter=await run("stat -c '%u:%g:%a' /workspace");
  assert.equal(ownerAfter.exit,0);assert.ok(ownerAfter.output.includes('0:0:755'),'Rootschutz muss reale Docker-Ownership ändern: '+JSON.stringify(ownerAfter));
  for(const command of [
   'printf changed > /workspace/control.txt',
   'chmod 0600 /workspace/control.txt',
   'mv /workspace/control.txt /workspace/moved.txt',
   'rm /workspace/control.txt',
  ])assert.notEqual((await run(command)).exit,0,command+' muss tatsächlich vom OS abgewiesen werden');
  assert.ok((await run('cat /workspace/control.txt')).output.includes('source'));
  // Artefaktfreigabe eines eigenen Unterordners ändert die Root-Ownership nicht.
  assert.equal((await run('mkdir /workspace/dist; chown 1000:1000 /workspace/dist','0')).exit,0);
  assert.equal((await run('printf build > /workspace/dist/output')).exit,0);
  await schuetzeWorkspaceWurzel(c);
  assert.ok((await run("stat -c '%u:%g:%a' /workspace")).output.includes('0:0:755'));
  const orchestrator=new WorkspaceOrchestrator();orchestrator.docker=docker;orchestrator.dockerAvailable=true;
  orchestrator.anyActiveContainerId=async()=>c.id;orchestrator.recordActivity=async()=>{};orchestrator.appendToLog=async()=>{};
  const pgFixture={query:async sql=>{assert.match(sql,/SELECT file_path, content FROM code_files/);return{rows:[{file_path:'control.txt',content:'source'},{file_path:'package.json',content:'{\"name\":\"p10-t70-fixture\"}'}]};}};
  const materialized=await mitLesePool(pgFixture,()=>orchestrator.materialize('p10_t70_docker'));
  assert.equal(materialized.files,2);await schuetzeWorkspaceWurzel(c);
  assert.ok((await run("stat -c '%u:%g:%a' /workspace")).output.includes('0:0:755'));
  assert.equal((await run('mv /workspace/control.txt /workspace/moved.txt')).exit,1,'Rename nach echtem Re-Materialize bleibt gesperrt');
  assert.equal((await run('rm /workspace/control.txt')).exit,1,'Unlink nach echtem Re-Materialize bleibt gesperrt');
  assert.equal((await run('printf module > /workspace/node_modules/output; printf build > /workspace/dist/output')).exit,0,'nur Artefaktverzeichnisse bleiben schreibbar');
  console.log('T70_REAL_DOCKER_ROOT_OWNERSHIP_AND_SOURCE_GUARD_OK');
 }finally{await c.remove({force:true,v:true});}
});
