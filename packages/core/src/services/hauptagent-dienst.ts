/**
 * P22-T36 (W2-P1): Hauptagent (Main-Agent) – dauerhafte Identitaet, Produkt-Schalter 'hauptagent', Rechte-Rahmen der
 * Selbstverwaltung und generische Runtime-Auftraege je Identitaet. Vertrag thought 0abdb238 (Freigabe Channel w2 27941),
 * User-Entscheidungen 39b8e0e9 (U1), 60c03d56 (Selbstverwaltung, ersetzt U2), 5fc2cafa (Modell-/Runtime-Wechsel).
 *
 * IDENTITAET: genau EINE Identitaet agent_id 'hauptagent', rolle 'main' im reservierten, unsichtbaren Bereich
 *   HAUPTAGENT_PROJEKT (virtuelle-projekte.ts). Angelegt ueber den bestehenden Ausweis-Kern (agentVorbereiten, Weg B,
 *   Akteur User) beim ersten Kontakt im Web-UI-Main-Chat; danach immer derselbe Ausweis (ausweisFuerStart, keine
 *   Rotation). Modell-/Runtime-Wechsel aendern den Ausweis nie. Der Rahmen der Selbstverwaltung (erlaubte_modelle,
 *   erlaubte_runtimes) liegt im Startrezept der Identitaet und wird nur vom User geaendert (profil_aendern).
 *
 * SCHALTER 'hauptagent' (Produkt-Schalter I, regel-neue-funktionen-mit-schalter-und-debug), Standard AUS:
 *   wirksam = intern-Override 'hauptagent' (nur SYNAPSE_INTERN_TOOL=1, befristet) > Produkt-Schalter (agent_profil_schalter,
 *   NUR ebene global, funktion 'hauptagent'; profil_schalter_setzen und 'alle' wirken NICHT darauf) > Env SYNAPSE_HAUPTAGENT=1
 *   > AUS. Setzen NUR der User (uebergeordnete Kontrolle, 60c03d56) – auch kein Legacy-Koordinator.
 *   MAPPING main_synapse: AUS = Altweg unveraendert (Werkzeugprofil weiter ueber intern main_synapse bzw.
 *   SYNAPSE_MAIN_SYNAPSE, Session-Scope). EIN = Identitaetsweg; main_synapse wird dort nicht ausgewertet.
 *
 * RECHTE (P1 nur User + Main ausprogrammiert, alle anderen recht_fehlt): User darf alles. Der Main-Agent (Principal aus
 *   seinem Ausweis, Rolle 'main' in PG gegengeprueft) darf ueber die EIGENE Identitaet: Status lesen, Auftraege
 *   neustart/update/modellwechsel/runtime_wechsel anlegen (Modell/Runtime nur innerhalb erlaubte_*; Hands-Off Pflicht),
 *   eigene offene Auftraege abbrechen. stop nur der User. Koordinatoren (auch Legacy) haben keine Verwaltungsrechte;
 *   sie erreichen den Main-Agenten nur ueber chat/inbox.
 *
 * AUFTRAEGE (Tabelle agent_runtime_auftraege, Schema 116): gewuenscht vs. tatsaechlich strikt getrennt. Bestand: das Profil-
 *   'modell' liegt in der Spalte modell_bestaetigt (= konfiguriert/gewuenscht); modell_selbstauskunft = Selbstauskunft des
 *   Agenten. TATSAECHLICH laufend gilt erst, was ein ACK nach erfolgreichem Neustart in auftrag.tatsaechlich schreibt
 *   (Runtime-Daemon, spaeteres Paket). In P1 bleiben Auftraege pending, Status zeigt ausfuehrung 'ausstehend_kein_executor'.
 *   P22-T6: neustart/modellwechsel/stop fuehrt der Runtime-Daemon aus (runtime-auftraege-ausfuehrung.ts): ausfuehrung
 *   'wartet_auf_runtime_daemon' (pending) bzw. 'in_ausfuehrung' (claimed/accepted); runtime_wechsel/update weiter ohne Ausfuehrer.
 */
import { randomUUID } from 'node:crypto';
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';
import { registerVirtualProject } from './project-registry.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { agentVorbereiten, ausweisFuerStart } from './agent-ausweis-dienst.js';
import { ProfilVerwaltungFehler, aktuellerW1bAkteur, pflichtText, pruefeProfilVerwalter } from './agent-profil-verwalter.js';
import { AUSWEIS_IM_TEXT } from './agent-ausweis-format.js';
import { AUSFUEHRBARE_AUFTRAG_ARTEN } from './runtime-auftraege-ausfuehrung.js';
import { identitaetAudit, schreibeProfilRevision, spaltenAusInhalt } from './agent-profil-dienst-a.js';
import { setzeHeartbeatKonfiguration } from './wrapper-status.js';
import { leseAgentVerbrauch } from './agent-verbrauch.js';
import type { AusweisAkteur, W1bAkteur } from './agent-profil-vertrag.js';

export const HAUPTAGENT_FUNKTION = 'hauptagent' as const;
export const HAUPTAGENT_AGENT_ID = 'hauptagent';
export const HAUPTAGENT_ROLLE = 'main';
export const AUFTRAG_ARTEN = ['neustart', 'update', 'modellwechsel', 'runtime_wechsel', 'stop'] as const;
export type AuftragArt = typeof AUFTRAG_ARTEN[number];
export const AUFTRAG_OFFEN = ['pending', 'claimed', 'accepted'] as const;
const AUSFUEHRUNG_P1 = 'ausstehend_kein_executor';

type Q = QueryConfig & { query_timeout: number };
function fehler(code: string, details?: Record<string, unknown>): never { throw new ProfilVerwaltungFehler(code, details); }

// ---------------------------------------------------------------------------------------------
// Schalter
// ---------------------------------------------------------------------------------------------
export type HauptagentQuelle = 'standard' | 'produkt-schalter' | 'intern';
export interface HauptagentSchalterStand {
  aktiv: boolean;
  quelle: HauptagentQuelle;
  standard: boolean;
  bis: string | null;
  gesetzt_von: string | null;
  gesetzt_am: string | null;
  grund: string | null;
  letzter_fehler: string | null;
  main_synapse_mapping: string;
}
export const MAIN_SYNAPSE_MAPPING = 'hauptagent AUS: Altweg unveraendert, Werkzeugprofil ueber intern main_synapse bzw. SYNAPSE_MAIN_SYNAPSE (Session-Scope). '
  + 'hauptagent EIN: Identitaetsweg (Ausweis + Profil, Bearer-Scope hauptagent:identitaet:<id>); main_synapse wird dort nicht ausgewertet.';

/** Frisch je Aufruf (kein Cache), damit Ablauf/Loeschen eines Overrides sofort wirkt. Lesefehler -> Produktionsstandard. */
export async function leseHauptagentSchalter(): Promise<HauptagentSchalterStand> {
  const standard = process.env.SYNAPSE_HAUPTAGENT === '1';
  const basis: HauptagentSchalterStand = { aktiv: standard, quelle: 'standard', standard, bis: null, gesetzt_von: null,
    gesetzt_am: null, grund: null, letzter_fehler: null, main_synapse_mapping: MAIN_SYNAPSE_MAPPING };
  let letzter: string | null = null;
  if (internToolAktiv()) {
    try {
      const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
        text: `SELECT aktiv, bis FROM intern_schalter WHERE name = $1 AND modus = 'freigegeben' AND (bis IS NULL OR bis > NOW())`,
        values: [HAUPTAGENT_FUNKTION], query_timeout: 2000,
      } as Q);
      const z = r.rows[0];
      if (z) return { ...basis, aktiv: z.aktiv, quelle: 'intern', bis: z.bis ? z.bis.toISOString() : null };
    } catch { letzter = 'schalter_nicht_erreichbar'; }
  }
  try {
    const r = await getPool().query<{ aktiv: boolean; grund: string | null; gesetzt_von: string; gesetzt_am: Date }>({
      text: `SELECT aktiv, grund, gesetzt_von, gesetzt_am FROM agent_profil_schalter
        WHERE ebene = 'global' AND project IS NULL AND funktion = $1`,
      values: [HAUPTAGENT_FUNKTION], query_timeout: 2000,
    } as Q);
    const z = r.rows[0];
    if (z) return { ...basis, aktiv: z.aktiv, quelle: 'produkt-schalter', gesetzt_von: z.gesetzt_von,
      gesetzt_am: z.gesetzt_am.toISOString(), grund: z.grund, letzter_fehler: letzter };
  } catch { letzter = letzter ?? 'produkt_schalter_nicht_lesbar'; }
  return { ...basis, letzter_fehler: letzter };
}

/** Nur der User (authentifizierter User-Eingang). Schreibt die globale Zeile funktion 'hauptagent'. */
export async function setzeHauptagentSchalter(akteur: AusweisAkteur | null, e: { aktiv: unknown; grund: unknown }): Promise<HauptagentSchalterStand> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Schalter hauptagent setzt nur der User' });
  if (typeof e.aktiv !== 'boolean') fehler('aktiv_fehlt');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  await getPool().query(
    `INSERT INTO agent_profil_schalter (ebene, project, funktion, aktiv, grund, gesetzt_von, setter_identity_id, gesetzt_am)
     VALUES ('global', NULL, $1, $2, $3, 'user', NULL, NOW())
     ON CONFLICT (ebene, (COALESCE(project, '')), funktion) DO UPDATE SET aktiv=EXCLUDED.aktiv, grund=EXCLUDED.grund,
       gesetzt_von=EXCLUDED.gesetzt_von, setter_identity_id=NULL, gesetzt_am=EXCLUDED.gesetzt_am`,
    [HAUPTAGENT_FUNKTION, e.aktiv, grund]);
  return leseHauptagentSchalter();
}

async function pruefeHauptagentAn(): Promise<HauptagentSchalterStand> {
  const s = await leseHauptagentSchalter();
  if (!s.aktiv) fehler('funktion_aus', { funktion: HAUPTAGENT_FUNKTION, quelle: s.quelle, ...(s.letzter_fehler ? { letzter_fehler: s.letzter_fehler } : {}) });
  return s;
}

// ---------------------------------------------------------------------------------------------
// Identitaet
// ---------------------------------------------------------------------------------------------
interface MainZeile {
  id: string; agent_id: string; rolle: string; status: string; profil: Record<string, unknown>;
  startrezept: Record<string, unknown>; profil_revision: number; modell_bestaetigt: string | null;
  modell_selbstauskunft: string | null; zuletzt_aktiv: Date; typ_id: string | null; typ_revision: number | null;
}

const MAIN_SPALTEN = `id, agent_id, rolle, status, profil, startrezept, profil_revision, modell_bestaetigt, modell_selbstauskunft, zuletzt_aktiv,
  typ_id, typ_revision`;

async function leseMainZeile(): Promise<MainZeile | null> {
  const r = await getPool().query<MainZeile>(
    `SELECT ${MAIN_SPALTEN} FROM agent_identitaeten WHERE project = $1 AND agent_id = $2`, [HAUPTAGENT_PROJEKT, HAUPTAGENT_AGENT_ID]);
  return r.rows[0] ?? null;
}

/** Identity-ID der Main-Identitaet (oder null). Fuer Driver/Transport. */
export async function hauptagentIdentitaetsId(): Promise<string | null> {
  return (await leseMainZeile())?.id ?? null;
}

export interface MainIdentitaetErgebnis {
  outcome: 'created' | 'existing';
  identity_id: string;
  agent_id: string;
  project: string;
  rolle: string;
  /** Ausweis: NUR fuer die Weitergabe per Header an die Main-CLI; nie in Prompt, Log, Antwort an Clients. */
  token: string;
  erstnutzung_bis: string | null;
}

function textListeAus(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map(x => x.trim()) : [];
}

/**
 * Erstkontakt (Web-UI-Main-Chat, Akteur User): legt GENAU EINE Main-Identitaet mit dauerhaftem Ausweis an oder findet sie.
 * Idempotent: UNIQUE(project, agent_id); ein paralleler Erstkontakt endet als 'existing'.
 */
export async function stelleMainIdentitaetSicher(
  akteur: AusweisAkteur | null, e: { modell?: string | null; runtime?: string | null } = {},
): Promise<MainIdentitaetErgebnis> {
  if (!akteur || akteur.art !== 'user') fehler('recht_fehlt', { grund: 'Erstkontakt nur durch den User' });
  await pruefeHauptagentAn();
  await registerVirtualProject(HAUPTAGENT_PROJEKT);
  const vorhanden = async (z: MainZeile): Promise<MainIdentitaetErgebnis> => {
    if (z.status !== 'aktiv') fehler('identitaet_nicht_aktiv');
    const a = await ausweisFuerStart(HAUPTAGENT_PROJEKT, z.id, { art: 'user' });
    return { outcome: 'existing', identity_id: z.id, agent_id: z.agent_id, project: HAUPTAGENT_PROJEKT, rolle: z.rolle,
      token: a.token, erstnutzung_bis: a.erstnutzung_bis };
  };
  const z = await leseMainZeile();
  if (z) return vorhanden(z);
  const modell = typeof e.modell === 'string' && e.modell.trim() ? e.modell.trim() : null;
  const runtime = typeof e.runtime === 'string' && e.runtime.trim() ? e.runtime.trim() : null;
  // Paralleler Erstkontakt (mehrere Tabs/Prozesse): serialisiert ueber einen Sitzungs-Advisory-Lock, danach erneut pruefen.
  const sperre = await getPool().connect();
  try {
    await sperre.query('SELECT pg_advisory_lock(hashtext($1))', ['synapse-hauptagent-erstkontakt']);
    const nachSperre = await leseMainZeile();
    if (nachSperre) return await vorhanden(nachSperre);
    const r = await agentVorbereiten({
      project: HAUPTAGENT_PROJEKT, name: HAUPTAGENT_AGENT_ID, rolle: HAUPTAGENT_ROLLE, startart: 'hauptagent',
      // 5fc2cafa: Profil-modell = konfiguriert/gewuenscht (Bestand: Spalte modell_bestaetigt); tatsaechlich erst per ACK.
      ...(modell ? { modell } : {}),
      profil: { startrezept: { runtime, erlaubte_modelle: modell ? [modell] : [], erlaubte_runtimes: runtime ? [runtime] : [] } },
      grund: 'Erstkontakt im Web-UI-Main-Chat (P22-T36)',
    }, { art: 'user' });
    return { outcome: 'created', identity_id: r.identity_id, agent_id: r.agent_id, project: HAUPTAGENT_PROJEKT, rolle: r.rolle,
      token: r.token, erstnutzung_bis: r.erstnutzung_bis };
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    if (code !== 'identitaet_existiert' && code !== '23505') throw err;
    const neu = await leseMainZeile();
    if (!neu) throw err;
    return vorhanden(neu);
  } finally {
    await sperre.query('SELECT pg_advisory_unlock(hashtext($1))', ['synapse-hauptagent-erstkontakt']).catch(() => undefined);
    sperre.release();
  }
}

// ---------------------------------------------------------------------------------------------
// Rechte
// ---------------------------------------------------------------------------------------------
type Berechtigung = { art: 'user'; wer: 'user'; actor: null } | { art: 'selbst'; wer: string; actor: string };

/** User, oder der Main-Agent selbst (Principal aus Ausweis, Rolle main in PG). Alle anderen: recht_fehlt. */
async function berechtigungFuer(akteur: AusweisAkteur | null, ziel: MainZeile): Promise<Berechtigung> {
  if (akteur?.art === 'user') return { art: 'user', wer: 'user', actor: null };
  if (akteur?.art === 'identitaet') {
    const p = akteur.principal;
    if (p.identity_id === ziel.id && p.project === HAUPTAGENT_PROJEKT) {
      const r = await getPool().query(
        "SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle=$3 AND status='aktiv'", [ziel.id, HAUPTAGENT_PROJEKT, HAUPTAGENT_ROLLE]);
      if (r.rows[0]) return { art: 'selbst', wer: ziel.id, actor: ziel.id };
    }
  }
  return fehler('recht_fehlt');
}

/** Grobe Vorpruefung VOR Schalter/Ziel: nur User oder ein Principal mit Rolle main im reservierten Bereich (PG-Pruefung folgt). */
function vorpruefeAkteur(akteur: AusweisAkteur | null): void {
  if (akteur?.art === 'user') return;
  if (akteur?.art === 'identitaet' && akteur.principal.project === HAUPTAGENT_PROJEKT && akteur.principal.rolle === HAUPTAGENT_ROLLE) return;
  fehler('recht_fehlt');
}

async function zielMain(identityId: unknown): Promise<MainZeile> {
  const z = await leseMainZeile();
  if (!z) return fehler('identitaet_unbekannt', { grund: 'Main-Identitaet noch nicht angelegt (Erstkontakt im Web-UI-Main-Chat)' });
  if (identityId !== undefined && identityId !== null && identityId !== z.id) {
    // P1: Auftraege nur fuer die Main-Identitaet ausprogrammiert (Tabelle ist generisch je Identitaet).
    fehler('ziel_nicht_unterstuetzt', { grund: 'P1: Runtime-Auftraege nur fuer die Main-Identitaet' });
  }
  return z;
}

// ---------------------------------------------------------------------------------------------
// Auftraege
// ---------------------------------------------------------------------------------------------
// P22-T6/T58: failover (nur true) = alter Container ist bereits gestoppt; runtime_wechsel ohne Stop an die alte Runtime.
const GEWUENSCHT_FELDER = ['modell', 'provider', 'effort', 'runtime', 'cli', 'failover'] as const;

function normalisiereGewuenscht(v: unknown): Record<string, string> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) fehler('gewuenscht_ungueltig');
  const o = v as Record<string, unknown>;
  const unbekannt = Object.keys(o).filter(k => !(GEWUENSCHT_FELDER as readonly string[]).includes(k));
  if (unbekannt.length) fehler('gewuenscht_ungueltig', { felder: unbekannt });
  const out: Record<string, string> = {};
  for (const k of GEWUENSCHT_FELDER) {
    const x = o[k];
    if (x === undefined || x === null) continue;
    if (k === 'failover') {
      if (x !== true) fehler('gewuenscht_ungueltig', { felder: [k] });
      out[k] = 'ja';
      continue;
    }
    if (typeof x !== 'string' || !x.trim() || x.length > 128) fehler('gewuenscht_ungueltig', { felder: [k] });
    out[k] = (x as string).trim();
  }
  return out;
}

function pruefeHandsOff(v: unknown): Record<string, unknown> | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) fehler('hands_off_ungueltig');
  const text = JSON.stringify(v);
  if (text.length > 20_000) fehler('hands_off_zu_gross');
  if (AUSWEIS_IM_TEXT.test(text)) fehler('inhalt_enthaelt_ausweis');
  return v as Record<string, unknown>;
}

interface AuftragZeile {
  id: string; identity_id: string; art: AuftragArt; status: string; gewuenscht: Record<string, unknown>;
  tatsaechlich: Record<string, unknown> | null; hands_off: Record<string, unknown> | null; grund: string;
  erstellt_von: string; actor_identity_id: string | null; idempotenz_schluessel: string | null; claim_revision: number;
  letzter_fehler: string | null; erstellt_am: Date; aktualisiert_am: Date; abgeschlossen_am: Date | null; abgeschlossen_von: string | null;
}
const AUFTRAG_SPALTEN = `id, identity_id, art, status, gewuenscht, tatsaechlich, hands_off, grund, erstellt_von, actor_identity_id,
  idempotenz_schluessel, claim_revision, letzter_fehler, erstellt_am, aktualisiert_am, abgeschlossen_am, abgeschlossen_von`;

function auftragAus(z: AuftragZeile): Record<string, unknown> {
  const offen = (AUFTRAG_OFFEN as readonly string[]).includes(z.status);
  return {
    auftrag_id: z.id, identity_id: z.identity_id, art: z.art, status: z.status, offen,
    gewuenscht: z.gewuenscht, tatsaechlich: z.tatsaechlich, hands_off: z.hands_off, grund: z.grund,
    erstellt_von: z.erstellt_von, idempotenz_schluessel: z.idempotenz_schluessel, claim_revision: z.claim_revision,
    letzter_fehler: z.letzter_fehler, erstellt_am: z.erstellt_am.toISOString(), aktualisiert_am: z.aktualisiert_am.toISOString(),
    abgeschlossen_am: z.abgeschlossen_am ? z.abgeschlossen_am.toISOString() : null, abgeschlossen_von: z.abgeschlossen_von,
    ...(offen ? { ausfuehrung: !([...AUSFUEHRBARE_AUFTRAG_ARTEN, 'runtime_wechsel'] as readonly string[]).includes(z.art) ? AUSFUEHRUNG_P1
      : z.status === 'pending' ? 'wartet_auf_runtime_daemon' : 'in_ausfuehrung' } : {}),
  };
}

async function audit(identityId: string, b: Berechtigung, aktion: string, neu: unknown, grund: string): Promise<void> {
  await getPool().query(
    `INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id) VALUES ($1,$2,$3,NULL,$4::jsonb,$5,$6)`,
    [identityId, b.wer, aktion, JSON.stringify(neu ?? null), grund, b.actor]);
}

export interface AuftragEingabe {
  identity_id?: string | null;
  art: unknown;
  gewuenscht?: unknown;
  hands_off?: unknown;
  grund: unknown;
  idempotenz_schluessel?: unknown;
}

export async function legeRuntimeAuftragAn(akteur: AusweisAkteur | null, e: AuftragEingabe): Promise<Record<string, unknown>> {
  vorpruefeAkteur(akteur);
  await pruefeHauptagentAn();
  const ziel = await zielMain(e.identity_id);
  const b = await berechtigungFuer(akteur, ziel);
  if (typeof e.art !== 'string' || !(AUFTRAG_ARTEN as readonly string[]).includes(e.art)) fehler('auftrag_art_ungueltig');
  const art = e.art as AuftragArt;
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const gewuenscht = normalisiereGewuenscht(e.gewuenscht);
  if (AUSWEIS_IM_TEXT.test(JSON.stringify(gewuenscht))) fehler('inhalt_enthaelt_ausweis');
  const handsOff = pruefeHandsOff(e.hands_off);
  const schluessel = typeof e.idempotenz_schluessel === 'string' && e.idempotenz_schluessel.trim() ? e.idempotenz_schluessel.trim().slice(0, 200) : null;
  if (art === 'modellwechsel' && !gewuenscht.modell) fehler('gewuenscht_modell_fehlt');
  if (art === 'runtime_wechsel' && !gewuenscht.runtime) fehler('gewuenscht_runtime_fehlt');
  if (gewuenscht.failover && art !== 'runtime_wechsel') fehler('gewuenscht_ungueltig', { felder: ['failover'] });
  if (b.art === 'selbst') {
    // 60c03d56: uebergeordnete Kontrolle beim User -> stop nur der User. 5fc2cafa: Modell/Runtime nur im festgelegten Rahmen.
    if (art === 'stop') fehler('recht_fehlt', { grund: 'stop nur durch den User' });
    if (gewuenscht.failover) fehler('recht_fehlt', { grund: 'failover nur durch User/Ueberwachung' });
    const rahmen = ziel.startrezept ?? {};
    if (gewuenscht.modell && !textListeAus(rahmen.erlaubte_modelle).includes(gewuenscht.modell)) {
      fehler('ausserhalb_rahmen', { feld: 'modell', erlaubte_modelle: textListeAus(rahmen.erlaubte_modelle) });
    }
    if (gewuenscht.runtime && !textListeAus(rahmen.erlaubte_runtimes).includes(gewuenscht.runtime)) {
      fehler('ausserhalb_rahmen', { feld: 'runtime', erlaubte_runtimes: textListeAus(rahmen.erlaubte_runtimes) });
    }
    if (!handsOff) fehler('hands_off_fehlt', { grund: 'Vor Neustart/Update/Wechsel Arbeitsstand als hands_off hinterlegen' });
  }
  if (schluessel) {
    const alt = await getPool().query<AuftragZeile>(`SELECT ${AUFTRAG_SPALTEN} FROM agent_runtime_auftraege WHERE identity_id=$1 AND idempotenz_schluessel=$2`, [ziel.id, schluessel]);
    if (alt.rows[0]) {
      if (alt.rows[0].art !== art) fehler('idempotenz_konflikt', { auftrag_id: alt.rows[0].id });
      return { auftrag: auftragAus(alt.rows[0]), idempotent: true };
    }
  }
  const id = randomUUID();
  try {
    const r = await getPool().query<AuftragZeile>(
      `INSERT INTO agent_runtime_auftraege (id, identity_id, art, status, gewuenscht, hands_off, grund, erstellt_von, actor_identity_id, idempotenz_schluessel)
       VALUES ($1,$2,$3,'pending',$4::jsonb,$5::jsonb,$6,$7,$8,$9) RETURNING ${AUFTRAG_SPALTEN}`,
      [id, ziel.id, art, JSON.stringify(gewuenscht), handsOff ? JSON.stringify(handsOff) : null, grund, b.wer, b.actor, schluessel]);
    await audit(ziel.id, b, 'runtime_auftrag_angelegt', { auftrag_id: id, art, gewuenscht }, grund);
    return { auftrag: auftragAus(r.rows[0]), idempotent: false };
  } catch (err) {
    const c = err as { code?: string; constraint?: string };
    // P22-T43: Unique-Verletzung am Zustand erkennen, nicht nur am Index-NAMEN. In kopierten Tabellen (Tests: CREATE TABLE ...
    // (LIKE ... INCLUDING ALL)) heissen die Indizes anders; dann kam statt auftrag_offen_vorhanden ein generischer Fehler.
    if (c.code === '23505') {
      const offen = await getPool().query<{ id: string }>(
        "SELECT id FROM agent_runtime_auftraege WHERE identity_id=$1 AND art=$2 AND status IN ('pending','claimed','accepted') LIMIT 1", [ziel.id, art]);
      if (c.constraint === 'uq_agent_runtime_auftraege_offen' || (c.constraint !== 'uq_agent_runtime_auftraege_idem' && offen.rows[0])) {
        fehler('auftrag_offen_vorhanden', { auftrag_id: offen.rows[0]?.id ?? null });
      }
      if (c.constraint === 'uq_agent_runtime_auftraege_idem' || schluessel) fehler('idempotenz_konflikt');
    }
    throw err;
  }
}

export async function brecheRuntimeAuftragAb(akteur: AusweisAkteur | null, e: { auftrag_id: unknown; grund: unknown }): Promise<Record<string, unknown>> {
  vorpruefeAkteur(akteur);
  await pruefeHauptagentAn();
  if (typeof e.auftrag_id !== 'string' || !e.auftrag_id.trim()) fehler('auftrag_id_fehlt');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const z = (await getPool().query<AuftragZeile>(`SELECT ${AUFTRAG_SPALTEN} FROM agent_runtime_auftraege WHERE id=$1`, [(e.auftrag_id as string).trim()])).rows[0];
  if (!z) return fehler('auftrag_unbekannt');
  const ziel = await zielMain(z.identity_id);
  const b = await berechtigungFuer(akteur, ziel);
  if (b.art === 'selbst' && z.actor_identity_id !== b.actor) fehler('recht_fehlt', { grund: 'nur eigene Auftraege abbrechen' });
  // Nur pending: ein beanspruchter Auftrag muss erst vom Ausfuehrer versoehnt werden (Leaseablauf beweist keinen Exit).
  const r = await getPool().query<AuftragZeile>(
    `UPDATE agent_runtime_auftraege SET status='cancelled', aktualisiert_am=NOW(), abgeschlossen_am=NOW(), abgeschlossen_von=$2
      WHERE id=$1 AND status='pending' RETURNING ${AUFTRAG_SPALTEN}`, [z.id, b.wer]);
  if (!r.rows[0]) fehler('auftrag_nicht_abbrechbar', { status: z.status });
  await audit(ziel.id, b, 'runtime_auftrag_abgebrochen', { auftrag_id: z.id, art: z.art }, grund);
  return { auftrag: auftragAus(r.rows[0]) };
}

export async function listeRuntimeAuftraege(akteur: AusweisAkteur | null, e: { identity_id?: string | null } = {}): Promise<Record<string, unknown>> {
  vorpruefeAkteur(akteur);
  const ziel = await zielMain(e.identity_id);
  await berechtigungFuer(akteur, ziel);
  const r = await getPool().query<AuftragZeile>(
    `SELECT ${AUFTRAG_SPALTEN} FROM agent_runtime_auftraege WHERE identity_id=$1 ORDER BY erstellt_am DESC LIMIT 50`, [ziel.id]);
  return { identity_id: ziel.id, auftraege: r.rows.map(auftragAus) };
}

/**
 * Status fuer User und Main-Agent selbst: Schalter, Identitaet, gewuenscht (Profil/offener Auftrag) vs. tatsaechlich
 * (modell_bestaetigt), Rahmen, offene Auftraege. Ohne Identitaet: identitaet null (Schalter bleibt sichtbar, nur User).
 */
export async function hauptagentStatus(akteur: AusweisAkteur | null): Promise<Record<string, unknown>> {
  vorpruefeAkteur(akteur);
  const schalter = await leseHauptagentSchalter();
  const z = await leseMainZeile();
  if (!z) {
    if (akteur?.art !== 'user') fehler('recht_fehlt');
    return { schalter, project: HAUPTAGENT_PROJEKT, identitaet: null, auftraege_offen: [] };
  }
  await berechtigungFuer(akteur, z);
  const ausweis = await getPool().query<{ zustand: string }>(
    `SELECT CASE WHEN t.gueltig_bis IS NULL THEN 'aktiv' WHEN t.gueltig_bis > NOW() THEN 'ausgestellt' ELSE 'verfallen' END AS zustand
       FROM agent_identitaet_tokens t WHERE t.identity_id=$1 AND t.widerrufen_am IS NULL AND t.token_offen IS NOT NULL LIMIT 1`, [z.id]);
  const offen = await getPool().query<AuftragZeile>(
    `SELECT ${AUFTRAG_SPALTEN} FROM agent_runtime_auftraege WHERE identity_id=$1 AND status IN ('pending','claimed','accepted') ORDER BY erstellt_am`, [z.id]);
  const rahmen = z.startrezept ?? {};
  // P22-T7: ein offener Wechselauftrag ist der gewuenschte Stand, bis der Ausfuehrer (T6) ihn bestaetigt.
  const offenGewuenscht = (feld: 'modell' | 'runtime'): string | null => {
    const a = offen.rows.find(o => (o.art === 'modellwechsel' || o.art === 'runtime_wechsel') && typeof o.gewuenscht?.[feld] === 'string');
    return a ? a.gewuenscht[feld] as string : null;
  };
  const ack = await getPool().query<{ modell: string | null; runtime: string | null }>(
    `SELECT tatsaechlich->>'modell' AS modell, tatsaechlich->>'runtime' AS runtime FROM agent_runtime_auftraege
      WHERE identity_id=$1 AND status='completed' AND tatsaechlich IS NOT NULL ORDER BY abgeschlossen_am DESC NULLS LAST LIMIT 1`, [z.id]);
  return {
    schalter, project: HAUPTAGENT_PROJEKT,
    identitaet: {
      identity_id: z.id, agent_id: z.agent_id, rolle: z.rolle, status: z.status, profil_revision: z.profil_revision,
      ausweis_zustand: ausweis.rows[0]?.zustand ?? 'fehlt', zuletzt_aktiv: z.zuletzt_aktiv.toISOString(),
      // Gewuenscht = konfiguriert im Profil bzw. offener Wechselauftrag; tatsaechlich = erst nach bestaetigtem Neustart.
      modell_gewuenscht: offenGewuenscht('modell') ?? z.modell_bestaetigt ?? ((z.profil?.modell as string | undefined) ?? null),
      modell_tatsaechlich: ack.rows[0]?.modell ?? null, modell_selbstauskunft: z.modell_selbstauskunft,
      runtime_gewuenscht: offenGewuenscht('runtime') ?? (typeof rahmen.runtime === 'string' ? rahmen.runtime : null),
      runtime_tatsaechlich: ack.rows[0]?.runtime ?? null,
      rahmen: { erlaubte_modelle: textListeAus(rahmen.erlaubte_modelle), erlaubte_runtimes: textListeAus(rahmen.erlaubte_runtimes) },
    },
    heartbeat: await heartbeatStand(z),
    auftraege_offen: offen.rows.map(auftragAus),
    // P22-T58: Runtime-Ueberwachung kurz (dynamisch: runtime-ueberwachung.ts importiert diese Datei).
    ueberwachung: await (await import('./runtime-ueberwachung.js')).ueberwachungKurz(),
  };
}

// ---------------------------------------------------------------------------------------------
// P22-T7: Heartbeat des Hauptagenten (User 88f80455, 423dc69e). Einstellung im Startrezept der Identitaet
// (startrezept.heartbeat {aktiv, intervall_ms}); fehlt sie, gilt der Code-Standard AUS. Setzen NUR der User. Der Main-Spawn
// (T6) liest sie ueber hauptagentHeartbeatAusStartrezept statt setzeHeartbeatBeimSpawn. Laeuft schon ein Wrapper der
// Identitaet, wird seine Zeile sofort nachgezogen (Bestand-Trigger weckt den Wrapper).
// ---------------------------------------------------------------------------------------------
export const HEARTBEAT_TAKT_MIN_MS = 5_000;
export const HEARTBEAT_STANDARD = { aktiv: false, intervall_ms: null } as const;

export interface HauptagentHeartbeatEinstellung {
  aktiv: boolean;
  /** null = adaptive Ladder des Wrappers (wie lokale Spezialisten). */
  intervall_ms: number | null;
  quelle: 'standard' | 'einstellung';
  gesetzt_am: string | null;
}

/** Eine Lesestelle fuer die Heartbeat-Einstellung (auch fuer den Main-Spawn in T6). */
export function hauptagentHeartbeatAusStartrezept(startrezept: unknown): HauptagentHeartbeatEinstellung {
  const h = startrezept && typeof startrezept === 'object' ? (startrezept as Record<string, unknown>).heartbeat : undefined;
  if (!h || typeof h !== 'object' || typeof (h as Record<string, unknown>).aktiv !== 'boolean') {
    return { ...HEARTBEAT_STANDARD, quelle: 'standard', gesetzt_am: null };
  }
  const o = h as Record<string, unknown>;
  const takt = typeof o.intervall_ms === 'number' && Number.isInteger(o.intervall_ms) && o.intervall_ms >= HEARTBEAT_TAKT_MIN_MS ? o.intervall_ms : null;
  return { aktiv: o.aktiv as boolean, intervall_ms: takt, quelle: 'einstellung', gesetzt_am: typeof o.gesetzt_am === 'string' ? o.gesetzt_am : null };
}

async function heartbeatStand(z: MainZeile): Promise<Record<string, unknown>> {
  const w = await getPool().query<{ heartbeat_enabled: boolean; heartbeat_interval_ms: number | null; status: string }>(
    'SELECT heartbeat_enabled, heartbeat_interval_ms, status FROM agent_identitaet_wrapper_status WHERE identity_id=$1 AND project=$2',
    [z.id, HAUPTAGENT_PROJEKT]).catch(() => ({ rows: [] as Array<{ heartbeat_enabled: boolean; heartbeat_interval_ms: number | null; status: string }> }));
  const lauf = w.rows[0];
  return {
    gewuenscht: hauptagentHeartbeatAusStartrezept(z.startrezept),
    // Tatsaechlich = Zeile des laufenden Wrappers; ohne Lauf gibt es keinen tatsaechlichen Stand.
    tatsaechlich: lauf
      ? { lauf: true, status: lauf.status, aktiv: lauf.heartbeat_enabled, intervall_ms: lauf.heartbeat_interval_ms != null ? Number(lauf.heartbeat_interval_ms) : null }
      : { lauf: false, status: 'kein_lauf', aktiv: null, intervall_ms: null },
  };
}

/**
 * P22-T7 / User de950bab: Wer den Main-Heartbeat setzen darf. User immer. Ein bestaetigter Koordinator (mit Ausweis, Rolle in PG
 * gegengeprueft, oder Legacy-Koordinator) und der Main-Agent selbst NUR auf Anweisung des Users: dann ist user_auftrag (Wortlaut der
 * Anweisung) Pflicht und landet mit dem Grund in Revision und Audit. Von sich aus aendern ihn weder Koordinator noch Main (88f80455).
 * Alle anderen: recht_fehlt. Lesen duerfen dieselben Akteure ohne user_auftrag.
 */
type HeartbeatAkteur = { wer: string; actor: string | null; user: boolean; rolle: 'user' | 'koordinator' | 'main' };
async function heartbeatAkteur(akteur: AusweisAkteur | null, z: MainZeile | null): Promise<HeartbeatAkteur> {
  if (akteur?.art === 'user') return { wer: 'user', actor: null, user: true, rolle: 'user' };
  if (akteur?.art === 'identitaet' && akteur.principal.project === HAUPTAGENT_PROJEKT && akteur.principal.rolle === HAUPTAGENT_ROLLE) {
    if (!z) return fehler('recht_fehlt');
    const b = await berechtigungFuer(akteur, z);
    return { wer: b.wer, actor: b.actor, user: false, rolle: 'main' };
  }
  if (akteur?.art === 'identitaet' && akteur.principal.rolle === 'koordinator') {
    const v = await pruefeProfilVerwalter(akteur, akteur.principal.project);
    return { wer: v.wer, actor: v.actor_identity_id, user: false, rolle: 'koordinator' };
  }
  if (akteur?.art === 'legacy_koordinator') {
    // Gehoert der Name einer Token-Identitaet (auch im Bereich des Main), braucht der Aufruf deren Ausweis (wie pruefeProfilVerwalter).
    const v = await pruefeProfilVerwalter(akteur, HAUPTAGENT_PROJEKT);
    return { wer: v.wer, actor: null, user: false, rolle: 'koordinator' };
  }
  return fehler('recht_fehlt');
}

export async function leseHauptagentHeartbeat(akteur: AusweisAkteur | null): Promise<Record<string, unknown>> {
  const z = await leseMainZeile();
  await heartbeatAkteur(akteur, z);
  if (!z) {
    return { identitaet: null, gewuenscht: { ...HEARTBEAT_STANDARD, quelle: 'standard', gesetzt_am: null }, tatsaechlich: { lauf: false, status: 'keine_identitaet', aktiv: null, intervall_ms: null } };
  }
  return { identitaet: z.id, ...(await heartbeatStand(z)) };
}

/**
 * Setzen: User, oder Koordinator/Main selbst auf User-Anweisung (user_auftrag Pflicht, de950bab). Schreibt eine neue Profil-
 * Revision (Historie + Audit wie profil_aendern) und zieht einen laufenden Wrapper nach. Ohne Identitaet: identitaet_unbekannt
 * (vor dem Erstkontakt gilt der Standard AUS).
 */
export async function setzeHauptagentHeartbeat(
  akteur: AusweisAkteur | null, e: { aktiv: unknown; intervall_ms?: unknown; grund: unknown; user_auftrag?: unknown },
): Promise<Record<string, unknown>> {
  const wer = await heartbeatAkteur(akteur, await leseMainZeile());
  const userAuftrag = wer.user ? null : pflichtText(e.user_auftrag, 'user_auftrag_fehlt');
  if (typeof e.aktiv !== 'boolean') fehler('aktiv_fehlt');
  let takt: number | null = null;
  if (e.intervall_ms !== undefined && e.intervall_ms !== null) {
    if (typeof e.intervall_ms !== 'number' || !Number.isInteger(e.intervall_ms) || e.intervall_ms < HEARTBEAT_TAKT_MIN_MS || e.intervall_ms > 24 * 3_600_000) {
      fehler('intervall_ungueltig', { min_ms: HEARTBEAT_TAKT_MIN_MS, max_ms: 24 * 3_600_000 });
    }
    takt = e.intervall_ms as number;
  }
  const grund = pflichtText(e.grund, 'grund_fehlt');
  const vorher = await leseMainZeile();
  if (!vorher) fehler('identitaet_unbekannt', { grund: 'Main-Identitaet noch nicht angelegt; bis dahin gilt Heartbeat AUS (Standard)' });
  const heartbeat = { aktiv: e.aktiv, intervall_ms: takt, gesetzt_am: new Date().toISOString(), gesetzt_von: wer.rolle };
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const z = (await c.query<MainZeile>(`SELECT ${MAIN_SPALTEN} FROM agent_identitaeten WHERE id=$1 FOR UPDATE`, [vorher.id])).rows[0];
    const alt: Record<string, unknown> = { ...(z.profil ?? {}), rolle: z.rolle, ...(z.modell_bestaetigt != null ? { modell: z.modell_bestaetigt } : {}),
      ...(z.startrezept && Object.keys(z.startrezept).length ? { startrezept: z.startrezept } : {}) };
    const neu = { ...alt, startrezept: { ...(z.startrezept ?? {}), heartbeat } };
    const { startrezept } = spaltenAusInhalt(neu);
    const revision = z.profil_revision + 1;
    await c.query('UPDATE agent_identitaeten SET startrezept=$2::jsonb, profil_revision=$3 WHERE id=$1', [z.id, JSON.stringify(startrezept), revision]);
    const v = { wer: wer.wer, actor: wer.actor, user: wer.user };
    await schreibeProfilRevision(c, z.id, revision, neu, z.typ_id ?? null, z.typ_revision ?? null, v, userAuftrag, grund);
    await identitaetAudit(c, z.id, v, 'hauptagent_heartbeat', { heartbeat: (z.startrezept ?? {}).heartbeat ?? null },
      { heartbeat, akteur: wer.rolle, ...(userAuftrag ? { user_auftrag: userAuftrag } : {}) }, grund);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
  // Laufender Wrapper: Zeile nachziehen (der eine Weg setzeHeartbeatKonfiguration). Ohne Zeile ist nichts zu tun.
  let nachgezogen = false;
  try {
    const r = await setzeHeartbeatKonfiguration(HAUPTAGENT_PROJEKT,
      [{ art: 'identity', project: HAUPTAGENT_PROJEKT, agent_id: HAUPTAGENT_AGENT_ID, identity_id: vorher.id }],
      { enabled: e.aktiv, intervalMs: takt });
    nachgezogen = r.some(x => x.identityId === vorher.id);
  } catch { nachgezogen = false; }
  const jetzt = await leseMainZeile();
  return { identitaet: vorher.id, wrapper_nachgezogen: nachgezogen, ...(await heartbeatStand(jetzt ?? vorher)) };
}

// ---------------------------------------------------------------------------------------------
// admin-Aktionen (MCP admin, stdio und REST) – Akteur nur aus Transport/Tokenpruefung
// ---------------------------------------------------------------------------------------------
export const HAUPTAGENT_ADMIN_ACTIONS = ['hauptagent_status', 'hauptagent_auftrag', 'hauptagent_auftraege', 'hauptagent_auftrag_abbrechen',
  // P22-T7: Heartbeat des Hauptagenten (ohne aktiv lesen, mit aktiv setzen - nur User) und Verbrauch je Agent/Projekt/Monat.
  'hauptagent_heartbeat', 'agent_verbrauch'] as const;
export type HauptagentAdminAction = typeof HAUPTAGENT_ADMIN_ACTIONS[number];
export const HAUPTAGENT_ADMIN_PARAMETER: Record<string, Record<string, unknown>> = {
  auftrag_art: { type: 'string', enum: [...AUFTRAG_ARTEN], description: 'hauptagent_auftrag: neustart|update|modellwechsel|runtime_wechsel|stop (stop nur User)' },
  auftrag_id: { type: 'string', description: 'hauptagent_auftrag_abbrechen: Auftrags-ID' },
  gewuenscht: { type: 'object', additionalProperties: true, description: 'hauptagent_auftrag: gewuenschter Stand {modell, provider, effort, runtime, cli}' },
  hands_off: { type: 'object', additionalProperties: true, description: 'hauptagent_auftrag: Arbeitsstand/Uebergabe {thought_id, arbeitsstand, offene_aufgaben}; Pflicht fuer den Hauptagenten selbst' },
  idempotenz_schluessel: { type: 'string', description: 'hauptagent_auftrag: optionaler Idempotenz-Schluessel' },
  intervall_ms: { type: 'number', description: 'hauptagent_heartbeat: fester Takt in ms (>= 5000), weglassen/null = adaptiv; setzen User, Koordinator/Main nur auf User-Anweisung (user_auftrag Pflicht)' },
  monat: { type: 'string', description: 'agent_verbrauch: Kalendermonat YYYY-MM (Standard aktueller Monat); Koordinator nur mit project (eigenes)' },
};

export function istHauptagentAdminAction(action: unknown): action is HauptagentAdminAction {
  return typeof action === 'string' && (HAUPTAGENT_ADMIN_ACTIONS as readonly string[]).includes(action);
}

const CODE = /^[a-z][a-z0-9_]{2,80}$/;

export async function fuehreHauptagentAdminAus(
  action: HauptagentAdminAction, args: Record<string, unknown>, akteurOpt?: AusweisAkteur | null,
): Promise<Record<string, unknown>> {
  const akteur: AusweisAkteur | null = akteurOpt !== undefined ? akteurOpt : aktuellerW1bAkteur();
  const zid = typeof args.ziel_identity_id === 'string' && args.ziel_identity_id.trim() ? args.ziel_identity_id.trim() : null;
  try {
    switch (action) {
      case 'hauptagent_status':
        return { success: true, action, ...(await hauptagentStatus(akteur)) };
      case 'hauptagent_auftrag':
        return { success: true, action, ...(await legeRuntimeAuftragAn(akteur, {
          identity_id: zid, art: args.auftrag_art, gewuenscht: args.gewuenscht, hands_off: args.hands_off,
          grund: args.grund, idempotenz_schluessel: args.idempotenz_schluessel,
        })) };
      case 'hauptagent_auftraege':
        return { success: true, action, ...(await listeRuntimeAuftraege(akteur, { identity_id: zid })) };
      case 'hauptagent_auftrag_abbrechen':
        return { success: true, action, ...(await brecheRuntimeAuftragAb(akteur, { auftrag_id: args.auftrag_id, grund: args.grund })) };
      case 'hauptagent_heartbeat':
        return { success: true, action, ...(args.aktiv === undefined
          ? await leseHauptagentHeartbeat(akteur)
          : await setzeHauptagentHeartbeat(akteur, { aktiv: args.aktiv, intervall_ms: args.intervall_ms, grund: args.grund, user_auftrag: args.user_auftrag })) };
      case 'agent_verbrauch':
        return { success: true, action, ...(await leseAgentVerbrauch(akteur, { monat: args.monat, project: args.project })) };
    }
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    if (typeof code === 'string' && CODE.test(code)) {
      const d = (e as { details?: unknown }).details;
      return { success: false, action, error: code, ...(d && typeof d === 'object' ? { details: d } : {}) };
    }
    return { success: false, action, error: 'hauptagent_fehler' };
  }
  return { success: false, action, error: 'aktion_unbekannt' };
}
