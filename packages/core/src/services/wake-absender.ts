/**
 * P22-T119 (3), Befund 5a7f6a07 (4): Der REST-MCP-/REST-wake-Altweg (Nicht-Identitaets-Name) trug fest from:'rest-api' und
 * legte die Inbox-Zeile mit Absender 'rest-api' an -> der geweckte Agent antwortete an 'rest-api' statt an den Aufrufer (z. B. Main).
 * Schalter wake_echter_absender (Produkt, Std AUS, nur ausdruecklich): Absender = Ausweis-Principal (agent_id) > vom Transport
 * abgeleiteter Aufrufer (effectiveAgentId) > 'rest-api' (nur ohne Aufrufer). AUS: unveraendert 'rest-api'.
 * Debug: Quelle + Principal-Projekt (antwortet der Agent in project, liegt die Antwort dort in der Inbox des Absenders).
 */
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';

export const WAKE_ECHTER_ABSENDER_FUNKTION = 'wake_echter_absender' as const;
export const WAKE_ALT_ABSENDER = 'rest-api' as const;

export interface WakeAbsender { absender: string; quelle: 'principal' | 'aufrufer' | 'rest_api_rueckfall' | 'schalter_aus'; principal_project: string | null }

/** Rein, testbar. */
export function waehleWakeAbsender(schalterAn: boolean, principal: { agent_id?: string | null; project?: string | null } | null, aufrufer?: string | null): WakeAbsender {
  if (!schalterAn) return { absender: WAKE_ALT_ABSENDER, quelle: 'schalter_aus', principal_project: null };
  const pid = typeof principal?.agent_id === 'string' && principal.agent_id.trim() ? principal.agent_id.trim() : null;
  if (pid) return { absender: pid, quelle: 'principal', principal_project: principal?.project ?? null };
  const a = typeof aufrufer === 'string' && aufrufer.trim() ? aufrufer.trim() : null;
  if (a) return { absender: a, quelle: 'aufrufer', principal_project: null };
  return { absender: WAKE_ALT_ABSENDER, quelle: 'rest_api_rueckfall', principal_project: null };
}

/** Absender fuer den wake-Altweg im laufenden Aufruf. Wirft nie (Lesefehler -> Schalter AUS). */
export async function wakeAbsenderFuer(project: string, aufrufer?: string | null): Promise<WakeAbsender> {
  let an = false;
  try { an = (await leseProfilProduktSchalter(WAKE_ECHTER_ABSENDER_FUNKTION, project)).aktiv; } catch { an = false; }
  const p = aktuellerAgentPrincipal() as { agent_id?: string; project?: string } | null;
  return waehleWakeAbsender(an, p, aufrufer ?? null);
}
