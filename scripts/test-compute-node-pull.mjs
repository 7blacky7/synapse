import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// Agent-E2E (GPU-2, P15-T6, P15-T9): der Knoten holt den Referenzvertrag, registriert sich, bekommt
// claimBatch vom Server, claimt einen STAPEL, bettet ihn in EINEM /api/embed-Aufruf ein (lange Texte
// werden gestueckelt), schliesst ihn in EINEM Aufruf ab und gibt beim Beenden offene Claims frei.

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
const lang = 'GPU-2-long-content-'.repeat(1800);
const stapel = [
  { chunkId: 'chunk-lang', claimToken: '11111111-1111-4111-8111-111111111111', content: lang, contentHash: 'b'.repeat(64) },
  { chunkId: 'chunk-kurz-1', claimToken: '22222222-2222-4222-8222-222222222222', content: 'kurz eins', contentHash: 'c'.repeat(64) },
  { chunkId: 'chunk-kurz-2', claimToken: '33333333-3333-4333-8333-333333333333', content: 'kurz zwei', contentHash: 'd'.repeat(64) },
];
const haengt = { chunkId: 'chunk-haengt', claimToken: '44444444-4444-4444-8444-444444444444', content: 'HAENGT', contentHash: 'e'.repeat(64) };
// P15-T11: claimBatch = Kapazitaet offener Claims; der Knoten holt Stapel der halben Kapazitaet,
// damit der vorausgeholte Stapel neben dem rechnenden Platz hat.
const CLAIM_BATCH = 6;

const embedAufrufe = [];
let registration = null;
let completion = null;
let release = null;
const claimLimits = [];
let claimRunde = 0;
let trapConnections = 0;
let completedResolve; const completed = new Promise((r) => { completedResolve = r; });
let haengtResolve; const haengtAngekommen = new Promise((r) => { haengtResolve = r; });
let releaseResolve; const releaseAngekommen = new Promise((r) => { releaseResolve = r; });

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
  if (request.url === '/api/ps') return json(response, 200, { models: [] });
  // P12-T14: /api/embed (Liste input -> Liste embeddings). Modell und num_ctx aus dem Referenzvertrag.
  if (request.url === '/api/embed') {
    assert.equal(body.model, model);
    assert.ok(Array.isArray(body.input));
    assert.deepEqual(body.options, { num_ctx: 8192 });
    embedAufrufe.push(body.input);
    // Zweiter Stapel: Ollama antwortet nicht -> der Agent haelt den Claim, bis er beendet wird.
    if (body.input.some((t) => t.endsWith('HAENGT'))) { haengtResolve(); return; }
    return json(response, 200, { embeddings: body.input.map(() => new Array(4096).fill(1)) });
  }
  json(response, 404, {});
});

// Referenzvertrag wie GET /api/embedding-nodes/reference (P15-T1, P15-T8) ihn liefert.
const referenz = {
  model,
  modelDigest: digest,
  nativeDimension: 4096,
  targetDimension: 3072,
  numCtx: 8192,
  quantization: 'Q8_0',
  requiredTotalVramMb: 12000,
  requiredFreeVramMb: 7300,
  queryPraefix: 'query: ',
  dokPraefix: 'passage: ',
  maxStueckZeichen: 3276,
};
let referenzAbrufe = 0;

const api = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (request.method === 'GET' && request.url === '/api/embedding-nodes/reference') {
    referenzAbrufe++;
    return json(response, 200, { success: true, reference: referenz });
  }
  if (request.url === '/api/embedding-nodes/register') {
    registration = body;
    return json(response, 201, { success: true, claimBatch: CLAIM_BATCH });
  }
  if (request.url?.endsWith('/heartbeat')) return json(response, 200, { success: true });
  if (request.url?.endsWith('/claims')) {
    claimLimits.push(body.limit);
    claimRunde++;
    const claims = claimRunde === 1 ? stapel : claimRunde === 2 ? [haengt] : [];
    return json(response, 200, { success: true, claims, reference: referenz });
  }
  if (request.url?.endsWith('/claims/complete')) {
    completion = body;
    json(response, 200, { success: true, abgeschlossen: body.items.map((i) => i.chunkId), abgelehnt: [] });
    completedResolve();
    return;
  }
  if (request.url?.endsWith('/claims/release')) {
    release = body;
    json(response, 200, { success: true, freigegeben: body.claims.map((c) => c.chunkId) });
    releaseResolve();
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
const fakeBinDir = await mkdtemp(path.join(os.tmpdir(), 'synapse-fake-gpu-'));
await writeFile(
  path.join(fakeBinDir, 'nvidia-smi'),
  '#!/bin/sh\nprintf "Test GPU, 12288, 10000\\n"\n',
  { mode: 0o700 },
);

let stderr = '';
const child = spawn(process.execPath, ['packages/compute-node-agent/dist/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    SYNAPSE_GPU_INDEX: '0',
    SYNAPSE_API_URL: `http://127.0.0.1:${apiPort}`,
    SYNAPSE_API_TOKEN: 'test-service-token',
    SYNAPSE_NODE_ID: 'gpu2-test-node',
    // P15-T9: kein Wunsch des Knotens -> der Server legt die Stapelgroesse fest (claimBatch).
    SYNAPSE_NODE_MAX_CONCURRENCY: '',
    SYNAPSE_NODE_HEARTBEAT_MS: '100',
    SYNAPSE_NODE_RETRY_MS: '20',
    OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
    // P15-T6: absichtlich falsche Env — der Vertrag der API muss gewinnen.
    OLLAMA_MODEL: 'falsches-modell:latest',
    EMBEDDING_TARGET_DIM: '17',
    EMBEDDING_NUM_CTX: '17',
    // P15-T8: auch falsche Praefix-Env muss der Vertrag uebersteuern.
    EMBEDDING_QUERY_PREFIX: 'falsch-q: ',
    EMBEDDING_DOC_PREFIX: 'falsch-d: ',
    OPENAI_API_KEY: 'must-never-be-used',
    DATABASE_URL: `postgresql://127.0.0.1:${pgTrapPort}/forbidden`,
    QDRANT_URL: `http://127.0.0.1:${qdrantTrapPort}`,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
const frist = (p, ms, was) => Promise.race([
  p,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${was} timeout: ${stderr.slice(-1500)}`)), ms)),
]);

try {
  await frist(completed, 15_000, 'Stapel-Abschluss');
  await frist(haengtAngekommen, 10_000, 'zweiter Stapel');
  // Geordnetes Beenden (Tray "Helfer stoppen" schickt SIGTERM): offene Claims muessen zurueck.
  child.kill('SIGTERM');
  await frist(releaseAngekommen, 5_000, 'Claim-Freigabe');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);

  assert.equal(registration.maxConcurrency, undefined, 'ohne Env darf der Knoten keinen eigenen Default melden');
  assert.ok(referenzAbrufe >= 1, 'Agent hat den Referenzvertrag nicht abgerufen');
  assert.equal(registration.model, model);
  assert.equal(registration.targetDimension, 3072);
  assert.equal(registration.numCtx, 8192);
  assert.ok(claimLimits.length >= 2 && claimLimits.every((l) => l === CLAIM_BATCH / 2),
    'Claim-Limit = halbe Kapazitaet (Vorausholen): ' + JSON.stringify(claimLimits));

  // Stapel: EIN Abschluss mit allen drei Eintraegen, in Claim-Reihenfolge.
  assert.equal(completion.model, model);
  assert.equal(completion.modelDigest, digest);
  assert.equal(completion.nativeDimension, 4096);
  assert.equal(completion.targetDimension, 3072);
  assert.equal(completion.numCtx, 8192);
  assert.deepEqual(completion.items.map((i) => i.chunkId), stapel.map((c) => c.chunkId));
  assert.deepEqual(completion.items.map((i) => i.claimToken), stapel.map((c) => c.claimToken));
  for (const item of completion.items) {
    assert.equal(item.vector.length, 3072);
    const norm = Math.sqrt(item.vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) < 1e-10);
  }
  // Die beiden kurzen Texte gingen in EINEM /api/embed-Aufruf; der lange wurde gestueckelt.
  assert.ok(embedAufrufe.some((input) => input.length === 2 && input[0] === 'passage: kurz eins' && input[1] === 'passage: kurz zwei'),
    'kurze Texte nicht als ein Stapel eingebettet: ' + JSON.stringify(embedAufrufe.map((i) => i.length)));
  const stuecke = embedAufrufe.find((input) => input.join('') === 'passage: ' + lang);
  assert.ok(stuecke && stuecke.length >= 2, 'langer Text nicht vollstaendig gestueckelt');

  // Beenden: genau der haengende Claim wurde mit seinem Token freigegeben.
  assert.deepEqual(release.claims, [{ chunkId: haengt.chunkId, claimToken: haengt.claimToken }]);
  assert.equal(trapConnections, 0);
  console.log(
    `GPU-2/P15-T9 agent E2E: claimBatch=${CLAIM_BATCH} stapel=${completion.items.length} embed_aufrufe=${embedAufrufe.length} release=1 forbidden_net=0`,
  );
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  ollama.closeAllConnections?.();
  await Promise.all([close(ollama), close(api), close(trapA), close(trapB)]);
  await rm(fakeBinDir, { recursive: true, force: true });
}
