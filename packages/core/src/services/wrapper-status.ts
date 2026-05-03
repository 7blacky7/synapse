/**
 * MODUL: wrapper-status Service
 * ZWECK: Source-of-Truth fuer laufende Wrapper/Spezialisten in PostgreSQL.
 *
 * Ersetzt .synapse/agents/status.json als primaere Datenquelle.
 * Beide Eingangs-Pfade (stdio-MCP + REST) nutzen diese Funktionen.
 * status.json bleibt als optionaler Cache fuer Backward-Compat.
 *
 * PARTIAL-UPDATE-SEMANTIK:
 *   Felder die nicht uebergeben werden (undefined → null) werden auf
 *   bestehende DB-Werte gefallen. Nur explizit gesetzte Felder aendern sich.
 *   Ausnahme: last_activity wird immer auf NOW() gesetzt.
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
 *
 * PARTIAL-UPDATE-SAFE: Felder die nicht uebergeben werden bleiben unveraendert.
 * Fuer den INSERT-Fall (neue Row) gelten Schema-Defaults (idle/false/{}/false).
 *
 * Empfehlung fuer Caller:
 *   - Heartbeat-Tick (Token-Update): nur tokensInput/Output/Percent uebergeben
 *   - Status-Aenderung: status + busy + currentTask uebergeben
 *   - wrapperStatusFlush (90s-Tick): ALLE Felder uebergeben fuer konsistenten State
 */
export async function upsertWrapperStatus(
  row: Partial<WrapperStatusRow> & { agentName: string; project: string },
): Promise<void> {
  const pool = getPool()
  // Konvertiere undefined → null fuer alle optionalen Felder.
  // Im INSERT-Pfad: COALESCE($N, <default>) setzt den richtigen Default.
  // Im UPDATE-Pfad: COALESCE($N, wrapper_status.field) preserviert bestehende Werte.
  // So ist jedes Feld single-source: nur explizit gesetzte Werte aendern die DB.
  await pool.query(
    `INSERT INTO wrapper_status (
        agent_name, project, wrapper_pid, inner_pid, socket_path,
        model, model_full_id, provider,
        status, busy, current_task,
        context_ceiling, tokens_input, tokens_output, tokens_percent,
        channels, connected_mcp, last_activity
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8,
        COALESCE($9,        'idle'),
        COALESCE($10::BOOLEAN, false),
        $11,
        $12, $13, $14, $15,
        COALESCE($16::TEXT[], '{}'),
        COALESCE($17::BOOLEAN, false),
        NOW()
      )
      ON CONFLICT (agent_name, project) DO UPDATE SET
        wrapper_pid     = COALESCE($3,            wrapper_status.wrapper_pid),
        inner_pid       = COALESCE($4,            wrapper_status.inner_pid),
        socket_path     = COALESCE($5,            wrapper_status.socket_path),
        model           = COALESCE($6,            wrapper_status.model),
        model_full_id   = COALESCE($7,            wrapper_status.model_full_id),
        provider        = COALESCE($8,            wrapper_status.provider),
        status          = COALESCE($9,            wrapper_status.status),
        busy            = COALESCE($10::BOOLEAN,  wrapper_status.busy),
        current_task    = COALESCE($11,           wrapper_status.current_task),
        context_ceiling = COALESCE($12,           wrapper_status.context_ceiling),
        tokens_input    = COALESCE($13,           wrapper_status.tokens_input),
        tokens_output   = COALESCE($14,           wrapper_status.tokens_output),
        tokens_percent  = COALESCE($15,           wrapper_status.tokens_percent),
        channels        = COALESCE($16::TEXT[],   wrapper_status.channels),
        connected_mcp   = COALESCE($17::BOOLEAN,  wrapper_status.connected_mcp),
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
      row.status ?? null,        // null → INSERT: 'idle', UPDATE: preserve existing
      row.busy ?? null,          // null → INSERT: false, UPDATE: preserve existing
      row.currentTask ?? null,
      row.contextCeiling ?? null,
      row.tokensInput ?? null,
      row.tokensOutput ?? null,
      row.tokensPercent ?? null,
      row.channels ?? null,      // null → INSERT: '{}', UPDATE: preserve existing
      row.connectedMcp ?? null,  // null → INSERT: false, UPDATE: preserve existing
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
