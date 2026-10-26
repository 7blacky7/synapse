/**
 * P22-T204 (Stoerung 26.10.2026): embeddings/index.ts echte HTTP-Queue gegen Ollama-Attrappe, ein Slot.
 * Zwei Suchanfragen mit Hintergrund-Prioritaet verdraengen sich nicht gegenseitig (vorher Livelock:
 * ~20 Verdraengungen/s, alle anderen Auftraege blockiert). Keine DB/LLM/Docker/Browser.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
const starts = [], pending = [];
let aborted = 0, checks = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'p204-fixture' }] })); return; }
  let text = ''; for await (const part of req) text += part;
  const body = JSON.parse(text);
  const eintrag = { res, body };
  starts.push(body.input[0]); pending.push(eintrag);
  res.on('close', () => {
    if (res.writableEnded) return;
    aborted++;
    const i = pending.indexOf(eintrag);
    if (i !== -1) pending.splice(i, 1);
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, { SYNAPSE_COMPUTE_NODE: '1', SYNAPSE_NODE_MAX_CONCURRENCY: '1',
  SYNAPSE_COMPUTE_ADMISSION: '0', EMBED_MIN_GAP_MS: '0', EMBEDDING_PROVIDER: 'ollama',
  OLLAMA_MODEL: 'p204-fixture', OLLAMA_URL: 'http://127.0.0.1:' + server.address().port,
  EMBEDDING_QUERY_PREFIX: '', EMBEDDING_DOC_PREFIX: '', EMBEDDING_NUM_CTX: '512',
  EMBEDDING_MAX_CHARS: '2048', EMBEDDING_TARGET_DIM: '4', QDRANT_URL: 'http://127.0.0.1:9' });
const emb = await import('../dist/embeddings/index.js');
const wait = async (fn, label) => { const until = Date.now() + 5000; while (!fn()) {
  if (Date.now() > until) throw Error('P22-T204 embeddings/index.ts ' + label + ' erwartet=Fortschritt ist=' + JSON.stringify({ starts, aborted }));
  await new Promise(r => setTimeout(r, 5));
} };
const complete = () => { const p = pending.shift(); p.res.end(JSON.stringify({ embeddings: p.body.input.map(() => [1,0,0,0]) })); };
const ok = (value, label) => { assert.ok(value, 'P22-T204 embeddings/index.ts ' + label + ' erwartet=true ist=' + JSON.stringify({ starts, aborted, stats: emb.getEmbeddingQueueStats() })); checks++; };
try {
  const q1 = emb.embed('q1', { priority: 'background', art: 'query' });
  await wait(() => starts.length === 1, 'q1 startet');
  const q2 = emb.embed('q2', { priority: 'background', art: 'query' });
  await wait(() => emb.embeddingWarteschlangeEintraege().length === 1, 'q2 wartet');
  ok(aborted === 0, 'laufende Suchanfrage wird nicht verdraengt');
  complete(); await q1;
  await wait(() => starts.length === 2, 'q2 startet');
  complete(); await q2;
  ok(aborted === 0 && starts.join() === 'q1,q2', 'keine gegenseitige Verdraengung, beide fertig');
  ok(emb.getEmbeddingQueueStats().preemptedBackground === 0, 'Zaehler preemptedBackground bleibt 0');
  console.log('BESTANDEN ' + checks + ' P22-T204 Livelock-Pruefungen');
} finally {
  while (pending.length) complete();
  server.closeAllConnections(); await new Promise(r => server.close(r));
}
