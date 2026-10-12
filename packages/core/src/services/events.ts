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
 *   - number: Anzahl unquittierter Events (fuer Ereignisabfragen)
 *
 * NEBENEFFEKTE:
 *   - PostgreSQL: Schreibt in agent_events / agent_event_acks Tabellen
 *   - Kein Qdrant (Events sind chronologisch, nicht semantisch)
 */

import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { eventsOffenBedingungSql } from './event-sichtbarkeit.js';
import { darfKoordinatorOderUser } from './rollen-pruefung.js';
import { sendMessage } from './chat.js';

export type EventType =
  | 'WORK_STOP'
  | 'CRITICAL_REVIEW'
  | 'ARCH_DECISION'
  | 'TEAM_DISCUSSION'
  | 'ANNOUNCEMENT'
  | 'PLAN_READY'
  // P6-T31: wartender Agent bittet den Reservierenden um Plan oder Freigabe.
  | 'PLAN_WAITING'
  // V1 (29.09.2026): Nachfolge-Events eines gemeinsamen Plans, persistent bis ack.
  | 'PLAN_COMMITTED'
  | 'PLAN_CANCELLED'
  | 'PLAN_CHANGED'
  | 'PLAN_FOLLOWUP';

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
 * Eigener Scope/all: normale Quittierung. Fremder Scope: nur Koordinator/User
 * oder ohne aktive Zielsession, immer mit Pflichtgrund in reaction.
 * Stellvertretung schreibt den ACK fuer den Empfaenger, damit sein Event geschlossen
 * ist; reaction vermerkt Akteur und Grund. Pruefung und Schreiben in einer SQL-Anweisung.
 */
export async function acknowledgeEvent(
  eventId: number,
  agentId: string,
  reaction?: string
): Promise<EventAck> {
  const pool = getPool();

  const result = await pool.query(
    `WITH ziel AS (
       SELECT e.*, CASE WHEN e.scope LIKE 'agent:%' THEN substring(e.scope FROM 7) END AS empfaenger
       FROM agent_events e WHERE e.id = $1
     )
     INSERT INTO agent_event_acks (event_id, agent_id, acked_at, reaction)
     SELECT e.id, COALESCE(e.empfaenger, $2), NOW(),
       CASE WHEN e.scope = 'all' OR e.empfaenger = $2 THEN $3 ELSE $5 END
     FROM ziel e
     WHERE e.scope = 'all' OR e.empfaenger = $2
       OR (e.empfaenger <> '' AND $5::text IS NOT NULL AND (
         $4::boolean OR NOT EXISTS (
           SELECT 1 FROM agent_sessions s
           WHERE s.id = e.empfaenger AND s.project = e.project AND s.status = 'active'
         )
       ))
     ON CONFLICT (event_id, agent_id) DO UPDATE
       SET acked_at = NOW(), reaction = COALESCE(EXCLUDED.reaction, agent_event_acks.reaction)
     RETURNING event_id, agent_id, acked_at, reaction`,
    [eventId, agentId, reaction ?? null, darfKoordinatorOderUser(agentId),
      reaction?.trim() ? `stellvertretend durch ${agentId}; Grund: ${reaction.trim()}` : null]
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error(`Event #${eventId} nicht gefunden oder Agent "${agentId}" darf es nicht quittieren. Stellvertretend nur als Koordinator/User oder ohne aktive Zielsession; Grund in reaction ist Pflicht.`);
  }
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

  // Bedingung aus der GEMEINSAMEN Quelle event-sichtbarkeit.ts (P15-T26/P15-T30), dieselbe wie im
  // gemeinsame Quelle - keine Kopie mehr. scope:'all' zaehlt erst ab dem Beginn
  // der laufenden Lebensphase (aktiv_seit, Altzeilen registered_at), siehe eventsSichtbarAbSql.
  // Alte scope:'all' Events wurden bereits von damals aktiven Agenten bearbeitet —
  // ein neuer Agent muss sie nicht nochmal acken.
  // Direkt adressierte Events (scope: 'agent:<id>') werden immer geliefert.
  const result = await pool.query(
    `SELECT e.id, e.project, e.event_type, e.priority, e.scope, e.source_id, e.payload, e.requires_ack, e.created_at
     FROM agent_events e
     WHERE ${eventsOffenBedingungSql({ projekt: '$1', scope: '$2', agent: '$3' })}
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
  if (event.eventType === 'PLAN_WAITING' && event.payload) {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      const waitingAgent = String(payload.waiting_agent ?? event.sourceId);
      const sharedFiles = Array.isArray(payload.shared_files)
        ? payload.shared_files.filter((value): value is string => typeof value === 'string')
        : [];
      const fileHint = sharedFiles.length === 1
        ? sharedFiles[0]
        : sharedFiles.length > 1
          ? `${sharedFiles.length} Dateien`
          : 'Dateien';
      return truncateEventSummary(`Agent ${waitingAgent} wartet auf deinen Plan oder Freigabe fuer ${fileHint}`);
    } catch {
      // Kaputtes Payload darf den Antwort-Hook nicht brechen.
    }
  }
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

  // V1: Nachfolge-Events eines gemeinsamen Plans kurz und handlungsleitend.
  if (event.eventType !== 'PLAN_READY' && event.eventType.startsWith('PLAN_') && event.payload) {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      const planId = String(payload.plan_id ?? '?');
      const fehlt = Array.isArray(payload.offene_dateien) && payload.offene_dateien.length > 0;
      const text = event.eventType === 'PLAN_COMMITTED'
        ? `Plan ${planId} committed${fehlt ? ' — dein Beitrag fehlt: coedit_add' : ''}`
        : event.eventType === 'PLAN_CANCELLED'
          ? `Plan ${planId} verworfen — nichts geschrieben, ggf. neu planen`
          : event.eventType === 'PLAN_CHANGED'
            ? `Plan ${planId} geaendert: ${String(payload.withdrawn_by ?? '?')} hat zurueckgezogen`
            : `Plan ${planId} committed, Folgeplan ${String(payload.folgeplan_id ?? '?')} — dort beitragen`;
      return truncateEventSummary(text);
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
  urgent: DringlicherEventHinweis[];
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
      .map(event => ({ event_id: event.id, event_type: event.eventType, priority: event.priority })),
  };
}

type DringlicherEventHinweis = { event_id: number; event_type: string; priority: EventPriority };
type EventEskalationsStand = { anzahl: number; gemeldet: boolean };
// Wie bisher pro Prozess. Projekt und Event-ID verhindern fremde ACK-Resets und Zählervermischung.
const eventEskalationen = new Map<string, Map<number, EventEskalationsStand>>();

/** Nach drei sichtbaren Warnungen einmal melden; normale Inbox-Felder bleiben unverändert. */
export async function pruefeEventEskalation(
  project: string,
  agentId: string,
  urgent: DringlicherEventHinweis[],
): Promise<string | undefined> {
  const key = JSON.stringify([project, agentId]);
  if (urgent.length === 0) {
    eventEskalationen.delete(key);
    return undefined;
  }
  let staende = eventEskalationen.get(key);
  if (!staende) {
    staende = new Map();
    eventEskalationen.set(key, staende);
  }
  const faellig: Array<{ event: DringlicherEventHinweis; stand: EventEskalationsStand }> = [];
  for (const event of urgent) {
    let stand = staende.get(event.event_id);
    if (!stand) {
      stand = { anzahl: 0, gemeldet: false };
      staende.set(event.event_id, stand);
    }
    stand.anzahl = Math.min(3, stand.anzahl + 1);
    if (stand.anzahl === 3 && !stand.gemeldet) {
      // Vor dem await beanspruchen: parallele Antworten dürfen nicht mehrfach senden.
      stand.gemeldet = true;
      faellig.push({ event, stand });
    }
  }
  if (faellig.length > 0) {
    try {
      const liste = faellig.map(({ event }) =>
        `#${event.event_id} ${event.event_type}(${event.priority})`).join(', ');
      await sendMessage(project, 'system',
        `⚠️ ESKALATION: Agent "${agentId}" ignoriert Events seit 3 Tool-Calls: ${liste}`,
        'koordinator');
    } catch (error) {
      for (const { stand } of faellig) stand.gemeldet = false;
      console.error('[Synapse Events] Eskalations-DM fehlgeschlagen:', error);
    }
  }
  // Bereits gemeldete IDs behalten, auch wenn neue critical-Events sie kurz aus den Top 3 verdrängen.
  return '⚠️ Dringende Events (' + urgent.map(event => event.priority).join(', ')
    + '): event(pending) lesen und erforderliche ACKs ausführen.';
}


/**
 * Schneller COUNT unquittierter Events
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
             AND (w.expires_at > NOW() OR EXISTS (SELECT 1 FROM file_batch_plans p WHERE p.id = w.primary_plan_id AND p.status = 'open'))
         )
       )`,
    [project, `agent:${agentId}`, agentId]
  );

  return result.rows[0]?.count ?? 0;
}
