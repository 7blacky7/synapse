/** t76-A: historischer Build nur statisch; niemals ausführen. */
import assert from'node:assert/strict';import{ermittleShellLage}from'../dist/services/shell-lage.js';import{pruefeShellStart}from'../dist/services/shell-start-sicherung.js';import{SHELL_SICHERUNG_SEED}from'../dist/services/shell-sicherung-seed.js';
await import('./shell-t76-c.test.mjs');
const probe=async input=>({cwd:input.cwd,os:'linux',env:{},pfade:(input.pfade??[]).map(pfad=>({pfad,kanonisch:pfad,existiert:false,links:[],eigener_benutzer:true,naechster_elternpfad:'/tmp'}))});
const ctx={shell:'sh',os:'linux',cwd:'/virtual/t76',project_root:'/virtual/t76',env:{},env_vollstaendig:true,probe};
const check=async(command,opts={})=>pruefeShellStart({project:'owned-t76-a',command,lage:await ermittleShellLage(command,{...ctx,...opts}),agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
const historical="for p in @synapse/rest-api @synapse/mcp-server @synapse/compute-node-agent; do nice -n 19 ionice -c3 pnpm --filter $p build > /tmp/p15p-$(echo $p|tr / _).log 2>&1; echo \"$p EXIT=$? TS=$(grep -c 'error TS' /tmp/p15p-$(echo $p|tr / _).log)\"; grep 'error TS' /tmp/p15p-$(echo $p|tr / _).log | head -10; done";
assert.equal((await check(historical)).darf_starten,true,'6b73691e literalgebundene Build-Logs');
for(const command of [
 'for p in @synapse/core @synapse/rest-api; do pnpm --filter $p build > /tmp/owned-$(echo $p|tr / _).log; done',
 'for p in @synapse/core; do pnpm --filter $p build > /tmp/owned-$(basename "$p").log; done'
])assert.equal((await check(command)).darf_starten,true,command);
for(const command of [
 "for p in @synapse/core; do pnpm --filter $p build > '/tmp/owned-$(echo $p|tr / _).log'; done",
 'for p in $PACKAGES; do pnpm --filter $p build > /tmp/owned-$(echo $p|tr / _).log; done',
 'for p in @synapse/core; do pnpm --filter $p build > $TARGET; done',
 'for p in @synapse/core; do pnpm --filter $p build > /etc/owned-$(echo $p|tr / _).log; done',
 'for p in @synapse/core; do pnpm --filter $p build > /tmp/owned-$(echo $p|tr / _).env; done',
 'for p in @synapse/core; do pnpm --filter $p build > /tmp/owned-$(echo $p|tr / _).log; rm -rf owned; done',
 'for p in @synapse/core; do pnpm --filter $p build > /tmp/owned-$(echo $p|tr / _).log; git reset --hard; done',
 'for p in @synapse/core; do pnpm --filter $p build > /tmp/owned-$(echo $p|tr / _).log; git checkout -- owned; done',
 'for p in @synapse/core; do pnpm --filter $p build > /tmp/owned-$(echo $p|tr / _).log; git worktree remove --force owned; done',
 'for p in @synapse/core; do pnpm --filter $p build > /tmp/owned-$(echo $p|tr / _).log; node -e "db.query(\'DELETE FROM owned\')"; done'
])assert.equal((await check(command)).darf_starten,false,command);
assert.equal((await check(historical,{inspect:false})).darf_starten,false,'keine Native-Lage, kein neuer Log-Nachweis');
assert.equal((await check(historical,{probe:async input=>({...await probe(input),pfade:(input.pfade??[]).map((pfad,i)=>({pfad,kanonisch:i===0?'/etc/different':pfad,existiert:true,links:[],eigener_benutzer:true}))})})).darf_starten,false,'Symlink außerhalb Log-Scope');
assert.equal((await check(historical,{probe:async input=>({...await probe(input),pfade:(input.pfade??[]).map(pfad=>({pfad,kanonisch:pfad,existiert:true,links:[],eigener_benutzer:false}))})})).darf_starten,false,'fremder bestehender Log');
if(process.argv.includes('--native-a')){
 const u=new URL(process.env.DATABASE_URL);assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
 const{mkdtemp,writeFile,readFile,symlink}=await import('node:fs/promises');const{homedir}=await import('node:os');const{join}=await import('node:path');const{randomUUID}=await import('node:crypto');
 const{getPool,closePool}=await import('../dist/db/client.js');const{execShellInProject}=await import('../dist/services/shell-exec.js');
 const root=await mkdtemp(join(homedir(),'dev','synapse-t76-a-')),project='test-t76-a-'+randomUUID(),log=join(root,'build-@synapse_owned-a.log');
 await writeFile(join(root,'package.json'),JSON.stringify({name:'@synapse/owned-a',version:'0.0.0',scripts:{build:'node -e "console.log(12345)"'}}));
 await getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
 const command='for p in @synapse/owned-a; do pnpm --filter $p build > ./build-$(echo $p|tr / _).log; done';
 const native=await ermittleShellLage(command,{...ctx,cwd:root,project_root:root,probe:undefined});
 assert.match(native.build_log.hash,/^[a-f0-9]{64}$/);assert.equal(native.build_log.belege[0].scope,'projekt');
 let started=false;const r=await execShellInProject({project,command,agent_id:'sol-2',onStarted:()=>started=true});
 assert.equal(started,true,JSON.stringify(r));assert.equal(r.exit_code,0,JSON.stringify(r));assert.match(await readFile(log,'utf8'),/12345/);
 const link=join(root,'linked-@synapse_owned-a.log');await symlink('/etc/passwd',link);
 const evil='for p in @synapse/owned-a; do pnpm --filter $p build > ./linked-$(echo $p|tr / _).log; done';
 const unsafe=await ermittleShellLage(evil,{...ctx,cwd:root,project_root:root,probe:undefined});assert.equal(pruefeShellStart({project,command:evil,lage:unsafe,agent_id:'sol-2'},SHELL_SICHERUNG_SEED).darf_starten,false,'echter Symlink nie ausgeführt');
 const real=await ermittleShellLage(historical,{...ctx,cwd:'/home/blacky/dev/synapse',project_root:'/home/blacky/dev/synapse',probe:undefined});
 assert.equal(pruefeShellStart({project:'synapse',command:historical,lage:real,agent_id:'sol-2'},SHELL_SICHERUNG_SEED).darf_starten,true,'historischer Text nur native Leseprobe');assert.equal(real.build_log.belege.length,3);
 await closePool();console.log('t76-A nativer eigener pnpm-Build/Loghash/Scope + echter Symlink abgewiesen; historische Build-Texte nie ausgeführt.');
}

console.log('t76-A historische Logschleife, native Scopegrenzen und echte Mutationen grün.');
