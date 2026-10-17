import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { agentLaufIdentitaet, agentLaufPfad, agentLaufSchluessel } from './agent-lauf.js'
import type { SpecialistStatus, StatusFile } from './types.js'

const DEFAULT_MAX_SPECIALISTS = 7

/**
 * Spezialisten-Status (Cache, PG wrapper_status ist primaer).
 *
 * ACHTUNG, ZWEI DATEIEN (P15-T40): .synapse/agents/status.json ist dieser
 * Spezialisten-Cache {specialists, maxSpecialists, lastUpdate}; der Wrapper
 * schreibt ihn bei jedem Aktivitaets-Update neu. .synapse/status.json ist
 * etwas anderes: der Projektstatus aus core/services/project-status.ts
 * (id, path, setupPhase). Der Pfad hier ist also kein Fehler — die Datei NICHT
 * nach .synapse/status.json verlegen, das wuerde den Projektstatus
 * ueberschreiben. Beide liegen unter .synapse/ und sind dort fuer den Index
 * gesperrt (DEFAULT_IGNORES).
 */
function statusPath(projectPath: string): string {
  return agentLaufIdentitaet() ? join(agentLaufPfad(projectPath, ''), 'status.json') : join(projectPath, '.synapse', 'agents', 'status.json')
}

export async function readStatus(projectPath: string): Promise<StatusFile> {
  try {
    const raw = await readFile(statusPath(projectPath), 'utf-8')
    return JSON.parse(raw) as StatusFile
  } catch {
    return {
      specialists: {},
      maxSpecialists: DEFAULT_MAX_SPECIALISTS,
      lastUpdate: new Date().toISOString(),
    }
  }
}

export async function writeStatus(projectPath: string, status: StatusFile): Promise<void> {
  const path = statusPath(projectPath)
  await mkdir(dirname(path), { recursive: true })
  status.lastUpdate = new Date().toISOString()
  await writeFile(path, JSON.stringify(status, null, 2), 'utf-8')
}

export async function updateSpecialist(
  projectPath: string,
  name: string,
  update: Partial<SpecialistStatus>,
): Promise<void> {
  const status = await readStatus(projectPath)
  status.specialists[agentLaufSchluessel(name)] = { ...status.specialists[agentLaufSchluessel(name)], ...update } as SpecialistStatus
  await writeStatus(projectPath, status)
}

export async function removeSpecialist(projectPath: string, name: string): Promise<void> {
  const status = await readStatus(projectPath)
  delete status.specialists[agentLaufSchluessel(name)]
  await writeStatus(projectPath, status)
}

export async function getRunningCount(projectPath: string): Promise<number> {
  const status = await readStatus(projectPath)
  return Object.values(status.specialists).filter(s => s.status === 'running').length
}

export async function canSpawn(projectPath: string): Promise<{ ok: boolean; reason?: string }> {
  const status = await readStatus(projectPath)
  const running = Object.values(status.specialists).filter(s => s.status === 'running').length
  if (running >= status.maxSpecialists) {
    return {
      ok: false,
      reason: `Specialist-Limit erreicht (${running}/${status.maxSpecialists}). Stoppe einen Spezialisten zuerst.`,
    }
  }
  return { ok: true }
}
