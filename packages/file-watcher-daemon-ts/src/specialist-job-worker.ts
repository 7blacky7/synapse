/**
 * MODUL: specialist-job-worker.ts
 * ZWECK: PostgreSQL LISTEN-basierter Worker fuer Specialist-Jobs.
 *        Lauscht auf 'specialist_job_created', claimed Jobs fuer aktive Projekte
 *        und ruft die entsprechenden Specialist-Tools (spawn, stop, purge, ...)
 *        lokal auf — wo Claude-CLI + Projekt-FS verfuegbar sind.
 *
 * INTEGRATION: Wird von main.ts nach startAllEnabled() gestartet.
 *
 * SPEZIALISTEN-TOOLS sind in @synapse/mcp-server, NICHT in @synapse/core.
 * Wir importieren via dynamic import um Circular-Dep zu vermeiden.
 */

import { installiereAgentStartQuelle } from './agent-start-api.js'
import os from 'node:os'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getPool,
  verbindeListenClient,
  lokalerProjektpfad,
  reapLokaleWrapper,
  claimPendingSpecialistJob,
  completeSpecialistJob,
  expirePendingSpecialistJobs,
  registriereWorker,
  workerPausiert,
  meldeWorkerArbeit,
  pruefeWrapperProzess,
  type SpecialistJobRow,
  type SpecialistJobCompletion,
} from '@synapse/core'
// P9-T27: optionaler API-Weg (daemon_jobs_weg=api) statt PG LISTEN/SQL
import {
  daemonJobsWeg,
  pruefeApiWeg,
  holeSpecialistJobsApi,
  meldeSpecialistAbschlussApi,
  specialistExpireApi,
  wrapperKandidatenApi,
  wrapperAbgestuerztApi,
  schlafe,
  DAEMON_JOBS_POLL_S,
  type SpecialistApiJob,
} from './daemon-jobs-api.js'
// P9-T27 Welle 2: PG-Schritte der Spezialisten-Tools ueber die API
import { installiereSpezialistenApiWeg } from './spezialisten-datenweg-api.js'

const DAEMON_ID = `daemon-${os.hostname()}-${process.pid}`

/**
 * Schreibt den Rotations-Marker, den der Wrapper im Heartbeat prueft
 * (agents/src/wrapper.ts RESPAWN_MARKER_PATH). Gebraucht fuer den REST-Weg von
 * trigger_respawn: dort laeuft core im API-Container, und nur der Daemon sitzt
 * auf dem Rechner des Wrappers. Liefert den geschriebenen Pfad.
 */
export function schreibeRotationsMarker(name: string, verzeichnis = '/tmp'): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) || name.includes('..')) {
    throw new Error(`Ungueltiger Spezialisten-Name fuer den Rotations-Marker: "${name}"`)
  }
  const pfad = join(verzeichnis, `.specialist-rotate-pending-${name}`)
  writeFileSync(pfad, `${new Date().toISOString()}\n`, 'utf8')
  return pfad
}

export interface SpecialistJobWorkerHandle {
  stop: () => Promise<void>
}

/**
 * Startet LISTEN-Loop fuer Specialist-Jobs.
 *
 * @param getActiveProjects  Liefert aktuelle Liste aktiver Projektnamen.
 */
export async function startSpecialistJobWorker(
  getActiveProjects: () => string[],
): Promise<SpecialistJobWorkerHandle> {
  await installiereAgentStartQuelle()
  // P9-T27: Schalter daemon_jobs_weg — 'api' holt/meldet Jobs ueber die Synapse-API statt PG LISTEN/SQL.
  if (daemonJobsWeg() === 'api') return startSpecialistJobWorkerApi(getActiveProjects)
  const pool = getPool()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listenClient: any = null
  let safetyInterval: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let reaperLaeuft = false

  listenClient = await verbindeListenClient()
  await listenClient.query('LISTEN specialist_job_created')

  listenClient.on('notification', (msg: { channel: string; payload?: string }) => {
    if (msg.channel !== 'specialist_job_created' || !msg.payload) return
    const colonIdx = msg.payload.indexOf(':')
    if (colonIdx === -1) return
    const project = msg.payload.slice(0, colonIdx)

    if (!getActiveProjects().includes(project)) return

    void processJob(project).catch((err: unknown) => {
      console.error(`[specialist-worker] processJob(${project}) Fehler:`, (err as Error).message)
    })
  })

  listenClient.on('error', (err: Error) => {
    if (!stopped) console.error('[specialist-worker] LISTEN-Client Fehler:', err.message)
  })

  // Safety-Net alle 10s
  // P15-T12: pausierbar ueber intern(worker_pausieren, worker specialist_jobs, prozess daemon)
  registriereWorker({
    name: 'specialist_jobs',
    beschreibung: 'Specialist-Jobs aus der Queue claimen und ausfuehren',
    durchlauf: async () => {
      const projekte = getActiveProjects()
      for (const project of projekte) await processJob(project)
      return { projekte: projekte.length }
    },
  })

  safetyInterval = setInterval(() => {
    if (stopped) return
    if (!reaperLaeuft && !workerPausiert('specialist_jobs')) {
      reaperLaeuft = true
      void reapLokaleWrapper(getActiveProjects()).catch(err => {
        console.error('[specialist-worker] Reaper:', err.message)
      }).finally(() => { reaperLaeuft = false })
    }
    // P15-T12: waehrend einer Pause nichts verfallen lassen — die Jobs warten nur.
    if (!workerPausiert('specialist_jobs')) {
      void expirePendingSpecialistJobs(30).catch((err: unknown) => {
        console.error(`[specialist-worker] expirePendingSpecialistJobs Fehler:`, (err as Error).message)
      })
    }
    for (const project of getActiveProjects()) {
      void processJob(project).catch((err: unknown) => {
        console.error(`[specialist-worker] safety-net processJob(${project}) Fehler:`, (err as Error).message)
      })
    }
  }, 10_000)

  // Startup-Catchup
  for (const project of getActiveProjects()) {
    void processJob(project).catch((err: unknown) => {
      console.error(`[specialist-worker] startup catchup processJob(${project}) Fehler:`, (err as Error).message)
    })
  }

  console.error(`[specialist-worker] gestartet als ${DAEMON_ID}`)

  const stop = async (): Promise<void> => {
    stopped = true
    if (safetyInterval !== null) {
      clearInterval(safetyInterval)
      safetyInterval = null
    }
    if (listenClient !== null) {
      try { await listenClient.query('UNLISTEN *') } catch { /* ignore */ }
      try { await listenClient.end() } catch { /* ignore */ }
      listenClient = null
    }
    console.error('[specialist-worker] gestoppt.')
  }

  return { stop }
}

// ── Job-Verarbeitung ──────────────────────────────────────────────────────────

async function processJob(project: string): Promise<void> {
  // P15-T12: pausiert -> nicht claimen, der Job bleibt pending.
  if (workerPausiert('specialist_jobs')) return
  const job = await claimPendingSpecialistJob(project, DAEMON_ID, os.hostname())
  if (!job) return
  meldeWorkerArbeit('specialist_jobs')

  console.error(`[specialist-worker] Job ${job.id} (${project}) gestartet: action=${job.action}`)

  try {
    const result = await dispatchSpecialistAction(job)
    await completeSpecialistJob(job.id, { status: 'done', result })
    console.error(`[specialist-worker] Job ${job.id} done`)
  } catch (err: unknown) {
    const m = (err as Error).message ?? String(err)
    await completeSpecialistJob(job.id, {
      status: 'failed',
      error: 'specialist_exception',
      message: m,
    })
    console.error(`[specialist-worker] Job ${job.id} failed: ${m}`)
  }
}

/**
 * Ruft die jeweilige Specialist-Tool-Funktion auf basis von job.action.
 * Tools liegen in @synapse/mcp-server — dynamic import damit der Daemon
 * nicht zwingend mcp-server im Build braucht.
 */
import { mitDaemonAuftrag } from './daemon-auftrag.js';
import { holeAgentStartApi } from './agent-start-api.js';
export async function dispatchSpecialistAction(
  job: SpecialistJobRow,
  optionen: { lokalerProjektpfad?: string | null } = {},
): Promise<Record<string, unknown>> {
  // ID-Aufträge überschreiben nur ihren eigenen Datenweg, nie parallele Legacy-Jobs.
  return mitDaemonAuftrag(job, async () => {
    if (!job.target_identity_id) return dispatchSpecialistActionGebunden(job, optionen);
    const agents = await import('@synapse/agents');
    const env = await holeAgentStartApi(String(job.args.name), job.project);
    if (env.SYNAPSE_AGENT_IDENTITY_ID !== job.target_identity_id) throw new Error('daemon_auftrag_startidentitaet_falsch');
    const tools = await import('@synapse/mcp-server/tools');
    const { apiSpezialistenDatenweg, holeModelleApi } = await import('./spezialisten-datenweg-api.js');
    return agents.mitAgentLaufUmgebung(String(job.args.name), job.project, env, () =>
      tools.mitSpezialistenDatenweg(apiSpezialistenDatenweg, () =>
        agents.mitModellQuelle(holeModelleApi, () => dispatchSpecialistActionGebunden(job, optionen))));
  });
}
async function dispatchSpecialistActionGebunden(
  job: SpecialistJobRow,
  /** P9-T27: im API-Weg liefert die API den Projektpfad dieses Hosts mit (sonst PG-Lookup wie bisher). */
  optionen: { lokalerProjektpfad?: string | null } = {},
): Promise<Record<string, unknown>> {
  const args = job.args as Record<string, unknown>
  const tools = await import('@synapse/mcp-server/tools')

  switch (job.action) {
    case 'spawn': {
      return (await tools.spawnSpecialistTool(
        String(args.name),
        String(args.model),
        String(args.expertise),
        String(args.task),
        String(args.project),
        String(args.project_path),
        args.cwd ? String(args.cwd) : undefined,
        args.channel ? String(args.channel) : undefined,
        Array.isArray(args.allowed_tools) ? (args.allowed_tools as string[]) : undefined,
        typeof args.keep_alive === 'boolean' ? args.keep_alive : undefined,
        args.effort != null ? String(args.effort) : undefined,
      )) as Record<string, unknown>
    }

    case 'spawn_batch': {
      const specs = Array.isArray(args.specialists) ? (args.specialists as Array<Record<string, unknown>>) : []
      const project = String(args.project)
      const projectPath = String(args.project_path)
      const results: Array<Record<string, unknown>> = []
      const errors: string[] = []
      for (const s of specs) {
        try {
          const r = await tools.spawnSpecialistTool(
            String(s.name),
            String(s.model),
            String(s.expertise),
            String(s.task),
            project,
            projectPath,
            s.cwd ? String(s.cwd) : undefined,
            s.channel ? String(s.channel) : undefined,
            Array.isArray(s.allowed_tools) ? (s.allowed_tools as string[]) : undefined,
            typeof s.keep_alive === 'boolean' ? s.keep_alive : undefined,
            s.effort != null ? String(s.effort) : undefined,
          )
          results.push(r as Record<string, unknown>)
        } catch (err) {
          errors.push(`${s.name}: ${err}`)
        }
      }
      return {
        success: errors.length === 0,
        count: results.length,
        results,
        errors: errors.length > 0 ? errors : undefined,
        message: `${results.length}/${specs.length} Spezialisten gestartet`,
      }
    }

    case 'stop': {
      const path = optionen.lokalerProjektpfad !== undefined ? optionen.lokalerProjektpfad : await lokalerProjektpfad(job.project)
      if (!path) throw new Error('Stop: Projektpfad dieses Hosts nicht eindeutig registriert')
      const names = Array.isArray(args.name) ? (args.name as unknown[]).map(String) : [String(args.name)]
      const projectPath = path
      if (names.length === 1) {
        return (await tools.stopSpecialistTool(names[0], projectPath, job.project)) as Record<string, unknown>
      }
      const results: Array<Record<string, unknown>> = []
      const errors: string[] = []
      for (const n of names) {
        try { results.push((await tools.stopSpecialistTool(n, projectPath, job.project)) as Record<string, unknown>) }
        catch (e) { errors.push(`${n}: ${e}`) }
      }
      return { results, count: results.length, errors }
    }

    case 'purge': {
      const names = Array.isArray(args.name) ? (args.name as unknown[]).map(String) : [String(args.name)]
      const projectPath = String(args.project_path)
      const purgeProject = args.project ? String(args.project) : undefined
      if (names.length === 1) {
        return (await tools.purgeSpecialistTool(names[0], projectPath, purgeProject)) as Record<string, unknown>
      }
      const results: Array<Record<string, unknown>> = []
      const errors: string[] = []
      for (const n of names) {
        try { results.push((await tools.purgeSpecialistTool(n, projectPath, purgeProject)) as Record<string, unknown>) }
        catch (e) { errors.push(`${n}: ${e}`) }
      }
      return { results, count: results.length, errors }
    }

    case 'wake': {
      const names = Array.isArray(args.name) ? (args.name as unknown[]).map(String) : [String(args.name)]
      const message = String(args.message)
      if (names.length === 1) {
        return (await tools.wakeSpecialistTool(names[0], message, job.project)) as Record<string, unknown>
      }
      const results: Array<Record<string, unknown>> = []
      const errors: string[] = []
      for (const n of names) {
        try { results.push((await tools.wakeSpecialistTool(n, message, job.project)) as Record<string, unknown>) }
        catch (e) { errors.push(`${n}: ${e}`) }
      }
      return { results, count: results.length, errors }
    }

    case 'update_skill': {
      return (await tools.updateSpecialistSkillTool(
        String(args.name),
        String(args.project_path),
        args.section as 'regeln' | 'fehler' | 'patterns' | undefined,
        args.skill_action as 'add' | 'remove',
        String(args.content),
        args.file as 'rules' | 'errors' | 'patterns' | 'context' | undefined,
      )) as Record<string, unknown>
    }

    case 'status': {
      // Iter 3: REST-API status verfuegbar machen. Bei name=Array → batch-status
      const names = Array.isArray(args.name) ? (args.name as string[]) : (args.name ? [String(args.name)] : [])
      if (names.length === 0) {
        // Alle Spezialisten
        return (await tools.specialistStatusTool(String(args.project_path))) as Record<string, unknown>
      }
      if (names.length === 1) {
        return (await tools.specialistStatusTool(String(args.project_path), names[0])) as Record<string, unknown>
      }
      const results: Array<Record<string, unknown>> = []
      for (const n of names) {
        results.push((await tools.specialistStatusTool(String(args.project_path), n)) as Record<string, unknown>)
      }
      return { results, count: results.length }
    }

    case 'rotate': {
      // Neustart-Aufforderung aus maybeTriggerRespawn (REST-Weg). Der Korridor-
      // Check ist dort schon bestanden; hier nur noch der Marker.
      const name = String(args.name)
      const marker = schreibeRotationsMarker(name)
      return { success: true, name, marker, message: `Rotations-Marker fuer "${name}" geschrieben` }
    }

    default:
      throw new Error(`Unbekannte Specialist-Action: ${job.action}`)
  }
}

// ── P9-T27: API-Weg ───────────────────────────────────────────────────────────

/**
 * Spezialisten-Worker ueber die Synapse-API (daemon_jobs_weg=api). Gleiches Verhalten wie der PG-Weg:
 * Claim nur fuer aktive Projekte und diesen Host (target_hostname), Jobs juenger als 30 s, Verfall
 * nach 30 s, Wrapper-Reaper (Datenteil ueber die API, Prozesspruefung /proc lokal), Pause ueber
 * intern(worker_pausieren, worker specialist_jobs). dispatchSpecialistAction bleibt unveraendert;
 * den Projektpfad fuer stop liefert die API mit.
 * Welle 2: die PG-Schritte der Spezialisten-Tools (spawn/stop/purge/wake in @synapse/mcp-server) und die
 * Modell-Registry laufen ueber die API (spezialisten-datenweg-api.ts); neu gestartete Wrapper bekommen
 * SYNAPSE_WRAPPER_TRANSPORT=api + API-Zugang.
 */
async function startSpecialistJobWorkerApi(getActiveProjects: () => string[]): Promise<SpecialistJobWorkerHandle> {
  pruefeApiWeg()
  await installiereSpezialistenApiWeg()
  let stopped = false
  let laufend: AbortController | null = null
  let reaperLaeuft = false

  const bearbeite = async (job: SpecialistApiJob): Promise<void> => {
    meldeWorkerArbeit('specialist_jobs')
    console.error(`[specialist-worker] Job ${job.id} (${job.project}) gestartet: action=${job.action}`)
    let abschluss: SpecialistJobCompletion
    try {
      const result = await dispatchSpecialistAction(job, { lokalerProjektpfad: job.lokaler_projektpfad ?? null })
      abschluss = { status: 'done', result }
    } catch (err: unknown) {
      const m = (err as Error).message ?? String(err)
      abschluss = { status: 'failed', error: 'specialist_exception', message: m }
    }
    for (let versuch = 1; versuch <= 3; versuch++) {
      try {
        await meldeSpecialistAbschlussApi(job.id, DAEMON_ID, abschluss)
        console.error(`[specialist-worker] Job ${job.id} ${abschluss.status}${abschluss.message ? `: ${abschluss.message}` : ''}`)
        return
      } catch (err) {
        console.error(`[specialist-worker] Abschluss ${job.id}, Versuch ${versuch} fehlgeschlagen:`, (err as Error).message)
        if (versuch < 3) await schlafe(1_000 * versuch)
      }
    }
  }

  const abruf = async (warteS: number, signal?: AbortSignal): Promise<number> => {
    if (workerPausiert('specialist_jobs')) return 0
    const projekte = getActiveProjects()
    if (projekte.length === 0) return 0
    const jobs = await holeSpecialistJobsApi({ daemonId: DAEMON_ID, projekte, warteS, signal })
    for (const job of jobs) {
      void bearbeite(job).catch((err: unknown) => {
        console.error(`[specialist-worker] Job ${job.id} Fehler:`, (err as Error).message)
      })
    }
    return jobs.length
  }

  registriereWorker({
    name: 'specialist_jobs',
    beschreibung: 'Specialist-Jobs ueber die Synapse-API holen und ausfuehren',
    durchlauf: async () => ({ projekte: getActiveProjects().length, jobs: await abruf(0), weg: 'api' }),
  })

  /** reapLokaleWrapper im API-Weg: Kandidaten von der API, Prozesspruefung lokal, CAS-Update per API. */
  const reaper = async (): Promise<number> => {
    let anzahl = 0
    for (const k of await wrapperKandidatenApi(DAEMON_ID, getActiveProjects())) {
      if ((await pruefeWrapperProzess(Number(k.wrapper_pid), k.agent_name, k.project, k.path, k.identity_id)).zustand !== 'tot') continue
      anzahl += await wrapperAbgestuerztApi(DAEMON_ID, k)
    }
    return anzahl
  }

  const safetyInterval = setInterval(() => {
    if (stopped) return
    if (!reaperLaeuft && !workerPausiert('specialist_jobs')) {
      reaperLaeuft = true
      void reaper().catch((err: unknown) => {
        console.error('[specialist-worker] Reaper (API):', (err as Error).message)
      }).finally(() => { reaperLaeuft = false })
    }
    // P15-T12: waehrend einer Pause nichts verfallen lassen — die Jobs warten nur.
    if (!workerPausiert('specialist_jobs')) {
      void specialistExpireApi(DAEMON_ID, 30).catch((err: unknown) => {
        console.error('[specialist-worker] expire (API) Fehler:', (err as Error).message)
      })
    }
  }, 10_000)

  void (async () => {
    let fehlerZyklen = 0
    let fehlerGemeldet = false
    while (!stopped) {
      try {
        if (workerPausiert('specialist_jobs') || getActiveProjects().length === 0) { await schlafe(2_000); continue }
        laufend = new AbortController()
        await abruf(DAEMON_JOBS_POLL_S, laufend.signal)
        laufend = null
        if (fehlerGemeldet) { console.error('[specialist-worker] API wieder erreichbar'); fehlerGemeldet = false }
        fehlerZyklen = 0
      } catch (err) {
        laufend = null
        if (stopped) break
        fehlerZyklen = Math.min(fehlerZyklen + 1, 30)
        if (!fehlerGemeldet) {
          console.error(`[specialist-worker] API nicht erreichbar (${(err as Error).message}) — neuer Versuch mit Backoff bis 30 s`)
          fehlerGemeldet = true
        }
        await schlafe(1_000 * fehlerZyklen)
      }
    }
  })()

  console.error(`[specialist-worker] gestartet als ${DAEMON_ID} (Weg: API)`)

  return {
    stop: async (): Promise<void> => {
      stopped = true
      clearInterval(safetyInterval)
      laufend?.abort()
      console.error('[specialist-worker] gestoppt.')
    },
  }
}
