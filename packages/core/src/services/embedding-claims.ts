import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../db/client.js';
import { ensureProjectCollection } from '../qdrant/collections.js';
import { insertVector } from '../qdrant/operations.js';
import type { CodeChunkPayload } from '../types/index.js';
import { deterministicChunkPointId, embeddingContentHash } from './embedding-chunk-id.js';

export interface EmbeddingChunkClaim {
  chunkId: string;
  claimToken: string;
  claimAttempt: number;
  project: string;
  filePath: string;
  fileType: string;
  chunkIndex: number;
  totalChunks: number;
  content: string;
  contentHash: string;
  lineStart: number;
  lineEnd: number;
  leaseUntil: string;
}

export interface CompleteEmbeddingClaimInput {
  nodeId: string;
  chunkId: string;
  claimToken: string;
  contentHash: string;
  vector: number[];
  expectedDimension?: number;
}

export interface CompleteEmbeddingClaimResult {
  completed: boolean;
  alreadyCompleted: boolean;
  pointId: string;
}

export interface ClaimOptions {
  limit?: number;
  leaseSeconds?: number;
  /** Server-authoritative parallel claim cap for this node. */
  maxConcurrent?: number;
}

type QueryResult<T> = { rows: T[]; rowCount?: number | null };
export type EmbeddingClaimsDbClient = {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
};
export type EmbeddingClaimsDbPool = {
  connect(): Promise<EmbeddingClaimsDbClient>;
};

export interface CompleteEmbeddingDependencies {
  pool?: EmbeddingClaimsDbPool;
  ensureCollection?: (project: string, vectorSize: number) => Promise<string>;
  writeVector?: (
    collection: string,
    vector: number[],
    payload: CodeChunkPayload,
    pointId: string,
  ) => Promise<void>;
}

function boundedInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value == null || value <= 0) return fallback;
  return Math.min(value, max);
}

export function validateEmbeddingVector(vector: unknown, expectedDimension = 3072): vector is number[] {
  if (!Array.isArray(vector) || vector.length !== expectedDimension) return false;
  let normSq = 0;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    normSq += value * value;
  }
  return Number.isFinite(normSq) && normSq > 0;
}

export async function claimEmbeddingChunks(
  nodeId: string,
  options: ClaimOptions = {},
  pool: EmbeddingClaimsDbPool = getPool() as unknown as EmbeddingClaimsDbPool,
): Promise<EmbeddingChunkClaim[]> {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(nodeId)) throw new Error('invalid_node_id');
  const requestedLimit = boundedInt(options.limit, 1, 100);
  const leaseSeconds = boundedInt(options.leaseSeconds, 120, 900);
  const maxConcurrent = boundedInt(options.maxConcurrent, 2, 100);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Kapazitaetspruefung und Claim sind pro Node atomar. Ohne diesen Lock
    // koennen zwei Transaktionen gleichzeitig COUNT=0 sehen und gemeinsam das
    // server-autorisierte maxConcurrent ueberschreiten.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `embedding-node:${nodeId}`,
    ]);
    const active = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM code_chunks
        WHERE claimed_by=$1 AND embedded_at IS NULL AND lease_until >= NOW()`,
      [nodeId],
    );
    const capacity = Math.max(0, maxConcurrent - Number(active.rows[0]?.count ?? 0));
    const limit = Math.min(requestedLimit, capacity);
    if (limit === 0) {
      await client.query('COMMIT');
      return [];
    }
    // ZWEISTUFIG: ERST DAS PROJEKT, DANN DESSEN CHUNKS.
    //
    // ⚠️ Hier stand bis zum 01.08.2026 EINE Abfrage ueber alle offenen Chunks mit
    // `ORDER BY cf.updated_at`. Gemessen mit EXPLAIN ANALYZE: 7,9 SEKUNDEN je
    // Runde. Sie materialisierte 436.590 Zeilen, verwarf 28,8 Mio Zeilenpaare im
    // Join-Filter gegen projects und sortierte alles per top-N — um zwei Zeilen
    // zurueckzugeben. Das war der Durchsatzengpass: bei 0,4 s je Embedding
    // wartete die GPU rund zwanzigmal so lange auf die Auswahl wie aufs Rechnen.
    // Der Sortierschluessel aus code_files zwang den Join und machte jeden
    // partiellen Index auf code_chunks unbrauchbar.
    //
    // Die Projektauswahl kostet ueber idx_code_chunks_unembedded fast nichts, und
    // die Chunk-Auswahl laeuft danach ueber idx_code_chunks_claim_ordnung mit
    // frueher Abbruchmoeglichkeit. Nebeneffekt, fachlich erwuenscht: ein Knoten
    // arbeitet eine Datei am Stueck ab statt quer durch den Bestand zu springen.
    const projektWahl = await client.query<{ name: string }>(
      `SELECT p.name
         FROM (SELECT DISTINCT name, enabled FROM projects) p
        WHERE p.enabled
          AND EXISTS (SELECT 1 FROM code_chunks cc
                       WHERE cc.project = p.name AND cc.embedded_at IS NULL)
        ORDER BY random()
        LIMIT 1`,
    );
    const projekt = projektWahl.rows[0]?.name;
    if (!projekt) {
      await client.query('COMMIT');
      return [];
    }

    const selected = await client.query<{
      id: string;
      project: string;
      file_path: string;
      file_type: string;
      chunk_index: number;
      content: string;
      line_start: number;
      line_end: number;
      total_chunks: number;
    }>(
      `SELECT cc.id, cc.project, cc.file_path, cf.file_type, cc.chunk_index,
              cc.content, cc.line_start, cc.line_end,
              (SELECT COUNT(*) FROM code_chunks allc
                WHERE allc.project=cc.project AND allc.file_path=cc.file_path)::int AS total_chunks
         FROM code_chunks cc
         JOIN code_files cf ON cf.project=cc.project AND cf.file_path=cc.file_path
        WHERE cc.project = $2
          AND cc.embedded_at IS NULL
          AND (cc.lease_until IS NULL OR cc.lease_until < NOW())
        ORDER BY cc.file_path, cc.chunk_index
        LIMIT $1
        FOR UPDATE OF cc SKIP LOCKED`,
      [limit, projekt],
    );

    const claims: EmbeddingChunkClaim[] = [];
    for (const row of selected.rows) {
      const contentHash = embeddingContentHash(row.content);
      const claimToken = uuidv4();
      const updated = await client.query<{ claim_attempt: number; lease_until: Date }>(
        `UPDATE code_chunks
            SET content_hash=$2, claim_token=$3, claimed_by=$4,
                lease_until=NOW()+($5::int * INTERVAL '1 second'),
                claim_attempt=claim_attempt+1
          WHERE id=$1 AND embedded_at IS NULL
          RETURNING claim_attempt, lease_until`,
        [row.id, contentHash, claimToken, nodeId, leaseSeconds],
      );
      const state = updated.rows[0];
      if (!state) continue;
      claims.push({
        chunkId: row.id,
        claimToken,
        claimAttempt: state.claim_attempt,
        project: row.project,
        filePath: row.file_path,
        fileType: row.file_type,
        chunkIndex: row.chunk_index,
        totalChunks: row.total_chunks,
        content: row.content,
        contentHash,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        leaseUntil: new Date(state.lease_until).toISOString(),
      });
    }
    await client.query('COMMIT');
    return claims;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function completeEmbeddingClaim(
  input: CompleteEmbeddingClaimInput,
  dependencies: CompleteEmbeddingDependencies = {},
): Promise<CompleteEmbeddingClaimResult> {
  if (!validateEmbeddingVector(input.vector, input.expectedDimension ?? 3072)) {
    throw new Error('invalid_embedding_vector');
  }
  const pool = dependencies.pool ?? (getPool() as unknown as EmbeddingClaimsDbPool);
  const ensureCollection = dependencies.ensureCollection ?? ensureProjectCollection;
  const writeVector = dependencies.writeVector ?? (async (collection, vector, payload, pointId) => {
    await insertVector(collection, vector, payload, pointId);
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const key = await client.query<{ project: string; file_path: string }>(
      'SELECT project, file_path FROM code_chunks WHERE id=$1',
      [input.chunkId],
    );
    if (!key.rows[0]) throw new Error('claim_not_found');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `chunks:${key.rows[0].project}:${key.rows[0].file_path}`,
    ]);

    const current = await client.query<{
      id: string;
      project: string;
      file_path: string;
      file_type: string;
      chunk_index: number;
      content: string;
      content_hash: string | null;
      line_start: number;
      line_end: number;
      claim_token: string | null;
      claimed_by: string | null;
      lease_until: Date | null;
      embedded_at: Date | null;
      total_chunks: number;
      server_now: Date;
    }>(
      `SELECT cc.id, cc.project, cc.file_path, cf.file_type, cc.chunk_index,
              cc.content, cc.content_hash, cc.line_start, cc.line_end,
              cc.claim_token, cc.claimed_by, cc.lease_until, cc.embedded_at,
              (SELECT COUNT(*) FROM code_chunks allc
                WHERE allc.project=cc.project AND allc.file_path=cc.file_path)::int AS total_chunks,
              NOW() AS server_now
         FROM code_chunks cc
         JOIN code_files cf ON cf.project=cc.project AND cf.file_path=cc.file_path
        WHERE cc.id=$1
        FOR UPDATE OF cc`,
      [input.chunkId],
    );
    const row = current.rows[0];
    if (!row) throw new Error('claim_not_found');
    const pointId = deterministicChunkPointId(row.project, row.file_path, row.chunk_index, row.content);
    const actualHash = embeddingContentHash(row.content);
    if (
      row.claim_token !== input.claimToken ||
      row.claimed_by !== input.nodeId ||
      row.content_hash !== input.contentHash ||
      actualHash !== input.contentHash
    ) throw new Error('claim_fence_rejected');

    if (row.embedded_at) {
      await client.query('COMMIT');
      return { completed: true, alreadyCompleted: true, pointId };
    }
    if (!row.lease_until || new Date(row.lease_until) <= new Date(row.server_now)) {
      throw new Error('claim_lease_expired');
    }

    const payload: CodeChunkPayload = {
      file_path: row.file_path,
      file_name: path.basename(row.file_path),
      file_type: row.file_type,
      line_start: row.line_start,
      line_end: row.line_end,
      project: row.project,
      chunk_index: row.chunk_index,
      total_chunks: row.total_chunks,
      updated_at: new Date(row.server_now).toISOString(),
      content: row.content,
    };
    const collection = await ensureCollection(row.project, input.expectedDimension ?? 3072);
    await writeVector(collection, input.vector, payload, pointId);

    const ack = await client.query(
      `UPDATE code_chunks
          SET embedded_at=NOW(), lease_until=NULL
        WHERE id=$1 AND claim_token=$2 AND claimed_by=$3
          AND content_hash=$4 AND embedded_at IS NULL`,
      [row.id, input.claimToken, input.nodeId, input.contentHash],
    );
    if ((ack.rowCount ?? 0) !== 1) throw new Error('claim_ack_race');

    await client.query('COMMIT');
    return { completed: true, alreadyCompleted: false, pointId };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
