/**
 * P22-T79 (User-Grundsatz memory grundsatz-main-agent-sonderstellung, 20.10.2026: 'Der Main-Agent arbeitet eben nicht dort drin.
 * Er darf aber alles einsehen.'): Sonderstellung des Main in der Ausweis-Grenze (agent-token-tools.ts).
 *
 * LESEZUGRIFF: Ausweis der aktiven Identitaet rolle 'main' im internen Bereich synapse-hauptagent + project=<B> (sichtbares
 *   User-Projekt) -> B wird wie ein Fremdprojekt behandelt, UNABHAENGIG vom Schalter mehrprojekt, Zugang IMMER Visum
 *   (VISUM_ZUSCHNITT: lesen + Channels), auch ohne Koordinator in B. Schreiben -> main_nur_lesen. Unbekanntes Projekt ->
 *   projekt_unbekannt mit Projektliste. Keine Pflichtregeln von B (der Main arbeitet dort nicht), keine Arbeitsfreigabe.
 * LENKHINWEIS: lesende Datenaufrufe des Main im internen Bereich (dort liegen keine Projektdaten) bekommen das Antwortfeld
 *   main_hinweis mit der Projektliste; ebenso chat(anmelden) des Main.
 * SCHALTER (memory regel-neue-funktionen-mit-schalter-und-debug): Produkt-Schalter 'main_lesezugriff' und 'startkontext' (agent-verlauf.ts)
 *   (Katalog PROFIL_PRODUKT_FUNKTIONEN, nur ausdruecklich, STANDARD EIN wie hauptagent_verlauf: reine Lese-/Zustellrechte des
 *   Main). Wirksam = intern-Override (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (ebene global) > Standard EIN.
 *   AUS = Bestand (Abweisung agent_token_fremdes_projekt bzw. kein eingespielter Startkontext).
 * DEBUG: leseMainSchalter() (Quelle, letzter_fehler); chat(identitaet).ausweis_projekte zeigt die Eintraege des Main.
 * AGENTEN-VERWALTUNG (P22-T79 Befund d93b8a2e, User 24.10.: 'auf Agenten sowieso und auch Koordinatoren auf der API'): mit
 *   Produkt-Schalter 'main_agentenverwaltung' (global, Standard AUS, nur ausdruecklich) darf der Main in jedem User-Projekt die
 *   Aktionen der Positivliste MAIN_VERWALTUNG ausfuehren (Ausweise, Identitaeten, Spezialisten/Koordinatoren starten/stoppen,
 *   Heartbeat, Kontingent). Der Principal bleibt dann die Main-Identitaet, der Aufrufkontext traegt main_verwaltung=<Projekt>;
 *   pruefeProfilVerwalter/pruefeAusweisAkteur lassen den Main NUR mit diesem Flag zu. Projektarbeit bleibt main_nur_lesen.
 */
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';

export const MAIN_LESEZUGRIFF_FUNKTION = 'main_lesezugriff' as const;
/** P22-T78 F1: Schalter des generischen Startkontexts (agent-verlauf.ts), gleiche Lesestelle, Standard EIN. */
export const STARTKONTEXT_SCHALTER = 'startkontext' as const;
export type MainSchalterFunktion = typeof MAIN_LESEZUGRIFF_FUNKTION | typeof STARTKONTEXT_SCHALTER;
/** Rolle des Main (= hauptagent-dienst.ts HAUPTAGENT_ROLLE; Literal, damit die Ausweis-Grenze den Dienst nicht importiert). */
const MAIN_ROLLE = 'main';
/** Antwortfeld des Lenkhinweises. */
export const MAIN_HINWEIS_FELD = 'main_hinweis';

type Q = QueryConfig & { query_timeout: number };

export interface MainSchalter { aktiv: boolean; quelle: 'standard' | 'produkt-schalter' | 'intern'; bis: string | null; letzter_fehler: string | null }

/** Frisch je Aufruf. Standard EIN; Lesefehler -> Standard mit letzter_fehler. Wirft nie. */
export async function leseMainSchalter(funktion: MainSchalterFunktion): Promise<MainSchalter> {
  const basis: MainSchalter = { aktiv: true, quelle: 'standard', bis: null, letzter_fehler: null };
  let letzter: string | null = null;
  try {
    // Dynamisch wie hauptagent-verlauf.ts (Importzyklus ueber intern-tool).
    const { internToolAktiv } = await import('./intern-tool.js');
    if (internToolAktiv()) {
      try {
        const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
          text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
          values: [funktion], query_timeout: 2000,
        } as Q);
        const z = r.rows[0];
        if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
      } catch { letzter = 'schalter_nicht_erreichbar'; }
    }
    const p = await leseProfilProduktSchalter(funktion, null);
    if (p.quelle === 'produkt-schalter') return { ...basis, aktiv: p.aktiv, quelle: 'produkt-schalter', letzter_fehler: letzter };
    return { ...basis, letzter_fehler: letzter ?? p.letzter_fehler };
  } catch {
    return { ...basis, letzter_fehler: 'schalter_nicht_lesbar' };
  }
}

/** identity_id, wenn der Ausweis der aktiven Main-Identitaet (rolle main, Bereich synapse-hauptagent) gehoert; sonst null. */
export async function mainIdentitaetDesAusweises(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const r = await getPool().query<{ id: string }>(
      `SELECT i.id FROM agent_identitaet_tokens t JOIN agent_identitaeten i ON i.id = t.identity_id
        WHERE t.token_offen = $1 AND t.widerrufen_am IS NULL AND (t.gueltig_bis IS NULL OR t.gueltig_bis > NOW())
          AND i.project = $2 AND i.rolle = $3 AND i.status = 'aktiv' LIMIT 1`, [token, HAUPTAGENT_PROJEKT, MAIN_ROLLE]);
    return r.rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/** Ist die angemeldete Identitaet der Main? (nach pruefeAgentToken) */
export function istMainPrincipal(p: { project: string; rolle: string } | null | undefined): boolean {
  return !!p && p.project === HAUPTAGENT_PROJEKT && p.rolle === MAIN_ROLLE;
}

/** Sichtbare User-Projekte (Registry, ohne reservierte Systembereiche). Fehler -> leer. */
export async function sichtbareUserProjekte(): Promise<string[]> {
  try {
    const { listeProjekte } = await import('./project-registry.js');
    return (await listeProjekte()).map(p => p.name).filter(n => n && n !== HAUPTAGENT_PROJEKT);
  } catch {
    return [];
  }
}

const liste = (xs: string[]): string => (xs.length ? xs.map(x => `"${x}"`).join(', ') : '(keine gefunden)');

/** Tools mit Projektdaten; lesende Aufrufe davon im internen Bereich bekommen den Lenkhinweis. */
export const MAIN_DATEN_TOOLS: ReadonlySet<string> = new Set([
  'thought', 'plan', 'memory', 'search', 'code_intel', 'hex', 'files', 'files_batch', 'docs', 'asset_intel', 'project', 'shell',
]);

/**
 * Kommunikation des Main in User-Projekten ueber das Visum hinaus (Grundsatz Punkt 3: 'kann JEDEN Agenten anschreiben'):
 * Direktnachricht und Inbox an Agenten des Projekts. Arbeiten (schreiben in Tasks, Code, Wissen) bleibt verweigert.
 */
const MAIN_KOMMUNIKATION: ReadonlySet<string> = new Set(['chat.send', 'chat.inbox_send']);
export function mainKommunikationErlaubt(tool: string, action: string | undefined): boolean {
  return MAIN_KOMMUNIKATION.has(`${tool}.${action ?? ''}`);
}

export const MAIN_AGENTENVERWALTUNG_FUNKTION = 'main_agentenverwaltung' as const;
/** P22-T79: Agenten-Verwaltung des Main in User-Projekten (tool.action). Kein purge, keine Projektdaten. */
export const MAIN_VERWALTUNG: ReadonlySet<string> = new Set([
  'admin.agent_vorbereiten', 'admin.token_abrufen', 'admin.token_loeschen', 'admin.profil_lesen', 'admin.profil_uebersicht',
  'admin.profil_historie', 'admin.identitaet_deaktivieren', 'admin.identitaet_reaktivieren', 'admin.container_kontingent',
  'admin.anmeldungen', 'admin.koordinator_heartbeat',
  'specialist.spawn', 'specialist.spawn_batch', 'specialist.stop', 'specialist.status', 'specialist.wake', 'specialist.heartbeat',
  'specialist.capabilities',
  // P22-T121 (User 24.10. R7 = ja): Runtime-Agenten-Aktionen (T116/T117). Wirksam nur ueber diese Positivliste, d. h. nur mit
  // Schalter main_agentenverwaltung EIN; dahinter bleibt pruefeSteuerRecht + Bestaetigung (runtime-agenten-steuerung.ts) voll wirksam.
  'specialist.runtime_uebersicht', 'specialist.runtime_steuern', 'specialist.runtime_log', 'specialist.runtime_prozesse',
  'specialist.runtime_prozess', 'specialist.runtime_modellwechsel',
]);
export function mainVerwaltungErlaubt(tool: string, action: string | undefined): boolean {
  return MAIN_VERWALTUNG.has(`${tool}.${action ?? ''}`);
}
/** Schalter main_agentenverwaltung (global). Wirft nie; Lesefehler -> AUS. */
export async function mainVerwaltungAktiv(): Promise<boolean> {
  try { return (await leseProfilProduktSchalter(MAIN_AGENTENVERWALTUNG_FUNKTION, null)).aktiv; } catch { return false; }
}

/** P22-T107 (Befund 01f22cc2): Zusatz, wenn main_agentenverwaltung EIN ist - der Main legt Agenten selbst an, statt weiterzuleiten. */
export const MAIN_VERWALTUNG_HINWEIS = 'Agenten-Verwaltung erledigst du SELBST in jedem Projekt (project:"<name>"), wenn der User es auftraegt: '
  + 'Ausweis anlegen admin(agent_vorbereiten, rolle koordinator|subagent, grund, user_auftrag), Koordinatoren/Spezialisten starten/stoppen '
  + 'specialist(spawn ort:"container" | stop | wake | status), Heartbeat admin(koordinator_heartbeat) bzw. specialist(heartbeat), '
  + 'Kontingent admin(container_kontingent), Runtime-Agenten specialist(runtime_uebersicht | runtime_steuern | runtime_log | '
  + 'runtime_prozesse | runtime_prozess | runtime_modellwechsel; Steuern mit grund + Bestaetigung). Nicht an einen Koordinator weiterleiten und nicht erneut nachfragen.';

/** Lenkhinweis fuer den Main im internen Bereich bzw. bei der Anmeldung. */
export function mainHinweisText(projekte: string[], verwaltung = false): string {
  return `Du bist der Main: du siehst ALLE Projekte des Users lesend ein und arbeitest nicht darin. Im internen Bereich "${HAUPTAGENT_PROJEKT}" `
    + `liegen keine Projektdaten (Tasks, Thoughts, Memories, Code). Gib dafuer project:"<name>" an. Projekte: ${liste(projekte)}.`
    + (verwaltung ? ' ' + MAIN_VERWALTUNG_HINWEIS : '');
}

/** Schreibversuch des Main in einem User-Projekt. */
export function mainNurLesenAblehnung(tool: string, action: string | undefined, project: string): Record<string, unknown> {
  return {
    success: false, error: 'main_nur_lesen', tool, ...(action ? { action } : {}), project,
    message: `Der Main arbeitet nicht in Projekten: im Projekt "${project}" darfst du lesen und Channels nutzen. "${tool}${action ? '.' + action : ''}" `
      + `aendert etwas - gib den Auftrag an den Koordinator von "${project}" weiter (channel oder chat). Nichts wurde ausgefuehrt. `
      + `Agenten-Verwaltung (Ausweise, Koordinatoren/Spezialisten starten/stoppen, Heartbeat, Kontingent) ist mit Schalter main_agentenverwaltung erlaubt.`,
  };
}

/** Main nennt ein Projekt, das es nicht gibt (oder einen Systembereich). */
export function mainProjektUnbekannt(project: string, projekte: string[]): Record<string, unknown> {
  return {
    success: false, error: 'projekt_unbekannt', project, projekte,
    message: `Ein Projekt "${project}" gibt es nicht. Vorhandene Projekte: ${liste(projekte)}. Nichts wurde ausgefuehrt.`,
  };
}
