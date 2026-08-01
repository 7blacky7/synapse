import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

const listen = (server) => new Promise((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
);
const close = (server) => new Promise((resolve) => server.close(resolve));
const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const model = 'qwen3-embedding:8b';
const digest = 'a'.repeat(64);
const content = 'GPU-2-long-content-'.repeat(1800);
const ollamaPrompts = [];
let registration = null;
let completion = null;
let claimGiven = false;
let completedResolve;
const completed = new Promise((resolve) => { completedResolve = resolve; });
let trapConnections = 0;

const ollama = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (request.url === '/api/tags') {
    return json(response, 200, { models: [{ name: model, model, digest }] });
  }
  if (request.url === '/api/show') {
    return json(response, 200, {
      details: { quantization_level: 'Q8_0' },
      model_info: { 'qwen3.embedding_length': 4096 },
    });
  }
  if (request.url === '/api/embeddings') {
    assert.equal(body.model, model);
    assert.equal(typeof body.prompt, 'string');
    assert.deepEqual(body.options, { num_ctx: 8192 });
    assert.equal('input' in body, false);
    ollamaPrompts.push(body.prompt);
    return json(response, 200, { embedding: new Array(4096).fill(1) });
  }
  json(response, 404, {});
});

const api = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (request.url === '/api/embedding-nodes/register') {
    registration = body;
    return json(response, 201, { success: true });
  }
  if (request.url?.endsWith('/heartbeat')) return json(response, 200, { success: true });
  if (request.url?.endsWith('/claims') && !request.url.includes('/complete')) {
    if (claimGiven) {
      return json(response, 200, {
        success: true,
        claims: [],
        reference: {
          model,
          modelDigest: digest,
          nativeDimension: 4096,
          targetDimension: 3072,
          numCtx: 8192,
          quantization: 'Q8_0',
        },
      });
    }
    claimGiven = true;
    return json(response, 200, {
      success: true,
      claims: [{
        chunkId: 'chunk-http',
        claimToken: '11111111-1111-4111-8111-111111111111',
        content,
        contentHash: 'b'.repeat(64),
      }],
      reference: {
        model,
        modelDigest: digest,
        nativeDimension: 4096,
        targetDimension: 3072,
        numCtx: 8192,
        quantization: 'Q8_0',
      },
    });
  }
  if (request.url?.endsWith('/complete')) {
    completion = body;
    json(response, 200, { success: true, completed: true });
    completedResolve();
    return;
  }
  json(response, 404, {});
});

const trapA = net.createServer((socket) => {
  trapConnections++;
  socket.destroy();
});
const trapB = net.createServer((socket) => {
  trapConnections++;
  socket.destroy();
});

const [ollamaPort, apiPort, pgTrapPort, qdrantTrapPort] = await Promise.all([
  listen(ollama), listen(api), listen(trapA), listen(trapB),
]);

let stderr = '';
const child = spawn(process.execPath, ['packages/compute-node-agent/dist/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    SYNAPSE_API_URL: `http://127.0.0.1:${apiPort}`,
    SYNAPSE_API_TOKEN: 'test-service-token',
    SYNAPSE_NODE_ID: 'gpu2-test-node',
    SYNAPSE_NODE_MAX_CONCURRENCY: '1',
    SYNAPSE_NODE_HEARTBEAT_MS: '100',
    SYNAPSE_NODE_RETRY_MS: '20',
    OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
    OLLAMA_MODEL: model,
    EMBEDDING_TARGET_DIM: '3072',
    EMBEDDING_NUM_CTX: '8192',
    OPENAI_API_KEY: 'must-never-be-used',
    DATABASE_URL: `postgresql://127.0.0.1:${pgTrapPort}/forbidden`,
    QDRANT_URL: `http://127.0.0.1:${qdrantTrapPort}`,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

try {
  await Promise.race([
    completed,
    new Promise((_resolve, reject) => setTimeout(
      () => reject(new Error(`compute agent timeout: ${stderr.slice(-1000)}`)),
      15_000,
    )),
  ]);
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');

  assert.equal(registration.maxConcurrency, 1);
  assert.equal(completion.model, model);
  assert.equal(completion.modelDigest, digest);
  assert.equal(completion.nativeDimension, 4096);
  assert.equal(completion.targetDimension, 3072);
  assert.equal(completion.numCtx, 8192);
  assert.equal(completion.vector.length, 3072);
  const norm = Math.sqrt(completion.vector.reduce((sum, value) => sum + value * value, 0));
  assert.ok(Math.abs(norm - 1) < 1e-10);
  assert.ok(ollamaPrompts.length >= 2);
  assert.equal(ollamaPrompts.join(''), content);
  assert.equal(trapConnections, 0);
  console.log(
    `GPU-2 agent E2E: prompts=${ollamaPrompts.length} vector=3072 norm=${norm.toFixed(12)} forbidden_net=0`,
  );
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  await Promise.all([close(ollama), close(api), close(trapA), close(trapB)]);
}
