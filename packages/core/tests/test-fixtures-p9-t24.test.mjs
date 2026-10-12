/** P9-T24: echte Tests müssen ihre eigenen Wurzeln und Streams beseitigen. */
import assert from'node:assert/strict';import{spawn}from'node:child_process';import{readdir,lstat}from'node:fs/promises';import{homedir}from'node:os';import{join,resolve}from'node:path';
import{createTestFixtureCleanup}from'./_helfer/test-fixture-cleanup.mjs';
const u=new URL(process.env.DATABASE_URL);assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const cases=[["shell-sicherung-e3-start.test.mjs",[],"synapse-e3-start-"],["shell-sicherung-e3-worker.test.mjs",[],"synapse-e3-worker-"],["shell-sicherung-e3-stdio.test.mjs",[],"synapse-e3-stdio-"],["shell-sicherung-e3-rest.test.mjs",[],"synapse-e3-rest-"],["shell-sicherung-e3-workspace.test.mjs",[],"synapse-shell-e2-workspace-"],["shell-sicherung-e1-golden.test.mjs",[],"synapse-shell-e1-runtime-"],["shell-lage-e2-hook.test.mjs",[],"synapse-shell-e2-hook-"],["shell-lage-e2-workspace.test.mjs",[],"synapse-shell-e2-workspace-"],["shell-t76-a.test.mjs",["--native-a"],"synapse-t76-a-"],["shell-t76-b.test.mjs",["--native-b"],"synapse-t76-b-"],["shell-t76-c.test.mjs",["--native-c"],"synapse-t76-c-"]],dev=join(homedir(),'dev'),fixtures=resolve('coedit-test'),streams=join(homedir(),'.synapse','shell-streams');
const list=async dir=>{try{return(await readdir(dir)).sort();}catch(e){if(e.code==='ENOENT')return[];throw e;}};
const rescueDev=createTestFixtureCleanup({rootDirectory:dev}),rescueFixtures=createTestFixtureCleanup({rootDirectory:fixtures});
const only=process.argv.find(x=>x.startsWith('--only='))?.slice(7),modes=process.argv.includes('--normal-only')?['normal']:['normal','failure','SIGINT','SIGTERM'];
const failures=[];
try{
for(const[file,args,prefix]of cases.filter(x=>!only||x[0]===only)){
 for(const mode of modes){
  const privateHome=await rescueFixtures.createRoot('p9-t24-home-'),privateStreams=join(privateHome,'.synapse','shell-streams');
  const before={dev:await list(dev),fixtures:await list(fixtures),streams:await list(privateStreams)};
  const env={...process.env,SYNAPSE_TEST_STREAM_HOME:privateHome};delete env.SYNAPSE_FIXTURE_FAIL;delete env.SYNAPSE_FIXTURE_WAIT_SIGNAL;
  if(mode==='failure')env.SYNAPSE_FIXTURE_FAIL='1';if(mode.startsWith('SIG'))env.SYNAPSE_FIXTURE_WAIT_SIGNAL='1';
  const child=spawn(process.execPath,['--import',resolve('packages/core/tests/_helfer/fixture-test-home.mjs'),join('packages/core/tests',file),...args],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
  let output='',signalled=false;const consume=chunk=>{output+=chunk.toString();if(mode.startsWith('SIG')&&!signalled&&output.includes('P9_T24_FIXTURE_READY')){signalled=true;child.kill(mode);}};
  child.stdout.on('data',consume);child.stderr.on('data',consume);
  const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
  const code=await new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});clearTimeout(timer);
  const after={dev:await list(dev),fixtures:await list(fixtures),streams:await list(privateStreams)};
  try{
   assert.deepEqual(after.dev,before.dev,file+' '+mode+' ~/dev');
   assert.deepEqual(after.fixtures,before.fixtures,file+' '+mode+' Fixturewurzeln');
   assert.deepEqual(after.streams,before.streams,file+' '+mode+' eigene Stream-Logs');
   if(mode==='normal')assert.equal(code,0,output.slice(-4000));
   else if(mode==='failure'){assert.notEqual(code,0);assert.match(output,/P9_T24_EXPECTED_FAILURE/);}
   else {assert.equal(signalled,true,'Signal-Gate erreicht');assert.notEqual(code,0);assert.match(output,/P9_T24_EXPECTED_SIGNAL/);}
   console.log(JSON.stringify({file,mode,status:'gruen',dev_unveraendert:true,fixtures_unveraendert:true,streams_unveraendert:true}));
  }catch(e){
   failures.push(e);console.log(JSON.stringify({file,mode,status:'rot',fehler:e.message.slice(-2000)}));
   // Nur neue, exakt benannte Wurzeln dieses Testaufrufs, niemals unbekannte Ordner.
   for(const[dir,old,fresh,cleanup]of[[dev,before.dev,after.dev,rescueDev],[fixtures,before.fixtures,after.fixtures,rescueFixtures]]){
    for(const name of fresh.filter(x=>!old.includes(x)&&x.startsWith(prefix)&&/^[A-Za-z0-9]{6}$/.test(x.slice(prefix.length)))){
     const full=join(dir,name),st=await lstat(full);assert.equal(st.isDirectory()&&!st.isSymbolicLink(),true);cleanup.trackRoot(full);
    }
   }
   if(only)break;
  }
 }
}
}finally{await rescueDev.cleanup();rescueDev.dispose();await rescueFixtures.cleanup();rescueFixtures.dispose();}
if(failures.length)throw Error('P9-T24 '+failures.length+' fehlgeschlagene Fixture-Läufe (Einzelbefunde oben).');
console.log('P9-T24 alle ausgewählten Vor/Nach-Listen identisch.');
