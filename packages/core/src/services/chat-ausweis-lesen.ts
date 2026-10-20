/**
 * P22-T86 (Befund thought 08eb5dd6, t130-Abnahme): chat(action:"get") MIT Ausweis lieferte alte globale Nachrichten fremder
 * Agenten (Broadcasts, im strikten Modus sogar fremde DMs: chat.get.agent_id ist dort Fachfilter und blieb leer).
 * Mit Ausweis zaehlen jetzt nur Nachrichten AN den Leser: recipient_identity_id = eigene Identitaet oder (Legacy-DM ohne
 * Identitaet) recipient_id = eigener Name, unter dem Namen zeitbasiert ohne Archiv-Zeilen eines frueheren Traegers (P22-T80).
 * Keine Broadcasts, keine eigenen Sendungen. Ausgabe neueste zuerst; ohne Treffer leer mit Hinweis auf channel(feed).
 * message_id (Einzelabruf) bleibt beim Bestandsweg.
 *
 * SCHALTER 'chat_get_eigene' (Produkt-Schalter I im Katalog PROFIL_PRODUKT_FUNKTIONEN, nur ausdruecklich): STANDARD EIN
 *   (Fehlerkorrektur, reine Einschraenkung der Sicht). Wirksam = intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) >
 *   Produkt-Schalter (ebene global) > Standard EIN. AUS = Bestand (Handler wie vor P22-T86).
 * DEBUG: leseChatGetEigeneSchalter() (Quelle, letzter_fehler); die Antwort traegt filter {identity_id, agent_id, schalter}.
 */
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { archivSichtFuer, archivNamensBedingung } from './agent-entfernung.js';

export const CHAT_GET_EIGENE_FUNKTION = 'chat_get_eigene' as const;
export const CHAT_GET_EIGENE_LEER_HINWEIS = 'Keine Direktnachrichten an dich. Rueckmeldungen und Auftraege kommen ueber channel(action:"feed", channel_name).';

type Q = QueryConfig & { query_timeout: number };

export interface ChatGetEigeneSchalter { aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; bis: string | null; letzter_fehler: string | null }

/** Frisch je Aufruf. Standard EIN; Lesefehler -> Standard mit letzter_fehler. Wirft nie. */
export async function leseChatGetEigeneSchalter(): Promise<ChatGetEigeneSchalter> {
  const basis: ChatGetEigeneSchalter = { aktiv: true, quelle: 'standard', bis: null, letzter_fehler: null };
  let letzter: string | null = null;
  try {
    // Dynamisch wie hauptagent-sonderstellung.ts (Importzyklus ueber intern-tool).
    const { internToolAktiv } = await import('./intern-tool.js');
    if (internToolAktiv()) {
      try {
        const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
          text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
          values: [CHAT_GET_EIGENE_FUNKTION], query_timeout: 2000,
        } as Q);
        const z = r.rows[0];
        if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
      } catch { letzter = 'schalter_nicht_erreichbar'; }
    }
    const p = await leseProfilProduktSchalter(CHAT_GET_EIGENE_FUNKTION, null);
    if (p.quelle === 'produkt-schalter') return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', letzter_fehler: letzter };
    return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler };
  } catch {
    return { ...basis, letzter_fehler: 'schalter_nicht_lesbar' };
  }
}

export interface EigeneChatNachricht {
  id: number; project: string; senderId: string; recipientId: string | null; content: string; timestamp: Date;
  senderIdentityId: string | null; recipientIdentityId: string | null;
}

/**
 * Nachrichten AN den Leser (Identitaet oder Name), neueste zuerst. Markiert den Lesestand der Identitaet (nur gelieferte
 * fremde Nachrichten, nie zurueck). sender = optionaler Absenderfilter (Name oder Identitaets-ID).
 */
export async function leseEigeneChatNachrichten(project: string, leser: { identity_id: string; agent_id: string },
  o: { since?: string; sender?: string; limit?: number } = {}): Promise<EigeneChatNachricht[]> {
  const params: unknown[] = [project];
  const bind = (v: unknown) => { params.push(v); return '$' + params.length; };
  const id = bind(leser.identity_id), name = bind(leser.agent_id);
  const sicht = await archivSichtFuer(project, leser.agent_id);
  const bedingungen = [
    'project = $1',
    `(recipient_identity_id = ${id} OR (recipient_identity_id IS NULL AND ${archivNamensBedingung('recipient_id', 'timestamp', name, sicht, bind)}))`,
  ];
  if (o.since) bedingungen.push('timestamp > ' + bind(o.since));
  if (o.sender) { const s = bind(o.sender); bedingungen.push(`(sender_identity_id = ${s} OR sender_id = ${s})`); }
  const limit = Number.isFinite(o.limit) && (o.limit as number) > 0 ? Math.min(Math.floor(o.limit as number), 500) : 50;
  const sql = `WITH geliefert AS MATERIALIZED (
      SELECT * FROM chat_messages WHERE ${bedingungen.join(' AND ')} ORDER BY timestamp DESC, id DESC LIMIT ${bind(limit)}),
    markiert AS (
      INSERT INTO agent_identitaet_chat_lesestand(project, agent_id, identity_id, letzte_id)
      SELECT $1, ${name}, ${id}, MAX(id) FROM geliefert WHERE sender_identity_id IS DISTINCT FROM ${id}
      HAVING MAX(id) IS NOT NULL
      ON CONFLICT(project, identity_id) DO UPDATE SET letzte_id = GREATEST(agent_identitaet_chat_lesestand.letzte_id, EXCLUDED.letzte_id), updated_at = NOW()
      RETURNING letzte_id)
    SELECT * FROM geliefert ORDER BY timestamp DESC, id DESC`;
  const { rows } = await getPool().query(sql, params);
  return rows.map((r: Record<string, any>) => ({ id: r.id, project: r.project, senderId: r.sender_id, recipientId: r.recipient_id,
    content: r.content, timestamp: r.timestamp, senderIdentityId: r.sender_identity_id ?? null, recipientIdentityId: r.recipient_identity_id ?? null }));
}

/** Fertige Tool-Antwort fuer chat(get) mit Ausweis. */
export async function chatGetEigeneAntwort(project: string, leser: { identity_id: string; agent_id: string },
  args: Record<string, unknown>, schalter: ChatGetEigeneSchalter): Promise<Record<string, unknown>> {
  const str = (k: string) => (typeof args[k] === 'string' && args[k] ? args[k] as string : undefined);
  const limit = typeof args.limit === 'number' ? args.limit : Number(args.limit ?? NaN);
  const messages = await leseEigeneChatNachrichten(project, leser, { since: str('since'), sender: str('sender_id_filter'), limit: Number.isFinite(limit) ? limit : undefined });
  return { success: true, action: 'get', messages, count: messages.length, reihenfolge: 'neueste_zuerst',
    ...(messages.length === 0 ? { hinweis: CHAT_GET_EIGENE_LEER_HINWEIS } : {}),
    filter: { identity_id: leser.identity_id, agent_id: leser.agent_id, project, schalter: { quelle: schalter.quelle, letzter_fehler: schalter.letzter_fehler } } };
}
