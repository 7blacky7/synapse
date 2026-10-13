/** RV19: echte Toolaufrufe über beide REST-Endpunkte und stdio-SDK, nur synthetische Test-DB. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from '../../rest-api/node_modules/fastify/fastify.js';
const url=new URL(process.env.DATABASE_URL||'http://invalid');
assert.equal(url.port,'5433');assert.equal(url.pathname,'/synapse_test');
Object.assign(process.env,{QDRANT_URL:'http://127.0.0.1:1',SYNAPSE_SKIP_EMBEDDINGS:'1',SYNAPSE_HINWEIS_BUDGET_MS:'300'});
delete process.env.SYNAPSE_DATABASE_URL;
const core=await import('../dist/index.js');
const {mcpRoutes}=await import('../../rest-api/dist/routes/mcp.js');
const {createServer}=await import('../../mcp-server/dist/server.js');
const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {InMemoryTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js');
const pool=core.getPool(),project='p18_rv19',prefix='p18_rv19-wire-'+randomUUID(),agents=[];
const rest=Fastify({logger:false});await rest.register(mcpRoutes);await rest.ready();
const stdio=createServer(),[ct,st]=InMemoryTransport.createLinkedPair();
await stdio.connect(st);const client=new Client({name:'rv19-test',version:'1'});await client.connect(ct);
const rpc=async(endpoint,name,args)=>{
  const r=await rest.inject({method:'POST',url:endpoint,payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}}});
  assert.equal(r.statusCode,200,r.body);const v=r.json();assert(!v.error,JSON.stringify(v.error));return v.result;
};
const decode=r=>JSON.parse(r.content[0].text);
let stop;
try {
  for(const [label,call] of [['rest-root',(n,a)=>rpc('/',n,a)],['rest-messages',(n,a)=>rpc('/mcp/messages',n,a)],['stdio',(n,a)=>client.callTool({name:n,arguments:a})]]) {
    const agent=prefix+'-'+label;agents.push(agent);
    await pool.query("INSERT INTO agent_sessions(id,project,status,sitzung_seit) VALUES($1,$2,'active',NOW())",[agent,project]);
    const args={project,agent_id:agent,action:'variables',file_path:'synthetic-no-file.ts'};
    await call('code_intel',args); // Bestands-Onboarding/First-use vollständig abholen.
    const before=decode(await call('code_intel',args));
    assert.equal(before.ausloeser_hinweise,undefined);
    stop=core.registriereHinweisQuelle({quelle_id:'rv19-wire',pruefe:c=>
      c.tool==='code_intel'&&c.aktion==='variables'&&c.agent_id===agent
        ? [{hinweis_id:'wire',modus:'einmal_je_sitzung',text:'Synthetische Strecke'}] : []});
    const response=await call('code_intel',args),after=decode(response);
    assert.deepEqual(after.ausloeser_hinweise,['Synthetische Strecke'],label);
    if(response.structuredContent)assert.deepEqual(response.structuredContent.ausloeser_hinweise,after.ausloeser_hinweise,'Text und strukturierte Antwort gleich');
    const {ausloeser_hinweise,...restAfter}=after;
    assert.deepEqual(restAfter,before,label+' bestehende Felder unverändert');
    assert.equal(decode(await call('code_intel',args)).ausloeser_hinweise,undefined,label+' Dedup');
    stop();stop=undefined;
    console.log('PASS '+label+' reale Einhängung/Bestandsfelder/Dedup');
  }
  // Beide Adminstrecken behalten den alten P7-Platzhalter für Budget/Stufe.
  for(const call of [(n,a)=>rpc('/mcp/messages',n,a),(n,a)=>client.callTool({name:n,arguments:a})]){
    const r=decode(await call('admin',{action:'kontextprofil_setzen',project,ziel:prefix,hinweise_aus:['rv19-wire'],kontext_budget:100,agent_id:agents[0]}));
    assert.equal(r.status,'forbidden','Berechtigung bleibt erhalten');
  }
  console.log('P18-T29 STRECKEN PASS');
} catch (error) {
  console.error(error);process.exitCode=1;
} finally {
  stop?.();await client.close();await stdio.close();await rest.close();
  for(const table of ['ausloeser_hinweis_zustellungen','ausloeser_hinweis_aufrufe','agent_onboardings','agent_sessions','tool_calls'])await pool.query('DELETE FROM '+table+' WHERE '+(table==='agent_sessions'?'id':'agent_id')+'=ANY($1::text[])',[agents]);
  await pool.query("DELETE FROM ausloeser_hinweis_metriken WHERE project=$1 AND quelle_id='rv19-wire'",[project]);
  await core.closePool();
}
// Importierte Bestandsserver starten Hintergrunddienste; Assertions und Cleanup sind beendet.
process.exit(process.exitCode || 0);

