/**
 * MODUL: event-sichtbarkeit.ts (P15-T26, 11.10.2026)
 * ZWECK: EINZIGE Quelle der Frage "welche Events sind fuer einen Agenten offen".
 *   - scripts/event-check.mjs (PostToolUse-Hook) laedt dist/services/event-sichtbarkeit.js direkt
 *     und fragt HOOK_EVENTS_SQL ab.
 *   - intern(ereignisse) (intern-diagnose-welle2.ts) zeigt mit derselben HOOK_EVENTS_SQL die Hook-Sicht;
 *     scripts/test-intern-diagnose.mjs (E3) prueft gegen das echte Hook-Skript.
 *   - getPendingEvents (events.ts) soll dieselbe Bedingung nutzen (eventsOffenBedingungSql), damit Server
 *     und Hook nicht wieder auseinanderlaufen (P15-T21 hatte sie WORTGLEICH kopiert).
 * SITZUNGSBEGINN steht NUR in eventsSichtbarAbSql(): ab wann ein scope:'all'-Event fuer den Agenten zaehlt.
 * KEINE IMPORTS: der Hook laedt das Modul nach jedem Tool-Aufruf, es darf nichts nachziehen.
 */

/**
 * Ab wann scope:'all'-Events fuer den Agenten zaehlen (direkt adressierte zaehlen immer).
 * EINZIGE Stelle dieser Bedingung. Ohne Sitzung: die letzte Stunde.
 * P15-T30: ab dem Beginn der laufenden LEBENSPHASE (agent_sessions.aktiv_seit; Altzeilen ohne Wert:
 * registered_at). aktiv_seit bleibt bei Handoff/Rotation stehen (unquittierte Events der Vorsitzung
 * bleiben offen) und beginnt neu, wenn ein abgemeldeter oder stillgelegter Name wieder auftaucht.
 * Frueher registered_at = ERSTMALS registriert: ein wiederverwendeter Name bekam alle Alt-Events.
 * @param agentParam SQL-Platzhalter der Agent-ID, z. B. '$3'
 */
export function eventsSichtbarAbSql(agentParam: string): string {
  return `COALESCE(
           (SELECT COALESCE(aktiv_seit, registered_at) FROM agent_sessions WHERE id = ${agentParam}),
           NOW() - INTERVAL '1 hour'
         )`;
}

/**
 * Offene Events eines Agenten, fuer "FROM agent_events e" (ohne requires_ack - danach filtert nur der Hook).
 * - nicht vom Agenten quittiert
 * - scope 'all' erst ab eventsSichtbarAbSql, scope 'agent:<id>' immer
 * - PLAN_READY nur mit offenem Wait und hoechstens eines je Plan (nach ACK desselben Plans keines mehr)
 * @param p SQL-Platzhalter: projekt (Projekt), scope ('agent:<id>'), agent (Agent-ID)
 */
export function eventsOffenBedingungSql(p: { projekt: string; scope: string; agent: string }): string {
  return `e.project = ${p.projekt}
       AND (e.scope = 'all' OR e.scope = ${p.scope})
       AND NOT EXISTS (
         SELECT 1 FROM agent_event_acks
         WHERE agent_event_acks.event_id = e.id
           AND agent_event_acks.agent_id = ${p.agent}
       )
       AND (
         e.scope = ${p.scope}
         OR e.created_at > ${eventsSichtbarAbSql(p.agent)}
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
         -- Runde 3 (Befund 46ccab5b-6): hat der Agent schon ein PLAN_READY fuer DENSELBEN Plan quittiert
         -- (mehrere Waits -> mehrere Events), kommt kein weiteres fuer diesen Plan mehr.
         AND NOT EXISTS (
           SELECT 1 FROM agent_events e2
             JOIN agent_event_acks a2 ON a2.event_id = e2.id AND a2.agent_id = ${p.agent}
            WHERE e2.project = e.project AND e2.event_type = 'PLAN_READY' AND e2.scope = e.scope AND e2.id <> e.id
              AND (CASE WHEN e2.payload LIKE '{%' THEN e2.payload::jsonb ->> 'plan_id' END)
                = (CASE WHEN e.payload LIKE '{%' THEN e.payload::jsonb ->> 'plan_id' END)
         )
       )`;
}

/** So viele Events zeigt der Hook nach einem Tool-Aufruf hoechstens. */
export const HOOK_EVENTS_LIMIT = 5;

/**
 * Die Abfrage des PostToolUse-Hooks. Unterschied zur Server-Sicht: nur requires_ack = true (der Hook fordert
 * nur dort zum Quittieren auf). Parameter: hookEventsParameter().
 */
export const HOOK_EVENTS_SQL = `SELECT e.id, e.event_type, e.priority, e.source_id, e.payload, e.scope, e.created_at
     FROM agent_events e
     WHERE ${eventsOffenBedingungSql({ projekt: '$1', scope: '$2', agent: '$3' })}
       AND e.requires_ack = true
     ORDER BY CASE e.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, e.created_at ASC
     LIMIT $4`;

/** Parameter fuer HOOK_EVENTS_SQL: [$1 project, $2 'agent:<id>', $3 agent_id, $4 limit]. */
export function hookEventsParameter(project: string, agentId: string, limit: number = HOOK_EVENTS_LIMIT): [string, string, string, number] {
  return [project, `agent:${agentId}`, agentId, limit];
}
