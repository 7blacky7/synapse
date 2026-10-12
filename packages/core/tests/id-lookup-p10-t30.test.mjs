import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const dbUrl = new URL(process.env.DATABASE_URL || 'http://ungueltig');
assert.equal(dbUrl.pathname, '/synapse_test', 'nur synapse_test verwenden');
assert.equal(dbUrl.port, '5433', 'nur Test-DB-Port verwenden');

const core = await import('../dist/index.js');
const { closePool } = await import('../dist/db/client.js');
const rest = await import('../../rest-api/dist/routes/mcp.js');
const mcpPfad = '../../mcp-server/dist/tools/consolidated/';
const moduleFuer = async (name) => import(mcpPfad + name + '.js');
const ladeTool = async (name) => {
  const mod = await moduleFuer(name);
  const tool = Object.values(mod).find((v) => v && v.definition?.name === name);
  assert.ok(tool?.handler, 'MCP-Tool ' + name + ' geladen');
  return tool;
};
const project = 'p10-t30-id-lookup-golden';
const faelle = [
  ['memory', { action: 'read', project, name: 'p10-t30-nicht-vorhanden' }],
  ['docs', { action: 'get_for_file', project, agent_id: 'p10-t30-golden', file_path: 'src/fehlt.ts', framework_warnungen: false }],
  ['channel', { action: 'feed', project, channel_name: 'p10-t30-nicht-vorhanden' }],
  ['event', { action: 'pending', project, agent_id: 'p10-t30-golden' }],
  ['chat', { action: 'get', project, agent_id: 'p10-t30-golden' }],
  ['jev', { action: 'protokoll', project, seit: '2000-01-01T00:00:00.000Z' }],
];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const golden = {};
for (const [name, args] of faelle) {
  const tool = await ladeTool(name);
  const stdio = await tool.handler(args);
  const restAntwort = await rest.handleToolCall(name, args, 'p10-t30-golden');
  golden[name] = { stdio: hash(stdio), rest: hash(restAntwort) };
  console.log('GOLDEN ' + name + ' ' + JSON.stringify(golden[name]));
}
await closePool();
if (process.env.P10_T30_GOLDEN_CAPTURE !== '1') {
  assert.deepEqual(golden, {
    memory: { stdio: '332f293cc3acd631754d89fe220bfbc09c555ceaa6f5ef550882238ca5900f65', rest: '3f9ece9e65009a38a9c84987f0e36fc32313f83318f6e6c4f2e4fd23d4f78d9a' },
    docs: { stdio: '39049680a8bd66ad89b9d70b77b4e80388b958c81e401987f66b63d6e9916d3f', rest: '4a05d888e990356967987e8d15612bdfd405f5d1e80d44b3dd17059e9b99cc11' },
    channel: { stdio: '4968a329c2226ffcd8206f8bdd12641e54f7f37e92dfc8f1a02d691d381908c3', rest: 'fd4dffdac90085e2a00ebc81418711b68da26c60f864ce5c5ab85ac751cc69de' },
    event: { stdio: '183eb398610736e5834b602332b82f180a32600111d4036ee1a6da07c495846b', rest: '9c425d4a69fff03df661fe034f953e5a48b5e5ef71052de69e927234f5649df2' },
    chat: { stdio: '58e3fdb2f222779c35d1088da51cf15f88123c1cd8b3f1a0498e8202839830c5', rest: 'cbc20a9710c6d0bfd6a1e33e3c76c753fe2758c83cf6879a4561ee892c7eb14f' },
    jev: { stdio: '22b86d1c526e42c4c643303199c4a75c0b1eaee9830ef03f0015408a69d441c8', rest: '22b86d1c526e42c4c643303199c4a75c0b1eaee9830ef03f0015408a69d441c8' },
  }, 'Standardausgaben ohne neuen Parameter bleiben unverändert');
}
if (process.env.P10_T30_GOLDEN_CAPTURE !== '1') {
  assert.equal(typeof core.getProjectRecordById, 'function', 'gemeinsamer Core-ID-Lookup vorhanden');
}
console.log('P10-T30-GOLDEN-OK: Standardausgaben sind unverändert');
process.exit(0);
