#!/usr/bin/env node
// test-claims-t24-t25.mjs — P15-T24/T25 gegen die TEST-DB (braucht das E4-Schema, core gebaut).
//   K1 zwei gleichzeitige Knoten: jeder Chunk genau einmal geclaimt, keiner uebersprungen, keiner doppelt
//   K2 Reihenfolge ein Knoten: Stufe vor Stufe, darin file_path, chunk_index (wie vorher)
//   K3 totalChunks/fileType je Claim gleich der alten Zeilen-Unterabfrage bzw. code_files
//   K4 Token/Lease/Fence: claim_token, claimed_by, content_hash, lease_until, claim_attempt in der DB wie im Claim
//   K5 T25 alle Chunks von A geleast (anderer Knoten): Claim liefert B statt leer; alte Projektwahl haette A gewaehlt
//   K6 T25 alle Chunks von A zurueckgestellt: Claim liefert B
//   K7 T25 Chunks von A von einer anderen Transaktion gesperrt: naechstes Projekt in derselben Runde
//   K8 nichts claimbar: leere Antwort, keine Endlosschleife
// Aufruf: set -a; . <test-db.env>; set +a; node scripts/test-claims-t24-t25.mjs
import assert from 'node:assert/strict';

if (!/:5433\/synapse_test(\?|$)/.test(process.env.DATABASE_URL ?? '')) {
  console.error('ABBRUCH: DATABASE_URL zeigt nicht auf die Test-DB (:5433/synapse_test).');
  process.exit(2);
}
const core = await import('../packages/core/dist/index.js');
const { CLAIM_SQL, claimEmbeddingChunks } = await import('../packages/core/dist/services/embedding-claims.js');
const pool = core.getPool();
const A = 'p15-t24-a';
const B = 'p15-t24-b';
const KNOTEN = ['p15-t24-k1', 'p15-t24-k2', 'p15-t24-k3'];
let ok = 0;
const pruefe = (bed, name, info) => {
  if (!bed) {
    console.error('FEHLER ' + name, info === undefined ? '' : JSON.stringify(info, null, 2).slice(0, 2500));
    process.exitCode = 1;
    throw new Error(name);
  }
  ok++;
  console.log('OK  ' + name);
};
const ALT_PROJEKTWAHL = `SELECT p.name
         FROM (SELECT DISTINCT name, enabled FROM projects) p
        WHERE p.enabled
          AND EXISTS (SELECT 1 FROM code_chunks cc
                       WHERE cc.project = p.name AND cc.embedded_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM embed_prioritaet z
                           WHERE z.project = p.name AND z.zurueckgestellt_bis > NOW())
        ORDER BY COALESCE((SELECT e.stufe FROM embed_prioritaet e WHERE e.project = p.name), 3), random()
        LIMIT 1`;
// Dateien: A/a1.ts (23 Chunks, typescript), A/a2.py (9, python), B/b1.go (11, go)
const DATEIEN = [[A, 'src/a1.ts', 'typescript', 23], [A, 'src/a2.py', 'python', 9], [B, 'src/b1.go', 'go', 11]];
const GESAMT = DATEIEN.reduce((s, d) => s + d[3], 0);
const cid = (p, f, i) => `${p}|${f}|${i}`;
const freigeben = () => pool.query(`UPDATE code_chunks SET claimed_by = NULL, claim_token = NULL, lease_until = NULL,
  zurueckgestellt_bis = NULL, claim_attempt = 0 WHERE project = ANY($1::text[])`, [[A, B]]);
const schluessel = (c) => `${c.project}:${c.filePath}#${c.chunkIndex}`;

async function aufraeumen() {
  for (const p of [A, B]) {
    await pool.query('DELETE FROM code_chunks WHERE project = $1', [p]);
    await pool.query('DELETE FROM code_files WHERE project = $1', [p]);
    await pool.query('DELETE FROM projects WHERE name = $1', [p]);
    await pool.query('DELETE FROM embed_prioritaet WHERE project = $1', [p]);
  }
}

try {
  await aufraeumen();
  if ((await core.leseSchalter('embedding')).aktiv) throw new Error('PG-Schalter embedding in der Test-DB aktiv - Claims waeren leer');
  const andere = await pool.query(`SELECT count(*)::int AS n FROM (SELECT DISTINCT name FROM projects WHERE enabled) p
    WHERE EXISTS (SELECT 1 FROM code_chunks c WHERE c.project = p.name AND c.embedded_at IS NULL)`);
  if (andere.rows[0].n > 0) throw new Error(`Test-DB hat ${andere.rows[0].n} andere Projekte mit offenen Chunks - Ergebnis waere nicht eindeutig`);
  for (const p of [A, B]) await pool.query(`INSERT INTO projects (name, hostname, path, enabled) VALUES ($1, 'test', '/tmp/' || $1, true)`, [p]);
  await pool.query(`INSERT INTO embed_prioritaet (project, stufe, gesetzt_von) VALUES ($1, 1, 'test'), ($2, 2, 'test')`, [A, B]);
  for (const [p, f, typ, n] of DATEIEN) {
    await pool.query(`INSERT INTO code_files (id, project, file_path, file_name, file_type, content, parsed_at, parser_version)
       VALUES ($1, $2, $3, $3, $4, 'x', NOW(), 999)`, [`${p}|${f}`, p, f, typ]);
    for (let i = 0; i < n; i++) {
      await pool.query(`INSERT INTO code_chunks (id, project, file_path, chunk_index, content, line_start, line_end)
         VALUES ($1, $2, $3, $4, 'inhalt ' || $1, $4 + 1, $4 + 1)`, [cid(p, f, i), p, f, i]);
    }
  }
  const erwartet = (await pool.query(`SELECT id FROM code_chunks WHERE project = ANY($1::text[])
    ORDER BY CASE project WHEN $2 THEN 1 ELSE 2 END, file_path, chunk_index`, [[A, B], A])).rows.map((r) => r.id);

  // K1 zwei gleichzeitige Knoten (und ein dritter), Stapel 5, bis nichts mehr kommt
  const jeKnoten = new Map(KNOTEN.map((k) => [k, []]));
  const runde = async (k) => {
    for (;;) {
      const c = await claimEmbeddingChunks(k, { limit: 5, maxConcurrent: 1000, leaseSeconds: 120 });
      if (c.length === 0) return;
      jeKnoten.get(k).push(c);
    }
  };
  await Promise.all(KNOTEN.map(runde));
  const alle = [...jeKnoten.values()].flat(2);
  const ids = alle.map((c) => c.chunkId);
  pruefe(ids.length === GESAMT && new Set(ids).size === GESAMT && erwartet.every((id) => ids.includes(id)),
    `K1 drei gleichzeitige Knoten: ${GESAMT} Chunks je genau einmal, keiner fehlt`, { anzahl: ids.length, eindeutig: new Set(ids).size });
  const stapel = [...jeKnoten.values()].flat();
  pruefe(stapel.every((s) => new Set(s.map((c) => c.project)).size === 1),
    'K1 jeder Stapel aus genau einem Projekt (wie vorher)');
  pruefe(stapel.every((s) => s.every((c, i) => i === 0 || `${s[i - 1].filePath}\u0000${String(s[i - 1].chunkIndex).padStart(6, '0')}` < `${c.filePath}\u0000${String(c.chunkIndex).padStart(6, '0')}`)),
    'K1 innerhalb jedes Stapels aufsteigend nach file_path, chunk_index');
  const db1 = await pool.query(`SELECT count(*)::int AS n, count(DISTINCT claim_token)::int AS t FROM code_chunks
    WHERE project = ANY($1::text[]) AND claim_token IS NOT NULL AND lease_until > NOW() AND claim_attempt = 1`, [[A, B]]);
  pruefe(db1.rows[0].n === GESAMT && db1.rows[0].t === GESAMT, 'K1 DB: jeder Chunk genau ein Claim (claim_attempt 1, eigenes Token)', db1.rows[0]);

  // K2 Reihenfolge, ein Knoten
  await freigeben();
  const folge = [];
  for (;;) {
    const c = await claimEmbeddingChunks(KNOTEN[0], { limit: 4, maxConcurrent: 1000, leaseSeconds: 120 });
    if (c.length === 0) break;
    folge.push(...c);
  }
  pruefe(JSON.stringify(folge.map((c) => c.chunkId)) === JSON.stringify(erwartet),
    'K2 ein Knoten: Stufe 1 (A) vor Stufe 2 (B), darin file_path, chunk_index', { folge: folge.map(schluessel).slice(0, 50) });

  // K3 totalChunks / fileType
  const alt = new Map((await pool.query(`SELECT cc.id, cf.file_type,
      (SELECT COUNT(*) FROM code_chunks allc WHERE allc.project=cc.project AND allc.file_path=cc.file_path)::int AS total_chunks
     FROM code_chunks cc JOIN code_files cf ON cf.project=cc.project AND cf.file_path=cc.file_path
    WHERE cc.project = ANY($1::text[])`, [[A, B]])).rows.map((r) => [r.id, r]));
  pruefe(folge.every((c) => alt.get(c.chunkId).total_chunks === c.totalChunks && alt.get(c.chunkId).file_type === c.fileType),
    'K3 totalChunks und fileType gleich der alten Zeilen-Abfrage (23/9/11, typescript/python/go)',
    folge.filter((c) => alt.get(c.chunkId).total_chunks !== c.totalChunks || alt.get(c.chunkId).file_type !== c.fileType).slice(0, 5));

  // K4 Token/Lease/Fence
  const zeilen = new Map((await pool.query(`SELECT id, claim_token, claimed_by, content_hash, lease_until, claim_attempt, content
    FROM code_chunks WHERE project = ANY($1::text[])`, [[A, B]])).rows.map((r) => [r.id, r]));
  pruefe(folge.every((c) => {
    const z = zeilen.get(c.chunkId);
    return z.claim_token === c.claimToken && z.claimed_by === KNOTEN[0] && z.content_hash === c.contentHash
      && c.contentHash === core.embeddingContentHash(z.content) && new Date(z.lease_until).toISOString() === c.leaseUntil
      && z.claim_attempt === c.claimAttempt && c.claimAttempt === 1;
  }), 'K4 DB-Zeile = Claim: Token, Knoten, Hash, Lease, claim_attempt (Freigabe setzt im Test auf 0 zurueck)');

  // K5 alle A-Chunks von einem anderen Knoten geleast
  await freigeben();
  const k5a = await claimEmbeddingChunks(KNOTEN[1], { limit: 100, maxConcurrent: 1000, leaseSeconds: 120 });
  pruefe(k5a.length === 32 && k5a.every((c) => c.project === A), 'K5 Knoten 2 haelt alle 32 Chunks von A', k5a.length);
  const altWahl = (await pool.query(ALT_PROJEKTWAHL)).rows[0]?.name;
  const neuWahl = (await pool.query(CLAIM_SQL.projektWahl, [[]])).rows[0]?.name;
  pruefe(altWahl === A && neuWahl === B, 'K5 alte Projektwahl haette A (nichts claimbar) gewaehlt, neue waehlt B', { altWahl, neuWahl });
  const k5b = await claimEmbeddingChunks(KNOTEN[2], { limit: 5, maxConcurrent: 1000, leaseSeconds: 120 });
  pruefe(k5b.length === 5 && k5b.every((c) => c.project === B) && k5b[0].chunkIndex === 0, 'K5 Knoten 3 bekommt B#0..4 statt einer leeren Runde', k5b.map(schluessel));

  // K6 alle A-Chunks zurueckgestellt
  await freigeben();
  await pool.query(`UPDATE code_chunks SET zurueckgestellt_bis = NOW() + INTERVAL '10 minutes' WHERE project = $1`, [A]);
  const k6 = await claimEmbeddingChunks(KNOTEN[0], { limit: 3, maxConcurrent: 1000, leaseSeconds: 120 });
  pruefe(k6.length === 3 && k6.every((c) => c.project === B), 'K6 A zurueckgestellt -> B', k6.map(schluessel));

  // K7 A-Chunks von einer anderen Transaktion gesperrt (SKIP LOCKED) -> naechstes Projekt in derselben Runde
  await freigeben();
  const sperre = await pool.connect();
  try {
    await sperre.query('BEGIN');
    await sperre.query('SELECT id FROM code_chunks WHERE project = $1 FOR UPDATE', [A]);
    const wahl = (await pool.query(CLAIM_SQL.projektWahl, [[]])).rows[0]?.name;
    const k7 = await claimEmbeddingChunks(KNOTEN[0], { limit: 4, maxConcurrent: 1000, leaseSeconds: 120 });
    pruefe(wahl === A && k7.length === 4 && k7.every((c) => c.project === B), 'K7 Projektwahl nimmt A (sieht claimbar), Runde liefert trotzdem B', { wahl, k7: k7.map(schluessel) });
  } finally {
    await sperre.query('ROLLBACK').catch(() => {});
    sperre.release();
  }

  // K8 nichts claimbar
  await freigeben();
  await pool.query(`UPDATE code_chunks SET zurueckgestellt_bis = NOW() + INTERVAL '10 minutes' WHERE project = ANY($1::text[])`, [[A, B]]);
  const t0 = Date.now();
  const k8 = await claimEmbeddingChunks(KNOTEN[0], { limit: 4, maxConcurrent: 1000, leaseSeconds: 120 });
  pruefe(k8.length === 0 && (await pool.query(CLAIM_SQL.projektWahl, [[]])).rows.length === 0, `K8 nichts claimbar -> leer (${Date.now() - t0} ms), Projektwahl leer`);

  console.log(`ALLE PRUEFUNGEN GRUEN (${ok})`);
} finally {
  await aufraeumen().catch(() => {});
  await core.closePool?.();
}
