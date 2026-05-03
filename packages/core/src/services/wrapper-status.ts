/**
 * MODUL: wrapper-status Service
 * ZWECK: Source-of-Truth fuer laufende Wrapper/Spezialisten in PostgreSQL.
 *
 * Ersetzt .synapse/agents/status.json als primaere Datenquelle.
 * Beide Eingangs-Pfade (stdio-MCP + REST) nutzen diese Funktionen.
 * status.json bleibt als optionaler Cache fuer Backward-Compat.
 */

import { getPool } from '../db/client.js'

export interface WrapperStatusRow {
  agentName: string
  project: string
  wrapperPid: number | null
  innerPid: number | null
  socketPath: string | null
  model: string | null
  modelFullId: string | null
  provider: string | null
  status: 'running' | 'idle' | 'crashed' | 'stopped'
  busy: boolean
  currentTask: string | null
  contextCeiling: number | null
  tokensInput: number | null
  tokensOutput: number | null
  tokensPercent: number | null
  channels: string[]
  connectedMcp: boolean
  lastActivity: Date
}

/** Datenbank-Row (snake_case) → WrapperStatusRow (camelCase) */
function mapRow(row: Record<string, unknown>): WrapperStatusRow {
  return {
    agentName: row.agent_name as string,
    project: row.project as string,
    wrapperPid: row.wrapper_pid as number | null,
    innerPid: row.inner_pid as number | null,
    socketPath: row.socket_path as string | null,
    model: row.model as string | null,
    modelFullId: row.model_full_id as string | null,
    provider: row.provider as string | null,
    status: (row.status as string) as WrapperStatusRow['status'],
    busy: row.busy as boolean,
    currentTask: row.current_task as string | null,
    contextCeiling: row.context_ceiling as number | null,
    tokensInput: row.tokens_input as number | null,
    tokensOutput: row.tokens_output as number | null,
    tokensPercent: row.tokens_percent != null ? Number(row.tokens_percent) : null,
    channels: (row.channels as string[]) ?? [],
    connectedMcp: row.connected_mcp as boolean,
    lastActivity: new Date(row.last_activity as string),
  }
}

/**
 * Upsert: Schreibt oder aktualisiert einen Wrapper-Status-Eintrag.
 * Wird bei jedem Heartbeat-Tick aufgerufen.
 */
export async function upsertWrapperStatus(
  row: Partial<WrapperStatusRow> & { agentName: string; project: string },
): Promise<void> {
  const pool = getPool()
  await pool.query(
    `INSERT INTO wrapper_status (
        agent_name, project, wrapper_pid, inner_pid, socket_path,
        model, model_full_id, provider, status, busy, current_task,
        context_ceiling, tokens_input, tokens_output, tokens_percent,
        channels, connected_mcp, last_activity
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, NOW()
      )
      ON CONFLICT (agent_name, project) DO UPDATE SET
        wrapper_pid     = COALESCE(EXCLUDED.wrapper_pid,     wrapper_status.wrapper_pid),
        inner_pid       = COALESCE(EXCLUDED.inner_pid,       wrapper_status.inner_pid),
        socket_path     = COALESCE(EXCLUDED.socket_path,     wrapper_status.socket_path),
        model           = COALESCE(EXCLUDED.model,           wrapper_status.model),
        model_full_id   = COALESCE(EXCLUDED.model_full_id,   wrapper_status.model_full_id),
        provider        = COALESCE(EXCLUDED.provider,        wrapper_status.provider),
        status          = EXCLUDED.status,
        busy            = EXCLUDED.busy,
        current_task    = EXCLUDED.current_task,
        context_ceiling = COALESCE(EXCLUDED.context_ceiling, wrapper_status.context_ceiling),
        tokens_input    = COALESCE(EXCLUDED.tokens_input,    wrapper_status.tokens_input),
        tokens_output   = COALESCE(EXCLUDED.tokens_output,   wrapper_status.tokens_output),
        tokens_percent  = COALESCE(EXCLUDED.tokens_percent,  wrapper_status.tokens_percent),
        channels        = EXCLUDED.channels,
        connected_mcp   = EXCLUDED.connected_mcp,
        last_activity   = NOW()`,
    [
      row.agentName,
      row.project,
      row.wrapperPid ?? null,
      row.innerPid ?? null,
      row.socketPath ?? null,
      row.model ?? null,
      row.modelFullId ?? null,
      row.provider ?? null,
      row.status ?? 'idle',
      row.busy ?? false,
      row.currentTask ?? null,
      row.contextCeiling ?? null,
      row.tokensInput ?? null,
      row.tokensOutput ?? null,
      row.tokensPercent ?? null,
      row.channels ?? [],
      row.connectedMcp ?? false,
    ],
  )
}

/**
 * Liest den Status eines einzelnen Spezialisten.
 * Gibt null zurueck wenn kein Eintrag vorhanden.
 */
export async function getWrapperStatus(
  agentName: string,
  project: string,
): Promise<WrapperStatusRow | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM wrapper_status WHERE agent_name = $1 AND project = $2`,
    [agentName, project],
  )
  return rows.length > 0 ? mapRow(rows[0]) : null
}

/**
 * Listet alle Spezialisten eines Projekts.
 * Sortiert nach last_activity DESC (aktive zuerst).
 */
export async function listWrapperStatus(project: string): Promise<WrapperStatusRow[]> {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT * FROM wrapper_status WHERE project = $1 ORDER BY last_activity DESC`,
    [project],
  )
  return rows.map(mapRow)
}

/**
 * Loescht den Status-Eintrag eines Spezialisten.
 * Wird bei purge/removeSpecialist aufgerufen.
 */
export async function removeWrapperStatus(agentName: string, project: string): Promise<void> {
  const pool = getPool()
  await pool.query(
    `DELETE FROM wrapper_status WHERE agent_name = $1 AND project = $2`,
    [agentName, project],
  )
}
