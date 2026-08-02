/**
 * Kooperative Dateireservierungen fuer Co-Edit.
 *
 * CE-1 ist reine Buchfuehrung: Reservierungen blockieren weder plan() noch commit().
 * Mehrere Agenten duerfen denselben project/file_path gleichzeitig reservieren.
 */

import { posix as path } from 'node:path';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { contentHash } from './code-write.js';

export interface FileReservation {
  id: string;
  project: string;
  agent_id: string;
  file_path: string;
  reserved_at: string;
  expires_at: string;
  released_at: string | null;
  plan_id: string | null;
  content_hash_at_reservation: string | null;
  last_extended_at: string | null;
  taken_over_at: string | null;
  taken_over_by: string | null;
  coordination_hint?: string;
  is_expired: boolean;
}

interface FileReservationRow {
  id: string;
  project: string;
  agent_id: string;
  file_path: string;
  reserved_at: Date | string;
  expires_at: Date | string;
  released_at: Date | string | null;
  plan_id: string | null;
  content_hash_at_reservation: string | null;
  last_extended_at: Date | string | null;
  taken_over_at: Date | string | null;
  taken_over_by: string | null;
  coordination_hint?: string | null;
  is_expired: boolean;
}

type ReservationQueryClient = PoolClient | ReturnType<typeof getPool>;

export interface ReservationTtlConfig {
  enabled: boolean;
  baseMinutes: number;
  maxMinutes: number;
  renewBeforeMinutes: number;
  takeoverGraceMinutes: number;
  legacyFallbackMinutes: number;
  workerIntervalMs: number;
}

const EMPTY_CONTENT_HASH = contentHash('');

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getReservationTtlConfig(): ReservationTtlConfig {
  const baseMinutes = envNonNegativeInt('SYNAPSE_RESERVATION_TTL_BASE_MINUTES', 20);
  return {
    enabled: baseMinutes > 0,
    baseMinutes,
    maxMinutes: Math.max(baseMinutes, envNonNegativeInt('SYNAPSE_RESERVATION_TTL_MAX_MINUTES', 120)),
    renewBeforeMinutes: envNonNegativeInt('SYNAPSE_RESERVATION_TTL_RENEW_BEFORE_MINUTES', 10),
    takeoverGraceMinutes: envNonNegativeInt('SYNAPSE_RESERVATION_TTL_GRACE_MINUTES', 10),
    legacyFallbackMinutes: 5,
    workerIntervalMs: Math.max(100, envNonNegativeInt('SYNAPSE_RESERVATION_TTL_WORKER_INTERVAL_MS', 60_000)),
  };
}

export interface ReservationMutationResult {
  released: FileReservation[];
  missing_paths: string[];
}

export interface ReservationUpdateResult {
  added: FileReservation[];
  kept: FileReservation[];
  released: FileReservation[];
  missing_keep_paths: string[];
  missing_release_paths: string[];
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapReservation(row: FileReservationRow): FileReservation {
  return {
    id: String(row.id),
    project: row.project,
    agent_id: row.agent_id,
    file_path: row.file_path,
    reserved_at: iso(row.reserved_at),
    expires_at: iso(row.expires_at),
    released_at: row.released_at === null ? null : iso(row.released_at),
    plan_id: row.plan_id === null ? null : String(row.plan_id),
    content_hash_at_reservation: row.content_hash_at_reservation ?? null,
    last_extended_at: row.last_extended_at === null ? null : iso(row.last_extended_at),
    taken_over_at: row.taken_over_at === null ? null : iso(row.taken_over_at),
    taken_over_by: row.taken_over_by ?? null,
    ...(row.coordination_hint ? { coordination_hint: row.coordination_hint } : {}),
    is_expired: row.is_expired,
  };
}

function normalizeExpiresAt(value?: string): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('expires_at muss ein gueltiger ISO-Zeitstempel sein');
  }
  if (parsed.getTime() <= Date.now()) {
    throw new Error('expires_at muss in der Zukunft liegen');
  }
  return parsed.toISOString();
}

function normalizePlanId(value?: string): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('plan_id muss eine positive BIGINT-ID als String sein');
  }
  return trimmed;
}

/**
 * Normalisiert und dedupliziert Projekt-relative Pfade.
 * Absolute Pfade und Traversal sind fuer Reservierungen nicht erlaubt.
 */
export function normalizeReservationFilePaths(filePaths: readonly string[]): string[] {
  const result = new Set<string>();
  for (const raw of filePaths) {
    const trimmed = raw.trim().replace(/\\/g, '/');
    if (!trimmed) continue;
    if (trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) {
      throw new Error(`Reservierungspfad muss projekt-relativ sein: "${raw}"`);
    }
    const normalized = path.normalize(trimmed);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Ungueltiger Reservierungspfad: "${raw}"`);
    }
    result.add(normalized);
  }
  if (result.size === 0) {
    throw new Error('Mindestens ein file_path ist erforderlich');
  }
  return [...result];
}

function optionalPaths(filePaths: readonly string[] | undefined): string[] {
  return filePaths && filePaths.length > 0
    ? normalizeReservationFilePaths(filePaths)
    : [];
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function reservationParticipantCount(
  client: ReservationQueryClient,
  project: string,
  filePath: string,
): Promise<number> {
  const { rows } = await client.query<{ participant_count: string }>(
    `WITH participants AS (
       SELECT agent_id FROM file_reservations
        WHERE project = $1 AND file_path = $2 AND released_at IS NULL
       UNION
       SELECT primary_agent FROM file_batch_waits
        WHERE project = $1 AND $2 = ANY(shared_files)
          AND status IN ('waiting', 'linked') AND expires_at > NOW()
       UNION
       SELECT waiting_agent FROM file_batch_waits
        WHERE project = $1 AND $2 = ANY(shared_files)
          AND waiting_agent IS NOT NULL
          AND status IN ('waiting', 'linked') AND expires_at > NOW()
     )
     SELECT COUNT(DISTINCT agent_id)::text AS participant_count FROM participants`,
    [project, filePath],
  );
  return Math.max(1, Number(rows[0]?.participant_count ?? 1));
}

function scaledTtlSeconds(config: ReservationTtlConfig, participants: number): number {
  const minutes = config.enabled
    ? Math.min(config.maxMinutes, config.baseMinutes * Math.max(1, participants))
    : config.legacyFallbackMinutes;
  return Math.max(1, Math.round(minutes * 60));
}

async function currentFileHash(
  client: ReservationQueryClient,
  project: string,
  filePath: string,
): Promise<string> {
  const { rows } = await client.query<{ content_hash: string }>(
    `SELECT content_hash FROM code_files
      WHERE project = $1 AND file_path = $2 AND deleted_at IS NULL LIMIT 1`,
    [project, filePath],
  );
  return rows[0]?.content_hash ?? EMPTY_CONTENT_HASH;
}

async function syncWaitExpiries(
  client: ReservationQueryClient,
  project: string,
  filePaths: readonly string[],
): Promise<void> {
  if (filePaths.length === 0) return;
  await client.query(
    `UPDATE file_batch_waits w
        SET expires_at = COALESCE((
              SELECT MIN(primary_reservation.expires_at)
                FROM unnest(w.shared_files) AS shared(file_path)
                JOIN LATERAL (
                  SELECT r.expires_at
                    FROM file_reservations r
                   WHERE r.project = w.project
                     AND r.file_path = shared.file_path
                     AND r.released_at IS NULL
                   ORDER BY r.reserved_at, r.id
                   LIMIT 1
                ) AS primary_reservation ON TRUE
            ), w.expires_at),
            updated_at = NOW()
      WHERE w.project = $1
        AND w.status IN ('waiting', 'linked')
        AND w.shared_files && $2::text[]`,
    [project, filePaths],
  );
}

export async function refreshReservationTtlsForFiles(
  args: { project: string; filePaths: readonly string[] },
  queryClient: ReservationQueryClient = getPool(),
): Promise<number> {
  const filePaths = [...new Set(args.filePaths.filter(Boolean))];
  if (filePaths.length === 0) return 0;
  const config = getReservationTtlConfig();
  let updated = 0;
  for (const filePath of filePaths) {
    const participants = await reservationParticipantCount(queryClient, args.project, filePath);
    const result = await queryClient.query(
      `UPDATE file_reservations
          SET expires_at = GREATEST(expires_at, NOW() + ($3 * INTERVAL '1 second'))
        WHERE project = $1 AND file_path = $2
          AND released_at IS NULL AND expires_at > NOW()`,
      [args.project, filePath, scaledTtlSeconds(config, participants)],
    );
    updated += result.rowCount ?? 0;
  }
  await syncWaitExpiries(queryClient, args.project, filePaths);
  return updated;
}

async function renewDueWithClient(
  client: PoolClient,
  args: { project?: string; filePaths?: readonly string[] } = {},
): Promise<number> {
  const config = getReservationTtlConfig();
  if (!config.enabled) return 0;
  const values: unknown[] = [config.renewBeforeMinutes];
  const filters = [
    'r.released_at IS NULL',
    'r.expires_at > NOW()',
    `r.expires_at <= NOW() + ($1 * INTERVAL '1 minute')`,
  ];
  if (args.project) {
    values.push(args.project);
    filters.push(`r.project = $${values.length}`);
  }
  if (args.filePaths && args.filePaths.length > 0) {
    values.push([...new Set(args.filePaths)]);
    filters.push(`r.file_path = ANY($${values.length}::text[])`);
  }
  const { rows } = await client.query<{
    id: string; project: string; agent_id: string; file_path: string;
  }>(
    `SELECT r.id::text AS id, r.project, r.agent_id, r.file_path
       FROM file_reservations r
      WHERE ${filters.join(' AND ')}
        AND (
          EXISTS (
            SELECT 1 FROM tool_calls t
             WHERE t.agent_id = r.agent_id
               AND (t.project = r.project OR t.project IS NULL)
               AND t.ts > COALESCE(r.last_extended_at, r.reserved_at)
          )
          OR EXISTS (
            SELECT 1 FROM file_batch_plans p
             WHERE p.project = r.project
               AND p.status = 'open' AND p.expires_at > NOW()
               AND (p.owner_agent_id = r.agent_id OR p.id = r.plan_id)
               AND p.expected_hashes ? r.file_path
          )
        )
      ORDER BY r.expires_at, r.id
      FOR UPDATE SKIP LOCKED`,
    values,
  );

  const touched = new Map<string, Set<string>>();
  for (const row of rows) {
    const participants = await reservationParticipantCount(client, row.project, row.file_path);
    await client.query(
      `UPDATE file_reservations
          SET expires_at = NOW() + ($2 * INTERVAL '1 second'),
              last_extended_at = NOW()
        WHERE id = $1::bigint AND released_at IS NULL AND expires_at > NOW()`,
      [row.id, scaledTtlSeconds(config, participants)],
    );
    const paths = touched.get(row.project) ?? new Set<string>();
    paths.add(row.file_path);
    touched.set(row.project, paths);
  }
  for (const [project, paths] of touched) {
    await syncWaitExpiries(client, project, [...paths]);
  }
  return rows.length;
}

export async function renewFileReservationTtls(
  args: { project?: string; filePaths?: readonly string[] } = {},
): Promise<number> {
  return inTransaction((client) => renewDueWithClient(client, args));
}

async function addWithClient(
  client: PoolClient,
  args: {
    project: string;
    agentId: string;
    filePaths: readonly string[];
    expiresAt: string | null;
    planId: string | null;
  },
): Promise<FileReservation[]> {
  const config = getReservationTtlConfig();
  const reservations: FileReservation[] = [];
  for (const filePath of args.filePaths) {
    const baselineHash = await currentFileHash(client, args.project, filePath);
    await client.query(
      `INSERT INTO file_reservations (
         project, agent_id, file_path, expires_at, plan_id,
         content_hash_at_reservation, last_extended_at
       )
       VALUES (
         $1, $2, $3,
         COALESCE($4::timestamptz, NOW() + ($6 * INTERVAL '1 second')),
         $5::bigint, $7, NOW()
       )
       ON CONFLICT (project, agent_id, file_path) WHERE released_at IS NULL
       DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         plan_id = COALESCE(EXCLUDED.plan_id, file_reservations.plan_id),
         content_hash_at_reservation = COALESCE(
           file_reservations.content_hash_at_reservation,
           EXCLUDED.content_hash_at_reservation
         ),
         last_extended_at = NOW()`,
      [
        args.project, args.agentId, filePath, args.expiresAt, args.planId,
        scaledTtlSeconds(config, 1), baselineHash,
      ],
    );

    const locked = await client.query<FileReservationRow>(
      `SELECT id::text AS id, project, agent_id, file_path,
              reserved_at, expires_at, released_at, plan_id::text AS plan_id,
              content_hash_at_reservation, last_extended_at, taken_over_at, taken_over_by,
              (expires_at <= NOW()) AS is_expired
         FROM file_reservations
        WHERE project = $1 AND file_path = $2 AND released_at IS NULL
        ORDER BY reserved_at, id
        FOR UPDATE`,
      [args.project, filePath],
    );
    const primary = locked.rows[0];
    let coordinationHint: string | null = null;

    if (primary && primary.agent_id !== args.agentId) {
      if (new Date(primary.expires_at).getTime() > Date.now()) {
        coordinationHint = `Aktive Primaerreservierung von ${primary.agent_id}; Co-Edit-Wait verwenden.`;
      } else {
        const contender = locked.rows.find(
          (row) => row.agent_id !== primary.agent_id
            && new Date(row.expires_at).getTime() > Date.now(),
        );
        const { rows: checks } = await client.query<{
          within_grace: boolean;
          has_activity: boolean;
          has_open_file_plan: boolean;
          hash_drifted: boolean;
        }>(
          `SELECT
             NOW() < $3::timestamptz + ($4 * INTERVAL '1 minute') AS within_grace,
             EXISTS (
               SELECT 1 FROM tool_calls t
                WHERE t.agent_id = $2
                  AND (t.project = $1 OR t.project IS NULL)
                  AND t.ts > $3::timestamptz
             ) AS has_activity,
             EXISTS (
               SELECT 1 FROM file_batch_plans p
                WHERE p.project = $1
                  AND p.status = 'open' AND p.expires_at > NOW()
                  AND (p.owner_agent_id = $2 OR p.id = $5::bigint)
                  AND p.expected_hashes ? $6
             ) AS has_open_file_plan,
             COALESCE((
               SELECT cf.content_hash FROM code_files cf
                WHERE cf.project = $1 AND cf.file_path = $6
                  AND cf.deleted_at IS NULL LIMIT 1
             ), $7) <> COALESCE($8, $7) AS hash_drifted`,
          [
            args.project, primary.agent_id, primary.expires_at,
            config.takeoverGraceMinutes, primary.plan_id, filePath,
            EMPTY_CONTENT_HASH, primary.content_hash_at_reservation,
          ],
        );
        const check = checks[0];
        const blockers = [
          check.within_grace ? 'Grace-Phase' : null,
          check.has_activity ? 'Activity seit Ablauf' : null,
          check.has_open_file_plan ? 'offener dateibezogener Plan' : null,
          check.hash_drifted ? 'Content-Hash geaendert' : null,
        ].filter((value): value is string => value !== null);

        if (contender && blockers.length === 0) {
          await client.query(
            `UPDATE file_reservations
                SET released_at = NOW(), taken_over_at = NOW(), taken_over_by = $2
              WHERE id = $1::bigint AND released_at IS NULL`,
            [primary.id, contender.agent_id],
          );
          await client.query(
            `UPDATE file_batch_waits
                SET status = 'conflict', updated_at = NOW()
              WHERE project = $1 AND primary_agent = $2
                AND $3 = ANY(shared_files)
                AND status IN ('waiting', 'linked')`,
            [args.project, primary.agent_id, filePath],
          );
          coordinationHint = contender.agent_id === args.agentId
            ? `Restart-sicheres Takeover von ${primary.agent_id} abgeschlossen.`
            : `Primaerreservierung ging an den aelteren aktiven Contender ${contender.agent_id}.`;
        } else {
          coordinationHint = blockers.length > 0
            ? `Takeover blockiert: ${blockers.join(', ')}.`
            : 'Takeover blockiert: kein aktiver Contender.';
        }
      }
    }

    if (!args.expiresAt) {
      await refreshReservationTtlsForFiles(
        { project: args.project, filePaths: [filePath] },
        client,
      );
    } else {
      await syncWaitExpiries(client, args.project, [filePath]);
    }

    const { rows } = await client.query<FileReservationRow>(
      `SELECT id::text AS id, project, agent_id, file_path,
              reserved_at, expires_at, released_at, plan_id::text AS plan_id,
              content_hash_at_reservation, last_extended_at, taken_over_at, taken_over_by,
              (expires_at <= NOW()) AS is_expired
         FROM file_reservations
        WHERE project = $1 AND agent_id = $2 AND file_path = $3
          AND released_at IS NULL
        LIMIT 1`,
      [args.project, args.agentId, filePath],
    );
    if (rows[0]) {
      const mapped = mapReservation(rows[0]);
      if (coordinationHint) mapped.coordination_hint = coordinationHint;
      reservations.push(mapped);
    }
  }
  return reservations;
}

async function releaseWithClient(
  client: PoolClient,
  project: string,
  agentId: string,
  filePaths: readonly string[],
): Promise<FileReservation[]> {
  if (filePaths.length === 0) return [];
  const { rows } = await client.query<FileReservationRow>(
    `UPDATE file_reservations
        SET released_at = NOW()
      WHERE project = $1
        AND agent_id = $2
        AND file_path = ANY($3::text[])
        AND released_at IS NULL
      RETURNING
        id::text AS id, project, agent_id, file_path,
        reserved_at, expires_at, released_at, plan_id::text AS plan_id,
         content_hash_at_reservation, last_extended_at, taken_over_at, taken_over_by,
         (expires_at <= NOW()) AS is_expired`,
    [project, agentId, filePaths],
  );
  return rows.map(mapReservation);
}

export async function addFileReservations(args: {
  project: string;
  agentId: string;
  filePaths: readonly string[];
  expiresAt?: string;
  planId?: string;
}): Promise<FileReservation[]> {
  const filePaths = normalizeReservationFilePaths(args.filePaths);
  const expiresAt = normalizeExpiresAt(args.expiresAt);
  const planId = normalizePlanId(args.planId);
  return inTransaction((client) => addWithClient(client, {
    project: args.project,
    agentId: args.agentId,
    filePaths,
    expiresAt,
    planId,
  }));
}

export async function releaseFileReservations(args: {
  project: string;
  agentId: string;
  filePaths: readonly string[];
}): Promise<ReservationMutationResult> {
  const filePaths = normalizeReservationFilePaths(args.filePaths);
  const released = await inTransaction((client) =>
    releaseWithClient(client, args.project, args.agentId, filePaths));
  const releasedPaths = new Set(released.map((entry) => entry.file_path));
  return {
    released,
    missing_paths: filePaths.filter((filePath) => !releasedPaths.has(filePath)),
  };
}

function assertDisjoint(groups: Array<{ name: string; paths: readonly string[] }>): void {
  const owners = new Map<string, string>();
  for (const group of groups) {
    for (const filePath of group.paths) {
      const previous = owners.get(filePath);
      if (previous) {
        throw new Error(`file_path "${filePath}" steht zugleich in ${previous} und ${group.name}`);
      }
      owners.set(filePath, group.name);
    }
  }
}

export async function updateFileReservations(args: {
  project: string;
  agentId: string;
  releasePaths?: readonly string[];
  keepPaths?: readonly string[];
  addPaths?: readonly string[];
  expiresAt?: string;
  planId?: string;
}): Promise<ReservationUpdateResult> {
  const releasePaths = optionalPaths(args.releasePaths);
  const keepPaths = optionalPaths(args.keepPaths);
  const addPaths = optionalPaths(args.addPaths);
  if (releasePaths.length + keepPaths.length + addPaths.length === 0) {
    throw new Error('reservation_update braucht release_paths, keep_paths oder add_paths');
  }
  assertDisjoint([
    { name: 'release_paths', paths: releasePaths },
    { name: 'keep_paths', paths: keepPaths },
    { name: 'add_paths', paths: addPaths },
  ]);

  const expiresAt = normalizeExpiresAt(args.expiresAt);
  const planId = normalizePlanId(args.planId);

  return inTransaction(async (client) => {
    const released = await releaseWithClient(client, args.project, args.agentId, releasePaths);
    const kept = keepPaths.length === 0
      ? []
      : (await client.query<FileReservationRow>(
          `SELECT
             id::text AS id, project, agent_id, file_path,
             reserved_at, expires_at, released_at, plan_id::text AS plan_id,
         content_hash_at_reservation, last_extended_at, taken_over_at, taken_over_by,
         (expires_at <= NOW()) AS is_expired
           FROM file_reservations
           WHERE project = $1
             AND agent_id = $2
             AND file_path = ANY($3::text[])
             AND released_at IS NULL
           ORDER BY reserved_at, id`,
          [args.project, args.agentId, keepPaths],
        )).rows.map(mapReservation);
    const added = await addWithClient(client, {
      project: args.project,
      agentId: args.agentId,
      filePaths: addPaths,
      expiresAt,
      planId,
    });

    const keptSet = new Set(kept.map((entry) => entry.file_path));
    const releasedSet = new Set(released.map((entry) => entry.file_path));
    return {
      added,
      kept,
      released,
      missing_keep_paths: keepPaths.filter((filePath) => !keptSet.has(filePath)),
      missing_release_paths: releasePaths.filter((filePath) => !releasedSet.has(filePath)),
    };
  });
}

export async function listFileReservations(args: {
  project: string;
  agentId?: string;
  filePaths?: readonly string[];
  includeReleased?: boolean;
}): Promise<FileReservation[]> {
  const filePaths = optionalPaths(args.filePaths);
  const values: unknown[] = [args.project];
  const conditions = ['project = $1'];

  if (args.agentId) {
    values.push(args.agentId);
    conditions.push(`agent_id = $${values.length}`);
  }
  if (filePaths.length > 0) {
    values.push(filePaths);
    conditions.push(`file_path = ANY($${values.length}::text[])`);
  }
  if (!args.includeReleased) {
    conditions.push('released_at IS NULL');
  }

  const { rows } = await getPool().query<FileReservationRow>(
    `SELECT
       id::text AS id, project, agent_id, file_path,
       reserved_at, expires_at, released_at, plan_id::text AS plan_id,
         content_hash_at_reservation, last_extended_at, taken_over_at, taken_over_by,
         (expires_at <= NOW()) AS is_expired
     FROM file_reservations
     WHERE ${conditions.join(' AND ')}
     ORDER BY file_path, reserved_at, id`,
    values,
  );
  return rows.map(mapReservation);
}


export interface ForeignActiveReservationPrimary {
  file_path: string;
  reserved_by: string;
  reserved_since: string;
  expires_at: string;
}

export interface DirectWriteReservationHint {
  files: ForeignActiveReservationPrimary[];
  message: string;
}

/**
 * Liefert pro Pfad die aelteste aktive Reservierung, sofern sie nicht dem
 * aufrufenden Agenten gehoert. Ranking und Caller-Filter entsprechen exakt
 * der CE-2-Logik in planBatch.
 */
export async function findForeignActiveReservationPrimaries(
  args: {
    project: string;
    callerAgentId?: string | null;
    filePaths: readonly string[];
  },
  client?: ReservationQueryClient,
): Promise<ForeignActiveReservationPrimary[]> {
  const filePaths = [...new Set(args.filePaths.filter((filePath) => filePath.length > 0))];
  if (filePaths.length === 0) return [];

  if (client && 'release' in client) {
    await renewDueWithClient(client as PoolClient, { project: args.project, filePaths });
  } else {
    await renewFileReservationTtls({ project: args.project, filePaths });
  }
  const queryClient = client ?? getPool();

  const { rows } = await queryClient.query<{
    file_path: string;
    reserved_by: string;
    reserved_since: Date | string;
    expires_at: Date | string;
  }>(
    `WITH ranked AS (
       SELECT file_path, agent_id, reserved_at, expires_at,
              ROW_NUMBER() OVER (
                PARTITION BY file_path ORDER BY reserved_at ASC, id ASC
              ) AS reservation_rank
         FROM file_reservations
        WHERE project = $1
          AND file_path = ANY($2::text[])
          AND released_at IS NULL
     )
     SELECT file_path, agent_id AS reserved_by, reserved_at AS reserved_since, expires_at
       FROM ranked
      WHERE reservation_rank = 1
        AND ($3::text IS NULL OR agent_id <> $3)`,
    [args.project, filePaths, args.callerAgentId ?? null],
  );

  const byPath = new Map(rows.map((row) => [row.file_path, row] as const));
  return filePaths.flatMap((filePath) => {
    const row = byPath.get(filePath);
    return row
      ? [{
          file_path: row.file_path,
          reserved_by: row.reserved_by,
          reserved_since: iso(row.reserved_since),
          expires_at: iso(row.expires_at),
        }]
      : [];
  });
}

/**
 * Best-effort-Decorator fuer erfolgreiche direkte Writes. Ein Fehler beim
 * Hinweis-Check darf den bereits gelungenen Write niemals kippen.
 */
export async function getDirectWriteReservationHint(args: {
  project: string;
  agentId?: string;
  filePaths: readonly string[];
}): Promise<DirectWriteReservationHint | undefined> {
  if (!args.agentId) return undefined;
  try {
    const files = await findForeignActiveReservationPrimaries({
      project: args.project,
      callerAgentId: args.agentId,
      filePaths: args.filePaths,
    });
    if (files.length === 0) return undefined;
    return {
      files,
      message: 'Schreiben wurde nicht blockiert. Reserviere die Datei und nutze files(action: "plan"), um dich in die Koordination einzuklinken.',
    };
  } catch (error) {
    console.error(
      '[Synapse] Reservierungs-Hinweis fuer direkten Write fehlgeschlagen (best-effort):',
      error instanceof Error ? error.message : error,
    );
    return undefined;
  }
}