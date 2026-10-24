/**
 * P22-T13 Paket D: gemeinsame Helfer der Verwaltungsdienste (Persona-Bibliothek, Tokenabruf, admin/REST).
 * Der Akteur kommt AUSSCHLIESSLICH aus dem authentifizierten User-Eingang (user-herkunft.ts) bzw. der
 * Tokenpruefung (agent-bezug.ts), niemals aus Tool-Argumenten (User 15b01fa5, 02845fc2).
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { aktuellerAgentAufruf, aktuellerAgentPrincipal } from './agent-bezug.js';
import { HAUPTAGENT_PROJEKT } from './virtuelle-projekte.js';
import { aktuelleUserHerkunft } from './user-herkunft.js';
import type { W1bAkteur, AusweisAkteur } from './agent-profil-vertrag.js';
import { rolleFuerAgent } from './agent-rollen.js';

export type ProfilDb = Pick<PoolClient, 'query'>;

/** Geheimnisfreier Fachfehler der Verwaltung; details enthaelt nie Tokenwerte. */
export class ProfilVerwaltungFehler extends Error {
  constructor(public readonly code: string, public readonly details?: Record<string, unknown>) { super(code); }
}

/** Audit-Text, wenn der User selbst ueber den authentifizierten Eingang handelt und keinen Wortlaut mitgibt. */
export const USER_AUFTRAG_STANDARD = 'User-Auswahl ueber den authentifizierten User-Eingang';

/** Akteur des laufenden Aufrufs: User nur mit belegter Herkunft, sonst bezeugte Identitaet, sonst null. */
export function aktuellerW1bAkteur(): W1bAkteur | null {
  if (aktuelleUserHerkunft()) return { art: 'user' };
  const p = aktuellerAgentPrincipal();
  return p && p.art === 'identity' ? { art: 'identitaet', principal: p } : null;
}

/**
 * P22-T79 (Befund d93b8a2e): der Main verwaltet Agenten in Projekt <project> NUR, wenn die Ausweis-Grenze den Aufruf als
 * Agenten-Verwaltung freigegeben hat (Aufrufkontext main_verwaltung === project; Positivliste + Schalter main_agentenverwaltung
 * in agent-token-tools.ts) und PG ihn als aktive Main-Identitaet im internen Bereich kennt. Sonst null.
 */
export async function mainVerwaltetProjekt(akteur: AusweisAkteur, project: string | null, db?: ProfilDb): Promise<{ wer: string; actor_identity_id: string } | null> {
  if (!project || akteur.art !== 'identitaet') return null;
  const p = akteur.principal;
  if (p.rolle !== 'main' || p.project !== HAUPTAGENT_PROJEKT || aktuellerAgentAufruf()?.main_verwaltung !== project) return null;
  const r = await (db ?? getPool()).query(
    "SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv' AND rolle='main'", [p.identity_id, HAUPTAGENT_PROJEKT]);
  return r.rows[0] ? { wer: p.identity_id, actor_identity_id: p.identity_id } : null;
}

/**
 * User, oder aktiver bestaetigter Koordinator DESSELBEN Projekts (Rolle wird in PG gegengeprueft,
 * nicht aus dem Principal geglaubt). nurUser: globale Kataloge.
 */
export async function pruefeProfilVerwalter(
  akteur: AusweisAkteur, project: string | null, opt: { nurUser?: boolean; db?: ProfilDb } = {},
): Promise<{ wer: string; actor_identity_id: string | null }> {
  if (akteur.art === 'user') return { wer: 'user', actor_identity_id: null };
  if (opt.nurUser || !project) throw new ProfilVerwaltungFehler('recht_fehlt');
  if (akteur.art === 'legacy_koordinator') {
    // P22-T34 (User 19.10., memory entscheidung-agenten-ausweis-2026-10-19 Punkt 3a): ein Legacy-Koordinator ohne eigenen Ausweis
    // darf alles, was Koordinator mit Ausweis darf (ausser 'nur User'). Erkennung wie P22-T18 (Rolle/Namensmuster koordinator);
    // gehoert der Name einer Token-Identitaet, braucht der Aufruf deren Ausweis. Audit-Kennung 'legacy:<id>'.
    const agent = typeof akteur.agent_id === 'string' ? akteur.agent_id.trim() : '';
    if (!agent || rolleFuerAgent(agent).rolle !== 'koordinator') throw new ProfilVerwaltungFehler('recht_fehlt');
    const eigene = await (opt.db ?? getPool()).query('SELECT 1 FROM agent_identitaeten WHERE project=$1 AND agent_id=$2 LIMIT 1', [project, agent]);
    if (eigene.rows[0]) throw new ProfilVerwaltungFehler('recht_fehlt');
    return { wer: 'legacy:' + agent, actor_identity_id: null };
  }
  if (akteur.art !== 'identitaet') throw new ProfilVerwaltungFehler('recht_fehlt');
  const main = await mainVerwaltetProjekt(akteur, project, opt.db);
  if (main) return main;
  const p = akteur.principal;
  if (p.project !== project || p.rolle !== 'koordinator') throw new ProfilVerwaltungFehler('recht_fehlt');
  const r = await (opt.db ?? getPool()).query(
    "SELECT 1 FROM agent_identitaeten WHERE id=$1 AND project=$2 AND status='aktiv' AND rolle='koordinator'",
    [p.identity_id, project]);
  if (!r.rows[0]) throw new ProfilVerwaltungFehler('recht_fehlt');
  return { wer: p.identity_id, actor_identity_id: p.identity_id };
}

export function pflichtText(wert: unknown, code: string, min = 5, max = 1000): string {
  const t = typeof wert === 'string' ? wert.trim() : '';
  if (t.length < min || t.length > max) throw new ProfilVerwaltungFehler(code);
  return t;
}

/**
 * K7/K10: Setzen/Aendern braucht einen dokumentierten User-Auftrag. Der User selbst darf den Wortlaut
 * weglassen (die authentifizierte Handlung ist der Auftrag); ein Koordinator nie.
 */
export function userAuftragFuer(akteur: AusweisAkteur, wert: unknown): string {
  const leer = wert === undefined || wert === null || (typeof wert === 'string' && !wert.trim());
  if (leer && akteur.art === 'user') return USER_AUFTRAG_STANDARD;
  return pflichtText(wert, 'user_auftrag_fehlt');
}

export async function profilTransaktion<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    // DB-Fehler koennen Werte enthalten: nicht weiterreichen.
    if (e instanceof ProfilVerwaltungFehler) throw e;
    if ((e as { code?: string })?.code === '23505') throw new ProfilVerwaltungFehler('konflikt');
    throw new ProfilVerwaltungFehler('verwaltung_speicher_fehler');
  } finally { c.release(); }
}

export const isoZeit = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());
