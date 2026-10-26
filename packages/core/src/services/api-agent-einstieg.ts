/**
 * P22-T183 B7 (Bauplan 7b28536d): EINSTIEGE in den Lauf der API-Agenten IM synapse-api-Prozess. Alle nur bei Produkt-Schalter
 * api_agenten_lauf_intern EIN im Projekt; AUS (oder kein API-Modell bzw. kein Lauf) liefert null und der Aufrufer bleibt beim
 * Bestand (Daemon-Job, Wrapper, Inbox-Poll).
 *   a) spawneAlsApiLauf: specialist spawn mit einem Modell der Provider anthropic-api | openrouter-api (egal welcher ort). Identitaet
 *      wie beim Container-Spawn (vorhandene unter dem Namen, sonst agent_vorbereiten), Lauf anlegen, Auftrag als erster Eingang
 *      (sofort faellig). Rechte wie agent_vorbereiten: User oder Koordinator DESSELBEN Projekts (auch Legacy-Koordinator).
 *   c) stelleApiLaufZu: Inbox-Nachricht (postToInbox) bzw. Chat-DM (sendMessage) an eine Identitaet mit API-Lauf -> Eingang mit
 *      Buendelfenster (O3). Wirft nie; die eigentliche Zustellung (Inbox/Chat) bleibt unveraendert. Eigene Nachrichten des Agenten
 *      an sich selbst zaehlen nicht.
 *   d) stoppeAlsApiLauf: specialist stop fuer einen Agenten mit API-Lauf -> Status gestoppt (der laufende Turn bricht im
 *      naechsten Takt ab). Rechte wie a).
 * DEBUG: apiLaufZustellungStand() (Zaehler zugestellt/ohne_lauf/schalter_aus/fehler, letzter Fehler) erscheint im Lauf-Stand.
 */
import { getPool } from '../db/client.js';
import { ProfilVerwaltungFehler, aktuellerW1bAkteur, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';
import { rolleFuerAgent } from './agent-rollen.js';
import { istVirtuellesProjekt } from './virtuelle-projekte.js';
import { leseApiLaufSchalter, legeApiLaufAn, legeApiEingangAn, RUECKFALL_MARKE_SQL, type ApiEingangQuelle } from './api-agent-lauf-dienst.js';

const API_PROVIDER = ['anthropic-api', 'openrouter-api'] as const;
const TASK_MAX_ZEICHEN = 200_000;

function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

function akteurAus(agentId: unknown): AusweisAkteur | null {
  const a: W1bAkteur | null = aktuellerW1bAkteur();
  if (a) return a as AusweisAkteur;
  const agent = typeof agentId === 'string' ? agentId.trim() : '';
  return agent && rolleFuerAgent(agent).rolle === 'koordinator' ? { art: 'legacy_koordinator', agent_id: agent } as AusweisAkteur : null;
}

function akteurName(a: AusweisAkteur): string {
  return a.art === 'user' ? 'user' : a.art === 'identitaet' ? a.principal.agent_id : a.art === 'legacy_koordinator' ? a.agent_id : a.art;
}

/** Provider eines Registry-Alias, wenn er ein API-Provider ist; sonst null. */
export async function apiProviderFuerModell(model: unknown): Promise<typeof API_PROVIDER[number] | null> {
  if (typeof model !== 'string' || !model.trim()) return null;
  const r = await getPool().query<{ provider: string }>('SELECT provider FROM model_registry WHERE alias = $1 AND enabled = true', [model.trim()]);
  const p = r.rows[0]?.provider;
  return p && (API_PROVIDER as readonly string[]).includes(p) ? p as typeof API_PROVIDER[number] : null;
}

export interface ApiSpawnEingabe {
  project: string; name: unknown; model: unknown; expertise?: unknown; task: unknown; channel?: unknown;
  /** Nur fuer die Akteur-Ermittlung des Legacy-Koordinators (wie admin). */
  agent_id?: unknown;
}

/** null = kein API-Lauf (Schalter AUS bzw. kein API-Modell) -> Bestand. Fachfehler als { success:false, error }. */
export async function spawneAlsApiLauf(e: ApiSpawnEingabe): Promise<Record<string, unknown> | null> {
  const anbieter = await apiProviderFuerModell(e.model).catch(() => null);
  if (!anbieter || typeof e.project !== 'string' || istVirtuellesProjekt(e.project)) return null;
  const schalter = await leseApiLaufSchalter(e.project);
  if (!schalter.aktiv) return null;
  try {
    const akteur = akteurAus(e.agent_id);
    if (!akteur) fehler('recht_fehlt', { grund: 'API-Lauf starten nur der User oder ein Koordinator des Projekts' });
    await pruefeProfilVerwalter(akteur, e.project);
    const name = pflichtText(e.name, 'name_fehlt', 1, 128);
    if (typeof e.task !== 'string' || !e.task.trim()) fehler('task_fehlt');
    const model = String(e.model).trim();
    const vorhanden = await getPool().query<{ id: string; status: string; rolle: string }>(
      'SELECT id, status, rolle FROM agent_identitaeten WHERE project = $1 AND agent_id = $2', [e.project, name]);
    let identity_id: string, rolle: string, neu = false;
    if (vorhanden.rows[0]) {
      if (vorhanden.rows[0].status !== 'aktiv') fehler('identitaet_nicht_aktiv', { name });
      identity_id = vorhanden.rows[0].id; rolle = vorhanden.rows[0].rolle;
    } else {
      const { agentVorbereiten } = await import('./agent-ausweis-dienst.js');
      const a = await agentVorbereiten({ project: e.project, name, rolle: 'subagent', modell: model, startart: 'spezialist',
        grund: 'P22-T183: Spezialist als API-Lauf in der synapse-api (specialist spawn mit API-Modell)' }, akteur);
      identity_id = a.identity_id; rolle = 'subagent'; neu = true;
    }
    const expertise = typeof e.expertise === 'string' && e.expertise.trim() ? e.expertise.trim() : null;
    const channel = typeof e.channel === 'string' && e.channel.trim() ? e.channel.trim() : null;
    const system = `Du bist ${name}${expertise ? ', Spezialist fuer ' + expertise : ''} im Projekt ${e.project}.`
      + (channel ? ` Ergebnisse und Fragen kurz in den Channel ${channel}, Inhalte als thought.` : '');
    const lauf = await legeApiLaufAn({ identity_id, project: e.project, agent_id: name, rolle, modell: model, anbieter, system_prompt: system,
      gestartet_von: akteurName(akteur) });
    const task = e.task.length > TASK_MAX_ZEICHEN ? e.task.slice(0, TASK_MAX_ZEICHEN) : e.task;
    const eingang = await legeApiEingangAn({ identity_id, text: task, quelle: 'auftrag', absender: akteurName(akteur) });
    const freigabe = rolle === 'main' ? null : await getPool().query<{ aktiv: boolean; modelle: string[] }>(
      'SELECT aktiv, modelle FROM api_agent_freigaben WHERE identity_id = $1', [identity_id]).then(r => r.rows[0] ?? null).catch(() => null);
    const freigegeben = rolle === 'main' || (!!freigabe?.aktiv && (freigabe.modelle ?? []).includes(model));
    return {
      success: true, ort: 'api', agent: name, name, model, anbieter, identity_id, identitaet_neu: neu,
      lauf: { status: lauf.status, sitzung: lauf.sitzung, neu: lauf.neu }, eingang: { id: eingang.id, faellig_ab: eingang.faellig_ab },
      freigabe: { vorhanden: freigegeben },
      message: freigegeben ? `API-Lauf ${name} (${model}) angelegt, Auftrag liegt als Eingang an.`
        : `API-Lauf ${name} (${model}) angelegt. Ohne Freigabe fuer dieses Modell (admin api_freigabe / Web-UI) startet KEIN Turn; der Auftrag wartet.`,
      schalter: schalter.debug,
    };
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, ort: 'api', error: err.code, message: err.code, ...(err.details ? { details: err.details } : {}) };
    return { success: false, ort: 'api', error: 'api_lauf_spawn_fehler', message: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

/** null = kein API-Lauf unter dem Namen bzw. Schalter AUS -> Bestand (Daemon-Stop). */
export async function stoppeAlsApiLauf(project: string, name: unknown, agentId?: unknown): Promise<Record<string, unknown> | null> {
  if (typeof name !== 'string' || !name.trim()) return null;
  const r = await getPool().query<{ identity_id: string; status: string; rueckfall: boolean }>(
    `SELECT l.identity_id, l.status, ${RUECKFALL_MARKE_SQL} AS rueckfall FROM api_agent_laeufe l WHERE l.project = $1 AND l.agent_id = $2`,
    [project, name.trim()]).catch(() => null);
  const l = r?.rows[0];
  // Im Rueckfall laeuft der Agent im Container: stop geht an den Bestand (Daemon).
  if (!l || l.rueckfall || !(await leseApiLaufSchalter(project)).aktiv) return null;
  try {
    const akteur = akteurAus(agentId);
    if (!akteur) fehler('recht_fehlt', { grund: 'API-Lauf stoppen nur der User oder ein Koordinator des Projekts' });
    await pruefeProfilVerwalter(akteur, project);
    await getPool().query("UPDATE api_agent_laeufe SET status = 'gestoppt', aktualisiert_am = NOW() WHERE identity_id = $1", [l.identity_id]);
    return { success: true, ort: 'api', name: name.trim(), identity_id: l.identity_id, vorher: l.status, status: 'gestoppt',
      message: 'API-Lauf gestoppt; ein laufender Turn bricht im naechsten Takt ab. Fortsetzen: admin api_lauf modus fortsetzen.' };
  } catch (err) {
    if (err instanceof ProfilVerwaltungFehler) return { success: false, ort: 'api', error: err.code, message: err.code };
    return { success: false, ort: 'api', error: 'api_lauf_stop_fehler', message: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

const zustellung = { zugestellt: 0, im_rueckfall: 0, ohne_lauf: 0, schalter_aus: 0, fehler: 0, letzter_fehler: null as string | null, letzte: null as string | null };
export function apiLaufZustellungStand(): Record<string, unknown> { return { ...zustellung }; }

/**
 * c) Nachricht an eine Identitaet mit API-Lauf -> Eingang (Buendelfenster). ziel: Agentenname, 'identity:<id>' oder AgentZiel.
 * Wirft nie und haelt den Aufrufer nicht auf (der Aufrufer wartet nicht darauf).
 */
export async function stelleApiLaufZu(project: string, ziel: unknown, text: string, quelle: ApiEingangQuelle, absender: string | null): Promise<boolean> {
  try {
    if (!ziel || !text) return false;
    let identity: string | null = null, name: string | null = null;
    if (typeof ziel === 'object') {
      const z = ziel as { identity_id?: unknown; agent_id?: unknown };
      identity = typeof z.identity_id === 'string' ? z.identity_id : null;
      name = typeof z.agent_id === 'string' ? z.agent_id : null;
    } else if (typeof ziel === 'string') {
      if (ziel.startsWith('identity:')) identity = ziel.slice('identity:'.length); else name = ziel;
    }
    if (!identity && !name) return false;
    const r = await getPool().query<{ identity_id: string; project: string; agent_id: string; rueckfall: boolean }>(
      `SELECT l.identity_id, l.project, l.agent_id, ${RUECKFALL_MARKE_SQL} AS rueckfall FROM api_agent_laeufe l
        WHERE ($1::text IS NOT NULL AND l.identity_id = $1) OR ($1::text IS NULL AND l.project = $2 AND l.agent_id = $3) LIMIT 1`,
      [identity, project, name]);
    const l = r.rows[0];
    if (!l) { zustellung.ohne_lauf += 1; return false; }
    // Rueckfall auf Container (Tageslimit): die Nachricht bleibt nur in Inbox/Chat, der Container-Agent liest sie (Bestand).
    if (l.rueckfall) { zustellung.im_rueckfall += 1; return false; }
    if (absender && absender === l.agent_id) return false;
    if (!(await leseApiLaufSchalter(l.project)).aktiv) { zustellung.schalter_aus += 1; return false; }
    await legeApiEingangAn({ identity_id: l.identity_id, text, quelle, absender });
    zustellung.zugestellt += 1;
    zustellung.letzte = new Date().toISOString();
    return true;
  } catch (err) {
    zustellung.fehler += 1;
    zustellung.letzter_fehler = (err instanceof Error ? err.message : String(err)).slice(0, 200);
    return false;
  }
}
