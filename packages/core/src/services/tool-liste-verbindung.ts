/**
 * P22-T56 (User 20.10.2026): tools/list JE VERBINDUNG.
 *
 * tools/list kommt beim Verbindungsaufbau, vor dem ersten Aufruf mit token. Was die Verbindung selbst traegt, entscheidet
 * die Liste (die Aufrufzeit-Erkennung P22-T55 und die Fall-Skills P23-T5 bleiben massgeblich, die Liste gewaehrt nichts):
 *   ausweis    Ausweis im Transport (REST-Header x-synapse-agent-token, stdio-Env SYNAPSE_AGENT_TOKEN) und Ausweis-Kern fuer
 *              diesen Ausweis wirksam: nur der Ausweis-Weg. token kurz, agent_id/role/project-Selbstangaben ausgeblendet
 *              (agent_id bleibt nur in Tools, die es als Fachfilter kennen; project bleibt bei mehrprojekt, optional),
 *              chat mit anmelden/identitaet.
 *   legacy     REST ohne Ausweis von einem Web-Connector (User-Agent-Praefix aus SYNAPSE_TOOL_LISTE_LEGACY_UA, Standard
 *              claude-user, claude-ai, openai-mcp): keine token-Werbung, agent_id wie bisher, chat ohne anmelden/identitaet.
 *   gemeinsam  Verbindung ohne Ausweis, die mehrere Agenten teilen koennen (stdio = lokale CLI, Claude-Code-Subagenten
 *              teilen die Koordinator-Verbindung; REST von einem unbekannten Client): Liste wie nach P22-T55 (beide Wege).
 *   bestand    Schalter AUS: exakt die Liste nach P22-T55/P23-T5.
 * Unbekannte Clients landen bewusst bei gemeinsam: eine fehlende token-Werbung liesse Clients den token verwerfen
 * (Befund P22-T55), eine ueberzaehlige schadet nicht.
 *
 * SCHALTER (memory regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter agent_profil_schalter funktion
 *   'tool_liste_je_verbindung' (projekt > global; 'alle' schliesst ihn NICHT ein), Standard AUS. Gelesen wird beim Ausweis
 *   das Projekt des Ausweises, sonst global. intern-Override gleichen Namens (nur SYNAPSE_INTERN_TOOL=1, befristet) hat
 *   Vorrang. Lesefehler -> AUS (letzter_fehler). Gepuffert je Prozess (kernTtlMs), Schreiben eines Schalters leert den Puffer.
 * DEBUG: jede Entscheidung traegt variante + grund; bei Schalter EIN steht sie in tools/list unter _meta.synapse_tool_liste.
 *   toolListeVerbindungDiagnose() liefert Zaehler je Variante und die letzten Entscheidungen (User-Agent gekuerzt).
 */
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';
import { leseProfilProduktSchalter, kernTtlMs, registriereSchalterGeschrieben, ausweisTokenAktiv, ausweisProjekt } from './agent-profil-schalter.js';

export const TOOL_LISTE_FUNKTION = 'tool_liste_je_verbindung' as const;
export type ToolListeVariante = 'ausweis' | 'legacy' | 'gemeinsam' | 'bestand';

export interface ToolListeVerbindung {
  transport: 'rest' | 'stdio';
  /** Ausweis aus Header/Env der Verbindung (leer = keiner). */
  transportToken?: string;
  /** nur REST: User-Agent des Clients */
  userAgent?: string;
}

export interface ToolListeEntscheidung {
  variante: ToolListeVariante;
  grund: string;
  transport: 'rest' | 'stdio';
  /** Projekt des Transport-Ausweises (nur Variante ausweis) */
  ausweis_project: string | null;
  schalter: { aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; project: string | null; letzter_fehler: string | null };
}

const STANDARD_LEGACY_UA = ['claude-user', 'claude-ai', 'openai-mcp'];
/** User-Agent-Praefixe der Web-Connectoren ohne Ausweis (Env SYNAPSE_TOOL_LISTE_LEGACY_UA, kommagetrennt, ersetzt den Standard). */
export function legacyUserAgentPraefixe(): string[] {
  const roh = process.env.SYNAPSE_TOOL_LISTE_LEGACY_UA;
  if (roh === undefined || roh.trim() === '') return STANDARD_LEGACY_UA;
  return roh.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
}

type SchalterStand = ToolListeEntscheidung['schalter'];
const PUFFER = new Map<string, { bis: number; stand: SchalterStand }>();
export function leereToolListeSchalterPuffer(): void { PUFFER.clear(); }
registriereSchalterGeschrieben(leereToolListeSchalterPuffer);

/** EINE Lesestelle des Schalters. */
export async function leseToolListeSchalter(project?: string | null): Promise<SchalterStand> {
  const p = typeof project === 'string' && project.trim() ? project.trim() : null;
  const ttl = kernTtlMs();
  const jetzt = Date.now();
  const c = ttl > 0 ? PUFFER.get(p ?? '') : undefined;
  if (c && c.bis > jetzt) return c.stand;
  let stand: SchalterStand = { aktiv: false, quelle: 'standard', project: p, letzter_fehler: null };
  let intern = false;
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean }>({
        text: `SELECT aktiv FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [TOOL_LISTE_FUNKTION],
        query_timeout: 2000,
      } as import('pg').QueryConfig & { query_timeout: number });
      if (r.rows[0]) { stand = { ...stand, aktiv: r.rows[0].aktiv, quelle: 'intern' }; intern = true; }
    } catch { stand = { ...stand, letzter_fehler: 'intern_schalter_nicht_lesbar' }; }
  }
  if (!intern) {
    const prod = await leseProfilProduktSchalter(TOOL_LISTE_FUNKTION, p);
    stand = { ...stand, aktiv: prod.aktiv && !prod.letzter_fehler, quelle: prod.quelle,
      letzter_fehler: prod.letzter_fehler ?? stand.letzter_fehler };
  }
  if (ttl > 0 && !stand.letzter_fehler) PUFFER.set(p ?? '', { bis: jetzt + ttl, stand });
  return stand;
}

const zaehler: Record<ToolListeVariante, number> = { ausweis: 0, legacy: 0, gemeinsam: 0, bestand: 0 };
const LETZTE: Array<{ zeit: string; transport: string; variante: ToolListeVariante; grund: string; user_agent: string | null }> = [];
const LETZTE_MAX = 20;
/** Debug: Zaehler je Variante und die letzten Entscheidungen. */
export function toolListeVerbindungDiagnose(): Record<string, unknown> {
  return { zaehler: { ...zaehler }, letzte: LETZTE.map((x) => ({ ...x })), legacy_user_agents: legacyUserAgentPraefixe() };
}
/** Tests: Zaehler und Verlauf zuruecksetzen. */
export function leereToolListeDiagnose(): void {
  for (const k of Object.keys(zaehler) as ToolListeVariante[]) zaehler[k] = 0;
  LETZTE.length = 0;
}

/** Welche Liste bekommt diese Verbindung? Wirft nie (Fehler -> bestand). */
export async function entscheideToolListeVerbindung(v: ToolListeVerbindung): Promise<ToolListeEntscheidung> {
  const token = typeof v.transportToken === 'string' ? v.transportToken.trim() : '';
  const ua = typeof v.userAgent === 'string' ? v.userAgent.trim().toLowerCase() : '';
  let e: ToolListeEntscheidung;
  try {
    const heimat = token ? await ausweisProjekt(token) : null;
    const schalter = await leseToolListeSchalter(heimat);
    const basis = { transport: v.transport, ausweis_project: null, schalter };
    if (!schalter.aktiv) e = { ...basis, variante: 'bestand', grund: 'schalter_aus' };
    else if (token) {
      e = await ausweisTokenAktiv(heimat, token)
        ? { ...basis, variante: 'ausweis', grund: v.transport === 'stdio' ? 'env_ausweis' : 'header_ausweis', ausweis_project: heimat }
        // Ausweis im Transport, aber Kern fuer ihn nicht wirksam: die Aufrufe laufen ohne Ausweis-Weg -> Bestandsliste.
        : { ...basis, variante: 'gemeinsam', grund: 'ausweis_kern_aus' };
    } else if (v.transport === 'stdio') e = { ...basis, variante: 'gemeinsam', grund: 'stdio_ohne_ausweis' };
    else {
      const praefix = ua ? legacyUserAgentPraefixe().find((x) => ua.startsWith(x)) : undefined;
      e = praefix
        ? { ...basis, variante: 'legacy', grund: 'user_agent:' + praefix }
        : { ...basis, variante: 'gemeinsam', grund: ua ? 'rest_ohne_ausweis_client_unbekannt' : 'rest_ohne_ausweis_ohne_user_agent' };
    }
  } catch {
    e = { variante: 'bestand', grund: 'entscheidung_fehler', transport: v.transport, ausweis_project: null,
      schalter: { aktiv: false, quelle: 'standard', project: null, letzter_fehler: 'entscheidung_fehler' } };
  }
  zaehler[e.variante]++;
  LETZTE.push({ zeit: new Date().toISOString(), transport: e.transport, variante: e.variante, grund: e.grund, user_agent: ua ? ua.slice(0, 80) : null });
  if (LETZTE.length > LETZTE_MAX) LETZTE.shift();
  return e;
}

/** tools/list-Ergebnis: Debug unter _meta nur bei Schalter EIN (AUS = Antwort unveraendert). */
export function toolListeMeta(e: ToolListeEntscheidung | null | undefined): { _meta?: Record<string, unknown> } {
  if (!e || !e.schalter.aktiv) return {};
  return { _meta: { synapse_tool_liste: { variante: e.variante, grund: e.grund, transport: e.transport } } };
}
