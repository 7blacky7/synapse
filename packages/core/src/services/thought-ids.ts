/**
 * MODUL: thought-ids
 * ZWECK: Thought-IDs aufloesen (volle UUID oder eindeutiger Praefix, mind. 8 Zeichen) und
 *        Thoughts aus PostgreSQL lesen. PostgreSQL ist die Quelle der Wahrheit, nicht Qdrant.
 *
 * Bewusst OHNE Qdrant-Import: die SQL-Schicht ist mit einer injizierten query-Funktion ohne DB testbar.
 *
 * Regeln der Aufloesung:
 *  - volle UUID (36 Zeichen)              -> unveraendert (Existenz prueft der Aufrufer)
 *  - Praefix aus [0-9a-f-], >= 8 Zeichen  -> je Projekt, LIKE 'praefix%' LIMIT 6
 *      0 Treffer -> nicht_gefunden; >1 -> mehrdeutig (Kandidaten id + 60 Zeichen Inhalt)
 *  - kuerzer als 8 Zeichen                -> ungueltig (zu_kurz)
 *  - enthaelt % oder _ (LIKE-Zeichen)     -> ungueltig
 *  - sonst (andere Zeichen)               -> nur exakter Treffer (Altbestand mit fremden IDs)
 */

import { getPool } from '../db/client.js'

export const PRAEFIX_MIN = 8
const KANDIDATEN_MAX = 6
const INHALT_VORSCHAU = 60

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PRAEFIX_RE = /^[0-9a-f-]+$/

export type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>

export interface ThoughtIdDeps {
  query?: QueryFn
}

const standardQuery: QueryFn = (sql, params) => getPool().query(sql, params) as unknown as ReturnType<QueryFn>

export interface ThoughtRow {
  id: string
  project: string
  source: string
  content: string
  tags: string[]
  timestamp: string
  task_id?: string
}

export type AufloesungStatus = 'ok' | 'nicht_gefunden' | 'mehrdeutig' | 'ungueltig'

export interface Aufloesung {
  eingabe: string
  status: AufloesungStatus
  /** aufgeloeste volle ID (nur bei status ok) */
  id?: string
  /** true, wenn ein Praefix angefragt und aufgeloest wurde */
  gekuerzt?: boolean
  kandidaten?: Array<{ id: string; inhalt: string }>
  fehler?: string
}

export type IdEingabe =
  | { art: 'voll'; id: string }
  | { art: 'praefix'; id: string }
  | { art: 'fremd'; id: string }
  | { art: 'ungueltig'; fehler: string }

/** Ordnet eine Eingabe ein, ohne die DB zu fragen. */
export function pruefeIdEingabe(roh: unknown): IdEingabe {
  if (typeof roh !== 'string') return { art: 'ungueltig', fehler: 'id muss ein String sein' }
  const id = roh.trim().toLowerCase()
  if (id.length === 0) return { art: 'ungueltig', fehler: 'id ist leer' }
  if (id.includes('%') || id.includes('_')) {
    return { art: 'ungueltig', fehler: 'id darf die Zeichen % und _ nicht enthalten' }
  }
  if (UUID_RE.test(id)) return { art: 'voll', id }
  if (PRAEFIX_RE.test(id)) {
    if (id.length < PRAEFIX_MIN) {
      return { art: 'ungueltig', fehler: `Praefix zu kurz: mindestens ${PRAEFIX_MIN} Zeichen (oder die volle UUID) angeben` }
    }
    return { art: 'praefix', id }
  }
  if (id.length > 128) return { art: 'ungueltig', fehler: 'id zu lang' }
  return { art: 'fremd', id }
}

function kuerze(text: unknown): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > INHALT_VORSCHAU ? `${t.slice(0, INHALT_VORSCHAU)}…` : t
}

/** Loest jede Eingabe einzeln auf. Reihenfolge und Anzahl bleiben erhalten. */
export async function loeseThoughtIdsAuf(
  project: string,
  eingaben: unknown[],
  deps: ThoughtIdDeps = {},
): Promise<Aufloesung[]> {
  const query = deps.query ?? standardQuery
  const out: Aufloesung[] = []
  for (const roh of eingaben) {
    const eingabe = typeof roh === 'string' ? roh : String(roh)
    const e = pruefeIdEingabe(roh)
    if (e.art === 'ungueltig') {
      out.push({ eingabe, status: 'ungueltig', fehler: e.fehler })
      continue
    }
    if (e.art === 'voll') {
      out.push({ eingabe, status: 'ok', id: e.id, gekuerzt: false })
      continue
    }
    if (e.art === 'fremd') {
      const r = await query('SELECT id, content FROM thoughts WHERE project = $1 AND id = $2', [project, e.id])
      out.push(r.rows.length > 0
        ? { eingabe, status: 'ok', id: String(r.rows[0].id), gekuerzt: false }
        : { eingabe, status: 'nicht_gefunden' })
      continue
    }
    const r = await query(
      'SELECT id, content FROM thoughts WHERE project = $1 AND id LIKE $2 ORDER BY id LIMIT ' + KANDIDATEN_MAX,
      [project, `${e.id}%`],
    )
    if (r.rows.length === 0) {
      out.push({ eingabe, status: 'nicht_gefunden' })
    } else if (r.rows.length === 1) {
      out.push({ eingabe, status: 'ok', id: String(r.rows[0].id), gekuerzt: true })
    } else {
      out.push({
        eingabe,
        status: 'mehrdeutig',
        kandidaten: r.rows.map(x => ({ id: String(x.id), inhalt: kuerze(x.content) })),
        fehler: `Praefix "${eingabe}" ist mehrdeutig (${r.rows.length} Treffer) — laengeren Praefix angeben`,
      })
    }
  }
  return out
}

// ───────────────────────── Lesen aus PostgreSQL ─────────────────────────

const SPALTEN = 'id, project, source, content, tags, timestamp, task_id'

function zeitAlsIso(wert: unknown): string {
  if (wert instanceof Date) return wert.toISOString()
  const d = new Date(String(wert))
  return Number.isNaN(d.getTime()) ? String(wert ?? '') : d.toISOString()
}

/** PG-Zeile -> Thought-Form (timestamp ISO-String wie bisher aus Qdrant). */
export function zeileZuThought(row: Record<string, unknown>): ThoughtRow {
  const t: ThoughtRow = {
    id: String(row.id),
    project: String(row.project),
    source: String(row.source),
    content: String(row.content ?? ''),
    tags: Array.isArray(row.tags) ? (row.tags as unknown[]).map(String) : [],
    timestamp: zeitAlsIso(row.timestamp),
  }
  if (row.task_id != null) t.task_id = String(row.task_id)
  return t
}

function grenze(limit: number): number {
  return Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 10000) : 50
}

export async function leseThoughtsAusPg(project: string, limit = 50, deps: ThoughtIdDeps = {}): Promise<ThoughtRow[]> {
  const query = deps.query ?? standardQuery
  const r = await query(
    `SELECT ${SPALTEN} FROM thoughts WHERE project = $1 ORDER BY timestamp DESC LIMIT $2`,
    [project, grenze(limit)],
  )
  return r.rows.map(zeileZuThought)
}

export async function leseThoughtsNachSourceAusPg(project: string, source: string, limit = 50, deps: ThoughtIdDeps = {}): Promise<ThoughtRow[]> {
  const query = deps.query ?? standardQuery
  const r = await query(
    `SELECT ${SPALTEN} FROM thoughts WHERE project = $1 AND source = $2 ORDER BY timestamp DESC LIMIT $3`,
    [project, source, grenze(limit)],
  )
  return r.rows.map(zeileZuThought)
}

export async function leseThoughtsNachTagAusPg(project: string, tag: string, limit = 50, deps: ThoughtIdDeps = {}): Promise<ThoughtRow[]> {
  const query = deps.query ?? standardQuery
  const r = await query(
    `SELECT ${SPALTEN} FROM thoughts WHERE project = $1 AND $2 = ANY(tags) ORDER BY timestamp DESC LIMIT $3`,
    [project, tag, grenze(limit)],
  )
  return r.rows.map(zeileZuThought)
}

/** Per volle ID(s) aus PG; Ergebnis in Eingabereihenfolge, unbekannte IDs fehlen. */
export async function leseThoughtsNachIdsAusPg(project: string, ids: string[], deps: ThoughtIdDeps = {}): Promise<ThoughtRow[]> {
  if (ids.length === 0) return []
  const query = deps.query ?? standardQuery
  const r = await query(
    `SELECT ${SPALTEN} FROM thoughts WHERE project = $1 AND id = ANY($2::text[])`,
    [project, ids],
  )
  const nachId = new Map(r.rows.map(x => [String(x.id), zeileZuThought(x)]))
  const out: ThoughtRow[] = []
  const gesehen = new Set<string>()
  for (const id of ids) {
    const t = nachId.get(id)
    if (t && !gesehen.has(id)) {
      out.push(t)
      gesehen.add(id)
    }
  }
  return out
}

export interface ThoughtMitAufloesung extends ThoughtRow {
  /** nur gesetzt, wenn ein gekuerzter Praefix angefragt wurde */
  aufgeloeste_id?: string
}

export interface HoleErgebnis {
  thoughts: ThoughtMitAufloesung[]
  /** Eingaben, die nicht ok waren (ungueltig / mehrdeutig / nicht gefunden) */
  probleme: Aufloesung[]
}

/** Praefix-faehiges Laden per Eingabe-IDs (volle UUID oder Praefix). */
export async function holeThoughtsPerEingabe(project: string, eingaben: unknown[], deps: ThoughtIdDeps = {}): Promise<HoleErgebnis> {
  const aufl = await loeseThoughtIdsAuf(project, eingaben, deps)
  const okIds = aufl.filter(a => a.status === 'ok' && a.id).map(a => a.id as string)
  const zeilen = await leseThoughtsNachIdsAusPg(project, okIds, deps)
  const nachId = new Map(zeilen.map(z => [z.id, z]))
  const thoughts: ThoughtMitAufloesung[] = []
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
    thoughts.push(a.gekuerzt ? { ...z, aufgeloeste_id: z.id } : z)
  }
  return { thoughts, probleme }
}

// ───────────────────────── Semantische Treffer aus PG nachladen ─────────────────────────

export interface SuchTreffer<P extends Record<string, unknown>> {
  id: string
  score: number
  payload: P
}

/**
 * Qdrant-Treffer: score bleibt aus Qdrant, Inhalt/Tags/source/timestamp/task_id kommen aus PG.
 * Treffer ohne PG-Zeile werden verworfen und gezaehlt. Reihenfolge der Treffer bleibt.
 */
export function mischeSuchtreffer<P extends Record<string, unknown>>(
  treffer: Array<SuchTreffer<P>>,
  zeilen: ThoughtRow[],
): { treffer: Array<SuchTreffer<P>>; verworfen: number } {
  const nachId = new Map(zeilen.map(z => [z.id, z]))
  const out: Array<SuchTreffer<P>> = []
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
      source: z.source,
      content: z.content,
      tags: z.tags,
      timestamp: z.timestamp,
      ...(z.task_id != null ? { task_id: z.task_id } : {}),
    } as unknown as P
    out.push({ id: t.id, score: t.score, payload })
  }
  return { treffer: out, verworfen }
}
