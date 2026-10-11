/**
 * MODUL: Intern-Einblick (P14-T4, 11.10.2026)
 * ZWECK: Einblick in die internen Ablaeufe fuer das intern-Tool — in EINEM Aufruf statt verstreuter SQL-
 *        Abfragen: status (Queue, Pools, Rueckstand, Worker, Kontingent, Modell, Schalter), db_sitzungen
 *        (pg_stat_activity) und langsam (langsamste tool_calls).
 *
 * NUR LESEN: nichts wird beendet, nichts geaendert. db_sitzungen zeigt "idle in transaction" mit Sperren
 *   und blockierende PIDs an — beenden bleibt eine bewusste Handlung von Hand (pg_terminate_backend).
 * QUELLEN AUS ANDEREN PAKETEN: Was nicht in core lebt (Parser-Worker der rest-api), meldet sich ueber
 *   registriereInternQuelle(name, fn) an und erscheint in status unter quellen.<name>.
 * TEILAUSFAELLE: jeder Teil von status ist einzeln abgesichert; ein Fehler steht als { fehler } an seiner
 *   Stelle, der Rest kommt trotzdem.
 */

import type { Pool } from 'pg';
import { getPool, getHintergrundPool } from '../db/client.js';
import { getEmbeddingQueueStats, embeddingModellKennung } from '../embeddings/index.js';
import { zaehleOffeneEmbeddings } from './embed-backlog.js';
import { context7Kontingent } from './context7-kontingent.js';
import { alleSchalter } from './intern-schalter.js';

const quellen = new Map<string, () => unknown>();

/** Meldet eine Statusquelle aus einem anderen Paket an (z. B. rest-api Parser-Worker). */
export function registriereInternQuelle(name: string, quelle: () => unknown): void {
  quellen.set(name, quelle);
}

async function sicher<T>(fn: () => T | Promise<T>): Promise<T | { fehler: string }> {
  try {
    return await fn();
  } catch (err) {
    return { fehler: err instanceof Error ? err.message : String(err) };
  }
}

function poolStand(pool: Pool): Record<string, number | null> {
  return {
    max: (pool as unknown as { options?: { max?: number } }).options?.max ?? null,
    gesamt: pool.totalCount,
    frei: pool.idleCount,
    wartend: pool.waitingCount,
  };
}

/** Gesamtbild in einem Aufruf. */
export async function internStatus(): Promise<Record<string, unknown>> {
  const [offene, context7, schalter] = await Promise.all([
    sicher(() => zaehleOffeneEmbeddings()),
    sicher(() => context7Kontingent()),
    sicher(() => alleSchalter()),
  ]);
  const weitere: Record<string, unknown> = {};
  for (const [name, quelle] of quellen) weitere[name] = await sicher(quelle);
  return {
    embedding_modell: await sicher(() => embeddingModellKennung()),
    embedding_queue: getEmbeddingQueueStats(),
    db_pools: { haupt: poolStand(getPool()), hintergrund: poolStand(getHintergrundPool()) },
    offene_embeddings: offene,
    context7,
    schalter,
    quellen: weitere,
  };
}

interface SitzungsZeile {
  pid: number;
  usename: string | null;
  application_name: string | null;
  client_addr: string | null;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  abfrage_s: number | null;
  transaktion_s: number | null;
  zustand_s: number | null;
  sperren: number;
  blockiert_von: number[];
  query: string | null;
}

/**
 * pg_stat_activity der eigenen Datenbank: Zusammenfassung nach Zustand und Client, dazu laufende Abfragen
 * ab minSekunden, alle "idle in transaction" (mit Zahl gehaltener Sperren) und blockierte Sitzungen.
 */
export async function dbSitzungen(minSekunden = 5): Promise<Record<string, unknown>> {
  const { rows } = await getPool().query<SitzungsZeile>(
    `SELECT a.pid, a.usename, a.application_name, a.client_addr::text AS client_addr, a.state,
            a.wait_event_type, a.wait_event,
            EXTRACT(EPOCH FROM (now() - a.query_start))::int  AS abfrage_s,
            EXTRACT(EPOCH FROM (now() - a.xact_start))::int   AS transaktion_s,
            EXTRACT(EPOCH FROM (now() - a.state_change))::int AS zustand_s,
            (SELECT count(*)::int FROM pg_locks l WHERE l.pid = a.pid AND l.granted) AS sperren,
            pg_blocking_pids(a.pid) AS blockiert_von,
            left(a.query, 300) AS query
       FROM pg_stat_activity a
      WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.backend_type = 'client backend'`,
  );
  const nachZustand: Record<string, number> = {};
  const nachClient: Record<string, number> = {};
  for (const z of rows) {
    const zustand = z.state ?? 'unbekannt';
    nachZustand[zustand] = (nachZustand[zustand] ?? 0) + 1;
    const client = `${z.application_name || '-'} @ ${z.client_addr ?? 'lokal'}`;
    nachClient[client] = (nachClient[client] ?? 0) + 1;
  }
  const kurz = (z: SitzungsZeile) => ({
    pid: z.pid, client: `${z.application_name || '-'} @ ${z.client_addr ?? 'lokal'}`, zustand: z.state,
    abfrage_s: z.abfrage_s, transaktion_s: z.transaktion_s, zustand_s: z.zustand_s, warten_auf: z.wait_event_type ? `${z.wait_event_type}/${z.wait_event}` : null,
    sperren: z.sperren, blockiert_von: z.blockiert_von, query: z.query,
  });
  const idleInTx = rows.filter((z) => (z.state ?? '').startsWith('idle in transaction'));
  return {
    gesamt: rows.length,
    nach_zustand: nachZustand,
    nach_client: nachClient,
    min_sekunden: minSekunden,
    lange_abfragen: rows.filter((z) => z.state === 'active' && (z.abfrage_s ?? 0) >= minSekunden)
      .sort((x, y) => (y.abfrage_s ?? 0) - (x.abfrage_s ?? 0)).map(kurz),
    idle_in_transaction: idleInTx.sort((x, y) => (y.transaktion_s ?? 0) - (x.transaktion_s ?? 0)).map(kurz),
    blockiert: rows.filter((z) => z.blockiert_von.length > 0).map(kurz),
    hinweis: idleInTx.some((z) => z.sperren > 0)
      ? 'idle in transaction MIT Sperren ist der typische Verursacher haengender Anfragen. Das Tool beendet nichts.'
      : undefined,
  };
}

// Bewusst wartende Aufrufe (Long-Poll) gehoeren nicht in die Liste der langsamen.
const WARTEND_SQL =
  `(tool_name IN ('files', 'files_batch') AND action IN ('plan_status', 'shared_plan_status', 'commit')
    AND args_preview ~ '"wait_seconds"\\s*:\\s*"?[1-9]')`;

/** Langsamste tool_calls der letzten minuten, ohne bewusst wartende; optional auf ein Projekt begrenzt. */
export async function langsameAufrufe(opt: { minuten?: number; limit?: number; project?: string } = {}): Promise<Record<string, unknown>> {
  const minuten = opt.minuten ?? 30;
  const limit = opt.limit ?? 20;
  const werte = [minuten, opt.project ?? null];
  const fenster = `ts > now() - make_interval(mins => $1::int) AND duration_ms IS NOT NULL
                   AND ($2::text IS NULL OR project = $2)`;
  const [liste, gruppen, wartend] = await Promise.all([
    getPool().query(
      `SELECT id::text, ts, tool_name, action, agent_id, project, duration_ms, ok, left(args_preview, 200) AS args
         FROM tool_calls WHERE ${fenster} AND NOT ${WARTEND_SQL}
        ORDER BY duration_ms DESC LIMIT $3`,
      [...werte, limit],
    ),
    getPool().query(
      `SELECT tool_name, action, count(*)::int AS anzahl, max(duration_ms) AS max_ms,
              round(avg(duration_ms))::int AS mittel_ms,
              (percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int AS median_ms
         FROM tool_calls WHERE ${fenster} AND NOT ${WARTEND_SQL}
        GROUP BY tool_name, action ORDER BY max_ms DESC LIMIT 15`,
      werte,
    ),
    getPool().query(`SELECT count(*)::int AS n FROM tool_calls WHERE ${fenster} AND ${WARTEND_SQL}`, werte),
  ]);
  return {
    minuten,
    project: opt.project ?? null,
    langsamste: liste.rows,
    je_tool: gruppen.rows,
    ausgeschlossen_wartend: wartend.rows[0]?.n ?? 0,
  };
}
