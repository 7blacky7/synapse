/**
 * P22-T13 Phase V: GEMEINSAMER VERTRAG fuer W1b (Typen, Interfaces, Service-Signaturen).
 * Konzept: 7594a932 (4) + 85dd2b81 (4.1/K14) + 4e6327ca (4.2/K15) + 10be97e2 (4.3/K16) + 6411650a (4.3a).
 *
 * PAKETZUORDNUNG (jeder Stub nennt sein Paket im Fehler W1bNichtUmgesetzt und im Kommentar):
 *   A  Schattenprofile (24h-Frist, Bestaetigung/Ablehnung/Verfall), Typ-Katalog global/projekt mit
 *      Revisionen, Profil-Override mit profil_revision/CAS, Profilhistorie/Rollback, Audit
 *   B  Voranlage/Legacy-Anmeldung -> Schattenentwurf, erster Koordinator, tokenfreie
 *      Koordinatorliste (CLI/Web-UI), Token-Aktivierung/Erstzustellung, portable Anmeldung,
 *      Fortsetzungsantwort
 *   C  Tool-/Aktions-/Hinweiskatalog vollstaendig je Produzent, Typ-/Profilresolver (Zuschnitt,
 *      registriereZuschnittResolver), gemeinsame Antwortpipeline/Budget/Projektion
 *   D  Persona-Bibliothek/-Zuweisung, Verwaltung REST+Tool, verschluesselter auditierter
 *      Tokenabruf (agent-token-tresor.ts), Web-UI-Anzeige des Koordinatortokens
 *   T  Optionale Task-Bindung offen|identitaet|team mit Pflicht-Grund und Audit
 * Stubs werfen W1bNichtUmgesetzt - KEIN fachliches Verhalten, KEIN DB-Zugriff. Umgesetzt sind
 * nur reine Vertragsentscheidungen, die alle Pakete gleich brauchen (Zustandsautomat,
 * Rechteentscheidung, Katalogableitung, Validierung). Alles ist ueber agent-profil-schalter.ts
 * standardmaessig AUS; kein Stub wird von einem bestehenden Pfad aufgerufen.
 */
import type { IdentitaetsAgentPrincipal } from './agent-bezug.js';
import type { ToolZuschnitt, ZugriffsRegel } from './tool-gate.js';
// Paket A: Dienste sind im Eintrag lazy verdrahtet (W1B_DIENSTE), weil agent-profil-dienst-a.ts diese Datei zurueckimportiert.
import { PAKET_A_DIENSTE } from './agent-profil-dienst-a.js';
// Paket B: Anmeldung/Koordinatorliste/Fortsetzung, lazy verdrahtet (agent-anmeldung.ts importiert diese Datei zurueck).
import { ANMELDUNGS_DIENSTE } from './agent-anmeldung.js';
import type { PoolClient } from 'pg';
// W12 (P22-T23): Ausweis-/Regelstand-Kennungen (reine Funktion regelnStand).
import { createHash } from 'node:crypto';
import { aktuellerAgentPrincipal } from './agent-bezug.js';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
// P22-T18: Rollenerkennung per Namensmuster fuer Aufrufer ohne Token (reine Funktion ohne Importe).
import { rolleFuerAgent } from './agent-rollen.js';
// Paket D: Persona-/Tokenabruf-Dienste sind im Eintrag lazy verdrahtet (W1B_DIENSTE), weil sie diese Datei zurueckimportieren.
import { personaDienst } from './agent-persona.js';
import { tokenAbrufDienst, rufeAusweisAb, loescheAusweis } from './agent-token-abruf.js';

export type W1bPaket = 'A' | 'B' | 'C' | 'D' | 'T';

export class W1bNichtUmgesetzt extends Error {
  readonly code = 'w1b_nicht_umgesetzt';
  constructor(public readonly paket: W1bPaket, public readonly funktion: string) {
    super(`w1b_nicht_umgesetzt:${paket}:${funktion}`);
  }
}

/** Verwaltungsakteur. Ausschliesslich aus authentifiziertem Transport bzw. Tokenpruefung, nie aus Tool-Argumenten. */
export type W1bAkteur =
  | { art: 'user' }
  | { art: 'daemon' }
  | { art: 'identitaet'; principal: IdentitaetsAgentPrincipal };

// ---------------------------------------------------------------------------------------------
// Schattenprofil (A, Aufruf der Anlage aus B)
// ---------------------------------------------------------------------------------------------
export const SCHATTEN_ZUSTAENDE = ['pending', 'bestaetigt', 'abgelaufen', 'abgelehnt'] as const;
export type SchattenZustand = typeof SCHATTEN_ZUSTAENDE[number];
/** K3: Profil UND vorgesehener Token bleiben 24 h Schatten; Aktivitaet verlaengert nicht. */
export const SCHATTEN_FRIST_MS = 24 * 3_600_000;
export type SchattenUrsprung = 'legacy_register' | 'koordinator_voranlage' | 'koordinator_start';

export interface SchattenSelbstangaben {
  name?: string;
  modell?: string;
  effort?: string;
  kontext?: string | number;
  typ_vorschlag?: string;
  rolle_vorschlag?: string;
  arbeitsweise?: string;
  startart?: string;
  channels?: string[];
  /** weitere Profildaten als Selbstangabe; niemals fremde Zugangswerte */
  weitere?: Record<string, unknown>;
}

export interface Schattenprofil {
  id: string;
  project: string;
  ursprung_agent_id: string;
  ursprung_sitzung: string | null;
  ursprung_art: SchattenUrsprung;
  selbstangaben: SchattenSelbstangaben;
  korrektur: Partial<ProfilInhalt>;
  typ_id: string | null;
  zustand: SchattenZustand;
  revision: number;
  erstellt_am: string;
  ablauf_am: string;
  identity_id: string | null;
  entschieden_von: string | null;
  entschieden_am: string | null;
  user_zustimmung: string | null;
  grund: string | null;
  /** Anzeige nur als Praefix; der vorgesehene Token ist vor Bestaetigung UNGUELTIG. */
  vorgesehener_token_praefix?: string | null;
}

const SCHATTEN_UEBERGAENGE: Readonly<Record<SchattenZustand, readonly SchattenZustand[]>> = {
  pending: ['bestaetigt', 'abgelaufen', 'abgelehnt'],
  bestaetigt: [],
  abgelaufen: [],
  abgelehnt: [],
};

/** Endzustaende sind endgueltig: ein abgelaufener Vorgang wird nie nachtraeglich bestaetigt. */
export function schattenUebergangErlaubt(von: SchattenZustand, nach: SchattenZustand): boolean {
  return SCHATTEN_UEBERGAENGE[von]?.includes(nach) ?? false;
}

export function schattenAblauf(erstellt: Date): Date {
  return new Date(erstellt.getTime() + SCHATTEN_FRIST_MS);
}

/** pending nach Ablauf ist wirksam abgelaufen, auch bevor ein Verfallslauf die Zeile umschreibt. */
export function wirksamerSchattenZustand(
  s: { zustand: SchattenZustand; ablauf_am: string | Date }, jetzt = Date.now(),
): SchattenZustand {
  if (s.zustand !== 'pending') return s.zustand;
  return new Date(s.ablauf_am).getTime() <= jetzt ? 'abgelaufen' : 'pending';
}

/** Der vorgesehene Schatten-Token bewirkt nie eine Anmeldung; erst Bestaetigung aktiviert ihn. */
export function vorgesehenerTokenGueltig(zustand: SchattenZustand): boolean {
  return zustand === 'bestaetigt';
}

export interface SchattenAnlage {
  project: string;
  ursprung_agent_id: string;
  ursprung_sitzung?: string | null;
  ursprung_art: SchattenUrsprung;
  selbstangaben: SchattenSelbstangaben;
}

export interface SchattenBestaetigung {
  schattenprofil_id: string;
  erwartete_revision: number;
  korrektur?: Partial<ProfilInhalt>;
  typ_id?: string | null;
  /** Nachweis der User-Zustimmung bzw. Freigabe zum Alleinbestaetigen (Pflicht, ins Audit). */
  user_zustimmung: string;
  grund: string;
}

export interface SchattenprofilDienst {
  /** A: legt an bzw. fuehrt wiederholte Meldungen desselben Vorgangs zusammen; nur bei Produkt-Schalter schattenprofile. */
  legeSchattenprofilAn(e: SchattenAnlage, akteur: W1bAkteur): Promise<Schattenprofil>;
  /** A */
  listeSchattenprofile(project: string, akteur: AusweisAkteur, filter?: { zustand?: SchattenZustand }): Promise<Schattenprofil[]>;
  /** A: Korrekturentwurf mit CAS auf revision */
  korrigiereSchattenprofil(id: string, erwartete_revision: number, korrektur: Partial<ProfilInhalt>, akteur: AusweisAkteur, grund: string): Promise<Schattenprofil>;
  /** A: atomar Identitaet + Profilrevision 1 + Tokenaktivierung + Audit; Doppelbestaetigung idempotent */
  bestaetigeSchattenprofil(b: SchattenBestaetigung, akteur: AusweisAkteur): Promise<{ schattenprofil: Schattenprofil; identity_id: string; profil_revision: number }>;
  /** A */
  lehneSchattenprofilAb(id: string, erwartete_revision: number, akteur: AusweisAkteur, grund: string): Promise<Schattenprofil>;
  /** A: pending mit ablauf_am <= jetzt -> abgelaufen (verfaellt mit vorgesehenem Token); keine Datenloeschung */
  verfalleAbgelaufene(project?: string, jetzt?: Date): Promise<number>;
}

// ---------------------------------------------------------------------------------------------
// Profil, Typ-Katalog, Revisionen (A), wirksames Profil (C)
// ---------------------------------------------------------------------------------------------
export type KontextStufe = 'normal' | 'kompakt' | 'minimal';
export type ShellStufe = 'laeuft' | 'hinweis' | 'anleitung' | 'rueckfrage';

export interface ProfilZuschnitt {
  standard?: ZugriffsRegel;
  /** Schluessel = Tool-Name */
  tools?: Record<string, ZugriffsRegel>;
  /** Schluessel = '<tool>.<action>' */
  aktionen?: Record<string, ZugriffsRegel>;
  schreiben?: boolean;
  /** hoechste erlaubte Shell-Stufe; ersetzt keine Bestaetigung und hebt keine harte Sperre auf */
  shell_stufe_max?: ShellStufe;
  /** Mengen-/Parameterlimits je '<tool>.<action>.<parameter>' */
  limits?: Record<string, number>;
  /** b930e4af: nur mit ausdruecklichem User-Auftrag gilt der Zuschnitt fuer intern */
  intern_user_festgelegt?: { user_auftrag: string } | null;
}

export interface ProfilInhalt {
  modell?: string | null;
  provider?: string | null;
  effort?: string | null;
  kontextfenster?: number | null;
  kontext_budget?: number | null;
  kontext_stufe?: KontextStufe;
  rolle?: string;
  regeln?: string[];
  briefing?: string | null;
  arbeitsweise?: string | null;
  channels?: string[];
  zuschnitt?: ProfilZuschnitt;
  /** Schluessel aus HINWEIS_KATALOG; Pflichtklassen sind nicht abschaltbar */
  hinweise?: Record<string, boolean>;
  startrezept?: Record<string, unknown>;
}

export type FeldHerkunft = 'standard' | 'global_typ' | 'projekt_typ' | 'profil';

export interface WirksamesProfil {
  identity_id: string;
  project: string;
  profil_revision: number;
  typ: { id: string; schluessel: string; scope: 'global' | 'projekt'; revision: number } | null;
  werte: ProfilInhalt;
  herkunft: Partial<Record<keyof ProfilInhalt, FeldHerkunft>>;
  /** fuer das Gate (tool-gate.ts); null = kein Zuschnitt = heutiges Verhalten */
  zuschnitt: ToolZuschnitt | null;
}

export interface ProfilAenderung {
  identity_id: string;
  /** CAS: muss agent_identitaeten.profil_revision entsprechen, sonst ProfilRevisionKonflikt */
  erwartete_revision: number;
  patch: Partial<ProfilInhalt>;
  typ_id?: string | null;
  grund: string;
  user_auftrag?: string;
}

export interface ProfilRevision {
  identity_id: string;
  revision: number;
  snapshot: ProfilInhalt & { rolle?: string; modell_bestaetigt?: string | null };
  typ_id: string | null;
  typ_revision: number | null;
  persona_vorlage_id: string | null;
  persona_version: number | null;
  wer: string;
  user_auftrag: string | null;
  grund: string;
  wann: string;
}

export class ProfilRevisionKonflikt extends Error {
  readonly code = 'profil_revision_veraltet';
  constructor(public readonly aktuelle_revision: number) { super('profil_revision_veraltet'); }
}

export interface ProfilDienst {
  /** C: konsistenter Snapshot aus aktueller Profil-/Typrevision; Fehler -> Ablehnung, nie alte Freigaben */
  leseWirksamesProfil(identity_id: string, akteur: W1bAkteur): Promise<WirksamesProfil>;
  /** A: neue unveraenderliche Revision + Audit transaktional, CAS ueber erwartete_revision */
  aendereProfil(a: ProfilAenderung, akteur: W1bAkteur): Promise<{ profil_revision: number }>;
  /** A */
  profilHistorie(identity_id: string, akteur: W1bAkteur): Promise<ProfilRevision[]>;
  /** A: Rollback = neue Revision; reaktiviert keine entfernte Persona ohne User-Wunsch (K7) */
  rollbackProfil(identity_id: string, ziel_revision: number, erwartete_revision: number, akteur: W1bAkteur, grund: string): Promise<{ profil_revision: number }>;
}

/**
 * K10/a0f710e0: Profile aendern User oder Koordinator desselben Projekts; ein Agent nie sein eigenes,
 * ein Koordinator sein eigenes nur im ersten User-beauftragten Startfall. Rolle aus Tokenpruefung.
 */
export function darfProfilAendern(
  akteur: AusweisAkteur, ziel: { identity_id: string; project: string }, opt: { ersterKoordinatorStart?: boolean } = {},
): boolean {
  if (akteur.art === 'user') return true;
  // P22-T34: Legacy-Koordinator hat keine eigene Identitaet, also nie ein Eigenprofil; seine Rolle prueft pruefeProfilVerwalter/pruefeVerwalter.
  if (akteur.art === 'legacy_koordinator') return true;
  if (akteur.art !== 'identitaet') return false;
  const p = akteur.principal;
  if (p.project !== ziel.project || p.rolle !== 'koordinator') return false;
  if (p.identity_id === ziel.identity_id) return opt.ersterKoordinatorStart === true;
  return true;
}

export interface AgentTyp {
  id: string;
  scope: 'global' | 'projekt';
  project: string | null;
  schluessel: string;
  aktuelle_revision: number;
  status: 'aktiv' | 'deaktiviert';
}

export interface AgentTypRevision {
  typ_id: string;
  revision: number;
  inhalt: ProfilInhalt;
  wer: string;
  grund: string | null;
  wann: string;
}

export interface TypKatalogDienst {
  /** A: global + Projekt; Projekttyp ergaenzt globale Einstellungen */
  listeTypen(project: string, akteur: W1bAkteur): Promise<AgentTyp[]>;
  /** A */
  legeTypAn(e: { scope: 'global' | 'projekt'; project?: string | null; schluessel: string; inhalt: ProfilInhalt; grund: string }, akteur: W1bAkteur): Promise<AgentTyp>;
  /** A: neue Revision mit CAS */
  aendereTyp(typ_id: string, erwartete_revision: number, inhalt: ProfilInhalt, akteur: W1bAkteur, grund: string): Promise<AgentTyp>;
  /** A */
  leseTypRevision(typ_id: string, revision?: number): Promise<AgentTypRevision>;
}

// ---------------------------------------------------------------------------------------------
// Persona (D) - Standard leer, nur auf User-Wunsch
// ---------------------------------------------------------------------------------------------
export interface PersonaVorlage {
  id: string;
  scope: 'global' | 'projekt';
  project: string | null;
  name: string;
  aktuelle_version: number;
  status: 'aktiv' | 'archiviert';
}

export interface PersonaVersion {
  vorlage_id: string;
  version: number;
  inhalt: Record<string, unknown>;
  user_auftrag: string;
  wann: string;
}

export interface PersonaZuweisung {
  identity_id: string;
  vorlage_id: string;
  version: number;
  user_auftrag: string;
  gesetzt_von: string;
  gesetzt_am: string;
}

/** K7: ohne ausdruecklichen User-Wunsch keine Persona; Typ/Vorlage/Jev/Rollback weisen nie zu. */
export const PERSONA_STANDARD: PersonaZuweisung | null = null;

export interface PersonaDienst {
  /** D */
  listeVorlagen(project: string, akteur: W1bAkteur): Promise<PersonaVorlage[]>;
  /** D: neue Vorlage mit Version 1; user_auftrag Pflicht */
  legeVorlageAn(e: { scope: 'global' | 'projekt'; project?: string | null; name: string; inhalt: Record<string, unknown> }, akteur: W1bAkteur, user_auftrag: string): Promise<PersonaVersion>;
  /** D: neue Version ueberschreibt keine laufende Zuweisung */
  neueVersion(vorlage_id: string, inhalt: Record<string, unknown>, akteur: W1bAkteur, user_auftrag: string): Promise<PersonaVersion>;
  /** D: nur auf User-Wunsch, auditiert alt/neu */
  weiseZu(identity_id: string, vorlage_id: string, version: number, akteur: W1bAkteur, user_auftrag: string): Promise<PersonaZuweisung>;
  /** D: jederzeit */
  entferne(identity_id: string, akteur: W1bAkteur, grund: string): Promise<void>;
  /** D */
  leseZuweisung(identity_id: string): Promise<PersonaZuweisung | null>;
}

// ---------------------------------------------------------------------------------------------
// Tool-/Aktions-/Hinweiskatalog (C)
// ---------------------------------------------------------------------------------------------
/** '<tool>' oder '<tool>.<action>' - stabil, aus den vorhandenen Definitionen abgeleitet. */
export type ToolKatalogSchluessel = string;

export interface ToolKatalogEintrag {
  schluessel: ToolKatalogSchluessel;
  tool: string;
  action: string | null;
}

/** Leitet Tool- und Aktionsschluessel aus denselben Definitionen ab, die tools/list und PA-1 sehen. */
export function toolKatalogAusDefinitionen(
  defs: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }>,
): ToolKatalogEintrag[] {
  const out: ToolKatalogEintrag[] = [];
  for (const d of defs) {
    out.push({ schluessel: d.name, tool: d.name, action: null });
    const action = d.inputSchema?.properties?.action as { enum?: unknown[] } | undefined;
    for (const a of Array.isArray(action?.enum) ? action.enum : []) {
      if (typeof a === 'string') out.push({ schluessel: d.name + '.' + a, tool: d.name, action: a });
    }
  }
  return out;
}

// P22-T13 Paket C: Der vollstaendige Hinweiskatalog (K16.3/P7-T46) liegt in hinweis-katalog.ts (rein, ohne
// Laufzeitimporte), damit Low-Level-Produzenten ihn VOR Suche/Claim ohne Importzyklus nutzen. Hier nur
// re-exportiert: dieselben Namen und Schluessel wie in Phase V (kein zweiter Katalog).
export type { HinweisKlasse, HinweisKatalogEintrag } from './hinweis-katalog.js';
export { HINWEIS_KATALOG, HINWEIS_KATALOG_VOLLSTAENDIG, hinweisEintrag, hinweisAbschaltbar } from './hinweis-katalog.js';

/** C: Zuschnitt-Resolver. Standard: kein aktives Profil -> null -> exakt heutiges Verhalten. */
export type ZuschnittResolver = (p: IdentitaetsAgentPrincipal) => Promise<ToolZuschnitt | null>;
const KEIN_ZUSCHNITT: ZuschnittResolver = async () => null;
let zuschnittResolver: ZuschnittResolver = KEIN_ZUSCHNITT;

/** Paket C registriert hier den revisionsfrischen Profilresolver; null setzt auf 'kein Profil' zurueck. */
export function registriereZuschnittResolver(fn: ZuschnittResolver | null): void {
  zuschnittResolver = fn ?? KEIN_ZUSCHNITT;
}

/** Fehler werden NICHT als 'kein Profil' behandelt; der Aufrufer lehnt dann ab (K16.8). */
export async function loeseToolZuschnitt(p: IdentitaetsAgentPrincipal): Promise<ToolZuschnitt | null> {
  return zuschnittResolver(p);
}

export interface AntwortpipelineEingabe {
  tool: string;
  action: string | null;
  principal: IdentitaetsAgentPrincipal | null;
  /** vollstaendiges fachliches Ergebnis (Audit/Speicherung bleiben ungekuerzt, K16.7) */
  vollstaendig: unknown;
  profil: WirksamesProfil | null;
}

export interface AntwortpipelineDienst {
  /** C: Katalogentscheidung vor Produzent/Claim, Projektion nur der Agentenauslieferung */
  projiziereAgentAntwort(e: AntwortpipelineEingabe): Promise<{ agent: unknown; gekuerzt: boolean; nachladen?: Record<string, unknown> }>;
}

// ---------------------------------------------------------------------------------------------
// Anmeldung/Koordinatorliste (B), Tokenabruf (D)
// ---------------------------------------------------------------------------------------------
/** K3C: tokenfreie Liste; der Anmeldende ist noch kein Koordinator. */
export interface KoordinatorListenEintrag {
  name: string;
  agent_id: string;
  identity_id: string;
  zustand: 'laeuft' | 'ruht' | 'deaktiviert';
  letzte_aktivitaet: string | null;
  /** Anzeige (CLI/Web-UI/chatgpt.com/Host), keine Bindung der Tokengueltigkeit */
  letzter_herkunftsort: string | null;
}

export interface FortsetzungsInfo {
  identity_id: string;
  project: string;
  profil_revision: number;
  letzter_lauf: { lauf_id: string; abgeloest: boolean } | null;
  /** priorisierter Ueberblick mit IDs und exakten Abrufaktionen (K4) */
  abrufwege: Array<{ art: string; id: string; aufruf: Record<string, unknown> }>;
  /** Anzahl Abrufwege je Art (Ueberblick fuer kleine Kontexte) */
  zaehler?: Record<string, number>;
  /** W12-C (P22-T26): kompakter Profilblock; nur wenn zustellUmfang().profilblock. */
  profil?: ProfilBlock;
  /** W12-C: an die Identitaet gebundene Tasks (plan_task_bindungen), zusaetzlich zu Beteiligungen. */
  gebundene_tasks?: GebundeneTask[];
  /** W12-C: Channels aus dem Profil, bei der Anmeldung automatisch beigetreten. */
  profil_channels?: { beigetreten: string[]; fehlgeschlagen: string[] };
  /** W12-B: was in dieser Antwort zugestellt wurde (Debug/Tests). */
  zustellung?: ZustellUmfang & { lauf_id: string | null };
}

export interface AnmeldungsDienst {
  /** B */
  koordinatorListe(project: string): Promise<KoordinatorListenEintrag[]>;
  /** B: erster Koordinator ohne Anfangstoken, atomar je Projekt, User-Auftrag ins Audit */
  legeErstenKoordinatorAn(project: string, user_auftrag: string): Promise<{ identity_id: string; token: string }>;
  /** B */
  fortsetzungsInfo(p: IdentitaetsAgentPrincipal): Promise<FortsetzungsInfo>;
}

/** 02845fc2/K10A: fremde Tokens lesen nur User oder bestaetigter Koordinator DESSELBEN Projekts. */
export function darfTokenAbrufen(akteur: W1bAkteur, project: string): boolean {
  if (akteur.art === 'user') return true;
  return akteur.art === 'identitaet' && akteur.principal.rolle === 'koordinator' && akteur.principal.project === project;
}

export interface TokenAbrufDienst {
  /** D: entschluesselt API-seitig, auditiert ohne Tokenwert; Antwort darf den echten Token enthalten */
  rufeProfilTokenAb(project: string, ziel_identity_id: string, akteur: W1bAkteur, anlass: string): Promise<{ token: string; token_id: string; token_praefix: string }>;
}

// ---------------------------------------------------------------------------------------------
// Task-Bindung (T)
// ---------------------------------------------------------------------------------------------
export type TaskBindung =
  | { art: 'offen' }
  | { art: 'identitaet'; identity_id: string }
  | { art: 'team'; identity_ids: readonly string[] };
export type TaskBindungsAktion = 'festlegen' | 'aendern' | 'entblocken';

/** K14.4: Pruefung ausschliesslich ueber die Token-identity_id, kein Namensfallback. */
export function taskBindungErlaubt(b: TaskBindung, akteur: { identity_id?: string | null }): boolean {
  if (b.art === 'offen') return true;
  const id = akteur.identity_id;
  if (!id) return false;
  return b.art === 'identitaet' ? b.identity_id === id : b.identity_ids.includes(id);
}

/** K14.3: Teamaenderung/Entblocken nur mit Grund; leeres Team ist kein heimliches Entblocken. */
export function pruefeTaskBindungsAenderung(
  aktion: TaskBindungsAktion, neu: TaskBindung | null, grund?: string | null,
): string | null {
  const mitGrund = typeof grund === 'string' && grund.trim().length > 0;
  if (aktion === 'entblocken') return mitGrund ? null : 'grund_fehlt';
  if (!neu || neu.art === 'offen') return 'bindung_ungueltig';
  if (neu.art === 'identitaet' && !neu.identity_id) return 'bindung_ungueltig';
  if (neu.art === 'team' && (!Array.isArray(neu.identity_ids) || neu.identity_ids.length === 0
    || neu.identity_ids.some(x => typeof x !== 'string' || !x))) return 'team_leer';
  if (aktion === 'aendern' && !mitGrund) return 'grund_fehlt';
  return null;
}

export interface TaskBindungDienst {
  /** T: keine Zeile = offen */
  leseBindung(project: string, task_id: string): Promise<TaskBindung>;
  /** T: nur Koordinator/User, auditiert */
  legeFest(project: string, task_id: string, b: TaskBindung, akteur: W1bAkteur, grund?: string): Promise<TaskBindung>;
  /** T: Grund Pflicht */
  aendere(project: string, task_id: string, b: TaskBindung, akteur: W1bAkteur, grund: string): Promise<TaskBindung>;
  /** T: Grund Pflicht, Rueckkehr zu offen ohne Historienverlust */
  entblocke(project: string, task_id: string, akteur: W1bAkteur, grund: string): Promise<TaskBindung>;
}

// ---------------------------------------------------------------------------------------------
// Stub-Registry: die Pakete ersetzen ihre Eintraege; bis dahin klarer Fehler ohne Wirkung.
// ---------------------------------------------------------------------------------------------
function stub(paket: W1bPaket, funktion: string): (..._a: unknown[]) => Promise<never> {
  return async () => { throw new W1bNichtUmgesetzt(paket, funktion); };
}

// ---------------------------------------------------------------------------------------------
// Paket T (K14): Task-Bindung offen|identitaet|team. Keine Zeile = offen. Wirkung nur bei
// Produkt-Schalter task_bindung (Standard AUS). Verwaltung nur User bzw. Koordinator desselben Projekts.
// ---------------------------------------------------------------------------------------------
export class TaskBindungFehler extends Error {
  constructor(public readonly code: string, message?: string) { super(message ?? code); }
}

const TASK_BINDUNG_GRUND_TEXT: Record<string, string> = {
  grund_fehlt: 'Grund ist Pflicht (nicht leer).',
  team_leer: 'Ein Team braucht mindestens ein Mitglied; ein leeres Team ist kein Entblocken.',
  bindung_ungueltig: 'Ungueltige Task-Bindung.',
};

interface TaskBindungZeile { art: 'identitaet' | 'team'; identity_ids: string[]; revision: number }

function zeileZuBindung(z: { art: string; identity_ids: string[] }): TaskBindung {
  return z.art === 'identitaet'
    ? { art: 'identitaet', identity_id: z.identity_ids[0] }
    : { art: 'team', identity_ids: z.identity_ids };
}

/** K14.3: Verwaltung nur User bzw. Koordinator desselben Projekts (Rolle aus Tokenpruefung). */
export function darfTaskBindungVerwalten(akteur: AusweisAkteur, project: string): boolean {
  if (akteur.art === 'user') return true;
  // P22-T34: Legacy-Koordinator (Namensmuster/Rolle wie P22-T18); die Abgrenzung zu Token-Identitaeten macht der Dispatcher (pruefeProfilVerwalter).
  if (akteur.art === 'legacy_koordinator') return typeof akteur.agent_id === 'string' && rolleFuerAgent(akteur.agent_id.trim()).rolle === 'koordinator';
  return akteur.art === 'identitaet' && akteur.principal.rolle === 'koordinator' && akteur.principal.project === project;
}

function akteurKennung(akteur: AusweisAkteur): { wer: string; identity: string | null } {
  if (akteur.art === 'user') return { wer: 'user', identity: null };
  if (akteur.art === 'legacy_koordinator') return { wer: 'legacy:' + String(akteur.agent_id ?? '').trim(), identity: null };
  if (akteur.art === 'daemon') return { wer: 'daemon', identity: null };
  return { wer: akteur.principal.identity_id, identity: akteur.principal.identity_id };
}

function normalisiereBindung(b: TaskBindung): TaskBindung {
  if (b.art === 'identitaet') return { art: 'identitaet', identity_id: String(b.identity_id ?? '').trim() };
  if (b.art === 'team') {
    const roh = Array.isArray(b.identity_ids) ? b.identity_ids : [];
    return { art: 'team', identity_ids: [...new Set(roh.map(x => String(x ?? '').trim()).filter(Boolean))] };
  }
  return b;
}

/** K14.2: Mitglieder muessen zum selben Projekt wie die Task gehoeren. */
async function pruefeIdentitaetenImProjekt(project: string, ids: readonly string[]): Promise<void> {
  const r = await getPool().query<{ id: string }>(
    'SELECT id FROM agent_identitaeten WHERE project=$1 AND id=ANY($2::text[])', [project, [...ids]]);
  const da = new Set(r.rows.map(x => x.id));
  const fremd = ids.filter(x => !da.has(x));
  if (fremd.length > 0) throw new TaskBindungFehler('identitaet_fremd', 'Identitaet(en) gehoeren nicht zu diesem Projekt: ' + fremd.join(', ') + '.');
}

async function mitTransaktion<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const ergebnis = await fn(c);
    await c.query('COMMIT');
    return ergebnis;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

async function leseBindungRoh(project: string, task_id: string): Promise<TaskBindung> {
  const r = await getPool().query<TaskBindungZeile>(
    'SELECT art, identity_ids, revision FROM plan_task_bindungen WHERE project=$1 AND task_id=$2', [project, task_id]);
  return r.rows[0] ? zeileZuBindung(r.rows[0]) : { art: 'offen' };
}

/** Gate ohne Schalterpruefung (Aufrufer hat den Schalter bereits gelesen). Null = erlaubt. */
export async function bindungsSperre(project: string, task_id: string, identity_id: string | null, ref: string = task_id): Promise<string | null> {
  const b = await leseBindungRoh(project, task_id);
  if (taskBindungErlaubt(b, { identity_id })) return null;
  return `Diese Task ist an eine andere Identitaet/ein anderes Team gebunden (Task ${ref}). Ablehnung ohne Aenderung.`;
}

/** Gate fuer uebernehmen/abmelden/passende_tasks. Schalter AUS -> immer null (exakt bisheriges Verhalten). */
export async function pruefeTaskBindungZugriff(project: string, task_id: string, identity_id: string | null, ref: string = task_id): Promise<string | null> {
  if (!(await leseProfilProduktSchalter('task_bindung', project)).aktiv) return null;
  return bindungsSperre(project, task_id, identity_id, ref);
}

async function schreibeBindungsAudit(
  c: PoolClient, project: string, task_id: string, aktion: TaskBindungsAktion,
  alt: TaskBindung | null, neu: TaskBindung | (TaskBindung & { ereignis: string }) | null, wer: string, identity: string | null, grund: string | null,
): Promise<void> {
  await c.query(
    `INSERT INTO plan_task_bindung_audit(project,task_id,aktion,alt,neu,wer,actor_identity_id,grund)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [project, task_id, aktion, alt ? JSON.stringify(alt) : null, neu ? JSON.stringify(neu) : null, wer, identity, grund]);
}

/** festlegen / aendern / entblocken: Schalter, Recht, Pflicht-Grund, Mitglieder, Sperre + Audit in EINER Transaktion. */
async function verwalteBindung(
  project: string, task_id: string, akteur: AusweisAkteur, aktion: TaskBindungsAktion,
  neu: TaskBindung | null, grund: string | null,
): Promise<TaskBindung> {
  if (!(await leseProfilProduktSchalter('task_bindung', project)).aktiv) {
    throw new TaskBindungFehler('funktion_aus', 'Task-Bindung ist nicht freigegeben (Produkt-Schalter task_bindung ist AUS).');
  }
  if (!darfTaskBindungVerwalten(akteur, project)) {
    throw new TaskBindungFehler('recht_fehlt', 'Task-Bindungen setzen, aendern und entblocken nur User bzw. Koordinator dieses Projekts.');
  }
  const n = neu ? normalisiereBindung(neu) : null;
  const fehler = pruefeTaskBindungsAenderung(aktion, n, grund);
  if (fehler) throw new TaskBindungFehler(fehler, TASK_BINDUNG_GRUND_TEXT[fehler] ?? fehler);
  const ids: string[] = n && n.art === 'identitaet' ? [n.identity_id] : n && n.art === 'team' ? [...n.identity_ids] : [];
  if (ids.length > 0) await pruefeIdentitaetenImProjekt(project, ids);
  const { wer, identity } = akteurKennung(akteur);
  const grundTrim = grund?.trim() ?? null;
  return mitTransaktion(async (c) => {
    const r = await c.query<TaskBindungZeile>(
      'SELECT art, identity_ids, revision FROM plan_task_bindungen WHERE project=$1 AND task_id=$2 FOR UPDATE', [project, task_id]);
    const zeile = r.rows[0];
    if (aktion === 'festlegen' && zeile) throw new TaskBindungFehler('bindung_existiert', 'Task hat bereits eine Bindung; aendern oder entblocken.');
    if (aktion !== 'festlegen' && !zeile) throw new TaskBindungFehler('keine_bindung', 'Task hat keine Bindung (offen).');
    const alt: TaskBindung = zeile ? zeileZuBindung(zeile) : { art: 'offen' };
    if (aktion === 'entblocken') {
      await c.query('DELETE FROM plan_task_bindungen WHERE project=$1 AND task_id=$2', [project, task_id]);
      await schreibeBindungsAudit(c, project, task_id, aktion, alt, { art: 'offen' }, wer, identity, grundTrim);
      return { art: 'offen' } as TaskBindung;
    }
    if (!n || n.art === 'offen') throw new TaskBindungFehler('bindung_ungueltig', TASK_BINDUNG_GRUND_TEXT.bindung_ungueltig);
    if (aktion === 'festlegen') {
      await c.query(
        `INSERT INTO plan_task_bindungen(project,task_id,art,identity_ids,gesetzt_von,gesetzt_von_identity_id,grund)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [project, task_id, n.art, ids, wer, identity, grundTrim]);
    } else {
      await c.query(
        `UPDATE plan_task_bindungen SET art=$3, identity_ids=$4, revision=revision+1, gesetzt_von=$5,
           gesetzt_von_identity_id=$6, gesetzt_am=NOW(), grund=$7 WHERE project=$1 AND task_id=$2`,
        [project, task_id, n.art, ids, wer, identity, grundTrim]);
    }
    await schreibeBindungsAudit(c, project, task_id, aktion, alt, n, wer, identity, grundTrim);
    return n;
  });
}

/**
 * P22-T18 (User-Entscheidung 19.10.2026, thought 8aab4bcf): Angaben aus dem Aufruf, KEIN Identitaetsnachweis.
 * agent_id = Legacy-Agent ohne Token (fehlt: reiner User-Pfad), grund = Begruendung fuer update_task auf gebundener Task.
 */
export interface TaskBearbeiter {
  agent_id?: string | null; grund?: string | null;
  /** P22-T28 (H3): Merker je Aufruf (z. B. add_batch): hoechstens EIN Audit-Eintrag je Task und Aufruf. */
  auditMerker?: Set<string>;
}

function beschreibeBindung(b: TaskBindung): string {
  if (b.art === 'identitaet') return 'Identitaet ' + b.identity_id;
  if (b.art === 'team') return 'Team ' + b.identity_ids.join(', ');
  return 'offen';
}

/**
 * P22-T18: update_task eines Legacy-Agenten (agent_id, kein Token-Principal) bei Schalter EIN.
 * Unveraendert (null): kein agent_id (User-Pfad), Rolle koordinator (Namensmuster wie rolleFuerAgent), Task ohne Bindung.
 * Gebundene Task: ohne Grund Abweisung (TaskBindungFehler grund_noetig), mit getrimmtem Grund (Konvention der Bindungs-Gruende: nicht leer)
 * erlaubt UND Eintrag in plan_task_bindung_audit: aktion 'aendern' (die CHECK-Aktionen bleiben unveraendert), Bindung unveraendert (alt = neu),
 * wer 'legacy:<agent_id>', neu.ereignis 'update_task_legacy', grund mit Praefix '[update_task ohne Token]'.
 */
/** P22-T28 (H3): Ergebnis des update_task-Gates; nachErfolg schreibt den Legacy-Audit ERST nach erfolgreichem Task-Update. */
export interface BindungsPruefung { sperre: string | null; nachErfolg: (() => Promise<void>) | null }
const KEINE_VORMERKUNG: BindungsPruefung = { sperre: null, nachErfolg: null };
async function pruefeLegacyBearbeitung(project: string, task_id: string, bearbeiter: TaskBearbeiter | undefined, ref: string): Promise<BindungsPruefung> {
  const agent = typeof bearbeiter?.agent_id === 'string' ? bearbeiter.agent_id.trim() : '';
  if (!agent) return KEINE_VORMERKUNG;
  if (rolleFuerAgent(agent).rolle === 'koordinator') return KEINE_VORMERKUNG;
  const b = await leseBindungRoh(project, task_id);
  if (b.art === 'offen') return KEINE_VORMERKUNG;
  const grund = typeof bearbeiter?.grund === 'string' ? bearbeiter.grund.trim() : '';
  if (!grund) {
    throw new TaskBindungFehler('grund_noetig', `grund_noetig: grund angeben (Task ${ref} ist gebunden an ${beschreibeBindung(b)}). Agenten ohne Token brauchen fuer update_task auf einer gebundenen Task einen Grund.`);
  }
  const merker = bearbeiter?.auditMerker;
  return {
    sperre: null,
    nachErfolg: async () => {
      if (merker?.has(task_id)) return;
      await mitTransaktion(c => schreibeBindungsAudit(c, project, task_id, 'aendern', b, { ...b, ereignis: 'update_task_legacy' }, 'legacy:' + agent, null, '[update_task ohne Token] ' + grund));
      merker?.add(task_id);
    },
  };
}

/** update_task-Gate (Paket T): bei Schalter EIN darf nur Koordinator/User bzw. Mitglied der Bindung bearbeiten. Ohne Principal: User-Pfade unveraendert, Legacy-Agent mit agent_id nur mit Grund (P22-T18). */
export async function vormerkenTaskBindungBearbeitenFuer(project: string, task_id: string, p: IdentitaetsAgentPrincipal | null, ref: string = task_id, bearbeiter?: TaskBearbeiter): Promise<BindungsPruefung> {
  if (!(await leseProfilProduktSchalter('task_bindung', project)).aktiv) return KEINE_VORMERKUNG;
  if (!p) return pruefeLegacyBearbeitung(project, task_id, bearbeiter, ref);
  if (p.project === project && p.rolle === 'koordinator') return KEINE_VORMERKUNG;
  return { sperre: await bindungsSperre(project, task_id, p.project === project ? p.identity_id : null, ref), nachErfolg: null };
}

/** Wie vormerkenTaskBindungBearbeitenFuer, schreibt den Legacy-Audit aber SOFORT (Altverhalten fuer Aufrufer ohne eigenes Update). */
export async function pruefeTaskBindungBearbeitenFuer(project: string, task_id: string, p: IdentitaetsAgentPrincipal | null, ref: string = task_id, bearbeiter?: TaskBearbeiter): Promise<string | null> {
  const r = await vormerkenTaskBindungBearbeitenFuer(project, task_id, p, ref, bearbeiter);
  if (r.nachErfolg) await r.nachErfolg();
  return r.sperre;
}

/** P22-T28 (H3): Gate mit Akteur aus dem Tokenkontext; der Aufrufer ruft nachErfolg() nach dem erfolgreichen Task-Update. */
export async function vormerkenTaskBindungBearbeiten(project: string, task_id: string, ref: string = task_id, bearbeiter?: TaskBearbeiter): Promise<BindungsPruefung> {
  const p = aktuellerAgentPrincipal();
  return vormerkenTaskBindungBearbeitenFuer(project, task_id, p && p.art === 'identity' ? p : null, ref, bearbeiter);
}

/** Wie pruefeTaskBindungBearbeitenFuer, Akteur aus dem aktuellen Tokenkontext. */
export async function pruefeTaskBindungBearbeiten(project: string, task_id: string, ref: string = task_id, bearbeiter?: TaskBearbeiter): Promise<string | null> {
  const p = aktuellerAgentPrincipal();
  return pruefeTaskBindungBearbeitenFuer(project, task_id, p && p.art === 'identity' ? p : null, ref, bearbeiter);
}

export const taskBindungDienst: TaskBindungDienst = {
  leseBindung: leseBindungRoh,
  legeFest: (project, task_id, b, akteur, grund) => verwalteBindung(project, task_id, akteur, 'festlegen', b, grund ?? null),
  aendere: (project, task_id, b, akteur, grund) => verwalteBindung(project, task_id, akteur, 'aendern', b, grund),
  entblocke: (project, task_id, akteur, grund) => verwalteBindung(project, task_id, akteur, 'entblocken', null, grund),
};

export interface W1bDienste {
  schatten: SchattenprofilDienst;
  profil: ProfilDienst;
  typen: TypKatalogDienst;
  persona: PersonaDienst;
  anmeldung: AnmeldungsDienst;
  tokenAbruf: TokenAbrufDienst;
  taskBindung: TaskBindungDienst;
  antwort: AntwortpipelineDienst;
}

export const W1B_DIENSTE: W1bDienste = {
  schatten: {
    legeSchattenprofilAn: (e, a) => PAKET_A_DIENSTE.schatten.legeSchattenprofilAn(e, a),
    listeSchattenprofile: (p, a, f) => PAKET_A_DIENSTE.schatten.listeSchattenprofile(p, a, f),
    korrigiereSchattenprofil: (id, r, k, a, g) => PAKET_A_DIENSTE.schatten.korrigiereSchattenprofil(id, r, k, a, g),
    bestaetigeSchattenprofil: (b, a) => PAKET_A_DIENSTE.schatten.bestaetigeSchattenprofil(b, a),
    lehneSchattenprofilAb: (id, r, a, g) => PAKET_A_DIENSTE.schatten.lehneSchattenprofilAb(id, r, a, g),
    verfalleAbgelaufene: (p, j) => PAKET_A_DIENSTE.schatten.verfalleAbgelaufene(p, j),
  },
  profil: {
    // Paket C: lazy (dynamischer Import), weil agent-zuschnitt.ts diese Datei statisch importiert.
    leseWirksamesProfil: async (id, a) => (await import('./agent-zuschnitt.js')).leseWirksamesProfil(id, a),
    aendereProfil: (a, k) => PAKET_A_DIENSTE.profil.aendereProfil(a, k),
    profilHistorie: (id, k) => PAKET_A_DIENSTE.profil.profilHistorie(id, k),
    rollbackProfil: (id, z, r, k, g) => PAKET_A_DIENSTE.profil.rollbackProfil(id, z, r, k, g),
  },
  typen: {
    listeTypen: (p, a) => PAKET_A_DIENSTE.typen.listeTypen(p, a),
    legeTypAn: (e, a) => PAKET_A_DIENSTE.typen.legeTypAn(e, a),
    aendereTyp: (t, r, i, a, g) => PAKET_A_DIENSTE.typen.aendereTyp(t, r, i, a, g),
    leseTypRevision: (t, r) => PAKET_A_DIENSTE.typen.leseTypRevision(t, r),
  },
  persona: {
    listeVorlagen: (p, a) => personaDienst.listeVorlagen(p, a),
    legeVorlageAn: (e, a, u) => personaDienst.legeVorlageAn(e, a, u),
    neueVersion: (v, i, a, u) => personaDienst.neueVersion(v, i, a, u),
    weiseZu: (i, v, n, a, u) => personaDienst.weiseZu(i, v, n, a, u),
    entferne: (i, a, g) => personaDienst.entferne(i, a, g),
    leseZuweisung: (i) => personaDienst.leseZuweisung(i),
  },
  anmeldung: {
    koordinatorListe: (p) => ANMELDUNGS_DIENSTE.koordinatorListe(p),
    legeErstenKoordinatorAn: (p, u) => ANMELDUNGS_DIENSTE.legeErstenKoordinatorAn(p, u),
    fortsetzungsInfo: (p) => ANMELDUNGS_DIENSTE.fortsetzungsInfo(p),
  },
  tokenAbruf: {
    rufeProfilTokenAb: (p, z, a, g) => tokenAbrufDienst.rufeProfilTokenAb(p, z, a, g),
  },
  taskBindung: {
    leseBindung: leseBindungRoh,
    legeFest: taskBindungDienst.legeFest,
    aendere: taskBindungDienst.aendere,
    entblocke: taskBindungDienst.entblocke,
  },
  antwort: {
    projiziereAgentAntwort: async (e) => (await import('./agent-zuschnitt.js')).projiziereAgentAntwort(e),
  },
};

// =============================================================================================
// WELLE 12 (P22-T23) - DELTA-VERTRAG AGENTEN-AUSWEIS. Verbindlich fuer W12-A/B/C/D/T (P22-T24..T28).
// Grundlage: thoughts 498818f4 (Zielbild 1-11), eeac2976 (Lebenszyklus), 63911bc7 (offen speichern),
// memory entscheidung-agenten-ausweis-2026-10-19 (Punkt 2: KEINE Sitzungsbindung, K1 GESTRICHEN).
// Schema: 114_agent_ausweis.sql (agent-ausweis-schema.ts). Paketzuschnitt: Vertrags-Thought zu P22-T23.
//
// V1 AUSWEIS = Identifikation innerhalb von Synapse, KEIN Sicherheitssystem; Bearer bleibt Pflicht.
//    Wert 'sai_' + fortlaufend gezaehlte Nummer (P22-T35, 1 Zeichen, dann 2, 3 ...; alte 64-hex bleiben gueltig), OFFEN in agent_identitaet_tokens.token_offen (unique), Lookup NUR darueber.
//    token_hash / token_verschluesselt / token_schluessel_id / start_art sind stillgelegt (neue Zeilen NULL);
//    Altzeilen ohne token_offen sind ungueltig (Koordinator stellt beim Deploy neu aus). agent-token-tresor.ts
//    und SYNAPSE_AGENT_TOKEN_SCHLUESSEL entfallen. Wert NIE in Log/Audit/tool_calls/Channel/Thought;
//    Zuordnung ueber identity_id, token_id, token_praefix. Nur direkte Antworten an User/Koordinator bzw. an
//    den betroffenen Agenten (Startkonfiguration, Abruf, TOKEN_BEREIT-Hinweis) tragen den Wert.
// V2 LEBENSZYKLUS (ausweisZustand): ausgestellt -> aktiv -> geloescht; ausgestellt + Frist vorbei = verfallen.
//    Weg A: Legacy-Anmeldung erzeugt nur einen SCHATTEN (24 h, kein Ausweis). Bestaetigung (admin
//      schattenprofil_bestaetigen) erzeugt den Ausweis direkt 'aktiv' (ausweis_weg 'schatten_bestaetigt');
//      der laufende Agent erhaelt ihn per Hinweis TOKEN_BEREIT (V6).
//    Weg B: admin agent_vorbereiten erzeugt Identitaet + Profil + Ausweis 'ausgestellt' mit Erstnutzungsfrist
//      (erstnutzungFristMs, Env SYNAPSE_AGENT_START_TOKEN_TTL_MIN, Standard 10 min). Die ERSTE erfolgreiche
//      Pruefung (chat anmelden ODER beliebiger Toolaufruf mit token) IST die Bestaetigung: gueltig_bis = NULL,
//      danach dauerhaft bis User/Koordinator loescht. Sonderfall: der Name hat eine laufende Legacy-Sitzung im
//      Projekt -> sofort 'aktiv' (ausweis_weg 'uebernahme', legacy_uebernahme:true), Zustellung wie Weg A.
//    Je Identitaet genau EIN nicht geloeschter Ausweis (Index uq_agent_identitaet_tokens_einer). Respawn,
//      Neustart, Modellwechsel und Daemon-Start benutzen DENSELBEN Ausweis; keine Start-Rotation, kein
//      60-s-Uebergang, keine Start-Ausweise mehr. Neu ausgestellt wird nur, wenn der vorhandene verfallen
//      (vorher loeschen, Grund 'erstnutzung_verfallen') oder ausdruecklich geloescht ist.
// V3 IDENTIFIKATION JE AUFRUF: Der Agent gibt token bei JEDEM Toolaufruf als Parameter mit (wie agent_id).
//    Keine Sitzungsbindung, keine neuen Header/Env-Konzepte. Bestand x-synapse-agent-token (Spezialisten,
//    mcp-http.json) und SYNAPSE_AGENT_TOKEN (stdio, Daemon-Spawn) bleiben unveraendert lauffaehig, werden aber
//    nicht ausgebaut; Vorrang: Argument token > Bestand-Header/Env. Ohne token: Legacy wie heute (agent_id).
// V4 RECHTE: agent_vorbereiten, Abruf und Loeschen nur User (authentifizierter User-Eingang) oder Koordinator
//    MIT eigenem Ausweis desselben Projekts (darfAusweisVerwalten). Daemon: nur ausweisFuerStart fuer eine
//    vorhandene Identitaet seines Projekts, nie Anlage. Ein Legacy-Koordinator ohne Ausweis ist kein Nachweis
//    (erster Koordinator: legeErstenKoordinatorAn bzw. chat(register, id:'koordinator') im Modus 'beide').
// V5 LAUF = AKTUELLER KONTEXT (lauf_id). Neuer Lauf (context_epoch+1, neue Identitaets-Sitzung):
//    chat(anmelden, token) und admin(index_stats, sitzung:'neu'|'fortsetzung') mit token -> beginn_art
//    'anmelden' bzw. 'fortsetzung'; erster Token-Aufruf ohne aktiven Lauf -> 'implizit'; erster Token-Aufruf
//    einer Identitaet mit Legacy-Ursprung (gleiche agent_id bzw. Schatten-Ursprung) -> 'uebernahme' inkl.
//    Uebernahme-Bruecke (LaufDienst.uebernehmeLegacy, einmalig, idempotent). Folgeaufrufe mit token im
//    selben Lauf beginnen nie einen neuen Lauf. Was zugestellt wird, entscheidet zustellUmfang().
// V6 HINWEISQUELLEN (bestehende Registry ausloeser-hinweise.ts, beide PFLICHT: durch hinweise_aus/
//    hinweise_nur von Profil/Kontextprofil NICHT abschaltbar):
//    w1b.token_bereit (W12-B): Aufruf OHNE token unter einer agent_id, zu der im Projekt eine Identitaet
//      (agent_id gleich bzw. bestaetigter Schatten mit ursprung_agent_id gleich) mit gueltigem Ausweis
//      (ausgestellt|aktiv) und zuletzt_benutzt IS NULL existiert. modus 'bis_erledigt', hinweis_id = token_id,
//      entprellung_ms = tokenBereitEntprellungMs() (Env SYNAPSE_W1B_TOKEN_HINWEIS_MS, Standard 600000),
//      spezifitaet 9, text = tokenBereitText(token). erledigt:true sobald zuletzt_benutzt gesetzt. UNABHAENGIG
//      von ursprung_sitzung. Registrierung an den wirksamen Ausweis-Kern gekoppelt (auch nach API-Neustart mit
//      intern-Override; Quelle prueft leseAusweisKern selbst), nicht nur an Env SYNAPSE_W1B_ANMELDUNG.
//    w1b.profil_update (W12-C, eigene Datei): Aufruf MIT token, aktiver Lauf. Basis = GREATEST(
//      lauf.zugestellt_profil_revision, hoechste schon zugestellte 'rev:<n>' dieser Quelle in der aktuellen
//      Identitaets-Sitzung); Basis NULL -> nichts (Profilblock zustaendig). Basis < agent_identitaeten.
//      profil_revision -> EIN Hinweis: modus 'einmal_je_sitzung', hinweis_id 'rev:<aktuell>', spezifitaet 8,
//      text = formatiereProfilUpdate(diff), Diff aus agent_profil_revisionen (Basis vs. aktuell) plus seit
//      lauf.zugestellt_am geaenderte Task-Bindungen (plan_task_bindung_audit). Durchsetzung bleibt SOFORT
//      (Resolver je Aufruf, unabhaengig von der Zustellung). Typrevision ohne Neuzuweisung erhoeht
//      profil_revision nicht (Typ-Pinning 26cf1837 B3) -> kein Hinweis; im Diff steht ein Typwechsel als
//      'Typ <alt> -> <neu> (Rev n)'.
//    Tool-Call-Log: sai_[a-z0-9]{1,64} (Wortgrenzen) in args UND result schwaerzen (token-Parameter je Aufruf!) - W12-B prueft
//      tool-args-schwaerzen.ts und ergaenzt bei Bedarf; admin agent_vorbereiten/token_abrufen ohne result.
// V7 SCHALTER S1 (W12-T): EIN Produkt-Schalter 'agenten_ausweis' (agent_profil_schalter, projekt > global) fuer
//    den Ausweis-Kern; ersetzt in der Wirkung token_identitaet + w1b_anmeldung + schattenprofile + token_abruf.
//    Getrennt bleiben profilverwaltung, typkatalog, persona, task_bindung, w1b_durchsetzung, w1b_antwortanpassung.
//    Einziger Lesepunkt fuer Ausweis-Pfade: leseAusweisKern(project) (agent-profil-schalter.ts; Signatur jetzt,
//    Rumpf = Uebergang ueber Altschalter, W12-T ersetzt). Wirksam nur bei agent_bezug_modus 'beide';
//    Einschalten bei anderem Modus -> agent_bezug_modus_nicht_beide. AUS = Bestandsverhalten (Golden t110).
// =============================================================================================

export type W12Paket = 'W12-A' | 'W12-B' | 'W12-C' | 'W12-D' | 'W12-T';
export class W12NichtUmgesetzt extends Error {
  readonly code = 'w12_nicht_umgesetzt';
  constructor(public readonly paket: W12Paket, public readonly funktion: string) {
    super(`w12_nicht_umgesetzt:${paket}:${funktion}`);
  }
}

/** Stabile Fehlercodes der W12-Pfade (Tool/REST: {success:false, error:<code>}). Bestehende Klassen duerfen sie tragen. */
export const AUSWEIS_FEHLER = [
  'agent_token_ungueltig',          // unbekannt, geloescht, verfallen, Altzeile ohne token_offen, falsches Format
  'agent_token_fremdes_projekt',
  'agent_token_fehlt',              // agent_id gehoert einer Identitaet, Aufruf ohne token (Text: TEXT_AGENT_TOKEN_FEHLT)
  'identitaet_konflikt',            // Selbstangaben widersprechen dem Ausweis (F3, unveraendert)
  'ausweis_kern_aus',               // leseAusweisKern(project).aktiv === false
  'agent_bezug_modus_nicht_beide',
  'recht_fehlt',
  'identitaet_unbekannt',
  'identitaet_nicht_aktiv',
  'ausweis_fehlt',                  // Abruf/Start: Identitaet ohne gueltigen Ausweis
  'name_ungueltig',
  'grund_fehlt',
  'anlass_fehlt',
] as const;
export type AusweisFehlerCode = typeof AUSWEIS_FEHLER[number];
export class AusweisFehler extends Error {
  constructor(public readonly code: AusweisFehlerCode, public readonly details?: Record<string, unknown>) { super(code); }
}

// ---- V1/V2 Ausweis-Lebenszyklus (reine Entscheidungen) ----------------------------------------
// P22-T35: Format/Praefix kommen aus agent-ausweis-format.ts (einzige Quelle; sai_ + 1..64 Zeichen [a-z0-9]).
import * as AUSWEIS_FMT from './agent-ausweis-format.js';
export const AUSWEIS_FORMAT = AUSWEIS_FMT.AUSWEIS_FORMAT;
export const AUSWEIS_PRAEFIX_LAENGE = AUSWEIS_FMT.AUSWEIS_PRAEFIX_LAENGE;
export function ausweisPraefix(token: string): string { return AUSWEIS_FMT.ausweisPraefix(token); }

export type AusweisZustand = 'ausgestellt' | 'aktiv' | 'verfallen' | 'geloescht';
export type AusweisWeg =
  | 'vorbereitet' | 'schatten_bestaetigt' | 'uebernahme' | 'register' | 'erster_koordinator' | 'daemon_start' | 'neu_ausgestellt';

/** Zustand allein aus den Spalten (agent_identitaet_tokens): widerrufen_am > gueltig_bis. */
export function ausweisZustand(
  t: { gueltig_bis: string | Date | null | undefined; widerrufen_am: string | Date | null | undefined }, jetzt = Date.now(),
): AusweisZustand {
  if (t.widerrufen_am) return 'geloescht';
  if (t.gueltig_bis === null || t.gueltig_bis === undefined) return 'aktiv';
  return new Date(t.gueltig_bis).getTime() > jetzt ? 'ausgestellt' : 'verfallen';
}
/** Nur ausgestellt (innerhalb der Frist) und aktiv identifizieren; alles andere -> agent_token_ungueltig. */
export function ausweisGueltig(z: AusweisZustand): boolean { return z === 'ausgestellt' || z === 'aktiv'; }
/** Erstnutzungsfrist Weg B; Env SYNAPSE_AGENT_START_TOKEN_TTL_MIN (Minuten, > 0), Standard 10. */
export function erstnutzungFristMs(): number {
  const m = Number(process.env.SYNAPSE_AGENT_START_TOKEN_TTL_MIN);
  return (Number.isFinite(m) && m > 0 ? m : 10) * 60_000;
}

/** V4: User oder Koordinator MIT Ausweis desselben Projekts (wie darfTokenAbrufen; Daemon nur ausweisFuerStart). */
export function darfAusweisVerwalten(akteur: W1bAkteur, project: string): boolean {
  return darfTokenAbrufen(akteur, project);
}

// ---- Weg B: agent_vorbereiten + Startkonfiguration (W12-A) ------------------------------------
export type Startart = 'subagent' | 'spezialist' | 'codex' | 'hauptagent' | 'sonstiges';

export interface AgentVorbereitenEingabe {
  project: string;
  /** Neue Identitaet bzw. Name einer laufenden Legacy-Sitzung (-> Uebernahme). Genau eins von name/identity_id. */
  name?: string;
  /** Vorhandene Identitaet (Respawn): liefert deren gueltigen Ausweis, stellt keinen zweiten aus. */
  identity_id?: string;
  /** Standard 'subagent'; 'koordinator' durch User oder Koordinator (auch Legacy). */
  rolle?: string;
  typ_id?: string | null;
  /** Profil-Override (ProfilInhalt), wird als Revision gespeichert (aendereProfil-Regeln, CAS intern). */
  profil?: Partial<ProfilInhalt>;
  modell?: string | null;
  startart?: Startart;
  grund: string;
  user_auftrag?: string;
}

export interface Startkonfiguration {
  /** Ein Satz fuers Spawn-Prompt/Onboarding, enthaelt den Ausweis (startsatzText). */
  startsatz: string;
  /** Dieselbe Vorlage mit Platzhalter {TOKEN} (fuer Anzeige/Logs ohne Wert). */
  startsatz_vorlage: string;
  /** Erste Aktion des Agenten. */
  erste_aktion: { tool: 'chat'; argumente: { action: 'anmelden'; token: string } };
  /** ISO-Zeitpunkt der Erstnutzungsfrist; null = bereits aktiv. */
  erstnutzung_bis: string | null;
  /** Nur Daemon-Spezialisten (Bestand): Env-Name, den der Daemon selbst setzt. Kein neues Konzept. */
  bestand_env?: 'SYNAPSE_AGENT_TOKEN';
}

export interface AgentVorbereitenAusgabe {
  identity_id: string;
  agent_id: string;
  project: string;
  rolle: string;
  profil_revision: number;
  neu_angelegt: boolean;
  legacy_uebernahme: boolean;
  token: string;
  token_id: string;
  token_praefix: string;
  zustand: AusweisZustand;
  ausweis_weg: AusweisWeg;
  erstnutzung_bis: string | null;
  startkonfiguration: Startkonfiguration;
}

export const STARTSATZ_VORLAGE = 'Dein Synapse-Agenten-Ausweis: {TOKEN}. Erste Aktion: chat(action:"anmelden", token:"{TOKEN}"). '
  + 'Danach bei JEDEM Synapse-Aufruf token:"{TOKEN}" mitgeben (ersetzt agent_id, project und role). '
  + 'Neuer Kontext/Neustart: wieder chat(anmelden, token), nie chat(register). Ausweis nie in Channel, Thought oder Log schreiben.';

export function startsatzText(token: string, erstnutzung_bis: string | null): string {
  const satz = STARTSATZ_VORLAGE.split('{TOKEN}').join(token);
  return erstnutzung_bis ? `${satz} Erste Anmeldung bis ${erstnutzung_bis}, sonst verfaellt der Ausweis.` : satz;
}

export function baueStartkonfiguration(token: string, erstnutzung_bis: string | null, startart?: Startart): Startkonfiguration {
  return {
    startsatz: startsatzText(token, erstnutzung_bis),
    startsatz_vorlage: STARTSATZ_VORLAGE,
    erste_aktion: { tool: 'chat', argumente: { action: 'anmelden', token } },
    erstnutzung_bis,
    ...(startart === 'spezialist' ? { bestand_env: 'SYNAPSE_AGENT_TOKEN' as const } : {}),
  };
}

export interface AusweisAbruf {
  identity_id: string;
  token: string;
  token_id: string;
  token_praefix: string;
  zustand: AusweisZustand;
  ausweis_weg: AusweisWeg | null;
  erstnutzung_bis: string | null;
  zuletzt_benutzt: string | null;
}

/** W12-A (Koordinator-Vorgabe 27920): zusaetzlich zu W1bAkteur der Legacy-Koordinator ohne eigenen Ausweis (Erkennung wie P22-T18). */
export type AusweisAkteur = W1bAkteur | { art: 'legacy_koordinator'; agent_id: string };

export interface AusweisDienst {
  /** W12-A: admin agent_vorbereiten / REST POST .../agent-profile/vorbereiten. Kern AUS -> ausweis_kern_aus. */
  agentVorbereiten(e: AgentVorbereitenEingabe, akteur: AusweisAkteur): Promise<AgentVorbereitenAusgabe>;
  /** W12-A: admin token_abrufen (offen lesen, ohne eigenen Schalter token_abruf), Audit ohne Wert. */
  rufeAusweisAb(project: string, identity_id: string, akteur: AusweisAkteur, anlass: string): Promise<AusweisAbruf>;
  /** W12-A: admin token_loeschen / REST DELETE; setzt widerrufen_am (+ Grund), Identitaet bleibt. Idempotent. */
  loescheAusweis(project: string, identity_id: string, akteur: AusweisAkteur, grund: string): Promise<{ identity_id: string; token_id: string | null; geloescht: boolean }>;
  /**
   * W12-A: Daemon agent_start (akteur daemon) bzw. Koordinator-Respawn. Gueltiger Ausweis -> genau dieser
   * (neu:false). Keiner/verfallen -> verfallenen loeschen, neuen mit Erstnutzungsfrist (neu:true,
   * ausweis_weg 'daemon_start'). Legt NIE eine Identitaet an.
   */
  ausweisFuerStart(project: string, identity_id: string, akteur: AusweisAkteur): Promise<AusweisAbruf & { neu: boolean }>;
}

// ---- V5 Lauf-Zustellbuchhaltung + Uebernahme-Bruecke (W12-B) -----------------------------------
export type LaufBeginnArt = 'anmelden' | 'fortsetzung' | 'implizit' | 'uebernahme';

/** Legacy-Herkunft (Spalte agent_identitaet_laeufe.uebernommen_aus). */
export interface UebernahmeQuelle {
  agent_id: string;
  /** agent_sessions.sitzung_seit der Legacy-Sitzung als Text (wie Hinweis-Zustellungen), sonst null */
  sitzung: string | null;
  schattenprofil_id: string | null;
}

export interface LaufZustellstand {
  lauf_id: string;
  identity_id: string;
  context_epoch: number;
  beginn_art: LaufBeginnArt | null;
  zugestellt_profil_revision: number | null;
  zugestellt_regeln_stand: string | null;
  zugestellt_am: string | null;
  uebernommen_aus: UebernahmeQuelle | null;
}

/**
 * Uebernahme-Bruecke (einmalig je Identitaet+Ursprung, in EINER Transaktion, idempotent):
 *  (a) agent_onboardings (project, agent_id) -> agent_identitaet_onboardings (identity_id); dann
 *      zugestellt_regeln_stand = regelnStand(aktuelle Pflichtregeln), wenn die Legacy-Sitzung sie nachweislich
 *      erhalten hat (Onboarding-Zeile nach sitzung_seit), sonst NULL (-> voll);
 *  (b) ausloeser_hinweis_zustellungen der Legacy-Sitzung -> agent_identitaet_hinweis_zustellungen mit der
 *      Sitzungskennung der neuen Identitaets-Sitzung (nichts doppelt);
 *  (c) offene chat_messages an recipient_id = agent_id (recipient_identity_id NULL) -> recipient_identity_id;
 *  (d) specialist_channel_members des Namens -> agent_identitaet_channel_mitglieder (Lesemarken mit).
 * Events, Reservierungen, Waits, Shell-Jobs bleiben unveraendert (Namensbezug wie bisher).
 */
export interface UebernahmeErgebnis {
  lauf_id: string;
  quelle: UebernahmeQuelle;
  bereits_uebernommen: boolean;
  onboarding_zeilen: number;
  hinweis_zustellungen: number;
  nachrichten: number;
  channels: number;
}

export interface LaufDienst {
  /**
   * W12-B: im Token-Aufrufpfad (agent-token-tools.ts) nach erfolgreicher Pruefung. Aktiver Lauf vorhanden ->
   * dessen Stand. Sonst Lauf + Identitaets-Sitzung anlegen (beginn_art 'uebernahme' mit Bruecke bei Legacy-
   * Ursprung, sonst 'implizit'); behebt 'hinweis_identitaet_sitzung_fehlt' beim ersten Token-Aufruf.
   */
  sichereLauf(p: IdentitaetsAgentPrincipal): Promise<LaufZustellstand>;
  /** W12-B: siehe UebernahmeErgebnis. */
  uebernehmeLegacy(identity_id: string, quelle: UebernahmeQuelle, lauf_id: string): Promise<UebernahmeErgebnis>;
  /** W12-B */
  leseZustellstand(lauf_id: string): Promise<LaufZustellstand | null>;
  /** W12-B/C: Werte nur erhoehen bzw. setzen, nie zuruecknehmen; zugestellt_am = NOW(). */
  markiereZugestellt(lauf_id: string, stand: { profil_revision?: number; regeln_stand?: string }): Promise<void>;
}

/** Was eine Antwort an Regeln/Profil/Fortsetzung traegt. 'Bekanntes nicht erneut' (Zielbild 5, 7, 10). */
export interface ZustellUmfang {
  /** Pflichtregeln (Tag pflicht bzw. vollstaendig im Onboarding) im Volltext */
  pflichtregeln: 'voll' | 'keine';
  /** uebrige Regeln nur als regel_verzeichnis (Namen + Abrufaufruf) */
  regel_verzeichnis: boolean;
  /** kompakter Profilblock (ProfilBlock) */
  profilblock: boolean;
  /** fortsetzung (FortsetzungsInfo: Abrufwege, gebundene Tasks, Channels) */
  fortsetzung: boolean;
}

/**
 * Reine Lieferregel. anlass 'anmeldung' = neuer Lauf (anmelden, index_stats neu/fortsetzung): alles kompakt-
 * vollstaendig. 'folgeaufruf' = derselbe Lauf: nur, was in DIESEM Lauf noch nicht zugestellt wurde;
 * geaenderte Pflichtregeln erneut voll, Profilaenderungen ueber w1b.profil_update (nicht hier).
 */
export function zustellUmfang(
  stand: Pick<LaufZustellstand, 'zugestellt_profil_revision' | 'zugestellt_regeln_stand'> | null,
  aktuell: { regeln_stand: string },
  anlass: 'anmeldung' | 'folgeaufruf',
): ZustellUmfang {
  if (anlass === 'anmeldung' || !stand) {
    return { pflichtregeln: 'voll', regel_verzeichnis: true, profilblock: true, fortsetzung: true };
  }
  const regelnNeu = stand.zugestellt_regeln_stand === null;
  const regelnGeaendert = !regelnNeu && stand.zugestellt_regeln_stand !== aktuell.regeln_stand;
  return {
    pflichtregeln: regelnNeu || regelnGeaendert ? 'voll' : 'keine',
    regel_verzeichnis: regelnNeu,
    profilblock: stand.zugestellt_profil_revision === null,
    fortsetzung: false,
  };
}

/** Stand der Pflichtregeln: sha256 ueber sortierte 'name<TAB>aktualisiert' (Reihenfolge-unabhaengig). */
export function regelnStand(regeln: ReadonlyArray<{ name: string; aktualisiert?: string | Date | null }>): string {
  const zeilen = regeln.map(r => r.name + '\t' + (r.aktualisiert ? new Date(r.aktualisiert).toISOString() : '')).sort();
  return createHash('sha256').update(zeilen.join('\n')).digest('hex');
}

// ---- V6 Hinweisquellen ------------------------------------------------------------------------
export const HINWEIS_QUELLE_TOKEN_BEREIT = 'w1b.token_bereit';
export const HINWEIS_QUELLE_PROFIL_UPDATE = 'w1b.profil_update';
/** Pflicht: nicht ueber hinweise_aus/hinweise_nur (Profil, Kontextprofil) abschaltbar. */
export const W12_PFLICHT_HINWEISQUELLEN: readonly string[] = [HINWEIS_QUELLE_TOKEN_BEREIT, HINWEIS_QUELLE_PROFIL_UPDATE];

export function tokenBereitEntprellungMs(): number {
  const m = Number(process.env.SYNAPSE_W1B_TOKEN_HINWEIS_MS);
  return Number.isFinite(m) && m >= 0 ? m : 600_000;
}

export function tokenBereitText(token: string): string {
  return `Dein Agenten-Ausweis ist bereit: ${token}. Ab sofort bei JEDEM Synapse-Aufruf token:"${token}" mitgeben `
    + '(ersetzt agent_id, project und role). Neuer Kontext: chat(action:"anmelden", token:<Ausweis>), nie chat(register). '
    + 'Ausweis nie in Channel, Thought oder Log schreiben.';
}

export type ProfilDiffBereich =
  | 'regeln' | 'zuschnitt' | 'hinweise' | 'kontext' | 'typ' | 'rolle' | 'channels' | 'briefing'
  | 'arbeitsweise' | 'modell' | 'task_bindung' | 'sonstiges';
export type ProfilDiffArt = 'neu' | 'geaendert' | 'entfernt' | 'erlaubt' | 'gesperrt' | 'aktiviert' | 'deaktiviert';

export interface ProfilDiffEintrag {
  bereich: ProfilDiffBereich;
  art: ProfilDiffArt;
  /** Regelname, '<tool>' / '<tool>.<action>', Hinweisart, Task-Kurz-ID, Feldname ... */
  schluessel: string;
  /** optionaler fertiger Teiltext (ueberschreibt die Standardformulierung), z. B. 'Typ reviewer -> tester (Rev 3)' */
  text?: string;
}

export interface ProfilDiff {
  identity_id: string;
  /** null = keine bekannte Basis (dann kein Hinweis, sondern Profilblock) */
  von_revision: number | null;
  nach_revision: number;
  eintraege: ProfilDiffEintrag[];
}

const DIFF_BEREICH_TEXT: Record<ProfilDiffBereich, string> = {
  regeln: 'Regel', zuschnitt: 'Werkzeug', hinweise: 'Hinweis', kontext: 'Kontext', typ: 'Typ', rolle: 'Rolle',
  channels: 'Channel', briefing: 'Briefing', arbeitsweise: 'Arbeitsweise', modell: 'Modell', task_bindung: 'Task',
  sonstiges: 'Feld',
};
const DIFF_ART_TEXT: Record<ProfilDiffArt, string> = {
  neu: 'neu', geaendert: 'geaendert', entfernt: 'entfernt', erlaubt: 'erlaubt', gesperrt: 'gesperrt',
  aktiviert: 'aktiviert', deaktiviert: 'deaktiviert',
};

/** Verbindliches Format: 'Profil-Update (Revision a -> b): Regel X geaendert; Hinweis Y deaktiviert; Task Z neu.' */
export function formatiereProfilUpdate(d: ProfilDiff, maxZeichen = 600): string {
  const kopf = `Profil-Update (Revision ${d.von_revision ?? 0} -> ${d.nach_revision})`;
  if (d.eintraege.length === 0) return kopf + ': keine inhaltlichen Aenderungen.';
  const teile = d.eintraege.map(e => e.text ?? `${DIFF_BEREICH_TEXT[e.bereich]} ${e.schluessel} ${DIFF_ART_TEXT[e.art]}`);
  let text = kopf + ': ';
  let n = 0;
  for (const t of teile) {
    const naechstes = (n ? '; ' : '') + t;
    if (text.length + naechstes.length + 1 > maxZeichen && n > 0) break;
    text += naechstes;
    n++;
  }
  const rest = teile.length - n;
  return text + (rest > 0 ? `; +${rest} weitere (admin profil_historie)` : '') + '.';
}

// ---- W12-C: Profilblock, gebundene Tasks -----------------------------------------------------
export interface ProfilBlock {
  identity_id: string;
  agent_id: string;
  project: string;
  profil_revision: number;
  rolle: string;
  typ: { schluessel: string; revision: number } | null;
  /** Regelnamen; Volltext ueber memory(read). Pflichtregeln stehen voll im Onboarding. */
  regeln: string[];
  werkzeuge: { standard: ZugriffsRegel | null; gesperrt: string[]; erlaubt: string[]; schreiben: boolean | null } | null;
  kontext: { stufe: KontextStufe | null; budget: number | null };
  hinweise_aus: string[];
  channels: string[];
  /** gekuerzt auf hoechstens 500 Zeichen */
  briefing: string | null;
}

export interface GebundeneTask {
  task_id: string;
  kurz_id: string | null;
  titel: string | null;
  status: string | null;
  art: 'identitaet' | 'team';
}

export interface ProfilUpdateDienst {
  /** W12-C: Diff zweier Revisionen (agent_profil_revisionen) + Task-Bindungen seit 'seit'. */
  berechneDiff(identity_id: string, von_revision: number | null, nach_revision: number, seit: string | null): Promise<ProfilDiff>;
  /** W12-C: aus leseWirksamesProfil, kompakt. */
  profilBlock(identity_id: string): Promise<ProfilBlock>;
  /** W12-C: plan_task_bindungen mit identity_id (art identitaet oder Team-Mitglied). */
  gebundeneTasks(project: string, identity_id: string): Promise<GebundeneTask[]>;
}

// ---- W12-D: verbindliche Texte (nur Texte, keine Logik) --------------------------------------
export const TEXT_AGENT_TOKEN_FEHLT = 'agent_token_fehlt: Dieser Agent hat einen Agenten-Ausweis. Gib ihn bei jedem Aufruf als '
  + 'token mit; neuer Kontext: chat(action:"anmelden", token:<Ausweis>). Ausweis verloren: Koordinator/User ruft ihn mit '
  + 'admin(action:"token_abrufen", project, ziel_identity_id, anlass) ab.';
export const TEXT_NEUINSTANZ = 'Neuinstanz/Neustart/Modellwechsel mit Ausweis: chat(action:"anmelden", token:<Ausweis>), nie chat(register).';
/** Konkreter Aufruf im Koordinator-Hinweis 'Schattenprofil wartet' (ersetzt SCHATTEN_ABRUF_TEXT). */
export function schattenBestaetigenAufruf(project: string, schattenprofil_id: string, revision: number): string {
  return `admin(action:"schattenprofil_bestaetigen", project:"${project}", schattenprofil_id:"${schattenprofil_id}", `
    + `erwartete_revision:${revision}, user_zustimmung:"<Nachweis>", grund:"<Grund>")`;
}
export const TEXT_AGENT_VORBEREITEN_AUFRUF = 'admin(action:"agent_vorbereiten", project, agent_name, rolle?, typ_id?, profil_patch?, grund)';

// ---- Stub-Registry W12: Pakete ersetzen ihre Zeile durch lazy Delegation (Muster W1B_DIENSTE) ---------
function stub12(paket: W12Paket, funktion: string): (..._a: unknown[]) => Promise<never> {
  return async () => { throw new W12NichtUmgesetzt(paket, funktion); };
}

export interface W12Dienste {
  ausweis: AusweisDienst;
  lauf: LaufDienst;
  profilUpdate: ProfilUpdateDienst;
}

export const W12_DIENSTE: W12Dienste = {
  ausweis: {
    // W12-A (P22-T24): lazy, weil agent-ausweis-dienst.ts diese Datei zurueckimportiert.
    agentVorbereiten: async (e, a) => (await import('./agent-ausweis-dienst.js')).agentVorbereiten(e, a),
    rufeAusweisAb: (p, i, a, an) => rufeAusweisAb(p, i, a, an),
    loescheAusweis: (p, i, a, g) => loescheAusweis(p, i, a, g),
    ausweisFuerStart: async (p, i, a) => (await import('./agent-ausweis-dienst.js')).ausweisFuerStart(p, i, a),
  },
  lauf: {
    // W12-B (P22-T25): lazy, weil agent-lauf.ts diese Datei zurueckimportiert.
    sichereLauf: async (p) => (await import('./agent-lauf.js')).LAUF_DIENST.sichereLauf(p),
    uebernehmeLegacy: async (i, q, l) => (await import('./agent-lauf.js')).LAUF_DIENST.uebernehmeLegacy(i, q, l),
    leseZustellstand: async (l) => (await import('./agent-lauf.js')).LAUF_DIENST.leseZustellstand(l),
    markiereZugestellt: async (l, s) => (await import('./agent-lauf.js')).LAUF_DIENST.markiereZugestellt(l, s),
  },
  profilUpdate: {
    berechneDiff: async (i, v, n, s) => (await import('./agent-profil-update.js')).berechneDiff(i, v, n, s),
    profilBlock: async (i) => (await import('./agent-profil-update.js')).profilBlock(i),
    gebundeneTasks: async (pr, i) => (await import('./agent-profil-update.js')).gebundeneTasks(pr, i),
  },
};
