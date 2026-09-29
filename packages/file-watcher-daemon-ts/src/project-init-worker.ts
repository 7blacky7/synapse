/**
 * MODUL: project-init-worker.ts
 * ZWECK: PostgreSQL LISTEN-basierter Worker fuer Project-Init-Jobs (Web-KI
 *        Self-Service). Lauscht auf 'project_init_job_created', resolved den
 *        Pfad gegen WORKSPACE_ROOT, legt das Verzeichnis an, registriert das
 *        Projekt in der `projects`-Tabelle und startet ggf. den FileWatcher
 *        ueber den uebergebenen WatcherManager.
 *
 * INTEGRATION: Wird von main.ts neben den anderen Workern gestartet. Anders
 *        als shell/specialist gibt es keinen Project-Filter — der Daemon
 *        nimmt alle pending Project-Init-Jobs an, deren `hostname` zu seinem
 *        Hostname matcht (oder NULL = beliebig).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  getPool,
  claimPendingProjectInitJob,
  completeProjectInitJob,
  expirePendingProjectInitJobs,
  isValidProjectName,
  registerProject,
  envHatDatabaseUrl,
  schreibeProjektDbEnv,
  vergissJobUmgebungCache,
  type ProjectInitJobRow,
  type ProjektDbAnlage,
} from '@synapse/core'

import { getWorkspaceRoot, loadConfig, DEFAULT_SYNAPSE_API_URL } from './config.js'
import type { WatcherManager } from './manager.js'

const HOSTNAME = os.hostname()
const DAEMON_ID = `daemon-${HOSTNAME}-${process.pid}`

export interface ProjectInitWorkerHandle {
  stop: () => Promise<void>
}

export async function startProjectInitWorker(
  manager: WatcherManager,
): Promise<ProjectInitWorkerHandle> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let listenClient: any = null
  let safetyInterval: ReturnType<typeof setInterval> | null = null
  let stopped = false

  listenClient = await getPool().connect()
  await listenClient.query('LISTEN project_init_job_created')

  listenClient.on('notification', (msg: { channel: string; payload?: string }) => {
    if (msg.channel !== 'project_init_job_created') return
    void processNextJob(manager).catch((err: unknown) => {
      console.error('[project-init-worker] processNextJob Fehler:', (err as Error).message)
    })
  })

  listenClient.on('error', (err: Error) => {
    if (!stopped) console.error('[project-init-worker] LISTEN-Client Fehler:', err.message)
  })

  // Safety-Net alle 10s: pending Jobs catchen + alte timeout-en
  safetyInterval = setInterval(() => {
    if (stopped) return
    void expirePendingProjectInitJobs(30).catch((err: unknown) => {
      console.error('[project-init-worker] expirePending Fehler:', (err as Error).message)
    })
    void processNextJob(manager).catch((err: unknown) => {
      console.error('[project-init-worker] safety-net Fehler:', (err as Error).message)
    })
  }, 10_000)

  // Startup-Catchup
  void processNextJob(manager).catch((err: unknown) => {
    console.error('[project-init-worker] startup catchup Fehler:', (err as Error).message)
  })

  console.error(`[project-init-worker] gestartet als ${DAEMON_ID} (workspace_root=${getWorkspaceRoot()})`)

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
    console.error('[project-init-worker] gestoppt.')
  }

  return { stop }
}

async function processNextJob(manager: WatcherManager): Promise<void> {
  const job = await claimPendingProjectInitJob(DAEMON_ID, HOSTNAME)
  if (!job) return

  console.error(`[project-init-worker] Job ${job.id} (name=${job.name}) gestartet`)

  try {
    const resolved = await initializeProject(job, manager)
    await completeProjectInitJob(job.id, {
      status: 'done',
      resolved_path: resolved.path,
      message: resolved.message,
    })
    console.error(`[project-init-worker] Job ${job.id} done — path=${resolved.path}`)
  } catch (err) {
    const e = err as Error & { code?: string; rejectReason?: string }
    const isReject = e.rejectReason !== undefined
    await completeProjectInitJob(job.id, {
      status: isReject ? 'rejected' : 'failed',
      error: isReject ? e.rejectReason! : (e.code ?? 'project_init_failed'),
      message: e.message,
    })
    console.error(`[project-init-worker] Job ${job.id} ${isReject ? 'rejected' : 'failed'}: ${e.message}`)
  }
}

async function startRemoteWorkspace(name: string): Promise<void> {
  let baseUrl = DEFAULT_SYNAPSE_API_URL
  try {
    const cfg = loadConfig()
    if (cfg.synapse_api_url) baseUrl = cfg.synapse_api_url
  } catch { /* default-fallback */ }

  const url = `${baseUrl.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(name)}/workspace/start`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      console.error(`[project-init-worker] workspace-bridge ${name}: HTTP ${res.status}`)
      return
    }
    console.error(`[project-init-worker] workspace-bridge ${name}: gestartet via ${baseUrl}`)
  } catch (err) {
    console.error(`[project-init-worker] workspace-bridge ${name} fehlgeschlagen (uebersprungen): ${(err as Error).message}`)
  }
}

interface InitResult {
  path: string
  message: string
}

/**
 * Projekt-DB ueber die synapse-api anlegen lassen (POST /api/projects/:name/projekt-db)
 * und DATABASE_URL in <projekt>/.env schreiben (auch fuer eine schon vorhandene DB,
 * deren Zugangsdaten in Synapse liegen). Passwort nicht loggen. Best-effort: wirft nie.
 */
async function richteProjektDbEin(name: string, projectPath: string): Promise<string> {
  if (envHatDatabaseUrl(projectPath)) {
    return 'Projekt-DB: .env enthaelt bereits DATABASE_URL — nichts angelegt.'
  }
  let baseUrl = DEFAULT_SYNAPSE_API_URL
  let token: string | undefined
  try {
    const cfg = loadConfig() as ReturnType<typeof loadConfig> & { synapse_api_token?: unknown }
    if (cfg.synapse_api_url) baseUrl = cfg.synapse_api_url
    if (typeof cfg.synapse_api_token === 'string' && cfg.synapse_api_token) token = cfg.synapse_api_token
  } catch { /* default-fallback */ }

  let ergebnis: ProjektDbAnlage | undefined
  let zugang: { host?: string; port?: number; database?: string; user?: string; passwort?: string } | null | undefined
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(name)}/projekt-db`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ projekt_pfad: projectPath }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) return `Projekt-DB: synapse-api antwortete HTTP ${res.status}.`
    const antwort = (await res.json()) as { projekt_db?: ProjektDbAnlage; zugang?: typeof zugang }
    ergebnis = antwort.projekt_db
    zugang = antwort.zugang
  } catch (err) {
    return `Projekt-DB: synapse-api nicht erreichbar (${(err as Error).message}).`
  }
  // Shell-Jobs dieses Projekts sollen die neue DB sofort als DATABASE_URL sehen.
  vergissJobUmgebungCache(name)
  if (!ergebnis) return 'Projekt-DB: Antwort ohne Ergebnis.'
  if (!zugang?.passwort) return `Projekt-DB [${ergebnis.status}]: ${ergebnis.hinweis}`
  try {
    schreibeProjektDbEnv(projectPath, zugang)
    return `Projekt-DB: ${ergebnis.hinweis} DATABASE_URL in ${path.join(projectPath, '.env')} (chmod 600).`
  } catch (err) {
    return `Projekt-DB: ${ergebnis.hinweis} .env nicht geschrieben (${(err as Error).message}) — Zugangsdaten per project(action:"projekt_db").`
  }
}

async function initializeProject(
  job: ProjectInitJobRow,
  manager: WatcherManager,
): Promise<InitResult> {
  // Validierung
  if (!isValidProjectName(job.name)) {
    const err = new Error(
      `Projekt-Name "${job.name}" ist ungueltig. Erlaubt: 2-64 Zeichen, [a-zA-Z0-9_-], beginnt mit Buchstabe/Ziffer.`,
    ) as Error & { rejectReason: string }
    err.rejectReason = 'invalid_name'
    throw err
  }

  const root = getWorkspaceRoot()
  const projectPath = path.resolve(root, job.name)

  // Nur Projekt-DB fuer ein BESTEHENDES Projekt (project action "projekt_db", auf Wunsch).
  if (job.template === 'projekt_db') {
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      const err = new Error(
        `Projektordner "${projectPath}" existiert nicht — Projekt-DB nur fuer bestehende Projekte.`,
      ) as Error & { rejectReason: string }
      err.rejectReason = 'not_found'
      throw err
    }
    return { path: projectPath, message: await richteProjektDbEin(job.name, projectPath) }
  }

  // Sandbox-Check: kein Path-Traversal aus dem Workspace-Root
  const rootAbs = path.resolve(root)
  if (!projectPath.startsWith(rootAbs + path.sep) && projectPath !== rootAbs) {
    const err = new Error(
      `Aufgeloester Pfad "${projectPath}" liegt ausserhalb von WORKSPACE_ROOT "${rootAbs}".`,
    ) as Error & { rejectReason: string }
    err.rejectReason = 'path_traversal'
    throw err
  }

  // Existierendes Projekt → wenn schon registriert: Pfad zurueckgeben (idempotent),
  // sonst registrieren ohne neu anzulegen.
  const alreadyExists = fs.existsSync(projectPath)
  if (alreadyExists) {
    const stat = fs.statSync(projectPath)
    if (!stat.isDirectory()) {
      const err = new Error(
        `Pfad "${projectPath}" existiert bereits, ist aber kein Verzeichnis.`,
      ) as Error & { rejectReason: string }
      err.rejectReason = 'not_a_directory'
      throw err
    }
  } else {
    // WORKSPACE_ROOT sicherstellen + Projekt-Verzeichnis anlegen
    fs.mkdirSync(rootAbs, { recursive: true })
    fs.mkdirSync(projectPath, { recursive: true })

    // git init — best-effort, kein harter Fehler wenn git fehlt
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: projectPath, stdio: 'ignore' })
    } catch (gitErr) {
      console.error(
        `[project-init-worker] git init fuer ${projectPath} fehlgeschlagen (uebersprungen): ${(gitErr as Error).message}`,
      )
    }

    // README — minimaler Stub damit Watcher etwas zum Indexieren hat
    const readmePath = path.join(projectPath, 'README.md')
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(
        readmePath,
        `# ${job.name}\n\nProjekt erstellt via Synapse Self-Service Init am ${new Date().toISOString()}.\n`,
        'utf-8',
      )
    }
  }

  // Projekt in PG registrieren (project-registry.ts)
  await registerProject(job.name, projectPath)

  // Daemon-Config + FileWatcher in einem: registriert in config.json,
  // persistiert, spawnt Watcher. Damit erscheint das Projekt automatisch
  // im Tray-Refresh.
  try {
    await manager.register(job.name, projectPath)
  } catch (regErr) {
    console.error(
      `[project-init-worker] manager.register fuer ${job.name} fehlgeschlagen (uebersprungen): ${(regErr as Error).message}`,
    )
  }

  // WS-P10: Bridge zur synapse-api — Workspace-Container vorwaermen.
  // Best-effort: Fehler nur loggen, Projekt-Init darf nicht failen wenn synapse-api offline.
  if (process.env.SYNAPSE_WORKSPACE_BRIDGE_DISABLED !== '1') {
    void startRemoteWorkspace(job.name)
  }

  // Projekt-DB auf der Unraid-Projekt-Instanz — nur fuer neu angelegte Ordner,
  // bestehende Projekte bekommen sie nur auf Wunsch. Best-effort: wirft nie.
  const projektDbHinweis = alreadyExists
    ? 'Projekt-DB: nicht automatisch angelegt (Ordner bestand schon) — auf Wunsch per project(action:"projekt_db").'
    : await richteProjektDbEin(job.name, projectPath)

  return {
    path: projectPath,
    message: (alreadyExists
      ? `Projekt "${job.name}" war schon angelegt — registriert + Watcher gestartet.`
      : `Projekt "${job.name}" angelegt unter ${projectPath} und gestartet.`) + ` ${projektDbHinweis}`,
  }
}
