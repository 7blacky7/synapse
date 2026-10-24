/**
 * P22-T120 (Live t179, rea4 2a40f930): Antwort eines geweckten Agenten an den Wecker (z. B. Main) identitaetsadressiert zustellen.
 * URSACHE: postToInbox -> aufgeloestesSendeZiel(project, 'hauptagent') sucht die Identitaet NUR im Projekt des Antwortenden
 *   (agent_identitaeten.project = 'synapse'); die Main-Identitaet liegt in 'synapse-hauptagent' -> Legacy-Ziel, to_identity_id NULL.
 *   Der Main liest per Identitaet (hauptagent-zustellung: specialist_inbox.to_identity_id = Main) bzw. inbox_check im eigenen
 *   Projekt (inbox.ts: project = 'synapse-hauptagent') -> die Zeile (project=synapse, to_identity NULL) erreicht ihn nie.
 *   Zusaetzlich traegt die wake-Zeile selbst keine from_identity_id (Absender-Name aus wake_echter_absender, Principal aus
 *   anderem Projekt -> kommunikationsAgent liefert Legacy).
 * FIX (Schalter wake_antwort_identitaet, Produkt, Std AUS, nur ausdruecklich; in Projekt des Geweckten UND des Weckers schalten):
 *   1 wake (routes/mcp.ts, routes/specialists.ts): merkeWakeRueckadresse setzt from_identity_id der wake-Inbox-Zeile auf den
 *     Ausweis-Principal (Rueckadresse), nur wenn der Absender genau dieser Principal ist.
 *   2 Antwort (inbox.ts postToInbox): bleibt das Ziel ein Legacy-Name, sucht rueckadresseFuer die juengste wake-Zeile im Projekt,
 *     die von genau diesem Namen (mit Identitaet) an den Antwortenden ging -> to_identity_id = diese Identitaet.
 *   3 Lesen (inbox.ts checkInbox/getNewInboxMessages/getInboxHistory): identitaetsadressierte Nachrichten projektuebergreifend.
 * Debug: console.debug '[wake-antwort-identitaet] ...'; wake-Antwort traegt debug.rueckadresse.
 */
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';

export const WAKE_ANTWORT_IDENTITAET_FUNKTION = 'wake_antwort_identitaet' as const;

type Query = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
const pg: Query = (sql, p) => getPool().query(sql, p) as never;

/** Schalter je Projekt. Wirft nie (Lesefehler -> AUS). */
export async function wakeAntwortIdentitaetAktiv(project: string): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(WAKE_ANTWORT_IDENTITAET_FUNKTION, project)).aktiv; } catch { return false; }
}

/** Rein, testbar: Rueckadresse nur, wenn der wake-Absender genau der Ausweis-Principal (mit Identitaet) ist. */
export function rueckadresseAusPrincipal(absender: string, principal: { art?: string; identity_id?: string | null; agent_id?: string | null } | null): string | null {
  if (!principal || principal.art !== 'identity' || !principal.identity_id) return null;
  return principal.agent_id && principal.agent_id === absender ? principal.identity_id : null;
}

/**
 * R1 (rea4 9d101b8f), rein: projektfreies Lesen nur fuer die EIGENE Identitaet des Lesenden (serverseitiger Principal, nie aus
 * Parametern). Fremdes explizites identity:<id>-Ziel -> false (Bestand mit Projektfilter).
 */
export function projektfreiesLesenErlaubt(zielIdentityId: string | null | undefined, principal: { art?: string; identity_id?: string | null } | null): boolean {
  return !!zielIdentityId && !!principal && principal.art === 'identity' && principal.identity_id === zielIdentityId;
}

/**
 * R2 (rea4 9d101b8f): Rueckadresse VOR dem Wake bestimmen, damit sie atomar im INSERT der wake-Zeile steht (postToInbox opts
 * fromIdentityId) und erst danach notifiziert wird. Wirft nie; identity_id null = Bestand.
 */
export async function wakeRueckadresseVorab(project: string, absender: string, an?: boolean,
  principal = aktuellerAgentPrincipal() as { art?: string; identity_id?: string; agent_id?: string } | null): Promise<{ identity_id: string | null; grund: string }> {
  try {
    if (!(an ?? await wakeAntwortIdentitaetAktiv(project))) return { identity_id: null, grund: 'schalter_aus' };
    const id = rueckadresseAusPrincipal(absender, principal);
    return id ? { identity_id: id, grund: 'vorab' } : { identity_id: null, grund: 'kein_identitaets_principal' };
  } catch { return { identity_id: null, grund: 'fehler' }; }
}

/**
 * R2-Rest (rea4 66293a98): Reihenfolge des Wake. Mit Rueckadresse: erst INSERT; NUR bei erfolgreichem INSERT Notify, sonst kein
 * Notify und ok=false (rueckadresse_fehler). Ohne Rueckadresse: Bestand (Notify, dann INSERT; ok = eins von beiden).
 * inbox liefert die Inbox-ID oder undefined (Fehler schon gemeldet), notify true/false. Rein bis auf die uebergebenen Schritte.
 */
export async function wakeReihenfolge(mitRueckadresse: boolean, inbox: () => Promise<number | undefined>, notify: () => Promise<boolean>)
  : Promise<{ ok: boolean; notifyOk: boolean; inboxId: number | undefined; rueckadresse_fehler: string | null }> {
  if (mitRueckadresse) {
    const inboxId = await inbox();
    if (inboxId == null) {
      console.debug('[wake-antwort-identitaet] Wake-INSERT mit Rueckadresse fehlgeschlagen, kein Notify');
      return { ok: false, notifyOk: false, inboxId: undefined, rueckadresse_fehler: 'inbox_insert_fehlgeschlagen_kein_notify' };
    }
    const notifyOk = await notify();
    return { ok: true, notifyOk, inboxId, rueckadresse_fehler: null };
  }
  const notifyOk = await notify();
  const inboxId = await inbox();
  return { ok: notifyOk || inboxId != null, notifyOk, inboxId, rueckadresse_fehler: null };
}

/** (Altweg, nicht mehr in den Routen genutzt) wake-Inbox-Zeile nachtraeglich mit der Identitaet des Weckers versehen. Wirft nie. */
export async function merkeWakeRueckadresse(inboxId: number | undefined, project: string, absender: string,
  query: Query = pg, an?: boolean, principal = aktuellerAgentPrincipal() as { art?: string; identity_id?: string; agent_id?: string } | null)
  : Promise<{ gesetzt: boolean; grund: string; identity_id?: string }> {
  try {
    if (inboxId == null) return { gesetzt: false, grund: 'keine_inbox_zeile' };
    if (!(an ?? await wakeAntwortIdentitaetAktiv(project))) return { gesetzt: false, grund: 'schalter_aus' };
    const id = rueckadresseAusPrincipal(absender, principal);
    if (!id) return { gesetzt: false, grund: 'kein_identitaets_principal' };
    const r = await query('UPDATE specialist_inbox SET from_identity_id = $2 WHERE id = $1 AND project = $3 AND from_agent = $4 AND from_identity_id IS NULL',
      [inboxId, id, project, absender]);
    const gesetzt = (r.rowCount ?? 0) > 0;
    console.debug('[wake-antwort-identitaet] Rueckadresse', { inboxId, project, absender, identity_id: id, gesetzt });
    return { gesetzt, grund: gesetzt ? 'gesetzt' : 'zeile_unpassend', identity_id: id };
  } catch (err) {
    console.error('[wake-antwort-identitaet] Rueckadresse nicht gesetzt:', (err as Error)?.message ?? err);
    return { gesetzt: false, grund: 'fehler' };
  }
}

/**
 * Schritt 2: Identitaet des Weckers fuer eine Antwort von antwortender an zielName im Projekt. Juengste wake-Zeile von zielName
 * (mit from_identity_id, aktive Identitaet desselben agent_id) an antwortender. Wirft nie; null = Bestand.
 */
export async function rueckadresseFuer(project: string, zielName: string, antwortender: string, query: Query = pg)
  : Promise<{ identity_id: string; agent_id: string; wake_inbox_id: number } | null> {
  try {
    const r = await query(`SELECT i.id, a.id AS identity_id, a.agent_id FROM specialist_inbox i
        JOIN agent_identitaeten a ON a.id = i.from_identity_id AND a.status = 'aktiv' AND a.agent_id = $2
       WHERE i.project = $1 AND i.from_agent = $2 AND i.to_agent = $3 AND i.from_identity_id IS NOT NULL
       ORDER BY i.id DESC LIMIT 1`, [project, zielName.trim(), antwortender]);
    const z = r.rows[0];
    return z ? { identity_id: String(z.identity_id), agent_id: String(z.agent_id), wake_inbox_id: Number(z.id) } : null;
  } catch { return null; }
}
