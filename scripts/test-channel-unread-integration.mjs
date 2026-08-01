import assert from 'node:assert/strict'
import Fastify from '../packages/rest-api/node_modules/fastify/fastify.js'
import { Client } from '../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../packages/mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'
import {
  claimUnreadChannelHints, closePool, createChannel, deleteChannel,
  joinChannel, postChannelMessage,
} from '../packages/core/dist/index.js'
import { mcpRoutes } from '../packages/rest-api/dist/routes/mcp.js'

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`
const project = `hook5-transport-${suffix}`
const channel = `hook5-${suffix}`
const sender = `hook5-sender-${suffix}`
const restAgent = `hook5-rest-${suffix}`
const stdioAgent = `hook5-stdio-${suffix}`
const anonymousAgent = `hook5-anon-${suffix}`

async function boundedCleanup(label, action) {
  await Promise.race([
    action(),
    new Promise((resolve) => setTimeout(() => {
      console.error(`HOOK-5 Cleanup-Timeout: ${label}`)
      resolve()
    }, 2_000)),
  ])
}

function parseToolText(result) {
  const text = result?.content?.find((part) => part.type === 'text')?.text
  assert.equal(typeof text, 'string')
  return JSON.parse(text)
}

async function seed(agent) {
  assert.equal(await joinChannel(project, channel, agent), true)
  await postChannelMessage(project, channel, sender, `ungelesen fuer ${agent}`)
}

async function callRest(app, agentId) {
  const arguments_ = { tool_name: 'files' }
  if (agentId !== undefined) arguments_.agent_id = agentId
  const response = await app.inject({
    method: 'POST',
    url: '/',
    payload: {
      jsonrpc: '2.0', id: Math.random(), method: 'tools/call',
      params: { name: 'guide', arguments: arguments_ },
    },
  })
  assert.equal(response.statusCode, 200)
  return parseToolText(response.json().result)
}

await createChannel(project, channel, 'HOOK-5 Transporttest', sender)
const app = Fastify({ logger: false })
await app.register(mcpRoutes)
await app.ready()

let client
try {
  await seed(restAgent)
  const restFirst = await callRest(app, restAgent)
  assert.equal(restFirst.unread_channels?.[0]?.channel, channel)
  assert.equal(restFirst.unread_channels?.[0]?.count, 1)
  const restSecond = await callRest(app, restAgent)
  assert.equal(restSecond.unread_channels, undefined)

  await seed(anonymousAgent)
  const restAnonymous = await callRest(app, undefined)
  assert.equal(restAnonymous.unread_channels, undefined)
  const anonymousStillUnread = await claimUnreadChannelHints(anonymousAgent)
  assert.equal(anonymousStillUnread.length, 1)

  await seed(stdioAgent)
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['packages/mcp-server/dist/index.js'],
    cwd: process.cwd(),
    stderr: 'inherit',
  })
  client = new Client({ name: 'hook5-integration', version: '1.0.0' })
  await client.connect(transport)
  const stdioFirst = parseToolText(await client.callTool({
    name: 'guide', arguments: { tool_name: 'files', agent_id: stdioAgent },
  }))
  assert.equal(stdioFirst.unread_channels?.[0]?.channel, channel)
  assert.equal(stdioFirst.unread_channels?.[0]?.count, 1)
  const stdioSecond = parseToolText(await client.callTool({
    name: 'guide', arguments: { tool_name: 'files', agent_id: stdioAgent },
  }))
  assert.equal(stdioSecond.unread_channels, undefined)

  console.error('HOOK-5 REST+stdio transport integration: OK')
} finally {
  if (client) await boundedCleanup('stdio client', () => client.close())
  await boundedCleanup('Fastify', () => app.close())
  await boundedCleanup('Testchannel', () => deleteChannel(project, channel))
  await boundedCleanup('Core-Pool', () => closePool())
}
process.exit(0)
