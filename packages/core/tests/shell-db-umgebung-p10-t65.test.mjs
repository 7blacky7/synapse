/** P10-T65 Richtungswechsel3: synthetische Ziele, echte Kindprozesse, keine SQL/Netzverbindung. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {baueJobUmgebung,vergissJobUmgebungCache} from '../dist/services/shell-job-umgebung.js';
import {dbZielAusUrl,pruefeDbKommando} from '../dist/services/shell-db-zuordnung.js';
const live='postgresql://system:synthetic@system.invalid:6123/system_catalog';
const own='postgresql://tester:synthetic@test.invalid:7123/p10_env_test';
const proof={project:'p10_env_test',live:dbZielAusUrl(live),ziele:[{...dbZielAusUrl(own),art:'test'}]};
const js=text=>pruefeDbKommando({argv:[{text:'node'}],inline_skript:{sprache:'node',text}}, {DATABASE_URL:own},proof);
const cases=[
 ['cfg neu zugewiesen',"const{Client}=require('pg');let cfg={connectionString:process.env.DATABASE_URL};cfg={host:'system.invalid',port:6123,database:'system_catalog',user:'system'};new Client(cfg).query('DROP TABLE owned')"],
 ['cfg Spread',"const{Pool}=require('pg');const cfg={connectionString:process.env.DATABASE_URL};const c=new Pool({...cfg,host:'system.invalid'});c.query('DROP TABLE owned')"],
 ['q neu zugewiesen',"const c=getPool();let q={text:'DROP TABLE owned'};q={text:'DROP DATABASE system_catalog'};c.query(q)"],
 ['URL mutiert',"const{Client}=require('pg');const u=new URL(process.env.DATABASE_URL);u.hostname='system.invalid';u.port='6123';u.pathname='/system_catalog';new Client({connectionString:u.toString()}).query('DROP TABLE owned')"],
 ['Literal eigene DSN',"const{Client}=require('pg');new Client({connectionString:'"+own+"'}).query('DROP TABLE owned')"],
 ['Env-Alias',"const{Client}=require('pg');const uri=process.env.DATABASE_URL;new Client({connectionString:uri}).query('DROP TABLE owned')"],
 ['SQL Wechsel',"const c=getPool();c.query('USE system_catalog')"],
 ['Env-Neuzuweisung',"process.env.DATABASE_URL='"+live+"';const c=getPool();c.query('DROP TABLE owned')"],
];
for(const [name,text]of cases)test(name+' ergibt Anleitung',()=>assert.equal(js(text).erlaubt,false));
for(const text of [
 "const c=getPool();c.query(process.env.SQL)",
 "const{Client}=require('pg');new Client({connectionString:process.env.DATABASE_URL}).query('DROP TABLE owned')",
 "const{Pool}=require('pg');new Pool({connectionString:process.env.DATABASE_URL}).query('CREATE TABLE owned(x int)')",
 "const c=getPool();c.query('DROP TABLE owned')"
])test('Direkte eigene Env-Zielkontrolle frei',()=>assert.equal(js(text).erlaubt,true));
test('System-Zugang nie an Kind, auch über Durchlass und beliebigen Konfigurationsnamen/Port',async()=>{
 const basis={PATH:process.env.PATH,DATABASE_URL:live,SYNAPSE_DATABASE_URL:live,PGHOST:'system.invalid',PGPORT:'6123',PGDATABASE:'system_catalog',PGUSER:'system',PGPASSWORD:'synthetic',
 SYNAPSE_SHELL_ENV_DURCHLASS:'DATABASE_URL,SYNAPSE_DATABASE_URL,PGPASSWORD',UNGEWOEHNLICHER_NAME:live};
 const opt={basis,systemUrl:live,leseZugang:async()=>null,secretsPfad:'/nonexistent/p10_env_test',existiert:()=>false};
 const job=await baueJobUmgebung('synapse',opt);
 assert.equal(job.info.database_url,'keine');
 assert.equal(Object.keys(job.env).some(k=>/^PG|^(?:SYNAPSE_)?DATABASE_URL$/i.test(k)),false);
 assert.equal(Object.values(job.env).includes(live),false);
 const code="process.stdout.write(JSON.stringify({db:!!process.env.DATABASE_URL,syn:!!process.env.SYNAPSE_DATABASE_URL,pg:Object.keys(process.env).some(k=>/^PG/i.test(k))}))";
 const child=spawnSync(process.execPath,['-e',code],{env:job.env,encoding:'utf8'});
 assert.equal(child.status,0);assert.deepEqual(JSON.parse(child.stdout),{db:false,syn:false,pg:false});
 // Docker exec erbt Basisvariablen: dieselbe env -i Konstruktion entfernt sie vor dem Nutzerprozess.
 const docker=spawnSync('/usr/bin/env',['-i',...Object.entries(job.env).map(([k,v])=>k+'='+v),process.execPath,'-e',code],{env:basis,encoding:'utf8'});
 assert.equal(docker.status,0);assert.deepEqual(JSON.parse(docker.stdout),{db:false,syn:false,pg:false});
 assert.equal(basis.DATABASE_URL,live,'Parent behält eigenen Systemzugang');
});
test('Eigene registrierte Projekt-DB bleibt im Kind, System-DB mit anderer Rolle nicht',async()=>{
 vergissJobUmgebungCache();
 const opt={basis:{PATH:process.env.PATH,DATABASE_URL:live},systemUrl:live,secretsPfad:'/nonexistent/p10_env_test',existiert:()=>false,
 leseZugang:async project=>({database_url:project==='p10_env_test'?own:live.replace('system:','other:'),host:project==='p10_env_test'?'test.invalid':'system.invalid',port:project==='p10_env_test'?7123:6123,database:project==='p10_env_test'?'p10_env_test':'system_catalog'})};
 const job=await baueJobUmgebung('p10_env_test',opt);
 assert.equal(job.env.DATABASE_URL,own);assert.equal(job.env.SYNAPSE_DATABASE_URL,undefined);
 const child=spawnSync(process.execPath,['-e',"process.stdout.write(String(process.env.DATABASE_URL===process.argv[1]))",own],{env:job.env,encoding:'utf8'});
 assert.equal(child.status,0);assert.equal(child.stdout,'true');
 const bad=await baueJobUmgebung('p10_env_wrong',opt);assert.equal(bad.env.DATABASE_URL,undefined);
});

test('Core-Import lädt System-.env im markierten Shell-Kind nicht nach',async()=>{
 const dir=await mkdtemp(fileURLToPath(new URL('./p10-env-fixture-',import.meta.url)));
 try {
  await writeFile(dir+'/.env','DATABASE_URL='+live+'\nSYNAPSE_DATABASE_URL='+live+'\n');
  const job=await baueJobUmgebung('synapse',{basis:{PATH:process.env.PATH},systemUrl:live,leseZugang:async()=>null,secretsPfad:'/nonexistent/p10_env_test',existiert:()=>false});
  const modul=new URL('../dist/config.js',import.meta.url).href;
  const code="await import(process.argv[1]);process.stdout.write(String(!process.env.DATABASE_URL&&!process.env.SYNAPSE_DATABASE_URL))";
  const child=spawnSync(process.execPath,['--input-type=module','-e',code,modul],{env:job.env,cwd:dir,encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'true');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('WorkspaceOrchestrator.exec entfernt tatsächlich Docker-Config.Env vor dem Nutzerprozess',async()=>{
 const {WorkspaceOrchestrator}=await import('../../rest-api/dist/services/workspace-orchestrator.js');
 const {mitLesePool}=await import('../dist/db/client.js');
 const {Readable}=await import('node:stream');
 const inherited={PATH:process.env.PATH,DATABASE_URL:live,SYNAPSE_DATABASE_URL:live,PGPASSWORD:'synthetic',PGHOST:'system.invalid'};
 let nutzerStart=0;
 const container={
  putArchive:async stream=>{for await(const chunk of stream){void chunk;}},
  inspect:async()=>({Config:{Env:Object.entries(inherited).map(([k,v])=>k+'='+v)}}),
  exec:async o=>{
   if(o.User==='0')return{start:async()=>Readable.from([]),inspect:async()=>({ExitCode:0})};
   nutzerStart++;
   const child=spawnSync(o.Cmd[0],o.Cmd.slice(1),{env:inherited,encoding:'utf8'});
   return {start:async()=>Readable.from([Buffer.from(child.stdout)]),inspect:async()=>({ExitCode:child.status})};
  }
 };
 const w=new WorkspaceOrchestrator();
 w.dockerAvailable=true;
 w.ensureProjectRunning=async()=> 'synthetic-container';
 w.recordActivity=async()=>{};
 w.appendToLog=async()=>{};
 w.lageProbeImContainer=async()=>({cwd:'/workspace',os:'linux',env:{HOME:'/home/synthetic',PWD:'/workspace'},pfade:[],prozesse:{pids:[],namen:[]}});
 w.docker={getContainer:()=>container,modem:{demuxStream:(stream,stdout,stderr)=>{stream.pipe(stdout);stderr.end();}}};
 const client={query:async sql=>({rows:String(sql).includes(' AS katalog')?[{katalog:{regeln:[],antworten:[],risiko_verben:[]}}]:[],rowCount:0}),release(){}};
 const pool={query:client.query,connect:async()=>client};
 vergissJobUmgebungCache('p10_workspace_env');
 const result=await mitLesePool(pool,()=>w.exec('p10_workspace_env','env',{agent_id:'sol-2'}));
 assert.equal(nutzerStart,1,JSON.stringify({status:result.status,error:result.error}));
 assert.equal(result.exitCode,0,result.stderr);
 const env=Object.fromEntries(result.stdout.trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
 assert.equal(env.DATABASE_URL,undefined);assert.equal(env.SYNAPSE_DATABASE_URL,undefined);
 assert.equal(Object.keys(env).some(k=>/^PG/i.test(k)),false);
 assert.equal(env.SYNAPSE_SHELL_JOB,'1');
});

test('System-Alias ohne PostgreSQL-Standardport ist kein Durchlass-Geheimnis',async()=>{
 const system='postgresql://system:synthetic@system.invalid:5432/system_catalog';
 const alias='postgresql://other:synthetic@system.invalid/system_catalog';
 const job=await baueJobUmgebung('synapse',{basis:{PATH:process.env.PATH,REPORT_DB:alias,SYNAPSE_SHELL_ENV_DURCHLASS:'REPORT_DB'},systemUrl:system,leseZugang:async()=>null,secretsPfad:'/nonexistent/p10_env_test',existiert:()=>false});
 const child=spawnSync(process.execPath,['-e',"process.stdout.write(String(!process.env.REPORT_DB))"],{env:job.env,encoding:'utf8'});
 assert.equal(child.status,0);assert.equal(child.stdout,'true');
});
