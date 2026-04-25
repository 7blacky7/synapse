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

import os from 'node:os'
import {
  getPool,
  claimPendingSpecialistJob,
  completeSpecialistJob,
  expirePendingSpecialistJobs,
  type SpecialistJobRow,
} from '@synapse/core'

const DAEMON_ID = `daemon-${os.hostname()}-${process.pid}`

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
  const pool = getPool()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listenClient: any = null
  let safetyInterval: ReturnType<typeof setInterval> | null = null
  let stopped = false

  listenClient = await pool.connect()
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
  safetyInterval = setInterval(() => {
    if (stopped) return
    void expirePendingSpecialistJobs(30).catch((err: unknown) => {
      console.error(`[specialist-worker] expirePendingSpecialistJobs Fehler:`, (err as Error).message)
    })
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
      try { listenClient.release() } catch { /* ignore */ }
      listenClient = null
    }
    console.error('[specialist-worker] gestoppt.')
  }

  return { stop }
}

// ── Job-Verarbeitung ──────────────────────────────────────────────────────────

async function processJob(project: string): Promise<void> {
  const job = await claimPendingSpecialistJob(project, DAEMON_ID)
  if (!job) return

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
async function dispatchSpecialistAction(job: SpecialistJobRow): Promise<Record<string, unknown>> {
  const args = job.args as Record<string, unknown>
  const tools = await import('@synapse/mcp-server/tools')

  switch (job.action) {
    case 'spawn': {
      return (await tools.spawnSpecialistTool(
        String(args.name),
        args.model as 'opus' | 'sonnet' | 'haiku' | 'opus[1m]' | 'sonnet[1m]',
        String(args.expertise),
        String(args.task),
        String(args.project),
        String(args.project_path),
        args.cwd ? String(args.cwd) : undefined,
        args.channel ? String(args.channel) : undefined,
        Array.isArray(args.allowed_tools) ? (args.allowed_tools as string[]) : undefined,
        typeof args.keep_alive === 'boolean' ? args.keep_alive : undefined,
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
            s.model as 'opus' | 'sonnet' | 'haiku' | 'opus[1m]' | 'sonnet[1m]',
            String(s.expertise),
            String(s.task),
            project,
            projectPath,
            s.cwd ? String(s.cwd) : undefined,
            s.channel ? String(s.channel) : undefined,
            Array.isArray(s.allowed_tools) ? (s.allowed_tools as string[]) : undefined,
            typeof s.keep_alive === 'boolean' ? s.keep_alive : undefined,
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
      const names = Array.isArray(args.name) ? (args.name as unknown[]).map(String) : [String(args.name)]
      const projectPath = String(args.project_path)
      if (names.length === 1) {
        return (await tools.stopSpecialistTool(names[0], projectPath)) as Record<string, unknown>
      }
      const results: Array<Record<string, unknown>> = []
      const errors: string[] = []
      for (const n of names) {
        try { results.push((await tools.stopSpecialistTool(n, projectPath)) as Record<string, unknown>) }
        catch (e) { errors.push(`${n}: ${e}`) }
      }
      return { results, count: results.length, errors }
    }

    case 'purge': {
      const names = Array.isArray(args.name) ? (args.name as unknown[]).map(String) : [String(args.name)]
      const projectPath = String(args.project_path)
      if (names.length === 1) {
        return (await tools.purgeSpecialistTool(names[0], projectPath)) as Record<string, unknown>
      }
      const results: Array<Record<string, unknown>> = []
      const errors: string[] = []
      for (const n of names) {
        try { results.push((await tools.purgeSpecialistTool(n, projectPath)) as Record<string, unknown>) }
        catch (e) { errors.push(`${n}: ${e}`) }
      }
      return { results, count: results.length, errors }
    }

    case 'wake': {
      const names = Array.isArray(args.name) ? (args.name as unknown[]).map(String) : [String(args.name)]
      const message = String(args.message)
      if (names.length === 1) {
        return (await tools.wakeSpecialistTool(names[0], message)) as Record<string, unknown>
      }
      const results: Array<Record<string, unknown>> = []
      const errors: string[] = []
      for (const n of names) {
        try { results.push((await tools.wakeSpecialistTool(n, message)) as Record<string, unknown>) }
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

    default:
      throw new Error(`Unbekannte Specialist-Action: ${job.action}`)
  }
}
