/** P10-T8: Dringliche Events über echte REST-/stdio-Hooks, nur synapse_test. */
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
const {emitEvent} = await import('../../core/dist/services/events.js');
const pool = getPool(), prefix = 'sol-3-escalation-' + randomUUID(), projects = [];
const failures = [];
function check(label, actual, expected) {
  try { assert.deepEqual(actual, expected, label); }
  catch (error) { failures.push(error.message); }
}
const app = Fastify({logger: false});
const client = new Client({name: 'event-escalation-test', version: '1.0.0'});
const env = Object.fromEntries(Object.entries(process.env).filter(([,v]) => typeof v === 'string'));
env.SYNAPSE_DATABASE_URL = env.DATABASE_URL;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../../mcp-server/dist/index.js', import.meta.url))],
  env, stderr: 'pipe',
});
transport.stderr?.resume();
function parse(response) {
  assert(!response.isError);
  const result = JSON.parse(response.content.find(c => c.type === 'text').text);
  assert.notEqual(result.success, false, JSON.stringify(result));
  return result;
}
const rest = async (name, args) => {
  const response = await app.inject({method: 'POST', url: '/', payload: {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {name, arguments: args},
  }});
  assert.equal(response.statusCode, 200);
  return parse(response.json().result);
};
const stdio = async (name, args) => parse(await client.callTool({name, arguments: args}));
const messages = async project => (await pool.query(
  "SELECT content FROM chat_messages WHERE project=$1 AND sender_id='system' AND recipient_id='koordinator' ORDER BY id", [project])).rows;
try {
  await app.register(mcpRoutes);
  await app.ready();
  await client.connect(transport);
  for (const [index, call] of [rest, stdio].entries()) {
    const label = index === 0 ? 'REST' : 'stdio';
    const project = prefix + '-' + label, other = project + '-other', agent = project + '-agent';
    projects.push(project, other);
    const hint = p => call('channel', {action: 'list', project: p, agent_id: agent});
    const ack = id => call('event', {action: 'ack', project, agent_id: agent, event_id: Number(id)});
    const emit = (p, priority) => emitEvent(p, 'ANNOUNCEMENT', priority, 'agent:' + agent, 'test', 'P10-T8 Test', true);
    const normal = await emit(project, 'normal');
    const normalResponse = await hint(project);
    // Golden des Altstands: exakt die normalen Event-Felder, IDs allein laufzeitabhängig.
    check(label + ' normal Golden', normalResponse.pending_events, [{
      event_id: normal.id, event_type: 'ANNOUNCEMENT',
      summary: 'ANNOUNCEMENT von test wartet — Ack erforderlich',
    }]);
    check(label + ' normal ohne Warnung', normalResponse.event_warning, undefined);
    await ack(normal.id);
    const urgent = await emit(project, 'high'), otherUrgent = await emit(other, 'critical');
    for (let i = 0; i < 2; i++) {
      const response = await hint(project);
      check(label + ' dringliches Event sichtbar', String(response.pending_events?.[0]?.event_id), String(urgent.id));
      check(label + ' Warnung high', /⚠️.*high/.test(response.event_warning ?? ''), true);
      await hint(other);
    }
    check(label + ' vor drei Calls keine DM', await messages(project), []);
    check(label + ' Projekttrennung vor drei Calls', await messages(other), []);
    // Ein anderes ACK darf die bereits zweimal ignorierte Warnung nicht zurücksetzen.
    const unrelated = await emit(project, 'normal');
    await ack(unrelated.id);
    await call('event', {action: 'pending', project, agent_id: agent});
    await hint(project);
    check(label + ' dritter schneller Call eskaliert', (await messages(project)).length, 1);
    check(label + ' anderes Projekt noch nicht eskaliert', (await messages(other)).length, 0);
    const criticalResponse = await hint(other);
    check(label + ' Warnung critical', /⚠️.*critical/.test(criticalResponse.event_warning ?? ''), true);
    check(label + ' eigenes drittes Ereignis', (await messages(other)).length, 1);
    await Promise.all(Array.from({length: 4}, () => hint(project)));
    check(label + ' keine wiederholten DMs', (await messages(project)).length, 1);
    const dm = (await messages(project))[0]?.content ?? '';
    check(label + ' DM nennt Agent/Event', dm.includes(agent) && dm.includes(String(urgent.id)), true);
    await ack(urgent.id);
    const empty = await hint(project);
    check(label + ' nach ACK keine Warnung', empty.event_warning, undefined);
    check(label + ' nach ACK kein Eventhinweis', empty.pending_events, undefined);
    const fresh = await emit(project, 'critical');
    await hint(project);
    await hint(project);
    check(label + ' neues Event beginnt bei eins', (await messages(project)).length, 1);
    await hint(project);
    check(label + ' neues Event eskaliert nach drei', (await messages(project)).length, 2);
    await ack(fresh.id);
    await call('event', {action: 'ack', project: other, agent_id: agent, event_id: Number(otherUrgent.id)});
    await hint(project);
    await hint(other);
    console.log(label + ': Lifecycle, Golden, Zähler und Projekttrennung geprüft');
  }
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log('PASS P10-T8: beide Transporte, Eskalation nach drei Calls, einmalig und getrennt');
} finally {
  await client.close();
  await app.close();
  await pool.query('DELETE FROM agent_event_acks WHERE event_id IN (SELECT id FROM agent_events WHERE project=ANY($1::text[]))', [projects]);
  for (const table of ['agent_events','chat_messages','tool_calls','agent_onboardings','agent_sessions']) {
    await pool.query('DELETE FROM ' + table + ' WHERE project=ANY($1::text[])', [projects]);
  }
  await pool.end();
}
