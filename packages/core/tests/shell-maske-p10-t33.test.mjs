/** P10-T33: shell-Golden am Altstand und rote Secret-Kontrolle nur synapse_test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
process.env.QDRANT_URL='http://127.0.0.1:9';process.env.OLLAMA_URL='http://127.0.0.1:9';
const {getPool,closePool}=await import('../dist/db/client.js');
const {execShellInProject}=await import('../dist/services/shell-exec.js');
const pool=getPool(), project='test-p10-t33-'+randomUUID();
const root=path.join(process.cwd(),'coedit-test',project), fake='nur-test-geheim-'+randomUUID();
const fetchAlt=globalThis.fetch;
globalThis.fetch=async(input,init)=>String(input).includes('/projects/'+project+'/status')?new Response('{"enabled":true}',{status:200}):fetchAlt(input,init);
try{
 assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
 fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'.env'),'UNRAID_SSH_PASSWORD='+fake+'\n');
 await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,os.hostname(),root]);
 const good=await execShellInProject({project,command:"printf 'hello shell\\n'",tail_lines:5});
 assert.equal(good.status,'done');assert.equal(good.exit_code,0);assert.deepEqual(good.tail,['hello shell']);
 assert.equal(good.maskiert,undefined,'Golden ohne Secrets unveraendert');
 console.log('OK Golden shell: done/0, tail hello shell, kein maskiert-Feld');
 const bad=await execShellInProject({project,command:'cat .env',tail_lines:5});
 assert.equal(bad.status,'done');
 assert(!JSON.stringify(bad).includes(fake),'RED: cat Test-.env muss vor der Rueckgabe maskiert sein');
 console.log('OK Secret-Ausgabe maskiert');

 const maske=await import('../dist/services/shell-maske.js');
 const queue=await import('../dist/services/shell-queue.js');
 const audit=await import('../dist/services/tool-call-log.js');
 const streamFile=path.join(os.homedir(),'.synapse','shell-streams',bad.stream_id+'.log');
 assert(!fs.readFileSync(streamFile,'utf8').includes(fake),'auch Stream-Datei darf nie Klartext speichern');
 assert(bad.maskiert>0);
 for(const name of ['KEY','TOKEN','SECRET','PASSWORD','PASS','PWD','API_KEY','AUTH','CREDENTIAL']){
   const r=maske.maskiereShellText(name+'=unbekanntesTestGeheimnis');
   assert.equal(r.text,name+'=[WERT]');assert(r.maskiert>0);
 }
 assert(!maske.maskiereShellText('Bearer unbekanntesTestGeheimnis').text.includes('unbekanntesTestGeheimnis'));
 assert(!maske.maskiereShellText('postgresql://tester:unbekanntesTestGeheimnis@host/db').text.includes('unbekanntesTestGeheimnis'));
 const json=maske.maskiereShellDaten({TOKEN:'unbekanntesTestGeheimnis',outer:{PASSWORD:'andereTestDaten'}},[]);
 assert(!JSON.stringify(json.daten).includes('unbekanntesTestGeheimnis'));assert(!JSON.stringify(json.daten).includes('andereTestDaten'));
 const bare=await execShellInProject({project,command:"cut -d= -f2 .env",tail_lines:5});
 assert(!JSON.stringify(bare).includes(fake),'bekannter Wert ohne Schluessel');
 const chunked=await execShellInProject({project,command:"node -e 'process.stdout.write(\"TOK\");setTimeout(()=>process.stdout.write(\"EN=chunkTestSecret\\n\"),15)'",tail_lines:5});
 assert(!JSON.stringify(chunked).includes('chunkTestSecret'),'Chunkgrenze trennt Secret-Schluessel');
 const raw='UNRAID_SSH_PASSWORD='+fake+'\n'+fake+'\nBearer unbekanntesTestGeheimnis\n';
 const {id}=await queue.insertCompletedShellJob({project,command:'test-completion',status:'done',tail:[raw],output:raw,message:'postgresql://tester:unbekanntesTestGeheimnis@host/db',source:'mcp_local',agent_id:'sol-1-test'});
 const saved=(await pool.query('SELECT output,tail,message FROM shell_jobs WHERE id=$1',[id])).rows[0];
 assert(!JSON.stringify(saved).includes(fake));assert(!JSON.stringify(saved).includes('unbekanntesTestGeheimnis'));
 const second=await queue.enqueueShellJob({project,command:'test-complete',agent_id:'sol-1-test'});
 await queue.completeShellJob(second.id,{status:'done',tail:[raw],output:raw});
 assert(!JSON.stringify((await pool.query('SELECT output,tail FROM shell_jobs WHERE id=$1',[second.id])).rows[0]).includes(fake));
 assert(!JSON.stringify(await queue.getShellJobById(id)).includes(fake));
 assert(!JSON.stringify(await queue.getShellJobLogLines(id)).includes(fake));
 assert(!JSON.stringify(await queue.searchShellJobLog(id,'WERT')).includes(fake));
 await audit.logToolCall({project,agentId:'sol-1-test',tool:'shell',action:'exec',ok:true,result:JSON.stringify({tail:[raw]}),argsPreview:raw});
 assert(!JSON.stringify((await pool.query('SELECT result,args_preview FROM tool_calls WHERE project=$1',[project])).rows).includes(fake));
 for(const detail of ['summary','full'])assert(!JSON.stringify(await audit.queryToolCalls({project,tool:['shell'],detail})).includes(fake));
 // Unveraenderter Altbestand: Lesen maskiert; autorisierte Anzeige mit Grund ist auditiert.
 const legacy=(await pool.query("INSERT INTO shell_jobs(project,command,status,output,tail,completed_at) VALUES($1,'legacy-test','done',$2,$3::jsonb,NOW()) RETURNING id",[project,raw,JSON.stringify([raw])])).rows[0].id;
 const counts=await maske.zaehleShellSecretBestand(project);assert.equal(counts.jobs,1);
 assert((await pool.query('SELECT output FROM shell_jobs WHERE id=$1',[legacy])).rows[0].output.includes(fake),'Zaehlen bereinigt keine Zeile');
 await assert.rejects(()=>maske.mitShellAusgabe({project,maskierung:false,agent_id:'sol-1',grund:'Gezielter Testfall'},()=>queue.getShellJobById(legacy)));
 await assert.rejects(()=>maske.mitShellAusgabe({project,maskierung:false,agent_id:'koordinator',grund:'kurz'},()=>queue.getShellJobById(legacy)));
 const erlaubt=await maske.mitShellAusgabe({project,maskierung:false,agent_id:'koordinator',grund:'Gezielter Altbestandstest'},()=>queue.getShellJobById(legacy));
 assert(erlaubt.output.includes(fake));assert(erlaubt.maskierung_audit);
 assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM tool_calls WHERE project=$1 AND action='maskierung_aus'",[project])).rows[0].n,1);
 assert(!JSON.stringify((await pool.query('SELECT result,args_preview FROM tool_calls WHERE project=$1',[project])).rows).includes(fake));
 console.log('OK Persistenz/get/log/activity, Muster/Wertliste/Chunkgrenzen, Altbestand nur gezaehlt, Override-Audit');

 assert.equal(maske.maskiereShellText('log KEY=inlineSecret').text,'log KEY=[WERT]');
 const docker=JSON.parse(maske.maskiereShellText('{"Config":{"Env":["API_KEY=dockerSecret","LANG=C.UTF8"]}}').text);
 assert.equal(docker.Config.Env[0],'API_KEY=[WERT]');assert.equal(docker.Config.Env[1],'LANG=C.UTF8');
 fs.writeFileSync(path.join(root,'.mcp.json'),JSON.stringify({mcpServers:{test:{env:{API_KEY:'mcpOnlyValue-98765'}}}}));
 fs.writeFileSync(path.join(root,'secrets.env'),'DEPLOY_AUTH=deployOnlyValue-98765\n');
 for(const [command,value]of [["node -e 'process.stdout.write(\"mcpOnlyValue-98765\")'",'mcpOnlyValue-98765'],["cut -d= -f2 secrets.env",'deployOnlyValue-98765']]){
   assert(!JSON.stringify(await execShellInProject({project,command})).includes(value));
 }
 const pgSecret='pgOnlyValue-98765';
 await pool.query("INSERT INTO code_files(id,project,file_path,file_name,file_type,content,content_hash,file_size) VALUES($1,$2,'cfg/.env.sample','.env.sample','sample',$3,'fixture',30)",[randomUUID(),project,'HIDDEN_SECRET='+pgSecret]);
 assert(!JSON.stringify(await maske.maskiereShellAntwort(project,{tail:[pgSecret]})).includes(pgSecret));
 await audit.logToolCall({project:null,agentId:'sol-1-test',tool:'shell',action:'get',ok:true,result:JSON.stringify({job:{project,output:pgSecret}})});
 assert(!JSON.stringify((await pool.query("SELECT result FROM tool_calls WHERE agent_id='sol-1-test' AND project IS NULL AND position($1 in result)>0",[project])).rows).includes(pgSecret));
 const {handleToolCall}=await import('../../rest-api/dist/routes/mcp.js');
 const {shellTool}=await import('../../mcp-server/dist/tools/consolidated/shell.js');
 const decode=r=>r?.content?JSON.parse(r.content[0].text):r;
 for(const handler of [args=>handleToolCall('shell',args),shellTool.handler]){
  for(const args of [{action:'get',id:legacy},{action:'log',id:legacy},{action:'log',id:legacy,query:'WERT'},{action:'activity',project,tools:['shell'],detail:'full'}]){
   const r=decode(await handler(args));assert(!JSON.stringify(r).includes(fake));assert(!JSON.stringify(r).includes('unbekanntesTestGeheimnis'));
  }
  await assert.rejects(()=>handler({action:'get',id:legacy,maskierung:false,agent_id:'sol-1',grund:'Unberechtigter Test'}));
  const r=decode(await handler({action:'get',id:legacy,project,maskierung:false,agent_id:'koordinator',grund:'Transport Altbestandsprobe'}));
  assert(r.job.output.includes(fake));
 }
 console.log('OK Stdio/REST get/log/activity + verweigertes/erlaubtes Override, Docker-Env-Namen, zusätzliche FS/PG-Wertquellen');

 const lang='not JSON {"note":"'+('token key '.repeat(6000))+'"}';
 const start=performance.now();const longResult=maske.maskiereShellText(lang);
 assert.equal(longResult.text,lang);assert(performance.now()-start<100,'lange normale Logwerte ohne quadratische Regex-Suche');
 assert.deepEqual(maske.maskiereShellText('[WERT]', ['W']),{text:'[WERT]',maskiert:0},'Platzhalter nicht erneut maskieren');
 fs.appendFileSync(path.join(root,'.env'),'PUBLIC_FLAG=1\n');
 const identitaet='11111111-1111-4111-8111-111111111111';
 const metadata=await maske.maskiereShellAntwort(project,{status:'done',id:identitaet,tail:['literal 1']});
 assert.equal(metadata.id,identitaet,'Secret-Werte maskieren keine Steuer-ID');
 assert.equal(metadata.tail[0],'literal 1','kurzes öffentliches FLAG-Literal bleibt lesbar');



}finally{
 globalThis.fetch=fetchAlt;
 await pool.query("DELETE FROM tool_calls WHERE project=$1 OR (agent_id='sol-1-test' AND project IS NULL AND position($2 in result)>0)",[project,project]);
 await pool.query('DELETE FROM code_files WHERE project=$1',[project]);
 await pool.query('DELETE FROM shell_jobs WHERE project=$1',[project]);
 await pool.query('DELETE FROM projects WHERE name=$1',[project]);
 fs.rmSync(root,{recursive:true,force:true});
 await closePool();
}
process.exit(0);
