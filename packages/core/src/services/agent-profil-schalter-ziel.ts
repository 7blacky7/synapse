/**
 * P22-T287 S1 (User 08.11.2026, Festlegung thought fa7c00cf, Korrektur 27f9c071, Konzept ebe24645): Produkt-Schalter je Agent.
 *
 * EBENEN: Sie liegen UEBER der bestehenden Aufloesung in agent-profil-schalter.ts:leseProfilProduktSchalter (keine zweite
 *   Schalterlogik). Rang: identitaet (Ausweis, identity_id) bzw. agent (Agent nach alter Methode ohne Ausweis: agent_id oder
 *   Namensmuster wie luna-*) > typ (agent_typen.id der Identitaet) > projekt > global > Standard.
 *   Innerhalb der Agent-Ebenen: identitaet > agent exakt > agent Muster (laengster fester Anteil zuerst) > typ.
 *   Pruefer-Entscheidung 9ff7ab0f P4: die agent-Ebene (Name/Muster) gilt NUR fuer Legacy-Principals ohne Ausweis; fuer
 *   Ausweis-Identitaeten gelten identitaet und typ (leseZielTreffer ignoriert agent_id, sobald identity_id gesetzt ist).
 *   Nur fuer Funktionen der Positivliste ZIEL_FAEHIGE_FUNKTIONEN; 'alle' gibt es auf diesen Ebenen nicht.
 * ZIEL (S3, Fremd-Empfaenger-Regel): NUR ausdruecklich. undefined/null = ohne Agent-Ebenen (Projektsicht). Eine Lesestelle, die fuer
 *   den aufrufenden Agenten entscheidet, uebergibt zielDesAufrufers(project) (Ausweis -> {identity_id}, Legacy -> {agent_id}, nur im
 *   Projekt des Aufrufs); eine Lesestelle fuer einen anderen Agenten uebergibt dessen Ziel. Ohne ausdrueckliches Ziel greift nie eine
 *   Agent-Regel - so kann keine Regel des Absenders fuer einen Empfaenger gelten.
 * SPEICHER: agent_profil_schalter_ziel (Schema 182, additiv; agent_profil_schalter bleibt unveraendert), Verlauf
 *   agent_profil_schalter_ziel_verlauf, bei ebene identitaet zusaetzlich agent_identitaet_audit (Verlauf des Ausweises).
 *   Jede Zeile traegt herkunft (user | ausweis | legacy_koordinator | ohne_ausweis) und setter_agent_id.
 * RECHTE: dieselbe Pruefung wie die Profilverwaltung (agent-profil-verwalter.ts:pruefeProfilVerwalter): User; Main nur mit
 *   Agenten-Verwaltung des Projekts; Koordinator des Projekts mit Ausweis oder Legacy ohne Ausweis; Koordinator eines anderen
 *   Projekts nur ueber koordinator_projektverwaltung. Agenten MIT Ausweis (ausser Koordinator/Main) nie.
 *   Pruefer-Entscheidung 9ff7ab0f P2: Main darf setzen, Voraussetzung bleibt main_verwaltung (Agenten-Verwaltung des Zielprojekts,
 *   Schalter main_agentenverwaltung), konsistent zu profil_aendern und zur Main-Sonderstellung.
 * AUFLAGE 9ff7ab0f P3: schalter_identitaet bleibt bis S3 ueberall AUS (Fremd-Empfaenger: Lesestellen wie mod_inbox, inbox_quittung,
 *   ausweis_channels, startkontext, verlauf_uebergabe entscheiden teils fuer einen anderen Agenten als den Aufrufer). S3 prueft jede
 *   Lesestelle der Positivliste und reicht ziel ausdruecklich bzw. null durch.
 * AUFRAEUMEN (9ff7ab0f P6): agent-entfernung.ts:fuehreEntfernungAus loescht beim Archivieren eines Agenten dessen eigene Regeln
 *   (identitaet: identity_id, Legacy: exakter Name; Muster bleiben) ueber raeumeZielRegelnAuf, mit Verlaufszeile herkunft 'aufraeumen'.
 *   Pruefer 70f43eaf H1: Wiederherstellen (agent-entfernung.ts stelleEntfernteWiederHer) holt diese Regeln NICHT zurueck; sie stehen
 *   im Verlauf (agent_profil_schalter_ziel_verlauf) und werden bei Bedarf neu gesetzt.
 *   User-Korrektur 27f9c071: Agenten nach alter Methode OHNE Ausweis (identifiziert ueber den Namen, wie bisher) duerfen Regeln der
 *   Ebene agent setzen (Koordinator-Entscheidung: nur Name/Muster; identitaet und typ bleiben bei User, Main und Koordinator).
 *   Eigener Produkt-Schalter schalter_setzen_ohne_ausweis nach der Regel "neue Funktion = Schalter, Standard AUS" (nur
 *   ausdruecklich); nur im Projekt der Anfrage (kein Ausweis/Visum im Aufruf, Legacy-Kontext im selben Projekt); Grund Pflicht
 *   (min. 10 Zeichen); ein Name, der einer Ausweis-Identitaet gehoert, wird mit deren Ausweis gesetzt (ausweis_erforderlich);
 *   Audit mit agent_id und herkunft 'ohne_ausweis' (gesetzt_von 'ohne_ausweis:<agent_id>').
 * SCHALTER: Produkt-Schalter schalter_identitaet (projekt/global, Standard AUS, nur ausdruecklich). AUS: Zielzeilen werden beim
 *   Lesen ignoriert (= heutiges Verhalten) und Setzen antwortet funktion_aus. Lesefehler -> projekt/global wie bisher + ziel_fehler.
 * WIRKUNG: gepuffert je Prozess wie der Ausweis-Kern (kernTtlMs, Schluessel mit Ziel). Schreiben leert den Puffer im schreibenden
 *   Prozess sofort, andere Prozesse sehen es nach ihrer TTL (Standard 5 s).
 * DEBUG: ProfilProduktSchalterStand.ziel_ebene identitaet|agent|typ, ziel, ziel_muster (ebene bleibt 'projekt', Vertrag der
 *   Verbraucher unveraendert); gesetzt_von nennt den Setzenden; Lesefehler im Feld ziel_fehler.
 */
import { getPool } from '../db/client.js';
import type { AusweisAkteur } from './agent-profil-vertrag.js';

/** Produkt-Schalter der Mechanik selbst (regel-neue-funktionen-mit-schalter-und-debug). */
export const SCHALTER_ZIEL_FUNKTION = 'schalter_identitaet' as const;
/** User-Korrektur 27f9c071: Setzen durch Agenten ohne Ausweis (Standard AUS, nur ausdruecklich). */
export const SCHALTER_OHNE_AUSWEIS_FUNKTION = 'schalter_setzen_ohne_ausweis' as const;
/** Mindestlaenge des Grundes auf dem Weg ohne Ausweis (sonst 5 wie bei allen Produkt-Schaltern). */
export const OHNE_AUSWEIS_GRUND_MIN = 10;
export const SCHALTER_ZIEL_EBENEN = ['identitaet', 'agent', 'typ'] as const;
export type SchalterZielEbene = typeof SCHALTER_ZIEL_EBENEN[number];

/**
 * Positivliste: nur Schalter, die Kontext, Antworten oder Verhalten EINES Agenten betreffen (Konzept ebe24645 Abschnitt 3).
 * Web-UI-, Reverse-, Asset- und Systemschalter bleiben global/projekt.
 */
export const ZIEL_FAEHIGE_FUNKTIONEN: readonly string[] = [
  // S3: nur Funktionen, deren Lesestellen das Ziel ausdruecklich uebergeben (geprueft, Fremd-Empfaenger-Regel):
  //   fall-skills.ts leseFallSkillSchalter (schlank/hinweis/fremd: eigene Antwort und Hinweise des Aufrufers),
  //   task-pins.ts leseTaskPinsSchalter (Pins in plan get/anmelden des Aufrufers), speicher-aehnlichkeit.ts (Speichern des Aufrufers),
  //   zwangs-pin.ts ermittleBefund/quittiereZwangsPinLesen (Ziel = aufrufer der Sperre), agent-token-tools.ts (profil_antwortanpassung).
  'tool_antworten_schlank', 'fall_skill_hinweis', 'shell_fremde_ergebnisse', 'task_pins', 'zwangs_pin',
  'speicher_aehnlichkeit', 'speicher_aehnlichkeit_pruefen', 'profil_antwortanpassung',
  // S3 GESTRICHEN (bis eine Lesestelle je Agent existiert): tool_beschreibungen_kurz/tool_liste_je_verbindung (tools/list je Verbindung),
  //   tool_antwort_ueberlauf/artefakt_dateien (Transport), shell_ausgabe_voll (liest auch fuer fremde Jobs), coedit_ohne_gate/
  //   anker_umrechnung (planuebergreifend zwischen Beitragenden), startkontext/runtime_tool_ausgabe/verlauf_* (global gelesen, ohne
  //   Projekt/Identitaet: leseMainSchalter bzw. Runtime-Ueberwachung), inbox_quittung/mod_inbox/ausweis_channels (Empfaenger !=
  //   Aufrufer), warteschlangen_stau (Waechter global). Kandidaten fuer S4 (Einstellwerte/Hintergrundpfade mit ausdruecklichem Ziel).
];

export function istZielFaehig(funktion: string): boolean { return ZIEL_FAEHIGE_FUNKTIONEN.includes(funktion); }
export function istSchalterZielEbene(v: unknown): v is SchalterZielEbene {
  return typeof v === 'string' && (SCHALTER_ZIEL_EBENEN as readonly string[]).includes(v);
}

/** Agent, fuer den gelesen wird. identity_id: Ausweis (identitaet + typ); agent_id: Name ohne Ausweis (agent exakt/Muster, nur ohne identity_id). */
export interface SchalterZiel { identity_id?: string | null; agent_id?: string | null }

export interface SchalterZielTreffer {
  ebene: SchalterZielEbene; ziel: string; muster: boolean; aktiv: boolean; grund: string | null; gesetzt_von: string; gesetzt_am: string;
}

export interface SchalterZielZeile {
  ebene: SchalterZielEbene; ziel: string; aktiv: boolean; grund: string | null; gesetzt_von: string; gesetzt_am: Date | string;
}

/** Namensmuster wie in ausloeser-hinweise.ts ('*' = beliebig viele Zeichen), sonst exakt. */
export function agentMusterPasst(muster: string, agent: string): boolean {
  if (!muster.includes('*')) return muster === agent;
  return new RegExp('^' + muster.split('*').map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(agent);
}

function rang(z: Pick<SchalterZielZeile, 'ebene' | 'ziel'>, agent: string | null): number {
  if (z.ebene === 'identitaet') return 3_000_000;
  if (z.ebene === 'agent') {
    if (!agent || !agentMusterPasst(z.ziel, agent)) return -1;
    return z.ziel.includes('*') ? 1_000_000 + z.ziel.replace(/\*/g, '').length : 2_000_000;
  }
  return 1;
}

/** Rein (Tests): waehlt die wirksame Zielzeile; die SQL-Abfrage liefert nur identitaet/typ dieses Agenten und alle agent-Zeilen. */
export function waehleZielTreffer(zeilen: readonly SchalterZielZeile[], agent: string | null): SchalterZielTreffer | null {
  let best: SchalterZielZeile | null = null;
  let bestRang = -1;
  for (const z of zeilen) {
    const r = rang(z, agent);
    if (r < 0) continue;
    if (r > bestRang || (r === bestRang && best && z.ziel < best.ziel)) { best = z; bestRang = r; }
  }
  if (!best) return null;
  const am = best.gesetzt_am instanceof Date ? best.gesetzt_am.toISOString() : String(best.gesetzt_am);
  return { ebene: best.ebene, ziel: best.ziel, muster: best.ebene === 'agent' && best.ziel.includes('*'), aktiv: best.aktiv,
    grund: best.grund, gesetzt_von: best.gesetzt_von, gesetzt_am: am };
}

/** Ziel aus dem Aufrufkontext; nur wenn der Aufruf im selben Projekt laeuft (fremde Empfaenger bleiben unberuehrt). */
export async function zielAusAufruf(project: string): Promise<SchalterZiel | null> {
  const { aktuellerAgentAufruf } = await import('./agent-bezug.js');
  const p = aktuellerAgentAufruf()?.principal;
  if (!p || p.project !== project) return null;
  // P4 (9ff7ab0f): Ausweis-Identitaeten nur ueber identity_id (identitaet/typ), die agent-Ebene gilt nur ohne Ausweis.
  return p.art === 'identity' ? { identity_id: p.identity_id } : { agent_id: p.agent_id };
}

/** P22-T287 S3: Ziel des aufrufenden Agenten fuer Lesestellen, die fuer GENAU ihn entscheiden (Fremd-Empfaenger-Regel). */
export const zielDesAufrufers = zielAusAufruf;

/** P22-T287 S3 (P5): Messung der Zielstufe je Prozess (Zielabfragen an PG, Treffer, Dauer). */
const ZIEL_ZAEHLER = { abfragen: 0, treffer: 0, ms: 0 };
export function schalterZielDiagnose(): { abfragen: number; treffer: number; ms: number } { return { ...ZIEL_ZAEHLER }; }
export function leereSchalterZielDiagnose(): void { ZIEL_ZAEHLER.abfragen = 0; ZIEL_ZAEHLER.treffer = 0; ZIEL_ZAEHLER.ms = 0; }

/** P22-T287 S3: Debug-Quelle je Aufruf - nur Treffer einer Zielregel, am Aufrufkontext gesammelt (Antwortfeld schalter_quelle). */
export interface SchalterQuelle { funktion: string; aktiv: boolean; ziel_ebene: SchalterZielEbene; ziel: string }
const QUELLEN = new WeakMap<object, Map<string, SchalterQuelle>>();
export async function merkeSchalterQuelle(funktion: string, _project: string, t: SchalterZielTreffer): Promise<void> {
  const { aktuellerAgentAufruf } = await import('./agent-bezug.js');
  const k = aktuellerAgentAufruf();
  if (!k) return;
  let m = QUELLEN.get(k);
  if (!m) { m = new Map(); QUELLEN.set(k, m); }
  m.set(funktion, { funktion, aktiv: t.aktiv, ziel_ebene: t.ebene, ziel: t.ziel });
}
export async function schalterQuelleDesAufrufs(): Promise<SchalterQuelle[]> {
  const { aktuellerAgentAufruf } = await import('./agent-bezug.js');
  const k = aktuellerAgentAufruf();
  const m = k ? QUELLEN.get(k) : undefined;
  return m ? [...m.values()] : [];
}

/** EINE Abfrage je Funktion/Projekt/Ziel (Typ ueber agent_identitaeten.typ_id). Wirft bei Lesefehlern (Aufrufer faengt ab). */
export async function leseZielTreffer(funktion: string, project: string, ziel: SchalterZiel): Promise<SchalterZielTreffer | null> {
  const id = typeof ziel.identity_id === 'string' && ziel.identity_id.trim() ? ziel.identity_id.trim() : null;
  // P4 (9ff7ab0f): mit identity_id keine agent-Ebene (auch wenn agent_id mitkommt).
  const agent = !id && typeof ziel.agent_id === 'string' && ziel.agent_id.trim() ? ziel.agent_id.trim() : null;
  if (!id && !agent) return null;
  ZIEL_ZAEHLER.abfragen++;
  const t0 = Date.now();
  const r = await getPool().query<SchalterZielZeile>({
    text: `SELECT ebene, ziel, aktiv, grund, gesetzt_von, gesetzt_am FROM agent_profil_schalter_ziel
      WHERE funktion = $1 AND project = $2 AND ((ebene = 'identitaet' AND ziel = $3) OR (ebene = 'agent' AND $3::text IS NULL)
        OR (ebene = 'typ' AND ziel = (SELECT typ_id FROM agent_identitaeten WHERE id = $3)))`,
    values: [funktion, project, id],
    query_timeout: 2000,
  } as import('pg').QueryConfig & { query_timeout: number });
  ZIEL_ZAEHLER.ms += Date.now() - t0;
  const t = waehleZielTreffer(r.rows, agent);
  if (t) ZIEL_ZAEHLER.treffer++;
  return t;
}

export interface ZielSchalterRegel {
  ebene: SchalterZielEbene; ziel: string; funktion: string; aktiv: boolean; grund: string | null; gesetzt_von: string; gesetzt_am: string;
  herkunft: string | null; setter_agent_id: string | null;
}

/** Debug/Verwaltung: gesetzte Zielregeln des Projekts (optional je Ebene/Ziel) samt Herkunft des Setzenden. */
export async function listeZielSchalter(project: string, f: { ebene?: SchalterZielEbene; ziel?: string } = {}): Promise<ZielSchalterRegel[]> {
  const r = await getPool().query<SchalterZielZeile & { funktion: string; herkunft: string | null; setter_agent_id: string | null }>(
    `SELECT ebene, ziel, funktion, aktiv, grund, gesetzt_von, gesetzt_am, herkunft, setter_agent_id FROM agent_profil_schalter_ziel
      WHERE project = $1 AND ($2::text IS NULL OR ebene = $2) AND ($3::text IS NULL OR ziel = $3)
      ORDER BY ebene, ziel, funktion LIMIT 500`, [project, f.ebene ?? null, f.ziel ?? null]);
  return r.rows.map((z) => ({ ebene: z.ebene, ziel: z.ziel, funktion: z.funktion, aktiv: z.aktiv, grund: z.grund, gesetzt_von: z.gesetzt_von,
    gesetzt_am: z.gesetzt_am instanceof Date ? z.gesetzt_am.toISOString() : String(z.gesetzt_am), herkunft: z.herkunft ?? null,
    setter_agent_id: z.setter_agent_id ?? null }));
}

export class SchalterZielFehler extends Error {
  constructor(public readonly code: string, public readonly details?: Record<string, unknown>) { super(code); }
}

/** Wer setzt: Akteur der Profilverwaltung oder (User-Korrektur 27f9c071) ein Agent nach alter Methode ohne Ausweis. */
export type ZielSetzer = AusweisAkteur | { art: 'ohne_ausweis'; agent_id: string };
export type ZielSetzerHerkunft = 'user' | 'ausweis' | 'legacy_koordinator' | 'ohne_ausweis';

export interface ZielSchalterEingabe {
  ebene: string; project: string; ziel: string | undefined; funktion: string;
  /** null = Regel entfernen (wieder erben) */
  aktiv: boolean | null;
  grund: string;
}
export interface ZielSchalterAenderung {
  ebene: SchalterZielEbene; project: string; ziel: string; funktion: string; alt: boolean | null; neu: boolean | null; wer: string; geaendert: boolean;
  herkunft: ZielSetzerHerkunft; setter_agent_id: string | null;
}

interface Setzer { wer: string; actor_identity_id: string | null; herkunft: ZielSetzerHerkunft; setter_agent_id: string | null }

/** Namen/Muster der Agent-Ebene; reines '*' waere die Projektebene und ist nicht erlaubt. */
const AGENT_MUSTER = /^[A-Za-z0-9*][A-Za-z0-9._:@*-]{0,127}$/;

function text(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

/** Keine zweite Rechtelogik: dieselbe Pruefung wie profil_aendern (User, Main mit Verwaltung, Koordinator mit/ohne Ausweis). */
async function pruefeVerwalter(akteur: AusweisAkteur, project: string): Promise<Setzer> {
  const { pruefeProfilVerwalter } = await import('./agent-profil-verwalter.js');
  try {
    const v = await pruefeProfilVerwalter(akteur, project);
    return { ...v,
      herkunft: akteur.art === 'user' ? 'user' : akteur.art === 'legacy_koordinator' ? 'legacy_koordinator' : 'ausweis',
      setter_agent_id: akteur.art === 'legacy_koordinator' ? akteur.agent_id : akteur.art === 'identitaet' ? akteur.principal.agent_id : null };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    throw new SchalterZielFehler(typeof code === 'string' ? code : 'recht_fehlt');
  }
}

/**
 * User-Korrektur 27f9c071: Agent nach alter Methode ohne Ausweis (Name wie bisher). Nur ebene agent (Koordinator-Entscheidung),
 * Schalter schalter_setzen_ohne_ausweis, nur das Projekt der Anfrage (kein Ausweis/Visum im Aufruf, Legacy-Kontext mit demselben
 * Namen und Projekt), Name gehoert keiner Ausweis-Identitaet, Grund mindestens OHNE_AUSWEIS_GRUND_MIN Zeichen.
 */
async function pruefeOhneAusweis(agentRoh: string, project: string, grund: string, ebene: SchalterZielEbene): Promise<Setzer> {
  if (ebene !== 'agent') {
    throw new SchalterZielFehler('nur_ebene_agent', { weg: 'ohne_ausweis',
      hinweis: 'Ohne Ausweis nur Regeln der Ebene agent (Name/Muster); identitaet und typ setzen User, Main oder Koordinator.' });
  }
  const agent = text(agentRoh);
  if (!agent) throw new SchalterZielFehler('recht_fehlt', { weg: 'ohne_ausweis', grund: 'agent_id fehlt' });
  const { aktuellerAgentAufruf } = await import('./agent-bezug.js');
  const k = aktuellerAgentAufruf();
  const p = k?.principal ?? null;
  if (p?.art === 'identity' || k?.fremdprojekt || (p?.art === 'legacy' && (p.project !== project || p.agent_id !== agent))) {
    throw new SchalterZielFehler('recht_fehlt', { weg: 'ohne_ausweis', grund: 'nur ohne Ausweis und nur im eigenen Projekt der Anfrage' });
  }
  const { leseProfilProduktSchalter } = await import('./agent-profil-schalter.js');
  const sch = await leseProfilProduktSchalter(SCHALTER_OHNE_AUSWEIS_FUNKTION, project, null);
  if (!sch.aktiv) {
    throw new SchalterZielFehler('funktion_aus', { funktion: SCHALTER_OHNE_AUSWEIS_FUNKTION, quelle: sch.quelle,
      hinweis: 'Setzen ohne Ausweis ist im Projekt AUS (Standard). Einschalten nur durch User/Koordinator: admin(profil_schalter_setzen, profil_funktion:"schalter_setzen_ohne_ausweis", aktiv:true, grund).' });
  }
  if (grund.length < OHNE_AUSWEIS_GRUND_MIN) throw new SchalterZielFehler('grund_fehlt', { weg: 'ohne_ausweis', min_zeichen: OHNE_AUSWEIS_GRUND_MIN });
  const r = await getPool().query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 LIMIT 1', [project, agent]);
  if (r.rows[0]) {
    throw new SchalterZielFehler('ausweis_erforderlich', { agent_id: agent, hinweis: 'Der Name gehoert einer Ausweis-Identitaet: mit agent_kennung aufrufen (dann gilt deren Rolle).' });
  }
  return { wer: 'ohne_ausweis:' + agent, actor_identity_id: null, herkunft: 'ohne_ausweis', setter_agent_id: agent };
}

/**
 * Setzt (aktiv true/false) oder entfernt (aktiv null) eine Regel auf Ebene identitaet|agent|typ. Rechte wie die Profilverwaltung bzw.
 * Weg ohne Ausweis (siehe Kopf); Mechanik-Schalter schalter_identitaet muss im Projekt EIN sein.
 * Audit: Zeile + Verlauf mit herkunft/setter_agent_id (+ agent_identitaet_audit bei identitaet).
 */
export async function setzeZielSchalter(e: ZielSchalterEingabe, akteur: ZielSetzer | null): Promise<ZielSchalterAenderung> {
  if (!istSchalterZielEbene(e.ebene)) throw new SchalterZielFehler('ziel_ebene_ungueltig', { erlaubt: [...SCHALTER_ZIEL_EBENEN] });
  const ebene = e.ebene;
  const project = text(e.project);
  if (!project) throw new SchalterZielFehler('project_fehlt');
  if (e.funktion === 'alle') throw new SchalterZielFehler('alle_nicht_je_ziel');
  if (!istZielFaehig(e.funktion)) throw new SchalterZielFehler('funktion_nicht_je_ziel', { funktion: e.funktion, erlaubt: [...ZIEL_FAEHIGE_FUNKTIONEN] });
  const grund = text(e.grund);
  if (grund.length < 5) throw new SchalterZielFehler('grund_fehlt');
  if (e.aktiv !== null && typeof e.aktiv !== 'boolean') throw new SchalterZielFehler('aktiv_fehlt');
  const ziel = text(e.ziel);
  if (!ziel) throw new SchalterZielFehler('ziel_fehlt', { ebene, parameter: ebene === 'identitaet' ? 'ziel_identity_id' : ebene === 'typ' ? 'typ_id' : 'ziel' });
  if (!akteur) throw new SchalterZielFehler('recht_fehlt');
  const v = akteur.art === 'ohne_ausweis' ? await pruefeOhneAusweis(akteur.agent_id, project, grund, ebene) : await pruefeVerwalter(akteur, project);
  const S = await import('./agent-profil-schalter.js');
  const mech = await S.leseProfilProduktSchalter(SCHALTER_ZIEL_FUNKTION, project, null);
  if (!mech.aktiv) {
    throw new SchalterZielFehler('funktion_aus', { funktion: SCHALTER_ZIEL_FUNKTION, quelle: mech.quelle, ...(mech.letzter_fehler ? { letzter_fehler: mech.letzter_fehler } : {}),
      hinweis: 'Produkt-Schalter schalter_identitaet ist im Projekt AUS (Standard). Einschalten: admin(profil_schalter_setzen, profil_funktion:"schalter_identitaet", aktiv:true, grund).' });
  }
  const pool = getPool();
  if (ebene === 'identitaet') {
    const r = await pool.query('SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2', [ziel, project]);
    if (!r.rows[0]) throw new SchalterZielFehler('identitaet_unbekannt', { ziel_identity_id: ziel });
  } else if (ebene === 'typ') {
    const r = await pool.query("SELECT 1 FROM agent_typen WHERE id=$1 AND status='aktiv' AND (scope='global' OR project=$2)", [ziel, project]);
    if (!r.rows[0]) throw new SchalterZielFehler('typ_unbekannt', { typ_id: ziel });
  } else if (!AGENT_MUSTER.test(ziel) || !ziel.replace(/\*/g, '')) {
    throw new SchalterZielFehler('ziel_ungueltig', { ziel, erwartet: 'agent_id oder Namensmuster wie luna-* (nicht nur *)' });
  }
  const c = await pool.connect();
  let alt: boolean | null = null;
  let geaendert = false;
  try {
    await c.query('BEGIN');
    const a = await c.query<{ aktiv: boolean }>(
      'SELECT aktiv FROM agent_profil_schalter_ziel WHERE ebene=$1 AND project=$2 AND ziel=$3 AND funktion=$4 FOR UPDATE', [ebene, project, ziel, e.funktion]);
    alt = a.rows[0]?.aktiv ?? null;
    if (e.aktiv === null) {
      if (a.rows[0]) {
        await c.query('DELETE FROM agent_profil_schalter_ziel WHERE ebene=$1 AND project=$2 AND ziel=$3 AND funktion=$4', [ebene, project, ziel, e.funktion]);
        geaendert = true;
      }
    } else {
      await c.query(
        `INSERT INTO agent_profil_schalter_ziel (ebene, project, ziel, funktion, aktiv, grund, gesetzt_von, setter_identity_id, herkunft, setter_agent_id, gesetzt_am)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (ebene, project, ziel, funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv, grund=EXCLUDED.grund,
           gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=EXCLUDED.setter_identity_id, herkunft=EXCLUDED.herkunft,
           setter_agent_id=EXCLUDED.setter_agent_id, gesetzt_am=EXCLUDED.gesetzt_am`,
        [ebene, project, ziel, e.funktion, e.aktiv, grund, v.wer, v.actor_identity_id, v.herkunft, v.setter_agent_id]);
      geaendert = true;
    }
    if (geaendert) {
      await c.query(
        `INSERT INTO agent_profil_schalter_ziel_verlauf (ebene, project, ziel, funktion, alt, neu, grund, gesetzt_von, setter_identity_id, herkunft, setter_agent_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [ebene, project, ziel, e.funktion, alt, e.aktiv, grund, v.wer, v.actor_identity_id, v.herkunft, v.setter_agent_id]);
      if (ebene === 'identitaet') {
        await c.query(
          'INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [ziel, v.wer, e.aktiv === null ? 'schalter_entfernt' : 'schalter_gesetzt', JSON.stringify({ funktion: e.funktion, aktiv: alt }),
            JSON.stringify({ funktion: e.funktion, aktiv: e.aktiv, herkunft: v.herkunft, setter_agent_id: v.setter_agent_id }), grund, v.actor_identity_id]);
      }
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (err instanceof SchalterZielFehler) throw err;
    throw new SchalterZielFehler('schalter_ziel_speicher_fehler', { meldung: String((err as { message?: unknown })?.message ?? err).slice(0, 200) });
  } finally {
    c.release();
  }
  if (geaendert) S.meldeSchalterGeschrieben();
  return { ebene, project, ziel, funktion: e.funktion, alt, neu: e.aktiv, wer: v.wer, geaendert, herkunft: v.herkunft, setter_agent_id: v.setter_agent_id };
}

/**
 * P6 (Pruefer 9ff7ab0f): beim Entfernen (Archivieren) eines Agenten dessen EIGENE Regeln loeschen - ebene identitaet (identity_id) bzw.
 * agent (exakter Name; Muster bleiben, sie gelten fuer andere Namen). Je Regel eine Verlaufszeile (neu NULL, herkunft 'aufraeumen').
 * Laeuft in der Transaktion des Aufrufers; vor Schema 182 (Tabelle fehlt) ohne Wirkung, damit das Entfernen nie daran scheitert.
 */
export async function raeumeZielRegelnAuf(db: Pick<import('pg').PoolClient, 'query'>,
  e: { project: string; ebene: 'identitaet' | 'agent'; ziel: string; wer: string; actor_identity_id: string | null; grund: string }): Promise<number> {
  const da = await db.query<{ da: boolean }>("SELECT to_regclass('agent_profil_schalter_ziel') IS NOT NULL AND to_regclass('agent_profil_schalter_ziel_verlauf') IS NOT NULL AS da");
  if (!da.rows[0]?.da || !e.ziel) return 0;
  const r = await db.query(
    `WITH weg AS (DELETE FROM agent_profil_schalter_ziel WHERE project = $1 AND ebene = $2 AND ziel = $3 RETURNING ebene, project, ziel, funktion, aktiv)
     INSERT INTO agent_profil_schalter_ziel_verlauf (ebene, project, ziel, funktion, alt, neu, grund, gesetzt_von, setter_identity_id, herkunft, setter_agent_id)
     SELECT ebene, project, ziel, funktion, aktiv, NULL, $4, $5, $6, 'aufraeumen', NULL FROM weg`,
    [e.project, e.ebene, e.ziel, e.grund, e.wer, e.actor_identity_id]);
  return r.rowCount ?? 0;
}
