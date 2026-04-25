import { readFile, writeFile, mkdir, readdir, rename, access, rm } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentMeta {
  name: string
  model: string
  expertise: string
  created: string
}

export type SkillFile = 'rules' | 'errors' | 'patterns' | 'context'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function agentDir(projectPath: string, agentName: string): string {
  return join(projectPath, '.synapse', 'agents', agentName)
}

export async function ensureAgentDir(projectPath: string, agentName: string): Promise<string> {
  const dir = agentDir(projectPath, agentName)
  await mkdir(join(dir, 'logs'), { recursive: true })
  return dir
}

/**
 * Loescht das gesamte Verzeichnis eines Agenten (.synapse/agents/<name>/).
 * Idempotent: kein Fehler wenn nichts existiert.
 * Sicherheits-Check: agentName darf weder leer sein noch '/' oder '..' enthalten,
 * sonst koennte rm -rf in fremde Pfade greifen.
 */
export async function purgeAgentDir(projectPath: string, agentName: string): Promise<void> {
  if (!agentName || agentName.includes('/') || agentName.includes('..') || agentName === '.') {
    throw new Error(`Ungueltiger agentName fuer purge: "${agentName}"`)
  }
  const dir = agentDir(projectPath, agentName)
  await rm(dir, { recursive: true, force: true })
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function skillFileName(file: SkillFile): string {
  return `${file}.md`
}

// ---------------------------------------------------------------------------
// Meta-Datei Funktionen
// ---------------------------------------------------------------------------

export async function readMeta(projectPath: string, agentName: string): Promise<AgentMeta | null> {
  const path = join(agentDir(projectPath, agentName), 'meta.yaml')
  try {
    const raw = await readFile(path, 'utf-8')
    const meta: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (key && value) meta[key] = value
    }
    if (!meta.name || !meta.model || !meta.expertise || !meta.created) return null
    return {
      name: meta.name,
      model: meta.model,
      expertise: meta.expertise,
      created: meta.created,
    }
  } catch {
    return null
  }
}

export async function writeMeta(projectPath: string, agentName: string, meta: AgentMeta): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  const content = `name: ${meta.name}\nmodel: ${meta.model}\nexpertise: ${meta.expertise}\ncreated: ${meta.created}\n`
  await writeFile(join(dir, 'meta.yaml'), content, 'utf-8')
}

// ---------------------------------------------------------------------------
// Skill-File Read/Write
// ---------------------------------------------------------------------------

export async function readSkillFile(projectPath: string, agentName: string, file: SkillFile): Promise<string | null> {
  const path = join(agentDir(projectPath, agentName), skillFileName(file))
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function writeSkillFile(projectPath: string, agentName: string, file: SkillFile, content: string): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  await writeFile(join(dir, skillFileName(file)), content, 'utf-8')
}

export async function appendToSkillFile(projectPath: string, agentName: string, file: SkillFile, entry: string): Promise<void> {
  const dir = await ensureAgentDir(projectPath, agentName)
  const path = join(dir, skillFileName(file))
  const today = todayDate()
  const header = `## ${today}`

  let existing = ''
  try {
    existing = await readFile(path, 'utf-8')
  } catch {
    // File does not exist yet
  }

  if (existing.includes(header)) {
    // Append bullet under existing date header
    const updated = existing.replace(header, `${header}\n- ${entry}`)
    await writeFile(path, updated, 'utf-8')
  } else {
    // Add new date header + bullet
    const block = `${existing ? existing.trimEnd() + '\n\n' : ''}${header}\n- ${entry}\n`
    await writeFile(path, block, 'utf-8')
  }
}

// ---------------------------------------------------------------------------
// readAllSkillFiles
// ---------------------------------------------------------------------------

export async function readAllSkillFiles(projectPath: string, agentName: string): Promise<string> {
  const meta = await readMeta(projectPath, agentName)
  const rules = await readSkillFile(projectPath, agentName, 'rules') ?? ''
  const errors = await readSkillFile(projectPath, agentName, 'errors') ?? ''
  const patterns = await readSkillFile(projectPath, agentName, 'patterns') ?? ''
  const context = await readSkillFile(projectPath, agentName, 'context') ?? ''

  const header = meta
    ? `# Agent: ${meta.name} (${meta.model})\nExpertise: ${meta.expertise}`
    : `# Agent: ${agentName}`

  return `${header}

## Regeln
${rules.trim() || '(Keine)'}

## Fehler → Loesung
${errors.trim() || '(Keine)'}

## Patterns
${patterns.trim() || '(Keine)'}

## Kontext
${context.trim() || '(Kein Kontext)'}
`
}

// ---------------------------------------------------------------------------
// migrateSkillMd
// ---------------------------------------------------------------------------

export async function migrateSkillMd(projectPath: string, agentName: string): Promise<boolean> {
  const dir = agentDir(projectPath, agentName)
  const metaPath = join(dir, 'meta.yaml')
  const skillPath = join(dir, 'SKILL.md')
  const memoryPath = join(dir, 'MEMORY.md')

  // Idempotenz: meta.yaml existiert bereits → nichts tun
  if (await fileExists(metaPath)) return false
  // Kein SKILL.md vorhanden → nichts zu migrieren
  if (!(await fileExists(skillPath))) return false

  const raw = await readFile(skillPath, 'utf-8')

  // --- Frontmatter extrahieren ---
  let frontmatter: Record<string, string> = {}
  let body = raw
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (key && value) frontmatter[key] = value
    }
    body = fmMatch[2]
  }

  // --- Sektionen extrahieren ---
  const sectionRegex = /^#\s+(.+)$/gm
  const sections: { title: string; start: number; end: number }[] = []
  let match: RegExpExecArray | null
  while ((match = sectionRegex.exec(body)) !== null) {
    if (sections.length > 0) {
      sections[sections.length - 1].end = match.index
    }
    sections.push({ title: match[1].trim(), start: match.index + match[0].length, end: body.length })
  }

  const sectionContent = (titlePattern: string): string => {
    const sec = sections.find(s => s.title.toLowerCase().includes(titlePattern.toLowerCase()))
    return sec ? body.slice(sec.start, sec.end).trim() : ''
  }

  const rulesContent = sectionContent('regeln')
  const errorsContent = sectionContent('fehler')
  const patternsContent = sectionContent('pattern')

  // Context = alles was nicht Regeln/Fehler/Patterns ist
  const knownTitles = ['regeln', 'fehler', 'pattern']
  const contextSections = sections.filter(
    s => !knownTitles.some(t => s.title.toLowerCase().includes(t))
  )
  let contextContent = contextSections
    .map(s => body.slice(s.start, s.end).trim())
    .filter(Boolean)
    .join('\n\n')

  // MEMORY.md anhaengen falls vorhanden
  if (await fileExists(memoryPath)) {
    const memoryContent = await readFile(memoryPath, 'utf-8')
    contextContent = contextContent
      ? `${contextContent}\n\n${memoryContent.trim()}`
      : memoryContent.trim()
  }

  // --- Dateien schreiben ---
  await ensureAgentDir(projectPath, agentName)

  const meta: AgentMeta = {
    name: frontmatter.name || agentName,
    model: frontmatter.model || 'unknown',
    expertise: frontmatter.expertise || 'General',
    created: frontmatter.created || todayDate(),
  }
  await writeMeta(projectPath, agentName, meta)

  if (rulesContent) await writeSkillFile(projectPath, agentName, 'rules', rulesContent + '\n')
  else await writeSkillFile(projectPath, agentName, 'rules', '')

  if (errorsContent) await writeSkillFile(projectPath, agentName, 'errors', errorsContent + '\n')
  else await writeSkillFile(projectPath, agentName, 'errors', '')

  if (patternsContent) await writeSkillFile(projectPath, agentName, 'patterns', patternsContent + '\n')
  else await writeSkillFile(projectPath, agentName, 'patterns', '')

  if (contextContent) await writeSkillFile(projectPath, agentName, 'context', contextContent + '\n')
  else await writeSkillFile(projectPath, agentName, 'context', '')

  // --- Originale umbenennen ---
  await rename(skillPath, skillPath + '.bak')
  if (await fileExists(memoryPath)) {
    await rename(memoryPath, memoryPath + '.bak')
  }

  return true
}

// ---------------------------------------------------------------------------
// createInitialAgent
// ---------------------------------------------------------------------------

export async function createInitialAgent(
  projectPath: string,
  name: string,
  model: string,
  expertise: string,
): Promise<void> {
  const meta: AgentMeta = { name, model, expertise, created: todayDate() }
  await writeMeta(projectPath, name, meta)
  await writeSkillFile(projectPath, name, 'rules', '')
  await writeSkillFile(projectPath, name, 'errors', '')
  await writeSkillFile(projectPath, name, 'patterns', '')
  await writeSkillFile(projectPath, name, 'context', '')
}

// ---------------------------------------------------------------------------
// Abwaertskompatibilitaet
// ---------------------------------------------------------------------------

export async function readSkill(projectPath: string, agentName: string): Promise<string | null> {
  const metaPath = join(agentDir(projectPath, agentName), 'meta.yaml')
  if (await fileExists(metaPath)) {
    return readAllSkillFiles(projectPath, agentName)
  }
  // Fallback: alte SKILL.md
  const path = join(agentDir(projectPath, agentName), 'SKILL.md')
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function writeSkill(projectPath: string, agentName: string, content: string): Promise<void> {
  await writeSkillFile(projectPath, agentName, 'context', content)
}

export async function readMemory(projectPath: string, agentName: string): Promise<string | null> {
  const contextPath = join(agentDir(projectPath, agentName), 'context.md')
  if (await fileExists(contextPath)) {
    return readSkillFile(projectPath, agentName, 'context')
  }
  // Fallback: alte MEMORY.md
  const path = join(agentDir(projectPath, agentName), 'MEMORY.md')
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function writeMemory(projectPath: string, agentName: string, content: string): Promise<void> {
  await writeSkillFile(projectPath, agentName, 'context', content)
}

// ---------------------------------------------------------------------------
// Log-Funktionen (UNVERAENDERT)
// ---------------------------------------------------------------------------

export async function readTodayLog(projectPath: string, agentName: string): Promise<string | null> {
  const today = todayDate()
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
  const today = todayDate()
  const path = join(dir, 'logs', `${today}.md`)

  let existing = ''
  try {
    existing = await readFile(path, 'utf-8')
  } catch {
    existing = `# Log ${today}\n\n`
  }

  await writeFile(path, existing + entry + '\n', 'utf-8')
}

// ---------------------------------------------------------------------------
// listAgentDirs (UNVERAENDERT)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// createInitialSkill (Abwaertskompatibel, delegiert an createInitialAgent)
// ---------------------------------------------------------------------------

export function createInitialSkill(
  name: string,
  model: string,
  expertise: string,
): string {
  const today = todayDate()
  // Rueckgabe bleibt String fuer Kompatibilitaet — Caller nutzt writeSkill()
  // Aber wir geben das neue Format als zusammengesetzten String zurueck
  return `name: ${name}
model: ${model}
expertise: ${expertise}
created: ${today}

## Regeln
(Noch keine Regeln gelernt)

## Fehler → Loesung
(Noch keine Fehler dokumentiert)

## Patterns
(Noch keine Patterns erkannt)
`
}
