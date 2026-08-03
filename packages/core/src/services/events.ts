/**
 * MODUL: Agenten-Events
 * ZWECK: Broadcast-Events zwischen KI-Agenten — WORK_STOP, CRITICAL_REVIEW, etc.
 *
 * INPUT:
 *   - project: string - Projekt-Identifikator
 *   - eventType: EventType - Art des Events
 *   - priority: EventPriority - Dringlichkeit
 *   - scope: string - 'all' oder 'agent:<id>'
 *   - sourceId: string - Absender-Agent-ID
 *   - payload?: string - Optionaler JSON-Payload
 *   - requiresAck?: boolean - Ob Agenten quittieren muessen
 *
 * OUTPUT:
 *   - AgentEvent: Gespeichertes Event mit ID und Timestamp
 *   - EventAck: Quittierung eines Events
 *   - AgentEvent[]: Ausstehende Events fuer einen Agenten
 *   - number: Anzahl unquittierter Events (fuer Hook-Usage)
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: Schreibt in agent_events / agent_event_acks Tabellen
 *   - Kein Qdrant (Events sind chronologisch, nicht semantisch)
 */

import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';

export type EventType =
  | 'WORK_STOP'
  | 'CRITICAL_REVIEW'
  | 'ARCH_DECISION'
  | 'TEAM_DISCUSSION'
  | 'ANNOUNCEMENT'
  | 'PLAN_READY';

export type EventPriority = 'critical' | 'high' | 'normal';

export interface AgentEvent {
  id: number;
  project: string;
  eventType: EventType;
  priority: EventPriority;
  scope: string;        // 'all' | 'agent:<id>'
  sourceId: string;
  payload: string | null;
  requiresAck: boolean;
  createdAt: string;
}

export interface EventAck {
  eventId: number;
  agentId: string;
  ackedAt: string;
  reaction: string | null;
}

/**
 * Sendet ein Event an alle oder einen bestimmten Agenten
 */
export async function emitEvent(
  project: string,
  eventType: EventType,
  priority: EventPriority,
  scope: string,
  sourceId: string,
  payload?: string,
  requiresAck?: boolean
): Promise<AgentEvent> {
  const pool = getPool();

  const result = await pool.query(
    `INSERT INTO agent_events (project, event_type, priority, scope, source_id, payload, requires_ack, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING id, project, event_type, priority, scope, source_id, payload, requires_ack, created_at`,
    [
      project,
      eventType,
      priority,
      scope,
      sourceId,
      payload ?? null,
      requiresAck !== undefined ? requiresAck : true,
    ]
  );

  const row = result.rows[0];
  const event: AgentEvent = {
    id: row.id,
    project: row.project,
    eventType: row.event_type,
    priority: row.priority,
    scope: row.scope,
    sourceId: row.source_id,
    payload: row.payload,
    requiresAck: row.requires_ack,
    createdAt: row.created_at,
  };

  console.error(
    `[Synapse Events] ${sourceId} → ${scope} [${priority}] ${eventType}: ${payload ? payload.substring(0, 80) : '(kein Payload)'}`
  );
  return event;
}

export interface EmitEventOnceArgs {
  project: string;
  eventType: EventType;
  priority: EventPriority;
  scope: string;
  sourceId: string;
  payload?: string;
  requiresAck?: boolean;
  dedupeKey: string;
}

/**
 * Erzeugt ein Event innerhalb einer bestehenden Transaktion hoechstens einmal.
 * Die partielle Unique-Constraint macht Retries pro fachlichem Dedupe-Key sicher.
 */
export async function emitEventOnce(
  args: EmitEventOnceArgs,
  client: PoolClient,
): Promise<AgentEvent | null> {
  const result = await client.query(
    `INSERT INTO agent_events (
       project, event_type, priority, scope, source_id, payload, requires_ack, dedupe_key, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (project, event_type, scope, dedupe_key)
       WHERE dedupe_key IS NOT NULL
       DO NOTHING
     RETURNING id, project, event_type, priority, scope, source_id, payload, requires_ack, created_at`,
    [
      args.project,
      args.eventType,
      args.priority,
      args.scope,
      args.sourceId,
      args.payload ?? null,
      args.requiresAck ?? true,
      args.dedupeKey,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    project: row.project,
    eventType: row.event_type,
    priority: row.priority,
    scope: row.scope,
    sourceId: row.source_id,
    payload: row.payload,
    requiresAck: row.requires_ack,
    createdAt: row.created_at,
  };
}

/**
 * Quittiert ein Event durch einen Agenten
 */
export async function acknowledgeEvent(
  eventId: number,
  agentId: string,
  reaction?: string
): Promise<EventAck> {
  const pool = getPool();

  const result = await pool.query(
    `INSERT INTO agent_event_acks (event_id, agent_id, acked_at, reaction)
     VALUES ($1, $2, NOW(), $3)
     ON CONFLICT (event_id, agent_id) DO UPDATE SET acked_at = NOW(), reaction = COALESCE($3, agent_event_acks.reaction)
     RETURNING event_id, agent_id, acked_at, reaction`,
    [eventId, agentId, reaction ?? null]
  );

  const row = result.rows[0];
  const ack: EventAck = {
    eventId: row.event_id,
    agentId: row.agent_id,
    ackedAt: row.acked_at,
    reaction: row.reaction,
  };

  console.error(`[Synapse Events] Agent "${agentId}" hat Event #${eventId} quittiert`);
  return ack;
}

/**
 * Holt ausstehende Events fuer einen Agenten
 * Gibt Events zurueck die noch nicht vom Agenten quittiert wurden
 * und deren scope 'all' oder 'agent:<agentId>' ist
 * Sortiert nach Prioritaet (critical → high → normal) und Erstellungszeit
 */
export async function getPendingEvents(
  project: string,
  agentId: string,
  limit?: number,
): Promise<AgentEvent[]> {
  const pool = getPool();
  const boundedLimit = limit === undefined
    ? null
    : Math.max(1, Math.min(100, Math.trunc(limit)));

  // Nur Events liefern die NACH der Registrierung des Agenten erstellt wurden.
  // Alte scope:'all' Events wurden bereits von damals aktiven Agenten bearbeitet —
  // ein neuer Agent muss sie nicht nochmal acken.
  // Direkt adressierte Events (scope: 'agent:<id>') werden immer geliefert.
  const result = await pool.query(
    `SELECT e.id, e.project, e.event_type, e.priority, e.scope, e.source_id, e.payload, e.requires_ack, e.created_at
     FROM agent_events e
     WHERE e.project = $1
       AND (e.scope = 'all' OR e.scope = $2)
       AND NOT EXISTS (
         SELECT 1 FROM agent_event_acks
         WHERE agent_event_acks.event_id = e.id
           AND agent_event_acks.agent_id = $3
       )
       AND (
         e.scope = $2
         OR e.created_at > COALESCE(
           (SELECT registered_at FROM agent_sessions WHERE id = $3),
           NOW() - INTERVAL '1 hour'
         )
       )
       AND (
         e.event_type <> 'PLAN_READY'
         OR EXISTS (
           SELECT 1 FROM file_batch_waits w
           WHERE w.project = e.project
             AND e.dedupe_key = 'plan-ready:' || w.wait_token::text
             AND w.status IN ('waiting', 'linked')
             AND w.expires_at > NOW()
         )
       )
     ORDER BY
       CASE e.priority
         WHEN 'critical' THEN 0
         WHEN 'high' THEN 1
         ELSE 2
       END ASC,
       e.created_at ASC
     LIMIT $4`,
    [project, `agent:${agentId}`, agentId, boundedLimit]
  );

  return result.rows.map(row => ({
    id: row.id,
    project: row.project,
    eventType: row.event_type,
    priority: row.priority,
    scope: row.scope,
    sourceId: row.source_id,
    payload: row.payload,
    requiresAck: row.requires_ack,
    createdAt: row.created_at,
  }));
}

function truncateEventSummary(value: string, maxLength = 80): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(normalized);
  if (chars.length <= maxLength) return normalized;
  return `${chars.slice(0, maxLength - 1).join('')}…`;
}

function summarizePendingEvent(event: AgentEvent): string {
  if (event.eventType === 'PLAN_READY' && event.payload) {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      const planId = typeof payload.plan_id === 'string' || typeof payload.plan_id === 'number'
        ? String(payload.plan_id)
        : null;
      const sharedFiles = Array.isArray(payload.shared_files)
        ? payload.shared_files.filter((value): value is string => typeof value === 'string')
        : [];
      const fileHint = sharedFiles.length === 1
        ? sharedFiles[0]
        : sharedFiles.length > 1
          ? `${sharedFiles.length} gemeinsame Dateien`
          : 'gemeinsame Dateien';
      if (planId) {
        return truncateEventSummary(`Gemeinsamer Plan ${planId} fuer ${fileHint} ist bereit`);
      }
    } catch {
      // Kaputtes Payload darf den Antwort-Hook nicht brechen.
    }
  }

  const ackHint = event.requiresAck ? ' — Ack erforderlich' : '';
  return truncateEventSummary(
    `${event.eventType} von ${event.sourceId} wartet${ackHint}`
  );
}

/**
 * CE-7 — Kompakter, hart begrenzter Inbox-Hinweis fuer normale Tool-Antworten.
 * Der Vollinhalt bleibt ausschliesslich event(pending) vorbehalten.
 */
export async function getPendingEventHints(
  project: string,
  agentId: string,
  limit = 3,
): Promise<{
  hints: Array<{ event_id: number; event_type: string; summary: string }>;
  urgent: Array<{ event_type: string; priority: EventPriority }>;
}> {
  const boundedLimit = Math.max(1, Math.min(3, Math.trunc(limit)));
  const events = await getPendingEvents(project, agentId, boundedLimit);
  return {
    hints: events.map(event => ({
      event_id: event.id,
      event_type: event.eventType,
      summary: summarizePendingEvent(event),
    })),
    urgent: events
      .filter(event => event.priority === 'critical' || event.priority === 'high')
      .map(event => ({ event_type: event.eventType, priority: event.priority })),
  };
}

/**
 * Schneller COUNT unquittierter Events fuer Hook-Usage
 */
export async function getUnackedCount(
  project: string,
  agentId: string
): Promise<number> {
  const pool = getPool();

  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM agent_events e
     WHERE e.project = $1
       AND (e.scope = 'all' OR e.scope = $2)
       AND NOT EXISTS (
         SELECT 1 FROM agent_event_acks
         WHERE agent_event_acks.event_id = e.id
           AND agent_event_acks.agent_id = $3
       )
       AND (
         e.event_type <> 'PLAN_READY'
         OR EXISTS (
           SELECT 1 FROM file_batch_waits w
           WHERE w.project = e.project
             AND e.dedupe_key = 'plan-ready:' || w.wait_token::text
             AND w.status IN ('waiting', 'linked')
             AND w.expires_at > NOW()
         )
       )`,
    [project, `agent:${agentId}`, agentId]
  );

  return result.rows[0]?.count ?? 0;
}
