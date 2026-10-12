/** P10-T16: Chat-Lifecycle über echte REST-/stdio-Dispatcher, nur synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const db=new URL(process.env.DATABASE_URL??'http://invalid');
assert.equal(db.port,'5433'); assert.equal(db.pathname,'/synapse_test');
const schema='sol3_chat_lifecycle_'+randomUUID().replaceAll('-','');
db.searchParams.set('options','-c search_path='+schema+',public');
process.env.DATABASE_URL=db.toString();
const {getPool}=await import('../../core/dist/db/client.js');
const {default:Fastify}=await import('../node_modules/fastify/fastify.js');
const {mcpRoutes}=await import('../dist/routes/mcp.js');
const {Client}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {StdioClientTransport}=await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const pool=getPool(),app=Fastify({logger:false});
const prefix='sol-3-chat-lifecycle-'+randomUUID();
const projects=[prefix+'-rest',prefix+'-stdio'];
let client;

function parse(response) {
  assert(!response.isError,JSON.stringify(response));
  const result=JSON.parse(response.content.find(c=>c.type==='text').text);
  assert.notEqual(result.success,false,JSON.stringify(result));
  return result;
}
async function rest(args) {
  const response=await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'chat',arguments:args}}});
  assert.equal(response.statusCode,200);
  return parse(response.json().result);
}
const stdio=async args=>parse(await client.callTool({name:'chat',arguments:args}));
try {
  assert.equal((await pool.query('SELECT current_database() AS db')).rows[0].db,'synapse_test');
  await pool.query('CREATE SCHEMA '+schema);
  for(const table of ['chat_messages','agent_sessions']) {
    await pool.query('CREATE TABLE '+table+' (LIKE public.'+table+' INCLUDING ALL)');
  }
  await pool.query('CREATE TABLE chat_lesestand(project text,agent_id text,letzte_id bigint NOT NULL DEFAULT 0,updated_at timestamptz DEFAULT now(),PRIMARY KEY(project,agent_id))');
  await app.register(mcpRoutes); await app.ready();
  const env={...process.env,DATABASE_URL:db.toString(),SYNAPSE_DATABASE_URL:db.toString()};
  delete env.SYNAPSE_AGENT_NAME;
  client=new Client({name:'chat-lifecycle-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../mcp-server/dist/index.js',import.meta.url))],env,stderr:'pipe'});
  transport.stderr?.resume(); await client.connect(transport);

  for(const [name,wireCall] of [['rest',rest],['stdio',stdio]]) {
    // Bestehende Verträge: REST register/send flach, stdio mit session/message.
    const call=async args=>{
      const result=await wireCall(args);
      if(name==='rest'&&args.action==='register')return {...result,session:result};
      if(name==='rest'&&args.action==='send')return {...result,message:result};
      return result;
    };
    const project=prefix+'-'+name,control=project+'-control',sender=project+'-sender',recipient=project+'-recipient',other=project+'-other';
    const base={project,agent_id:control};
    for(const id of [sender,recipient,other]) {
      const registered=await call({...base,action:'register',id,cutoff_date:'2026-01-01'});
      assert.equal(registered.session.id,id);
      assert.equal(registered.session.project,project);
    }
    const active=await call({...base,action:'list'});
    for(const id of [sender,recipient,other])assert(active.agents.some(a=>a.id===id),'registrierter Agent sichtbar: '+id);
    const foreign=await call({project:prefix+'-'+(name==='rest'?'stdio':'rest'),agent_id:control,action:'list'});
    assert(!foreign.agents.some(a=>[sender,recipient,other].includes(a.id)),'Agentenliste bleibt projektgebunden');

    const broadcast=await call({...base,action:'send',sender_id:sender,content:'broadcast-'+name});
    const dm=await call({...base,action:'send',sender_id:sender,recipient_id:recipient,content:'dm-'+name});
    const foreignDm=await call({...base,action:'send',sender_id:sender,recipient_id:other,content:'foreign-'+name});
    for(const sent of [broadcast,dm,foreignDm])assert(Number.isInteger(sent.message.id));
    const messages=(await call({project,agent_id:recipient,action:'get'})).messages;
    assert.deepEqual(messages.map(m=>m.id),[broadcast.message.id,dm.message.id],'Empfänger bekommt Broadcast und eigene DM');
    assert.deepEqual(messages.map(m=>m.content),['broadcast-'+name,'dm-'+name]);
    assert.equal(messages[0].recipientId,null);
    assert.equal(messages[1].recipientId,recipient);
    assert(messages.every(m=>m.senderId===sender));
    const others=(await call({project,agent_id:other,action:'get'})).messages;
    assert.deepEqual(others.map(m=>m.id),[broadcast.message.id,foreignDm.message.id],'fremde DM bleibt getrennt');
    const otherProject=await call({project:prefix+'-'+(name==='rest'?'stdio':'rest'),agent_id:recipient,action:'get'});
    assert(!otherProject.messages.some(m=>[broadcast.message.id,dm.message.id,foreignDm.message.id].includes(m.id)),'keine Nachrichten aus fremdem Projekt');

    await call({...base,action:'unregister',id:recipient});
    const after=await call({...base,action:'list'});
    assert(!after.agents.some(a=>a.id===recipient),'abgemeldeter Agent fehlt in aktiver Liste');
    assert(after.agents.some(a=>a.id===sender),'Positivkontrolle: anderer aktiver Agent bleibt sichtbar');
    assert.equal((await pool.query('SELECT status FROM agent_sessions WHERE id=$1',[recipient])).rows[0].status,'inactive');
    assert.equal(Number((await pool.query('SELECT COUNT(*) FROM chat_messages WHERE project=$1',[project])).rows[0].count),3,'Abmeldung löscht keine Nachrichten');
    for(const id of [sender,other])await call({...base,action:'unregister',id});
    console.log('PASS P10-T16',name,'register/send Broadcast+DM/get/list/unregister; Empfänger- und Projekttrennung');
  }
} finally {
  await client?.close(); await app.close();
  for(const table of ['tool_calls','agent_onboardings']) {
    await pool.query('DELETE FROM '+table+' WHERE project=ANY($1::text[])',[projects]);
  }
  await pool.query('DROP SCHEMA '+schema+' CASCADE'); await pool.end();
}
