import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'

function agentDir(projectPath: string, agentName: string): string {
  return join(projectPath, '.synapse', 'agents', agentName)
}

export async function ensureAgentDir(projectPath: string, agentName: string): Promise<string> {
  const dir = agentDir(projectPath, agentName)
  await mkdir(join(dir, 'logs'), { recursive: true })
  return dir
}

export async function readSkill(projectPath: string, agentName: string): Promise<string | null> {
  const path = join(agentDir(projectPath, agentName), 'SKILL.md')
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function writeSkill(projectPath: string, agentName: string, content: string): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  await writeFile(join(dir, 'SKILL.md'), content, 'utf-8')
}

export async function readMemory(projectPath: string, agentName: string): Promise<string | null> {
  const path = join(agentDir(projectPath, agentName), 'MEMORY.md')
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function writeMemory(projectPath: string, agentName: string, content: string): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  await writeFile(join(dir, 'MEMORY.md'), content, 'utf-8')
}

export async function readTodayLog(projectPath: string, agentName: string): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10)
  const path = join(agentDir(projectPath, agentName), 'logs', `${today}.md`)
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function readYesterdayLog(projectPath: string, agentName: string): Promise<string | null> {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const path = join(agentDir(projectPath, agentName), 'logs', `${yesterday}.md`)
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function appendLog(projectPath: string, agentName: string, entry: string): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  const today = new Date().toISOString().slice(0, 10)
  const path = join(dir, 'logs', `${today}.md`)

  let existing = ''
  try {
    existing = await readFile(path, 'utf-8')
  } catch {
    existing = `# Log ${today}\n\n`
  }

  await writeFile(path, existing + entry + '\n', 'utf-8')
}

export async function listAgentDirs(projectPath: string): Promise<string[]> {
  const base = join(projectPath, '.synapse', 'agents')
  try {
    const entries = await readdir(base, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory())
      .map(e => e.name)
  } catch {
    return []
  }
}

export function createInitialSkill(
  name: string,
  model: string,
  expertise: string,
): string {
  const today = new Date().toISOString().slice(0, 10)
  return `---
name: ${name}
model: ${model}
expertise: ${expertise}
created: ${today}
---

# Regeln
(Noch keine Regeln gelernt)

# Fehler → Loesung
(Noch keine Fehler dokumentiert)

# Patterns
(Noch keine Patterns erkannt)
`
}
