/**
 * P22-T10: Dauerhafte Agenten-Identitaet, projektgebundener Ausweis und Kontext-Epoch.
 * Nur API/Core: keine lokalen Credentials, keine Token in Log-/Auditdaten.
 * Aufrufer mit system-Recht sind ausschliesslich bereits authentifizierte API-/Daemonadapter;
 * niemals ein Tool-Argument als solchen Principal uebernehmen.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { internToolAktiv } from './intern-tool.js';
import { leseAgentBezugModus, aktuellerAgentAufruf, type AgentBezugStand } from './agent-bezug.js';
import { beginneIdentitaetsSitzung } from './agent-identitaet-sitzungen.js';
import { selbstKonflikte, type Selbstangaben } from './agent-selbstfelder.js';
import { speichereTokenChiffre } from './agent-token-abruf.js';

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
  /** Einmaliger Rueckgabewert; Adapter darf ihn weder protokollieren noch persistieren. */
  token: string;
  token_id: string;
  token_praefix: string;
  identitaet: AgentIdentitaet;
}
export interface AgentTokenAusstellen {
  project: string;
  name: string;
  modell_selbstauskunft?: string;
  /** Nur bestaetigte Principal-Rechte duerfen diese Werte setzen. */
  rolle?: string;
  modell_bestaetigt?: string;
  /** Bestehende Identitaet: weiteren Ausweis ausstellen statt neue Instanz. */
  identity_id?: string;
  /** Start-Ausweis: eigene Rotation pro Startweg; nie Haupt-Ausweise ersetzen. */
  start_art?: string;
  grund?: string;
}
/** Vertrauensgrenze: system NUR aus authentifiziertem Transport, identity_id aus Tokenpruefung. */
export interface AgentIdentitaetPrincipal {
  identity_id?: string;
  system?: 'user' | 'daemon';
}
const SPALTEN = `id, project, name, instanz_nr, agent_id, rolle, modell_bestaetigt,
  modell_selbstauskunft, profil, startrezept, status, erstellt_von, erstellt_am,
  zuletzt_aktiv, context_epoch`;
export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
function text(wert: string): boolean {
  return typeof wert === 'string' && wert.trim().length > 0 && wert.length <= 256;
}
async function freigabe(): Promise<void> {
  if (!(await leseTokenIdentitaetSchalter()).freigegeben) throw new AgentIdentitaetFehler('token_identitaet_aus');
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
    throw new AgentIdentitaetFehler('identitaet_speicher_fehler');
  } finally { c.release(); }
}
async function berechtigung(c: PoolClient, project: string, p?: AgentIdentitaetPrincipal): Promise<{ wer: string; verwaltung: boolean; daemon: boolean }> {
  if (p?.system === 'user' || p?.system === 'daemon') {
    return { wer: p.system, verwaltung: p.system === 'user', daemon: p.system === 'daemon' };
  }
  if (!p?.identity_id) return { wer: 'erstanmeldung', verwaltung: false, daemon: false };
  const r = await c.query<{ rolle: string }>(
    "SELECT rolle FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv' FOR SHARE",
    [p.identity_id, project],
  );
  if (!r.rows[0]) throw new AgentIdentitaetFehler('principal_ungueltig');
  return { wer: p.identity_id, verwaltung: r.rows[0].rolle === 'koordinator', daemon: false };
}
async function audit(c: PoolClient, id: string, wer: string, aktion: string, alt: unknown, neu: unknown, grund?: string): Promise<void> {
  await c.query(`INSERT INTO agent_identitaet_audit (identity_id, wer, aktion, alt, neu, grund, actor_identity_id)
    VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,(SELECT id FROM agent_identitaeten WHERE id=$2))`, [id, wer, aktion, JSON.stringify(alt), JSON.stringify(neu), grund ?? null]);
}

/** User27698: exakte Koordinatornamen duerfen sich selbst registrieren; sonst subagent. */
export async function stelleAgentTokenAus(e: AgentTokenAusstellen, principal?: AgentIdentitaetPrincipal, bezugsStand?: AgentBezugStand): Promise<AgentTokenAusgabe> {
  await freigabe();
  const bezug = bezugsStand ?? aktuellerAgentAufruf()?.bezug ?? await leseAgentBezugModus();
  if (!text(e.project) || !text(e.name) || e.name.includes('#')) throw new AgentIdentitaetFehler('identitaet_parameter_ungueltig');
  const koordinatorSelbst = /^(koordinator|coordinator)$/i.test(e.name.trim());
  const name = koordinatorSelbst ? 'koordinator' : e.name;
  if (name.trim().toLowerCase() === 'user') throw new AgentIdentitaetFehler('identitaet_parameter_ungueltig');
  return transaktion(async (c) => {
    const recht = await berechtigung(c, e.project, principal);
    const privilegiert = recht.verwaltung || recht.daemon;
    if (!privilegiert && (e.identity_id || (e.rolle && e.rolle !== (koordinatorSelbst ? 'koordinator' : 'subagent')) || e.modell_bestaetigt)) {
      throw new AgentIdentitaetFehler('identitaet_recht_fehlt');
    }
    if (e.start_art !== undefined && (!privilegiert || !e.identity_id || !text(e.start_art))) {
      throw new AgentIdentitaetFehler('start_ausweis_recht_fehlt');
    }
    let identitaet: AgentIdentitaet;
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
      await audit(c, id, recht.wer, 'ausstellen', null, { project: e.project, name, instanz_nr: instanz, rolle: identitaet.rolle }, e.grund);
    }
    // Wie auth.ts: 32 Zufallsbytes und SHA-256. Keine Abhaengigkeit core -> rest-api.
    const token = 'sai_' + randomBytes(32).toString('hex');
    const tokenId = randomUUID();
    const praefix = token.slice(0, 12);
    if (e.start_art) {
      // Maximal neuer und unmittelbar vorheriger Start-Ausweis waehrend 60s Uebergang.
      // Die Identitaetszeile ist bereits gesperrt; parallele Starts serialisieren hier.
      await c.query(`WITH vorher AS (
          SELECT id, row_number() OVER (ORDER BY start_uebergang ASC, erstellt_am DESC, id DESC) AS nr
          FROM agent_identitaet_tokens WHERE identity_id=$1 AND start_art=$2
            AND widerrufen_am IS NULL AND (gueltig_bis IS NULL OR gueltig_bis>NOW())
        ), aenderung AS (
          UPDATE agent_identitaet_tokens t SET
            start_uebergang=true,
            gueltig_bis=CASE WHEN v.nr=1 THEN LEAST(COALESCE(t.gueltig_bis,NOW()+INTERVAL '60 seconds'),NOW()+INTERVAL '60 seconds') ELSE t.gueltig_bis END,
            widerrufen_am=CASE WHEN v.nr>1 THEN NOW() ELSE t.widerrufen_am END,
            widerrufen_von=CASE WHEN v.nr>1 THEN $3 ELSE t.widerrufen_von END,
            widerrufen_von_identity_id=CASE WHEN v.nr>1 THEN (SELECT id FROM agent_identitaeten WHERE id=$3) ELSE t.widerrufen_von_identity_id END,
            widerrufen_grund=CASE WHEN v.nr>1 THEN 'start_rotation' ELSE t.widerrufen_grund END
          FROM vorher v WHERE t.id=v.id RETURNING t.id, t.gueltig_bis, t.widerrufen_am
        ) INSERT INTO agent_identitaet_audit (identity_id,wer,aktion,alt,neu,grund,actor_identity_id)
          SELECT $1,$3,'start_rotation',jsonb_build_object('token_id',id),
            jsonb_build_object('gueltig_bis',gueltig_bis,'widerrufen_am',widerrufen_am),$4,(SELECT id FROM agent_identitaeten WHERE id=$3) FROM aenderung`,
        [identitaet.id,e.start_art,recht.wer,e.grund ?? null]);
    }
    // Nur der ungenutzte Start-Ausweis hat eine Bootstrap-Hoechstfrist; Hauptausweise nicht.
    const minuten = Number(process.env.SYNAPSE_AGENT_START_TOKEN_TTL_MIN);
    const startTtlMs = (Number.isFinite(minuten) && minuten > 0 ? minuten : 10) * 60_000;
    const gueltigBis = e.start_art ? new Date(Date.now() + startTtlMs) : null;
    await c.query(`INSERT INTO agent_identitaet_tokens (id, identity_id, token_hash, token_praefix, start_art, gueltig_bis)
      VALUES ($1,$2,$3,$4,$5,$6)`, [tokenId, identitaet.id, hashAgentToken(token), praefix, e.start_art ?? null, gueltigBis]);
    // P22-T13 D (02845fc2): abrufbare Ablage nur fuer Hauptausweise und nur bei konfiguriertem API-Schluessel.
    if (!e.start_art) await speichereTokenChiffre(c, tokenId, token);
    await audit(c, identitaet.id, recht.wer, 'token_ausstellen', null, { token_id: tokenId, token_praefix: praefix }, e.grund);
    return { token, token_id: tokenId, token_praefix: praefix, identitaet };
  });
}

/** Validiert den Ausweis bei JEDEM Aufruf; erhoeht nur bei anmelden die Epoch. */
async function tokenIdentitaet(token: string, project: string | undefined, anmelden: boolean, bezugsStand?: AgentBezugStand, selbst?: Selbstangaben): Promise<AgentTokenAnmeldung> {
  await freigabe();
  const bezug = bezugsStand ?? aktuellerAgentAufruf()?.bezug ?? await leseAgentBezugModus();
  if (typeof token !== 'string' || !/^sai_[a-f0-9]{64}$/.test(token)) throw new AgentIdentitaetFehler('agent_token_ungueltig');
  return transaktion(async (c) => {
    // Gleiche Reihenfolge wie Widerruf/Deaktivierung: erst Identitaet, dann Ausweis.
    const r = await c.query<AgentIdentitaet>(
      `SELECT ${SPALTEN.split(',').map(s => 'i.' + s.trim()).join(',')}
       FROM agent_identitaeten i WHERE i.id=(SELECT identity_id FROM agent_identitaet_tokens WHERE token_hash=$1)
       FOR UPDATE`, [hashAgentToken(token)],
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
    // Die Start-Hoechstfrist gilt nur bis zur erfolgreichen Erstanmeldung des aktuellen
    // Ausweises. Danach gueltig_bis=NULL: wiederverwendbar bis Widerruf/Deaktivierung
    // oder naechster Startrotation. Ein alter Uebergangsausweis behaelt seine 60s-Frist.
    const t = await c.query(
      `UPDATE agent_identitaet_tokens SET zuletzt_benutzt=NOW(),
         gueltig_bis=CASE WHEN $2::boolean AND start_art IS NOT NULL AND NOT start_uebergang THEN NULL ELSE gueltig_bis END
       WHERE token_hash=$1 AND widerrufen_am IS NULL AND (gueltig_bis IS NULL OR gueltig_bis>NOW())
       RETURNING id, start_art, gueltig_bis, start_uebergang`, [hashAgentToken(token),anmelden],
    );
    if (!t.rows[0]) throw new AgentIdentitaetFehler('agent_token_ungueltig');
    // Nur der neue Start-Ausweis beendet den Uebergang. Ein alter Prozess darf
    // durch eine Anmeldung innerhalb der Kulanz den neuen Ausweis nicht widerrufen.
    if (anmelden && t.rows[0].start_art && !t.rows[0].start_uebergang) {
      await c.query(`WITH aenderung AS (
        UPDATE agent_identitaet_tokens SET widerrufen_am=NOW(),
          widerrufen_von=$1, widerrufen_von_identity_id=$1, widerrufen_grund='start_angemeldet'
        WHERE identity_id=$1 AND start_art=$2 AND id<>$3 AND widerrufen_am IS NULL RETURNING id
      ) INSERT INTO agent_identitaet_audit (identity_id,wer,aktion,alt,neu,grund,actor_identity_id)
        SELECT $1,$1,'start_rotation',jsonb_build_object('token_id',id),
          '{"widerrufen":true}'::jsonb,'start_angemeldet',$1 FROM aenderung`,
        [i.id,t.rows[0].start_art,t.rows[0].id]);
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
export async function widerrufeAgentToken(project: string, tokenId: string, principal: AgentIdentitaetPrincipal, grund: string): Promise<void> {
  await freigabe();
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
  await freigabe();
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
