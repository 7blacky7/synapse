import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// P15-T11 Agent-E2E: Vorausholen.
//   V1 Ueberlappung: der Claim von Stapel N+1 laeuft, WAEHREND Ollama Stapel N rechnet (Claim-Antwort
//      kuenstlich verzoegert), und der Abschluss von N laeuft, waehrend N+1 rechnet.
//   V2 Ollama bleibt seriell: nie zwei /api/embed gleichzeitig.
//   V3 Kapazitaet: Stapel = halbe Kapazitaet (claimBatch / 2).
//   V4 Volle Modellpruefung (nvidia-smi) nur beim Start, nicht je Stapel; Digest-Pruefung je Stapel.
//   V5 API-Rueckfall: bevorzugte Adresse tot (Verbindung abgelehnt) -> sofort ueber SYNAPSE_API_URL_RUECKFALL.
//   V6 SIGTERM gibt ALLE offenen Claims frei: den rechnenden UND den vorausgeholten Stapel.
//   V7 Statusdatei (SYNAPSE_NODE_STATUS_DATEI): aktive Adresse, Art, Rueckfall aktiv, Embed-Pause.
//   V8 Embed-Pause (EMBED_MIN_GAP_MS, vom Tray aus gpu-helfer.json) kommt in core an: GPU-Luecke >= Pause.

const listen = (server) => new Promise((resolve) =>
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
);
const close = (server) => new Promise((resolve) => server.close(resolve));
const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const jetzt = () => Date.now() - t0;

const CLAIM_MS = 250;
const EMBED_MS = 400;
const COMPLETE_MS = 150;
const CLAIM_BATCH = 4;

const model = 'vorlauf-test-modell:latest';
const digest = 'a'.repeat(64);
const referenz = {
  model,
  modelDigest: digest,
  nativeDimension: 16,
  targetDimension: 8,
  numCtx: 512,
  quantization: 'Q8_0',
  requiredTotalVramMb: 1000,
  requiredFreeVramMb: 500,
  queryPraefix: 'q: ',
  dokPraefix: 'd: ',
  maxStueckZeichen: 1000,
};

const claim = (stapel, nr) => ({
  chunkId: `${stapel}-${nr}`,
  claimToken: `${String(stapel.charCodeAt(0)).padStart(8, '0')}-${nr}111-4111-8111-111111111111`,
  content: `${stapel} text ${nr}`,
  contentHash: 'b'.repeat(64),
});
// A und B werden fertig, C haengt in Ollama, D wird waehrenddessen vorausgeholt.
const stapelFolge = ['A', 'B', 'C', 'D'].map((s) => [claim(s, 1), claim(s, 2)]);

const embeds = [];       // { stapel, start, ende }
const claimsLog = [];    // { stapel, start, ende, limit }
const completes = [];    // { stapel, start, ende }
let laufendeEmbeds = 0;
let maxLaufendeEmbeds = 0;
let tagsAufrufe = 0;
let release = null;
let claimRunde = 0;
let trapConnections = 0;
const signal = () => { let r; const p = new Promise((res) => { r = res; }); return [p, r]; };
const [cHaengt, cHaengtResolve] = signal();
const [dGeclaimt, dGeclaimtResolve] = signal();
const [releaseDa, releaseResolve] = signal();
const [zweiFertig, zweiFertigResolve] = signal();

const ollama = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (request.url === '/api/tags') {
    tagsAufrufe++;
    return json(response, 200, { models: [{ name: model, model, digest }] });
  }
  if (request.url === '/api/show') {
    return json(response, 200, { details: { quantization_level: 'Q8_0' }, model_info: { 'test.embedding_length': 16 } });
  }
  if (request.url === '/api/ps') return json(response, 200, { models: [] });
  if (request.url === '/api/embed') {
    const stapel = body.input[0].replace(/^d: /, '')[0];
    const eintrag = { stapel, start: jetzt(), ende: null };
    embeds.push(eintrag);
    laufendeEmbeds++;
    maxLaufendeEmbeds = Math.max(maxLaufendeEmbeds, laufendeEmbeds);
    if (stapel === 'C') { cHaengtResolve(); return; } // haengt bis zum Ende
    await sleep(EMBED_MS);
    laufendeEmbeds--;
    eintrag.ende = jetzt();
    return json(response, 200, { embeddings: body.input.map((_, i) => Array.from({ length: 16 }, (_v, k) => (k === i % 16 ? 1 : 0.5))) });
  }
  json(response, 404, {});
});

const api = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (request.method === 'GET' && request.url === '/api/embedding-nodes/reference') {
    return json(response, 200, { success: true, reference: referenz });
  }
  if (request.url === '/api/embedding-nodes/register') {
    return json(response, 201, { success: true, claimBatch: CLAIM_BATCH });
  }
  if (request.url?.endsWith('/heartbeat')) return json(response, 200, { success: true });
  if (request.url?.endsWith('/claims')) {
    const runde = claimRunde++;
    const claims = stapelFolge[runde] ?? [];
    const eintrag = { stapel: claims[0]?.chunkId[0] ?? '-', start: jetzt(), ende: null, limit: body.limit };
    claimsLog.push(eintrag);
    await sleep(CLAIM_MS);
    eintrag.ende = jetzt();
    json(response, 200, { success: true, claims, reference: referenz });
    if (eintrag.stapel === 'D') dGeclaimtResolve();
    return;
  }
  if (request.url?.endsWith('/claims/complete')) {
    const eintrag = { stapel: body.items[0].chunkId[0], start: jetzt(), ende: null, items: body.items.length };
    completes.push(eintrag);
    await sleep(COMPLETE_MS);
    eintrag.ende = jetzt();
    json(response, 200, { success: true, abgeschlossen: body.items.map((i) => i.chunkId), abgelehnt: [] });
    if (completes.filter((c) => c.ende !== null).length === 2) zweiFertigResolve();
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

// Tote bevorzugte Adresse: Port oeffnen, merken, schliessen -> Verbindung abgelehnt.
const tot = net.createServer();
const totPort = await listen(tot);
await close(tot);
const trapA = net.createServer((s) => { trapConnections++; s.destroy(); });
const trapB = net.createServer((s) => { trapConnections++; s.destroy(); });

const [ollamaPort, apiPort, pgTrapPort, qdrantTrapPort] = await Promise.all([
  listen(ollama), listen(api), listen(trapA), listen(trapB),
]);
const fakeBinDir = await mkdtemp(path.join(os.tmpdir(), 'synapse-fake-gpu-'));
const smiLog = path.join(fakeBinDir, 'smi.log');
const statusDatei = path.join(fakeBinDir, 'gpu-helfer-status.json');
const EMBED_PAUSE_MS = 75;
await writeFile(smiLog, '');
await writeFile(
  path.join(fakeBinDir, 'nvidia-smi'),
  `#!/bin/sh\necho x >> "${smiLog}"\nprintf "Test GPU, 12288, 10000\\n"\n`,
  { mode: 0o700 },
);

let stderr = '';
const child = spawn(process.execPath, ['packages/compute-node-agent/dist/index.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    SYNAPSE_GPU_INDEX: '0',
    SYNAPSE_API_URL: `http://127.0.0.1:${totPort}`,
    SYNAPSE_API_URL_RUECKFALL: `http://127.0.0.1:${apiPort}`,
    SYNAPSE_API_URL_ART: 'lan',
    SYNAPSE_NODE_STATUS_DATEI: statusDatei,
    EMBED_MIN_GAP_MS: String(EMBED_PAUSE_MS),
    SYNAPSE_API_TOKEN: 'test-service-token',
    SYNAPSE_NODE_ID: 'vorlauf-test-node',
    SYNAPSE_NODE_MAX_CONCURRENCY: '',
    // Lang: kein Heartbeat und keine periodische Vollpruefung waehrend des Tests (V4).
    SYNAPSE_NODE_HEARTBEAT_MS: '600000',
    SYNAPSE_NODE_RETRY_MS: '20',
    OLLAMA_URL: `http://127.0.0.1:${ollamaPort}`,
    OPENAI_API_KEY: 'must-never-be-used',
    DATABASE_URL: `postgresql://127.0.0.1:${pgTrapPort}/forbidden`,
    QDRANT_URL: `http://127.0.0.1:${qdrantTrapPort}`,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
const frist = (p, ms, was) => Promise.race([
  p,
  new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${was} timeout: ${stderr.slice(-2000)}`)), ms)),
]);
const ueberlappt = (a, b) => a.start < b.ende && b.start < a.ende;

try {
  await frist(zweiFertig, 20_000, 'Abschluss A und B');
  await frist(cHaengt, 10_000, 'Stapel C in Ollama');
  await frist(dGeclaimt, 10_000, 'Vorausholen von D');
  await sleep(50); // Claim-Antwort D beim Agenten ankommen lassen
  child.kill('SIGTERM');
  await frist(releaseDa, 5_000, 'Claim-Freigabe');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);

  const embed = (s) => embeds.find((e) => e.stapel === s);
  const claimVon = (s) => claimsLog.find((c) => c.stapel === s);
  const completeVon = (s) => completes.find((c) => c.stapel === s);

  // V1
  assert.ok(ueberlappt(claimVon('B'), embed('A')), `Claim B lief nicht waehrend Embed A: ${JSON.stringify({ claimB: claimVon('B'), embedA: embed('A') })}`);
  assert.ok(ueberlappt(completeVon('A'), embed('B')), `Abschluss A lief nicht waehrend Embed B: ${JSON.stringify({ completeA: completeVon('A'), embedB: embed('B') })}`);
  assert.ok(ueberlappt(claimVon('C'), embed('B')), 'Claim C lief nicht waehrend Embed B');
  assert.ok(claimVon('C').start >= completeVon('A').ende, 'Claim C vor Abschluss A - Kapazitaet waere ueberschritten');
  // Lueckenlos: Embed B beginnt praktisch direkt nach Embed A (kein Claim/Abschluss dazwischen).
  const luecke = embed('B').start - embed('A').ende;
  assert.ok(luecke < CLAIM_MS, `GPU-Luecke zwischen A und B ${luecke} ms (>= Claim-Dauer ${CLAIM_MS} ms)`);
  // V8: die Luecke ist die durchgereichte Embed-Pause (core MIN_GAP_MS), nicht der Default.
  assert.ok(luecke >= EMBED_PAUSE_MS - 5, `GPU-Luecke ${luecke} ms < Embed-Pause ${EMBED_PAUSE_MS} ms - EMBED_MIN_GAP_MS nicht angekommen?`);
  // V2
  assert.equal(maxLaufendeEmbeds, 1, 'zwei /api/embed gleichzeitig');
  // V3
  assert.ok(claimsLog.every((c) => c.limit === CLAIM_BATCH / 2), 'Stapel != halbe Kapazitaet: ' + JSON.stringify(claimsLog.map((c) => c.limit)));
  assert.deepEqual(completes.map((c) => [c.stapel, c.items]), [['A', 2], ['B', 2]]);
  // V4
  const smiAufrufe = (await readFile(smiLog, 'utf8')).split('\n').filter(Boolean).length;
  assert.equal(smiAufrufe, 1, `volle Modellpruefung (nvidia-smi) ${smiAufrufe}x statt nur beim Start`);
  assert.ok(tagsAufrufe >= 1 + completes.length, `Digest-Pruefung je Stapel fehlt (tags=${tagsAufrufe})`);
  // V5
  assert.match(stderr, new RegExp(`API http://127\\.0\\.0\\.1:${totPort} nicht erreichbar, weiter ueber http://127\\.0\\.0\\.1:${apiPort}`));
  // V6
  const erwartet = [...stapelFolge[2], ...stapelFolge[3]].map((c) => ({ chunkId: c.chunkId, claimToken: c.claimToken }));
  const sortiert = (l) => [...l].sort((a, b) => a.chunkId.localeCompare(b.chunkId));
  assert.deepEqual(sortiert(release.claims), sortiert(erwartet), 'SIGTERM hat nicht alle offenen Claims freigegeben');
  assert.equal(trapConnections, 0);
  // V7
  const status = JSON.parse(await readFile(statusDatei, 'utf8'));
  assert.equal(status.adresse, `http://127.0.0.1:${apiPort}`);
  assert.equal(status.art, 'oeffentlich');
  assert.equal(status.rueckfall_aktiv, true);
  assert.equal(status.lan_bevorzugen, true);
  assert.equal(status.embed_pause_ms, EMBED_PAUSE_MS);
  assert.deepEqual(status.adressen.map((a) => a.art), ['lan', 'oeffentlich']);
  console.log(
    `P15-T11 Vorlauf E2E: claimBatch=${CLAIM_BATCH} stapel=${CLAIM_BATCH / 2} gpu_luecke_A_B=${luecke}ms ` +
    `nvidia_smi=${smiAufrufe} tags=${tagsAufrufe} release=${release.claims.length} (rechnend+vorausgeholt) - ALLE PRUEFUNGEN GRUEN`,
  );
} finally {
  if (child.exitCode === null) child.kill('SIGKILL');
  ollama.closeAllConnections?.();
  api.closeAllConnections?.();
  await Promise.all([close(ollama), close(api), close(trapA), close(trapB)]);
  await rm(fakeBinDir, { recursive: true, force: true });
}
