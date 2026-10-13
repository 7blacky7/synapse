/** t83: Fastify-Injektion und SDK-MCP-Client sind keine HTTP-/PG-Schreibzugriffe. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {ermittleShellLage} from '../dist/services/shell-lage.js';
import {pruefeShellStart} from '../dist/services/shell-start-sicherung.js';
import {SHELL_SICHERUNG_SEED} from '../dist/services/shell-sicherung-seed.js';
import {pruefeDbKommando,dbZielAusUrl} from '../dist/services/shell-db-zuordnung.js';
const root='/home/blacky/dev/synapse',project='p10_t83_fixture';
const own='postgresql://tester:synthetic@test.invalid:5433/synapse_test',live='postgresql://system:synthetic@live.invalid:6123/system';
const proof={project,live:dbZielAusUrl(live),ziele:[{...dbZielAusUrl(own),art:'test'}]};
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/shell-fastify-p10-t65.json',import.meta.url),'utf8'));
async function decide(command,source){
 const probe=async input=>({cwd:input.cwd,os:'linux',env:{},pfade:(input.pfade??[]).map(p=>({pfad:p,kanonisch:p,existiert:true,links:[]})),
  ...(input.testdatei===root+'/'+source?.file?{testdatei:{pfad:input.testdatei,kanonisch:input.testdatei,text:source.text,sha256:source.sha256}}:{}),
  ...(input.umgebungsdatei?{umgebungsdatei:{pfad:input.umgebungsdatei,sha256:'a'.repeat(64),testprojekt:true,exportiert:true,port:'5433',datenbank:'synapse_test',datenbank_ziel:dbZielAusUrl(own)}}:{})});
 const lage=await ermittleShellLage(command,{cwd:root,project_root:root,os:'linux',shell:'sh',env:{},env_vollstaendig:true,datenbank_freigabe:proof,inspect:!!source,probe});
 return pruefeShellStart({project,command,lage,agent_id:'sol-2'},SHELL_SICHERUNG_SEED);
}
for(const f of fixtures)test('Unveränderter historischer Job '+f.job.slice(0,8)+' ist frei',async()=>{
 assert.equal(createHash('sha256').update(f.text).digest('hex'),f.sha256);
 const r=await decide(f.command,f);assert.equal(r.darf_starten,true,JSON.stringify({audit:r.audit,risiko:r.antwort?.risiko,ungeklaert:r.antwort?.lage.ungeklaert,db:r.antwort?.lage.datenbank_abgewiesen}));
});
const inline=text=>'node -e '+JSON.stringify(text);
for(const text of [
 "const app=Fastify();app.inject({method:'POST',url:'/fixture',payload:{}})",
 "const app=Fastify();const probes=[{method:'DELETE',url:'/fixture'}];for(const r of probes)app.inject(r)",
 "const record={method:'POST'};console.log(record)",
 "function run(req){return app.inject(req)}run({method:'PATCH',url:'/fixture'})"
])test('Lokale Methoden-Daten tragen keinen HTTP-Risikomarker',async()=>assert.equal((await decide(inline(text))).darf_starten,true));
for(const text of [
 "fetch('https://outside.invalid',{method:'POST'})",
 "fetch('https://outside.invalid',process.env.OPTIONS)",
 "import{request as send}from'node:http';send('https://outside.invalid',{method:'DELETE'})",
 "import axios from'axios';axios.request({url:'https://outside.invalid',method:'PUT'})",
 "const client=unknown;client.request({method:'POST'})",
 "const app=Fastify();app.inject({method:'POST'});fetch('https://outside.invalid',{method:'POST'})"
])test('Echter oder unklarer HTTP-Schreibaufruf bleibt Anleitung',async()=>assert.equal((await decide(inline(text))).darf_starten,false));
const db=text=>pruefeDbKommando({argv:[{text:'node'}],inline_skript:{sprache:'node',text}},{},proof);
for(const module of ['@modelcontextprotocol/sdk/client/index.js','../node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'])
 test('Expliziter MCP-Import ist kein PG-Client '+module,()=>{
  assert.equal(db("import{Client as McpClient}from'"+module+"';new McpClient({name:'fixture'},{capabilities:{}})").betroffen,false);
 });
for(const text of [
 "import{Client as DbClient}from'pg';new DbClient({host:'live.invalid',port:6123,database:'system'})",
 "const{Pool:DbPool}=require('pg');new DbPool({host:'live.invalid'})",
 "new Client({host:'live.invalid'})",
 "import{Client}from'@modelcontextprotocol/sdk/client/index.js';const db=getPool();db.query('DROP TABLE owned')"
])test('PG oder zusätzliche SQL bleibt ohne DB-Nachweis gesperrt',()=>{assert.equal(db(text).betroffen,true);assert.equal(db(text).erlaubt,false);});
