/** P10-T36 Preflight: nur printf ausführen; Gate-Reihenfolge und Maske. */
import assert from'node:assert/strict';
import{randomUUID}from'node:crypto';
import{mkdtemp}from'node:fs/promises';
import{join}from'node:path';import{homedir}from'node:os';
const u=new URL(process.env.DATABASE_URL||'http://invalid');assert.equal(u.pathname,'/synapse_test');assert.equal(u.port,'5433');
const db=await import('../dist/db/client.js');
const {execShellInProject}=await import('../dist/services/shell-exec.js');
const {ermittleShellLage}=await import('../dist/services/shell-lage.js');
const {maskiereShellDaten}=await import('../dist/services/shell-maske.js');
const root=await mkdtemp(join(homedir(),'dev','synapse-shell-e2-hook-'));
const project='test-shell-e2-hook-'+randomUUID();
await db.getPool().query('INSERT INTO projects(name,hostname,path)VALUES($1,$2,$3)',[project,'test',root]);
globalThis.fetch=async()=>new Response('{"enabled":true}',{status:200});
const events=[];
const r=await execShellInProject({project,command:'printf E2_OK',onLage:(lage)=>{
 assert.equal(lage.cwd,root);assert.ok(lage.hash);events.push('lage');
},onStarted:()=>events.push('start')});
assert.deepEqual(events,['lage','start']);assert.equal(r.exit_code,0);assert.deepEqual(r.tail,['E2_OK']);
let started=false;
await assert.rejects(()=>execShellInProject({project,command:'printf never',onLage:()=>{throw Error('test_gate');},onStarted:()=>started=true}),/test_gate/);
assert.equal(started,false);
const raw=await ermittleShellLage('rm "$TOKENFILE"',{shell:'bash',os:'linux',cwd:root,project_root:root,env:{TOKENFILE:'fake-sensitive-value'},inspect:false});
assert.ok(!JSON.stringify(maskiereShellDaten(raw,['fake-sensitive-value']).daten).includes('fake-sensitive-value'));
console.log('P10-T36 Preflight vor Spawn, Gate-Abbruch, sol-1-Maske gruen.');
await db.closePool();process.exit(0);
