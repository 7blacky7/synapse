/** P10-T33 urgente Regression: öffentliche Werte niemals Secret-Literale. Nur synapse_test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {createTestFixtureCleanup, trackShellStreams} from './_helfer/test-fixture-cleanup.mjs';
const u=new URL(process.env.DATABASE_URL||'http://ungueltig');assert.equal(u.port,'5433');assert.equal(u.pathname,'/synapse_test');
const env=await import('../dist/services/env-maske.js');
const publicText='0123456789 facf011272258b569c6d0205fa55de218ccb6679 5433 3456 11111111-1111-4111-8111-111111111111 2026-10-12T16:44:47Z tests_passed=31 input_tokens=1059 token_count=10 KEY_COUNT=4 PASSWORD_LENGTH=12 keyboard=ordinary-public-long-value';
const fake='private-key-'+randomUUID(),pwd='url-password-'+randomUUID();
const source='PORT=3456\nX=1\nZERO=0\nPUBLIC_LONG=ordinary-public-long-value\nREAL_API_KEY='+fake+'\nTINY_TOKEN=short\nDATABASE_URL=postgresql://tester:'+pwd+'@host:5433/db\n';
const json=JSON.stringify({mcpServers:{test:{env:{PORT:'3456',FLAG:'1',PUBLIC_LONG:'ordinary-public-long-value',TOKEN:fake},url:'postgresql://tester:'+pwd+'@host/db'}}});
const values=env.shellGeheimWerte(source,json);
assert(!values.includes('3456')&&!values.includes('1')&&!values.includes('0'),'RED: öffentliche Ports/Flags nicht als bekannte Literale sammeln');
assert(!values.includes('ordinary-public-long-value'),'auch lange öffentliche Konfiguration kein Geheimnis');
assert(!values.includes('short'),'Mindestlänge für Literale');
assert(values.includes(fake)&&values.includes(pwd),'echter Schlüssel und URL-Passwort bleiben Literale');
assert.equal(env.maskiereShellText(publicText,values).text,publicText,'Ziffern/Hashes/Ports bytegleich');
assert.equal(env.maskiereShellText(publicText,['0','1','3','4','5','6','5433','3456']).text,publicText,'auch explizite Kleinliteral-Listen werden gefiltert');
assert(!env.maskiereShellText('bare '+fake+' '+pwd,values).text.includes(fake));
assert.equal(env.maskiereShellText('TOKEN=short').text,'TOKEN=[WERT]','Namensmuster schützt auch kurze benannte Geheimnisse');
console.log('OK Quellenfilter/Mindestlänge: öffentliche Werte/Hashes/Ziffern lesbar, Geheimnis/URL-Passwort geschützt');
const normalJson=JSON.stringify({Env:['PORT=3456','FLAG=1'],headers:{Accept:'application/json'},input_tokens:1059,token_count:10,KEY_COUNT:4,PASSWORD_LENGTH:12,keyCount:4,uuid:'11111111-1111-4111-8111-111111111111',timestamp:'2026-10-12T16:44:47Z',hash:'facf011272258b569c6d0205fa55de218ccb6679',pass_rate:0.9,keyboard:'ordinary-public-long-value'});
for(const text of [normalJson,'normal '+normalJson]){
 assert.deepEqual(env.maskiereShellText(text,values),{text,maskiert:0},'MCP-JSON/Fragment: normale Metadaten unverändert');
}
const {ShellAusgabePuffer}=await import('../dist/services/shell-ausgabe-puffer.js');
let normalFlush='',normalCount=0;
const puffer=new ShellAusgabePuffer(values,(text,count)=>{normalFlush+=text;normalCount+=count;});
const langeNormalausgabe=publicText.repeat(3000);puffer.empfange(langeNormalausgabe);puffer.ende();
assert.equal(normalFlush,langeNormalausgabe);assert.equal(normalCount,0,'Teilflush-Probe erzeugt keine false positive Maskierung');

const {getPool,closePool}=await import('../dist/db/client.js'),{execShellInProject}=await import('../dist/services/shell-exec.js');
const cleanup=createTestFixtureCleanup(),runShell=trackShellStreams(cleanup,execShellInProject);
const pool=getPool(),project='test-public-shell-'+randomUUID(),root=path.join(process.cwd(),'coedit-test',project),oldFetch=globalThis.fetch;
cleanup.trackRoot(root);
globalThis.fetch=async(input,init)=>String(input).includes('/projects/'+project+'/status')?new Response('{"enabled":true}',{status:200}):oldFetch(input,init);
try{
 fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'.env'),source);fs.writeFileSync(path.join(root,'.mcp.json'),json);
 await pool.query('INSERT INTO projects(name,hostname,path,enabled) VALUES($1,$2,$3,true)',[project,os.hostname(),root]);
 const r=await runShell({project,command:"printf '"+publicText+"\\n'",tail_lines:5});
 assert.equal(r.exit_code,0);assert.deepEqual(r.tail,[publicText]);assert.equal(r.maskiert,undefined);
 const bad=await runShell({project,command:'cat .env'});
 assert(!JSON.stringify(bad).includes(fake));assert(!JSON.stringify(bad).includes(pwd));
 const full=fs.readFileSync(path.join(os.homedir(),'.synapse','shell-streams',bad.stream_id+'.log'),'utf8');
 assert(full.includes('PORT=3456')&&full.includes('X=1')&&full.includes('PUBLIC_LONG=ordinary-public-long-value'));
 console.log('OK echter Stream: öffentliche Ausgabe bytegleich, Test-.env nur Geheimnisse maskiert');
}finally{globalThis.fetch=oldFetch;await cleanup.cleanup();cleanup.dispose();await pool.query('DELETE FROM projects WHERE name=$1',[project]);await closePool();}
