import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../db/client.js';
import { zielDimension } from '../embeddings/index.js';
import { leseSchalter } from './intern-schalter.js';
import { ensureProjectCollection } from '../qdrant/collections.js';
import { insertVector, insertVectors } from '../qdrant/operations.js';
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

// P15-T24: file_type als Skalar-Unterabfrage statt JOIN code_files, total_chunks NICHT mehr je Zeile.
// (1) Der JOIN filterte nie etwas (FK code_chunks(project, file_path) -> code_files ON DELETE CASCADE,
//     file_type NOT NULL), verleitete den Planer aber bei Projekten mit vielen Dateien zu
//     Nested Loop ueber code_files + Sort ALLER offenen Chunks des Projekts statt eines geordneten
//     Laufs ueber idx_code_chunks_claim_ordnung mit fruehem Abbruch. Gemessen 11.10.2026 (Live-DB,
//     EXPLAIN ANALYZE, LIMIT 32): llama.cpp-cuda 23872 Zeilen sortiert, ~52-60 ms, 21584 Puffer.
// (2) total_chunks zaehlte je geclaimter ZEILE alle Chunks ihrer Datei - bei 32 Zeilen aus einer Datei
//     mit ~1900 Chunks 32 x 1900 Index-Eintraege (61440 Heap Fetches, ~90 % der Laufzeit, thought
//     3d721cfe). Jetzt EINMAL je Datei im Stapel (CLAIM_SQL.totalChunks), gleicher Wert.
const CLAIM_SPALTEN = `cc.id, cc.project, cc.file_path,
              (SELECT cf.file_type FROM code_files cf
                WHERE cf.project=cc.project AND cf.file_path=cc.file_path) AS file_type,
              cc.chunk_index, cc.content, cc.line_start, cc.line_end`;

/**
 * P15-T25: Die Projektwahl nimmt hoechstens so viele Projekte nacheinander, falls ein gewaehltes
 * Projekt trotz claimbarer Chunks nichts liefert (die Chunks hat in diesem Moment eine andere
 * Transaktion gesperrt - SKIP LOCKED). Ohne Obergrenze koennte eine Runde alle Projekte abklappern.
 */
const PROJEKTWAHL_MAX_VERSUCHE = 8;

/**
 * P15-T12 E4: die Abfragen der Chunk-Auswahl, exportiert fuer Messung (scripts/messung-claim-explain.mjs)
 * und Regressionstest. Reihenfolge in claimEmbeddingChunks:
 *   vorgezogen  Schritt 0: prio > 0, ueber ALLE aktiven Projekte, hoechste prio zuerst. Laeuft ueber den
 *               Teilindex idx_code_chunks_prio, der leer ist, solange niemand eine prio setzt.
 *   projektWahl Projekt waehlen wie bisher (Stufe, dann zufaellig); zurueckgestellte Projekte
 *               (embed_prioritaet.zurueckgestellt_bis) fallen heraus.
 *   normal      Schritt 1: UNVERAENDERT bis auf zwei Heap-Filter (prio IS NULL, nicht zurueckgestellt);
 *               die Zeilen werden fuer content/lease_until ohnehin gelesen.
 *   hinten      Schritt 2, nur bei Rest-Limit: prio < 0 des gewaehlten Projekts ("ans Projektende").
 * Ohne gesetzte prio/zurueckgestellt_bis ist die Reihenfolge identisch zu vorher (Regressionstest).
 *
 * P15-T24/T25 (11.10.2026):
 *   - alle Auswahl-Abfragen lesen nur code_chunks (file_type per Unterabfrage), total_chunks kommt
 *     aus totalChunks, einmal je Datei im Stapel.
 *   - projektWahl ($1 = bereits versuchte Projekte) waehlt nur Projekte mit CLAIMBAREN Chunks fuer
 *     Schritt 1/2: offen, Lease frei/abgelaufen, nicht zurueckgestellt, prio NULL oder < 0. Vorher
 *     reichte irgendein offener Chunk; waren alle geleast (anderer Knoten) oder zurueckgestellt,
 *     war die Runde leer und der Aufrufer ging in den Leerlauf-Backoff, obwohl andere Projekte
 *     Arbeit hatten. Reihenfolge unveraendert: Stufe, dann zufaellig - nur unter den Projekten, die
 *     tatsaechlich etwas liefern koennen.
 */
export const CLAIM_SQL = {
  vorgezogen: `SELECT ${CLAIM_SPALTEN}
         FROM code_chunks cc
        WHERE cc.embedded_at IS NULL
          AND cc.prio > 0
          AND (cc.lease_until IS NULL OR cc.lease_until < NOW())
          AND (cc.zurueckgestellt_bis IS NULL OR cc.zurueckgestellt_bis <= NOW())
          AND EXISTS (SELECT 1 FROM projects p WHERE p.name = cc.project AND p.enabled)
        ORDER BY cc.prio DESC, cc.project, cc.file_path, cc.chunk_index
        LIMIT $1
        FOR UPDATE OF cc SKIP LOCKED`,
  projektWahl: `SELECT p.name
         FROM (SELECT DISTINCT name, enabled FROM projects) p
        WHERE p.enabled
          AND p.name <> ALL($1::text[])
          AND EXISTS (SELECT 1 FROM code_chunks cc
                       WHERE cc.project = p.name AND cc.embedded_at IS NULL
                         AND (cc.lease_until IS NULL OR cc.lease_until < NOW())
                         AND (cc.prio IS NULL OR cc.prio < 0)
                         AND (cc.zurueckgestellt_bis IS NULL OR cc.zurueckgestellt_bis <= NOW()))
          AND NOT EXISTS (SELECT 1 FROM embed_prioritaet z
                           WHERE z.project = p.name AND z.zurueckgestellt_bis > NOW())
        ORDER BY COALESCE((SELECT e.stufe FROM embed_prioritaet e WHERE e.project = p.name), 3), random()
        LIMIT 1`,
  normal: `SELECT ${CLAIM_SPALTEN}
         FROM code_chunks cc
        WHERE cc.project = $2
          AND cc.embedded_at IS NULL
          AND (cc.lease_until IS NULL OR cc.lease_until < NOW())
          AND cc.prio IS NULL
          AND (cc.zurueckgestellt_bis IS NULL OR cc.zurueckgestellt_bis <= NOW())
        ORDER BY cc.file_path, cc.chunk_index
        LIMIT $1
        FOR UPDATE OF cc SKIP LOCKED`,
  hinten: `SELECT ${CLAIM_SPALTEN}
         FROM code_chunks cc
        WHERE cc.project = $2
          AND cc.embedded_at IS NULL
          AND cc.prio < 0
          AND (cc.lease_until IS NULL OR cc.lease_until < NOW())
          AND (cc.zurueckgestellt_bis IS NULL OR cc.zurueckgestellt_bis <= NOW())
        ORDER BY cc.prio DESC, cc.file_path, cc.chunk_index
        LIMIT $1
        FOR UPDATE OF cc SKIP LOCKED`,
  /** P15-T24: Chunks je Datei, einmal je (project, file_path) des Stapels ($1 Projekte, $2 Pfade). */
  totalChunks: `SELECT k.project, k.file_path,
              (SELECT COUNT(*) FROM code_chunks allc
                WHERE allc.project = k.project AND allc.file_path = k.file_path)::int AS total_chunks
         FROM unnest($1::text[], $2::text[]) AS k(project, file_path)`,
} as const;

type ChunkZaehlerAbfrage = (
  sql: string,
  values: unknown[],
) => Promise<{ rows: Array<{ project: string; file_path: string; total_chunks: number }> }>;

/** P15-T24: total_chunks je Datei der Zeilen, EINE Zaehlung je (project, file_path). */
async function chunksJeDatei(
  abfrage: ChunkZaehlerAbfrage,
  zeilen: Array<{ project: string; file_path: string }>,
): Promise<Map<string, number>> {
  const schluessel = (project: string, filePath: string) => `${project}\u0000${filePath}`;
  const dateien = new Map<string, { project: string; file_path: string }>();
  for (const z of zeilen) dateien.set(schluessel(z.project, z.file_path), z);
  const ergebnis = new Map<string, number>();
  if (dateien.size === 0) return ergebnis;
  const liste = [...dateien.values()];
  const { rows } = await abfrage(CLAIM_SQL.totalChunks, [liste.map((d) => d.project), liste.map((d) => d.file_path)]);
  for (const r of rows) ergebnis.set(schluessel(r.project, r.file_path), Number(r.total_chunks));
  return ergebnis;
}
const totalVon = (m: Map<string, number>, project: string, filePath: string): number =>
  m.get(`${project}\u0000${filePath}`) ?? 0;

interface ClaimZeile {
  id: string;
  project: string;
  file_path: string;
  file_type: string;
  chunk_index: number;
  content: string;
  line_start: number;
  line_end: number;
}

function boundedInt(value: number | undefined, fallback: number, max: number): number {
  if (!Number.isInteger(value) || value == null || value <= 0) return fallback;
  return Math.min(value, max);
}

export function validateEmbeddingVector(vector: unknown, expectedDimension: number): vector is number[] {
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
  // P14-T2: Schalter embedding (jeder Modus) -> keine Claims, weder fuer den Server noch fuer externe
  // Knoten. Die Chunks bleiben offen und werden nach der Freigabe normal geclaimt.
  if ((await leseSchalter('embedding')).aktiv) return [];
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
    // P15-T12 E4: Schritt 0 - ausdruecklich vorgezogene Chunks (prio > 0) vor allem anderen.
    // P12-T14: danach Projektwahl nach Embed-Prioritaet (Stufe 1 zuerst, ohne Eintrag 3), innerhalb zufaellig.
    const ausgewaehlt: ClaimZeile[] = (await client.query<ClaimZeile>(CLAIM_SQL.vorgezogen, [limit])).rows;
    let rest = limit - ausgewaehlt.length;
    // P15-T25: liefert das gewaehlte Projekt nichts (Chunks gerade von einer anderen Transaktion
    // gesperrt), sofort das naechste nehmen statt eine leere Runde zu melden. Ein Projekt, das
    // etwas geliefert hat, beendet die Runde wie bisher (ein Projekt je Runde).
    const versucht: string[] = [];
    while (rest > 0 && versucht.length < PROJEKTWAHL_MAX_VERSUCHE) {
      const projekt = (await client.query<{ name: string }>(CLAIM_SQL.projektWahl, [versucht])).rows[0]?.name;
      if (!projekt) break;
      versucht.push(projekt);
      const vorher = rest;
      const normal = await client.query<ClaimZeile>(CLAIM_SQL.normal, [rest, projekt]);
      ausgewaehlt.push(...normal.rows);
      rest -= normal.rows.length;
      // Schritt 2: Chunks, die ausdruecklich ans Projektende gestellt wurden (prio < 0).
      if (rest > 0) {
        const hinten = await client.query<ClaimZeile>(CLAIM_SQL.hinten, [rest, projekt]);
        ausgewaehlt.push(...hinten.rows);
        rest -= hinten.rows.length;
      }
      if (rest < vorher) break;
    }
    if (ausgewaehlt.length === 0) {
      await client.query('COMMIT');
      return [];
    }
    const totals = await chunksJeDatei((sql, werte) => client.query(sql, werte), ausgewaehlt);

    const claims: EmbeddingChunkClaim[] = [];
    for (const row of ausgewaehlt) {
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
        totalChunks: totalVon(totals, row.project, row.file_path),
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
  const dim = input.expectedDimension ?? await zielDimension();
  if (!validateEmbeddingVector(input.vector, dim)) {
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
    const collection = await ensureCollection(row.project, dim);
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

export interface StapelAbschlussEintrag {
  chunkId: string;
  claimToken: string;
  contentHash: string;
  vector: number[];
}

/**
 * P12-T14: Stapel-Abschluss fuer den Server-Embedding-Loop. Gleiche Pruefungen wie
 * completeEmbeddingClaim (Vektor, Claim-Token, Knoten, Inhalts-Hash, Lease), aber EIN Qdrant-Upsert
 * je Projekt und EIN UPDATE fuer den ganzen Stapel. Vorher ~9,5 Chunks/s (eine Transaktion je Chunk).
 *
 * ⚠️ KEINE SPERREN WAEHREND QDRANT- UND POOL-ZUGRIFFEN. Die erste Fassung (t46) hielt Datei-Locks und
 * Zeilensperren in einer Transaktion, waehrend ensureProjectCollection/insertVectors weitere
 * Verbindungen aus demselben Hintergrund-Pool brauchten. Die Parse-Worker warteten mit ihren
 * Verbindungen auf genau diese Datei-Locks (Prioritaetenliste -> dieselben Projekte) - Pool 8/8,
 * 25 wartend, Nachzug stand. Deshalb jetzt zweistufig:
 *   1. ohne Transaktion lesen, pruefen, Collection sicherstellen, Punkte schreiben (IDs sind
 *      deterministisch, ein doppelter Upsert schadet nicht),
 *   2. EIN UPDATE quittiert nur Zeilen, deren Token, Knoten, Hash und Lease noch stimmen. Hat
 *      parseAndEmbed die Datei dazwischen neu geschrieben, greift es nicht; der verwaiste Punkt
 *      faellt bei dessen naechstem Lauf weg (Waisen-Abgleich je Datei).
 * Abgelehnte Eintraege bleiben offen; der Aufrufer gibt deren Claims frei.
 */
export async function completeEmbeddingClaims(
  nodeId: string,
  eintraege: StapelAbschlussEintrag[],
  expectedDimension?: number,
): Promise<{ abgeschlossen: string[]; abgelehnt: Array<{ chunkId: string; grund: string }> }> {
  const dim = expectedDimension ?? await zielDimension();
  const abgelehnt: Array<{ chunkId: string; grund: string }> = [];
  const gueltig = eintraege.filter((e) => {
    if (validateEmbeddingVector(e.vector, dim)) return true;
    abgelehnt.push({ chunkId: e.chunkId, grund: 'invalid_embedding_vector' });
    return false;
  });
  if (gueltig.length === 0) return { abgeschlossen: [], abgelehnt };
  const nachId = new Map(gueltig.map((e) => [String(e.chunkId), e]));
  const ids = [...nachId.keys()];
  const pool = getPool();

  const { rows } = await pool.query<{
    id: string; project: string; file_path: string; file_type: string; chunk_index: number;
    content: string; content_hash: string | null; line_start: number; line_end: number;
    claim_token: string | null; claimed_by: string | null; lease_until: Date | null;
    embedded_at: Date | null; server_now: Date;
  }>(
    `SELECT cc.id, cc.project, cc.file_path, cf.file_type, cc.chunk_index,
            cc.content, cc.content_hash, cc.line_start, cc.line_end,
            cc.claim_token, cc.claimed_by, cc.lease_until, cc.embedded_at,
            NOW() AS server_now
       FROM code_chunks cc
       JOIN code_files cf ON cf.project=cc.project AND cf.file_path=cc.file_path
      WHERE cc.id = ANY($1)`,
    [ids],
  );
  // P15-T24: total_chunks einmal je Datei statt je Zeile (ein Stapel kommt meist aus einer Datei).
  const totals = await chunksJeDatei((sql, werte) => pool.query(sql, werte), rows);

  const gesehen = new Set<string>();
  const bereitsFertig: string[] = [];
  const kandidaten: StapelAbschlussEintrag[] = [];
  const zuSchreiben = new Map<string, Array<{ vector: number[]; payload: CodeChunkPayload; id: string }>>();
  for (const row of rows) {
    const id = String(row.id);
    gesehen.add(id);
    const e = nachId.get(id);
    if (!e) continue;
    if (
      row.claim_token !== e.claimToken || row.claimed_by !== nodeId ||
      row.content_hash !== e.contentHash || embeddingContentHash(row.content) !== e.contentHash
    ) { abgelehnt.push({ chunkId: id, grund: 'claim_fence_rejected' }); continue; }
    if (row.embedded_at) { bereitsFertig.push(id); continue; }
    if (!row.lease_until || new Date(row.lease_until) <= new Date(row.server_now)) {
      abgelehnt.push({ chunkId: id, grund: 'claim_lease_expired' });
      continue;
    }
    const liste = zuSchreiben.get(row.project) ?? [];
    liste.push({
      id: deterministicChunkPointId(row.project, row.file_path, row.chunk_index, row.content),
      vector: e.vector,
      payload: {
        file_path: row.file_path,
        file_name: path.basename(row.file_path),
        file_type: row.file_type,
        line_start: row.line_start,
        line_end: row.line_end,
        project: row.project,
        chunk_index: row.chunk_index,
        total_chunks: totalVon(totals, row.project, row.file_path),
        updated_at: new Date(row.server_now).toISOString(),
        content: row.content,
      },
    });
    zuSchreiben.set(row.project, liste);
    kandidaten.push(e);
  }
  for (const id of ids) if (!gesehen.has(id)) abgelehnt.push({ chunkId: id, grund: 'claim_not_found' });

  // 1. Qdrant zuerst (erst einfuegen, dann quittieren), ohne offene Transaktion.
  for (const [project, punkte] of zuSchreiben) {
    const collection = await ensureProjectCollection(project, dim);
    await insertVectors(collection, punkte);
  }

  // 2. Quittieren in EINER Anweisung; nur was Token/Knoten/Hash/Lease noch erfuellt.
  const abgeschlossen = [...bereitsFertig];
  if (kandidaten.length > 0) {
    const ack = await pool.query<{ id: string }>(
      `UPDATE code_chunks c SET embedded_at = NOW(), lease_until = NULL
         FROM unnest($1::text[], $2::text[], $3::text[]) AS u(id, token, hash)
        WHERE c.id::text = u.id AND c.claim_token = u.token AND c.content_hash = u.hash
          AND c.claimed_by = $4 AND c.embedded_at IS NULL AND c.lease_until > NOW()
        RETURNING c.id`,
      [kandidaten.map((k) => String(k.chunkId)), kandidaten.map((k) => k.claimToken), kandidaten.map((k) => k.contentHash), nodeId],
    );
    const quittiert = new Set(ack.rows.map((r) => String(r.id)));
    for (const k of kandidaten) {
      const id = String(k.chunkId);
      if (quittiert.has(id)) abgeschlossen.push(id);
      else abgelehnt.push({ chunkId: id, grund: 'claim_ack_race' });
    }
  }
  return { abgeschlossen, abgelehnt };
}
