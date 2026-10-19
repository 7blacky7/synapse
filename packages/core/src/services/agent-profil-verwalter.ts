/**
 * P22-T13 Paket D: gemeinsame Helfer der Verwaltungsdienste (Persona-Bibliothek, Tokenabruf, admin/REST).
 * Der Akteur kommt AUSSCHLIESSLICH aus dem authentifizierten User-Eingang (user-herkunft.ts) bzw. der
 * Tokenpruefung (agent-bezug.ts), niemals aus Tool-Argumenten (User 15b01fa5, 02845fc2).
 */
import type { PoolClient } from 'pg';
import { getPool } from '../db/client.js';
import { aktuellerAgentPrincipal } from './agent-bezug.js';
import { aktuelleUserHerkunft } from './user-herkunft.js';
import type { W1bAkteur, AusweisAkteur } from './agent-profil-vertrag.js';

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
 * User, oder aktiver bestaetigter Koordinator DESSELBEN Projekts (Rolle wird in PG gegengeprueft,
 * nicht aus dem Principal geglaubt). nurUser: globale Kataloge.
 */
export async function pruefeProfilVerwalter(
  akteur: W1bAkteur, project: string | null, opt: { nurUser?: boolean; db?: ProfilDb } = {},
): Promise<{ wer: string; actor_identity_id: string | null }> {
  if (akteur.art === 'user') return { wer: 'user', actor_identity_id: null };
  if (opt.nurUser || akteur.art !== 'identitaet' || !project) throw new ProfilVerwaltungFehler('recht_fehlt');
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
