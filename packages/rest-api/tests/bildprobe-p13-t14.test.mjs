/**
 * P13-T14: Bildprobe, DB-frei. PostgreSQL wird vollständig durch einen
 * In-Process-Query-Mock ersetzt; keine Verbindung und keine Live-Daten.
 * Lauf: node packages/rest-api/tests/bildprobe-p13-t14.test.mjs
 */
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/synapse_test';
delete process.env.SYNAPSE_AUTH_DISABLED;
const bp = await import('../../core/dist/services/bildprobe.js');
const requireApi = createRequire(new URL('../package.json', import.meta.url));
const Fastify = requireApi('fastify');
const { getPool } = await import('../../core/dist/db/client.js');
const pool = getPool();
const sql = [];
pool.query = async (query, values = []) => {
  sql.push({ query, values });
  if (/UPDATE auth_tokens/.test(query) && values[0] === createHash('sha256').update('test-only-bildprobe').digest('hex')) {
    return { rows:[{ kind:'service', token_hash:values[0], expires_at:null }], rowCount:1 };
  }
  return { rows: [], rowCount: 0 };
};
const { registerAuthHook } = await import('../dist/middleware/auth-hook.js');
const { bildprobeRoutes } = await import('../dist/routes/bildprobe.js');
const { mcpRoutes } = await import('../dist/routes/mcp.js');
const { createServer: createStdioServer } = await import('../../mcp-server/dist/server.js');
const requireMcp = createRequire(new URL('../../mcp-server/package.json', import.meta.url));
const { Client } = await import(requireMcp.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { InMemoryTransport } = await import(requireMcp.resolve('@modelcontextprotocol/sdk/inMemory.js'));

function crc(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngInfo(png) {
  assert.deepEqual([...png.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  const idat = [];
  let w, h, end = false;
  for (let at = 8; at < png.length;) {
    const n = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + n);
    assert.equal(png.readUInt32BE(at + 8 + n), crc(png.subarray(at + 4, at + 8 + n)));
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[9], 2);
    }
    if (type === 'IDAT') idat.push(data);
    if (type === 'IEND') end = true;
    at += n + 12;
  }
  assert.ok(end);
  const pixels = inflateSync(Buffer.concat(idat));
  assert.equal(pixels.length, (w * 3 + 1) * h);
  let light = 0;
  for (let y = 0; y < h; y++) {
    assert.equal(pixels[y * (w * 3 + 1)], 0);
    for (let x = 0; x < w; x++) if (pixels[y * (w * 3 + 1) + 1 + x * 3] > 200) light++;
  }
  assert.ok(light > 100, 'sichtbare helle Bitmap-Glyphen vorhanden');
  return { w, h };
}
const config = bp.ladeBildprobeKonfiguration({
  SYNAPSE_BILDPROBE_BASE_URL: 'https://example.invalid',
  SYNAPSE_BILDPROBE_TTL_MS: '100',
  SYNAPSE_BILDPROBE_WIDTH: '480',
  SYNAPSE_BILDPROBE_HEIGHT: '160',
});
let now = 1000;
const fixture = 'FALKE-7381';
const dienst = new bp.BildprobeDienst(config, { jetzt: () => now, wort: () => fixture, kennung: 'api' });
const text = r => JSON.parse(r.content.find(c => c.type === 'text').text);
const inline = dienst.ausfuehren({ modus: 'inline' });
assert.deepEqual(inline.content.map(c => c.type), ['text', 'image']);
assert.equal(inline.content[1].mimeType, 'image/png');
assert.ok(!JSON.stringify(text(inline)).includes(fixture));
assert.ok(!JSON.stringify(inline.structuredContent).includes(fixture));
assert.deepEqual(pngInfo(Buffer.from(inline.content[1].data, 'base64')), { w: 480, h: 160 });
assert.equal(text(dienst.ausfuehren({ probe_id: text(inline).probe_id, wort: 'FALSCH' })).richtig, false);
assert.equal(text(dienst.ausfuehren({ probe_id: text(inline).probe_id, wort: fixture })).richtig, true);
assert.ok(!JSON.stringify(dienst.ausfuehren({ probe_id: text(inline).probe_id, wort: fixture })).includes(fixture));
const link = text(dienst.ausfuehren({ modus: 'link' }));
assert.equal(link.modus, 'link');
assert.ok(link.link.startsWith('https://example.invalid/api/bildprobe/'));
const token = new URL(link.link).pathname.split('/').at(-1);
assert.match(token, /^[a-f0-9]{64}$/);
const first = dienst.abrufen(token, { ip: '127.0.0.1', userAgent: 'proxy-one' });
assert.equal(first.status, 200);
pngInfo(first.png);
assert.equal(dienst.abrufen(token, { ip: '127.0.0.2', userAgent: 'proxy-two' }).status, 410);
const stats = text(dienst.ausfuehren({ probe_id: link.probe_id, wort: fixture }));
assert.equal(stats.richtig, true);
assert.equal(stats.abrufe.length, 2);
assert.deepEqual(stats.abrufe.map(x => x.user_agent), ['proxy-one', 'proxy-two']);
assert.ok(stats.abrufe.every(x => x.zeit && x.ip));
const expires = text(dienst.ausfuehren({ modus: 'link' }));
now += 101;
assert.equal(dienst.abrufen(new URL(expires.link).pathname.split('/').at(-1), { ip: '127.0.0.1', userAgent: 'late' }).status, 410);
assert.equal(text(dienst.ausfuehren({ probe_id: expires.probe_id, wort: fixture })).abgelaufen, true);
assert.deepEqual(pngInfo(bp.renderBildprobePng(fixture, 720, 240)), { w: 720, h: 240 });
assert.throws(() => bp.ladeBildprobeKonfiguration({ SYNAPSE_BILDPROBE_WIDTH: 'NaN' }));
assert.throws(() => bp.ladeBildprobeKonfiguration({ SYNAPSE_BILDPROBE_BASE_URL: 'file:///tmp' }));
const cap = new bp.BildprobeDienst({ ...config, maxProben: 1 }, { jetzt: () => 0, wort: () => fixture });
cap.ausfuehren({ modus: 'inline' });
assert.equal(text(cap.ausfuehren({ modus: 'inline' })).error, 'bildprobe_kapazitaet');

const authApp = Fastify({ logger: false });
registerAuthHook(authApp);
await authApp.register(bildprobeRoutes, { dienst });
authApp.get('/api/geschuetzt', () => ({ ok: true }));
try {
  const publicProbe = text(dienst.ausfuehren({ modus: 'link' }));
  const path = new URL(publicProbe.link).pathname;
  const publicGet = await authApp.inject({ method: 'GET', url: path });
  assert.equal(publicGet.statusCode, 200);
  assert.equal(publicGet.headers['content-type'], 'image/png');
  assert.match(publicGet.headers['cache-control'], /no-store/);
  assert.equal((await authApp.inject({ method: 'GET', url: path })).statusCode, 410);
  for (const [method, url] of [
    ['GET', '/api/geschuetzt'], ['POST', '/api/bildprobe'], ['HEAD', path],
    ['POST', path], ['GET', path + '/extra'], ['GET', '/api/bildprobe/short'],
  ]) assert.equal((await authApp.inject({ method, url })).statusCode, 401, method + ' Pfad bleibt geschützt');
  const concurrent = new URL(text(dienst.ausfuehren({ modus: 'link' })).link).pathname;
  const races = await Promise.all([authApp.inject(concurrent), authApp.inject(concurrent)]);
  assert.deepEqual(races.map(x => x.statusCode).sort(), [200,410]);
  const late = text(dienst.ausfuehren({ modus:'link' }));
  now += 101;
  assert.equal((await authApp.inject(new URL(late.link).pathname)).statusCode, 410);
  const lateCheck = text(dienst.ausfuehren({ probe_id:late.probe_id, wort:fixture }));
  assert.equal(lateCheck.abrufe[0].status, 410);
  assert.equal(lateCheck.abgelaufen, true);
  assert.equal((await authApp.inject({ method:'POST', url:'/api/bildprobe', headers:{authorization:'Bearer test-only-bildprobe'}, payload:{modus:'inline'} })).statusCode,200);
} finally { await authApp.close(); }

const app = Fastify({ logger: false });
registerAuthHook(app);
const testHeaders = { authorization:'Bearer test-only-bildprobe' };
await app.register(mcpRoutes);
await app.register(bildprobeRoutes);
const stdio = createStdioServer();
const client = new Client({ name: 'bildprobe-test', version: '1.0.0' }, { capabilities: {} });
const [a,b] = InMemoryTransport.createLinkedPair();
await stdio.connect(a);
await client.connect(b);
let rpcId = 1;
const rpc = async args => (await app.inject({
  method: 'POST', url: '/mcp/messages', headers: testHeaders,
  payload: { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name: 'admin', arguments: args } },
})).json().result;
try {
  const lists = [
    (await client.listTools()).tools,
    (await app.inject({ method:'POST', url:'/mcp/messages', headers:testHeaders, payload:{jsonrpc:'2.0',id:rpcId++,method:'tools/list'} })).json().result.tools,
  ];
  for (const list of lists) {
    const def = list.find(x => x.name === 'admin');
    assert.ok(def.inputSchema.properties.action.enum.includes('bildprobe'));
    for (const key of ['modus','probe_id','wort']) assert.ok(key in def.inputSchema.properties);
  }
  for (const call of [args => client.callTool({ name: 'admin', arguments: args }), rpc]) {
    const r = await call({ action:'bildprobe', modus:'inline' });
    assert.deepEqual(r.content.map(x => x.type), ['text','image'], 'echte MCP-Blöcke statt eingebettetem JSON');
    assert.deepEqual(pngInfo(Buffer.from(r.content[1].data,'base64')), { w:480, h:160 });
    const check = await call({ action:'bildprobe', probe_id:text(r).probe_id, wort:fixture });
    assert.equal(typeof text(check).richtig, 'boolean');
    assert.ok(!JSON.stringify(check).includes(fixture));
  }
  // stdio-Link muss im API-Prozess leben: realer HTTP-Hop auf lokalen Testserver.
  process.env.SYNAPSE_API_TOKEN = 'test-only-bildprobe';
  await app.listen({ port:0, host:'127.0.0.1' });
  process.env.SYNAPSE_API_URL = 'http://127.0.0.1:' + app.server.address().port;
  const remote = await client.callTool({ name:'admin', arguments:{ action:'bildprobe', modus:'link' } });
  const meta = text(remote);
  assert.match(meta.probe_id, /^api\./);
  const remotePath = new URL(meta.link).pathname;
  assert.equal((await app.inject(remotePath)).statusCode, 200);
  assert.equal((await app.inject(remotePath)).statusCode, 410);
  const checkRemote = text(await client.callTool({ name:'admin', arguments:{ action:'bildprobe',probe_id:meta.probe_id,wort:fixture } }));
  assert.equal(checkRemote.abrufe.length, 2);
  const { logToolCall } = await import('../../core/dist/services/tool-call-log.js');
  await logToolCall({ tool:'admin', action:'bildprobe', argsPreview:'{"wort":"' + fixture, error:fixture, result:fixture, ok:false });
  await logToolCall({ tool:'admin', action:'index_stats', argsPreview:'{"bleibt":true}', result:'{"bleibt":true}', ok:true });
  const logs = sql.filter(x => /INSERT INTO tool_calls/.test(x.query));
  const control = logs.find(x => x.values[4] === 'index_stats');
  assert.equal(control.values[5], '{"bleibt":true}');
  assert.equal(control.values[9], '{"bleibt":true}');
  assert.ok(logs.length >= 6, 'echte Audit-Inserts erfasst');
  assert.ok(!JSON.stringify(logs).includes(fixture), 'Prüfwort niemals in gespeicherten tool_calls');
  const ordinary = logs.find(x => x.values[3] === 'admin' && x.values[4] === 'bildprobe');
  assert.ok(ordinary, 'Probe-Audit-Anker vorhanden');

  // Visuelle Positivkontrolle: zufälliges Bild, kein Sollwort im Log oder Dateinamen.
  if (process.env.BILDPROBE_VORSCHAU === '1') {
    const visual = await rpc({ action:'bildprobe', modus:'inline' });
    await mkdir('/tmp/synapse-p13-t14', { recursive:true });
    await writeFile('/tmp/synapse-p13-t14/positivkontrolle.png', Buffer.from(visual.content[1].data,'base64'));
    await writeFile('/tmp/synapse-p13-t14/probe-id.txt', text(visual).probe_id);
    // Das zufällige Codewort wird ausschließlich visuell gelesen, niemals als Text ausgegeben.
  }
  console.log('P13-T14 PASS: PNG/CRC, Modus, Bestätigung, Einmal/Ablauf/Race, Auth, REST+stdio, HTTP-Brücke, Audit ohne Klartext; DB-frei.');
} finally {
  await client.close(); await stdio.close(); await app.close(); await pool.end();
}
process.exit(0);
