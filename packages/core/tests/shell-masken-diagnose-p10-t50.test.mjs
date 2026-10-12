/** P10-T50: sichere Vorschau und Gleichheit zum Speicherweg, nur eigene Testdaten. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const url=new URL(process.env.DATABASE_URL||'http://ungueltig');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
const {getPool,closePool}=await import('../dist/db/client.js');
const {fuehreShellAltAus}=await import('../dist/services/intern-shell-alt.js');
const {insertCompletedShellJob}=await import('../dist/services/shell-queue.js');
const {logToolCall}=await import('../dist/services/tool-call-log.js');
const P='test-p10-t50-'+randomUUID(),pool=getPool();
const literal='fixture-only-secret-'+randomUUID();
const sample='TOKEN=fixture-token-12345';
const read=async()=>({
 jobs:(await pool.query('SELECT id,output,tail,message,error FROM shell_jobs WHERE project=$1 ORDER BY id',[P])).rows,
 calls:(await pool.query('SELECT id,result,args_preview,error FROM tool_calls WHERE project=$1 ORDER BY id',[P])).rows
});
try{
 await pool.query("INSERT INTO shell_jobs(project,command,status,output,created_at) VALUES ($1,'old','done',$2,'2000-01-01')",[P,sample]);
 await pool.query("INSERT INTO shell_jobs(project,command,status,output,tail) VALUES ($1,'recent','done',$2,$3)",[P,sample,JSON.stringify([sample])]);
 await pool.query("INSERT INTO tool_calls(project,tool_name,result) VALUES ($1,'shell',$2)",[P,JSON.stringify({output:sample})]);
 const before=await read();
 const diag=await fuehreShellAltAus('shell_altbestand_maskieren',{project:P,seit:'2026-01-01T00:00:00Z',diagnose:true},'sol-3');
 assert.equal(diag.success,true);
 assert.equal(diag.tabellen.shell_jobs.geprueft,1,'Zeitfilter schliesst alten Job aus');
 assert.equal(diag.tabellen.tool_calls.geprueft,1,'ts-Filter fuer Toolcalls');
 assert.equal(diag.diagnose.length,3,'output/tail/result werden getrennt beschrieben');
 assert.ok(diag.diagnose.every(d=>['output','tail','result'].includes(d.feld)));
 assert.ok(diag.diagnose.every(d=>d.treffer.some(t=>t.regel==='kv_geheimname'&&t.name==='TOKEN'&&t.laenge>0)));
 assert.equal(JSON.stringify(diag).includes('fixture-token-12345'),false,'keine Werte ausgeben');
 assert.deepEqual(await read(),before,'Diagnose ist rein lesend');
 const invalid=await fuehreShellAltAus('shell_altbestand_maskieren',{project:P,seit:'keine-Zeit'},'sol-3');
 assert.equal(invalid.success,false,'ungueltiger Zeitfilter darf nicht unbemerkt alle lesen');
 // Echte Persistenzfunktionen, gleiche bekannte Quellen, anschliessend zweite Maske.
 await pool.query('DELETE FROM shell_jobs WHERE project=$1',[P]);
 await pool.query('DELETE FROM tool_calls WHERE project=$1',[P]);
 await insertCompletedShellJob({project:P,command:'fixture',status:'done',output:sample,tail:[sample],source:'mcp_local'});
 await logToolCall({project:P,agentId:'sol-3',tool:'shell',ok:true,result:JSON.stringify({output:sample})});
 const live=await fuehreShellAltAus('shell_altbestand_maskieren',{project:P,diagnose:true},'sol-3');
 assert.equal(live.tabellen.shell_jobs.zu_aendern+live.tabellen.tool_calls.zu_aendern,0,'gleiche Quellen: Speicherweg und Nachmaske gleich');
 // Quellenwechsel wird sichtbar, beweist allein noch keine Ursache beim echten Befund.
 const saved=process.env.P10_T50_TEST_SECRET;
 try{
  delete process.env.P10_T50_TEST_SECRET;
  await insertCompletedShellJob({project:P,command:'source-change',status:'done',output:literal,source:'mcp_local'});
  process.env.P10_T50_TEST_SECRET=literal;
  const changed=await fuehreShellAltAus('shell_altbestand_maskieren',{project:P,diagnose:true},'sol-3');
  assert.equal(changed.tabellen.shell_jobs.zu_aendern,1);
  assert.ok(changed.diagnose.some(d=>d.treffer.some(t=>t.regel==='env_literal'&&t.laenge===literal.length)));
  assert.equal(JSON.stringify(changed).includes(literal),false);
 }finally{if(saved===undefined)delete process.env.P10_T50_TEST_SECRET;else process.env.P10_T50_TEST_SECRET=saved;}
 await pool.query("INSERT INTO shell_jobs(project,command,status,output) VALUES ($1,'structured','done',$2)",[P,JSON.stringify({TOKEN:'fixture-nested-value'})]);
 const structured=await fuehreShellAltAus('shell_altbestand_maskieren',{project:P,diagnose:true},'sol-3');
 assert.ok(structured.diagnose.some(d=>d.treffer.some(t=>t.regel==='json_geheimname'&&t.name==='TOKEN')),'strukturierter Feldname bleibt klassifiziert');
 assert.equal(JSON.stringify(structured).includes('fixture-nested-value'),false);
 await pool.query("INSERT INTO shell_jobs(project,command,status,output) SELECT $1,'limit','done',$2 FROM generate_series(1,101)",[P,sample]);
 const capped=await fuehreShellAltAus('shell_altbestand_maskieren',{project:P,diagnose:true},'sol-3');
 assert.equal(capped.diagnose.length,100);
 assert.equal(capped.diagnose_gekappt,true,'abgeschnittene Diagnose ist sichtbar');
 console.log('PASS P10-T50 Zeitfilter, sichere Felddiagnose, lesend, echte Speicherwege, Quellenwechsel, Struktur und Kappung');
}finally{
 await pool.query('DELETE FROM shell_jobs WHERE project=$1',[P]);
 await pool.query('DELETE FROM tool_calls WHERE project=$1',[P]);
 await closePool();
}
