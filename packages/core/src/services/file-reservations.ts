/**
 * Kooperative Dateireservierungen fuer Co-Edit.
 *
 * CE-1 ist reine Buchfuehrung: Reservierungen blockieren weder plan() noch commit().
 * Mehrere Agenten duerfen denselben project/file_path gleichzeitig reservieren.
 */

import { posix as path } from 'node:path';
import { normalisiereProjektPfad, PfadUngueltig } from './projekt-pfad.js';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { aktuelleAgentIdentityId, aktuellerAgentAufruf, leseAgentBezugModus, mitAgentAufrufKontext } from './agent-bezug.js';
import { fileAgentKey, reservierungsQuelle } from './file-agent-bezug.js';
import { contentHash } from './code-write.js';

export interface FileReservation {
  id: string;
  project: string;
  agent_id: string;
  identity_id?: string | null;
  taken_over_by_identity_id?: string | null;
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
  identity_id?: string | null;
  taken_over_by_identity_id?: string | null;
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
  planlessMinutes: number;
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
    planlessMinutes: Math.max(1, envNonNegativeInt('SYNAPSE_RESERVATION_TTL_PLANLESS_MINUTES', 5)),
    workerIntervalMs: Math.max(100, envNonNegativeInt('SYNAPSE_RESERVATION_TTL_WORKER_INTERVAL_MS', 60_000)),
  };
}

/** Pfad, dessen Reservierung schon vor dem release-Aufruf freigegeben war. */
export interface AlreadyReleasedReservation {
  file_path: string;
  released_at: string;
  /** commit = durch files commit freigegeben; takeover = uebernommen; release = frueheres release/update. */
  reason: 'commit' | 'takeover' | 'release';
  plan_id: string | null;
  taken_over_by?: string;
}

export interface ReservationMutationResult {
  released: FileReservation[];
  /** Schon freigegeben (z.B. durch commit) — kein Fehler. */
  already_released: AlreadyReleasedReservation[];
  /** Nur Pfade, die dieser Agent nie reserviert hat. */
  missing_paths: string[];
}

export interface ReservationUpdateResult {
  added: FileReservation[];
  kept: FileReservation[];
  released: FileReservation[];
  already_released: AlreadyReleasedReservation[];
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
    ...(row.identity_id ? { identity_id: row.identity_id } : {}),
    ...(row.taken_over_by_identity_id ? { taken_over_by_identity_id: row.taken_over_by_identity_id } : {}),
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
    // P15-T36: dieselbe Normalisierung wie files/files_batch (projekt-pfad.ts). Kein trim mehr (Leerzeichen
    // sind legale Namenszeichen); ein leerer oder nur aus Leerzeichen bestehender Eintrag wird wie bisher
    // uebersprungen. Absolut (auch unter dem Root), Ausbruch und Steuerzeichen werden abgelehnt.
    if (typeof raw !== 'string' || !raw.trim()) continue;
    try {
      result.add(normalisiereProjektPfad(raw).pfad);
    } catch (fehler) {
      if (fehler instanceof PfadUngueltig) throw new Error(`Ungueltiger Reservierungspfad: ${fehler.message}`);
      throw fehler;
    }
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
  const idMode = !!aktuellerAgentAufruf() && aktuellerAgentAufruf()?.bezug.modus !== 'alt';
  const { rows } = await client.query<{ participant_count: string }>(
    `WITH participants AS (
       SELECT ${idMode ? "CASE WHEN identity_id IS NOT NULL THEN 'identity:'||identity_id ELSE 'legacy:'||agent_id END" : 'agent_id'} AS agent_id
         FROM ${idMode ? reservierungsQuelle() : 'file_reservations'} AS reservations
        WHERE project = $1 AND file_path = $2 AND released_at IS NULL
       UNION
       SELECT ${idMode ? "CASE WHEN primary_identity_id IS NOT NULL THEN 'identity:'||primary_identity_id ELSE 'legacy:'||primary_agent END" : 'primary_agent'} FROM file_batch_waits
        WHERE project = $1 AND $2 = ANY(shared_files)
          AND status IN ('waiting', 'linked') AND expires_at > NOW()
       UNION
       SELECT ${idMode ? "CASE WHEN waiting_identity_id IS NOT NULL THEN 'identity:'||waiting_identity_id ELSE 'legacy:'||waiting_agent END" : 'waiting_agent'} FROM file_batch_waits
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
                    FROM ${aktuellerAgentAufruf()?.bezug.modus !== 'alt' && aktuellerAgentAufruf() ? reservierungsQuelle() : 'file_reservations'} r
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

/**
 * Befund 875d6a8c (f): erklaert, warum expires_at je Datei unterschiedlich ausfallen kann —
 * die TTL skaliert mit der Zahl der Beteiligten JE DATEI. null, wenn alle gleich sind.
 */
export function reservationTtlHint(reservations: ReadonlyArray<{ file_path: string; expires_at: string | Date }>): string | null {
  const distinct = new Set(reservations.map((r) => new Date(r.expires_at).toISOString()));
  if (distinct.size <= 1) return null;
  const config = getReservationTtlConfig();
  return `expires_at unterscheidet sich je Datei: die TTL skaliert mit der Zahl der Beteiligten je Datei `
    + `(mehr reservierende/wartende Agenten = laenger, hoechstens ${config.maxMinutes} Minuten). Verlaengert wird nur durch eigene Aktivitaet.`;
}

export async function refreshReservationTtlsForFiles(
  /** agentId: nur die Reservierung DIESES Agenten verlaengern (Befund 693bbf48 d). */
  args: { project: string; filePaths: readonly string[]; agentId?: string },
  queryClient: ReservationQueryClient = getPool(),
): Promise<number> {
  const identityId = args.agentId ? aktuelleAgentIdentityId(args.project,args.agentId) : null;
  const table = identityId ? 'agent_identitaet_file_reservations' : 'file_reservations';
  const actorColumn = identityId ? 'identity_id' : 'agent_id';
  const filePaths = [...new Set(args.filePaths.filter(Boolean))];
  if (filePaths.length === 0) return 0;
  const config = getReservationTtlConfig();
  let updated = 0;
  for (const filePath of filePaths) {
    const participants = await reservationParticipantCount(queryClient, args.project, filePath);
    const result = await queryClient.query(
      `UPDATE ${table}
          SET expires_at = GREATEST(expires_at, NOW() + ($3 * INTERVAL '1 second'))
        WHERE project = $1 AND file_path = $2
          AND released_at IS NULL AND expires_at > NOW()
          AND plan_id IS NOT NULL
          AND ($4::text IS NULL OR ${actorColumn} = $4)`,
      [args.project, filePath, scaledTtlSeconds(config, participants), identityId ?? args.agentId ?? null],
    );
    updated += result.rowCount ?? 0;
  }
  await syncWaitExpiries(queryClient, args.project, filePaths);
  return updated;
}

async function renewDueWithClient(
  client: PoolClient,
  args: { project?: string; filePaths?: readonly string[] } = {},
  identity = false,
): Promise<number> {
  const table = identity ? 'agent_identitaet_file_reservations' : 'file_reservations';
  const config = getReservationTtlConfig();
  if (!config.enabled) return 0;
  const values: unknown[] = [config.renewBeforeMinutes];
  const filters = [
    'r.released_at IS NULL',
    'r.plan_id IS NOT NULL',
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
    id: string; project: string; agent_id: string; file_path: string; letzte_aktivitaet: Date | string;
  }>(
    // P15-T35: letzte_aktivitaet = juengster eigener Tool-Call des Besitzers. Die Verlaengerung
    // rechnet ab DIESEM Zeitpunkt, nicht ab NOW() — ein Worker-Tick Minuten spaeter schenkt einem
    // laengst stillen Besitzer sonst eine volle TTL.
    `SELECT r.id::text AS id, r.project, r.agent_id, r.file_path,
            (SELECT MAX(t.ts) FROM tool_calls t
              WHERE ${identity ? 't.identity_id = r.identity_id' : 't.identity_id IS NULL AND t.agent_id = r.agent_id'}
                AND (t.project = r.project OR t.project IS NULL)) AS letzte_aktivitaet
       FROM ${table} r
      WHERE ${filters.join(' AND ')}
        -- Nur echte Tool-Aktivitaet verlaengert (28.09.2026). Ein offener Plan ist KEIN
        -- Lebenszeichen mehr: Plaene laufen nicht ab, ein abgestuerzter Agent mit
        -- offenem Plan wuerde seine Dateien sonst fuer immer sperren. Gegen veraltete
        -- Plaene schuetzt der Hash-Check beim commit (expected_hashes).
        AND EXISTS (
          SELECT 1 FROM tool_calls t
           WHERE ${identity ? 't.identity_id = r.identity_id' : 't.identity_id IS NULL AND t.agent_id = r.agent_id'}
             AND (t.project = r.project OR t.project IS NULL)
             AND t.ts > COALESCE(r.last_extended_at, r.reserved_at)
        )
      ORDER BY r.expires_at, r.id
      FOR UPDATE SKIP LOCKED`,
    values,
  );

  const touched = new Map<string, Set<string>>();
  // P15-T35 (Befund c0639b81): Basis-TTL ohne Skalierung nach Beteiligten. Vorher NOW() + TTL x
  // Beteiligte: wer auf eine Datei wartete oder sie mitreservierte, verlaengerte damit die
  // Reservierung eines abwesenden Besitzers (Live: 4212 auf 40 Min). Die Skalierung gilt weiter
  // beim eigenen reservation_add (refreshReservationTtlsForFiles); ein aktiver Besitzer wird bei
  // jeder neuen Aktivitaet erneut verlaengert. GREATEST: nie kuerzen.
  const basisSekunden = scaledTtlSeconds(config, 1);
  for (const row of rows) {
    await client.query(
      `UPDATE ${table}
          SET expires_at = GREATEST(expires_at, $3::timestamptz + ($2 * INTERVAL '1 second')),
              last_extended_at = NOW()
        WHERE id = $1::bigint AND released_at IS NULL AND expires_at > NOW()`,
      [row.id, basisSekunden, row.letzte_aktivitaet],
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
  if(!aktuellerAgentAufruf()) {
    const bezug=await leseAgentBezugModus();
    return mitAgentAufrufKontext({principal:null,bezug},()=>renewFileReservationTtls(args));
  }
  const modus=aktuellerAgentAufruf()!.bezug.modus;
  return inTransaction(async client => {
    const legacy = await renewDueWithClient(client,args);
    return legacy + (modus === 'alt' ? 0 : await renewDueWithClient(client,args,true));
  });
}

export interface StaleReservationRelease {
  /** Abgelaufen und laenger als die Grace-Frist her. */
  abgelaufen: number;
  /** Agent abgemeldet (agent_sessions.status <> 'active': unregister oder Session-Reaper). */
  abgemeldet: number;
}

/**
 * P15-T27 Ziel 3: Reservierungen freigeben, die niemanden mehr koordinieren.
 *  - abgelaufen und laenger als SYNAPSE_RESERVATION_TTL_GRACE_MINUTES (Default 10) her. Bis P15-T27
 *    blieb so eine Zeile mit released_at NULL ewig stehen: der reservation_ttl-Worker verlaengert nur
 *    LEBENDE Reservierungen (renewDue), freigegeben hat ihn nie jemand — nur commit, release oder ein
 *    Takeover beim reservation_add eines anderen. Die Grace bleibt, damit das Takeover-Konzept (CE-6)
 *    unveraendert gilt; fuer plan zaehlt eine abgelaufene Reservierung schon ab Ablauf nicht mehr.
 *  - Agent abgemeldet: agent_sessions.status <> 'active' (unregister oder Session-Reaper nach
 *    SYNAPSE_SESSION_IDLE_HOURS ohne Lebenszeichen) — sofort, auch wenn die TTL noch laeuft.
 * Laeuft im reservation_ttl-Worker (pausierbar seit P15-T12). Danach syncWaitExpiries je Datei.
 */
export async function releaseStaleFileReservations(
  args: { project?: string } = {},
  identity = false,
): Promise<StaleReservationRelease> {
  if(!aktuellerAgentAufruf()) {
    const bezug=await leseAgentBezugModus();
    return mitAgentAufrufKontext({principal:null,bezug},()=>releaseStaleFileReservations(args,identity));
  }
  const table = identity ? 'agent_identitaet_file_reservations' : 'file_reservations';
  const config = getReservationTtlConfig();
  const result = await inTransaction(async (client) => {
    const { rows } = await client.query<{ project: string; file_path: string; grund: string }>(
      `WITH faellig AS (
         SELECT r.id,
                CASE WHEN (r.plan_id IS NULL AND r.expires_at <= NOW())
                       OR (r.plan_id IS NOT NULL AND r.expires_at <= NOW() - ($1 * INTERVAL '1 minute'))
                     THEN 'abgelaufen' ELSE 'abgemeldet' END AS grund
           FROM ${table} r
          WHERE r.released_at IS NULL
            AND ($2::text IS NULL OR r.project = $2)
            AND ((r.plan_id IS NULL AND r.expires_at <= NOW())
                 OR (r.plan_id IS NOT NULL AND r.expires_at <= NOW() - ($1 * INTERVAL '1 minute'))
                 OR EXISTS (SELECT 1 FROM ${identity ? 'agent_identitaet_sitzungen' : 'agent_sessions'} s WHERE ${identity ? 's.identity_id = r.identity_id' : 's.id = r.agent_id'} AND s.status <> 'active'))
          FOR UPDATE OF r SKIP LOCKED
       )
       UPDATE ${table} r
          SET released_at = NOW()
         FROM faellig
        WHERE r.id = faellig.id AND r.released_at IS NULL
       RETURNING r.project, r.file_path, faellig.grund`,
      [config.takeoverGraceMinutes, args.project ?? null],
    );
    const perProject = new Map<string, Set<string>>();
    for (const row of rows) {
      const paths = perProject.get(row.project) ?? new Set<string>();
      paths.add(row.file_path);
      perProject.set(row.project, paths);
    }
    for (const [project, paths] of perProject) {
      await syncWaitExpiries(client, project, [...paths]);
    }
    return {
      abgelaufen: rows.filter((row) => row.grund === 'abgelaufen').length,
      abgemeldet: rows.filter((row) => row.grund === 'abgemeldet').length,
      freigaben: [...perProject].map(([project, paths]) => ({ project, paths: [...paths] })),
    };
  });
  if (result.abgelaufen + result.abgemeldet > 0) {
    const batch = await import('./file-batch.js');
    for (const entry of result.freigaben) await batch.replanUnblockedReservationWaits(entry.project, entry.paths);
  }
  if (!identity && (aktuellerAgentAufruf()?.bezug.modus ?? (await leseAgentBezugModus()).modus) !== 'alt') {
    const token = await releaseStaleFileReservations(args,true);
    return { abgelaufen: result.abgelaufen + token.abgelaufen, abgemeldet: result.abgemeldet + token.abgemeldet };
  }
  return { abgelaufen: result.abgelaufen, abgemeldet: result.abgemeldet };
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
  const identityId = aktuelleAgentIdentityId(args.project, args.agentId);
  const table = identityId ? 'agent_identitaet_file_reservations' : 'file_reservations';
  const actorColumn = identityId ? 'identity_id' : 'agent_id';
  const reservations: FileReservation[] = [];
  for (const filePath of args.filePaths) {
    if(aktuellerAgentAufruf() && aktuellerAgentAufruf()?.bezug.modus !== 'alt') await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['file-reservation:'+args.project+':'+filePath]);
    const baselineHash = await currentFileHash(client, args.project, filePath);
    await client.query(
      `INSERT INTO ${table} (
         project, agent_id, file_path, expires_at, plan_id,
         content_hash_at_reservation, last_extended_at${identityId ? ', identity_id' : ''}
       )
       VALUES (
         $1, $2, $3,
         COALESCE($4::timestamptz, NOW() + ($6 * INTERVAL '1 second')),
         $5::bigint, $7, NOW()${identityId ? ', $8' : ''}
       )
       ON CONFLICT (project, ${actorColumn}, file_path) WHERE released_at IS NULL
       DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         plan_id = COALESCE(EXCLUDED.plan_id, ${table}.plan_id),
         content_hash_at_reservation = COALESCE(
           ${table}.content_hash_at_reservation,
           EXCLUDED.content_hash_at_reservation
         ),
         last_extended_at = NOW()`,
      [
        args.project, args.agentId, filePath, args.expiresAt, args.planId,
        args.planId === null ? config.planlessMinutes * 60 : scaledTtlSeconds(config, 1), baselineHash, ...(identityId ? [identityId] : []),
      ],
    );

    // Beide Tabellen einzeln sperren: FOR UPDATE auf einer UNION ist nicht erlaubt.
    const lockedRows: FileReservationRow[] = [];
    const tables = aktuellerAgentAufruf()?.bezug.modus === 'alt' || !aktuellerAgentAufruf()
      ? ['file_reservations'] : ['file_reservations', 'agent_identitaet_file_reservations'];
    for (const t of tables) {
      const result = await client.query<FileReservationRow>(
        `SELECT *, id::text AS id, plan_id::text AS plan_id, (expires_at<=NOW()) AS is_expired
         FROM ${t} WHERE project=$1 AND file_path=$2 AND released_at IS NULL ORDER BY ${t}.reserved_at,${t}.id FOR UPDATE`,
        [args.project, filePath]);
      lockedRows.push(...result.rows);
    }
    lockedRows.sort((a,b) => new Date(a.reserved_at).getTime()-new Date(b.reserved_at).getTime() || Number(a.id)-Number(b.id));
    const locked = { rows: lockedRows };
    const primary = locked.rows[0];
    let coordinationHint: string | null = null;

    if (primary && fileAgentKey(primary) !== fileAgentKey({agent_id:args.agentId,identity_id:identityId})) {
      if (new Date(primary.expires_at).getTime() > Date.now()) {
        coordinationHint = `Aktive Primaerreservierung von ${primary.agent_id}; Co-Edit-Wait verwenden.`;
      } else {
        const contender = locked.rows.find(
          (row) => fileAgentKey(row) !== fileAgentKey(primary)
            && new Date(row.expires_at).getTime() > Date.now(),
        );
        // Ein offener Plan blockiert die Uebernahme nicht mehr (28.09.2026): Plaene
        // laufen nicht ab, sonst haelte ein abgestuerzter Owner die Datei ewig.
        const { rows: checks } = await client.query<{
          within_grace: boolean;
          has_activity: boolean;
          hash_drifted: boolean;
        }>(
          `SELECT
             NOW() < $3::timestamptz + ($4 * INTERVAL '1 minute') AS within_grace,
             EXISTS (
               SELECT 1 FROM tool_calls t
                WHERE (($8::text IS NOT NULL AND t.identity_id=$8) OR ($8::text IS NULL AND t.identity_id IS NULL AND t.agent_id=$2))
                  AND (t.project = $1 OR t.project IS NULL)
                  AND t.ts > $3::timestamptz
             ) AS has_activity,
             COALESCE((
               SELECT cf.content_hash FROM code_files cf
                WHERE cf.project = $1 AND cf.file_path = $5
                  AND cf.deleted_at IS NULL LIMIT 1
             ), $6) <> COALESCE($7, $6) AS hash_drifted`,
          [
            args.project, primary.agent_id, primary.expires_at,
            config.takeoverGraceMinutes, filePath,
            EMPTY_CONTENT_HASH, primary.content_hash_at_reservation, primary.identity_id ?? null,
          ],
        );
        const check = checks[0];
        const blockers = [
          check.within_grace ? 'Grace-Phase' : null,
          check.has_activity ? 'Activity seit Ablauf' : null,
          check.hash_drifted ? 'Content-Hash geaendert' : null,
        ].filter((value): value is string => value !== null);

        if (contender && blockers.length === 0) {
          await client.query(
            `UPDATE ${primary.identity_id ? 'agent_identitaet_file_reservations' : 'file_reservations'}
                SET released_at = NOW(), taken_over_at = NOW(), taken_over_by = $2, taken_over_by_identity_id=$3
              WHERE id = $1::bigint AND released_at IS NULL`,
            [primary.id, contender.agent_id, contender.identity_id ?? null],
          );
          await client.query(
            `UPDATE file_batch_waits
                SET status = 'conflict', updated_at = NOW()
              WHERE project = $1 AND primary_identity_id IS NOT DISTINCT FROM $4
                AND ($4::text IS NOT NULL OR primary_agent = $2)
                AND $3 = ANY(shared_files)
                AND status IN ('waiting', 'linked')
                -- Gemeinsamer Plan (28.09.2026): Waits, deren Ziel ein offener Co-Edit-Plan
                -- ist, bleiben — der Plan ueberlebt den Owner, samt allen Beitraegen.
                AND NOT EXISTS (
                  SELECT 1 FROM file_batch_plans p
                   WHERE p.project = $1 AND p.status = 'open' AND p.open_for_coedit = true
                     AND (p.id = file_batch_waits.primary_plan_id
                          OR (p.owner_identity_id IS NOT DISTINCT FROM $4 AND ($4::text IS NOT NULL OR p.owner_agent_id = $2) AND p.expected_hashes ? $3))
                )`,
            [args.project, primary.agent_id, filePath, primary.identity_id ?? null],
          );
          coordinationHint = fileAgentKey(contender) === fileAgentKey({agent_id:args.agentId,identity_id:identityId})
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
      // Befund 693bbf48 (d): nur die EIGENE Reservierung — wer reserviert, verlaengert
      // nicht mehr die eines anderen (ausgefallenen) Agenten auf derselben Datei.
      await refreshReservationTtlsForFiles(
        { project: args.project, filePaths: [filePath], agentId: args.agentId },
        client,
      );
    } else {
      await syncWaitExpiries(client, args.project, [filePath]);
    }

    const { rows } = await client.query<FileReservationRow>(
      `SELECT *, id::text AS id, plan_id::text AS plan_id, (expires_at<=NOW()) AS is_expired
         FROM ${table}
        WHERE project = $1 AND ${actorColumn} = $2 AND file_path = $3
          AND released_at IS NULL
        LIMIT 1`,
      [args.project, identityId ?? args.agentId, filePath],
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
  const identityId = aktuelleAgentIdentityId(project, agentId);
  const table = identityId ? 'agent_identitaet_file_reservations' : 'file_reservations';
  const actorColumn = identityId ? 'identity_id' : 'agent_id';
  const { rows } = await client.query<FileReservationRow>(
    `UPDATE ${table}
        SET released_at = NOW()
      WHERE project = $1
        AND ${actorColumn} = $2
        AND file_path = ANY($3::text[])
        AND released_at IS NULL
      RETURNING
        ${identityId ? 'identity_id, taken_over_by_identity_id,' : ''} id::text AS id, project, agent_id, file_path,
        reserved_at, expires_at, released_at, plan_id::text AS plan_id,
         content_hash_at_reservation, last_extended_at, taken_over_at, taken_over_by,
         (expires_at <= NOW()) AS is_expired`,
    [project, identityId ?? agentId, filePaths],
  );
  return rows.map(mapReservation);
}

/**
 * Liefert fuer Pfade ohne aktive Reservierung des Agenten die juengste bereits
 * freigegebene Zeile mit Grund: 'commit' (released_at deckt sich mit committed_at
 * eines committeten Plans auf diesem Pfad), 'takeover' oder 'release'.
 * Pfade ohne jede Reservierungszeile fehlen im Ergebnis (= missing_paths).
 */
async function findAlreadyReleased(
  client: ReservationQueryClient,
  project: string,
  agentId: string,
  filePaths: readonly string[],
): Promise<AlreadyReleasedReservation[]> {
  if (filePaths.length === 0) return [];
  const identityId = aktuelleAgentIdentityId(project, agentId);
  const table = identityId ? 'agent_identitaet_file_reservations' : 'file_reservations';
  const actorColumn = identityId ? 'identity_id' : 'agent_id';
  const { rows } = await client.query<{
    file_path: string;
    released_at: Date | string;
    plan_id: string | null;
    taken_over_by: string | null;
    commit_plan_id: string | null;
  }>(
    `SELECT DISTINCT ON (r.file_path)
            r.file_path, r.released_at, r.plan_id::text AS plan_id, r.taken_over_by,
            (SELECT p.id::text FROM file_batch_plans p
              WHERE p.project = r.project AND p.status = 'committed'
                AND p.expected_hashes ? r.file_path
                AND p.committed_at BETWEEN r.released_at - INTERVAL '2 seconds'
                                       AND r.released_at + INTERVAL '2 seconds'
              ORDER BY (p.id = r.plan_id) DESC NULLS LAST,
                       ABS(EXTRACT(EPOCH FROM (p.committed_at - r.released_at)))
              LIMIT 1) AS commit_plan_id
       FROM ${table} r
      WHERE r.project = $1 AND r.${actorColumn} = $2
        AND r.file_path = ANY($3::text[])
        AND r.released_at IS NOT NULL
      ORDER BY r.file_path, r.released_at DESC, r.id DESC`,
    [project, identityId ?? agentId, [...filePaths]],
  );
  return rows.map((row) => ({
    file_path: row.file_path,
    released_at: iso(row.released_at),
    reason: row.taken_over_by ? 'takeover' : row.commit_plan_id ? 'commit' : 'release',
    plan_id: row.commit_plan_id ?? row.plan_id ?? null,
    ...(row.taken_over_by ? { taken_over_by: row.taken_over_by } : {}),
  }));
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
  const result = await inTransaction(async (client) => {
    const released = await releaseWithClient(client, args.project, args.agentId, filePaths);
    const releasedPaths = new Set(released.map((entry) => entry.file_path));
    const notReleased = filePaths.filter((filePath) => !releasedPaths.has(filePath));
    // Befund 3: commit gibt Reservierungen still frei. Solche Pfade sind kein
    // Fehler, sondern already_released (mit released_at und Grund).
    const alreadyReleased = await findAlreadyReleased(client, args.project, args.agentId, notReleased);
    const alreadySet = new Set(alreadyReleased.map((entry) => entry.file_path));
    return {
      released,
      already_released: alreadyReleased,
      missing_paths: notReleased.filter((filePath) => !alreadySet.has(filePath)),
    };
  });
  if (result.released.length > 0) {
    const batch = await import('./file-batch.js');
    await batch.replanUnblockedReservationWaits(args.project, result.released.map((r) => r.file_path));
  }
  return result;
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
  const identityId = aktuelleAgentIdentityId(args.project,args.agentId);
  const table = identityId ? 'agent_identitaet_file_reservations' : 'file_reservations';
  const actorColumn = identityId ? 'identity_id' : 'agent_id';
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
             ${identityId ? 'identity_id, taken_over_by_identity_id,' : ''} id::text AS id, project, agent_id, file_path,
             reserved_at, expires_at, released_at, plan_id::text AS plan_id,
         content_hash_at_reservation, last_extended_at, taken_over_at, taken_over_by,
         (expires_at <= NOW()) AS is_expired
           FROM ${table}
           WHERE project = $1
             AND ${actorColumn} = $2
             AND file_path = ANY($3::text[])
             AND released_at IS NULL
           ORDER BY reserved_at, id`,
          [args.project, identityId ?? args.agentId, keepPaths],
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
    const notReleased = releasePaths.filter((filePath) => !releasedSet.has(filePath));
    const alreadyReleased = await findAlreadyReleased(client, args.project, args.agentId, notReleased);
    const alreadySet = new Set(alreadyReleased.map((entry) => entry.file_path));
    return {
      added,
      kept,
      released,
      already_released: alreadyReleased,
      missing_keep_paths: keepPaths.filter((filePath) => !keptSet.has(filePath)),
      missing_release_paths: notReleased.filter((filePath) => !alreadySet.has(filePath)),
    };
  });
}

export async function listFileReservations(args: {
  project: string;
  agentId?: string;
  filePaths?: readonly string[];
  includeReleased?: boolean;
}): Promise<FileReservation[]> {
  const identityId = args.agentId ? aktuelleAgentIdentityId(args.project,args.agentId) : null;
  const idMode = aktuellerAgentAufruf()?.bezug.modus !== 'alt' && !!aktuellerAgentAufruf();
  const filePaths = optionalPaths(args.filePaths);
  const values: unknown[] = [args.project];
  const conditions = ['project = $1'];

  if (args.agentId) {
    values.push(identityId ?? args.agentId);
    conditions.push(identityId ? `identity_id = $${values.length}` : `${idMode ? 'identity_id IS NULL AND ' : ''}agent_id = $${values.length}`);
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
       ${idMode ? 'identity_id, taken_over_by_identity_id,' : ''} id::text AS id, project, agent_id, file_path,
       reserved_at, expires_at, released_at, plan_id::text AS plan_id,
         content_hash_at_reservation, last_extended_at, taken_over_at, taken_over_by,
         (expires_at <= NOW()) AS is_expired
     FROM ${idMode ? reservierungsQuelle() : 'file_reservations'} AS reservations
     WHERE ${conditions.join(' AND ')}
     ORDER BY file_path, reserved_at, id`,
    values,
  );
  return rows.map(mapReservation);
}


export interface ForeignActiveReservationPrimary {
  file_path: string;
  reserved_by: string;
  reserved_identity_id?: string | null;
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
  const idMode = aktuellerAgentAufruf()?.bezug.modus !== 'alt' && !!aktuellerAgentAufruf();
  const identityId = args.callerAgentId ? aktuelleAgentIdentityId(args.project,args.callerAgentId) : null;

  const { rows } = await queryClient.query<{
    file_path: string;
    reserved_by: string;
    reserved_identity_id?: string | null;
    reserved_since: Date | string;
    expires_at: Date | string;
  }>(
    `WITH ranked AS (
       SELECT file_path, agent_id, ${idMode ? 'identity_id,' : ''} reserved_at, expires_at,
              ROW_NUMBER() OVER (
                PARTITION BY file_path ORDER BY reserved_at ASC, id ASC
              ) AS reservation_rank
         FROM ${idMode ? reservierungsQuelle() : 'file_reservations'} AS file_reservations
        WHERE project = $1
          AND file_path = ANY($2::text[])
          AND released_at IS NULL
          -- P15-T27: nur LEBENDE Reservierungen koordinieren. Eine abgelaufene (niemand verlaengert
          -- sie mehr, renewDue verlaengert nur lebende) oder die eines abgemeldeten Agenten erzeugte
          -- vorher einen Wait, der sich nie loeste (Reservierung 3996, Plaene 24811/24812).
          AND expires_at > NOW()
          AND NOT EXISTS (
            SELECT 1 FROM agent_sessions s WHERE ${idMode ? 'file_reservations.identity_id IS NULL AND' : ''} s.id = file_reservations.agent_id AND s.status <> 'active'
          )
          ${idMode ? "AND NOT EXISTS(SELECT 1 FROM agent_identitaet_sitzungen s WHERE s.identity_id=file_reservations.identity_id AND s.status<>'active')" : ''}
     )
     SELECT file_path, agent_id AS reserved_by, ${idMode ? 'identity_id AS reserved_identity_id,' : ''} reserved_at AS reserved_since, expires_at
       FROM ranked
      WHERE reservation_rank = 1
        AND (${idMode ? "($4::text IS NOT NULL AND identity_id IS DISTINCT FROM $4) OR ($4::text IS NULL AND ($3::text IS NULL OR identity_id IS NOT NULL OR agent_id <> $3))" : "$3::text IS NULL OR agent_id <> $3"})`,
    [args.project, filePaths, args.callerAgentId ?? null, ...(idMode ? [identityId] : [])],
  );

  const byPath = new Map(rows.map((row) => [row.file_path, row] as const));
  return filePaths.flatMap((filePath) => {
    const row = byPath.get(filePath);
    return row
      ? [{
          file_path: row.file_path,
          reserved_by: row.reserved_by,
          ...(row.reserved_identity_id ? { reserved_identity_id: row.reserved_identity_id } : {}),
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