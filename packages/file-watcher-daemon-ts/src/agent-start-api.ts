/**
 * P22-T12: Der Daemon bezieht Start-Ausweise über seinen vorhandenen API-Ausweis.
 * Kein PG, keine lokale Token-Datei, kein Ausweis in Queue/Argumenten/Logs.
 */
import { spezialistenDatenApi } from './daemon-jobs-api.js';

interface Freigabe { freigegeben: boolean; quelle: 'standard' | 'intern'; bis: string | null }
let stand: { wert: Freigabe; empfangen: number; serverZeit: number } | null = null;

/** Brückenverlust, alte API oder ungültige Antwort verwerfen den Override. */
export function verwerfeAgentStartFreigabe(): void { stand = null; }
export function uebernehmeAgentStartFreigabe(antwort: unknown): void {
  stand = null;
  if (!antwort || typeof antwort !== 'object') return;
  const a = antwort as Record<string, unknown>;
  const s = a.token_identitaet as Partial<Freigabe> | undefined;
  if (!s || typeof s.freigegeben !== 'boolean' || (s.quelle !== 'intern' && s.quelle !== 'standard')) return;
  const serverZeit = typeof a.server_zeit === 'string' ? Date.parse(a.server_zeit) : NaN;
  if (!Number.isFinite(serverZeit)) return;
  stand = { wert: { freigegeben: s.freigegeben, quelle: s.quelle, bis: typeof s.bis === 'string' ? s.bis : null }, empfangen: Date.now(), serverZeit };
}
/** Frische wird monoton relativ zum API-Zeitpunkt geprüft, ohne lokale PG-Abfrage. */
export function agentStartFreigegeben(): boolean {
  if (!stand || Date.now() - stand.empfangen > 90_000) return process.env.SYNAPSE_TOKEN_IDENTITAET === '1';
  const { wert, serverZeit, empfangen } = stand;
  if (wert.bis && Date.parse(wert.bis) <= serverZeit + Date.now() - empfangen) return process.env.SYNAPSE_TOKEN_IDENTITAET === '1';
  return wert.freigegeben;
}
export async function holeAgentStartApi(name: string, project: string): Promise<Record<string, string>> {
  if (!agentStartFreigegeben()) return {};
  // Server prüft Freigabe erneut sowie Daemon-Host und Projektzuordnung.
  const a = await spezialistenDatenApi<{ freigegeben?: boolean; token?: string; neuanmeldung?: boolean; legacy_start?: boolean; identity_id?: string; agent_bezug_modus?: string }>('agent_start', { project, agent: name });
  if (a.freigegeben !== true) return {};
  if (a.token !== undefined && (typeof a.token !== 'string' || !/^sai_[a-z0-9]{1,64}$/.test(a.token))) {
    throw new Error('agent_start: ungültige API-Antwort');
  }
  if (!a.token) {
    if (a.legacy_start === true || a.neuanmeldung === true) return { SYNAPSE_AGENT_TOKEN: '' };
    throw new Error('agent_start: Anmeldung nicht geklärt');
  }
  // Leer überschreibt einen eventuell vom aufrufenden Agenten geerbten Ausweis.
  if (a.agent_bezug_modus === 'beide' || a.agent_bezug_modus === 'neu') {
    if (typeof a.identity_id !== 'string' || !/^[a-f0-9-]{36}$/.test(a.identity_id)) throw new Error('agent_start: Identitäts-ID fehlt');
    return { SYNAPSE_AGENT_TOKEN: a.token, SYNAPSE_AGENT_IDENTITY_ID: a.identity_id, SYNAPSE_WRAPPER_TRANSPORT: 'api', SYNAPSE_WISSEN_QUELLE: 'api' };
  }
  return { SYNAPSE_AGENT_TOKEN: a.token };
}
export async function installiereAgentStartQuelle(): Promise<void> {
  const tools = await import('@synapse/mcp-server/tools');
  tools.setzeAgentStartQuelle(holeAgentStartApi);
}
