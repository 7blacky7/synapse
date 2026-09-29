/**
 * shell(exec): Warten bei neuer Channel-Nachricht unterbrechen (Task b5b5304a).
 *
 * Agenten nutzen shell fuer lange Builds/Tests und sahen Koordinator-Anweisungen erst,
 * wenn der Job fertig war: die Channel-Hinweise (unread_channels) haengen an der ANTWORT,
 * und ein blockierendes exec verzoegerte sie um bis zu 20 s (Abloesegrenze).
 *
 * User-Entscheidung 29.09.2026: nur Hinweis, schlank, KEIN Steuerparameter. Kommt waehrend
 * des Wartens eine fremde Nachricht in einem Channel, in dem der Agent Mitglied ist, kehrt
 * exec sofort zurueck (status 'running'). Der Job wird NICHT abgebrochen.
 *
 * Quelle ist der vorhandene Trigger notify_channel_message (pg_notify('synapse_channel',
 * {project, channel, sender, id})). Die Mitgliedschaft entscheidet PG, nicht die Payload.
 */

import { getPool } from '../db/index.js';

/** PG-Kanal des Triggers notify_channel_message (schema-sql/05_funktionen.sql) */
export const CHANNEL_NOTIFY_KANAL = 'synapse_channel';

/** Handlungshinweis in der exec-Antwort (REST-Weg: Job-ID ist bekannt) */
export const SHELL_UNTERBRECHUNG_HINWEIS = 'Job laeuft weiter: shell(get|log, id) oder shell(cancel, id)';

export interface ChannelUnterbrechung {
  project: string;
  channel: string;
  sender: string;
  message_id: number;
}

/** Payload des Triggers lesen; alles Unvollstaendige ergibt null. */
export function leseChannelNotify(payload?: string): ChannelUnterbrechung | null {
  if (!payload) return null;
  try {
    const d = JSON.parse(payload) as Record<string, unknown>;
    const id = Number(d.id);
    if (typeof d.project !== 'string' || typeof d.channel !== 'string' || typeof d.sender !== 'string'
      || !d.channel || !Number.isFinite(id)) {
      return null;
    }
    return { project: d.project, channel: d.channel, sender: d.sender, message_id: id };
  } catch {
    return null;
  }
}

export async function istChannelMitglied(project: string, channel: string, agentId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    `SELECT 1 AS ok FROM specialist_channel_members mem
     JOIN specialist_channels c ON c.id = mem.channel_id
     WHERE c.project = $1 AND c.name = $2 AND mem.agent_name = $3 LIMIT 1`,
    [project, channel, agentId],
  );
  return rows.length > 0;
}

/**
 * Unterbricht diese Notification das Warten von agentId? Nur eine fremde Nachricht in einem
 * Channel, in dem der Agent Mitglied ist. Ein DB-Fehler unterbricht nicht (lieber einmal
 * zu lange warten als ein exec an einer Hilfsabfrage scheitern lassen).
 */
export async function pruefeUnterbrechung(payload: string | undefined, agentId: string): Promise<ChannelUnterbrechung | null> {
  const u = leseChannelNotify(payload);
  if (!u || u.sender === agentId) return null;
  try {
    return (await istChannelMitglied(u.project, u.channel, agentId)) ? u : null;
  } catch {
    return null;
  }
}

export function unterbrechungsMeldung(u: ChannelUnterbrechung, hinweis: string = SHELL_UNTERBRECHUNG_HINWEIS): string {
  return `Neue Nachricht von ${u.sender} in Channel "${u.channel}" (${u.project}, id ${u.message_id}) — ` +
    `Warten beendet, damit du sie jetzt liest. ${hinweis}`;
}

/**
 * MCP-stdio-Weg: wartet mit eigenem LISTEN-Client auf die erste Nachricht, die agentId
 * unterbricht. Endet mit null, sobald `signal` abbricht (exec ist anders fertig geworden).
 * Ohne agentId sofort null, ohne Verbindung.
 */
export async function warteAufChannelNachricht(agentId: string, signal: AbortSignal): Promise<ChannelUnterbrechung | null> {
  if (!agentId || signal.aborted) return null;
  const client = await getPool().connect();
  let handler: ((msg: { channel: string; payload?: string }) => void) | null = null;
  try {
    await client.query(`LISTEN ${CHANNEL_NOTIFY_KANAL}`);
    return await new Promise<ChannelUnterbrechung | null>((resolve) => {
      let fertig = false;
      const ende = (u: ChannelUnterbrechung | null) => {
        if (fertig) return;
        fertig = true;
        signal.removeEventListener('abort', beiAbbruch);
        resolve(u);
      };
      const beiAbbruch = () => ende(null);
      signal.addEventListener('abort', beiAbbruch);
      if (signal.aborted) {
        ende(null);
        return;
      }
      handler = (msg) => {
        if (fertig || msg.channel !== CHANNEL_NOTIFY_KANAL) return;
        void pruefeUnterbrechung(msg.payload, agentId).then((u) => {
          if (u) ende(u);
        });
      };
      client.on('notification', handler);
    });
  } finally {
    if (handler) client.removeListener('notification', handler);
    try {
      await client.query(`UNLISTEN ${CHANNEL_NOTIFY_KANAL}`);
    } catch {
      /* best effort */
    }
    client.release();
  }
}
