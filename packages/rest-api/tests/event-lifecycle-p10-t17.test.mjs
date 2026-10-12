/** P10-T17: Event-Lifecycle über REST und stdio; ausschließlich synapse_test. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const db = new URL(process.env.DATABASE_URL ?? 'http://invalid');
assert.equal(db.port, '5433');
assert.equal(db.pathname, '/synapse_test');
const {default: Fastify} = await import('../node_modules/fastify/fastify.js');
const {mcpRoutes} = await import('../dist/routes/mcp.js');
const {Client} = await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
const {StdioClientTransport} = await import('../../mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js');
const {getPool} = await import('../../core/dist/db/client.js');
const pool = getPool();
const prefix = 'sol-3-lifecycle-' + randomUUID();
const projects = [prefix + '-rest', prefix + '-stdio'];
const app = Fastify({logger: false});
const client = new Client({name: 'event-lifecycle-test', version: '1.0.0'});
const env = Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === 'string'));
env.SYNAPSE_DATABASE_URL = env.DATABASE_URL;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../../mcp-server/dist/index.js', import.meta.url))],
  env, stderr: 'pipe',
});
transport.stderr?.resume();
function parse(response) {
  assert(!response.isError, 'Kein Transport-/Toolfehler');
  const result = JSON.parse(response.content.find(c => c.type === 'text').text);
  assert.notEqual(result.success, false, JSON.stringify(result));
  return result;
}
const rest = async args => {
  const response = await app.inject({method: 'POST', url: '/', payload: {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name: 'event', arguments: args},
  }});
  assert.equal(response.statusCode, 200);
  return parse(response.json().result);
};
const stdio = async args => parse(await client.callTool({name: 'event', arguments: args}));
try {
  await app.register(mcpRoutes);
  await app.ready();
  await client.connect(transport);
  for (const [index, call] of [rest, stdio].entries()) {
    const project = projects[index], agent = project + '-agent';
    const base = {project, agent_id: agent};
    assert.deepEqual((await call({...base, action: 'pending'})).events, []);
    for (const scope of ['agent:' + agent, 'all']) {
      const emitted = await call({...base, action: 'emit', source_id: agent,
        event_type: 'ANNOUNCEMENT', priority: 'normal', scope, requires_ack: true, payload: 'P10-T17 Test'});
      const id = emitted.event?.id ?? emitted.id;
      assert(id, 'emit muss eine Event-ID liefern');
      const pending = (await call({...base, action: 'pending'})).events;
      assert.equal(pending.length, 1, 'Positivkontrolle: emittiertes Event sichtbar');
      assert.equal(String(pending[0].id), String(id));
      assert.equal(pending[0].eventType, 'ANNOUNCEMENT');
      assert.equal(pending[0].scope, scope);
      const ack = await call({...base, action: 'ack', event_id: Number(id), reaction: 'Lifecycle geprüft'});
      assert.equal(String(ack.ack?.eventId ?? ack.eventId), String(id));
      assert.deepEqual((await call({...base, action: 'pending'})).events, [], 'ACK entfernt Event aus pending');
      assert.deepEqual((await pool.query('SELECT agent_id,reaction FROM agent_event_acks WHERE event_id=$1', [id])).rows,
        [{agent_id: agent, reaction: 'Lifecycle geprüft'}]);
      console.log('OK ' + (index === 0 ? 'REST' : 'stdio') + ' ' + (scope === 'all' ? 'Broadcast' : 'direkt') + ': emit → sichtbar → ACK → leer');
    }
  }
  console.log('PASS P10-T17: vier Event-Lifecycles über beide Tooltransporte');
} finally {
  await client.close();
  await app.close();
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=ANY($1::text[]))', [projects]);
  for (const table of ['agent_events','tool_calls','agent_onboardings','agent_sessions']) {
    await pool.query('DELETE FROM ' + table + ' WHERE project=ANY($1::text[])', [projects]);
  }
  await pool.end();
}
