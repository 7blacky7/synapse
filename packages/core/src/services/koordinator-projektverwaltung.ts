/**
 * P22-T277 (User 06.11.2026 ~13:00 MEZ: "Dass jeder Koordinator in jedem Projekt diese Dinge aendern kann. Auch wenn es keinen
 * Koordinator bereits in diesem Projekt gibt. Und jeder Koordinator ist berechtigt, einen Koordinator zu erstellen als Ausweis fuer das
 * jeweilige Projekt. Nicht nur mehr der Hauptagent."): Projektverwaltung durch Koordinatoren in fremden Projekten. Vorbild ist die
 * Agenten-Verwaltung des Main (hauptagent-sonderstellung.ts MAIN_VERWALTUNG/mainVerwaltungAktiv): derselbe Rechteweg, erweitert, kein zweiter.
 *
 * WER: aktive Identitaet rolle 'koordinator' mit persoenlichem Ausweis, egal aus welchem Heimatprojekt (der Main bleibt wie bisher,
 *   Legacy-Koordinatoren ohne Ausweis nicht).
 * WO: jedes sichtbare User-Projekt B != Heimat, auch mit vorhandenem (ruhendem) Koordinator, AUSSER synapse und dem Hauptagent-Bereich
 *   (KOORDINATOR_VERWALTUNG_AUSGENOMMEN). Unabhaengig vom Schalter mehrprojekt.
 * WAS: nur die Positivliste KOORDINATOR_VERWALTUNG (Projektschalter lesen/setzen auf Projektebene, Build-Einstellungen des Projekts,
 *   Ausweis vorbereiten inkl. Rolle koordinator, Ausweis abrufen). Alles andere bleibt Visum/Arbeitsfreigabe (P22-T44) bzw.
 *   agent_token_fremdes_projekt.
 * WIE: die Ausweis-Grenze (agent-token-tools.ts) setzt den Aufrufkontext koordinator_verwaltung=<B>; der Principal bleibt die
 *   Heimat-Identitaet. pruefeProfilVerwalter/pruefeAusweisAkteur (koordinatorVerwaltetProjekt), setzeProfilProduktSchalter (nur ebene
 *   projekt) und berechtigung() in agent-identitaet.ts lassen sie NUR mit diesem Kontext zu.
 * PFLICHT: grund (mind. 10 Zeichen) und user_auftrag bei profil_schalter_setzen/agent_vorbereiten; grund bei build_einstellungen setzen.
 *   ebene/profil_scope global und Werte ausserhalb des Projekts (Pruefcontainer-Budget, globale Sammelzeit, zuruecksetzen global/budget)
 *   werden abgewiesen.
 * AUDIT: der grund bekommt den Herkunftsvermerk (wer, Heimat, Ziel-Projekt, Aktion) - sichtbar im Schalterverlauf
 *   (agent_profil_schalter.grund, gesetzt_von = Identitaet), im Identitaets-/Profil-Audit von B und in build_pruefung_einstellungen;
 *   dazu je Aufruf eine tool_calls-Zeile im Projekt B mit source 'koordinator-projektverwaltung'.
 * SCHALTER: Produkt-Schalter koordinator_projektverwaltung (global, Standard AUS, nur ausdruecklich). AUS/Lesefehler = Bestand.
 * DEBUG: Antwortfeld berechtigung_weg:'koordinator_projektverwaltung' bei jedem Aufruf, der ueber diesen Weg kam (auch bei Abweisung).
 */
import { getPool } from '../db/client.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';

export const KOORDINATOR_PROJEKTVERWALTUNG_FUNKTION = 'koordinator_projektverwaltung' as const;
/** Antwortfeld des Debugs (Wert = KOORDINATOR_PROJEKTVERWALTUNG_FUNKTION). */
export const BERECHTIGUNG_WEG_FELD = 'berechtigung_weg' as const;
/** Projekte, die dieser Weg nie verwaltet (synapse: Heimat der Plattform; Hauptagent-Bereich: nur der Main). */
export const KOORDINATOR_VERWALTUNG_AUSGENOMMEN: readonly string[] = ['synapse', HAUPTAGENT_PROJEKT];
/** Positivliste tool.action. */
export const KOORDINATOR_VERWALTUNG: ReadonlySet<string> = new Set([
  'admin.profil_schalter_status', 'admin.profil_schalter_setzen', 'admin.agent_vorbereiten', 'admin.token_abrufen',
  'code_check.build_einstellungen',
]);
/** Schreibende Aktionen mit Pflicht grund + user_auftrag. */
const SETZEN_MIT_AUFTRAG: ReadonlySet<string> = new Set(['admin.profil_schalter_setzen', 'admin.agent_vorbereiten']);
/** build_einstellungen-Werte, die nicht dem Projekt gehoeren (Pruefcontainer bzw. global). */
const BUILD_NICHT_PROJEKT = ['speicher_mb', 'tmpfs_mb', 'heap_mb', 'zeitlimit_s', 'nachlauf_buendel_s'] as const;

export function koordinatorVerwaltungErlaubt(tool: string, action: string | undefined): boolean {
  return KOORDINATOR_VERWALTUNG.has(`${tool}.${action ?? ''}`);
}

export function istKoordinatorVerwaltungAusgenommen(project: string | null | undefined): boolean {
  return !project || KOORDINATOR_VERWALTUNG_AUSGENOMMEN.includes(project);
}

/** Schalter koordinator_projektverwaltung (global). Wirft nie; Lesefehler -> AUS. */
export async function koordinatorVerwaltungAktiv(): Promise<boolean> {
  try {
    // Dynamisch: agent-profil-schalter.ts importiert diese Datei ebenfalls dynamisch (kein Importzyklus).
    const { leseProfilProduktSchalter } = await import('./agent-profil-schalter.js');
    const s = await leseProfilProduktSchalter(KOORDINATOR_PROJEKTVERWALTUNG_FUNKTION, null);
    return s.aktiv && !s.letzter_fehler;
  } catch { return false; }
}

/** Identitaet, wenn der Ausweis einer aktiven Koordinator-Identitaet (nicht im Hauptagent-Bereich) gehoert; sonst null. Wirft nie. */
export async function koordinatorIdentitaetDesAusweises(token: string | undefined): Promise<{ identity_id: string; project: string; agent_id: string } | null> {
  if (!token) return null;
  try {
    const r = await getPool().query<{ identity_id: string; project: string; agent_id: string }>(
      `SELECT i.id AS identity_id, i.project, i.agent_id FROM agent_identitaet_tokens t JOIN agent_identitaeten i ON i.id = t.identity_id
        WHERE t.token_offen = $1 AND t.widerrufen_am IS NULL AND (t.gueltig_bis IS NULL OR t.gueltig_bis > NOW())
          AND i.rolle = 'koordinator' AND i.status = 'aktiv' AND i.project <> $2 LIMIT 1`, [token, HAUPTAGENT_PROJEKT]);
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

const laenge = (v: unknown): number => (typeof v === 'string' ? v.trim().length : 0);

/** Pflichtangaben und Projektgrenze VOR dem Handler. null = in Ordnung, sonst die Abweisung (nichts ausgefuehrt). */
export function pruefeKoordinatorVerwaltungsArgs(tool: string, action: string | undefined, args: Record<string, unknown>): Record<string, unknown> | null {
  const schluessel = `${tool}.${action ?? ''}`;
  const abw = (error: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ success: false, error, tool, ...(action ? { action } : {}), ...extra, message: message + ' Nichts wurde ausgefuehrt.' });
  const ebene = args.ebene;
  if (args.profil_scope === 'global'
    || (schluessel === 'admin.profil_schalter_setzen' && ebene !== undefined && ebene !== null && ebene !== 'projekt')) {
    return abw('nur_projektebene', 'Die Projektverwaltung durch Koordinatoren (koordinator_projektverwaltung) gilt nur auf Projektebene; '
      + 'globale Schalter setzen weiterhin nur der User bzw. ein Koordinator von synapse in synapse.');
  }
  const buildSetzen = schluessel === 'code_check.build_einstellungen' && String(args.modus ?? 'status') === 'setzen';
  if (buildSetzen) {
    const fremd: string[] = BUILD_NICHT_PROJEKT.filter((k) => args[k] !== undefined && args[k] !== null);
    const zurueck = args.zuruecksetzen;
    if (zurueck !== undefined && zurueck !== null && !['projekt', 'plan_pruefung'].includes(String(zurueck))) fremd.push('zuruecksetzen:' + String(zurueck));
    if (fremd.length) {
      return abw('nur_projektwerte', 'Ueber koordinator_projektverwaltung nur Werte dieses Projekts (aktiv, sprachen, nachlauf, plan_pruefung_*, '
        + 'zuruecksetzen projekt|plan_pruefung); Pruefcontainer-Budget und globale Werte bleiben beim User.', { felder: fremd });
    }
  }
  if (SETZEN_MIT_AUFTRAG.has(schluessel) || buildSetzen) {
    if (laenge(args.grund) < 10) return abw('grund_fehlt', 'grund mit mindestens 10 Zeichen ist Pflicht.');
    if (SETZEN_MIT_AUFTRAG.has(schluessel) && laenge(args.user_auftrag) < 5) {
      return abw('user_auftrag_fehlt', 'user_auftrag (Wortlaut des User-Auftrags) ist Pflicht.');
    }
  }
  return null;
}

/** Herkunftsvermerk fuer grund/Audit: wer, Heimat, Ziel-Projekt, Aktion. */
export function herkunftsVermerk(o: { agent_id: string; identity_id: string; heimat: string; ziel: string; tool: string; action: string | undefined }): string {
  return `[${KOORDINATOR_PROJEKTVERWALTUNG_FUNKTION}: ${o.agent_id} (${o.identity_id}) aus ${o.heimat} -> ${o.ziel}, ${o.tool}.${o.action ?? ''}]`;
}
