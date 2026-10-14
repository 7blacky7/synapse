/** P12-T15: dynamischer Embedding-Statushinweis, nur synapse_test. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pruefeTestDbUrl } from '../../../scripts/lib/test-db-schutz.mjs';

pruefeTestDbUrl('embedding-pending-hint-p12-t15.test');
Object.assign(process.env, {
  SYNAPSE_DATABASE_URL: process.env.DATABASE_URL,
  EMBEDDING_PRAEFIXE: 'aus',
  OLLAMA_URL: 'http://127.0.0.1:9',
  QDRANT_URL: 'http://127.0.0.1:9',
});

const { getPool, closePool } = await import('../dist/db/client.js');
const pool = getPool();
const { getEmbeddingPendingHint } = await import('../dist/services/embed-backlog.js');
const { embeddingModellKennung, sichereModellprofil } = await import('../dist/embeddings/index.js');
const project = 'p12-t15-' + randomUUID();
const fremdesProjekt = project + '-other';
const filePath = 'src/pending.ts';
const filePathAndere = 'src/other.ts';
const skipVorher = process.env.SYNAPSE_SKIP_EMBEDDINGS;

try {
  await pool.query(
    'INSERT INTO code_files (id, project, file_path, file_name, file_type) VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10)',
    [project + '-file', project, filePath, 'pending.ts', 'ts', fremdesProjekt + '-file', fremdesProjekt, filePathAndere, 'other.ts', 'ts'],
  );
  await pool.query(
    'INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end) VALUES ($1, $2, $3, 0, $4, 1, 1), ($5, $6, $7, 0, $8, 1, 1)',
    [project + '-chunk', project, filePath, 'const pending = true;', fremdesProjekt + '-chunk', fremdesProjekt, filePathAndere, 'const other = true;'],
  );

  await sichereModellprofil();
  const modell = embeddingModellKennung();
  delete process.env.SYNAPSE_SKIP_EMBEDDINGS;
  const aktiv = await getEmbeddingPendingHint(project);
  assert.equal(aktiv.embeddings_pending, true);
  assert.ok(aktiv.embeddings_hint.includes('Modell: ' + modell), aktiv.embeddings_hint);
  assert.match(aktiv.embeddings_hint, /offener Rueckstand: 1 Eintraege/, aktiv.embeddings_hint);
  assert.ok(aktiv.embeddings_hint.includes('Code-Re-Embedding/Rueckstand: 1 Chunks ohne Vektor'), aktiv.embeddings_hint);
  assert.ok(aktiv.embeddings_hint.includes('lokale Worker-Queue: '), aktiv.embeddings_hint);
  assert.match(aktiv.embeddings_hint, /Embeddings aktiv/, aktiv.embeddings_hint);

  process.env.SYNAPSE_SKIP_EMBEDDINGS = '1';
  const abgeschaltet = await getEmbeddingPendingHint(project);
  assert.ok(abgeschaltet.embeddings_hint.includes('Code-Embeddings abgeschaltet (SYNAPSE_SKIP_EMBEDDINGS=1)'), abgeschaltet.embeddings_hint);
  assert.match(abgeschaltet.embeddings_hint, /offener Rueckstand: 1 Eintraege/, abgeschaltet.embeddings_hint);
} finally {
  if (skipVorher === undefined) delete process.env.SYNAPSE_SKIP_EMBEDDINGS;
  else process.env.SYNAPSE_SKIP_EMBEDDINGS = skipVorher;
  await pool.query('DELETE FROM code_chunks WHERE project = ANY($1::text[])', [[project, fremdesProjekt]]).catch(() => {});
  await pool.query('DELETE FROM code_files WHERE project = ANY($1::text[])', [[project, fremdesProjekt]]).catch(() => {});
  await closePool();
}
