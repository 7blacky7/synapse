/**
 * MODUL: specialist-spawn-args
 * ZWECK: EINE Stelle, die Spawn-Eingaben (REST-Route, Tool-Aufruf ueber REST) in genau die Form
 *        bringt, die der Daemon-Worker (file-watcher-daemon specialist-job-worker.ts) liest:
 *        name, model, expertise, task, project, project_path, cwd, channel, allowed_tools,
 *        keep_alive, effort — alle snake_case, nie der String "undefined" (P7-T9).
 *
 * Der Worker laeuft im Daemon und wird nur vom User neu gestartet. Der Fix wirkt deshalb schon
 * OHNE Daemon-Neustart: die API validiert und normalisiert VOR dem Enqueue.
 *
 * keep_alive: KEIN einheitlicher Standard. Jeder Weg uebergibt seinen heutigen Standard
 * ausdruecklich (stdio true; REST/Web-KI false). Die Vereinheitlichung ist eine User-Entscheidung
 * (Kosten/Laufzeit).
 * Reine Funktionen bis auf pruefeSpawnEffort (getModel injizierbar).
 */

import { pruefeEffort, waehleEffort } from './effort.js'

export const SPAWN_BATCH_MAX = 10

export interface SpawnArgs {
  name: string
  model: string
  expertise: string
  task: string
  project: string
  project_path: string
  cwd?: string
  channel?: string
  allowed_tools?: string[]
  keep_alive?: boolean
  effort?: string
}

export interface SpawnOptionen {
  project: string
  projectPath: string
  /** Standard fuer keep_alive, wenn der Aufrufer nichts nennt. undefined = Feld weglassen. */
  keepAliveStandard?: boolean
}

export type SpawnErgebnis = { ok: true; args: SpawnArgs } | { ok: false; fehler: string }

type Roh = Record<string, unknown>

function text(wert: unknown): string | undefined {
  if (typeof wert !== 'string') return undefined
  const t = wert.trim()
  return t.length > 0 ? t : undefined
}

function erstes(roh: Roh, ...schluessel: string[]): unknown {
  for (const s of schluessel) {
    if (roh[s] !== undefined && roh[s] !== null) return roh[s]
  }
  return undefined
}

function boolWert(wert: unknown): boolean | undefined {
  if (typeof wert === 'boolean') return wert
  if (wert === 'true') return true
  if (wert === 'false') return false
  return undefined
}

function listeVonText(wert: unknown): string[] | undefined {
  if (!Array.isArray(wert)) return undefined
  const l = wert.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(x => x.length > 0)
  return l.length > 0 ? l : undefined
}

const PFLICHT: Array<{ feld: 'name' | 'model' | 'expertise' | 'task'; kurz: string }> = [
  { feld: 'name', kurz: 'name' },
  { feld: 'model', kurz: 'model' },
  { feld: 'expertise', kurz: 'expertise' },
  { feld: 'task', kurz: 'task' },
]

/**
 * Ein Spawn-Eintrag (spawn oder ein Item aus spawn_batch). Akzeptiert snake_case UND camelCase
 * (allowedTools, keepAlive). Pflicht: name, model, expertise, task — fehlt eines, kommt eine klare
 * Meldung mit dem Feldnamen statt eines Spawns mit "undefined".
 */
export function normalisiereSpawnEintrag(roh: unknown, opt: SpawnOptionen): SpawnErgebnis {
  if (roh === null || typeof roh !== 'object' || Array.isArray(roh)) {
    return { ok: false, fehler: 'Spawn-Eintrag muss ein Objekt sein' }
  }
  const r = roh as Roh
  const werte: Partial<Record<'name' | 'model' | 'expertise' | 'task', string>> = {}
  const fehlt: string[] = []
  for (const p of PFLICHT) {
    const w = text(r[p.feld])
    if (w === undefined) fehlt.push(p.kurz)
    else werte[p.feld] = w
  }
  if (fehlt.length > 0) {
    return { ok: false, fehler: `Pflichtfelder fehlen oder sind leer: ${fehlt.join(', ')}` }
  }
  const project = text(opt.project)
  const projectPath = text(opt.projectPath)
  if (!project) return { ok: false, fehler: 'project fehlt' }
  if (!projectPath) {
    return { ok: false, fehler: `Projektpfad fuer "${project}" unbekannt (Projekt nicht registriert oder project_path fehlt)` }
  }

  const keepAlive = boolWert(erstes(r, 'keep_alive', 'keepAlive')) ?? opt.keepAliveStandard
  const effortRoh = erstes(r, 'effort')
  const args: SpawnArgs = {
    name: werte.name as string,
    model: werte.model as string,
    expertise: werte.expertise as string,
    task: werte.task as string,
    project,
    project_path: projectPath,
  }
  const cwd = text(erstes(r, 'cwd'))
  if (cwd) args.cwd = cwd
  const channel = text(erstes(r, 'channel'))
  if (channel) args.channel = channel
  const tools = listeVonText(erstes(r, 'allowed_tools', 'allowedTools'))
  if (tools) args.allowed_tools = tools
  if (keepAlive !== undefined) args.keep_alive = keepAlive
  if (effortRoh !== undefined) args.effort = String(effortRoh)
  return { ok: true, args }
}

export type SpawnBatchErgebnis =
  | { ok: true; specialists: Array<Omit<SpawnArgs, 'project' | 'project_path'>> }
  | { ok: false; fehler: string }

/** spawn_batch: 1..10 Items, gemeinsame project/project_path; das erste fehlerhafte Item bricht mit Index ab. */
export function normalisiereSpawnBatch(roh: unknown, opt: SpawnOptionen): SpawnBatchErgebnis {
  if (!Array.isArray(roh) || roh.length === 0) return { ok: false, fehler: 'specialists (Array, 1..10 Items) ist erforderlich' }
  if (roh.length > SPAWN_BATCH_MAX) {
    return { ok: false, fehler: `Batch-Limit: Max ${SPAWN_BATCH_MAX} Spezialisten, ${roh.length} angegeben` }
  }
  const out: Array<Omit<SpawnArgs, 'project' | 'project_path'>> = []
  for (let i = 0; i < roh.length; i++) {
    const e = normalisiereSpawnEintrag(roh[i], opt)
    if (!e.ok) return { ok: false, fehler: `specialists[${i}]: ${e.fehler}` }
    const { project: _p, project_path: _pp, ...item } = e.args
    out.push(item)
  }
  return { ok: true, specialists: out }
}

/**
 * Args fuer enqueueSpecialistJob in der Form, die der HEUTIGE Daemon-Worker liest:
 *   spawn:       {name, model, expertise, task, project, project_path, cwd?, channel?, allowed_tools?, keep_alive?, effort?}
 *   spawn_batch: {project, project_path, specialists: [{name, model, expertise, task, ...}]}
 * roh = die Aufrufer-Eingabe (Tool-Args bzw. Route-Body, snake_case und/oder camelCase).
 */
export function baueSpawnJobArgs(
  action: 'spawn' | 'spawn_batch',
  roh: Record<string, unknown>,
  opt: SpawnOptionen,
): { ok: true; args: Record<string, unknown> } | { ok: false; fehler: string } {
  if (action === 'spawn') {
    const e = normalisiereSpawnEintrag(roh, opt)
    return e.ok ? { ok: true, args: { ...e.args } } : e
  }
  const b = normalisiereSpawnBatch(roh.specialists, opt)
  if (!b.ok) return b
  const projekt = text(opt.project)
  const pfad = text(opt.projectPath)
  if (!projekt) return { ok: false, fehler: 'project fehlt' }
  if (!pfad) return { ok: false, fehler: `Projektpfad fuer "${projekt}" unbekannt (Projekt nicht registriert oder project_path fehlt)` }
  return { ok: true, args: { project: projekt, project_path: pfad, specialists: b.specialists } }
}

export interface SpawnEffortDeps {
  getModel?: (alias: string) => Promise<{
    binary?: string
    alias: string
    effortStufen?: readonly string[] | null
    defaultEffort?: string | null
  } | null>
}

/**
 * effort frueh pruefen (vor Queue und Daemon): Tippfehler sofort mit den erlaubten Werten, und
 * fuer claude-Modelle gegen die Stufen des Modells. Wirft bei ungueltiger Angabe.
 * Verbindlich bleibt die Pruefung im Daemon (spawnSpecialistTool).
 */
export async function pruefeSpawnEffort(model: unknown, effort: unknown, deps: SpawnEffortDeps = {}): Promise<void> {
  const stufe = pruefeEffort(effort)
  if (!stufe || typeof model !== 'string') return
  const getModel = deps.getModel ?? (async (alias: string) => (await import('./model-registry.js')).getModel(alias))
  const eintrag = await getModel(model).catch(() => null)
  if (eintrag && eintrag.binary === 'claude') {
    waehleEffort(eintrag.alias, eintrag.effortStufen ?? [], eintrag.defaultEffort, stufe)
  }
}
