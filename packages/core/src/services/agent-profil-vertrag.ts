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
import { aktuellerAgentPrincipal } from './agent-bezug.js';
import { getPool } from '../db/client.js';
import { leseProfilProduktSchalter } from './agent-profil-schalter.js';
// Paket D: Persona-/Tokenabruf-Dienste sind im Eintrag lazy verdrahtet (W1B_DIENSTE), weil sie diese Datei zurueckimportieren.
import { personaDienst } from './agent-persona.js';
import { tokenAbrufDienst } from './agent-token-abruf.js';

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
  listeSchattenprofile(project: string, akteur: W1bAkteur, filter?: { zustand?: SchattenZustand }): Promise<Schattenprofil[]>;
  /** A: Korrekturentwurf mit CAS auf revision */
  korrigiereSchattenprofil(id: string, erwartete_revision: number, korrektur: Partial<ProfilInhalt>, akteur: W1bAkteur, grund: string): Promise<Schattenprofil>;
  /** A: atomar Identitaet + Profilrevision 1 + Tokenaktivierung + Audit; Doppelbestaetigung idempotent */
  bestaetigeSchattenprofil(b: SchattenBestaetigung, akteur: W1bAkteur): Promise<{ schattenprofil: Schattenprofil; identity_id: string; profil_revision: number }>;
  /** A */
  lehneSchattenprofilAb(id: string, erwartete_revision: number, akteur: W1bAkteur, grund: string): Promise<Schattenprofil>;
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
  akteur: W1bAkteur, ziel: { identity_id: string; project: string }, opt: { ersterKoordinatorStart?: boolean } = {},
): boolean {
  if (akteur.art === 'user') return true;
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
export function darfTaskBindungVerwalten(akteur: W1bAkteur, project: string): boolean {
  if (akteur.art === 'user') return true;
  return akteur.art === 'identitaet' && akteur.principal.rolle === 'koordinator' && akteur.principal.project === project;
}

function akteurKennung(akteur: W1bAkteur): { wer: string; identity: string | null } {
  if (akteur.art === 'user') return { wer: 'user', identity: null };
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
  alt: TaskBindung | null, neu: TaskBindung | null, wer: string, identity: string | null, grund: string | null,
): Promise<void> {
  await c.query(
    `INSERT INTO plan_task_bindung_audit(project,task_id,aktion,alt,neu,wer,actor_identity_id,grund)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [project, task_id, aktion, alt ? JSON.stringify(alt) : null, neu ? JSON.stringify(neu) : null, wer, identity, grund]);
}

/** festlegen / aendern / entblocken: Schalter, Recht, Pflicht-Grund, Mitglieder, Sperre + Audit in EINER Transaktion. */
async function verwalteBindung(
  project: string, task_id: string, akteur: W1bAkteur, aktion: TaskBindungsAktion,
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

/** update_task-Gate (Paket T): bei Schalter EIN darf nur Koordinator/User bzw. Mitglied der Bindung bearbeiten. Ohne Principal (User-Pfade) unveraendert. */
export async function pruefeTaskBindungBearbeitenFuer(project: string, task_id: string, p: IdentitaetsAgentPrincipal | null, ref: string = task_id): Promise<string | null> {
  if (!(await leseProfilProduktSchalter('task_bindung', project)).aktiv) return null;
  if (!p) return null;
  if (p.project === project && p.rolle === 'koordinator') return null;
  return bindungsSperre(project, task_id, p.project === project ? p.identity_id : null, ref);
}

/** Wie pruefeTaskBindungBearbeitenFuer, Akteur aus dem aktuellen Tokenkontext. */
export async function pruefeTaskBindungBearbeiten(project: string, task_id: string, ref: string = task_id): Promise<string | null> {
  const p = aktuellerAgentPrincipal();
  return pruefeTaskBindungBearbeitenFuer(project, task_id, p && p.art === 'identity' ? p : null, ref);
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
