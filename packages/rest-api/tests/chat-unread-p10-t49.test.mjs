/** P10-T49: Chat-Lesestand ist PG-persistent; echte REST-/stdio-Antworten. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(db.port,'5433'); assert.equal(db.pathname,'/synapse_test');
const schema = 'sol3_chat_' + randomUUID().replaceAll('-','');
db.searchParams.set('options','-c search_path=' + schema + ',public');
process.env.DATABASE_URL = db.toString();
const {getPool} = await import('../../core/dist/db/client.js');
const {getMessages} = await import('../../core/dist/services/chat.js');
const {default:Fastify} = await import('../node_modules/fastify/fastify.js');
const {mcpRoutes} = await import('../dist/routes/mcp.js');
const {Client} = await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {StdioClientTransport} = await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const pool = getPool(), app = Fastify({logger:false}), failures = [];
const prefix = 'sol-3-chat-' + randomUUID(), agent = prefix + '-a', sender = prefix + '-s', other = prefix + '-b';
let client;
function check(label,actual,expected) {
  try { assert.deepEqual(actual,expected,label); } catch(error) { failures.push(error.message); }
}
function parse(response) {
  assert(!response.isError);
  const result = JSON.parse(response.content.find(c=>c.type==='text').text);
  assert.notEqual(result.success,false,JSON.stringify(result));
  return result;
}
async function rest(args) {
  const r = await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'chat',arguments:args}}});
  assert.equal(r.statusCode,200); return parse(r.json().result);
}
async function restart() {
  await client?.close();
  client = new Client({name:'chat-read-test',version:'1'});
  const env = {...process.env,DATABASE_URL:db.toString(),SYNAPSE_DATABASE_URL:db.toString()};
  delete env.SYNAPSE_AGENT_NAME;
  const transport = new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../../mcp-server/dist/index.js',import.meta.url))],env,stderr:'pipe'});
  transport.stderr?.resume();
  await client.connect(transport);
}
const stdio = async args => parse(await client.callTool({name:'chat',arguments:args}));
const shape = r => r.unreadChat ? {broadcasts:r.unreadChat.broadcasts,dms:r.unreadChat.dms} : null;
const mark = async project => (await pool.query('SELECT letzte_id::text FROM chat_lesestand WHERE project=$1 AND agent_id=$2',[project,agent])).rows[0]?.letzte_id;
try {
  await pool.query('CREATE SCHEMA ' + schema);
  await pool.query('CREATE TABLE chat_messages (LIKE public.chat_messages INCLUDING ALL)');
  const source = await readFile(new URL('../../core/src/db/schema.ts',import.meta.url),'utf8');
  const ddl = source.match(/CREATE TABLE IF NOT EXISTS chat_lesestand \([\s\S]*?\);/)?.[0];
  check('Laufzeitschema enthält Lesestand',!!ddl,true);
  await pool.query(ddl ?? 'CREATE TABLE chat_lesestand(project text,agent_id text,letzte_id bigint NOT NULL DEFAULT 0,updated_at timestamptz DEFAULT now(),PRIMARY KEY(project,agent_id))');
  await app.register(mcpRoutes); await app.ready(); await restart();
  for (const [name,call] of [['rest',rest],['stdio',stdio]]) {
    const project = prefix + '-' + name, base = {project,agent_id:agent};
    await pool.query(`INSERT INTO chat_messages(project,sender_id,recipient_id,content,timestamp) VALUES
      ($1,$2,NULL,'broadcast',now()),($1,$2,$3,'dm',now()),
      ($1,$2,$4,'fremd',now()),($1,$3,NULL,'eigen',now())`,[project,sender,agent,other]);
    const expected = {broadcasts:1,dms:[{from:sender,count:1}]};
    const first = await call({...base,action:'list'});
    check(name+' Hinweis',shape(first),expected);
    if(first.unreadChat) assert.equal(typeof first.unreadChat.hint,'string');
    check(name+' wiederholen zählt ohne Lesen',shape(await call({...base,action:'list'})),expected);
    check(name+' kein Lesestand durch Hinweis',await mark(project),undefined);
    const read = await call({...base,action:'get'});
    assert.equal(read.messages.length,3,'echter Read liefert Broadcast, eigene Nachricht und eigene DM');
    assert(!read.messages.some(m=>m.content==='fremd'));
    check(name+' nach Get leer',shape(await call({...base,action:'list'})),null);
    const saved = await mark(project);
    check(name+' PG-Lesestand vorhanden',saved!==undefined,true);
    await restart();
    check(name+' neuer Prozess kennt Lesestand',shape(await stdio({...base,action:'list'})),null);
    check(name+' fremder Agent eigener Stand',shape(await rest({project,agent_id:other,action:'list'})),
      {broadcasts:2,dms:[{from:sender,count:1}]});
    // Mehr als altes 50er Hint-Limit; Teilabruf darf den Rest nicht als gelesen markieren.
    const ids = (await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content) SELECT $1,$2,$3,'mehr' FROM generate_series(1,60) RETURNING id",[project,sender,agent])).rows;
    check(name+' vollständige Zählung',shape(await rest({...base,action:'list'})),{broadcasts:0,dms:[{from:sender,count:60}]});
    await call({...base,action:'get',limit:5});
    check(name+' Teilabruf lässt Rest offen',shape(await rest({...base,action:'list'})),{broadcasts:0,dms:[{from:sender,count:58}]});
    await Promise.all([getMessages(project,{agentId:agent,limit:100}),getMessages(project,{agentId:agent,limit:1})]);
    check(name+' parallele Leser monoton',await mark(project),String(ids.at(-1).id));
    await getMessages(project,{agentId:agent,limit:1});
    check(name+' älterer Abruf senkt Stand nicht',await mark(project),String(ids.at(-1).id));
    const direct = (await pool.query("INSERT INTO chat_messages(project,sender_id,recipient_id,content) VALUES($1,$2,$3,'direkt') RETURNING id",[project,sender,agent])).rows[0];
    const one = await call({...base,action:'get',message_id:direct.id});
    check(name+' ID-Read liefert nur angeforderte Nachricht',one.messages.map(m=>Number(m.id)),[direct.id]);
    check(name+' ID-Read schreibt Stand fort',await mark(project),String(direct.id));
    check(name+' ID-Read leert Hinweis',shape(await rest({...base,action:'list'})),null);
    console.log('geprüft',name);
  }
  assert.deepEqual(failures,[],failures.join('\n'));
  console.log('PASS P10-T49: REST/stdio, PG-Stand, Neustart, Monotonie und Empfängertrennung');
} finally {
  await client?.close(); await app.close();
  for (const table of ['tool_calls','agent_onboardings','agent_sessions']) {
    await pool.query('DELETE FROM '+table+' WHERE project=ANY($1::text[])',[[prefix+'-rest',prefix+'-stdio']]);
  }
  await pool.query('DROP SCHEMA '+schema+' CASCADE'); await pool.end();
}
