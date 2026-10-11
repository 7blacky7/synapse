#!/usr/bin/env node
// messung-claim-explain.mjs — P15-T12 E4: EXPLAIN (ANALYZE, BUFFERS) der Chunk-Auswahl in claimEmbeddingChunks.
//   node scripts/messung-claim-explain.mjs vorher  [projekt ...]   alte Abfragen (Stand vor E4, hier woertlich)
//   node scripts/messung-claim-explain.mjs nachher [projekt ...]   CLAIM_SQL aus packages/core/dist; fehlen die
//        E4-Spalten in der DB, legt das Skript sie IN EINER TRANSAKTION an und rollt danach zurueck.
//        ⚠️ Das haelt kurz ACCESS EXCLUSIVE auf code_chunks (lock_timeout 2 s) — Dauer steht in der Ausgabe.
// Alles laeuft in BEGIN ... ROLLBACK: FOR UPDATE sperrt nur bis zum Rollback, nichts wird geschrieben.
// Je Abfrage 3 Laeufe; ausgegeben werden Ausfuehrungszeiten, Puffer und der Plan des letzten Laufs.
import { createRequire } from 'node:module';

const modus = process.argv[2];
if (modus !== 'vorher' && modus !== 'nachher') {
  console.error('Aufruf: node scripts/messung-claim-explain.mjs vorher|nachher [projekt ...]');
  process.exit(2);
}
const projekte = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['parser-testkorpus', 'synapse'];
const LIMIT = 32; // Server: parallel 2 x Stapel 16

const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const SPALTEN = `cc.id, cc.project, cc.file_path, cf.file_type, cc.chunk_index,
              cc.content, cc.line_start, cc.line_end,
              (SELECT COUNT(*) FROM code_chunks allc
                WHERE allc.project=cc.project AND allc.file_path=cc.file_path)::int AS total_chunks`;
const ALT = {
  projektWahl: `SELECT p.name
         FROM (SELECT DISTINCT name, enabled FROM projects) p
        WHERE p.enabled
          AND EXISTS (SELECT 1 FROM code_chunks cc
                       WHERE cc.project = p.name AND cc.embedded_at IS NULL)
        ORDER BY COALESCE((SELECT e.stufe FROM embed_prioritaet e WHERE e.project = p.name), 3), random()
        LIMIT 1`,
  normal: `SELECT ${SPALTEN}
         FROM code_chunks cc
         JOIN code_files cf ON cf.project=cc.project AND cf.file_path=cc.file_path
        WHERE cc.project = $2
          AND cc.embedded_at IS NULL
          AND (cc.lease_until IS NULL OR cc.lease_until < NOW())
        ORDER BY cc.file_path, cc.chunk_index
        LIMIT $1
        FOR UPDATE OF cc SKIP LOCKED`,
};

const client = await pool.connect();
const zeilen = (r) => r.rows.map((x) => x['QUERY PLAN']);
async function erklaere(name, sql, werte) {
  const zeiten = [];
  let plan = [];
  for (let i = 0; i < 3; i++) {
    const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, werte);
    plan = zeilen(r);
    const ausf = plan.find((z) => z.startsWith('Execution Time'));
    const plan_ = plan.find((z) => z.startsWith('Planning Time'));
    zeiten.push(`${ausf?.replace('Execution Time: ', 'exec ')} / ${plan_?.replace('Planning Time: ', 'plan ')}`);
  }
  console.log(`\n=== ${modus} | ${name} | ${zeiten.join(' | ')}`);
  for (const z of plan) console.log('   ' + z);
}

try {
  await client.query("SET statement_timeout = '60s'");
  await client.query('BEGIN');
  let sql = ALT;
  if (modus === 'nachher') {
    const da = await client.query(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_name = 'code_chunks' AND column_name IN ('prio', 'zurueckgestellt_bis')`);
    if (da.rows[0].n < 2) {
      await client.query("SET LOCAL lock_timeout = '2s'");
      const t0 = Date.now();
      await client.query('ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS prio SMALLINT');
      await client.query('ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS zurueckgestellt_bis TIMESTAMPTZ');
      const t1 = Date.now();
      await client.query(`CREATE INDEX IF NOT EXISTS idx_code_chunks_prio ON code_chunks(prio DESC, project, file_path, chunk_index)
                           WHERE embedded_at IS NULL AND prio IS NOT NULL`);
      const t2 = Date.now();
      await client.query(`CREATE INDEX IF NOT EXISTS idx_code_chunks_zurueckgestellt ON code_chunks(project, zurueckgestellt_bis)
                           WHERE zurueckgestellt_bis IS NOT NULL`);
      const t3 = Date.now();
      await client.query('ALTER TABLE embed_prioritaet ADD COLUMN IF NOT EXISTS zurueckgestellt_bis TIMESTAMPTZ');
      console.log(`DDL in der Transaktion (Rollback folgt): ADD COLUMN x2 ${t1 - t0} ms, idx_code_chunks_prio ${t2 - t1} ms, idx_code_chunks_zurueckgestellt ${t3 - t2} ms`);
    } else {
      console.log('E4-Spalten sind schon da (kein DDL noetig).');
    }
    const core = await import('../packages/core/dist/services/embedding-claims.js');
    sql = core.CLAIM_SQL;
    await erklaere('schritt0 vorgezogen', sql.vorgezogen, [LIMIT]);
  }
  await erklaere('projektWahl', sql.projektWahl, []);
  for (const p of projekte) {
    await erklaere(`schritt1 normal [${p}]`, sql.normal, [LIMIT, p]);
    if (modus === 'nachher') await erklaere(`schritt2 hinten [${p}]`, sql.hinten, [LIMIT, p]);
  }
} finally {
  await client.query('ROLLBACK').catch(() => {});
  client.release();
  await pool.end();
}
