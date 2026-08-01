#!/usr/bin/env node
/**
 * GPU-4 Regressionstest: beweist Vorrang zwischen einzelnen Ollama-Texten,
 * QueueFull-Zahlen, Scheduler-Metriken und vollstaendige Bulk-Ergebnisse.
 *
 * Vorher-Gegenprobe auf main 4138feb:
 *   interaktiv nach 220 ms im Timeout; Reihenfolge bg-1..bg-4,interactive.
 */
import http from 'node:http';
import assert from 'node:assert/strict';

const PORT = 17884;
process.env.EMBEDDING_PROVIDER = 'ollama';
process.env.OLLAMA_MODEL = 'gpu4-test';
process.env.OLLAMA_URL = `http://127.0.0.1:${PORT}`;
process.env.EMBED_MAX_CONCURRENT = '1';
process.env.EMBED_MIN_GAP_MS = '0';
process.env.EMBED_INTERACTIVE_QUEUE_LIMIT = '2';
process.env.EMBED_INTERACTIVE_MAX_WAIT_MS = '2000';
process.env.EMBED_ESTIMATED_CALL_MS = '90';

const order = [];
const promptWaiters = new Map();

function notifyPrompt(prompt) {
  const waiter = promptWaiters.get(prompt);
  if (waiter) {
    promptWaiters.delete(prompt);
    waiter();
  }
}

function waitForPrompt(prompt) {
  if (order.includes(prompt)) return Promise.resolve();
  return new Promise((resolve) => promptWaiters.set(prompt, resolve));
}

const server = http.createServer((request, response) => {
  if (request.url === '/api/tags') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ models: [{ name: 'gpu4-test' }] }));
    return;
  }
  if (request.url !== '/api/embeddings') {
    response.statusCode = 404;
    response.end();
    return;
  }

  let raw = '';
  request.on('data', (chunk) => { raw += chunk; });
  request.on('end', () => {
    const prompt = JSON.parse(raw).prompt;
    order.push(prompt);
    notifyPrompt(prompt);
    setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ embedding: [1, 0, 0] }));
    }, 90);
  });
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

try {
  const {
    embed,
    embedBatch,
    EmbeddingQueueFullError,
    getEmbeddingQueueStats,
  } = await import('../packages/core/dist/embeddings/index.js');

  const bulk = embedBatch(
    ['bg-1', 'bg-2', 'bg-3', 'bg-4'],
    { priority: 'background' },
  );
  await waitForPrompt('bg-1');

  const interactive = embed('interactive');
  const outcome = await Promise.race([
    interactive.then(() => 'completed'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 220)),
  ]);
  const [bulkVectors] = await Promise.all([bulk, interactive]);

  assert.equal(outcome, 'completed', 'Interaktiv wartete laenger als ein laufender Text');
  assert.deepEqual(
    order.slice(0, 5),
    ['bg-1', 'interactive', 'bg-2', 'bg-3', 'bg-4'],
    'Vorrang-Reihenfolge stimmt nicht',
  );
  assert.equal(bulkVectors.length, 4, 'Bulk-Ergebnis verlor Texte');
  assert.ok(bulkVectors.every((vector) => vector.length === 3), 'Bulk-Vektor unvollstaendig');

  const timeoutBlocker = embed('timeout-blocker', { priority: 'background' });
  await waitForPrompt('timeout-blocker');
  const beforeTimed = embed('before-timed', { priority: 'background' });
  const timed = embed('timed', { priority: 'background', maxQueueWaitMs: 20 }).then(
    () => null,
    (error) => error,
  );
  const afterTimed = embed('after-timed', { priority: 'background' });
  const timeoutError = await timed;
  assert.ok(timeoutError instanceof EmbeddingQueueFullError, 'Timeout ist nicht typisiert');
  assert.equal(timeoutError.ahead, 2, 'Spaetere Jobs wurden als vor Timeout-Job gezaehlt');
  assert.ok(timeoutError.estimatedWaitMs > 0, 'Timeout-ETA fehlt');
  await Promise.all([timeoutBlocker, beforeTimed, afterTimed]);

  const blocker = embed('blocker', { priority: 'background' });
  await waitForPrompt('blocker');
  const queued1 = embed('q-1');
  const queued2 = embed('q-2');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const liveStats = getEmbeddingQueueStats();
  assert.equal(liveStats.active.background, 1, 'Aktive Background-Metrik fehlt');
  assert.equal(liveStats.queued.interactive, 2, 'Live-Queue-Metrik stimmt nicht');
  assert.ok(liveStats.currentLongestWaitMs.interactive > 0, 'Live-Wartezeit fehlt');

  const rejected = embed('q-3').then(
    () => null,
    (error) => error,
  );

  const queueError = await rejected;
  assert.ok(queueError instanceof EmbeddingQueueFullError, 'Kein typisierter QueueFull-Fehler');
  assert.equal(queueError.code, 'EMBEDDING_QUEUE_FULL');
  assert.equal(queueError.priority, 'interactive');
  assert.equal(queueError.ahead, 3, 'Auftraege-vor-dir stimmen nicht');
  assert.ok(queueError.estimatedWaitMs > 0, 'ETA fehlt');

  const failFast = await embed('hook-skip', { maxQueueWaitMs: 0 }).then(
    () => null,
    (error) => error,
  );
  assert.ok(failFast instanceof EmbeddingQueueFullError, 'Fail-fast ist nicht typisiert');

  await Promise.all([blocker, queued1, queued2]);

  const stats = getEmbeddingQueueStats();
  assert.equal(stats.active.interactive + stats.active.background, 0);
  assert.equal(stats.queued.interactive + stats.queued.background, 0);
  assert.ok(stats.completed.background >= 8);
  assert.ok(stats.completed.interactive >= 3);
  assert.ok(stats.rejected.interactive >= 2);
  assert.ok(stats.longestWaitMs.interactive > 0);
  assert.ok(stats.averageCallMs > 0);

  console.error(JSON.stringify({
    success: true,
    priorityOrder: order.slice(0, 5),
    queueFull: {
      code: queueError.code,
      ahead: queueError.ahead,
      estimatedWaitMs: queueError.estimatedWaitMs,
    },
    timeoutAhead: timeoutError.ahead,
    liveStats,
    stats,
  }));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
