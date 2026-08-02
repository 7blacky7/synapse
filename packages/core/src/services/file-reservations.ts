/**
 * Kooperative Dateireservierungen fuer Co-Edit.
 *
 * CE-1 ist reine Buchfuehrung: Reservierungen blockieren weder plan() noch commit().
 * Mehrere Agenten duerfen denselben project/file_path gleichzeitig reservieren.
 */

import { posix as path } from 'node:path';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';

export interface FileReservation {
  id: string;
  project: string;
  agent_id: string;
  file_path: string;
  reserved_at: string;
  expires_at: string;
  released_at: string | null;
  plan_id: string | null;
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
  is_expired: boolean;
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
  const reservations: FileReservation[] = [];
  for (const filePath of args.filePaths) {
    const { rows } = await client.query<FileReservationRow>(
      `INSERT INTO file_reservations (
         project, agent_id, file_path, expires_at, plan_id
       )
       VALUES (
         $1, $2, $3,
         COALESCE($4::timestamptz, NOW() + INTERVAL '5 minutes'),
         $5::bigint
       )
       ON CONFLICT (project, agent_id, file_path) WHERE released_at IS NULL
       DO UPDATE SET
         reserved_at = CASE
           WHEN file_reservations.expires_at <= NOW() THEN NOW()
           ELSE file_reservations.reserved_at
         END,
         expires_at = EXCLUDED.expires_at,
         plan_id = COALESCE(EXCLUDED.plan_id, file_reservations.plan_id)
       RETURNING
         id::text AS id, project, agent_id, file_path,
         reserved_at, expires_at, released_at, plan_id::text AS plan_id,
         (expires_at <= NOW()) AS is_expired`,
      [args.project, args.agentId, filePath, args.expiresAt, args.planId],
    );
    reservations.push(mapReservation(rows[0]));
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

type ReservationQueryClient = PoolClient | ReturnType<typeof getPool>;

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
  client: ReservationQueryClient = getPool(),
): Promise<ForeignActiveReservationPrimary[]> {
  const filePaths = [...new Set(args.filePaths.filter((filePath) => filePath.length > 0))];
  if (filePaths.length === 0) return [];

  const { rows } = await client.query<{
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
          AND expires_at > NOW()
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