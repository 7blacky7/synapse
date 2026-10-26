/**
 * P22-T197: claude-prompt-start.ts (process.ts gemeinsamer Claude-Start).
 * E2BIG-Befund c533a466 / Analyse30227035: grosse Unicode-Prompts muessen aus argv/env bleiben.
 * Echte Dateirechte/Lebensdauer und OS-E2BIG-Gegenbeleg mit Wegwerfdaten; Claude-Spawn fuer einen Fall auf echtes Node-Kind gelenkt, KEINE CLI/Modell/Runtime-Aktion.
 * Keine DB/Browser. Aufruf: node packages/agents/tests/claude-prompt-start-p22-t197.test.mjs (Mock-Flag wird automatisch aktiviert)
 */
import assert from 'node:assert/strict';
import {mock} from 'node:test';
// P22-T197: test-alle invokes plain node; enable the required Node capability
// BEFORE any project import, DB access or temporary data. No skip, same assertions.
if(typeof mock.module!=='function'){
 const flag='--experimental-test-module-mocks';
 if(process.execArgv.includes(flag))throw Error('P22-T197: mock.module unavailable despite '+flag+' (Node '+process.version+')');
 const {spawnSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const child=spawnSync(process.execPath,[...process.execArgv,flag,fileURLToPath(import.meta.url),...process.argv.slice(2)],{stdio:'inherit',env:process.env});
 if(child.error)throw child.error;
 process.exit(child.status??1);
}

import {spawn as spawnOriginal} from 'node:child_process';
import {createHash} from 'node:crypto';
const spawnOS=spawnOriginal;
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFileSync,statSync,existsSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
const dir=await mkdtemp(join(tmpdir(),'synapse-t197-')),id=randomUUID();
const body='T197_PRIVATE_PROMPT \\ 😀 ä\n'.repeat(10000),secret='T197_PRIVATE_ENV';
let mode='ok',child,lastPath,calls=0,checks=0;
const logs=[],originalError=console.error;
const ok=(v,label,actual)=>{if(!v)console.error('DEBUG P22-T197 claude-prompt-start.ts '+label+' erwartet=true ist='+JSON.stringify(actual));assert.ok(v,label);checks++;console.log('OK P22-T197 '+label);};
const spawn=(binary,args,opts)=>{
 calls++;lastPath=args[args.indexOf('--system-prompt-file')+1];
 ok(binary==='claude'&&args.includes('--system-prompt-file')&&!args.includes('--system-prompt'),'Dateiargument ersetzt Inline-Argument',args.length);
 ok(!args.some(v=>String(v).includes('T197_PRIVATE_PROMPT'))&&!Object.values(opts.env).some(v=>String(v).includes('T197_PRIVATE_PROMPT')),'Prompt weder argv noch env',args.length);
 ok(readFileSync(lastPath,'utf8')===body&&statSync(lastPath).mode%512===0o600,'>128KiB Unicode-Prompt bytegleich und0600',{bytes:Buffer.byteLength(body),mode:statSync(lastPath).mode%512});
 if(mode==='os'){
  const worker="const fs=require('node:fs'),c=require('node:crypto'),b=fs.readFileSync(process.argv[1]);process.stdout.write(JSON.stringify({bytes:b.length,sha:c.createHash('sha256').update(b).digest('hex')}));process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";
  return spawnOS(process.execPath,['--eval',worker,'--',lastPath],opts);
 }
 if(mode==='sync')throw Object.assign(new Error('spawn E2BIG'),{code:'E2BIG'});
 child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
 const c=child;
 process.nextTick(()=>{if(mode==='async'){c.emit('error',Object.assign(new Error('spawn ENOENT'),{code:'ENOENT'}));c.emit('close',-1);}else c.emit('spawn');});
 return c;
};
mock.module('node:child_process',{namedExports:{spawn}});
const {starteClaudeMitPromptdatei}=await import('../dist/claude-prompt-start.js');
const e={agentName:'t197-'+id,sessionId:id,systemPrompt:body,args:['--print','--session-id',id],env:{T197_ENV:secret},cwd:dir,projectPath:dir};
try{
 console.error=(...x)=>logs.push(x.join(' '));
 const proc=await starteClaudeMitPromptdatei(e);
 ok(proc===child&&existsSync(lastPath),'Datei bleibt nach OS-spawn lesbar (CLI kann erst danach lesen)',lastPath);
 ok(lastPath.startsWith(join(dir,'.synapse','agents',e.agentName)),'Datei im bestehenden Laufordner',lastPath);
 const first=lastPath;
 const before=calls;
 await assert.rejects(starteClaudeMitPromptdatei(e),x=>x.code==='EEXIST');
 ok(calls===before&&existsSync(first)&&readFileSync(first,'utf8')===body,'wx/EEXIST bewahrt Datei der laufenden Sitzung',calls);
 proc.emit('close',0);
 for(let i=0;i<50&&existsSync(first);i++)await new Promise(r=>setTimeout(r,5));
 ok(!existsSync(first),'Child-close entfernt ausschliesslich eigene Promptdatei',first);
 for(const m of ['sync','async']){
  mode=m;
  await assert.rejects(starteClaudeMitPromptdatei({...e,sessionId:randomUUID()}),err=>{
   ok(err.code===(m==='sync'?'E2BIG':'ENOENT'),'Fehlercode '+m+' erhalten',err.code);
   ok(err.message.includes('prompt_bytes')&&!err.message.includes(secret)&&!err.message.includes('T197_PRIVATE_PROMPT'),'Fehlerdiagnose ohne Inhalte '+m,err.code);
   if(m==='sync')ok(err.message.includes('bereits per Datei'),'E2BIG benennt verbleibende argv/env-Grenze',err.message);
   return true;
  });
  ok(!existsSync(lastPath),'Startfehler '+m+' entfernt Promptdatei',lastPath);
 }

 // P22-T197: dieselbe Betriebssystem-Grenze wie im Befund tatsaechlich ausloesen,
 // danach echter Node-Kindprozess mit nur Dateipfad. Kein Claude-/Modellstart.
 if(process.platform==='linux'){
  await assert.rejects(new Promise((resolve,reject)=>{
   try{const p=spawnOS(process.execPath,['--eval','process.exit(0)',body],{stdio:'ignore'});p.once('error',reject);p.once('close',resolve);}
   catch(error){reject(error);}
  }),err=>err.code==='E2BIG');
  ok(true,'Echter OS-Gegenbeleg: grosser Inline-Prompt loest E2BIG aus',Buffer.byteLength(body));
 }
 mode='os';
 const native=await starteClaudeMitPromptdatei({...e,sessionId:randomUUID()});
 const nativePath=lastPath;
 const text=await new Promise((resolve,reject)=>{native.stdout.once('data',b=>resolve(b.toString()));native.once('error',reject);});
 const measured=JSON.parse(text);
 ok(measured.bytes===Buffer.byteLength(body)&&measured.sha===createHash('sha256').update(body).digest('hex'),'Echter OS-Kindprozess liest grossen Prompt bytegleich per Datei',measured);
 ok(existsSync(nativePath),'Echtes Kind haelt Datei bis Ende verfuegbar',nativePath);
 const beendet=new Promise(r=>native.once('close',r));native.stdin.end();await beendet;
 for(let i=0;i<50&&existsSync(nativePath);i++)await new Promise(r=>setTimeout(r,5));
 ok(!existsSync(nativePath),'Echtes Prozessende entfernt Promptdatei',nativePath);

 const d=logs.filter(x=>x.startsWith('[claude-start] ')).map(x=>{try{return JSON.parse(x.slice(15));}catch{return null;}}).filter(x=>x?.prompt_bytes);
 ok(d.length>=3&&d.every(x=>x.prompt_bytes===Buffer.byteLength(body)&&x.argv_max_bytes<131072&&x.argv_env_bytes===x.argv_bytes+x.env_bytes),'Byte-Diagnose zählt UTF8+NUL, grosse Daten nur in Datei',d);
 ok(!logs.join('\n').includes(secret)&&!logs.join('\n').includes('T197_PRIVATE_PROMPT'),'Keine Prompt-/Environment-Inhalte im Log',logs.length);
 ok(!readdirSync(dirname(lastPath)).some(x=>x.endsWith('.txt')),'Kein Promptrest nach Erfolg/Fehler',lastPath);
 console.log('P22-T197 '+checks+' Pruefungen GRUEN; kein Modellaufruf, Runtime-Live-Abnahme separat.');
}finally{console.error=originalError;mock.restoreAll();await rm(dir,{recursive:true,force:true});}
