/**
 * P22-T173: EINE Lesestelle fuer fruehere Namen umbenannter Identitaeten (agent_namens_aliase, Schema 159; geschrieben nur von
 * agent-umbenennung.ts). Gelesen von loeseAgentFilter (files history/versions agent_filter, shell activity), der Thought-Suche nach
 * Absender, der Chat-Sicht (archivSichtFuer) und den Channel-Verweisen (archivVerweise) sowie dem Profil-Update-Diff.
 * Nur getPool, keine Dienst-Importe (agent-bezug und agent-entfernung lesen hier; zyklusfrei).
 * Ob ueberhaupt Aliase existieren, ist 5 s gepuffert (ohne Umbenennung keine weitere Abfrage); leereAliasCache nach jeder Umbenennung.
 * Fehler (Schema alt, Tabelle fehlt) -> keine Aliase, der Aufrufer arbeitet wie bisher.
 */
import type { QueryConfig } from 'pg';
import { getPool } from '../db/client.js';

export interface NamensAlias {
  id: string; project: string; identity_id: string; alter_name: string; neuer_name: string;
  /** Name der Identitaet JETZT (nach weiteren Umbenennungen kann er von neuer_name abweichen). */
  aktueller_name: string;
  umbenannt_am: Date; profil_revision: number | null;
}

type Q = QueryConfig & { query_timeout: number };
const q = (text: string, values: unknown[] = []): Q => ({ text, values, query_timeout: 10_000 } as Q);
const SPALTEN = `a.id::text AS id, a.project, a.identity_id, a.alter_name, a.neuer_name, i.agent_id AS aktueller_name, a.umbenannt_am, a.profil_revision`;

let vorhanden: { bis: number; ja: boolean } | null = null;
export function leereAliasCache(): void { vorhanden = null; }

async function aliaseVorhanden(): Promise<boolean> {
  if (vorhanden && vorhanden.bis > Date.now()) return vorhanden.ja;
  let ja = false;
  try { ja = ((await getPool().query(q('SELECT 1 FROM agent_namens_aliase LIMIT 1'))).rowCount ?? 0) > 0; } catch { ja = false; }
  vorhanden = { bis: Date.now() + 5000, ja };
  return ja;
}

/** Aliase, deren frueherer ODER aktueller Name in namen steht (project null = alle Projekte), aelteste zuerst. */
export async function aliaseFuerNamen(project: string | null, namen: readonly string[]): Promise<NamensAlias[]> {
  const liste = [...new Set(namen.filter((n): n is string => typeof n === 'string' && n.trim() !== ''))];
  if (!liste.length || !(await aliaseVorhanden())) return [];
  try {
    return (await getPool().query<NamensAlias>(q(
      `SELECT ${SPALTEN} FROM agent_namens_aliase a JOIN agent_identitaeten i ON i.id = a.identity_id
        WHERE ($1::text IS NULL OR a.project = $1) AND (a.alter_name = ANY($2::text[]) OR i.agent_id = ANY($2::text[]))
        ORDER BY a.umbenannt_am, a.id`, [project, liste]))).rows;
  } catch { return []; }
}

/** Alle Aliase einer Identitaet, neueste zuerst (Detailansicht). */
export async function aliaseDerIdentitaet(identityId: string): Promise<Array<NamensAlias & { umbenannt_von: string; grund: string }>> {
  if (!identityId || !(await aliaseVorhanden())) return [];
  try {
    return (await getPool().query<NamensAlias & { umbenannt_von: string; grund: string }>(q(
      `SELECT ${SPALTEN}, a.umbenannt_von, a.grund FROM agent_namens_aliase a JOIN agent_identitaeten i ON i.id = a.identity_id
        WHERE a.identity_id = $1 ORDER BY a.umbenannt_am DESC, a.id DESC LIMIT 50`, [identityId]))).rows;
  } catch { return []; }
}

/** Umbenennungen, deren Profil-Revision in (von, nach] liegt (Profil-Update-Diff). */
export async function aliaseZwischenRevisionen(identityId: string, von: number, nach: number): Promise<NamensAlias[]> {
  if (!(await aliaseVorhanden())) return [];
  try {
    return (await getPool().query<NamensAlias>(q(
      `SELECT ${SPALTEN} FROM agent_namens_aliase a JOIN agent_identitaeten i ON i.id = a.identity_id
        WHERE a.identity_id = $1 AND a.profil_revision > $2 AND a.profil_revision <= $3 ORDER BY a.profil_revision, a.id`, [identityId, von, nach]))).rows;
  } catch { return []; }
}

/**
 * Name -> umbenannte Identitaet: name ist ihr aktueller oder ein frueherer Name. namen = aktueller Name + alle frueheren (fuer Zeilen
 * ohne identity_id, die der Altmodus nur mit dem Namen schrieb). Ohne Alias null (der Aufrufer bleibt beim bisherigen Weg).
 */
export async function aliasAufloesung(project: string, name: string): Promise<{ identity_id: string; aktueller_name: string; namen: string[] } | null> {
  const al = await aliaseFuerNamen(project, [name]);
  if (!al.length) return null;
  const treffer = al.find((a) => a.aktueller_name === name) ?? al[al.length - 1];
  const eigene = al.filter((a) => a.identity_id === treffer.identity_id);
  return { identity_id: treffer.identity_id, aktueller_name: treffer.aktueller_name, namen: [...new Set([treffer.aktueller_name, ...eigene.map((a) => a.alter_name)])] };
}

/** Reserviert: name ist frueherer Name einer Identitaet, die inzwischen anders heisst (ausser ausgenommen = diese Identitaet selbst). */
export async function aliasReserviertFuer(project: string, name: string, ausgenommen?: string | null): Promise<NamensAlias | null> {
  const al = await aliaseFuerNamen(project, [name]);
  return al.find((a) => a.alter_name === name && a.aktueller_name !== name && a.identity_id !== ausgenommen) ?? null;
}
