/**
 * P22-T193: embeddings/index.ts echte HTTP-Queue: Code > Wissen > Verlauf nach laufendem Datensatz.
 * Keine DB/LLM/Docker/Browser. Lokaler Ollama-Transport als Attrappe, ein Slot, keine Abbrueche.
 * Debug nennt Task, Quelle, erwartet/ist. PG-/Schreibwegpruefungen im ergaenzten T157-Test.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const starts = [], pending = [];
let aborted = 0, checks = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'p193-fixture' }] })); return; }
  let text = ''; for await (const part of req) text += part;
  const body = JSON.parse(text);
  starts.push(body.input[0]); pending.push({ res, body });
  res.on('close', () => { if (!res.writableEnded) aborted++; });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { SYNAPSE_COMPUTE_NODE: '1', SYNAPSE_NODE_MAX_CONCURRENCY: '1',
  SYNAPSE_COMPUTE_ADMISSION: '0', EMBED_MIN_GAP_MS: '0', EMBEDDING_PROVIDER: 'ollama',
  OLLAMA_MODEL: 'p193-fixture', OLLAMA_URL: 'http://127.0.0.1:' + server.address().port,
  EMBEDDING_QUERY_PREFIX: '', EMBEDDING_DOC_PREFIX: '', EMBEDDING_NUM_CTX: '512',
  EMBEDDING_MAX_CHARS: '2048', EMBEDDING_TARGET_DIM: '4', QDRANT_URL: 'http://127.0.0.1:9' });
const emb = await import('../dist/embeddings/index.js');
const wait = async fn => { const until = Date.now() + 5000; while (!fn()) {
  if (Date.now() > until) throw Error('P22-T193 embeddings/index.ts erwartet=Queuefortschritt ist=' + JSON.stringify(starts));
  await new Promise(r => setTimeout(r, 5));
} };
const complete = () => { const p = pending.shift(); p.res.end(JSON.stringify({ embeddings: p.body.input.map(() => [1,0,0,0]) })); };
const ok = (value, label) => { assert.ok(value, 'P22-T193 embeddings/index.ts ' + label + ' erwartet=true ist=' + JSON.stringify({ starts, aborted })); checks++; };
try {
  const running = emb.embed('verlauf-laeuft', { priority: 'background', admissionSource: 'verlauf' });
  await wait(() => starts.length === 1);
  const history = emb.embed('verlauf-wartet', { priority: 'background', admissionSource: 'verlauf' });
  const knowledge = emb.embed('wissen', { priority: 'interactive', admissionSource: 'wissen:thoughts' });
  const code = emb.embed('code', { priority: 'background', admissionSource: 'parser-worker' });
  await wait(() => emb.embeddingWarteschlangeEintraege().length === 3);
  ok(starts.length === 1 && aborted === 0, 'laufender Verlaufsdatensatz wird nicht abgebrochen');
  assert.deepEqual(emb.embeddingWarteschlangeEintraege().map(e => e.klasse), ['code','wissen','verlauf']); checks++;
  complete(); await running;
  await wait(() => starts.length === 2); ok(starts[1] === 'code', 'neuer Code vor wartendem Wissen und Verlauf');
  complete(); await code;
  await wait(() => starts.length === 3); ok(starts[2] === 'wissen', 'Wissen nach Code, vor Verlauf');
  complete(); await knowledge;
  await wait(() => starts.length === 4); ok(starts[3] === 'verlauf-wartet', 'Verlauf nach hoeherer Arbeit ohne Altersfenster');
  complete(); await history;
  ok(aborted === 0 && emb.getEmbeddingQueueStats().active.background === 0, 'keine Wiederholung/Abbrueche, Slots freigegeben');
  console.log('BESTANDEN ' + checks + ' P22-T193 echte Queue-Vertragspruefungen');
} finally {
  while (pending.length) complete();
  server.closeAllConnections(); await new Promise(r => server.close(r));
}
