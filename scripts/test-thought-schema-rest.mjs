// test-thought-schema-rest.mjs — P2-T385: REST-Schema des thought-Tools.
// task_id, task_status, trigger_respawn muessen auf oberster Ebene von properties stehen
// (nicht unter items). Ohne echte DB: nur tools/list ueber Fastify inject.
// Voraussetzung: gebaute dists (pnpm build).
import assert from 'node:assert/strict'
import Fastify from '../packages/rest-api/node_modules/fastify/fastify.js'
import { mcpRoutes } from '../packages/rest-api/dist/routes/mcp.js'

const app = Fastify({ logger: false })
await app.register(mcpRoutes)
await app.ready()

let ok = 0
let fehler = 0
function pruefe(name, fn) {
  try { fn(); ok++; console.log('OK    ' + name) } catch (e) { fehler++; console.log('FEHLER ' + name + ': ' + e.message) }
}

const response = await app.inject({
  method: 'POST',
  url: '/',
  payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
})
assert.equal(response.statusCode, 200)
const thought = response.json().result.tools.find((t) => t.name === 'thought')
assert.ok(thought, 'thought-Tool im REST-Schema')
const props = thought.inputSchema.properties

for (const key of ['task_id', 'task_status', 'trigger_respawn']) {
  pruefe(`properties.${key} auf oberster Ebene`, () => assert.ok(props[key], `${key} fehlt in properties`))
  pruefe(`${key} nicht unter items`, () => assert.equal(props.items?.[key], undefined))
}
pruefe('task_status Enum', () => assert.deepEqual(props.task_status.enum, ['todo', 'in_progress', 'done', 'blocked']))
pruefe('trigger_respawn ist boolean', () => assert.equal(props.trigger_respawn.type, 'boolean'))
pruefe('items ist Array mit object-Items (content, tags, task_id)', () => {
  assert.equal(props.items.type, 'array')
  assert.equal(props.items.items.type, 'object')
  assert.deepEqual(Object.keys(props.items.items.properties).sort(), ['content', 'tags', 'task_id'])
  assert.equal(props.items.maxItems, 50)
})
pruefe('id/query/limit weiterhin vorhanden', () => {
  for (const k of ['id', 'query', 'limit', 'dry_run', 'max_items']) assert.ok(props[k], k)
})

await app.close()
console.log(`${ok} OK / ${fehler} FEHLER`)
process.exit(fehler ? 1 : 0)
