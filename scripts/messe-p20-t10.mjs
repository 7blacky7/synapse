#!/usr/bin/env node
/**
 * P20-T10: reale lokale Ollama-Konkurrenz, ohne Produktivcodeänderung/Abort.
 * Nur TEST_DATABASE_URL (synapse_test:5433), explizites Loopback-Test-Ollama,
 * Referenzvertrag und GPU-UUID. Separate Core-Prozesse, kein echter Daemonstart.
 * Wissen: echter betteStapelEin-Weg mit synthetischer, eigener NachzugQuelle.
 * Knotenbulk: echter Core-embedBatch-Weg, kein vollständiger Claims-E2E.
 * HTTP-Start ist lokale Admission, NICHT beobachteter GPU-Rechenbeginn.
 */
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const PROJECT = 'p20_t10_sol1';
const TABLE = 'p20_t10_sol1_wissen';
const COLLECTION = 'project_p20_t10_sol1_thoughts';
const testDb = new URL(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '');
assert.equal(testDb.pathname, '/synapse_test', 'Nur synapse_test erlaubt');
assert.equal(testDb.port, '5433', 'Nur Testport 5433 erlaubt');
process.env.DATABASE_URL = testDb.href;
const target = new URL(process.env.P20_TEST_OLLAMA_URL || '');
assert.equal(target.hostname, '127.0.0.1');
assert.notEqual(target.port, '11434');
assert.ok(target.port, 'Expliziter Testport erforderlich');
assert.match(process.env.P20_TEST_GPU_ID || '', /^GPU-[a-f0-9-]+$/i);
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { Pool } = require('pg');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const childRole = process.argv[2];

if (childRole) {
  const send = event => process.send?.({ ...event, pid: process.pid, role: childRole, time: Date.now() });
  const originalFetch = globalThis.fetch;
  let requestId = 0;
  let runId = '';
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    const embedding = parsed.pathname === '/api/embed';
    if (embedding) {
      assert.equal(parsed.origin, target.origin, 'Embedding nur am Testbackend');
      const body = JSON.parse(options.body);
      const id = ++requestId;
      const started = Date.now();
      send({ type: 'http-start', runId, id, inputs: body.input.length });
      try {
        const response = await originalFetch(url, options);
        const data = await response.clone().json();
        send({ type: 'http-end', runId, id, started, status: response.status,
          totalDurationNs: data.total_duration ?? null, loadDurationNs: data.load_duration ?? null,
          promptEvalDurationNs: data.prompt_eval_duration ?? null,
          promptEvalCount: data.prompt_eval_count ?? null });
        return response;
      } catch (error) {
        send({ type: 'http-error', runId, id, name: error.name });
        throw error;
      }
    }
    return originalFetch(url, options);
  };
  const core = await import('../packages/core/dist/embeddings/index.js');
  const db = await import('../packages/core/dist/db/client.js');
  db.setzeDbProzess(childRole === 'background' ? 'daemon' : 'api');
  await core.embed('synthetic warmup', { strictOllama: true, art: 'query' });
  send({ type: 'ready' });
  process.on('message', async message => {
    runId = message.runId;
    try {
      if (message.type === 'stop') {
        await Promise.all([db.getPool().end(), db.getHintergrundPool().end()]);
        process.disconnect();
        return;
      }
      send({ type: 'enqueue', runId, kind: message.kind });
      if (message.kind === 'daemon-wissen') {
        const { betteStapelEin } = await import('../packages/core/dist/services/embed-nachzug.js');
        const quelle = {
          tabelle: TABLE, idSpalte: 'id', idTyp: 'uuid', standSql: 't.stand',
          async lese(ids) {
            const result = await db.getPool().query(
              'SELECT id, content, stand FROM ' + TABLE + ' WHERE id=ANY($1::uuid[])', [ids]);
            return result.rows.map(row => ({ id: row.id, project: PROJECT,
              collection: COLLECTION, text: row.content, stand: row.stand,
              payload: { project: PROJECT, content: row.content, source: 'synthetisch' } }));
          },
        };
        const count = await betteStapelEin(quelle, message.ids, { priority: 'background', strictOllama: true });
        assert.equal(count, message.ids.length);
      } else if (message.kind === 'knoten-bulk') {
        const vectors = await core.embedBatch(message.texts, { priority: 'background', strictOllama: true });
        assert.equal(vectors.length, message.texts.length);
      } else if (message.kind === 'media') {
        const supported = await core.supportsMultimodal();
        assert.equal(supported, false, 'Nemotron-Testprofil ist text-only');
        send({ type: 'media-unavailable', runId, supported });
      } else {
        await core.embed('synthetic interactive request ' + runId, { strictOllama: true, art: 'query' });
      }
      const stats = core.getEmbeddingQueueStats();
      assert.equal(stats.preemptedBackground, 0, 'Keine Background-Abbrüche erlaubt');
      send({ type: 'done', runId, stats });
    } catch (error) {
      send({ type: 'error', runId, name: error.name, message: String(error.message).slice(0, 180) });
    }
  });
} else {
  const referenceUrl = new URL(process.env.P20_REFERENCE_URL || '');
  assert.equal(referenceUrl.pathname, '/api/embedding-nodes/reference');
  const refResponse = await fetch(referenceUrl);
  assert.ok(refResponse.ok);
  const ref = (await refResponse.json()).reference;
  assert.match(ref.modelDigest, /^[a-f0-9]{64}$/);
  const tags = await (await fetch(target + 'api/tags')).json();
  const model = tags.models.find(item => item.name === ref.model);
  assert.ok(model, 'Referenzmodell fehlt');
  assert.equal(model.digest, ref.modelDigest, 'Digest muss exakt stimmen');
  const version = await (await fetch(target + 'api/version')).json();
  const gpuBefore = execFileSync('nvidia-smi', [
    '--query-gpu=uuid,name,memory.total,memory.free,utilization.gpu', '--format=csv,noheader,nounits',
  ], { encoding: 'utf8' }).trim();
  const dbPool = new Pool({ connectionString: testDb.href });
  const children = [];
  const events = [];
  const samples = [];
  const waiters = [];
  let sampling = false;
  let samplePromise;
  let tableCreated = false;
  let collectionOwned = false;
  const rounds = Number(process.env.P20_ROUNDS || 12);
  assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 30);
  const texts = Array.from({ length: 48 }, (_, index) =>
    ('Synthetic document ' + index + ' about isolated scheduling and resource measurement. ').repeat(50).slice(0, 3000));
  const ids = texts.map(() => randomUUID());
  function waitFor(predicate) {
    const known = events.find(predicate);
    if (known) return Promise.resolve(known);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) waiters.splice(at, 1);
        reject(new Error('Messereignis fehlt'));
      }, 120000);
      waiters.push(waiter);
    });
  }
  function worker(role) {
    const child = fork(fileURLToPath(import.meta.url), [role], {
      env: { ...process.env, EMBEDDING_PROVIDER: 'ollama', OLLAMA_URL: target.href.replace(/\/$/, ''),
        OLLAMA_MODEL: ref.model, SYNAPSE_OLLAMA_MODEL_DIGEST: ref.modelDigest,
        EMBEDDING_TARGET_DIM: String(ref.targetDimension), EMBEDDING_NUM_CTX: String(ref.numCtx),
        EMBEDDING_QUERY_PREFIX: ref.queryPraefix, EMBEDDING_DOC_PREFIX: ref.dokPraefix,
        EMBEDDING_MAX_INPUT_CHARS: String(ref.maxStueckZeichen),
        EMBED_OLLAMA_BATCH: '16', EMBED_MAX_CONCURRENT: process.env.P20_CORE_SLOTS || '2', EMBED_MIN_GAP_MS: '100',
        SYNAPSE_COMPUTE_NODE: '0' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(child);
    child.on('message', event => {
      events.push(event);
      for (const waiter of [...waiters]) if (waiter.predicate(event)) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(event);
      }
    });
    return child;
  }
  const records = [];
  try {
    const collectionUrl = new URL(process.env.QDRANT_URL || '');
    collectionUrl.pathname = '/collections/' + COLLECTION;
    const existing = await fetch(collectionUrl, { headers: process.env.QDRANT_API_KEY ? { 'api-key': process.env.QDRANT_API_KEY } : {} });
    assert.equal(existing.status, 404, 'Nur frische eigene Testcollection verwenden');
    collectionOwned = true;
    await dbPool.query('CREATE TABLE ' + TABLE +
      ' (id uuid PRIMARY KEY, project text NOT NULL, content text NOT NULL, stand text NOT NULL, embedded_at timestamptz)');
    tableCreated = true;
    await dbPool.query('INSERT INTO ' + TABLE +
      ' SELECT x.id, $1, x.content, x.id::text, NULL FROM unnest($2::uuid[], $3::text[]) AS x(id,content)',
      [PROJECT, ids, texts]);
    const bg = worker('background');
    const interactive = worker('interactive');
    await Promise.all([waitFor(e => e.type === 'ready' && e.pid === bg.pid),
      waitFor(e => e.type === 'ready' && e.pid === interactive.pid)]);
    sampling = true;
    samplePromise = (async () => {
      while (sampling) {
        samples.push({ time: Date.now(), gpu: execFileSync('nvidia-smi',
          ['--id=' + process.env.P20_TEST_GPU_ID, '--query-gpu=memory.used,utilization.gpu',
            '--format=csv,noheader,nounits'], { encoding: 'utf8' }).trim() });
        await sleep(200);
      }
    })();
    for (let round = 0; round < rounds; round++) {
      for (const kind of ['control', 'daemon-wissen', 'knoten-bulk']) {
        const runId = kind + '-' + round;
        if (kind !== 'control') {
          bg.send({ type: 'run', runId, kind, ids, texts });
          await waitFor(e => e.type === 'http-start' && e.runId === runId && e.pid === bg.pid);
          await sleep(75);
        }
        interactive.send({ type: 'run', runId, kind: 'interactive' });
        const done = await waitFor(e => ['done', 'error'].includes(e.type) &&
          e.runId === runId && e.pid === interactive.pid);
        assert.equal(done.type, 'done', JSON.stringify(done));
        if (kind !== 'control') {
          const bgDone = await waitFor(e => ['done', 'error'].includes(e.type) &&
            e.runId === runId && e.pid === bg.pid);
          assert.equal(bgDone.type, 'done', JSON.stringify(bgDone));
        }
        const runEvents = events.filter(e => e.runId === runId);
        const enqueue = runEvents.find(e => e.type === 'enqueue' && e.pid === interactive.pid);
        const start = runEvents.find(e => e.type === 'http-start' && e.pid === interactive.pid);
        const end = runEvents.find(e => e.type === 'http-end' && e.pid === interactive.pid);
        const bgIntervals = runEvents.filter(e => e.type === 'http-end' && e.pid === bg.pid);
        const overlap = bgIntervals.some(e => e.started < end.time && e.time > start.time);
        const record = { round, kind, localAdmissionMs: start.time - enqueue.time,
          responseMs: end.time - enqueue.time, httpMs: end.time - start.time,
          overlap, bgCalls: bgIntervals.length, bgPid: bg.pid, interactivePid: interactive.pid };
        if (kind !== 'control') assert.ok(overlap, 'Echte HTTP-Überlappung muss positiv belegt sein');
        records.push(record);
        console.log(JSON.stringify({ type: 'sample', ...record }));
      }
    }
    bg.send({ type: 'run', runId: 'media-check', kind: 'media' });
    await waitFor(e => e.type === 'media-unavailable');
    const errors = events.filter(e => ['error', 'http-error'].includes(e.type));
    assert.equal(errors.length, 0);
    function summarize(kind) {
      const chosen = records.filter(r => r.kind === kind);
      function metric(field) {
        const sorted = chosen.map(r => r[field]).sort((a, b) => a - b);
        return { p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1),
          min: sorted[0] };
      }
      return { n: chosen.length, localAdmissionMs: metric('localAdmissionMs'),
        responseMs: metric('responseMs'), overlaps: chosen.filter(r => r.overlap).length };
    }
    const report = { project: PROJECT, backend: target.origin, gpuId: process.env.P20_TEST_GPU_ID,
      model: ref.model, digest: model.digest, referenceDigest: ref.modelDigest, version: version.version,
      settings: { numCtx: ref.numCtx, coreSlots: Number(process.env.P20_CORE_SLOTS || 2), ollamaParallel: 1, batch: 16, backgroundTexts: texts.length },
      gpuBefore, summaries: Object.fromEntries(['control', 'daemon-wissen', 'knoten-bulk'].map(k => [k, summarize(k)])),
      media: 'Ollama-provider text-only; kein lokaler GPU-Mediaauftrag möglich',
      errors, preemptions: 0, records, events, samples,
      limitation: 'Core-Produzenten in isolierten Testprozessen, kein vollständiger Daemon/REST/Claims-E2E. HTTP-Überlappung plus GPU-Sampling; physischer Rechenbeginn je Request nicht beobachtbar. Lokale Admission und Antwortzeit separat.' };
    if (process.env.P20_REPORT_PATH) await writeFile(process.env.P20_REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ type: 'summary', ...report, events: undefined, samples: undefined, records: undefined }));
  } finally {
    sampling = false;
    await samplePromise;
    for (const child of children) if (child.connected) child.send({ type: 'stop', runId: 'stop' });
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', resolve);
    })));
    if (tableCreated) await dbPool.query('DROP TABLE ' + TABLE);
    await dbPool.end();
    const qdrant = new URL(process.env.QDRANT_URL || '');
    qdrant.pathname = '/collections/' + COLLECTION;
    if (collectionOwned) await fetch(qdrant, { method: 'DELETE', headers: process.env.QDRANT_API_KEY ?
      { 'api-key': process.env.QDRANT_API_KEY } : {} });
  }
}
