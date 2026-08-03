import assert from 'node:assert/strict'
import Fastify from '../packages/rest-api/node_modules/fastify/fastify.js'
import { Client } from '../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import {
  acknowledgeEvent, closePool, emitEvent, getPendingEvents,
} from '../packages/core/dist/index.js'
import { mcpRoutes } from '../packages/rest-api/dist/routes/mcp.js'

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const project = `ce7-hooks-${suffix}`
const source = `ce7-source-${'x'.repeat(140)}`
const seeded = []
let client

function parseToolResult(result) {
  const text = result?.content?.find((part) => part.type === 'text')?.text
  assert.equal(typeof text, 'string')
  return { parsed: JSON.parse(text), text }
}

async function seed(agent) {
  const specs = [
    ['ANNOUNCEMENT', 'normal'],
    ['TEAM_DISCUSSION', 'high'],
    ['WORK_STOP', 'critical'],
    ['ARCH_DECISION', 'normal'],
  ]
  const events = []
  for (const [eventType, priority] of specs) {
    const event = await emitEvent(
      project, eventType, priority, `agent:${agent}`, source,
      JSON.stringify({ secret_payload: 'P'.repeat(500), ordinal: events.length }),
      true,
    )
    seeded.push([event.id, agent])
    events.push(event)
  }
  return events
}

async function callRest(app, url, name, args, headers = {}) {
  const response = await app.inject({
    method: 'POST',
    url,
    headers,
    payload: {
      jsonrpc: '2.0',
      id: Math.random(),
      method: 'tools/call',
      params: { name, arguments: args },
    },
  })
  assert.equal(response.statusCode, 200)
  return parseToolResult(response.json().result)
}

function assertCompact(actual, expectedIds) {
  assert.equal(actual.length, 3)
  assert.deepEqual(actual.map((event) => event.event_id), expectedIds)
  for (const event of actual) {
    assert.deepEqual(Object.keys(event).sort(), ['event_id', 'event_type', 'summary'])
    assert.ok(Array.from(event.summary).length <= 80)
    assert.equal('payload' in event, false)
  }
}

function legacyBytes(events, agent) {
  const mapped = events.map((event) => ({
    id: event.id,
    eventType: event.eventType,
    priority: event.priority,
    payload: event.payload,
  }))
  const hint = events.map((event) => {
    if (event.priority === 'critical') {
      return `⛔ PFLICHT-EVENT: ${event.eventType} von ${event.sourceId}: ${event.payload}. Reagiere SOFORT mit event(action: "ack", event_id: ${event.id}, agent_id: "${agent}")`
    }
    if (event.priority === 'high') {
      return `⚠️ EVENT: ${event.eventType} von ${event.sourceId}: ${event.payload}. Bitte mit event(action: "ack", event_id: ${event.id}, agent_id: "${agent}") bestaetigen.`
    }
    return `📋 EVENT: ${event.eventType}: ${event.payload}. event(action: "ack", event_id: ${event.id}, agent_id: "${agent}")`
  }).join('\n')
  return Buffer.byteLength(JSON.stringify({
    pendingEvents: { count: events.length, events: mapped, hint },
  }, null, 2))
}

const app = Fastify({ logger: false })
await app.register(mcpRoutes)
await app.ready()

try {
  const restAgent = `ce7-rest-${suffix}`
  const restArgs = { action: 'list', project, agent_id: restAgent }
  await callRest(app, '/', 'channel', restArgs)
  const restBefore = await callRest(app, '/', 'channel', restArgs)
  assert.equal(restBefore.parsed.pending_events, undefined)

  const restEvents = await seed(restAgent)
  const expectedIds = [restEvents[2].id, restEvents[1].id, restEvents[0].id]
  const restAfter = await callRest(app, '/', 'channel', restArgs)
  assertCompact(restAfter.parsed.pending_events, expectedIds)
  const restRepeat = await callRest(app, '/', 'channel', restArgs)
  assertCompact(restRepeat.parsed.pending_events, expectedIds)

  const eventFull = await callRest(app, '/', 'event', {
    action: 'pending', project, agent_id: restAgent,
  })
  assert.equal(eventFull.parsed.pending_events, undefined)
  assert.equal(eventFull.parsed.events.length, 4)

  const guide = await callRest(app, '/', 'guide', {
    tool_name: 'files', project, agent_id: restAgent,
  })
  assert.equal(guide.parsed.pending_events, undefined)

  const rawArray = await callRest(app, '/', 'thought', {
    // Use the indexed project so this exercises the successful raw-array path;
    // the synthetic project intentionally has no Qdrant collection.
    action: 'search', project: 'synapse', query: 'ce7-kein-treffer', agent_id: restAgent,
  })
  assert.ok(Array.isArray(rawArray.parsed))

  const rows = await getPendingEvents(project, restAgent)
  const oldBytes = legacyBytes(rows, restAgent)
  const compactBytes = Buffer.byteLength(JSON.stringify({
    pending_events: restAfter.parsed.pending_events,
  }, null, 2))
  const responseDelta = Buffer.byteLength(restAfter.text) - Buffer.byteLength(restBefore.text)
  assert.ok(compactBytes < oldBytes)
  assert.ok(responseDelta > 0 && responseDelta < 768)

  const messagesAgent = `ce7-messages-${suffix}`
  const messagesEvents = await seed(messagesAgent)
  const messagesResult = await callRest(app, '/mcp/messages', 'channel', {
    action: 'list', project, agent_id: messagesAgent,
  })
  assertCompact(
    messagesResult.parsed.pending_events,
    [messagesEvents[2].id, messagesEvents[1].id, messagesEvents[0].id],
  )

  const derivedAgent = 'gpt-abcdef12'
  const derivedEvents = await seed(derivedAgent)
  const derivedResult = await callRest(
    app,
    '/',
    'channel',
    { action: 'list', project },
    { 'user-agent': 'openai-mcp/test', 'x-openai-session': 'v1/abcdef12-session' },
  )
  assertCompact(
    derivedResult.parsed.pending_events,
    [derivedEvents[2].id, derivedEvents[1].id, derivedEvents[0].id],
  )

  const stdioAgent = `ce7-stdio-${suffix}`
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/mcp-server/dist/index.js'],
    cwd: process.cwd(),
    stderr: 'inherit',
  })
  client = new Client({ name: 'ce7-integration', version: '1.0.0' })
  await client.connect(transport)
  const stdioArgs = { action: 'list', project, agent_id: stdioAgent }
  parseToolResult(await client.callTool({ name: 'channel', arguments: stdioArgs }))
  const stdioBefore = parseToolResult(await client.callTool({
    name: 'channel', arguments: stdioArgs,
  }))
  const stdioEvents = await seed(stdioAgent)
  const stdioAfter = parseToolResult(await client.callTool({
    name: 'channel', arguments: stdioArgs,
  }))
  assertCompact(
    stdioAfter.parsed.pending_events,
    [stdioEvents[2].id, stdioEvents[1].id, stdioEvents[0].id],
  )
  const stdioDelta = Buffer.byteLength(stdioAfter.text) - Buffer.byteLength(stdioBefore.text)
  assert.ok(stdioDelta > 0 && stdioDelta < 768)

  for (const [eventId, agent] of seeded) {
    await acknowledgeEvent(eventId, agent, 'CE-7 Integrationstest Cleanup')
  }
  seeded.length = 0
  const restCleared = await callRest(app, '/', 'channel', restArgs)
  assert.equal(restCleared.parsed.pending_events, undefined)

  console.error(JSON.stringify({
    ce7: 'OK',
    max_events: 3,
    max_summary_chars: 80,
    rest_before_bytes: Buffer.byteLength(restBefore.text),
    rest_after_bytes: Buffer.byteLength(restAfter.text),
    rest_delta_bytes: responseDelta,
    legacy_pending_bytes: oldBytes,
    compact_pending_bytes: compactBytes,
    stdio_delta_bytes: stdioDelta,
  }))
} finally {
  for (const [eventId, agent] of seeded) {
    try { await acknowledgeEvent(eventId, agent, 'CE-7 Integrationstest Cleanup') } catch {}
  }
  if (client) await client.close()
  await app.close()
  await closePool()
}
process.exit(0)
