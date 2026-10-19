/**
 * P22-T13 Paket A: Core-Dienste fuer Schattenprofile (K3), Typ-Katalog global/projekt mit Revisionen
 * und Vererbung (K5/K8), Identitaetsprofil lesen/aendern/Historie/Rollback (K5/K8/K10).
 * Signaturen: agent-profil-vertrag.ts (W1B_DIENSTE.schatten/typen/profil.* delegieren hierher).
 *
 * SCHALTER: jede Funktion prueft den Produkt-Schalter (agent-profil-schalter.ts, Standard AUS,
 *   Vorrang projekt>global): schatten -> 'schattenprofile', typen -> 'typkatalog', profil -> 'profilverwaltung'.
 *   AUS -> ProfilDienstFehler('funktion_aus'), keine DB-Aenderung. Ausnahme: verfalleAbgelaufene (reine
 *   Aufraeumung, ohne Schalter) und leseTypRevision/leseWirksamenTypInhalt (interne Lesewege fuer Paket C).
 * RECHTE: Akteur nur aus authentifiziertem Transport/Tokenpruefung (W1bAkteur). User immer; Koordinator
 *   nur desselben Projekts und nur wenn die DB ihn als aktiven Koordinator kennt (nie dem Principal
 *   allein glauben). Globale Typen nur User. Eigenprofilregel F2 (a0f710e0): Koordinator aendert sein
 *   EIGENES Profil nur im ersten Startfall (Schattenprofil koordinator_start, profil_revision = 1, mit
 *   User-Auftrag). Daemon darf nur den ersten Koordinator eines Projekts bestaetigen (K3C, atomar je Projekt).
 * ATOMAR: Bestaetigung (Identitaet + Profilrevision 1 + Tokenaktivierung + Audit), Profilaenderung und
 *   Rollback je EINE Transaktion; CAS ueber revision/profil_revision; Doppelbestaetigung idempotent.
 * TOKEN (W12 V2, Weg A): der Schatten traegt KEINEN Token. Erst die Bestaetigung erzeugt den Ausweis: offen in
 *   agent_identitaet_tokens.token_offen, sofort 'aktiv' (ausweis_weg schatten_bestaetigt). Kein Hash, kein Tresor.
 *   Der Tokenwert erscheint weder in Audit noch in Fehlern; der laufende Agent erhaelt ihn per Hinweis (W12-B).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { rolleFuerAgent } from './agent-rollen.js';
import { leseProfilProduktSchalter, leseAusweisKern, ausweisSchattenAktiv, type ProfilProduktFunktion } from './agent-profil-schalter.js';
import {
  HINWEIS_KATALOG_VOLLSTAENDIG, ProfilRevisionKonflikt, darfProfilAendern, hinweisEintrag,
  schattenAblauf, wirksamerSchattenZustand,
  type AgentTyp, type AgentTypRevision, type FeldHerkunft, type ProfilAenderung, type ProfilInhalt, type ProfilRevision,
  type ProfilDienst, type SchattenAnlage, type SchattenBestaetigung, type Schattenprofil, type SchattenprofilDienst,
  type SchattenSelbstangaben, type SchattenZustand, type TypKatalogDienst, type W1bAkteur, type AusweisAkteur,
} from './agent-profil-vertrag.js';

export class ProfilDienstFehler extends Error {
  /** Nur geheimnisfreie Details (Feldnamen, Funktionsname). */
  constructor(public readonly code: string, public readonly details?: Record<string, unknown>) { super(code); }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Zeile = Record<string, any>;
export interface Verwalter { wer: string; actor: string | null; user: boolean }

const MAX_TEXT = 4000;
const AUSWEIS_TEST = /sai_[a-f0-9]{16,}/i;
const AUSWEIS_ERSETZEN = /sai_[a-f0-9]{16,}/gi;
const GEHEIM_SCHLUESSEL = /^(token|password|passwort|secret|authorization|bearer|api[_-]?key|credential|cookie)/i;
const URSPRUNG_ARTEN = ['legacy_register', 'koordinator_voranlage', 'koordinator_start'] as const;

function pflichtText(v: unknown, code: string, max = 2000): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) throw new ProfilDienstFehler(code);
  return v.trim();
}
function iso(d: unknown): string | null {
  return d instanceof Date ? d.toISOString() : d == null ? null : String(d);
}

async function mitClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try { return await fn(c); } finally { c.release(); }
}
async function transaktion<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    if (e instanceof ProfilDienstFehler || e instanceof ProfilRevisionKonflikt) throw e;
    // DB-Fehler koennen Werte enthalten; nie weiterreichen.
    throw new ProfilDienstFehler((e as { code?: string } | null)?.code === '23505' ? 'eindeutigkeit_verletzt' : 'profil_speicher_fehler');
  } finally { c.release(); }
}
async function einmalig<T>(fn: () => Promise<T>, code: string): Promise<T> {
  try { return await fn(); } catch (e) {
    if ((e as { code?: string } | null)?.code === '23505') throw new ProfilDienstFehler(code);
    throw e;
  }
}
async function schalterEin(funktion: ProfilProduktFunktion, project: string | null): Promise<void> {
  if (funktion === 'agenten_ausweis') {
    // W12 V7: Schattenprofile haengen am Ausweis-Kern.
    const aktiv = project === null ? (await leseAusweisKern(null)).aktiv : await ausweisSchattenAktiv(project, false);
    if (!aktiv) throw new ProfilDienstFehler('funktion_aus', { funktion });
    return;
  }
  const s = await leseProfilProduktSchalter(funktion, project);
  if (s.letzter_fehler) throw new ProfilDienstFehler('produkt_schalter_nicht_lesbar');
  if (!s.aktiv) throw new ProfilDienstFehler('funktion_aus', { funktion });
}
async function sperreName(c: PoolClient, project: string, name: string): Promise<void> {
  // Gleicher Schluessel wie stelleAgentTokenAus: serialisiert die Instanznummer je Projekt/Name.
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([project, name])]);
}

/** User immer; Koordinator nur desselben Projekts und nur wenn die DB ihn als aktiven Koordinator kennt. */
async function pruefeVerwalter(c: PoolClient, akteur: AusweisAkteur, project: string, nurUser = false): Promise<Verwalter> {
  if (akteur?.art === 'user') return { wer: 'user', actor: null, user: true };
  if (nurUser) throw new ProfilDienstFehler('recht_fehlt');
  if (akteur?.art === 'legacy_koordinator') {
    // P22-T31 (Koordinator-Vorgabe 4fd83d8f): Legacy-Koordinator ohne eigenen Ausweis, Erkennung wie agent-token-abruf.ts
    // (Rolle/Namensmuster koordinator; der Name darf keiner Token-Identitaet gehoeren). Audit 'legacy:<id>'.
    const agent = typeof akteur.agent_id === 'string' ? akteur.agent_id.trim() : '';
    if (!agent || rolleFuerAgent(agent).rolle !== 'koordinator') throw new ProfilDienstFehler('recht_fehlt');
    const eigene = await c.query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 LIMIT 1', [project, agent]);
    if (eigene.rows[0]) throw new ProfilDienstFehler('recht_fehlt');
    return { wer: 'legacy:' + agent, actor: null, user: false };
  }
  if (akteur?.art !== 'identitaet') throw new ProfilDienstFehler('recht_fehlt');
  const p = akteur.principal;
  if (!p || p.project !== project || p.rolle !== 'koordinator') throw new ProfilDienstFehler('recht_fehlt');
  const r = await c.query<Zeile>("SELECT rolle FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv'", [p.identity_id, project]);
  if (r.rows[0]?.rolle !== 'koordinator') throw new ProfilDienstFehler('recht_fehlt');
  return { wer: p.identity_id, actor: p.identity_id, user: false };
}

// ---------------------------------------------------------------------------------------------
// Bereinigung und Validierung (keine Zugangswerte in Profildaten)
// ---------------------------------------------------------------------------------------------
function bereinige(wert: unknown, tiefe = 0): unknown {
  if (typeof wert === 'string') return wert.replace(AUSWEIS_ERSETZEN, '[ausweis]').slice(0, MAX_TEXT);
  if (wert === null || typeof wert === 'number' || typeof wert === 'boolean') return wert;
  if (tiefe >= 6) return undefined;
  if (Array.isArray(wert)) return wert.slice(0, 200).map(x => bereinige(x, tiefe + 1)).filter(x => x !== undefined);
  if (typeof wert === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(wert as Record<string, unknown>)) {
      if (GEHEIM_SCHLUESSEL.test(k)) continue;
      const b = bereinige(v, tiefe + 1);
      if (b !== undefined) o[k] = b;
    }
    return o;
  }
  return undefined;
}
function bereinigeSelbstangaben(s: unknown): SchattenSelbstangaben {
  const b = bereinige(s ?? {});
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ProfilDienstFehler('selbstangaben_ungueltig');
  if (JSON.stringify(b).length > 50_000) throw new ProfilDienstFehler('selbstangaben_zu_gross');
  return b as SchattenSelbstangaben;
}
function mergeSelbst(alt: SchattenSelbstangaben, neu: SchattenSelbstangaben): SchattenSelbstangaben {
  const r: Record<string, unknown> = { ...alt, ...neu };
  if (Array.isArray(alt.channels) && Array.isArray(neu.channels)) r.channels = [...new Set([...alt.channels, ...neu.channels])];
  if (alt.weitere && neu.weitere) r.weitere = { ...alt.weitere, ...neu.weitere };
  return r as SchattenSelbstangaben;
}
function tiefeSchluessel(v: unknown, tiefe = 0): string[] {
  if (!v || typeof v !== 'object' || tiefe > 8) return [];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [k, ...tiefeSchluessel(x, tiefe + 1)]);
}

const PROFIL_SCHLUESSEL = ['modell', 'provider', 'effort', 'kontextfenster', 'kontext_budget', 'kontext_stufe', 'rolle', 'regeln',
  'briefing', 'arbeitsweise', 'channels', 'zuschnitt', 'hinweise', 'startrezept'];
const ZUSCHNITT_SCHLUESSEL = ['standard', 'tools', 'aktionen', 'schreiben', 'shell_stufe_max', 'limits', 'intern_user_festgelegt'];
const REGELN = ['erlaubt', 'verweigert'];
function textOderNull(v: unknown, feld: string, max = 256): void {
  if (v === undefined || v === null) return;
  if (typeof v !== 'string' || v.length > max) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: [feld] });
}
function zahlOderNull(v: unknown, feld: string): void {
  if (v === undefined || v === null) return;
  if (!Number.isInteger(v) || (v as number) <= 0) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: [feld] });
}
function textListe(v: unknown, feld: string): void {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length > 200 || v.some(x => typeof x !== 'string' || x.length > 4000)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: [feld] });
}
function regelMap(v: unknown, feld: string, schluesselMuster: RegExp): void {
  if (v === undefined) return;
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: [feld] });
  for (const [k, x] of Object.entries(v)) {
    if (!schluesselMuster.test(k) || !REGELN.includes(x as string)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: [feld + '.' + k] });
  }
}

/** Strukturpruefung eines Profil-/Typ-Inhalts. Pflichthinweise sind nicht abschaltbar; keine Zugangswerte. */
export function pruefeProfilInhalt(inhalt: unknown): void {
  if (!inhalt || typeof inhalt !== 'object' || Array.isArray(inhalt)) throw new ProfilDienstFehler('inhalt_ungueltig');
  const o = inhalt as Record<string, unknown>;
  const unbekannt = Object.keys(o).filter(k => !PROFIL_SCHLUESSEL.includes(k));
  if (unbekannt.length) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: unbekannt });
  for (const f of ['modell', 'provider', 'effort']) textOrNullWrapper(o[f], f);
  textOderNull(o.briefing, 'briefing', 20_000);
  textOderNull(o.arbeitsweise, 'arbeitsweise', 20_000);
  zahlOderNull(o.kontextfenster, 'kontextfenster');
  zahlOderNull(o.kontext_budget, 'kontext_budget');
  if (o.kontext_stufe !== undefined && !['normal', 'kompakt', 'minimal'].includes(o.kontext_stufe as string)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['kontext_stufe'] });
  if (o.rolle !== undefined && (typeof o.rolle !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(o.rolle))) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['rolle'] });
  textListe(o.regeln, 'regeln');
  textListe(o.channels, 'channels');
  if (o.hinweise !== undefined) {
    if (!o.hinweise || typeof o.hinweise !== 'object' || Array.isArray(o.hinweise)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['hinweise'] });
    for (const [k, v] of Object.entries(o.hinweise)) {
      if (typeof v !== 'boolean') throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['hinweise.' + k] });
      const e = hinweisEintrag(k);
      if (!v && e?.klasse === 'pflicht') throw new ProfilDienstFehler('hinweis_pflicht_nicht_abschaltbar', { hinweis: k });
      if (!e && HINWEIS_KATALOG_VOLLSTAENDIG) throw new ProfilDienstFehler('hinweis_unbekannt', { hinweis: k });
    }
  }
  if (o.zuschnitt !== undefined) {
    const z = o.zuschnitt as Record<string, unknown> | null;
    if (!z || typeof z !== 'object' || Array.isArray(z)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['zuschnitt'] });
    const u = Object.keys(z).filter(k => !ZUSCHNITT_SCHLUESSEL.includes(k));
    if (u.length) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: u.map(k => 'zuschnitt.' + k) });
    if (z.standard !== undefined && !REGELN.includes(z.standard as string)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['zuschnitt.standard'] });
    regelMap(z.tools, 'zuschnitt.tools', /^[a-z0-9_]{1,64}$/i);
    regelMap(z.aktionen, 'zuschnitt.aktionen', /^[a-z0-9_]{1,64}\.[a-z0-9_]{1,64}$/i);
    if (z.schreiben !== undefined && typeof z.schreiben !== 'boolean') throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['zuschnitt.schreiben'] });
    if (z.shell_stufe_max !== undefined && !['laeuft', 'hinweis', 'anleitung', 'rueckfrage'].includes(z.shell_stufe_max as string)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['zuschnitt.shell_stufe_max'] });
    if (z.limits !== undefined) {
      const l = z.limits as Record<string, unknown>;
      if (!l || typeof l !== 'object' || Array.isArray(l) || Object.values(l).some(x => typeof x !== 'number' || !Number.isFinite(x) || x < 0)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['zuschnitt.limits'] });
    }
    const iu = z.intern_user_festgelegt;
    if (iu !== undefined && iu !== null && (typeof iu !== 'object' || typeof (iu as Record<string, unknown>).user_auftrag !== 'string' || !(iu as { user_auftrag: string }).user_auftrag.trim())) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['zuschnitt.intern_user_festgelegt'] });
  }
  if (o.startrezept !== undefined) {
    if (!o.startrezept || typeof o.startrezept !== 'object' || Array.isArray(o.startrezept)) throw new ProfilDienstFehler('inhalt_ungueltig', { felder: ['startrezept'] });
    if (tiefeSchluessel(o.startrezept).some(k => GEHEIM_SCHLUESSEL.test(k))) throw new ProfilDienstFehler('inhalt_enthaelt_zugangswert');
  }
  if (AUSWEIS_TEST.test(JSON.stringify(o))) throw new ProfilDienstFehler('inhalt_enthaelt_ausweis');
}
function textOrNullWrapper(v: unknown, feld: string): void { textOderNull(v, feld); }

// ---------------------------------------------------------------------------------------------
// Zeilen <-> Vertragstypen
// ---------------------------------------------------------------------------------------------
const SCHATTEN_SPALTEN = `id, project, ursprung_agent_id, ursprung_sitzung, ursprung_art, selbstangaben, korrektur, typ_id,
  zustand, revision, erstellt_am, ablauf_am, identity_id, entschieden_von, entschieden_am, user_zustimmung, grund`;
const SCHATTEN_MIT_TOKEN = SCHATTEN_SPALTEN + ', vorgesehener_token_hash, vorgesehener_token_verschluesselt, vorgesehener_token_schluessel_id';

function zuSchatten(r: Zeile): Schattenprofil {
  return {
    id: r.id, project: r.project, ursprung_agent_id: r.ursprung_agent_id, ursprung_sitzung: r.ursprung_sitzung ?? null,
    ursprung_art: r.ursprung_art, selbstangaben: r.selbstangaben ?? {}, korrektur: r.korrektur ?? {}, typ_id: r.typ_id ?? null,
    zustand: wirksamerSchattenZustand({ zustand: r.zustand as SchattenZustand, ablauf_am: r.ablauf_am }),
    revision: r.revision, erstellt_am: iso(r.erstellt_am) as string, ablauf_am: iso(r.ablauf_am) as string,
    identity_id: r.identity_id ?? null, entschieden_von: r.entschieden_von ?? null, entschieden_am: iso(r.entschieden_am),
    user_zustimmung: r.user_zustimmung ?? null, grund: r.grund ?? null,
  };
}
function zuTyp(r: Zeile): AgentTyp {
  return { id: r.id, scope: r.scope, project: r.project ?? null, schluessel: r.schluessel, aktuelle_revision: r.aktuelle_revision, status: r.status };
}
async function schattenAudit(c: PoolClient, id: string, v: { wer: string; actor: string | null }, aktion: string, alt: unknown, neu: unknown, grund?: string | null): Promise<void> {
  await c.query(`INSERT INTO agent_schattenprofil_audit (schattenprofil_id, wer, actor_identity_id, aktion, alt, neu, grund)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)`, [id, v.wer, v.actor, aktion, JSON.stringify(alt ?? null), JSON.stringify(neu ?? null), grund ?? null]);
}
export async function identitaetAudit(c: PoolClient, identityId: string, v: { wer: string; actor: string | null }, aktion: string, alt: unknown, neu: unknown, grund?: string | null): Promise<void> {
  await c.query(`INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`, [identityId, v.wer, aktion, JSON.stringify(alt ?? null), JSON.stringify(neu ?? null), grund ?? null, v.actor]);
}

// ---------------------------------------------------------------------------------------------
// Schattenprofil
// ---------------------------------------------------------------------------------------------
async function projektVonSchatten(id: string): Promise<string> {
  const r = await mitClient(c => c.query<Zeile>('SELECT project FROM agent_schattenprofile WHERE id=$1', [id]));
  if (!r.rows[0]) throw new ProfilDienstFehler('schattenprofil_unbekannt');
  return r.rows[0].project;
}
function offenPruefen(row: Zeile): void {
  const z = wirksamerSchattenZustand({ zustand: row.zustand, ablauf_am: row.ablauf_am });
  if (z === 'abgelaufen') throw new ProfilDienstFehler('schattenprofil_abgelaufen');
  if (z === 'abgelehnt') throw new ProfilDienstFehler('schattenprofil_abgelehnt');
  if (z === 'bestaetigt') throw new ProfilDienstFehler('schattenprofil_bereits_bestaetigt');
}
async function sperreSchatten(c: PoolClient, id: string, mitToken = false): Promise<Zeile> {
  const r = await c.query<Zeile>(`SELECT ${mitToken ? SCHATTEN_MIT_TOKEN : SCHATTEN_SPALTEN} FROM agent_schattenprofile WHERE id=$1 FOR UPDATE`, [id]);
  if (!r.rows[0]) throw new ProfilDienstFehler('schattenprofil_unbekannt');
  return r.rows[0];
}
async function verfalleZeile(c: PoolClient, id: string, jetzt: Date): Promise<void> {
  // Ablauf ohne Datenverlust: Angaben bleiben; nur der vorgesehene Token verfaellt.
  await c.query(`UPDATE agent_schattenprofile SET zustand='abgelaufen', entschieden_von='system', entschieden_am=$2,
      grund=COALESCE(grund,'frist_24h_abgelaufen'), vorgesehener_token_verschluesselt=NULL, vorgesehener_token_schluessel_id=NULL
    WHERE id=$1 AND zustand='pending'`, [id, jetzt]);
  await schattenAudit(c, id, { wer: 'system', actor: null }, 'abgelaufen', { zustand: 'pending' }, { zustand: 'abgelaufen' }, 'frist_24h_abgelaufen');
}

async function legeSchattenprofilAn(e: SchattenAnlage, akteur: W1bAkteur): Promise<Schattenprofil> {
  const project = pflichtText(e?.project, 'project_fehlt', 256);
  const agentId = pflichtText(e.ursprung_agent_id, 'agent_id_fehlt', 256);
  if (!(URSPRUNG_ARTEN as readonly string[]).includes(e.ursprung_art)) throw new ProfilDienstFehler('ursprung_art_ungueltig');
  await schalterEin('agenten_ausweis', project);
  const selbst = bereinigeSelbstangaben(e.selbstangaben);
  return transaktion(async (c) => {
    // Anlage: User, Daemon (automatische Legacy-/Startanlage) oder Koordinator des Projekts; Voranlage nie durch Daemon.
    let v: Verwalter;
    if (akteur?.art === 'daemon') {
      if (e.ursprung_art === 'koordinator_voranlage') throw new ProfilDienstFehler('recht_fehlt');
      v = { wer: 'daemon', actor: null, user: false };
    } else v = await pruefeVerwalter(c, akteur, project);
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['w1b-schatten', project, agentId])]);
    const vorhanden = await c.query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2', [project, agentId]);
    // Weitere Koordinatoren (koordinator_start) melden sich unter dem Legacy-Namen eines vorhandenen Koordinatorprofils; die Bestaetigung nummeriert (koordinator#N).
    if (vorhanden.rows.length && e.ursprung_art !== 'koordinator_start') throw new ProfilDienstFehler('identitaet_existiert');
    const jetzt = new Date();
    const offen = await c.query<Zeile>(`SELECT ${SCHATTEN_SPALTEN} FROM agent_schattenprofile WHERE project=$1 AND ursprung_agent_id=$2 AND zustand='pending' FOR UPDATE`, [project, agentId]);
    const alt = offen.rows[0];
    if (alt && new Date(alt.ablauf_am).getTime() > jetzt.getTime()) {
      // Dedupe je Vorgang: Frist bleibt, Aktivitaet verlaengert nicht.
      const merged = mergeSelbst(alt.selbstangaben ?? {}, selbst);
      if (JSON.stringify(merged) === JSON.stringify(alt.selbstangaben ?? {})) return zuSchatten(alt);
      const u = await c.query<Zeile>(`UPDATE agent_schattenprofile SET selbstangaben=$2::jsonb, revision=revision+1 WHERE id=$1 RETURNING ${SCHATTEN_SPALTEN}`, [alt.id, JSON.stringify(merged)]);
      await schattenAudit(c, alt.id, v, 'selbstangaben_aktualisiert', { revision: alt.revision }, { revision: u.rows[0].revision });
      return zuSchatten(u.rows[0]);
    }
    if (alt) await verfalleZeile(c, alt.id, jetzt);
    const id = randomUUID();
    // W12 V2 Weg A: der Schatten traegt KEINEN Token; der Ausweis entsteht erst mit der Bestaetigung.
    const r = await c.query<Zeile>(`INSERT INTO agent_schattenprofile (id, project, ursprung_agent_id, ursprung_sitzung, ursprung_art, selbstangaben,
        erstellt_am, ablauf_am)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING ${SCHATTEN_SPALTEN}`,
      [id, project, agentId, e.ursprung_sitzung ?? null, e.ursprung_art, JSON.stringify(selbst), jetzt, schattenAblauf(jetzt)]);
    await schattenAudit(c, id, v, 'angelegt', null, { ursprung_art: e.ursprung_art, ablauf_am: iso(r.rows[0].ablauf_am) });
    return zuSchatten(r.rows[0]);
  });
}

async function listeSchattenprofile(project: string, akteur: AusweisAkteur, filter?: { zustand?: SchattenZustand }): Promise<Schattenprofil[]> {
  const p = pflichtText(project, 'project_fehlt', 256);
  // P22-T31: wie alle Schatten-Pfade am Ausweis-Kern (nicht am Altschalter schattenprofile).
  await schalterEin('agenten_ausweis', p);
  return mitClient(async (c) => {
    await pruefeVerwalter(c, akteur, p);
    const r = await c.query<Zeile>(`SELECT ${SCHATTEN_SPALTEN} FROM agent_schattenprofile WHERE project=$1 ORDER BY erstellt_am DESC, id`, [p]);
    const liste = r.rows.map(zuSchatten);
    return filter?.zustand ? liste.filter(s => s.zustand === filter.zustand) : liste;
  });
}

async function korrigiereSchattenprofil(id: string, erwartete_revision: number, korrektur: Partial<ProfilInhalt>, akteur: AusweisAkteur, grund: string): Promise<Schattenprofil> {
  const g = pflichtText(grund, 'grund_fehlt');
  const project = await projektVonSchatten(id);
  await schalterEin('agenten_ausweis', project);
  pruefeProfilInhalt(korrektur);
  return transaktion(async (c) => {
    const row = await sperreSchatten(c, id);
    const v = await pruefeVerwalter(c, akteur, project);
    offenPruefen(row);
    if (row.revision !== erwartete_revision) throw new ProfilRevisionKonflikt(row.revision);
    const neu = { ...(row.korrektur ?? {}), ...korrektur };
    const u = await c.query<Zeile>(`UPDATE agent_schattenprofile SET korrektur=$2::jsonb, revision=revision+1 WHERE id=$1 RETURNING ${SCHATTEN_SPALTEN}`, [id, JSON.stringify(neu)]);
    await schattenAudit(c, id, v, 'korrigiert', { korrektur: row.korrektur, revision: row.revision }, { korrektur: neu, revision: u.rows[0].revision }, g);
    return zuSchatten(u.rows[0]);
  });
}

export async function sichtbarerTyp(c: PoolClient, typId: string, project: string): Promise<Zeile> {
  const r = await c.query<Zeile>(`SELECT id, scope, project, schluessel, aktuelle_revision, status FROM agent_typen
    WHERE id=$1 AND (scope='global' OR project=$2)`, [typId, project]);
  if (!r.rows[0]) throw new ProfilDienstFehler('typ_unbekannt');
  if (r.rows[0].status !== 'aktiv') throw new ProfilDienstFehler('typ_deaktiviert');
  return r.rows[0];
}

/** Zerlegt einen Inhalt in die Identitaetsspalten (rolle, modell_bestaetigt, startrezept, Rest = profil). */
export function spaltenAusInhalt(inhalt: Record<string, unknown>): { profil: Record<string, unknown>; rolle: string; modell: string | null; startrezept: Record<string, unknown> } {
  const { rolle, modell, startrezept, ...profil } = inhalt;
  return { profil, rolle: typeof rolle === 'string' ? rolle : 'subagent', modell: typeof modell === 'string' ? modell : null,
    startrezept: startrezept && typeof startrezept === 'object' ? startrezept as Record<string, unknown> : {} };
}
function inhaltAusZeile(i: Zeile): Record<string, unknown> {
  const o: Record<string, unknown> = { ...(i.profil ?? {}), rolle: i.rolle };
  if (i.modell_bestaetigt != null) o.modell = i.modell_bestaetigt;
  if (i.startrezept && Object.keys(i.startrezept).length) o.startrezept = i.startrezept;
  return o;
}
function snapshotAusInhalt(inhalt: Record<string, unknown>): Record<string, unknown> {
  return { ...inhalt, modell_bestaetigt: (inhalt.modell as string | null | undefined) ?? null };
}
export async function schreibeProfilRevision(c: PoolClient, identityId: string, revision: number, inhalt: Record<string, unknown>,
  typId: string | null, typRevision: number | null, v: Verwalter, userAuftrag: string | null, grund: string): Promise<void> {
  const pz = await c.query<Zeile>('SELECT vorlage_id, version FROM agent_persona_zuweisungen WHERE identity_id=$1', [identityId]);
  await c.query(`INSERT INTO agent_profil_revisionen (identity_id, revision, snapshot, typ_id, typ_revision, persona_vorlage_id, persona_version,
      wer, actor_identity_id, user_auftrag, grund) VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [identityId, revision, JSON.stringify(snapshotAusInhalt(inhalt)), typId, typRevision, pz.rows[0]?.vorlage_id ?? null,
      pz.rows[0]?.version ?? null, v.wer, v.actor, userAuftrag, grund]);
}

async function bestaetigeSchattenprofil(b: SchattenBestaetigung, akteur: AusweisAkteur): Promise<{ schattenprofil: Schattenprofil; identity_id: string; profil_revision: number }> {
  const id = pflichtText(b?.schattenprofil_id, 'schattenprofil_id_fehlt', 128);
  const zustimmung = pflichtText(b.user_zustimmung, 'user_zustimmung_fehlt');
  const grund = pflichtText(b.grund, 'grund_fehlt');
  const project = await projektVonSchatten(id);
  await schalterEin('agenten_ausweis', project);
  if (b.korrektur !== undefined) pruefeProfilInhalt(b.korrektur);
  return transaktion(async (c) => {
    const row = await sperreSchatten(c, id, true);
    const daemon = akteur?.art === 'daemon';
    let v: Verwalter;
    if (daemon) {
      // K3C: nur der erste Koordinator-Startfall darf ohne vorhandenen Koordinator bestaetigt werden.
      if (row.ursprung_art !== 'koordinator_start') throw new ProfilDienstFehler('recht_fehlt');
      v = { wer: 'daemon', actor: null, user: false };
    } else v = await pruefeVerwalter(c, akteur, project);
    if (row.zustand === 'bestaetigt') {
      // Doppelbestaetigung: keine zweite Identitaet, kein zweiter Token.
      const i = await c.query<Zeile>('SELECT profil_revision FROM agent_identitaeten WHERE id=$1', [row.identity_id]);
      return { schattenprofil: zuSchatten(row), identity_id: row.identity_id, profil_revision: i.rows[0]?.profil_revision ?? 1 };
    }
    offenPruefen(row);
    if (row.revision !== b.erwartete_revision) throw new ProfilRevisionKonflikt(row.revision);
    const korrektur: Record<string, unknown> = { ...(row.korrektur ?? {}), ...(b.korrektur ?? {}) };
    let rolle = typeof korrektur.rolle === 'string' ? korrektur.rolle : (row.ursprung_art === 'koordinator_start' ? 'koordinator' : 'subagent');
    if (daemon) {
      rolle = 'koordinator';
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['w1b-erster-koordinator', project])]);
      const k = await c.query("SELECT 1 FROM agent_identitaeten WHERE project=$1 AND rolle='koordinator' LIMIT 1", [project]);
      if (k.rows.length) throw new ProfilDienstFehler('erster_koordinator_vergeben');
    }
    korrektur.rolle = rolle;
    const typId = b.typ_id !== undefined ? b.typ_id : (row.typ_id as string | null);
    const typ = typId ? await sichtbarerTyp(c, typId, project) : null;
    // Identitaetsname: der real angemeldete Ursprungs-Agent, nie eine Selbstangabe.
    const m = /^(.+)#(\d+)$/.exec(row.ursprung_agent_id as string);
    let name = rolle === 'koordinator' ? 'koordinator' : (m ? m[1] : row.ursprung_agent_id as string);
    if (name.trim().toLowerCase() === 'user' || name.includes('#') || !name.trim()) throw new ProfilDienstFehler('identitaet_parameter_ungueltig');
    await sperreName(c, project, name);
    let instanz: number;
    if (rolle === 'koordinator') {
      const nr = await c.query<Zeile>("SELECT COALESCE(MAX(instanz_nr),0)+1 AS nr FROM agent_identitaeten WHERE project=$1 AND (name=$2 OR rolle='koordinator')", [project, name]);
      instanz = Number(nr.rows[0].nr);
    } else {
      instanz = m ? Number(m[2]) : 1;
      const belegt = await c.query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND (agent_id=$2 OR (name=$3 AND instanz_nr=$4))', [project, row.ursprung_agent_id, name, instanz]);
      if (belegt.rows.length) throw new ProfilDienstFehler('identitaet_existiert');
    }
    const agentId = instanz === 1 ? name : `${name}#${instanz}`;
    const { profil, modell, startrezept } = spaltenAusInhalt(korrektur);
    const identityId = randomUUID();
    const selbstModell = typeof row.selbstangaben?.modell === 'string' ? row.selbstangaben.modell : null;
    await einmalig(() => c.query(`INSERT INTO agent_identitaeten (id, project, name, instanz_nr, agent_id, rolle, modell_bestaetigt, modell_selbstauskunft,
        profil, startrezept, erstellt_von, erstellt_von_identity_id, profil_revision, typ_id, typ_revision)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,1,$13,$14)`,
      [identityId, project, name, instanz, agentId, rolle, modell, selbstModell, JSON.stringify(profil), JSON.stringify(startrezept),
        v.wer, v.actor, typ?.id ?? null, typ?.aktuelle_revision ?? null]), 'identitaet_existiert');
    // W12 V2 Weg A: erst mit der Bestaetigung entsteht der Ausweis - offen gespeichert, sofort 'aktiv' (ausweis_weg schatten_bestaetigt).
    const klar = 'sai_' + randomBytes(32).toString('hex');
    const tokenId = randomUUID();
    await c.query(`INSERT INTO agent_identitaet_tokens (id, identity_id, token_offen, token_praefix, ausweis_weg)
      VALUES ($1,$2,$3,$4,'schatten_bestaetigt')`, [tokenId, identityId, klar, klar.slice(0, 12)]);
    await schreibeProfilRevision(c, identityId, 1, korrektur, typ?.id ?? null, typ?.aktuelle_revision ?? null, v, zustimmung, grund);
    await c.query(`UPDATE agent_schattenprofile SET zustand='bestaetigt', revision=revision+1, korrektur=$2::jsonb, typ_id=$3, identity_id=$4,
        entschieden_von=$5, entschieden_von_identity_id=$6, entschieden_am=NOW(), user_zustimmung=$7, grund=$8,
        vorgesehener_token_verschluesselt=NULL, vorgesehener_token_schluessel_id=NULL WHERE id=$1`,
      [id, JSON.stringify(korrektur), typ?.id ?? null, identityId, v.wer, v.actor, zustimmung, grund]);
    await identitaetAudit(c, identityId, v, 'ausstellen', null, { project, name, instanz_nr: instanz, rolle, schattenprofil_id: id }, grund);
    await identitaetAudit(c, identityId, v, 'profil_bestaetigt', null, { profil_revision: 1, typ_id: typ?.id ?? null, user_zustimmung: zustimmung }, grund);
    await identitaetAudit(c, identityId, v, 'token_ausstellen', null, { token_id: tokenId, token_praefix: klar.slice(0, 12) }, grund);
    await schattenAudit(c, id, v, 'bestaetigt', { zustand: 'pending', revision: row.revision }, { zustand: 'bestaetigt', identity_id: identityId, typ_id: typ?.id ?? null }, grund + ' | zustimmung: ' + zustimmung);
    const fertig = await c.query<Zeile>(`SELECT ${SCHATTEN_SPALTEN} FROM agent_schattenprofile WHERE id=$1`, [id]);
    return { schattenprofil: zuSchatten(fertig.rows[0]), identity_id: identityId, profil_revision: 1 };
  });
}

async function lehneSchattenprofilAb(id: string, erwartete_revision: number, akteur: AusweisAkteur, grund: string): Promise<Schattenprofil> {
  const g = pflichtText(grund, 'grund_fehlt');
  const project = await projektVonSchatten(id);
  await schalterEin('agenten_ausweis', project);
  return transaktion(async (c) => {
    const row = await sperreSchatten(c, id);
    const v = await pruefeVerwalter(c, akteur, project);
    if (row.zustand === 'abgelehnt') return zuSchatten(row);
    offenPruefen(row);
    if (row.revision !== erwartete_revision) throw new ProfilRevisionKonflikt(row.revision);
    const u = await c.query<Zeile>(`UPDATE agent_schattenprofile SET zustand='abgelehnt', revision=revision+1, entschieden_von=$2, entschieden_von_identity_id=$3,
        entschieden_am=NOW(), grund=$4, vorgesehener_token_verschluesselt=NULL, vorgesehener_token_schluessel_id=NULL
      WHERE id=$1 RETURNING ${SCHATTEN_SPALTEN}`, [id, v.wer, v.actor, g]);
    await schattenAudit(c, id, v, 'abgelehnt', { zustand: 'pending', revision: row.revision }, { zustand: 'abgelehnt' }, g);
    return zuSchatten(u.rows[0]);
  });
}

async function verfalleAbgelaufene(project?: string, jetzt: Date = new Date()): Promise<number> {
  return transaktion(async (c) => {
    const r = await c.query<Zeile>(`SELECT id FROM agent_schattenprofile WHERE zustand='pending' AND ablauf_am <= $1 AND ($2::text IS NULL OR project=$2) FOR UPDATE`, [jetzt, project ?? null]);
    for (const z of r.rows) await verfalleZeile(c, z.id, jetzt);
    return r.rows.length;
  });
}

// ---------------------------------------------------------------------------------------------
// Typ-Katalog
// ---------------------------------------------------------------------------------------------
const TYP_SCHLUESSEL = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function listeTypen(project: string, akteur: W1bAkteur): Promise<AgentTyp[]> {
  const p = pflichtText(project, 'project_fehlt', 256);
  await schalterEin('typkatalog', p);
  return mitClient(async (c) => {
    await pruefeVerwalter(c, akteur, p);
    const r = await c.query<Zeile>(`SELECT id, scope, project, schluessel, aktuelle_revision, status FROM agent_typen
      WHERE scope='global' OR (scope='projekt' AND project=$1) ORDER BY scope, schluessel`, [p]);
    return r.rows.map(zuTyp);
  });
}

async function legeTypAn(e: { scope: 'global' | 'projekt'; project?: string | null; schluessel: string; inhalt: ProfilInhalt; grund: string }, akteur: W1bAkteur): Promise<AgentTyp> {
  if (e?.scope !== 'global' && e?.scope !== 'projekt') throw new ProfilDienstFehler('scope_ungueltig');
  const project = e.scope === 'projekt' ? pflichtText(e.project, 'project_fehlt', 256) : null;
  if (typeof e.schluessel !== 'string' || !TYP_SCHLUESSEL.test(e.schluessel)) throw new ProfilDienstFehler('typ_schluessel_ungueltig');
  const grund = pflichtText(e.grund, 'grund_fehlt');
  pruefeProfilInhalt(e.inhalt);
  await schalterEin('typkatalog', project);
  return transaktion(async (c) => {
    const v = await pruefeVerwalter(c, akteur, project ?? '', e.scope === 'global');
    const id = randomUUID();
    const r = await einmalig(() => c.query<Zeile>(`INSERT INTO agent_typen (id, scope, project, schluessel, aktuelle_revision, erstellt_von, erstellt_von_identity_id)
      VALUES ($1,$2,$3,$4,1,$5,$6) RETURNING id, scope, project, schluessel, aktuelle_revision, status`, [id, e.scope, project, e.schluessel, v.wer, v.actor]), 'typ_existiert');
    await c.query(`INSERT INTO agent_typ_revisionen (typ_id, revision, inhalt, wer, actor_identity_id, grund) VALUES ($1,1,$2::jsonb,$3,$4,$5)`,
      [id, JSON.stringify(e.inhalt), v.wer, v.actor, grund]);
    return zuTyp(r.rows[0]);
  });
}

async function aendereTyp(typ_id: string, erwartete_revision: number, inhalt: ProfilInhalt, akteur: W1bAkteur, grund: string): Promise<AgentTyp> {
  const g = pflichtText(grund, 'grund_fehlt');
  pruefeProfilInhalt(inhalt);
  const t0 = await mitClient(c => c.query<Zeile>('SELECT scope, project FROM agent_typen WHERE id=$1', [typ_id]));
  if (!t0.rows[0]) throw new ProfilDienstFehler('typ_unbekannt');
  await schalterEin('typkatalog', t0.rows[0].project ?? null);
  return transaktion(async (c) => {
    const t = await c.query<Zeile>('SELECT id, scope, project, schluessel, aktuelle_revision, status FROM agent_typen WHERE id=$1 FOR UPDATE', [typ_id]);
    const row = t.rows[0];
    if (!row) throw new ProfilDienstFehler('typ_unbekannt');
    const v = await pruefeVerwalter(c, akteur, row.project ?? '', row.scope === 'global');
    if (row.aktuelle_revision !== erwartete_revision) throw new ProfilRevisionKonflikt(row.aktuelle_revision);
    const neu = row.aktuelle_revision + 1;
    await c.query('UPDATE agent_typen SET aktuelle_revision=$2 WHERE id=$1', [typ_id, neu]);
    await c.query(`INSERT INTO agent_typ_revisionen (typ_id, revision, inhalt, wer, actor_identity_id, grund) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
      [typ_id, neu, JSON.stringify(inhalt), v.wer, v.actor, g]);
    return zuTyp({ ...row, aktuelle_revision: neu });
  });
}

async function leseTypRevision(typ_id: string, revision?: number): Promise<AgentTypRevision> {
  return mitClient(async (c) => {
    const t = await c.query<Zeile>('SELECT id, project, aktuelle_revision FROM agent_typen WHERE id=$1', [typ_id]);
    if (!t.rows[0]) throw new ProfilDienstFehler('typ_unbekannt');
    await schalterEin('typkatalog', t.rows[0].project ?? null);
    const rev = revision ?? t.rows[0].aktuelle_revision;
    const r = await c.query<Zeile>('SELECT typ_id, revision, inhalt, wer, grund, wann FROM agent_typ_revisionen WHERE typ_id=$1 AND revision=$2', [typ_id, rev]);
    if (!r.rows[0]) throw new ProfilDienstFehler('typ_revision_unbekannt');
    return { typ_id, revision: r.rows[0].revision, inhalt: r.rows[0].inhalt, wer: r.rows[0].wer, grund: r.rows[0].grund ?? null, wann: iso(r.rows[0].wann) as string };
  });
}

/**
 * Vererbung (K5): ein Projekttyp ergaenzt/ueberschreibt den gleichnamigen aktiven globalen Typ; Felder werden
 * je Top-Level-Schluessel ersetzt, die Herkunft je Feld ist nachvollziehbar. Persona gehoert nie zum Typ.
 * Interner Lesepfad fuer Paket C (kein Schalter, keine Akteurspruefung).
 */
export async function leseWirksamenTypInhalt(typ_id: string, revision?: number): Promise<{ typ: AgentTyp; revision: number; inhalt: ProfilInhalt; herkunft: Partial<Record<keyof ProfilInhalt, FeldHerkunft>> }> {
  return mitClient(async (c) => {
    const t = await c.query<Zeile>('SELECT id, scope, project, schluessel, aktuelle_revision, status FROM agent_typen WHERE id=$1', [typ_id]);
    if (!t.rows[0]) throw new ProfilDienstFehler('typ_unbekannt');
    const typ = t.rows[0];
    const inhalt: Record<string, unknown> = {};
    const herkunft: Record<string, FeldHerkunft> = {};
    const anwenden = (quelle: Record<string, unknown>, h: FeldHerkunft) => {
      for (const [k, x] of Object.entries(quelle)) { inhalt[k] = x; herkunft[k] = h; }
    };
    if (typ.scope === 'projekt') {
      const g = await c.query<Zeile>(`SELECT r.inhalt FROM agent_typen t JOIN agent_typ_revisionen r ON r.typ_id=t.id AND r.revision=t.aktuelle_revision
        WHERE t.scope='global' AND t.schluessel=$1 AND t.status='aktiv'`, [typ.schluessel]);
      if (g.rows[0]) anwenden(g.rows[0].inhalt, 'global_typ');
    }
    const rev = revision ?? typ.aktuelle_revision;
    const r = await c.query<Zeile>('SELECT inhalt FROM agent_typ_revisionen WHERE typ_id=$1 AND revision=$2', [typ_id, rev]);
    if (!r.rows[0]) throw new ProfilDienstFehler('typ_revision_unbekannt');
    anwenden(r.rows[0].inhalt, typ.scope === 'global' ? 'global_typ' : 'projekt_typ');
    return { typ: zuTyp(typ), revision: rev, inhalt: inhalt as ProfilInhalt, herkunft: herkunft as Partial<Record<keyof ProfilInhalt, FeldHerkunft>> };
  });
}

// ---------------------------------------------------------------------------------------------
// Identitaetsprofil
// ---------------------------------------------------------------------------------------------
async function projektVonIdentitaet(id: string): Promise<string> {
  const r = await mitClient(c => c.query<Zeile>('SELECT project FROM agent_identitaeten WHERE id=$1', [id]));
  if (!r.rows[0]) throw new ProfilDienstFehler('identitaet_unbekannt');
  return r.rows[0].project;
}
async function sperreIdentitaet(c: PoolClient, id: string): Promise<Zeile> {
  const r = await c.query<Zeile>(`SELECT id, project, rolle, modell_bestaetigt, profil, startrezept, profil_revision, typ_id, typ_revision, status
    FROM agent_identitaeten WHERE id=$1 FOR UPDATE`, [id]);
  if (!r.rows[0]) throw new ProfilDienstFehler('identitaet_unbekannt');
  return r.rows[0];
}
/** F2: User/Koordinator desselben Projekts; Koordinator-Eigenprofil nur im einmaligen Startfenster mit User-Auftrag. */
async function pruefeProfilRecht(c: PoolClient, akteur: W1bAkteur, ziel: Zeile, userAuftrag?: string): Promise<Verwalter> {
  const v = await pruefeVerwalter(c, akteur, ziel.project);
  let startfenster = false;
  if (!v.user && v.actor === ziel.id) {
    const s = await c.query(`SELECT 1 FROM agent_schattenprofile WHERE identity_id=$1 AND ursprung_art='koordinator_start' AND zustand='bestaetigt'`, [ziel.id]);
    startfenster = s.rows.length > 0 && ziel.profil_revision === 1 && typeof userAuftrag === 'string' && userAuftrag.trim().length > 0;
  }
  if (!darfProfilAendern(akteur, { identity_id: ziel.id, project: ziel.project }, { ersterKoordinatorStart: startfenster })) {
    throw new ProfilDienstFehler('eigenprofil_nicht_aenderbar');
  }
  return v;
}
function internFestlegung(z: unknown): string {
  const iu = (z as { intern_user_festgelegt?: unknown } | null | undefined)?.intern_user_festgelegt;
  return JSON.stringify(iu ?? null);
}

async function aendereProfil(a: ProfilAenderung, akteur: W1bAkteur): Promise<{ profil_revision: number }> {
  const grund = pflichtText(a?.grund, 'grund_fehlt');
  if (!Number.isInteger(a.erwartete_revision) || a.erwartete_revision < 0) throw new ProfilDienstFehler('revision_ungueltig');
  const project = await projektVonIdentitaet(a.identity_id);
  await schalterEin('profilverwaltung', project);
  pruefeProfilInhalt(a.patch ?? {});
  return transaktion(async (c) => {
    const i = await sperreIdentitaet(c, a.identity_id);
    const v = await pruefeProfilRecht(c, akteur, i, a.user_auftrag);
    if (i.profil_revision !== a.erwartete_revision) throw new ProfilRevisionKonflikt(i.profil_revision);
    const alt = inhaltAusZeile(i);
    const neu: Record<string, unknown> = { ...alt };
    for (const [k, x] of Object.entries(a.patch ?? {})) if (x !== undefined) neu[k] = x;
    if (a.patch?.zuschnitt && internFestlegung(a.patch.zuschnitt) !== internFestlegung(alt.zuschnitt) && !v.user) throw new ProfilDienstFehler('intern_festlegung_nur_user');
    let typId: string | null = i.typ_id ?? null;
    let typRev: number | null = i.typ_revision ?? null;
    if (a.typ_id !== undefined) {
      if (a.typ_id === null) { typId = null; typRev = null; } else {
        const t = await sichtbarerTyp(c, a.typ_id, i.project);
        typId = t.id; typRev = t.aktuelle_revision;
      }
    }
    const { profil, rolle, modell, startrezept } = spaltenAusInhalt(neu);
    const revision = i.profil_revision + 1;
    await c.query(`UPDATE agent_identitaeten SET profil=$2::jsonb, rolle=$3, modell_bestaetigt=$4, startrezept=$5::jsonb, profil_revision=$6, typ_id=$7, typ_revision=$8 WHERE id=$1`,
      [i.id, JSON.stringify(profil), rolle, modell, JSON.stringify(startrezept), revision, typId, typRev]);
    await schreibeProfilRevision(c, i.id, revision, neu, typId, typRev, v, a.user_auftrag?.trim() || null, grund);
    await identitaetAudit(c, i.id, v, 'profil_geaendert', { profil_revision: i.profil_revision, inhalt: alt }, { profil_revision: revision, inhalt: neu }, grund);
    return { profil_revision: revision };
  });
}

async function profilHistorie(identity_id: string, akteur: W1bAkteur): Promise<ProfilRevision[]> {
  const project = await projektVonIdentitaet(identity_id);
  await schalterEin('profilverwaltung', project);
  return mitClient(async (c) => {
    // Eigenprofil ist fuer den Agenten selbst lesbar (K10A); fremde Profile nur User/Koordinator des Projekts.
    const p = akteur?.art === 'identitaet' ? akteur.principal : null;
    const selbst = !!p && p.identity_id === identity_id && p.project === project;
    if (selbst) {
      const s = await c.query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv'", [identity_id, project]);
      if (!s.rows.length) throw new ProfilDienstFehler('recht_fehlt');
    } else await pruefeVerwalter(c, akteur, project);
    const r = await c.query<Zeile>(`SELECT identity_id, revision, snapshot, typ_id, typ_revision, persona_vorlage_id, persona_version, wer, user_auftrag, grund, wann
      FROM agent_profil_revisionen WHERE identity_id=$1 ORDER BY revision`, [identity_id]);
    return r.rows.map((z): ProfilRevision => ({ identity_id: z.identity_id, revision: z.revision, snapshot: z.snapshot, typ_id: z.typ_id ?? null,
      typ_revision: z.typ_revision ?? null, persona_vorlage_id: z.persona_vorlage_id ?? null, persona_version: z.persona_version ?? null,
      wer: z.wer, user_auftrag: z.user_auftrag ?? null, grund: z.grund, wann: iso(z.wann) as string }));
  });
}

/** Rollback = NEUE auditierte Revision mit dem Stand der Zielrevision; Persona-Zuweisungen werden nie angefasst (K7). */
async function rollbackProfil(identity_id: string, ziel_revision: number, erwartete_revision: number, akteur: W1bAkteur, grund: string): Promise<{ profil_revision: number }> {
  const g = pflichtText(grund, 'grund_fehlt');
  if (!Number.isInteger(ziel_revision) || ziel_revision < 1) throw new ProfilDienstFehler('revision_ungueltig');
  const project = await projektVonIdentitaet(identity_id);
  await schalterEin('profilverwaltung', project);
  return transaktion(async (c) => {
    const i = await sperreIdentitaet(c, identity_id);
    const v = await pruefeProfilRecht(c, akteur, i);
    if (i.profil_revision !== erwartete_revision) throw new ProfilRevisionKonflikt(i.profil_revision);
    const z = await c.query<Zeile>('SELECT snapshot, typ_id FROM agent_profil_revisionen WHERE identity_id=$1 AND revision=$2', [identity_id, ziel_revision]);
    if (!z.rows[0]) throw new ProfilDienstFehler('revision_unbekannt');
    const alt = inhaltAusZeile(i);
    const { modell_bestaetigt, ...rest } = z.rows[0].snapshot as Record<string, unknown>;
    const ziel: Record<string, unknown> = { ...rest };
    if (ziel.modell === undefined && typeof modell_bestaetigt === 'string') ziel.modell = modell_bestaetigt;
    let typId: string | null = null;
    let typRev: number | null = null;
    if (z.rows[0].typ_id) {
      const t = await c.query<Zeile>("SELECT id, aktuelle_revision FROM agent_typen WHERE id=$1 AND status='aktiv'", [z.rows[0].typ_id]);
      if (t.rows[0]) { typId = t.rows[0].id; typRev = t.rows[0].aktuelle_revision; }
    }
    const { profil, rolle, modell, startrezept } = spaltenAusInhalt(ziel);
    const revision = i.profil_revision + 1;
    await c.query(`UPDATE agent_identitaeten SET profil=$2::jsonb, rolle=$3, modell_bestaetigt=$4, startrezept=$5::jsonb, profil_revision=$6, typ_id=$7, typ_revision=$8 WHERE id=$1`,
      [i.id, JSON.stringify(profil), rolle, modell, JSON.stringify(startrezept), revision, typId, typRev]);
    await schreibeProfilRevision(c, i.id, revision, ziel, typId, typRev, v, null, `Rollback auf Revision ${ziel_revision}: ${g}`);
    await identitaetAudit(c, i.id, v, 'profil_rollback', { profil_revision: i.profil_revision, inhalt: alt }, { profil_revision: revision, ziel_revision, inhalt: ziel }, g);
    return { profil_revision: revision };
  });
}

/** Paket-A-Dienste in Vertragsform; W1B_DIENSTE (agent-profil-vertrag.ts) delegiert hierher. */
export const PAKET_A_DIENSTE: {
  schatten: SchattenprofilDienst;
  profil: Pick<ProfilDienst, 'aendereProfil' | 'profilHistorie' | 'rollbackProfil'>;
  typen: TypKatalogDienst;
} = {
  schatten: { legeSchattenprofilAn, listeSchattenprofile, korrigiereSchattenprofil, bestaetigeSchattenprofil, lehneSchattenprofilAb, verfalleAbgelaufene },
  profil: { aendereProfil, profilHistorie, rollbackProfil },
  typen: { listeTypen, legeTypAn, aendereTyp, leseTypRevision },
};
