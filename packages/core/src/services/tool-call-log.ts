/**
 * MODUL: Tool-Call Activity-Log
 * ZWECK: Zentraler Audit-Log ALLER MCP-Tool-Aufrufe (tool_calls-Tabelle).
 *        Quelle der Multi-Agenten-Aufsicht via shell(action:"activity").
 *
 * - logToolCall(): schreibt einen Eintrag (best-effort, non-blocking beim Aufrufer).
 *   Speichert das volle result bis zu einem konfigurierbaren Cap
 *   (Env SYNAPSE_TOOLCALL_RESULT_CAP, Default 32 KB) — groessere Ergebnisse
 *   werden gekappt + result_truncated=true + result_bytes=Gesamtgroesse.
 * - isMutationAction(): leitet aus dem Action-Namen ab, ob es ein Schreibzugriff
 *   ist (kein handgepflegtes Tool-Mapping). Konservativ: im Zweifel false.
 * - queryToolCalls(): SELECT mit den Filter-Achsen der activity-Action.
 *
 * NEBENEFFEKTE: PostgreSQL INSERT/SELECT auf tool_calls. Keine externen Systeme.
 */

import { getPool } from '../db/index.js';

/** Cap fuer das gespeicherte result (Storage-/PII-Hebel). Default 32 KB. */
const RESULT_CAP = (() => {
  const env = Number(process.env.SYNAPSE_TOOLCALL_RESULT_CAP);
  return Number.isFinite(env) && env > 0 ? Math.floor(env) : 32_768;
})();

/**
 * Schreibzugriff-Heuristik aus dem Action-Namen. Verben werden als ganze
 * Wort-Segmente (zwischen Anfang/Ende/Unterstrich) gematcht, damit z.B.
 * "index_stats" (Read) nicht faelschlich als Mutation gilt, "index_media"
 * (Mutation) aber schon. Erweiterbar ueber die Verb-Liste.
 */
const MUTATION_PATTERN =
  /(?:^|_)(write|create|update|delete|del|add|insert|replace|move|copy|remove|commit|restore|spawn|purge|stop|start|materialize|save|migrate|set|rm|emit|ack|post|pin|unpin|index_media|confirm)(?:_|$)/i;

export function isMutationAction(action?: string | null): boolean {
  if (!action) return false;
  return MUTATION_PATTERN.test(action);
}

export interface ToolCallLogEntry {
  project?: string | null;
  /** Echte Attribution. Wenn null, faellt der Eintrag auf source zurueck. */
  agentId?: string | null;
  /** Fallback-Quelle wenn keine agentId (z.B. "mcp" | "gpt-web" | "anonymous"). */
  source?: string | null;
  tool: string;
  action?: string | null;
  /** Bereits kompaktes JSON der Kern-Args (Aufrufer kuerzt). */
  argsPreview?: string | null;
  ok: boolean;
  error?: string | null;
  durationMs?: number | null;
  /** Volles Ergebnis als String — wird hier auf RESULT_CAP gekappt. */
  result?: string | null;
}

/**
 * Schreibt einen Tool-Call-Eintrag. Best-effort: faengt alle Fehler selbst ab,
 * damit das Logging einen Tool-Call NIE verlangsamt oder zum Scheitern bringt.
 * Aufrufer sollten zusaetzlich nicht awaiten bzw. .catch() anhaengen.
 */
export async function logToolCall(entry: ToolCallLogEntry): Promise<void> {
  try {
    let result = entry.result ?? null;
    let resultBytes: number | null = null;
    let truncated = false;
    if (result != null) {
      resultBytes = Buffer.byteLength(result, 'utf8');
      if (resultBytes > RESULT_CAP) {
        result = result.slice(0, RESULT_CAP) + `\n…[truncated — ${resultBytes} bytes total]`;
        truncated = true;
      }
    }
    const pool = getPool();
    await pool.query(
      `INSERT INTO tool_calls
         (project, agent_id, source, tool_name, action, args_preview, ok,
          error, duration_ms, result, result_bytes, result_truncated, is_mutation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        entry.project ?? null,
        entry.agentId ?? null,
        entry.source ?? (entry.agentId ? null : 'mcp'),
        entry.tool,
        entry.action ?? null,
        entry.argsPreview ?? null,
        entry.ok,
        entry.error ?? null,
        entry.durationMs ?? null,
        result,
        resultBytes,
        truncated,
        isMutationAction(entry.action),
      ],
    );
  } catch (err) {
    console.error('[tool-call-log] logToolCall fehlgeschlagen:', (err as Error).message);
  }
}

export type ActivityDetail = 'meta' | 'summary' | 'full';

export interface ActivityFilters {
  project?: string;
  /** Akzeptiert Agenten-Namen ODER IDs (gleicher Spaltenwert agent_id). */
  agentId?: string[];
  tool?: string[];
  status?: 'ok' | 'error';
  mutationsOnly?: boolean;
  /** ISO-Timestamp — nur Eintraege ab dann. */
  since?: string;
  limit?: number;
  /** Steuert NUR die Rueckgabe-Tiefe, nicht den Speicher. Default meta. */
  detail?: ActivityDetail;
}

export interface ToolCallRow {
  id: string;
  ts: string;
  project: string | null;
  agent_id: string | null;
  source: string | null;
  tool_name: string;
  action: string | null;
  args_preview: string | null;
  ok: boolean;
  error: string | null;
  duration_ms: number | null;
  is_mutation: boolean;
  result?: string | null;
  result_preview?: string | null;
  result_bytes?: number | null;
  result_truncated?: boolean | null;
}

/**
 * Liest den Activity-Store mit kombinierbaren Filtern, neueste zuerst.
 * detail gated die Result-Spalten (meta=kein Result, summary=Vorschau,
 * full=gespeichertes Result bis Cap) — verhindert Context-Overflow.
 */
export async function queryToolCalls(f: ActivityFilters): Promise<ToolCallRow[]> {
  const pool = getPool();
  const where: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (f.project) { where.push(`project = $${i++}`); params.push(f.project); }
  if (f.agentId && f.agentId.length) { where.push(`agent_id = ANY($${i++})`); params.push(f.agentId); }
  if (f.tool && f.tool.length) { where.push(`tool_name = ANY($${i++})`); params.push(f.tool); }
  if (f.status === 'error') where.push('ok = false');
  else if (f.status === 'ok') where.push('ok = true');
  if (f.mutationsOnly) where.push('is_mutation = true');
  if (f.since) { where.push(`ts >= $${i++}`); params.push(f.since); }

  const detail: ActivityDetail = f.detail ?? 'meta';
  const baseCols =
    'id::text, ts, project, agent_id, source, tool_name, action, args_preview, ok, error, duration_ms, is_mutation';
  const cols =
    detail === 'full'
      ? `${baseCols}, result, result_bytes, result_truncated`
      : detail === 'summary'
        ? `${baseCols}, left(result, 200) AS result_preview, result_bytes, result_truncated`
        : baseCols;

  const limit = Math.min(Math.max(f.limit ?? 50, 1), 500);
  const sql =
    `SELECT ${cols} FROM tool_calls` +
    (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
    ` ORDER BY ts DESC LIMIT ${limit}`;

  const res = await pool.query<ToolCallRow>(sql, params);
  return res.rows;
}
