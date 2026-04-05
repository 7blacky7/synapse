import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpecialistStatus, StatusFile } from './types.js'

const DEFAULT_MAX_SPECIALISTS = 7

function statusPath(projectPath: string): string {
  return join(projectPath, '.synapse', 'agents', 'status.json')
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
  await mkdir(join(projectPath, '.synapse', 'agents'), { recursive: true })
  status.lastUpdate = new Date().toISOString()
  await writeFile(path, JSON.stringify(status, null, 2), 'utf-8')
}

export async function updateSpecialist(
  projectPath: string,
  name: string,
  update: Partial<SpecialistStatus>,
): Promise<void> {
  const status = await readStatus(projectPath)
  status.specialists[name] = { ...status.specialists[name], ...update } as SpecialistStatus
  await writeStatus(projectPath, status)
}

export async function removeSpecialist(projectPath: string, name: string): Promise<void> {
  const status = await readStatus(projectPath)
  delete status.specialists[name]
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
