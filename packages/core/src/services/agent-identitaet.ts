/**
 * P22-T10: Dauerhafte Agenten-Identitaet, projektgebundener Ausweis und Kontext-Epoch.
 * W12 (P22-T24, Vertrag 27acb98b V1/V2): Der Ausweis ist eine Identifikation INNERHALB von Synapse, kein
 * Sicherheitssystem (Bearer bleibt Pflicht). Er wird OFFEN gespeichert (agent_identitaet_tokens.token_offen,
 * unique, Lookup NUR darueber); Hash/Tresor/Start-Rotation entfallen. Je Identitaet hoechstens EIN nicht
 * geloeschter Ausweis. Weg B: 'ausgestellt' mit Erstnutzungsfrist; die ERSTE erfolgreiche Pruefung
 * (anmelden oder jeder Toolaufruf mit token) ist die Bestaetigung (gueltig_bis=NULL, dauerhaft).
 * Der Wert steht nie in Log-/Auditdaten (Audit nennt token_id/token_praefix).
 * Aufrufer mit system-Recht sind ausschliesslich bereits authentifizierte API-/Daemonadapter;
 * niemals ein Tool-Argument als solchen Principal uebernehmen.
 */
import { createHash, randomUUID } from 'node:crypto';
import { AUSWEIS_FORMAT, ausweisPraefix, erzeugeAusweis } from './agent-ausweis-format.js';
/** P22-T35: zentrale Ausweis-Erzeugung (agent-ausweis-format.ts); keine andere Stelle erzeugt Ausweise. */
export { erzeugeAusweis as erzeugeAgentAusweis } from './agent-ausweis-format.js';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool-aktiv.js';
import { ausweisTokenAktiv } from './agent-profil-schalter.js';
// P22-T45: Erstnutzungsfrist aus der EINEN Lesestelle (Einstellung erstnutzung_minuten); kein Importzyklus mehr.
import { erstnutzungFristMs } from './agent-ausweis-fristen.js';
import { leseAgentBezugModus, aktuellerAgentAufruf, type AgentBezugStand } from './agent-bezug.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { beginneIdentitaetsSitzung } from './agent-identitaet-sitzungen.js';
import { selbstKonflikte, type Selbstangaben } from './agent-selbstfelder.js';

export interface TokenIdentitaetSchalter {
  freigegeben: boolean;
  quelle: 'standard' | 'intern';
  bis: string | null;
  letzter_fehler: string | null;
}
/** Standard AUS. Kein PG-Lesen ohne intern. Lesefehler verlaesst immer den Override. */
export async function leseTokenIdentitaetSchalter(): Promise<TokenIdentitaetSchalter> {
  const standard: TokenIdentitaetSchalter = {
    freigegeben: process.env.SYNAPSE_TOKEN_IDENTITAET === '1',
    quelle: 'standard', bis: null, letzter_fehler: null,
  };
  if (!internToolAktiv()) return standard;
  try {
    const r = await getPool().query<{ aktiv: boolean; bis: Date | null }>({
      text: `SELECT aktiv, bis FROM intern_schalter
        WHERE name = 'token_identitaet' AND modus = 'freigegeben'
          AND (bis IS NULL OR bis > NOW())`,
      query_timeout: 2000,
    } as import('pg').QueryConfig & { query_timeout: number });
    const z = r.rows[0];
    return z ? { freigegeben: z.aktiv, quelle: 'intern', bis: z.bis?.toISOString() ?? null, letzter_fehler: null } : standard;
  } catch {
    return { ...standard, letzter_fehler: 'schalter_nicht_erreichbar' };
  }
}

export class AgentIdentitaetFehler extends Error {
  /** P22-T13: optionale geheimnisfreie Details (z. B. Feldnamen eines Identitaetskonflikts). */
  constructor(public readonly code: string, public readonly details?: Record<string, unknown>) { super(code); }
}
export interface AgentIdentitaet {
  id: string;
  project: string;
  name: string;
  instanz_nr: number;
  agent_id: string;
  rolle: string;
  modell_bestaetigt: string | null;
  modell_selbstauskunft: string | null;
  profil: Record<string, unknown>;
  startrezept: Record<string, unknown>;
  status: 'aktiv' | 'deaktiviert';
  erstellt_von: string;
  erstellt_am: Date;
  zuletzt_aktiv: Date;
  context_epoch: number;
}
export interface AgentTokenAnmeldung {
  identitaet: AgentIdentitaet;
  /** Einmal pro Aufruf ermittelter Routingstand fuer Adapter/Hooks. */
  bezug?: AgentBezugStand;
  project: string;
  agent_id: string;
  rolle: string;
  modell: string | null;
  context_epoch: number;
  /** Aktueller logischer Lauf, bei noch nicht angemeldetem Ausweis null. */
  lauf_id: string | null;
}
export interface AgentTokenAusgabe {
  /** Direkte Antwort an den berechtigten Aufrufer; Adapter darf den Wert weder protokollieren noch persistieren. */
  token: string;
  token_id: string;
  token_praefix: string;
  identitaet: AgentIdentitaet;
  /** W12: true = neu ausgestellt, false = vorhandener gueltiger Ausweis wiederverwendet (Respawn). */
  neu?: boolean;
  /** W12: die Identitaet wurde mit diesem Aufruf angelegt. */
  neu_angelegt?: boolean;
  /** W12: Ende der Erstnutzungsfrist (ISO) oder null = dauerhaft aktiv. */
  gueltig_bis?: string | null;
  ausweis_weg?: string | null;
}
export interface AgentTokenAusstellen {
  project: string;
  name: string;
  modell_selbstauskunft?: string;
  /** Nur bestaetigte Principal-Rechte duerfen diese Werte setzen. */
  rolle?: string;
  modell_bestaetigt?: string;
  /** Bestehende Identitaet: deren gueltigen Ausweis liefern (Respawn) bzw. nach Verfall/Loeschen einen neuen ausstellen. */
  identity_id?: string;
  /** @deprecated W12 (V2): Start-Ausweise und Start-Rotation entfallen; wirkungslos. */
  start_art?: string;
  grund?: string;
  /** W12 Weg B: Erstnutzungsfrist (Einstellung erstnutzung_minuten, Standard 10 min) statt sofort aktiv. */
  erstnutzung?: boolean;
  /** W12: Herkunft des Ausweises (Anzeige/Debug); Standard 'register' bzw. 'neu_ausgestellt'. */
  ausweis_weg?: string;
  /** W12: laeuft in der Anlage-Transaktion nach dem Identitaets-INSERT und vor dem Ausweis (nur bei neuer Identitaet). */
  nach_anlage?: (c: PoolClient, identitaet: AgentIdentitaet) => Promise<void>;
}
/** Vertrauensgrenze: system NUR aus authentifiziertem Transport, identity_id aus Tokenpruefung. */
export interface AgentIdentitaetPrincipal {
  identity_id?: string;
  system?: 'user' | 'daemon';
  /** W12 (Koordinator-Vorgabe 27920): Legacy-Koordinator ohne Ausweis (Erkennung wie P22-T18, nur Namensmuster/Rolle). */
  legacy_koordinator?: string;
}
const SPALTEN = `id, project, name, instanz_nr, agent_id, rolle, modell_bestaetigt,
  modell_selbstauskunft, profil, startrezept, status, erstellt_von, erstellt_am,
  zuletzt_aktiv, context_epoch`;
/** Nur noch fuer Altzeilen/Fremdnutzer (z. B. Tests); die Identifikation laeuft nicht mehr ueber den Hash. */
export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function text(wert: string): boolean {
  return typeof wert === 'string' && wert.trim().length > 0 && wert.length <= 256;
}
/** W12 V7: Lesestelle ist der Ausweis-Kern (ein Produkt-Schalter); mit Ausweis ohne Projekt wird dessen Projekt gelesen. */
async function freigabe(project?: string | null, token?: string): Promise<void> {
  if (!(await ausweisTokenAktiv(project, token))) throw new AgentIdentitaetFehler('token_identitaet_aus');
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
    // DB-Fehler koennen Werte enthalten; nicht an Tool-/Logausgaben weiterreichen.
    if (e instanceof AgentIdentitaetFehler) throw e;
    if ((e as { code?: string } | null)?.code === '23505') throw new AgentIdentitaetFehler('ausweis_existiert');
    throw new AgentIdentitaetFehler('identitaet_speicher_fehler');
  } finally { c.release(); }
}
/** W12: gleiche Transaktionshuelle (Fehlerabbildung) fuer die Ausweis-Dienste. */
export const mitIdentitaetTransaktion = transaktion;
async function berechtigung(c: PoolClient, project: string, p?: AgentIdentitaetPrincipal): Promise<{ wer: string; verwaltung: boolean; daemon: boolean }> {
  if (p?.system === 'user' || p?.system === 'daemon') {
    return { wer: p.system, verwaltung: p.system === 'user', daemon: p.system === 'daemon' };
  }
  if (p?.legacy_koordinator) return { wer: 'legacy:' + p.legacy_koordinator, verwaltung: true, daemon: false };
  if (!p?.identity_id) return { wer: 'erstanmeldung', verwaltung: false, daemon: false };
  const r = await c.query<{ rolle: string }>(
    "SELECT rolle FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv' FOR SHARE",
    [p.identity_id, project],
  );
  if (!r.rows[0]) {
    // P22-T79 (Befund d93b8a2e): der Main verwaltet Agenten in <project> nur mit Freigabe der Ausweis-Grenze (main_verwaltung).
    if (aktuellerAgentAufruf()?.main_verwaltung === project) {
      const m = await c.query("SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND rolle='main' AND status='aktiv' FOR SHARE",
        [p.identity_id, HAUPTAGENT_PROJEKT]);
      if (m.rows[0]) return { wer: p.identity_id, verwaltung: true, daemon: false };
    }
    throw new AgentIdentitaetFehler('principal_ungueltig');
  }
  return { wer: p.identity_id, verwaltung: r.rows[0].rolle === 'koordinator', daemon: false };
}
async function audit(c: Pick<PoolClient, 'query'>, id: string, wer: string, aktion: string, alt: unknown, neu: unknown, grund?: string): Promise<void> {
  await c.query(`INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,(SELECT id FROM agent_identitaeten WHERE id=$2))`, [id, wer, aktion, JSON.stringify(alt), JSON.stringify(neu), grund ?? null]);
}
/** W12: Audit-Zeile fuer die Ausweis-Dienste (ohne Tokenwert!). */
export const schreibeIdentitaetAudit = audit;

// ---- W12 Ausweis-Ablage (V1/V2) ----------------------------------------------------------------
/** Der (hoechstens eine) nicht geloeschte offene Ausweis einer Identitaet. gueltig = ausgestellt innerhalb der Frist oder aktiv. */
export interface AusweisZeile {
  id: string;
  token: string;
  token_praefix: string;
  gueltig_bis: Date | null;
  zuletzt_benutzt: Date | null;
  erstellt_am: Date;
  ausweis_weg: string | null;
  gueltig: boolean;
}
export async function holeAusweis(c: Pick<PoolClient, 'query'>, identityId: string, sperren = false): Promise<AusweisZeile | null> {
  const r = await c.query<AusweisZeile>(
    `SELECT id, token_offen AS token, token_praefix, gueltig_bis, zuletzt_benutzt, erstellt_am, ausweis_weg,
       (gueltig_bis IS NULL OR gueltig_bis > NOW()) AS gueltig
     FROM agent_identitaet_tokens
     WHERE identity_id=$1 AND widerrufen_am IS NULL AND token_offen IS NOT NULL${sperren ? ' FOR UPDATE' : ''}`, [identityId]);
  return r.rows[0] ?? null;
}
/**
 * Genau EIN Ausweis je Identitaet: ein gueltiger vorhandener wird zurueckgegeben (neu:false). Ein verfallener,
 * nie benutzter wird zuerst geloescht (Grund erstnutzung_verfallen). Sonst wird ein neuer ausgestellt;
 * erstnutzung:true = 'ausgestellt' mit Frist, sonst sofort 'aktiv'. Die Identitaetszeile muss der Aufrufer gesperrt haben.
 */
export async function stelleOderHoleAusweisTx(
  c: PoolClient, identitaet: { id: string },
  o: { weg: string; erstnutzung: boolean; wer: string; grund?: string },
): Promise<{ zeile: AusweisZeile; neu: boolean }> {
  const vorhanden = await holeAusweis(c, identitaet.id, true);
  if (vorhanden) {
    if (vorhanden.gueltig) return { zeile: vorhanden, neu: false };
    await c.query(`UPDATE agent_identitaet_tokens SET widerrufen_am=NOW(), widerrufen_von=$2,
        widerrufen_von_identity_id=(SELECT id FROM agent_identitaeten WHERE id=$2), widerrufen_grund='erstnutzung_verfallen' WHERE id=$1`,
      [vorhanden.id, o.wer]);
    await audit(c, identitaet.id, o.wer, 'token_widerrufen', { token_id: vorhanden.id, widerrufen: false }, { token_id: vorhanden.id, widerrufen: true }, 'erstnutzung_verfallen');
  }
  // P22-T45: Erstnutzungsfrist des Projekts der Identitaet (projekt > global > Standard); gilt nur fuer diesen neuen Ausweis.
  const fristMs = o.erstnutzung
    ? await erstnutzungFristMs((await c.query<{ project: string }>('SELECT project FROM agent_identitaeten WHERE id=$1', [identitaet.id])).rows[0]?.project ?? null)
    : 0;
  const token = await erzeugeAusweis(c);
  const tokenId = randomUUID();
  const praefix = ausweisPraefix(token);
  await c.query(`INSERT INTO agent_identitaet_tokens (id, identity_id, token_offen, token_praefix, ausweis_weg, gueltig_bis)
    VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::boolean THEN NOW() + ($7::double precision * INTERVAL '1 millisecond') ELSE NULL END)`,
    [tokenId, identitaet.id, token, praefix, o.weg, o.erstnutzung, fristMs]);
  await audit(c, identitaet.id, o.wer, 'token_ausstellen', null, { token_id: tokenId, token_praefix: praefix, ausweis_weg: o.weg, erstnutzung: o.erstnutzung }, o.grund);
  const zeile = await holeAusweis(c, identitaet.id);
  if (!zeile) throw new AgentIdentitaetFehler('identitaet_speicher_fehler');
  return { zeile, neu: true };
}

/** User27698: exakte Koordinatornamen duerfen sich selbst registrieren; sonst subagent. */
export async function stelleAgentTokenAus(e: AgentTokenAusstellen, principal?: AgentIdentitaetPrincipal, bezugsStand?: AgentBezugStand): Promise<AgentTokenAusgabe> {
  await freigabe(typeof e.project === 'string' ? e.project : null);
  const bezug = bezugsStand ?? aktuellerAgentAufruf()?.bezug ?? await leseAgentBezugModus();
  if (!text(e.project) || !text(e.name) || e.name.includes('#')) throw new AgentIdentitaetFehler('identitaet_parameter_ungueltig');
  const koordinatorSelbst = /^(koordinator|coordinator)$/i.test(e.name.trim());
  const name = koordinatorSelbst ? 'koordinator' : e.name;
  if (name.trim().toLowerCase() === 'user') throw new AgentIdentitaetFehler('identitaet_parameter_ungueltig');
  // P22-T80 Nachbesserung: Sperrriegel - kein Ausweis unter dem Namen eines archivierten Eintrags (dynamisch: kein Importzyklus).
  if (await (await import('./agent-entfernung.js')).istGesperrterArchivName(name.trim())) throw new AgentIdentitaetFehler('archivname_gesperrt');
  return transaktion(async (c) => {
    const recht = await berechtigung(c, e.project, principal);
    const privilegiert = recht.verwaltung || recht.daemon;
    if (!privilegiert && (e.identity_id || (e.rolle && e.rolle !== (koordinatorSelbst ? 'koordinator' : 'subagent')) || e.modell_bestaetigt)) {
      throw new AgentIdentitaetFehler('identitaet_recht_fehlt');
    }
    let identitaet: AgentIdentitaet;
    let neuAngelegt = false;
    if (e.identity_id) {
      const r = await c.query<AgentIdentitaet>(
        `SELECT ${SPALTEN} FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv' FOR UPDATE`,
        [e.identity_id, e.project],
      );
      if (!r.rows[0]) throw new AgentIdentitaetFehler('identitaet_nicht_aktiv');
      identitaet = r.rows[0];
    } else {
      // Gleicher Projekt/Name serialisiert die Instanznummer; kein globaler Lock.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([e.project, name])]);
      const nr = await c.query<{ nr: number }>('SELECT COALESCE(MAX(instanz_nr),0)+1 AS nr FROM agent_identitaeten WHERE project=$1 AND (name=$2 OR ($3::boolean AND rolle=\'koordinator\'))', [e.project, name, koordinatorSelbst]);
      let instanz = Number(nr.rows[0].nr);
      let agentId: string;
      // User27717: Legacy-Namen ablehnen, weder uebernehmen noch automatisch #2 anlegen.
      if (bezug.modus === 'alt') {
      const legacy = await c.query(
        'SELECT id FROM agent_sessions WHERE project=$1 AND identity_id IS NULL AND (id=$2 OR id=$3)',
        [e.project,name,koordinatorSelbst ? 'coordinator' : name]);
      if (legacy.rows[0]) throw new AgentIdentitaetFehler('name_gehoert_bestehendem_agenten');
      }
      agentId = instanz === 1 ? name : `${name}#${instanz}`;
      if (bezug.modus === 'alt') {
      const belegt = await c.query('SELECT id FROM agent_sessions WHERE id=$1',[agentId]);
      if (belegt.rows[0]) throw new AgentIdentitaetFehler('name_gehoert_bestehendem_agenten');
      }
      const id = randomUUID();
      const r = await c.query<AgentIdentitaet>(
        `INSERT INTO agent_identitaeten (id, project, name, instanz_nr, agent_id, rolle,
          modell_bestaetigt, modell_selbstauskunft, erstellt_von, erstellt_von_identity_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,(SELECT id FROM agent_identitaeten WHERE id=$9)) RETURNING ${SPALTEN}`,
        [id, e.project, name, instanz, agentId, privilegiert ? (e.rolle ?? (koordinatorSelbst ? 'koordinator' : 'subagent')) : (koordinatorSelbst ? 'koordinator' : 'subagent'),
          privilegiert ? (e.modell_bestaetigt ?? null) : null, e.modell_selbstauskunft ?? null, recht.wer],
      );
      identitaet = r.rows[0];
      neuAngelegt = true;
      await audit(c, id, recht.wer, 'ausstellen', null, { project: e.project, name, instanz_nr: instanz, rolle: identitaet.rolle }, e.grund);
      if (e.nach_anlage) {
        await e.nach_anlage(c, identitaet);
        const frisch = await c.query<AgentIdentitaet>(`SELECT ${SPALTEN} FROM agent_identitaeten WHERE id=$1`, [id]);
        identitaet = frisch.rows[0];
      }
    }
    // V2: je Identitaet genau EIN Ausweis. Vorhandener gueltiger -> derselbe (Respawn/Neustart/Daemon-Start).
    const { zeile, neu } = await stelleOderHoleAusweisTx(c, identitaet, {
      weg: e.ausweis_weg ?? (neuAngelegt ? 'register' : 'neu_ausgestellt'),
      erstnutzung: e.erstnutzung === true, wer: recht.wer, grund: e.grund,
    });
    return { token: zeile.token, token_id: zeile.id, token_praefix: zeile.token_praefix, identitaet, neu, neu_angelegt: neuAngelegt,
      gueltig_bis: zeile.gueltig_bis ? zeile.gueltig_bis.toISOString() : null, ausweis_weg: zeile.ausweis_weg };
  });
}

/** Validiert den Ausweis bei JEDEM Aufruf; erhoeht nur bei anmelden die Epoch. */
async function tokenIdentitaet(token: string, project: string | undefined, anmelden: boolean, bezugsStand?: AgentBezugStand, selbst?: Selbstangaben): Promise<AgentTokenAnmeldung> {
  await freigabe(project ?? null, token);
  const bezug = bezugsStand ?? aktuellerAgentAufruf()?.bezug ?? await leseAgentBezugModus();
  if (typeof token !== 'string' || !AUSWEIS_FORMAT.test(token)) throw new AgentIdentitaetFehler('agent_token_ungueltig');
  return transaktion(async (c) => {
    // Gleiche Reihenfolge wie Widerruf/Deaktivierung: erst Identitaet, dann Ausweis.
    const r = await c.query<AgentIdentitaet>(
      `SELECT ${SPALTEN.split(',').map(s => 'i.' + s.trim()).join(',')}
       FROM agent_identitaeten i WHERE i.id=(SELECT identity_id FROM agent_identitaet_tokens WHERE token_offen=$1)
       FOR UPDATE`, [token],
    );
    let i = r.rows[0];
    if (!i || i.status !== 'aktiv') throw new AgentIdentitaetFehler('agent_token_ungueltig');
    if (project !== undefined && project !== i.project) throw new AgentIdentitaetFehler('agent_token_fremdes_projekt');
    // P22-T13 F3: ausdruecklicher Widerspruch VOR Epoch/Lauf/Sitzung/zuletzt_benutzt -> Rollback, keine Nebenwirkung.
    if (selbst) {
      const felder = selbstKonflikte({ agent_id: i.agent_id, rolle: i.rolle }, selbst);
      if (felder.length) throw new AgentIdentitaetFehler('identitaet_konflikt', { felder });
    }
    if (bezug.modus === 'alt') {
      // Rueckwechsel adoptiert keine ausschliesslich im ID-Modus entstandenen Namenszustaende.
      // Nur eine schon vorher an GENAU diese Identitaet gebundene Legacy-Sitzung ist nutzbar.
      const rollback = await c.query(
        `SELECT 1 FROM agent_identitaet_sitzungen s WHERE s.identity_id=$1
          AND NOT EXISTS (SELECT 1 FROM agent_sessions l WHERE l.id=$2 AND l.project=$3 AND l.identity_id=$1)`,
        [i.id,i.agent_id,i.project]);
      if (rollback.rows.length) throw new AgentIdentitaetFehler('agent_identity_im_altmodus_nicht_gebunden');
      // Ein frisch ausgestellter Ausweis hat noch keine ID-Sitzung. Auch seine reine
      // Pruefung darf deshalb keine gleichnamige Legacy-Sitzung (NULL oder andere ID)
      // bezeugen. Derselbe Guard gilt vor Anmeldung UND jedem fachlichen Folgeaufruf.
      const kollision = await c.query(
        'SELECT 1 FROM agent_sessions WHERE id=$1 AND (project IS DISTINCT FROM $2 OR identity_id IS DISTINCT FROM $3)',
        [i.agent_id,i.project,i.id]);
      if (kollision.rows.length) throw new AgentIdentitaetFehler('agent_sitzung_bereits_gebunden');
      // Legacy-Zustaende brauchen keine Chat-Anmeldung (z.B. erster Wrapper-Heartbeat).
      // Nur eine schon an DIESE Identitaet gebundene Alt-Sitzung bezeugt deren Besitz.
      const altbestand = await c.query(
        `SELECT 1 WHERE NOT EXISTS (
           SELECT 1 FROM agent_sessions WHERE id=$1 AND project=$2 AND identity_id=$3
         ) AND (
           EXISTS (SELECT 1 FROM wrapper_status WHERE agent_name=$1 AND project=$2)
           OR EXISTS (SELECT 1 FROM file_reservations WHERE agent_id=$1 AND project=$2
             AND released_at IS NULL AND expires_at>NOW())
           OR EXISTS (SELECT 1 FROM shell_jobs WHERE agent_id=$1 AND project=$2
             AND owner_identity_id IS NULL AND status IN ('pending','running'))
         )`, [i.agent_id,i.project,i.id]);
      if (altbestand.rows.length) throw new AgentIdentitaetFehler('agent_legacy_zustand_bereits_gebunden');

    }
    // W12 V2: Der Ausweis muss ausgestellt (innerhalb der Erstnutzungsfrist) oder aktiv sein. Die ERSTE erfolgreiche
    // Pruefung (anmelden oder jeder Toolaufruf) ist die Bestaetigung: gueltig_bis=NULL, dauerhaft bis Loeschen.
    const t = await c.query<{ id: string; gueltig_bis: Date | null }>(
      `SELECT id, gueltig_bis FROM agent_identitaet_tokens
        WHERE token_offen=$1 AND identity_id=$2 AND widerrufen_am IS NULL AND (gueltig_bis IS NULL OR gueltig_bis>NOW()) FOR UPDATE`,
      [token, i.id]);
    if (!t.rows[0]) throw new AgentIdentitaetFehler('agent_token_ungueltig');
    await c.query('UPDATE agent_identitaet_tokens SET zuletzt_benutzt=NOW(), gueltig_bis=NULL WHERE id=$1', [t.rows[0].id]);
    if (t.rows[0].gueltig_bis !== null) {
      await audit(c, i.id, i.id, 'ausweis_bestaetigt', { token_id: t.rows[0].id, gueltig_bis: t.rows[0].gueltig_bis }, { token_id: t.rows[0].id, gueltig_bis: null });
    }
    const neu = await c.query<AgentIdentitaet>(
      `UPDATE agent_identitaeten SET zuletzt_aktiv=NOW(), context_epoch=context_epoch+$2
       WHERE id=$1 RETURNING ${SPALTEN}`, [i.id, anmelden ? 1 : 0],
    );
    i = neu.rows[0];
    let laufId: string | null = null;
    if (anmelden) {
      laufId = randomUUID();
      const vorher = await c.query<{id: string}>(`UPDATE agent_identitaet_laeufe
        SET status='abgeloest', abgeloest_am=NOW(), abgeloest_durch=$2
        WHERE identity_id=$1 AND status='aktiv' RETURNING id`, [i.id,laufId]);
      await c.query(`INSERT INTO agent_identitaet_laeufe(id,identity_id,context_epoch,status)
        VALUES ($1,$2,$3,'aktiv')`,[laufId,i.id,i.context_epoch]);
      await audit(c,i.id,i.id,'lauf_begonnen',
        { abgeloeste_laeufe: vorher.rows.map(z=>z.id) },{lauf_id:laufId,context_epoch:i.context_epoch});
      // Sitzungsbindung atomar zur Epoch. Bestehende ACKs/Lesestaende und Zeitfelder bleiben.
      // agent_sessions hat historisch einen globalen Namensschluessel: niemals eine
      // fremde Projekt-/Identitaetsbindung durch dessen ON CONFLICT ueberschreiben.
      if (bezug.modus === 'alt') {
      const sitzung = await c.query(`INSERT INTO agent_sessions (id,project,identity_id,context_epoch,status)
        VALUES ($1,$2,$3,$4,'active')
        ON CONFLICT (id) DO UPDATE SET identity_id=EXCLUDED.identity_id, context_epoch=EXCLUDED.context_epoch
        WHERE agent_sessions.project=EXCLUDED.project
          AND agent_sessions.identity_id=EXCLUDED.identity_id
        RETURNING id`, [i.agent_id,i.project,i.id,i.context_epoch]);
      if (!sitzung.rows[0]) throw new AgentIdentitaetFehler('agent_sitzung_bereits_gebunden');
      } else {
        await beginneIdentitaetsSitzung({ identitaet: i, project: i.project, agent_id: i.agent_id,
          rolle: i.rolle, modell: i.modell_bestaetigt ?? i.modell_selbstauskunft,
          context_epoch: i.context_epoch, lauf_id: laufId }, c);
      }
      await audit(c, i.id, i.id, 'anmelden', { context_epoch: i.context_epoch - 1 }, { context_epoch: i.context_epoch });
    }
    if (!anmelden) {
      const lauf = await c.query<{id: string}>("SELECT id FROM agent_identitaet_laeufe WHERE identity_id=$1 AND status='aktiv'",[i.id]);
      laufId = lauf.rows[0]?.id ?? null;
    }
    return { identitaet: i, bezug, project: i.project, agent_id: i.agent_id, rolle: i.rolle, lauf_id: laufId,
      modell: i.modell_bestaetigt ?? i.modell_selbstauskunft, context_epoch: i.context_epoch };
  });
}
/** Neuer Kontext; keine Events, ACKs, Channels, Reservierungen oder Waits werden angefasst. */
export async function meldeAgentMitTokenAn(token: string, project?: string, bezug?: AgentBezugStand, selbst?: Selbstangaben): Promise<AgentTokenAnmeldung> {
  return tokenIdentitaet(token, project, true, bezug, selbst);
}
/** Transportbindung bei Folgeaufrufen pruefen, ohne Kontext-Epoch zu erhoehen. */
export async function pruefeAgentToken(token: string, project?: string, bezug?: AgentBezugStand, selbst?: Selbstangaben): Promise<AgentTokenAnmeldung> {
  return tokenIdentitaet(token, project, false, bezug, selbst);
}
/** P22-T155: Absender eines abgewiesenen Aufrufs fuer das Audit (tool_calls). */
export interface AusweisAbsender { identity_id: string; agent_id: string; project: string; lauf_id: string | null; context_epoch: number | null }
/**
 * P22-T155: Absender eines ABGEWIESENEN Aufrufs nur fuer das Audit (tool_calls), z. B. unbekannter_parameter vor der
 * Ausweispruefung. NUR LESEND: keine Anmeldung, kein Lauf, keine Epoch, kein zuletzt_benutzt/Bestaetigen, keine Rechte und kein
 * ALS-Principal. Widerrufene/abgelaufene Ausweise und nicht aktive Identitaeten -> null; Lesefehler -> null.
 */
export async function absenderAusAusweis(token: string | undefined | null): Promise<AusweisAbsender | null> {
  if (typeof token !== 'string' || !token) return null;
  try {
    const r = await getPool().query<{ identity_id: string; agent_id: string; project: string; context_epoch: number | null; lauf_id: string | null }>(
      `SELECT i.id AS identity_id, i.agent_id, i.project, i.context_epoch,
         (SELECT l.id FROM agent_identitaet_laeufe l WHERE l.identity_id=i.id AND l.status='aktiv' LIMIT 1) AS lauf_id
        FROM agent_identitaet_tokens t JOIN agent_identitaeten i ON i.id=t.identity_id
       WHERE t.token_offen=$1 AND t.widerrufen_am IS NULL AND (t.gueltig_bis IS NULL OR t.gueltig_bis>NOW()) AND i.status='aktiv'
       LIMIT 1`, [token]);
    const z = r.rows[0];
    return z ? { identity_id: z.identity_id, agent_id: z.agent_id, project: z.project, lauf_id: z.lauf_id ?? null,
      context_epoch: typeof z.context_epoch === 'number' ? z.context_epoch : null } : null;
  } catch { return null; }
}
export async function widerrufeAgentToken(project: string, tokenId: string, principal: AgentIdentitaetPrincipal, grund: string): Promise<void> {
  await freigabe(project);
  if (!text(grund)) throw new AgentIdentitaetFehler('grund_fehlt');
  await transaktion(async (c) => {
    const recht = await berechtigung(c, project, principal);
    if (!recht.verwaltung) throw new AgentIdentitaetFehler('identitaet_recht_fehlt');
    const r = await c.query<{ id: string }>(`SELECT i.id FROM agent_identitaeten i
      JOIN agent_identitaet_tokens t ON t.identity_id=i.id WHERE i.project=$1 AND t.id=$2 FOR UPDATE OF i`, [project, tokenId]);
    if (!r.rows[0]) throw new AgentIdentitaetFehler('agent_token_ungueltig');
    const geaendert = await c.query(`UPDATE agent_identitaet_tokens SET widerrufen_am=NOW(), widerrufen_von=$2, widerrufen_von_identity_id=(SELECT id FROM agent_identitaeten WHERE id=$2), widerrufen_grund=$3
      WHERE id=$1 AND widerrufen_am IS NULL RETURNING id`, [tokenId, recht.wer, grund]);
    if (geaendert.rows[0]) await audit(c, r.rows[0].id, recht.wer, 'token_widerrufen', { token_id: tokenId, widerrufen: false }, { token_id: tokenId, widerrufen: true }, grund);
  });
}
/** Ausschliesslich nach User-Auftrag im Adapter; Koordinator/User-Recht wird hier erneut geprueft. */
export async function deaktiviereAgentIdentitaet(project: string, identityId: string, principal: AgentIdentitaetPrincipal, grund: string): Promise<void> {
  await freigabe(project);
  if (!text(grund)) throw new AgentIdentitaetFehler('grund_fehlt');
  await transaktion(async (c) => {
    const recht = await berechtigung(c, project, principal);
    if (!recht.verwaltung) throw new AgentIdentitaetFehler('identitaet_recht_fehlt');
    const r = await c.query<{ status: string }>('SELECT status FROM agent_identitaeten WHERE id=$1 AND project=$2 FOR UPDATE', [identityId, project]);
    if (!r.rows[0]) throw new AgentIdentitaetFehler('identitaet_unbekannt');
    if (r.rows[0].status === 'deaktiviert') return;
    await c.query("UPDATE agent_identitaeten SET status='deaktiviert' WHERE id=$1", [identityId]);
    await c.query("UPDATE agent_identitaet_laeufe SET status='abgeloest',abgeloest_am=NOW() WHERE identity_id=$1 AND status='aktiv'",[identityId]);
    await audit(c, identityId, recht.wer, 'deaktivieren', { status: r.rows[0].status }, { status: 'deaktiviert' }, grund);
  });
}
/**
 * P22-T68: Gegenstueck zu deaktiviereAgentIdentitaet. Nur status deaktiviert -> aktiv mit Audit; es entsteht kein Lauf und kein Ausweis
 * (widerrufene/geloeschte Ausweise bleiben es, der Agent bekommt per agent_vorbereiten einen neuen). Schon aktiv: keine Aenderung.
 */
export async function reaktiviereAgentIdentitaet(project: string, identityId: string, principal: AgentIdentitaetPrincipal, grund: string): Promise<void> {
  await freigabe(project);
  if (!text(grund)) throw new AgentIdentitaetFehler('grund_fehlt');
  await transaktion(async (c) => {
    const recht = await berechtigung(c, project, principal);
    if (!recht.verwaltung) throw new AgentIdentitaetFehler('identitaet_recht_fehlt');
    const r = await c.query<{ status: string }>('SELECT status FROM agent_identitaeten WHERE id=$1 AND project=$2 FOR UPDATE', [identityId, project]);
    if (!r.rows[0]) throw new AgentIdentitaetFehler('identitaet_unbekannt');
    if (r.rows[0].status === 'aktiv') return;
    await c.query("UPDATE agent_identitaeten SET status='aktiv' WHERE id=$1", [identityId]);
    await audit(c, identityId, recht.wer, 'reaktivieren', { status: r.rows[0].status }, { status: 'aktiv' }, grund);
  });
}
