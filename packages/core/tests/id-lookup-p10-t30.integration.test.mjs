import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur synapse_test verwenden');
assert.equal(dbUrl.port, '5433', 'nur Test-DB-Port verwenden');

const core = await import('../dist/index.js');
const { closePool } = await import('../dist/db/client.js');
const rest = await import('../../rest-api/dist/routes/mcp.js');
const mcpPfad = '../../mcp-server/dist/tools/consolidated/';
const suffix = randomUUID();
const project = 'p10-t30-id-lookup-' + suffix;
const agentId = 'p10-t30-agent-' + suffix;
const andererAgent = 'p10-t30-other-' + suffix;
const toolNames = ['memory', 'docs', 'channel', 'event', 'chat', 'jev'];
const tools = {};
for (const name of toolNames) {
  const mod = await import(mcpPfad + name + '.js');
  tools[name] = Object.values(mod).find((v) => v && v.definition?.name === name);
  assert.ok(tools[name]?.handler, 'MCP-Tool ' + name + ' geladen');
}
const pool = core.getPool();
const decodeChannel = (result) => JSON.parse(result.content[0].text);

let seeded = false;
try {
  await core.ensureSchema();

  seeded = true;
  const memoryId = randomUUID();
  const docId = randomUUID();
  await pool.query(
    'INSERT INTO memories (id, project, name, category, content, tags) VALUES ($1, $2, $3, $4, $5, $6)',
    [memoryId, project, 'id-fixture-memory', 'note', 'fixture memory content', []],
  );
  await pool.query(
    'INSERT INTO tech_docs (id, project, framework, version, section, content, type, source, content_hash) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [docId, project, 'p10-t30', '1', 'fixture', 'fixture doc content', 'feature', 'manual', suffix],
  );

  const { rows: channelRows } = await pool.query(
    'INSERT INTO specialist_channels (name, project, created_by) VALUES ($1, $2, $3) RETURNING id',
    ['p10-t30-' + suffix, project, agentId],
  );
  const { rows: channelMessageRows } = await pool.query(
    'INSERT INTO specialist_channel_messages (channel_id, sender, content) VALUES ($1, $2, $3) RETURNING id',
    [channelRows[0].id, agentId, 'fixture channel message'],
  );
  const { rows: eventRows } = await pool.query(
    "INSERT INTO agent_events (project, event_type, priority, scope, source_id, payload, requires_ack) VALUES ($1, 'ANNOUNCEMENT', 'normal', $2, $3, $4, true) RETURNING id",
    [project, 'agent:' + agentId, agentId, 'fixture event'],
  );
  await pool.query(
    'INSERT INTO agent_event_acks (event_id, agent_id, reaction) VALUES ($1, $2, $3)',
    [eventRows[0].id, agentId, 'ack fixture'],
  );
  const { rows: chatRows } = await pool.query(
    'INSERT INTO chat_messages (project, sender_id, recipient_id, content) VALUES ($1, $2, $3, $4) RETURNING id',
    [project, andererAgent, agentId, 'fixture DM'],
  );
  const { rows: hiddenChatRows } = await pool.query(
    'INSERT INTO chat_messages (project, sender_id, recipient_id, content) VALUES ($1, $2, $3, $4) RETURNING id',
    [project, andererAgent, andererAgent + '-recipient', 'not visible to current agent'],
  );
  const { rows: jevRows } = await pool.query(
    'INSERT INTO jev_entscheidungen (project, frage, typ, entschieden) VALUES ($1, $2, $3, true) RETURNING id',
    [project, 'fixture question', 'noul'],
  );
  await pool.query(
    'INSERT INTO jev_entscheidet (project, aktiv, seit, gesetzt_von) VALUES ($1, true, NOW(), $2) ON CONFLICT (project) DO UPDATE SET aktiv = true, seit = NOW()',
    [project, agentId],
  );

  const pruefe = async (name, args, lese) => {
    const stdioRaw = await tools[name].handler(args);
    const stdio = name === 'channel' ? decodeChannel(stdioRaw) : stdioRaw;
    const restAntwort = await rest.handleToolCall(name, args, agentId);
    assert.equal(lese(stdio), true, name + ': stdio liest die Fixture-ID');
    assert.equal(lese(restAntwort), true, name + ': REST liest dieselbe Fixture-ID');
    return { stdio, rest: restAntwort };
  };

  const memoryById = await pruefe('memory', { action: 'read', project, id: memoryId }, (r) => r.success && r.memory?.id === memoryId);
  assert.equal(memoryById.stdio.memory.name, 'id-fixture-memory');
  assert.equal(memoryById.rest.memory.name, 'id-fixture-memory');
  const memoryByPrefix = await tools.memory.handler({ action: 'read', project, id: memoryId.slice(0, 8) });
  assert.equal(memoryByPrefix.success, true, 'Memory-Praefix ab 8 Zeichen funktioniert');
  const memoryWrongProject = await tools.memory.handler({ action: 'read', project: project + '-other', id: memoryId });
  assert.equal(memoryWrongProject.success, false, 'Memory-ID bleibt projektgebunden');

  await pruefe('docs', { action: 'get', project, id: docId }, (r) => r.success && r.doc?.id === docId);
  await pruefe('channel', { action: 'get', project, message_id: channelMessageRows[0].id }, (r) => r.success && r.message?.id === channelMessageRows[0].id);
  await pruefe('event', { action: 'get', project, agent_id: agentId, event_id: eventRows[0].id }, (r) => r.success && r.event?.id === eventRows[0].id);
  await pruefe('chat', { action: 'get', project, agent_id: agentId, message_id: chatRows[0].id }, (r) => r.success && r.messages?.[0]?.id === chatRows[0].id);
  const hiddenChat = await tools.chat.handler({ action: 'get', project, agent_id: agentId, message_id: hiddenChatRows[0].id });
  assert.equal(hiddenChat.success, false, 'Chat-ID gibt keine fremde DM frei');
  const hiddenChatRest = await rest.handleToolCall('chat', { action: 'get', project, agent_id: agentId, message_id: hiddenChatRows[0].id }, agentId);
  assert.equal(hiddenChatRest.success, false, 'REST gibt keine fremde DM frei');
  await pruefe('jev', { action: 'protokoll', project, id: jevRows[0].id }, (r) => r.success && r.eintraege?.[0]?.id === jevRows[0].id);
  const ackEvent = await core.getProjectRecordById('event', project, eventRows[0].id, agentId);
  assert.equal(ackEvent?.id, eventRows[0].id, 'quittiertes Event bleibt per ID lesbar');
  console.log('P10-T30-GREEN: sechs ID-Arten ueber stdio und REST; Prefix, Projektgrenze und DM-Sichtbarkeit geprüft');
} finally {
  if (seeded) {
    await pool.query('DELETE FROM jev_entscheidet WHERE project = $1', [project]);
    await pool.query('DELETE FROM jev_entscheidungen WHERE project = $1', [project]);
    await pool.query('DELETE FROM chat_messages WHERE project = $1', [project]);
    await pool.query('DELETE FROM agent_events WHERE project = $1', [project]);
    await pool.query('DELETE FROM memories WHERE project = $1', [project]);
    await pool.query('DELETE FROM tech_docs WHERE project = $1', [project]);
    await pool.query('DELETE FROM specialist_channels WHERE project = $1', [project]);
  }
  await closePool();
}
process.exit(0);
