/** P10-T33 Nacharbeit: lange LF-freie Ausgabe, Test-DB ausschliesslich. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {createTestFixtureCleanup, trackShellStreams} from './_helfer/test-fixture-cleanup.mjs';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const {getPool,closePool}=await import('../dist/db/client.js');
const {execShellInProject}=await import('../dist/services/shell-exec.js');
const cleanup=createTestFixtureCleanup(),runShell=trackShellStreams(cleanup,execShellInProject);
const {ShellAusgabePuffer,SHELL_PUFFER_GRENZE}=await import('../dist/services/shell-ausgabe-puffer.js');
const {maskiereShellText}=await import('../dist/services/env-maske.js');
for(const [raw,werte]of [
 ['z'.repeat(300000),[]],
 ['a'.repeat(65530)+'abcdefghijk'+'b'.repeat(180000),['abcdefghijk']],
 ['TOKEN='+'private'.repeat(30000)+'\npublic\n',[]],
 ['Bearer '+'private'.repeat(30000)+' public\n',[]],
 ['{"TOKEN":"'+'private'.repeat(30000)+'","public":"ok"}',[]],
 ['postgresql://tester:'+'private'.repeat(30000)+'@host/db public\n',[]],
 ['😀'.repeat(100000),[]],
 ['L'.repeat(200000),['L'.repeat(150000)]],
]){
 let output='',max=0;
 const p=new ShellAusgabePuffer(werte,text=>{output+=text;});
 for(let i=0;i<raw.length;i+=777){p.empfange(raw.slice(i,i+777));max=Math.max(max,p.gepuffert);}
 p.ende();
 assert.equal(output,maskiereShellText(raw,werte).text,'Streaming und gemeinsame Volltext-Maske stimmen überein');
 assert(max<=SHELL_PUFFER_GRENZE+werte.reduce((m,w)=>Math.max(m,w.length),256),'Puffer durch Grenze + Literalüberhang begrenzt');
}
console.log('OK Begrenzung/Überhang, lange KV-/Bearer-/JSON-/URL-Werte und Surrogat-Grenzen');

const pool=getPool(),project='test-shell-puffer-'+randomUUID(),root=path.join(process.cwd(),'coedit-test',project);
const fake='flushSecret-'+randomUUID(),limit=64*1024,plain='x'.repeat(limit-8),suffix=' END 😀';
cleanup.trackRoot(root);
const oldFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>String(input).includes('/projects/'+project+'/status')?new Response('{"enabled":true}',{status:200}):oldFetch(input,init);
try{
 assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
 fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'.env'),'HIDDEN_SECRET='+fake+'\n');
 await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,os.hostname(),root]);
 const script='process.stdout.write("x".repeat('+String(limit-8)+')+'+JSON.stringify(fake.slice(0,8))+');setTimeout(()=>process.stdout.write('+JSON.stringify(fake.slice(8)+suffix)+'+"y".repeat('+String(limit)+')),100);setTimeout(()=>process.exit(0),1200)';
 const command="node -e '"+script.replaceAll("'","'\\''")+"'";
 let during='';
 const result=await runShell({project,command,detach_after_ms:500,onDetached:({stream_id})=>{
   during=fs.readFileSync(path.join(os.homedir(),'.synapse','shell-streams',stream_id+'.log'),'utf8');
 }});
 assert.equal(result.exit_code,0);
 const file=path.join(os.homedir(),'.synapse','shell-streams',result.stream_id+'.log');
 const full=fs.readFileSync(file,'utf8');
 assert.equal(full,plain+'[WERT]'+suffix+'y'.repeat(limit),'LF-freie Ausgabe und Unicode unveraendert bis auf Geheimnis');
 assert(!during.includes(fake));assert(!full.includes(fake));
 assert(during.length>=limit/2,'RED: Teilflush schreibt lange LF-freie Ausgabe schon waehrend des Jobs');
 assert(!during.endsWith(fake.slice(0,8)),'Secret-Praefix an Grenze wird zurueckgehalten');
 console.log('OK lange LF-freie Ausgabe waehrend Lauf sichtbar; Secret an Flush-Grenze voll maskiert; Unicode/Golden stabil');
}finally{
 globalThis.fetch=oldFetch;
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 await cleanup.cleanup();cleanup.dispose();await closePool();
}
