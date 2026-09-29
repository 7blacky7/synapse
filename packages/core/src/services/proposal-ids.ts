/**
 * MODUL: proposal-ids
 * ZWECK: Proposals aus PostgreSQL lesen (Quelle der Wahrheit) + Praefix-IDs aufloesen (P10-T29).
 * Gleiches Muster wie thought-ids.ts; die Aufloesung selbst ist gemeinsam (loeseIdsAuf).
 * Bewusst ohne Qdrant-Import: query injizierbar, ohne DB testbar.
 */

import {
  loeseIdsAuf,
  type Aufloesung,
  type ThoughtIdDeps as ProposalIdDeps,
  type QueryFn,
} from './thought-ids.js'
import { getPool } from '../db/client.js'

export type { ProposalIdDeps }

const standardQuery: QueryFn = (sql, params) => getPool().query(sql, params) as unknown as ReturnType<QueryFn>

export interface ProposalRow {
  id: string
  project: string
  filePath: string
  suggestedContent: string
  description: string
  author: string
  status: 'pending' | 'reviewed' | 'accepted' | 'rejected'
  tags: string[]
  createdAt: string
  updatedAt: string
}

const SPALTEN = 'id, project, file_path, suggested_content, description, author, status, tags, created_at, updated_at'

function iso(wert: unknown): string {
  if (wert instanceof Date) return wert.toISOString()
  const d = new Date(String(wert))
  return Number.isNaN(d.getTime()) ? String(wert ?? '') : d.toISOString()
}

/** PG-Zeile -> Proposal (camelCase, Zeitstempel ISO). mitInhalt=false: suggestedContent '' (Lightweight). */
export function zeileZuProposal(row: Record<string, unknown>, mitInhalt = true): ProposalRow {
  return {
    id: String(row.id),
    project: String(row.project),
    filePath: String(row.file_path ?? ''),
    suggestedContent: mitInhalt ? String(row.suggested_content ?? '') : '',
    description: String(row.description ?? ''),
    author: String(row.author ?? ''),
    status: String(row.status ?? 'pending') as ProposalRow['status'],
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

/** Lightweight-Liste (suggestedContent ''), neueste zuerst, status-Filter in SQL, keine 1000er-Kappe. */
export async function listeProposalsAusPg(
  project: string,
  status?: string,
  deps: ProposalIdDeps = {},
): Promise<ProposalRow[]> {
  const query = deps.query ?? standardQuery
  const r = status
    ? await query(
      `SELECT ${SPALTEN} FROM proposals WHERE project = $1 AND status = $2 ORDER BY created_at DESC`,
      [project, status],
    )
    : await query(`SELECT ${SPALTEN} FROM proposals WHERE project = $1 ORDER BY created_at DESC`, [project])
  return r.rows.map(z => zeileZuProposal(z, false))
}

/** Per volle IDs (mit Inhalt), Eingabereihenfolge, unbekannte fehlen. */
export async function leseProposalsNachIdsAusPg(
  project: string,
  ids: string[],
  deps: ProposalIdDeps = {},
): Promise<ProposalRow[]> {
  if (ids.length === 0) return []
  const query = deps.query ?? standardQuery
  const r = await query(
    `SELECT ${SPALTEN} FROM proposals WHERE project = $1 AND id = ANY($2::text[])`,
    [project, ids],
  )
  const nachId = new Map(r.rows.map(x => [String(x.id), zeileZuProposal(x)]))
  const out: ProposalRow[] = []
  const gesehen = new Set<string>()
  for (const id of ids) {
    const p = nachId.get(id)
    if (p && !gesehen.has(id)) {
      out.push(p)
      gesehen.add(id)
    }
  }
  return out
}

export interface ProposalMitAufloesung extends ProposalRow {
  /** nur gesetzt, wenn ein gekuerzter Praefix angefragt wurde */
  aufgeloeste_id?: string
}

export function loeseProposalIdsAuf(project: string, eingaben: unknown[], deps: ProposalIdDeps = {}): Promise<Aufloesung[]> {
  return loeseIdsAuf('proposals', project, eingaben, deps)
}

/** Praefix-faehiges Laden per Eingabe-IDs (volle UUID oder Praefix). */
export async function holeProposalsPerEingabe(
  project: string,
  eingaben: unknown[],
  deps: ProposalIdDeps = {},
): Promise<{ proposals: ProposalMitAufloesung[]; probleme: Aufloesung[] }> {
  const aufl = await loeseProposalIdsAuf(project, eingaben, deps)
  const okIds = aufl.filter(a => a.status === 'ok' && a.id).map(a => a.id as string)
  const zeilen = await leseProposalsNachIdsAusPg(project, okIds, deps)
  const nachId = new Map(zeilen.map(z => [z.id, z]))
  const proposals: ProposalMitAufloesung[] = []
  const probleme: Aufloesung[] = []
  for (const a of aufl) {
    if (a.status !== 'ok') {
      probleme.push(a)
      continue
    }
    const z = nachId.get(a.id as string)
    if (!z) {
      probleme.push({ eingabe: a.eingabe, status: 'nicht_gefunden' })
      continue
    }
    proposals.push(a.gekuerzt ? { ...z, aufgeloeste_id: z.id } : z)
  }
  return { proposals, probleme }
}

export interface ProposalIdProblem {
  success: false
  status: Aufloesung['status']
  eingabe: string
  message: string
  kandidaten?: Aufloesung['kandidaten']
}

/** Nicht aufloesbare Eingabe -> einheitliche Fehlerantwort (nichts wurde geaendert). */
export function zuIdProblem(a: Aufloesung): ProposalIdProblem {
  const message = a.fehler
    ?? (a.status === 'nicht_gefunden' ? `Proposal "${a.eingabe}" nicht gefunden` : `id "${a.eingabe}" nicht aufloesbar`)
  return { success: false, status: a.status, eingabe: a.eingabe, message, ...(a.kandidaten ? { kandidaten: a.kandidaten } : {}) }
}

export interface ProposalTreffer<P extends Record<string, unknown>> {
  id: string
  score: number
  payload: P
}

/**
 * Qdrant-Treffer: score bleibt aus Qdrant, alle Felder kommen aus PG (Payload-Form snake_case wie
 * bisher, suggested_content weiter '' = Lightweight). Treffer ohne PG-Zeile: verworfen + gezaehlt.
 */
export function mischeProposalTreffer<P extends Record<string, unknown>>(
  treffer: Array<ProposalTreffer<P>>,
  zeilen: ProposalRow[],
): { treffer: Array<ProposalTreffer<P>>; verworfen: number } {
  const nachId = new Map(zeilen.map(z => [z.id, z]))
  const out: Array<ProposalTreffer<P>> = []
  let verworfen = 0
  for (const t of treffer) {
    const z = nachId.get(String(t.id))
    if (!z) {
      verworfen++
      continue
    }
    const payload = {
      ...t.payload,
      project: z.project,
      file_path: z.filePath,
      suggested_content: '',
      description: z.description,
      author: z.author,
      status: z.status,
      tags: z.tags,
      created_at: z.createdAt,
      updated_at: z.updatedAt,
    } as unknown as P
    out.push({ id: t.id, score: t.score, payload })
  }
  return { treffer: out, verworfen }
}
