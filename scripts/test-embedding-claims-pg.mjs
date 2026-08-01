import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const pg = require('pg');

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const table = `gpu2_claim_test_${process.pid}_${Date.now()}`;
if (!/^[a-z0-9_]+$/.test(table)) throw new Error('unsafe test table name');
const q = `"${table}"`;
let created = false;

try {
  await pool.query(`CREATE UNLOGGED TABLE ${q} (
    id integer PRIMARY KEY,
    embedded_at timestamptz,
    lease_until timestamptz,
    claimed_by text,
    chunk_index integer,
    content_hash text
  )`);
  created = true;
  await pool.query(
    `INSERT INTO ${q}(id, chunk_index, content_hash)
     SELECT id, id-1, 'v1' FROM generate_series(1, 4) AS id`,
  );

  const a = await pool.connect();
  const b = await pool.connect();
  try {
    await a.query('BEGIN');
    await b.query('BEGIN');
    const first = await a.query(
      `SELECT id FROM ${q}
        WHERE embedded_at IS NULL AND (lease_until IS NULL OR lease_until < NOW())
        ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED`,
    );
    const second = await b.query(
      `SELECT id FROM ${q}
        WHERE embedded_at IS NULL AND (lease_until IS NULL OR lease_until < NOW())
        ORDER BY id LIMIT 2 FOR UPDATE SKIP LOCKED`,
    );
    const ids = [...first.rows, ...second.rows].map((row) => row.id);
    assert.deepEqual(first.rows.map((row) => row.id), [1, 2]);
    assert.deepEqual(second.rows.map((row) => row.id), [3, 4]);
    assert.equal(new Set(ids).size, 4);
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
  } finally {
    a.release();
    b.release();
  }

  await pool.query(
    `UPDATE ${q}
        SET claimed_by='dead-node', lease_until=NOW()-INTERVAL '1 second'
      WHERE id=1`,
  );
  const reclaim = await pool.query(
    `UPDATE ${q}
        SET claimed_by='replacement', lease_until=NOW()+INTERVAL '2 minutes'
      WHERE id IN (
        SELECT id FROM ${q}
         WHERE embedded_at IS NULL AND lease_until < NOW()
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, claimed_by, lease_until > NOW() AS live`,
  );
  assert.deepEqual(reclaim.rows, [{ id: 1, claimed_by: 'replacement', live: true }]);

  const expectedSnapshot = JSON.stringify(Array.from({ length: 4 }, (_unused, index) => ({
    chunk_index: index,
    content_hash: 'v1',
  })));
  const snapshotBefore = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM jsonb_to_recordset($1::jsonb)
                     AS expected(chunk_index int, content_hash text)
               WHERE expected.chunk_index=cc.chunk_index
                 AND expected.content_hash=cc.content_hash
            ))::int AS matching
       FROM ${q} cc`,
    [expectedSnapshot],
  );
  assert.deepEqual(snapshotBefore.rows, [{ total: 4, matching: 4 }]);
  await pool.query(`UPDATE ${q} SET content_hash='v2' WHERE id=2`);
  const snapshotAfter = await pool.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM jsonb_to_recordset($1::jsonb)
                     AS expected(chunk_index int, content_hash text)
               WHERE expected.chunk_index=cc.chunk_index
                 AND expected.content_hash=cc.content_hash
            ))::int AS matching
       FROM ${q} cc`,
    [expectedSnapshot],
  );
  assert.deepEqual(snapshotAfter.rows, [{ total: 4, matching: 3 }]);
  const staleReuse = await pool.query(
    `UPDATE ${q} cc SET embedded_at=NOW()
       FROM jsonb_to_recordset($1::jsonb) AS reused(id int, content_hash text)
      WHERE cc.id=reused.id AND cc.content_hash=reused.content_hash`,
    [JSON.stringify([{ id: 2, content_hash: 'v1' }])],
  );
  assert.equal(staleReuse.rowCount, 0);
  const currentReuse = await pool.query(
    `UPDATE ${q} cc SET embedded_at=NOW()
       FROM jsonb_to_recordset($1::jsonb) AS reused(id int, content_hash text)
      WHERE cc.id=reused.id AND cc.content_hash=reused.content_hash`,
    [JSON.stringify([{ id: 2, content_hash: 'v2' }])],
  );
  assert.equal(currentReuse.rowCount, 1);
  console.log('GPU-2 real PG: disjoint=[1,2]/[3,4] stale_reclaim=1 snapshot=4/4->3/4 stale_reuse_ack=0 current_reuse_ack=1');
} finally {
  if (created) await pool.query(`DROP TABLE IF EXISTS ${q}`);
  await pool.end();
}
