/** P10-T12 Nachtrag: Erstellen/Aktualisieren kommt aus dem atomaren Upsert. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(db.port,'5433');
assert.equal(db.pathname,'/synapse_test');
const schema = 'sol3_update_' + randomUUID().replaceAll('-','');
db.searchParams.set('options','-c search_path=' + schema + ',public');
process.env.DATABASE_URL = db.toString();
const {getPool} = await import('../../core/dist/db/client.js');
const {writeMemory} = await import('../../core/dist/services/memory.js');
const {writeMemory: writeTool} = await import('../../mcp-server/dist/tools/memory.js');
const {default: Fastify} = await import('../node_modules/fastify/fastify.js');
const {mcpRoutes} = await import('../dist/routes/mcp.js');
const {memoryRoutes} = await import('../dist/routes/memory.js');
const pool = getPool(), query = pool.query.bind(pool);
const project = 'sol-3-update-' + randomUUID();
let raceName, arrived = 0, release, barrier;
pool.query = async (sql, values, ...rest) => {
  if (sql.includes('FROM intern_schalter')) return {rows:[{aktiv:true,bis:null,gesetzt_am:new Date()}]};
  const result = await query(sql,values,...rest);
  if (sql.includes('FROM memories') && values?.[0] === project && values?.[1] === raceName && result.rows.length === 0) {
    // Fertige Reads treffen sich vor dem Write; keine offenen Transaktionen/Sperren.
    if (++arrived === 2) release();
    await barrier;
  }
  return result;
};
const app = Fastify({logger:false}), failures = [];
function check(label, actual, expected) {
  try { assert.deepEqual(actual,expected,label); } catch(error) { failures.push(error.message); }
}
async function mcp(name, content, bulk) {
  const args = {project,action:'write',...(bulk ? {items:[{name,content}]} : {name,content})};
  const response = await app.inject({method:'POST',url:'/',payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'memory',arguments:args}}});
  assert.equal(response.statusCode,200);
  const envelope = response.json().result;
  assert(!envelope.isError);
  const result = JSON.parse(envelope.content[0].text);
  assert.equal(result.success,true);
  return bulk ? result.results[0] : result;
}
try {
  await query('CREATE SCHEMA ' + schema);
  await query('CREATE TABLE memories (LIKE public.memories INCLUDING ALL)');
  await query('CREATE UNIQUE INDEX ON memories(project,name)');
  await app.register(mcpRoutes);
  await app.register(memoryRoutes);
  await app.ready();
  const cases = [
    ['core',(name,content) => writeMemory(project,name,content)],
    ['stdio-tool',async (name,content) => {
      const message = await writeTool(project,name,content);
      assert(!message.startsWith('❌'),message);
      return {isUpdate:message.includes('aktualisiert'),message};
    }],
    ['rest',async (name,content) => {
      const response = await app.inject({method:'POST',url:'/api/projects/' + project + '/memories',payload:{memoryName:name,content}});
      assert.equal(response.statusCode,200);
      return response.json();
    }],
    ['mcp',(name,content) => mcp(name,content,false)],
    ['mcp-bulk',(name,content) => mcp(name,content,true)],
  ];
  for (const [label,write] of cases) {
    raceName = label;
    arrived = 0;
    barrier = new Promise(resolve => release = resolve);
    const results = await Promise.all([write(label,'A'),write(label,'B')]);
    check(label + ' exakt ein Insert und ein Update',results.map(r => r.isUpdate).sort(),[false,true]);
    for (const result of results) {
      if (result.message) check(label + ' Meldung passt zum Status',result.message.includes(result.isUpdate ? 'aktualisiert' : 'erstellt'),true);
    }
    const rows = (await query('SELECT id,created_at FROM memories WHERE project=$1 AND name=$2',[project,label])).rows;
    assert.equal(rows.length,1);
    const again = await write(label,'C');
    check(label + ' weiterer Write ist Update',again.isUpdate,true);
    const after = (await query('SELECT id,created_at FROM memories WHERE project=$1 AND name=$2',[project,label])).rows;
    assert.deepEqual(after,rows,'Identität/Erstellung bleiben stabil');
    console.log('geprüft:',label);
  }
  assert.deepEqual(failures,[],failures.join('\n'));
  console.log('PASS P10-T12 isUpdate: Core und vier Antwortwege');
} finally {
  await app.close();
  pool.query = query;
  await query('DROP SCHEMA ' + schema + ' CASCADE');
  await pool.end();
}
